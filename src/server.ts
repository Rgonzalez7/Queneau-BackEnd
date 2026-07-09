import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import "dotenv/config";
import { withDB } from "./lib/db";
import { COVERS_DIR, regenerateCover } from "./lib/cover";
import {
  authenticate, requireAuth, requireAdmin, currentUser,
  findUserByEmail, findUserByGoogle, findUserById, createUser, ensureSuperuser, reconcileSuperusers,
  hashPassword, verifyPassword, validEmail, validPassword,
  isAdultDOB, verifyGoogleIdToken, signToken, setAuthCookie, clearAuthCookie,
  publicUser, normEmail,
} from "./lib/auth";
import type { User } from "./lib/types";
import {
  sweepExpired,
  publicState,
  createOpening,
  purchaseOpening,
  setFinished,
  generateRemaining,
  resumeUnfinished,
  kickPending,
} from "./lib/rules";
import { extractProfile } from "./lib/analyzer";
import { learnFromTextInBackground, getCraftStats } from "./lib/craft";
import { uid, HttpError } from "./lib/constants";
import { STYLE_FACETS, sampleForStyle, sampleForScene, extractProse, extractSceneCraft, extractKnobs, generateStyleSample, extractTags, extractPlotArchitecture, extractCast } from "./lib/styledna";
import { assessOutput } from "./lib/safety";
import type { Profile, FormatKey } from "./lib/types";
import payments from "./lib/payments";

const app = express();

// Blindaje: un error suelto en un worker de segundo plano no debe tumbar el
// proceso (antes obligaba a reiniciar el servidor). Se loguea y se sigue.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
const PORT = Number(process.env.PORT) || 4000;

// CORS: el frontend (otro origen) consume la API CON cookies de sesión, así que
// hace falta credentials:true y un origin EXPLÍCITO (no "*"). CORS_ORIGIN admite
// una lista separada por comas. Además se permite cualquier subdominio *.vercel.app
// (preview/production) para no tener que reconfigurar en cada deploy. Sin lista,
// refleja el origen (solo dev).
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);              // curl / same-origin
      if (!CORS_ORIGINS.length) return cb(null, true); // sin lista => refleja (dev)
      let host = "";
      try { host = new URL(origin).hostname; } catch { /* origin inválido */ }
      const ok = CORS_ORIGINS.includes(origin) || /(^|\.)vercel\.app$/i.test(host);
      cb(null, ok);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" })); // sube a 2mb: el ADN manda el libro completo
app.use(cookieParser());
app.use(authenticate); // adjunta req.auth (o null) en cada petición
app.use("/covers", express.static(COVERS_DIR)); // portadas IA generadas

// Rutas de métodos de pago. El router trae sus propias rutas absolutas.
app.use(payments);

// Envuelve un handler async y traduce HttpError -> código HTTP.
function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e) {
      const err = e as HttpError;
      console.error("[api error]", req.method, req.url, "\n", (err && err.stack) || err);
      res.status(err.code || 500).json({ error: err.message || "Error" });
    }
  };
}

/* Devuelve la historia si pertenece al usuario (o si es admin); si no, 403/404. */
function ownStoryOr403(db: Parameters<typeof publicState>[0], id: string, me: User) {
  const s = db.stories.find((x) => x.id === id);
  if (!s) throw new HttpError(404, "Libro no encontrado");
  if (s.ownerId && s.ownerId !== me.id && me.role !== "admin") {
    throw new HttpError(403, "Ese libro no es tuyo");
  }
  return s;
}

/* ============================== AUTENTICACIÓN ============================== */

// Registro con email + contraseña (exige edad 18+).
app.post(
  "/api/auth/register",
  handler(async (req, res) => {
    const { email, password, name, dateOfBirth } = (req.body || {}) as Record<string, string>;
    if (!validEmail(email)) throw new HttpError(400, "Correo inválido");
    if (!validPassword(password)) throw new HttpError(400, "La contraseña debe tener al menos 8 caracteres");
    if (!name || !name.trim()) throw new HttpError(400, "Falta el nombre");
    if (!dateOfBirth || !isAdultDOB(dateOfBirth)) throw new HttpError(403, "Debes ser mayor de 18 años");

    const hash = await hashPassword(password);
    const user = await withDB((db) => {
      if (findUserByEmail(db, email)) throw new HttpError(409, "Ya existe una cuenta con ese correo");
      return createUser(db, {
        email: normEmail(email),
        name: name.trim(),
        passwordHash: hash,
        dateOfBirth,
        lastLogin: Date.now(),
      });
    });
    setAuthCookie(res, signToken(user));
    res.json({ user: publicUser(user), token: signToken(user) });
  })
);

// Login con email + contraseña.
app.post(
  "/api/auth/login",
  handler(async (req, res) => {
    const { email, password } = (req.body || {}) as Record<string, string>;
    if (!validEmail(email) || !password) throw new HttpError(400, "Correo o contraseña faltantes");
    const found = await withDB((db) => {
      const u = findUserByEmail(db, email);
      if (u) { ensureSuperuser(db, u); u.lastLogin = Date.now(); }
      return u ? { ...u } : null;
    });
    if (!found || !found.passwordHash) {
      // sin hash => probablemente es cuenta de Google
      throw new HttpError(401, "Correo o contraseña incorrectos");
    }
    if (found.suspended) throw new HttpError(403, "Cuenta suspendida");
    const ok = await verifyPassword(password, found.passwordHash);
    if (!ok) throw new HttpError(401, "Correo o contraseña incorrectos");
    setAuthCookie(res, signToken(found));
    res.json({ user: publicUser(found), token: signToken(found) });
  })
);

// Login/registro con Google (ID token de Google Identity Services).
// Para cuentas NUEVAS se exige dateOfBirth (18+); las existentes solo entran.
app.post(
  "/api/auth/google",
  handler(async (req, res) => {
    const { idToken, dateOfBirth } = (req.body || {}) as Record<string, string>;
    if (!idToken) throw new HttpError(400, "Falta el token de Google");
    const g = await verifyGoogleIdToken(idToken);

    const result = await withDB((db) => {
      let u: User | undefined = findUserByGoogle(db, g.googleId) || findUserByEmail(db, g.email);
      if (u) {
        if (u.suspended) throw new HttpError(403, "Cuenta suspendida");
        if (!u.googleId) u.googleId = g.googleId; // vincula Google a una cuenta de email existente
        ensureSuperuser(db, u);
        u.lastLogin = Date.now();
        return { user: u, created: false };
      }
      // cuenta nueva: exige edad
      if (!dateOfBirth || !isAdultDOB(dateOfBirth)) {
        throw new HttpError(428, "Necesitamos tu fecha de nacimiento (18+) para crear la cuenta");
      }
      const created = createUser(db, {
        email: g.email,
        name: g.name,
        googleId: g.googleId,
        dateOfBirth,
        lastLogin: Date.now(),
      });
      return { user: created, created: true };
    });
    setAuthCookie(res, signToken(result.user));
    res.json({ user: publicUser(result.user), token: signToken(result.user) });
  })
);

app.post(
  "/api/auth/logout",
  handler(async (_req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
  })
);

app.get(
  "/api/auth/me",
  requireAuth,
  handler(async (req, res) => {
    const me = await withDB((db) => {
      const u = currentUser(db, req);
      ensureSuperuser(db, u); // promueve al superusuario en cuanto entra
      return u;
    });
    // reemite el token (por si el rol cambió a admin) para que las rutas admin funcionen
    res.json({ user: publicUser(me), token: signToken(me) });
  })
);

/* ------------------------------- CUENTA --------------------------------- */

// Cambiar contraseña (solo cuentas email+contraseña). Las operaciones lentas
// de bcrypt van FUERA del candado de la DB.
app.post(
  "/api/account/password",
  requireAuth,
  handler(async (req, res) => {
    const current = String(req.body?.current || "");
    const next = String(req.body?.next || "");
    if (next.length < 8) throw new HttpError(400, "La nueva contraseña debe tener al menos 8 caracteres");
    const info = await withDB((db) => {
      const me = currentUser(db, req);
      return { hash: me.passwordHash || "" };
    });
    if (!info.hash) throw new HttpError(400, "Tu cuenta usa Google; no tiene contraseña que cambiar");
    if (!(await verifyPassword(current, info.hash))) {
      throw new HttpError(401, "La contraseña actual no es correcta");
    }
    const newHash = await hashPassword(next);
    await withDB((db) => {
      const me = currentUser(db, req);
      me.passwordHash = newHash;
    });
    res.json({ ok: true });
  })
);

// Actualizar el nombre visible de la cuenta.
app.post(
  "/api/account/name",
  requireAuth,
  handler(async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) throw new HttpError(400, "El nombre no puede estar vacío");
    const user = await withDB((db) => {
      const me = currentUser(db, req);
      me.name = name.slice(0, 80);
      return me;
    });
    res.json({ user: publicUser(user) });
  })
);

/* ================================= ADMIN ================================== */

/* Paginación + búsqueda server-side para las listas del admin. Devuelve solo la
   página pedida para no mandar miles de filas al cliente. */
function readPageParams(req: Request) {
  const q = String((req.query.q as string) || "");
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || "20"), 10) || 20));
  return { q, page, limit };
}
function paginate<T>(rows: T[], q: string, page: number, limit: number, match: (row: T, nq: string) => boolean) {
  const nq = q.trim().toLowerCase();
  const filtered = nq ? rows.filter((r) => match(r, nq)) : rows;
  const total = filtered.length;
  const start = (page - 1) * limit;
  return { items: filtered.slice(start, start + limit), total, hasMore: start + limit < total };
}

// Usuarios paginados + buscables (los más recientes primero).
app.get(
  "/api/admin/users",
  requireAdmin,
  handler(async (req, res) => {
    const { q, page, limit } = readPageParams(req);
    const out = await withDB((db) => {
      const byOwner = (id: string) => db.stories.filter((s) => s.ownerId === id).length;
      const rows = db.users
        .slice()
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .map((u) => ({ ...publicUser(u), stories: byOwner(u.id) }));
      return paginate(rows, q, page, limit, (r, nq) =>
        (r.name || "").toLowerCase().includes(nq) || (r.email || "").toLowerCase().includes(nq)
      );
    });
    res.json(out);
  })
);

// Libros con la VOZ (ADN) usada para generarlos — paginado + buscable, solo admin.
app.get(
  "/api/admin/stories",
  requireAdmin,
  handler(async (req, res) => {
    const { q, page, limit } = readPageParams(req);
    const out = await withDB((db) => {
      const emailById = new Map(db.users.map((u) => [u.id, u.email]));
      const rows = db.stories
        .slice()
        .reverse()
        .map((s) => ({
          id: s.id,
          title: s.title,
          owner: s.ownerId ? emailById.get(s.ownerId) || "—" : "—",
          format: s.format,
          status: s.status,
          paid: s.paid,
          voice: s.bibleSnapshot?.voice?.name || null,
          genre: s.profileSnapshot?.genre || null,
          chapters: s.chapters?.length || 0,
          total: s.chaptersTotal || 0,
        }));
      return paginate(rows, q, page, limit, (r, nq) =>
        [r.title, r.voice, r.owner, r.genre].some((x) => (x || "").toLowerCase().includes(nq))
      );
    });
    res.json(out);
  })
);

// Texto completo de un libro en .txt (para descargar/verificar el ADN desde el admin).
app.get(
  "/api/admin/stories/:id/text",
  requireAdmin,
  handler(async (req, res) => {
    const story = await withDB((db) => db.stories.find((s) => s.id === req.params.id) || null);
    if (!story) throw new HttpError(404, "Libro no encontrado");
    const parts: string[] = [];
    if (story.title) parts.push(story.title.toUpperCase(), "");
    for (const ch of story.chapters || []) {
      if (ch.t) parts.push(ch.t, "");
      if (ch.b) parts.push(ch.b, "");
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(parts.join("\n").trim() + "\n");
  })
);

// Resumen global para el superusuario.
app.get(
  "/api/admin/overview",
  requireAdmin,
  handler(async (_req, res) => {
    const out = await withDB((db) => {
      const users = db.users.map(publicUser);
      const byOwner = (id: string) => db.stories.filter((s) => s.ownerId === id).length;
      return {
        counts: {
          users: db.users.length,
          admins: db.users.filter((u) => u.role === "admin").length,
          suspended: db.users.filter((u) => u.suspended).length,
          profiles: db.profiles.length,
          stories: db.stories.length,
          paidStories: db.stories.filter((s) => s.paid).length,
          orphanProfiles: db.profiles.filter((p) => !p.ownerId).length,
          orphanStories: db.stories.filter((s) => !s.ownerId).length,
        },
        users: users.map((u) => ({ ...u, stories: byOwner(u.id) })),
      };
    });
    res.json(out);
  })
);

// Suspender / reactivar una cuenta.
app.post(
  "/api/admin/users/:id/suspend",
  requireAdmin,
  handler(async (req, res) => {
    const suspended = (req.body?.suspended as boolean) ?? true;
    const out = await withDB((db) => {
      const u = findUserById(db, req.params.id);
      if (!u) throw new HttpError(404, "Usuario no encontrado");
      if (u.role === "admin") throw new HttpError(400, "No puedes suspender a un administrador");
      u.suspended = suspended;
      return publicUser(u);
    });
    res.json({ user: out });
  })
);

// Cambiar rol (user/admin).
app.post(
  "/api/admin/users/:id/role",
  requireAdmin,
  handler(async (req, res) => {
    const role = req.body?.role === "admin" ? "admin" : "user";
    const out = await withDB((db) => {
      const u = findUserById(db, req.params.id);
      if (!u) throw new HttpError(404, "Usuario no encontrado");
      u.role = role;
      u.envAdmin = false; // cambio MANUAL desde el panel (no por env)
      if (role === "user") u.suspended = u.suspended || false;
      return publicUser(u);
    });
    res.json({ user: out });
  })
);

// Borrar una cuenta y todos sus datos.
app.delete(
  "/api/admin/users/:id",
  requireAdmin,
  handler(async (req, res) => {
    await withDB((db) => {
      const u = findUserById(db, req.params.id);
      if (!u) throw new HttpError(404, "Usuario no encontrado");
      if (u.role === "admin") throw new HttpError(400, "No puedes borrar a un administrador");
      db.stories = db.stories.filter((s) => s.ownerId !== u.id);
      db.profiles = db.profiles.filter((p) => p.ownerId !== u.id);
      db.users = db.users.filter((x) => x.id !== u.id);
    });
    res.json({ ok: true });
  })
);

/* --------------------- ADN de estilo / voces (admin) --------------------- */

// Lista de voces extraídas.
app.get(
  "/api/admin/voices",
  requireAdmin,
  handler(async (req, res) => {
    const { q, page, limit } = readPageParams(req);
    const out = await withDB((db) => {
      const rows = [...(db.voices || [])].sort((a, b) => b.createdAt - a.createdAt);
      return paginate(rows, q, page, limit, (v, nq) =>
        (v.name || "").toLowerCase().includes(nq) ||
        (v.tags?.genre || "").toLowerCase().includes(nq) ||
        (v.tags?.tropes || []).some((t) => (t || "").toLowerCase().includes(nq)) ||
        (v.tags?.tone || []).some((t) => (t || "").toLowerCase().includes(nq))
      );
    });
    res.json(out);
  })
);

// Renombrar una voz.
app.patch(
  "/api/admin/voices/:id",
  requireAdmin,
  handler(async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) throw new HttpError(400, "El nombre no puede estar vacío");
    const voice = await withDB((db) => {
      const v = (db.voices || []).find((x) => x.id === req.params.id);
      if (!v) throw new HttpError(404, "Voz no encontrada");
      v.name = name.slice(0, 80);
      return v;
    });
    res.json({ voice });
  })
);

// Borrar una voz.
app.delete(
  "/api/admin/voices/:id",
  requireAdmin,
  handler(async (req, res) => {
    await withDB((db) => {
      db.voices = (db.voices || []).filter((v) => v.id !== req.params.id);
    });
    res.json({ ok: true });
  })
);

// Analizar un documento y extraer su ADN de estilo, con progreso en vivo (SSE).
// El texto llega ya extraído desde el navegador (el archivo nunca se sube).
/* ------------------- análisis de voz EN SEGUNDO PLANO -------------------
   Corre en el proceso del backend, no atado al request: el admin puede cambiar
   de página o cerrar sesión y el trabajo sigue. El frontend crea el job, recibe
   un jobId y consulta /jobs/:id hasta que termina (o se reengancha tras recargar
   vía /jobs). */
type StageStatus = "running" | "done";
interface VoiceJob {
  id: string;
  name: string;
  createdBy: string;
  status: "running" | "done" | "error";
  stages: Record<string, StageStatus>;
  error?: string;
  voiceId?: string;
  createdAt: number;
  updatedAt: number;
}
const voiceJobs = new Map<string, VoiceJob>();
function pruneVoiceJobs() {
  const now = Date.now();
  for (const [id, j] of voiceJobs) {
    if (j.status !== "running" && now - j.updatedAt > 30 * 60_000) voiceJobs.delete(id); // terminados >30 min
  }
  if (voiceJobs.size > 50) {
    const oldest = [...voiceJobs.values()].filter((j) => j.status !== "running").sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (oldest) voiceJobs.delete(oldest.id);
  }
}

async function runVoiceJob(job: VoiceJob, text: string) {
  const set = (stage: string, status: StageStatus) => { job.stages[stage] = status; job.updatedAt = Date.now(); };
  const sample = sampleForStyle(text);
  const acc = {
    structure: "", voice: "",
    sceneCraft: { sex: "", violence: "", action: "" } as Record<string, string>,
    lexicon: { sex: [] as string[], violence: [] as string[], action: [] as string[] } as Record<string, string[]>,
  };
  try {
    for (const facet of STYLE_FACETS) {
      set(facet, "running");
      if (facet === "sex" || facet === "violence" || facet === "action") {
        const sceneSample = sampleForScene(text, facet); // ventanas donde SÍ ocurre esa escena
        const { craft, lexicon } = await extractSceneCraft(sceneSample, facet);
        acc.sceneCraft[facet] = craft;
        acc.lexicon[facet] = lexicon;
      } else {
        acc[facet] = await extractProse(sample, facet);
      }
      set(facet, "done");
    }

    set("knobs", "running");
    const { knobs, imperatives } = await extractKnobs(sample);
    set("knobs", "done");

    set("plot", "running");
    const plot = await extractPlotArchitecture(sample);
    const cast = await extractCast(sample); // perfil de elenco (para variar nº de personajes)
    set("plot", "done");

    set("sample", "running");
    const styleSample = await generateStyleSample(acc.voice, knobs, imperatives);
    set("sample", "done");

    set("tags", "running");
    const tags = await extractTags(sample);
    set("tags", "done");

    set("save", "running");
    const voice = await withDB((db) => {
      const v = {
        id: uid() + uid(),
        name: job.name,
        createdAt: Date.now(),
        createdBy: job.createdBy,
        structure: acc.structure,
        voice: acc.voice,
        sceneCraft: { sex: acc.sceneCraft.sex, violence: acc.sceneCraft.violence, action: acc.sceneCraft.action },
        lexicon: { sex: acc.lexicon.sex, violence: acc.lexicon.violence, action: acc.lexicon.action },
        knobs,
        imperatives,
        styleSample,
        tags,
        plotBeats: plot.beats,
        tensionCurve: plot.tension,
        cast,
        stats: { words: text.split(/\s+/).filter(Boolean).length },
      };
      if (!Array.isArray(db.voices)) db.voices = [];
      db.voices.push(v);
      return v;
    });
    set("save", "done");
    job.voiceId = voice.id;
    job.status = "done";
    job.updatedAt = Date.now();
  } catch (e) {
    job.status = "error";
    job.error = (e as Error).message || "Falló el análisis";
    job.updatedAt = Date.now();
  }
}

// Lanza el análisis en segundo plano y devuelve el id del trabajo.
app.post(
  "/api/admin/voices/analyze",
  requireAdmin,
  handler(async (req, res) => {
    const text = String(req.body?.text || "");
    const name = (String(req.body?.name || "").trim() || "Voz sin nombre").slice(0, 80);
    if (text.replace(/\s/g, "").length < 500) throw new HttpError(400, "El texto es muy corto para analizar (mín. ~500 caracteres).");
    if (!assessOutput(text).ok) throw new HttpError(422, "Este documento no puede analizarse.");
    pruneVoiceJobs();
    const userId = await withDB((db) => currentUser(db, req).id);
    const job: VoiceJob = {
      id: uid() + uid(), name, createdBy: userId,
      status: "running", stages: {}, createdAt: Date.now(), updatedAt: Date.now(),
    };
    voiceJobs.set(job.id, job);
    void runVoiceJob(job, text); // corre sin bloquear la respuesta
    res.json({ jobId: job.id });
  })
);

// Trabajos del admin actual (para reengancharse tras recargar / volver a entrar).
app.get(
  "/api/admin/voices/jobs",
  requireAdmin,
  handler(async (req, res) => {
    const me = await withDB((db) => currentUser(db, req).id);
    const jobs = [...voiceJobs.values()]
      .filter((j) => j.createdBy === me)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => ({ id: j.id, status: j.status, stages: j.stages, error: j.error, name: j.name, updatedAt: j.updatedAt }));
    res.json({ jobs });
  })
);

// Estado de un trabajo concreto.
app.get(
  "/api/admin/voices/jobs/:id",
  requireAdmin,
  handler(async (req, res) => {
    const job = voiceJobs.get(req.params.id);
    if (!job) throw new HttpError(404, "Trabajo no encontrado");
    res.json({ job: { id: job.id, status: job.status, stages: job.stages, error: job.error, name: job.name } });
  })
);

/* ================================ APP DATA =============================== */

app.get(
  "/api/state",
  requireAuth,
  handler(async (req, res) => {
    const out = await withDB((db) => {
      const me = currentUser(db, req);
      sweepExpired(db);
      kickPending(db); // reactiva workers de libros a medias
      return publicState(db, me.id);
    });
    res.json(out);
  })
);

app.post(
  "/api/profiles",
  requireAuth,
  handler(async (req, res) => {
    const body = (req.body || {}) as Partial<Profile>;
    const out = await withDB((db) => {
      const me = currentUser(db, req);
      sweepExpired(db);
      const profile: Profile = {
        id: body.id || uid(),
        ownerId: me.id,
        name: body.name || "Sin nombre",
        source: body.source || "manual",
        genre: body.genre || "",
        tropes: body.tropes || [],
        heat_level: body.heat_level ?? null,
        tone: body.tone || [],
        pov: body.pov || "",
        pacing: body.pacing || "",
        archetype: body.archetype || "",
        darkness: body.darkness || "",
        must_haves: body.must_haves || [],
        avoid: body.avoid || [],
        settings: body.settings || [],
        autopick: body.autopick || undefined,
        scenes: body.scenes || [],
        customScenes: body.customScenes || [],
        created: body.created || Date.now(),
      };
      const i = db.profiles.findIndex((p) => p.id === profile.id);
      // solo puede sobrescribir un perfil propio; si el id es ajeno, se rechaza
      if (i >= 0) {
        if (db.profiles[i].ownerId && db.profiles[i].ownerId !== me.id) {
          throw new HttpError(403, "Ese perfil no es tuyo");
        }
        db.profiles[i] = profile;
      } else {
        db.profiles.unshift(profile);
      }
      return publicState(db, me.id);
    });
    res.json(out);
  })
);

app.delete(
  "/api/profiles/:id",
  requireAuth,
  handler(async (req, res) => {
    const out = await withDB((db) => {
      const me = currentUser(db, req);
      sweepExpired(db);
      db.profiles = db.profiles.filter(
        (p) => !(p.id === req.params.id && (p.ownerId === me.id || me.role === "admin"))
      );
      return publicState(db, me.id);
    });
    res.json(out);
  })
);

app.post(
  "/api/profiles/extract",
  requireAuth,
  handler(async (req, res) => {
    const text = (req.body?.text as string) || "";
    if (text.replace(/\s/g, "").length < 200) {
      res.status(400).json({ error: "Hace falta más texto — pega un par de páginas." });
      return;
    }
    const draft = await extractProfile(text.slice(0, 16000));
    if (draft.blocked) {
      res.status(422).json({ error: "Contenido no permitido." });
      return;
    }
    // Aprendizaje de ESTRUCTURA (abstracto y anónimo): deriva señal de craft del
    // texto permitido y la suma al agregado. No guarda el texto; corre en segundo
    // plano para no demorar la respuesta de la lectora.
    learnFromTextInBackground(text.slice(0, 16000));
    res.json({ draft });
  })
);

// Vista de solo lectura del agregado de craft (números; sin texto ni obras).
// Útil para verificar que lo aprendido es abstracto y anónimo.
app.get(
  "/api/craft-stats",
  requireAdmin,
  handler(async (_req, res) => {
    res.json(await getCraftStats());
  })
);

app.post(
  "/api/openings",
  requireAuth,
  handler(async (req, res) => {
    const { profileId, format } = req.body as { profileId?: string; format?: FormatKey };
    const out = await withDB(async (db) => {
      const me = currentUser(db, req);
      sweepExpired(db);
      await createOpening(db, profileId ?? null, format as FormatKey, {}, me.id);
      return publicState(db, me.id);
    });
    res.json(out);
  })
);

app.post(
  "/api/openings/extra",
  requireAuth,
  handler(async (req, res) => {
    const { profileId, format } = req.body as { profileId?: string; format?: FormatKey };
    const out = await withDB(async (db) => {
      const me = currentUser(db, req);
      sweepExpired(db);
      // TODO: confirmar pago de la apertura extra
      await createOpening(db, profileId ?? null, format as FormatKey, { paidExtra: true }, me.id);
      return publicState(db, me.id);
    });
    res.json(out);
  })
);

app.post(
  "/api/openings/:id/purchase",
  requireAuth,
  handler(async (req, res) => {
    const id = req.params.id;
    // TODO: confirmar pago con la pasarela
    const out = await withDB(async (db) => {
      const me = currentUser(db, req);
      sweepExpired(db);
      ownStoryOr403(db, id, me);
      await purchaseOpening(db, id);
      return publicState(db, me.id);
    });
    // Compra ya guardada (rápida). Genera los capítulos restantes en segundo plano.
    void generateRemaining(id);
    res.json(out);
  })
);

app.post(
  "/api/openings/:id/sequel",
  requireAuth,
  handler(async (req, res) => {
    const out = await withDB(async (db) => {
      const me = currentUser(db, req);
      sweepExpired(db);
      const prev = ownStoryOr403(db, req.params.id, me);
      await createOpening(db, null, prev.format, {
        predecessorId: prev.id,
        profileSnapshot: prev.profileSnapshot,
      }, me.id);
      return publicState(db, me.id);
    });
    res.json(out);
  })
);

app.post(
  "/api/openings/:id/finish",
  requireAuth,
  handler(async (req, res) => {
    const finished = (req.body?.finished as boolean) ?? true;
    const out = await withDB((db) => {
      const me = currentUser(db, req);
      sweepExpired(db);
      ownStoryOr403(db, req.params.id, me);
      setFinished(db, req.params.id, finished);
      return publicState(db, me.id);
    });
    res.json(out);
  })
);

// Borra un libro de forma permanente (cualquier estado: apertura, en lectura o
// leído). Si la cuota de aperturas gratis se deriva de las historias activas,
// borrar una apertura libera su cupo automáticamente al recomputar publicState.
app.delete(
  "/api/openings/:id",
  requireAuth,
  handler(async (req, res) => {
    const out = await withDB((db) => {
      const me = currentUser(db, req);
      sweepExpired(db);
      const s = ownStoryOr403(db, req.params.id, me);
      const i = db.stories.findIndex((x) => x.id === s.id);
      db.stories.splice(i, 1);
      return publicState(db, me.id);
    });
    res.json(out);
  })
);

// Regenera la portada UNA sola vez por libro. Guarda la nueva SIN borrar la
// anterior; el activo no cambia hasta que el usuario elija con /cover/choose.
app.post(
  "/api/openings/:id/cover/regenerate",
  requireAuth,
  handler(async (req, res) => {
    const id = req.params.id;
    await withDB((db) => {
      const s = ownStoryOr403(db, id, currentUser(db, req));
      if (s.coverRegenerated) throw new HttpError(409, "Ya regeneraste la portada de este libro.");
      if (!s.coverImage) throw new HttpError(400, "Este libro aún no tiene portada.");
      return null;
    });
    const alt = await regenerateCover(id); // lento: fuera del lock
    if (!alt) throw new HttpError(502, "No se pudo generar la portada. Inténtalo más tarde.");
    const out = await withDB((db) => {
      const me = currentUser(db, req);
      const s = ownStoryOr403(db, id, me);
      s.coverImageOrig = s.coverImage || null; // conserva la original
      s.coverImageAlt = alt;                    // guarda la alternativa
      s.coverRegenerated = true;                // gasta la única regeneración
      return publicState(db, me.id);
    });
    res.json(out);
  })
);

// Elige qué portada queda activa: "orig" o "alt". Alternable las veces que se
// quiera (ambas imágenes están en disco); no consume regeneración.
app.post(
  "/api/openings/:id/cover/choose",
  requireAuth,
  handler(async (req, res) => {
    const which = String(req.body?.which || "");
    const out = await withDB((db) => {
      const me = currentUser(db, req);
      const s = ownStoryOr403(db, req.params.id, me);
      if (!s.coverRegenerated || !s.coverImageAlt) throw new HttpError(400, "No hay portada alternativa que elegir.");
      if (which === "orig") s.coverImage = s.coverImageOrig || s.coverImage;
      else if (which === "alt") s.coverImage = s.coverImageAlt;
      else throw new HttpError(400, "Opción inválida.");
      return publicState(db, me.id);
    });
    res.json(out);
  })
);

// Manejador de errores global: traduce lo que lancen los middleware (p. ej.
// requireAuth/requireAdmin, que corren ANTES del wrapper `handler`) a JSON con
// el código correcto, en vez del HTML 500 por defecto de Express.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const e = err as HttpError;
  if (!(e && e.code)) console.error("[api error]", req.method, req.url, "\n", (e && e.stack) || e);
  res.status((e && e.code) || 500).json({ error: (e && e.message) || "Error" });
});

app.listen(PORT, () => {
  console.log(`Queneau backend en http://localhost:${PORT}`);
  // Reconcilia el rol de superusuario con SUPERUSER_EMAIL (promueve el actual,
  // degrada al admin-por-env anterior). Se ejecuta en cada arranque.
  void withDB((db) => {
    const n = reconcileSuperusers(db);
    if (n) console.log(`[auth] superusuarios reconciliados: ${n} cambio(s)`);
  });
  // Retoma libros comprados que quedaron a medias por un reinicio.
  void resumeUnfinished();
});

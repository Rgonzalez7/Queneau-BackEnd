import express, { type Request, type Response } from "express";
import cors from "cors";
import "dotenv/config";
import { withDB } from "./lib/db";
import { COVERS_DIR } from "./lib/cover";
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
import { analyzeText } from "./lib/analyzer";
import { uid, HttpError } from "./lib/constants";
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

// CORS: permite que el frontend (otro origen) consuma la API.
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: "1mb" }));
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

app.get(
  "/api/state",
  handler(async (_req, res) => {
    const out = await withDB((db) => {
      sweepExpired(db);
      kickPending(db); // reactiva workers de libros a medias
      return publicState(db);
    });
    res.json(out);
  })
);

app.post(
  "/api/profiles",
  handler(async (req, res) => {
    const body = (req.body || {}) as Partial<Profile>;
    const out = await withDB((db) => {
      sweepExpired(db);
      const profile: Profile = {
        id: body.id || uid(),
        name: body.name || "Sin nombre",
        source: body.source || "manual",
        genre: body.genre || "",
        tropes: body.tropes || [],
        heat_level: body.heat_level ?? null,
        tone: body.tone || [],
        pov: body.pov || "",
        pacing: body.pacing || "",
        must_haves: body.must_haves || [],
        avoid: body.avoid || [],
        settings: body.settings || [],
        created: body.created || Date.now(),
      };
      const i = db.profiles.findIndex((p) => p.id === profile.id);
      if (i >= 0) db.profiles[i] = profile;
      else db.profiles.unshift(profile);
      return publicState(db);
    });
    res.json(out);
  })
);

app.delete(
  "/api/profiles/:id",
  handler(async (req, res) => {
    const out = await withDB((db) => {
      sweepExpired(db);
      db.profiles = db.profiles.filter((p) => p.id !== req.params.id);
      return publicState(db);
    });
    res.json(out);
  })
);

app.post(
  "/api/profiles/extract",
  handler(async (req, res) => {
    const text = (req.body?.text as string) || "";
    if (text.replace(/\s/g, "").length < 200) {
      res.status(400).json({ error: "Hace falta más texto — pega un par de páginas." });
      return;
    }
    const draft = analyzeText(text.slice(0, 16000));
    if (draft.blocked) {
      res.status(422).json({ error: "Contenido no permitido." });
      return;
    }
    res.json({ draft });
  })
);

app.post(
  "/api/openings",
  handler(async (req, res) => {
    const { profileId, format } = req.body as { profileId?: string; format?: FormatKey };
    const out = await withDB(async (db) => {
      sweepExpired(db);
      await createOpening(db, profileId ?? null, format as FormatKey);
      return publicState(db);
    });
    res.json(out);
  })
);

app.post(
  "/api/openings/extra",
  handler(async (req, res) => {
    const { profileId, format } = req.body as { profileId?: string; format?: FormatKey };
    const out = await withDB(async (db) => {
      sweepExpired(db);
      // TODO: confirmar pago de la apertura extra
      await createOpening(db, profileId ?? null, format as FormatKey, { paidExtra: true });
      return publicState(db);
    });
    res.json(out);
  })
);

app.post(
  "/api/openings/:id/purchase",
  handler(async (req, res) => {
    const id = req.params.id;
    // TODO: confirmar pago con la pasarela
    const out = await withDB(async (db) => {
      sweepExpired(db);
      await purchaseOpening(db, id);
      return publicState(db);
    });
    // Compra ya guardada (rápida). Genera los capítulos restantes en segundo plano.
    void generateRemaining(id);
    res.json(out);
  })
);

app.post(
  "/api/openings/:id/sequel",
  handler(async (req, res) => {
    const out = await withDB(async (db) => {
      sweepExpired(db);
      const prev = db.stories.find((s) => s.id === req.params.id);
      if (!prev) throw new HttpError(404, "Libro no encontrado");
      await createOpening(db, null, prev.format, {
        predecessorId: prev.id,
        profileSnapshot: prev.profileSnapshot,
      });
      return publicState(db);
    });
    res.json(out);
  })
);

app.post(
  "/api/openings/:id/finish",
  handler(async (req, res) => {
    const finished = (req.body?.finished as boolean) ?? true;
    const out = await withDB((db) => {
      sweepExpired(db);
      setFinished(db, req.params.id, finished);
      return publicState(db);
    });
    res.json(out);
  })
);

app.listen(PORT, () => {
  console.log(`Queneau backend en http://localhost:${PORT}`);
  // Retoma libros comprados que quedaron a medias por un reinicio.
  void resumeUnfinished();
});

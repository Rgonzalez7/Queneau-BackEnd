import type { DB, Story, FormatKey, Quota, PublicState, Profile } from "./types";
import { FORMATS, FREE_QUOTA, OPENING_TTL_MS, uid, HttpError } from "./constants";
import { withDB } from "./db";
import { buildBible, SafetyError } from "./bible";
import { pickVoice } from "./styledna";
import { writeSynopsis, writeChapter, summarizeChapter, fallbackChapter, generateBookTitle } from "./generator";
import { generateCover, coverEnabled } from "./cover";

/* R2 — barrer aperturas gratis caducadas. Devuelve true si cambió algo. */
export function sweepExpired(db: DB): boolean {
  const now = Date.now();
  const before = db.stories.length;
  db.stories = db.stories.filter(
    (s) => !(s.origin === "gratis" && !s.paid && s.expiresAt && s.expiresAt <= now)
  );
  return before !== db.stories.length;
}

/* Selecciona las historias de un dueño (o todas si ownerId es undefined). */
function ownedStories(db: DB, ownerId?: string): Story[] {
  return ownerId ? db.stories.filter((s) => s.ownerId === ownerId) : db.stories;
}

export function quotaState(db: DB, ownerId?: string): Quota {
  const mine = ownedStories(db, ownerId);
  const used = mine.filter((s) => s.origin === "gratis" && !s.paid).length;
  return {
    used,
    total: FREE_QUOTA,
    available: Math.max(0, FREE_QUOTA - used),
    hasPurchased: mine.some((s) => s.paid),
  };
}

interface OpeningOpts {
  paidExtra?: boolean;
  predecessorId?: string | null;
  profileSnapshot?: Profile;
}

/* Construye la biblia con modelo + safety; traduce SafetyError -> 422. */
async function bibleFor(profile: Profile, format: FormatKey, seed?: string) {
  try {
    return await buildBible(profile, { format, seed });
  } catch (e) {
    if (e instanceof SafetyError) throw new HttpError(422, e.message);
    throw e;
  }
}

export async function createOpening(
  db: DB,
  profileId: string | null,
  format: FormatKey,
  opts: OpeningOpts = {},
  ownerId?: string
): Promise<Story> {
  if (!FORMATS[format]) throw new HttpError(400, "Formato inválido");
  const profile =
    opts.profileSnapshot ||
    db.profiles.find((p) => p.id === profileId && (!ownerId || p.ownerId === ownerId));
  if (!profile) throw new HttpError(404, "Perfil no encontrado");

  // R0: un solo libro generándose a la vez POR USUARIO. Si el usuario tiene un
  // libro comprado todavía produciendo capítulos, no puede crear otra apertura.
  if (isBusyGenerating(db, ownerId)) {
    throw new HttpError(
      409,
      "Tu libro recién comprado se está generando. Espera a que termine para crear otro."
    );
  }

  const paidExtra = !!opts.paidExtra;
  if (!paidExtra) {
    // R1: solo gratis si hay cuota (del usuario)
    if (quotaState(db, ownerId).available <= 0) {
      throw new HttpError(
        402,
        "Cuota de aperturas gratis agotada. Compra un libro, espera a que una caduque, o paga una apertura extra."
      );
    }
  } else {
    // TODO: confirmar pago real de la apertura extra antes de continuar
  }

  const predecessor = opts.predecessorId
    ? db.stories.find((s) => s.id === opts.predecessorId) || null
    : null;

  // id único del libro. También es la SEMILLA de la biblia: así dos libros del
  // MISMO perfil obtienen nombres y trama distintos (la variedad depende del seed).
  const storyId = uid();

  // Secuela: hereda la biblia congelada del predecesor (mismo mundo/personajes).
  // Si no, se construye con el modelo (+ safety), sembrada con el id del libro.
  const bible = predecessor?.bibleSnapshot ?? (await bibleFor(profile, format, storyId));

  // Asigna una VOZ (ADN de estilo) a los libros nuevos, estable por semilla, para
  // variar la sensación de autor. Las secuelas heredan la voz del predecesor.
  if (!predecessor && !bible.voice) {
    const v = pickVoice(db.voices, profile, storyId);
    if (v) bible.voice = v;
  }

  // Apertura: solo sinopsis + capítulo 1 (el gancho gratis).
  const synopsis = await writeSynopsis(bible, format, predecessor);
  let ch1 = await writeChapter({ bible, index: 1, storySoFar: "" });
  if (!ch1) ch1 = await writeChapter({ bible, index: 1, storySoFar: "" }); // un reintento
  if (!ch1) ch1 = fallbackChapter(bible, 1); // último recurso coherente (nunca un stub)

  const now = Date.now();
  const origin = paidExtra ? "pagada_extra" : "gratis";

  const story: Story = {
    id: storyId,
    ownerId,
    profileSnapshot: JSON.parse(JSON.stringify(profile)), // FOTO CONGELADA
    profileName: profile.name,
    predecessorId: predecessor ? predecessor.id : null,
    title: (predecessor ? "Secuela · " : "") + profile.name + " · " + FORMATS[format].label,
    synopsis,
    format,
    bibleSnapshot: bible, // biblia CONGELADA
    chapters: [ch1], // solo cap. 1 en la apertura
    origin,
    paid: false,
    created: now,
    expiresAt: origin === "gratis" ? now + OPENING_TTL_MS : null, // R2: solo las gratis caducan
    status: "apertura",
    finished: false,
  };
  db.stories.unshift(story);
  void generateCover(story.id); // portada IA en segundo plano
  return story;
}

/* COMPRA (rápida): desbloquea, libera cuota y marca el libro para generación.
   NO genera los capítulos aquí — eso lo hace el worker en segundo plano, para
   no colgar la petición ni perderlo todo si algo falla a mitad. */
export async function purchaseOpening(db: DB, id: string): Promise<Story> {
  const s = db.stories.find((x) => x.id === id);
  if (!s) throw new HttpError(404, "Apertura no encontrada");
  if (s.paid) return s;
  // TODO: confirmar pago real antes de desbloquear

  const total = FORMATS[s.format].chapters;
  // Biblia congelada; si es una historia antigua sin biblia, se construye una vez.
  s.bibleSnapshot = s.bibleSnapshot ?? (await bibleFor(s.profileSnapshot, s.format, s.id));
  if (!s.bibleSnapshot.voice) {
    const v = pickVoice(db.voices, s.profileSnapshot, s.id);
    if (v) s.bibleSnapshot.voice = v;
  }

  s.paid = true; // R3: comprada
  s.expiresAt = null; // lo pagado NUNCA caduca
  s.status = "desbloqueada";
  s.finished = false; // entra a "en lectura"
  s.chaptersTotal = total;
  s.generating = s.chapters.length < total; // faltan capítulos por generar
  return s;
}

/* Worker en proceso: genera los capítulos que falten, uno a uno, GUARDANDO
   cada uno apenas sale. El trabajo lento (modelo) ocurre fuera del candado;
   solo el append a la db se hace bajo withDB. Si el server se reinicia a mitad,
   resumeUnfinished() lo retoma. Para escala real (varios servidores) esto se
   reemplaza por una cola externa (Redis/BullMQ) con la misma idea. */
const _working = new Set<string>();

export async function generateRemaining(storyId: string): Promise<void> {
  if (_working.has(storyId)) return; // evita workers duplicados
  _working.add(storyId);
  try {
    // snapshot inicial (rápido, bajo candado)
    const init = await withDB((db) => {
      const s = db.stories.find((x) => x.id === storyId);
      if (!s || !s.paid || !s.bibleSnapshot) return null;
      return {
        bible: s.bibleSnapshot,
        total: s.chaptersTotal ?? FORMATS[s.format].chapters,
        have: s.chapters.map((c) => c.b),
        needTitle: !s.bookTitle,
        opening: s.chapters[0]?.b || "",
      };
    });
    if (!init) return;
    const { bible, total } = init;

    // Título real del libro (corto, dark), una sola vez, apenas comprado. El
    // trabajo lento (modelo) va fuera del candado; solo el guardado es bajo withDB.
    if (init.needTitle) {
      const bookTitle = await generateBookTitle(bible, init.opening);
      if (bookTitle) {
        await withDB((db) => {
          const s = db.stories.find((x) => x.id === storyId);
          if (s && !s.bookTitle) s.bookTitle = bookTitle;
        });
      }
    }

    // resumen corriente de lo ya escrito (continuidad)
    let storySoFar = "";
    for (let i = 0; i < init.have.length; i++) {
      const sum = await summarizeChapter(bible, i + 1, init.have[i]);
      storySoFar += (i ? "\n" : "") + `Cap ${i + 1}: ${sum}`;
    }

    // genera y guarda los que faltan
    for (let n = init.have.length + 1; n <= total; n++) {
      // writeChapter ya reintenta con espera internamente; aquí un reintento más
      // por si un capítulo extremo agota la cadena, y como ÚLTIMO recurso un
      // capítulo coherente (nunca el stub de desarrollador).
      let ch = await writeChapter({ bible, index: n, storySoFar });
      if (!ch) ch = await writeChapter({ bible, index: n, storySoFar });
      if (!ch) ch = fallbackChapter(bible, n);
      await withDB((db) => {
        const s = db.stories.find((x) => x.id === storyId);
        if (s) s.chapters.push(ch);
      });
      const sum = await summarizeChapter(bible, n, ch.b);
      storySoFar += `\nCap ${n}: ${sum}`;
    }

    // marca completo
    await withDB((db) => {
      const s = db.stories.find((x) => x.id === storyId);
      if (s) s.generating = false;
    });
  } catch (e) {
    // Nunca dejes que un worker rechace: sería un unhandled rejection capaz de
    // tumbar el proceso. Se loguea y se deja `generating=true`, de modo que
    // kickPending lo reanude en la próxima lectura de estado.
    console.error(`[gen] worker falló en ${storyId}:`, (e as Error).message);
  } finally {
    _working.delete(storyId);
  }
}

/* Al arrancar el server: retoma libros comprados que quedaron a medias
   (por un reinicio durante la generación). */
export async function resumeUnfinished(): Promise<void> {
  const ids = await withDB((db) =>
    db.stories
      .filter((s) => {
        const total = s.chaptersTotal ?? FORMATS[s.format].chapters;
        return s.paid && s.chapters.length < total;
      })
      .map((s) => {
        s.chaptersTotal = s.chaptersTotal ?? FORMATS[s.format].chapters;
        s.generating = true;
        return s.id;
      })
  );
  for (const id of ids) void generateRemaining(id); // en segundo plano
}

/* Auto-arranque: en cada lectura de estado, reactiva el worker de cualquier
   libro comprado que quedó a medias y cuyo worker NO esté corriendo (tras un
   reinicio, un fallo, o si nunca arrancó). Seguro de llamar a menudo:
   generateRemaining ignora duplicados vía _working. Se ejecuta dentro de un
   withDB (db ya cargada y mutable). */
/* ¿Hay algún libro comprado todavía generándose? (capítulos incompletos o
   marcado generating). Se usa para bloquear nuevas aperturas mientras tanto. */
export function isBusyGenerating(db: DB, ownerId?: string): boolean {
  return ownedStories(db, ownerId).some((s) => {
    const total = s.chaptersTotal ?? FORMATS[s.format].chapters;
    return s.paid && (s.generating === true || s.chapters.length < total);
  });
}

export function kickPending(db: DB): void {
  for (const s of db.stories) {
    const total = s.chaptersTotal ?? FORMATS[s.format].chapters;
    if (s.paid && s.chapters.length < total && !_working.has(s.id)) {
      s.chaptersTotal = total;
      s.generating = true;
      void generateRemaining(s.id);
    }
    // portada IA: genera la de cualquier libro que aún no la tenga
    if (!s.coverImage && s.bibleSnapshot) void generateCover(s.id);
  }
}

export function setFinished(db: DB, id: string, finished: boolean): Story {
  const s = db.stories.find((x) => x.id === id);
  if (!s) throw new HttpError(404, "Libro no encontrado");
  if (!s.paid) throw new HttpError(400, "Solo los libros comprados se marcan como leídos");
  s.finished = finished;
  return s;
}

/* Estado público: aplica el muro (sin pagar, solo cap. 1). */
export function publicState(db: DB, ownerId?: string): PublicState {
  const q = quotaState(db, ownerId);
  const profiles = ownerId ? db.profiles.filter((p) => p.ownerId === ownerId) : db.profiles;
  return {
    brand: "Quenu",
    quota: q,
    formats: FORMATS,
    profiles,
    stories: ownedStories(db, ownerId).map((s) => {
      const total = s.chaptersTotal ?? FORMATS[s.format].chapters;
      return {
        id: s.id,
        title: s.title,
        profileName: s.profileName,
        genre: s.profileSnapshot.genre || "", // derivado de la foto congelada del perfil
        format: s.format,
        synopsis: s.synopsis,
        paid: s.paid,
        status: s.status,
        origin: s.origin,
        predecessorId: s.predecessorId,
        chapters: s.paid ? s.chapters : s.chapters.slice(0, 1),
        lockedChapters: s.paid ? 0 : total - 1,
        chaptersReady: s.paid ? s.chapters.length : 1,
        chaptersTotal: total,
        generating: !!s.generating,
        coverImage: s.coverImage ?? null,
        bookTitle: s.bookTitle ?? null,
        coverImageOrig: s.coverImageOrig ?? null,
        coverImageAlt: s.coverImageAlt ?? null,
        coverRegenerated: Boolean(s.coverRegenerated),
        coverPending: coverEnabled() && !s.coverImage,
        price: FORMATS[s.format].price,
        expiresInDays: s.expiresAt
          ? Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 86400000))
          : null,
        finished: !!s.finished,
      };
    }),
  };
}

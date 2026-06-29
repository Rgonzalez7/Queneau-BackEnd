/* ---------------------------------------------------------------------------
   craft.ts — APRENDIZAJE DE ESTRUCTURA (no de texto).

   A partir de un PDF/texto subido, deriva SOLO señal de craft ABSTRACTA:
   categorías de un vocabulario CERRADO (ritmo, motor de conflicto, dinámica de
   poder, tipo de heroína, intensidad) y la POSICIÓN aproximada (0-100) de unos
   beats genéricos. Se valida contra los catálogos: cualquier cosa fuera del
   vocabulario se descarta. Por construcción NO guarda texto, nombres, frases ni
   filas por obra — solo AGREGADOS anónimos (conteos e histogramas).

   Objetivo: que bible.ts pueda, más adelante, usar plantillas/curvas aprendidas
   en vez de fijas a mano, sin tocar la postura legal (ideas, no expresión).

   Nada aquí almacena el texto fuente. recordCraftSignal solo suma a CraftStats.
--------------------------------------------------------------------------- */
import type { CraftStats } from "./types";
import { getProvider } from "./provider";
import { withDB } from "./db";

/* --------------------------- vocabularios CERRADOS --------------------------- */
/* El modelo DEBE elegir solo de estas listas. Si devuelve otra cosa, se descarta. */
export const CRAFT_GENRES = [
  "dark romance", "romance mafia", "romance paranormal", "romance contemporáneo",
  "romance histórico", "romance de terror", "romance militar", "romance fantástico",
];
export const CRAFT_PACING = ["slow burn", "ritmo medio", "rápido / intenso"];
export const CRAFT_ENGINE = [
  "cautiverio", "venganza", "alianza o matrimonio forzado", "amor prohibido",
  "cacería o persecución", "deuda o chantaje", "protección o guardián",
  "redención", "obsesión", "secreto de identidad",
];
export const CRAFT_POWER = ["él domina", "ella domina", "lucha por el control", "equilibrio inestable"];
export const CRAFT_HEROINE = [
  "inocente que se endurece", "fuerte desde el inicio", "cómplice o igual",
  "vengadora", "superviviente",
];
export const CRAFT_HEAT = ["cerradas", "cálido", "picante", "explícito"];
export const CRAFT_BEATS = [
  "encuentro", "primer choque", "tensión o atracción", "primera intimidad",
  "escalada de peligro", "traición o secreto", "punto de quiebre",
  "separación", "clímax", "resolución",
];
export const CRAFT_TROPES = [
  "Enemies to Lovers", "Forbidden Love", "Obsesor x Obsesionada", "Villano x Heroína",
  "Mafia Boss x Heroína", "Capo x Fiscal", "Stalker x Víctima", "Depredador x Presa",
  "Manipulador x Manipuladora", "Jefe x Empleada", "Profesor x Alumna", "Guardaespaldas x Protegida",
  "Encerrados juntos", "Matrimonio por conveniencia", "Fingir noviazgo", "Exnovios",
  "Mejores amigos", "Amigos con beneficios", "Mutual Obsession", "Slow Burn",
  "Fast Burn", "Touch Her And Die", "Redemption Arc", "Secret Identity",
];
/* Estilo de las escenas íntimas — para aprender la VARIEDAD (lo que el usuario
   pidió): registro de lenguaje, ritmo e iniciativa. Categorías abstractas. */
export const CRAFT_IM_REGISTER = [
  "anatómico directo", "crudo vulgar", "eufemístico poético", "sensorial físico", "fundido a negro",
];
export const CRAFT_IM_PACING = ["lento provocador", "inmediato voraz", "intermitente"];
export const CRAFT_IM_INITIATOR = ["ella", "él", "compartido"];
/* Tipos de escena (espejo del paso "Escenas") — para contabilizarlas en la BD. */
export const CRAFT_SCENES = [
  "acción", "sexo explícito", "mutilación / gore", "tortura", "persecución",
  "confrontación / pelea", "traición", "celos", "peligro / secuestro",
  "reconciliación", "muerte de un personaje", "castigo",
];

/* Señal POR análisis (transitoria, NO se guarda). */
export interface CraftSignal {
  genre?: string;
  pacing?: string;
  engine?: string;
  power?: string;
  heroine?: string;
  heat?: string;
  imRegister?: string;  // registro del lenguaje íntimo
  imPacing?: string;    // ritmo de la escena íntima
  imInitiator?: string; // quién lleva la iniciativa
  scenes: { type: string; count: number }[]; // tipos de escena detectados + cuántas
  tropes: string[];
  beats: { beat: string; pos: number }[]; // pos 0-100
}

const norm = (s: string) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

function inVocab(value: unknown, vocab: string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = norm(value.trim());
  return vocab.find((opt) => norm(opt) === v); // match exacto contra el catálogo
}

/* --------------------------- extracción con modelo --------------------------- */
const CATALOG_BLOCK = [
  `GÉNERO: ${CRAFT_GENRES.join(" | ")}`,
  `RITMO: ${CRAFT_PACING.join(" | ")}`,
  `MOTOR: ${CRAFT_ENGINE.join(" | ")}`,
  `PODER: ${CRAFT_POWER.join(" | ")}`,
  `HEROÍNA: ${CRAFT_HEROINE.join(" | ")}`,
  `INTENSIDAD: ${CRAFT_HEAT.join(" | ")}`,
  `REGISTRO_INTIMO: ${CRAFT_IM_REGISTER.join(" | ")}`,
  `RITMO_INTIMO: ${CRAFT_IM_PACING.join(" | ")}`,
  `INICIATIVA_INTIMA: ${CRAFT_IM_INITIATOR.join(" | ")}`,
  `ESCENAS: ${CRAFT_SCENES.join(" | ")}`,
  `BEATS: ${CRAFT_BEATS.join(" | ")}`,
  `TROPES: ${CRAFT_TROPES.join(" | ")}`,
].join("\n");

const SYSTEM = [
  "Eres un analista de ESTRUCTURA narrativa. Recibes un fragmento de una novela romántica.",
  "Devuelve SOLO un objeto JSON con la estructura ABSTRACTA, usando EXCLUSIVAMENTE las etiquetas de los catálogos.",
  "PROHIBIDO: copiar texto, nombres propios, frases, lugares o cualquier detalle único de la obra. Solo categorías genéricas y posiciones.",
  "Si hay escenas íntimas, clasifica su REGISTRO de lenguaje, su RITMO y la INICIATIVA (categorías abstractas; nunca copies las frases).",
  "Para cada beat que identifiques, estima su POSICIÓN como porcentaje del fragmento (0 = inicio, 100 = final).",
  "Si un campo no aplica o no estás seguro, OMÍTELO. No inventes.",
  "",
  "CATÁLOGOS (elige solo de aquí):",
  CATALOG_BLOCK,
  "",
  'Formato EXACTO (sin texto extra, sin Markdown): {"genre":"","pacing":"","engine":"","power":"","heroine":"","heat":"","imRegister":"","imPacing":"","imInitiator":"","scenes":[{"type":"","count":0}],"tropes":[],"beats":[{"beat":"","pos":0}]}',
].join("\n");

function safeJson(raw: string): Record<string, unknown> | null {
  const s = raw.replace(/```json|```/g, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

/** Valida la salida cruda contra los catálogos: descarta TODO lo que no esté. */
function sanitize(raw: Record<string, unknown>): CraftSignal {
  const out: CraftSignal = { scenes: [], tropes: [], beats: [] };
  out.genre = inVocab(raw.genre, CRAFT_GENRES);
  out.pacing = inVocab(raw.pacing, CRAFT_PACING);
  out.engine = inVocab(raw.engine, CRAFT_ENGINE);
  out.power = inVocab(raw.power, CRAFT_POWER);
  out.heroine = inVocab(raw.heroine, CRAFT_HEROINE);
  out.heat = inVocab(raw.heat, CRAFT_HEAT);
  out.imRegister = inVocab(raw.imRegister, CRAFT_IM_REGISTER);
  out.imPacing = inVocab(raw.imPacing, CRAFT_IM_PACING);
  out.imInitiator = inVocab(raw.imInitiator, CRAFT_IM_INITIATOR);

  if (Array.isArray(raw.scenes)) {
    const seen = new Set<string>();
    for (const it of raw.scenes) {
      if (!it || typeof it !== "object") continue;
      const type = inVocab((it as Record<string, unknown>).type, CRAFT_SCENES);
      if (!type || seen.has(type)) continue;
      let count = Math.round(Number((it as Record<string, unknown>).count));
      if (!isFinite(count) || count < 1) count = 1;
      out.scenes.push({ type, count: Math.min(10, count) });
      seen.add(type);
    }
  }

  if (Array.isArray(raw.tropes)) {
    const seen = new Set<string>();
    for (const t of raw.tropes) {
      const m = inVocab(t, CRAFT_TROPES);
      if (m && !seen.has(m)) { seen.add(m); out.tropes.push(m); }
    }
  }
  if (Array.isArray(raw.beats)) {
    const seen = new Set<string>();
    for (const it of raw.beats) {
      if (!it || typeof it !== "object") continue;
      const b = inVocab((it as Record<string, unknown>).beat, CRAFT_BEATS);
      let pos = Number((it as Record<string, unknown>).pos);
      if (!b || seen.has(b) || !isFinite(pos)) continue;
      pos = Math.max(0, Math.min(100, Math.round(pos)));
      seen.add(b);
      out.beats.push({ beat: b, pos });
    }
  }
  return out;
}

/** Heurística sin modelo (fallback): deriva lo básico por palabras clave.
    No estima beats (no se pueden ubicar sin un análisis real). */
function heuristicSignal(text: string): CraftSignal {
  const t = norm(text);
  const has = (...ks: string[]) => ks.some((k) => t.includes(k));
  const sig: CraftSignal = { scenes: [], tropes: [], beats: [] };
  if (has("mafia", "capo", "cartel")) sig.genre = "romance mafia";
  else if (has("vampir", "lobo", "licantrop", "demonio")) sig.genre = "romance paranormal";
  else if (has("duque", "regencia", "victorian")) sig.genre = "romance histórico";
  else if (has("oscur", "secuestr", "cautiv")) sig.genre = "dark romance";

  if (has("secuestr", "cautiv", "encerr", "prisioner")) sig.engine = "cautiverio";
  else if (has("vengan", "venganza")) sig.engine = "venganza";
  else if (has("prohibid")) sig.engine = "amor prohibido";
  else if (has("obsesi")) sig.engine = "obsesión";

  if (has("posesiv", "te controlo", "eres mia", "eres mía")) sig.power = "él domina";
  if (has("lent", "pausad", "slow")) sig.pacing = "slow burn";
  else if (has("rapid", "vertigin", "intens")) sig.pacing = "rápido / intenso";

  const heat = ["sexual", "desnud", "gemid", "penetr", "orgasm"].filter((k) => t.includes(k)).length;
  sig.heat = heat >= 3 ? "explícito" : heat >= 1 ? "picante" : has("beso", "caricia") ? "cálido" : "cerradas";

  for (const tr of CRAFT_TROPES) if (t.includes(norm(tr).split(" ")[0])) sig.tropes.push(tr);
  sig.tropes = sig.tropes.slice(0, 6);

  // contabilidad básica de escenas por palabras clave
  const sceneKW: Record<string, string[]> = {
    "acción": ["disparo", "explosion", "persecucion", "arma"],
    "sexo explícito": ["penetr", "gemid", "orgasm", "desnud", "sexual"],
    "mutilación / gore": ["sangre", "despell", "mutil", "desoll", "viscer"],
    "tortura": ["tortur", "bisturi", "atad", "suplici"],
    "persecución": ["persecucion", "huir", "escap", "perseg"],
    "confrontación / pelea": ["pelea", "golpe", "punet", "ataque"],
    "traición": ["traicion", "engan", "mentir"],
    "celos": ["celos"],
    "peligro / secuestro": ["secuestr", "cautiv", "rapt", "amenaza"],
    "reconciliación": ["reconcili", "perdon", "volver juntos"],
    "muerte de un personaje": ["murio", "asesin", "cadaver", "matar"],
    "castigo": ["castig", "azot", "correa"],
  };
  for (const [type, kws] of Object.entries(sceneKW)) {
    if (kws.some((k) => t.includes(k))) sig.scenes.push({ type, count: 1 });
  }
  return sig;
}

/** Deriva la señal de craft de un texto. Usa el modelo si hay; si no, heurística.
    NUNCA guarda el texto. Devuelve solo categorías validadas. */
export async function extractCraftSignal(text: string): Promise<CraftSignal> {
  if (process.env.CRAFT_LEARNING === "off") return { scenes: [], tropes: [], beats: [] };
  const sample = text.slice(0, 14000);
  try {
    const { text: out } = await getProvider().complete({
      system: SYSTEM,
      messages: [{ role: "user", content: sample }],
      maxTokens: 400,
      temperature: 0.2,
    });
    const parsed = safeJson(out);
    if (parsed) {
      const sig = sanitize(parsed);
      // si el modelo no entregó casi nada útil, refuerza con heurística
      if (!sig.genre && !sig.engine && sig.scenes.length === 0 && sig.tropes.length === 0 && sig.beats.length === 0) {
        return mergeSignals(sig, heuristicSignal(text));
      }
      return sig;
    }
  } catch {
    /* cae a heurística */
  }
  return heuristicSignal(text);
}

function mergeSignals(a: CraftSignal, b: CraftSignal): CraftSignal {
  return {
    genre: a.genre || b.genre,
    pacing: a.pacing || b.pacing,
    engine: a.engine || b.engine,
    power: a.power || b.power,
    heroine: a.heroine || b.heroine,
    heat: a.heat || b.heat,
    imRegister: a.imRegister || b.imRegister,
    imPacing: a.imPacing || b.imPacing,
    imInitiator: a.imInitiator || b.imInitiator,
    scenes: a.scenes.length ? a.scenes : b.scenes,
    tropes: Array.from(new Set([...a.tropes, ...b.tropes])),
    beats: a.beats.length ? a.beats : b.beats,
  };
}

/* --------------------------- agregación anónima --------------------------- */
function emptyStats(): CraftStats {
  return {
    samples: 0, updated: 0,
    genre: {}, pacing: {}, engine: {}, power: {}, heroine: {}, heat: {},
    imRegister: {}, imPacing: {}, imInitiator: {}, scenes: {},
    tropePairs: {}, beatPos: {},
  };
}
const bump = (m: Record<string, number>, k?: string) => { if (k) m[k] = (m[k] || 0) + 1; };

/** Funde una señal en el agregado. Solo suma conteos/posiciones; sin texto. */
export async function recordCraftSignal(sig: CraftSignal): Promise<void> {
  if (process.env.CRAFT_LEARNING === "off") return;
  // nada que aprender si vino vacía
  if (!sig.genre && !sig.engine && !sig.pacing && !sig.heat && !sig.imRegister &&
      sig.scenes.length === 0 && sig.tropes.length === 0 && sig.beats.length === 0) return;

  await withDB((db) => {
    const cs = db.craftStats || emptyStats();
    cs.samples += 1;
    cs.updated = Date.now();
    bump(cs.genre, sig.genre);
    bump(cs.pacing, sig.pacing);
    bump(cs.engine, sig.engine);
    bump(cs.power, sig.power);
    bump(cs.heroine, sig.heroine);
    bump(cs.heat, sig.heat);
    bump(cs.imRegister, sig.imRegister);
    bump(cs.imPacing, sig.imPacing);
    bump(cs.imInitiator, sig.imInitiator);

    // contabilidad de escenas: suma las apariciones por tipo
    for (const s of sig.scenes) {
      if (!s || !s.type) continue;
      cs.scenes[s.type] = (cs.scenes[s.type] || 0) + Math.max(1, Math.min(10, Math.round(s.count || 1)));
    }

    // posiciones de beats: media incremental + histograma de 10 cubos
    for (const { beat, pos } of sig.beats) {
      const slot = cs.beatPos[beat] || { n: 0, sum: 0, hist: new Array(10).fill(0) };
      slot.n += 1;
      slot.sum += pos;
      slot.hist[Math.min(9, Math.floor(pos / 10))] += 1;
      cs.beatPos[beat] = slot;
    }

    // co-ocurrencia de tropes (pares en orden alfabético), tope para no explotar
    const tr = sig.tropes.slice(0, 8).sort();
    for (let i = 0; i < tr.length; i++) {
      for (let j = i + 1; j < tr.length; j++) {
        const key = `${tr[i]}|${tr[j]}`;
        cs.tropePairs[key] = (cs.tropePairs[key] || 0) + 1;
      }
    }

    db.craftStats = cs;
    return null;
  });
}

/** Procesa un texto en segundo plano (no bloquea la respuesta) y aprende de él. */
export function learnFromTextInBackground(text: string): void {
  if (process.env.CRAFT_LEARNING === "off") return;
  extractCraftSignal(text)
    .then((sig) => recordCraftSignal(sig))
    .catch(() => { /* el aprendizaje nunca debe afectar la petición del usuario */ });
}

/** Vista de solo lectura del agregado (números; sin texto ni obras). */
export async function getCraftStats(): Promise<CraftStats> {
  return withDB((db) => db.craftStats || emptyStats());
}

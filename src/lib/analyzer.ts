/* ---------------------------------------------------------------------------
   analyzer.ts — EXTRACTOR de perfil de gustos a partir de texto pegado.
   (Distinto de bible.ts, que arma la biblia de la historia.)

   Devuelve un borrador de Profile + bandera `blocked`. NO guarda el texto
   fuente: solo deriva etiquetas a nivel de género (postura legal del producto).
   Pasa el texto por safety: si hay indicios no permitidos, blocked = true.

   Es heurístico (stub mejorable): el día que quieras, el modelo puede hacer
   esta extracción con más finura, pero la decisión de bloqueo sigue en código.
--------------------------------------------------------------------------- */
import type { Profile, HeatLevel, SceneSpec } from "./types";
import { assessOutput, logIncident } from "./safety";
import { getAnalysisProvider } from "./provider";

export type ProfileDraft = Partial<Profile> & { blocked: boolean };

/* Tipos de escena — espejo EXACTO del paso "Escenas" del frontend. */
const A_SCENE_TYPES = [
  "acción", "sexo explícito", "mutilación / gore", "tortura", "persecución",
  "confrontación / pelea", "traición", "celos", "peligro / secuestro",
  "reconciliación", "muerte de un personaje", "castigo",
];

/* --------- catálogos del PERFIL (espejo EXACTO del frontend) ---------
   Los labels deben coincidir letra a letra para que el formulario los marque
   como seleccionados. El modelo solo puede elegir de estas listas. */
const A_TROPES = [
  // Opuestos complementarios
  "Grumpy x Sunshine", "Introvertido x Extrovertido", "Frío x Cariñoso",
  "Ordenado x Caótico", "Serio x Bromista", "Inocente x Experimentado", "Tradicional x Rebelde",
  // Enemigos y rivales
  "Enemies to Lovers", "Rivales académicos", "Rivales empresariales", "Mafias rivales",
  "Familias enemigas", "Policía x Criminal", "Espía x Espía enemigo", "Competidores deportivos",
  // Proximidad forzada
  "Compañeros de habitación", "Matrimonio arreglado", "Matrimonio por conveniencia",
  "Fingir noviazgo", "Protección de testigos", "Encerrados juntos", "Compartir misión",
  // Relaciones prohibidas
  "Profesor x Alumna", "Guardaespaldas x Protegida", "Jefe x Empleada",
  "Mejor amigo del hermano", "Sacerdote x Mujer", "Mafia rival",
  // Dark romance
  "Obsesor x Obsesionada", "Stalker x Víctima", "Villano x Heroína", "Psicópata x Psicópata",
  "Mafia Boss x Heroína", "Depredador x Presa", "Manipulador x Manipuladora",
  // Protector
  "Guardaespaldas x Cantante", "Detective x Víctima", "Militar x Testigo",
  "Mafioso x Mujer perseguida", "Mercenario x Rehén",
  // Segunda oportunidad
  "Exnovios", "Amor de infancia", "Ex prometidos", "Amor perdido",
  // Amigos a amantes
  "Mejores amigos", "Amigos de infancia", "Amigos con beneficios", "Compañeros de universidad",
  // Mafia
  "Don x Hija de rival", "Sicario x Objetivo", "Consigliere x Princesa mafia",
  "Mafia rusa x Mafia italiana", "Viuda mafia x Mano derecha", "Capo x Fiscal",
  // Militares y fuerzas especiales
  "Comandante x Analista", "Fuerzas especiales x Traductora", "Soldado x Periodista",
  "Militar x Doctora", "Francotirador x Espía", "Operador élite x Científica",
  // Fantasía oscura
  "Demonio x Bruja", "Ángel x Demonio", "Rey Fae x Humana",
  "Vampiro x Cazadora", "Dragón x Humana", "Dios x Mortal",
  // Thriller y suspense
  "Detective x Sospechosa", "Detective x Criminal", "Perfilador x Asesina serial",
  "Agente del FBI x Informante", "Hacker x Agente secreto",
  // Secretos y doble vida
  "Mafioso fingiendo ser empresario", "Espía fingiendo ser profesor", "Reina oculta", "Policía infiltrada",
  // Tropos populares
  "Touch Her And Die", "Burn The World For Her", "Who Did This To You?", "One Bed",
  "Forced Proximity", "Secret Identity", "Forbidden Love", "Revenge Romance",
  "Slow Burn", "Fast Burn", "Redemption Arc", "He Falls First", "She Falls First", "Mutual Obsession",
];
const A_HEAT: HeatLevel[] = ["cerradas", "cálido", "picante", "explícito"];
const A_TONE = ["oscuro", "tenso", "angsty", "tierno", "sensual", "sombrío", "emotivo", "con humor"];
const A_POV = ["primera persona dual", "primera persona única", "tercera persona", "múltiple"];
const A_PACING = ["slow burn", "ritmo medio", "rápido / intenso"];
const A_ARCHETYPE = [
  "El Villano", "El Monstruo", "El Rey", "El Principe Bratva", "El Psicopata",
  "El Acosador", "El Protector", "El Heore Roto", "El Golden Retriever",
];
const A_DARKNESS = ["dark-light", "dark", "very-dark", "extreme-dark"];
const A_GENRES = [
  "dark romance", "romance mafia", "romance paranormal", "romance contemporáneo",
  "romance histórico", "romance de terror", "romance militar", "romance fantástico",
  "new adult", "romance erótico",
];

const normv = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
function pickVocab(value: unknown, vocab: string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = normv(value);
  return vocab.find((o) => normv(o) === v);
}
function pickVocabMany(value: unknown, vocab: string[], max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of value) {
    const m = pickVocab(it, vocab);
    if (m && !seen.has(m)) { seen.add(m); out.push(m); if (out.length >= max) break; }
  }
  return out;
}
function safeJson(raw: string): Record<string, unknown> | null {
  const s = raw.replace(/```json|```/g, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
/** Valida las escenas detectadas contra el catálogo; cuenta acotada 1-10. */
function parseScenes(value: unknown): SceneSpec[] {
  if (!Array.isArray(value)) return [];
  const out: SceneSpec[] = [];
  const seen = new Set<string>();
  for (const it of value) {
    if (!it || typeof it !== "object") continue;
    const type = pickVocab((it as Record<string, unknown>).type, A_SCENE_TYPES);
    if (!type || seen.has(type)) continue;
    let count = Math.round(Number((it as Record<string, unknown>).count));
    if (!isFinite(count) || count < 1) count = 1;
    count = Math.min(10, count);
    seen.add(type);
    out.push({ type, count });
  }
  return out;
}

const PROFILE_SYSTEM = [
  "Eres un analista de gustos de novela romántica. Recibes un fragmento de un libro.",
  "Devuelve SOLO un objeto JSON describiendo el GUSTO que refleja, usando EXCLUSIVAMENTE las etiquetas de los catálogos (copia el texto de la etiqueta tal cual).",
  "PROHIBIDO copiar frases, nombres o detalles únicos de la obra. Solo categorías.",
  "Elige los tropes que de verdad estén presentes (varios si aplica). Si un campo no aplica, omítelo.",
  "",
  "CATÁLOGOS:",
  `GÉNERO (uno; si ninguno encaja, usa una frase corta): ${A_GENRES.join(" | ")}`,
  `TROPES (varios): ${A_TROPES.join(" | ")}`,
  `INTENSIDAD (una): ${A_HEAT.join(" | ")}`,
  `TONO (varios): ${A_TONE.join(" | ")}`,
  `POV (uno): ${A_POV.join(" | ")}`,
  `RITMO (uno): ${A_PACING.join(" | ")}`,
  `ARQUETIPO DEL INTERÉS (uno): ${A_ARCHETYPE.join(" | ")}`,
  `OSCURIDAD (una): ${A_DARKNESS.join(" | ")}`,
  `ESCENAS (las que aparezcan, con cuántas veces ~aproximado 1-5): ${A_SCENE_TYPES.join(" | ")}`,
  "",
  'Formato EXACTO, sin texto extra ni Markdown: {"genre":"","tropes":[],"heat":"","tone":[],"pov":"","pacing":"","archetype":"","darkness":"","scenes":[{"type":"","count":0}]}',
].join("\n");

/** Extracción RICA con modelo: mapea el texto a los catálogos del perfil.
    Valida todo contra las listas (descarta lo que no esté). Sin texto guardado. */
async function analyzeWithModel(text: string): Promise<Partial<Profile> | null> {
  try {
    const { text: out } = await getAnalysisProvider().complete({
      system: PROFILE_SYSTEM,
      messages: [{ role: "user", content: text.slice(0, 14000) }],
      maxTokens: 400,
      temperature: 0.2,
    });
    const raw = safeJson(out);
    if (!raw) return null;
    const genreMatched = pickVocab(raw.genre, A_GENRES);
    const genreFree = typeof raw.genre === "string" && raw.genre.trim().length > 1 && raw.genre.trim().length <= 40
      ? raw.genre.trim().toLowerCase() : "";
    const draft: Partial<Profile> = {
      genre: genreMatched || genreFree || undefined,
      tropes: pickVocabMany(raw.tropes, A_TROPES, 8),
      heat_level: (pickVocab(raw.heat, A_HEAT) as HeatLevel) || null,
      tone: pickVocabMany(raw.tone, A_TONE, 4),
      pov: pickVocab(raw.pov, A_POV) || "",
      pacing: pickVocab(raw.pacing, A_PACING) || "",
      archetype: pickVocab(raw.archetype, A_ARCHETYPE) || "",
      darkness: pickVocab(raw.darkness, A_DARKNESS) || "",
      scenes: parseScenes(raw.scenes),
    };
    return draft;
  } catch {
    return null;
  }
}

/* Etiquetas de PRECISIÓN para el match (no relleno generoso): solo lo dominante
   y coherente, mapeado a los mismos catálogos que los perfiles. */
const MATCH_TAGS_SYSTEM = [
  "Eres un clasificador de estilo literario. Etiqueta la obra SOLO con lo DOMINANTE y claramente central, para emparejarla con gustos de lectura.",
  "REGLAS: no rellenes de más; incluye SOLO lo evidente en el texto; NO mezcles etiquetas contradictorias (p. ej. 'enemigos a amantes' junto a 'amigos a amantes'); usa 'segundas oportunidades' SOLO si dos ex amantes se reencuentran (no por defecto); si la obra es cruda, violenta u oscura, NO uses tonos suaves ('tierno').",
  "CALIBRA la intensidad y la oscuridad por lo más FUERTE del texto: si hay sexo gráfico/anatómico o violencia sexual, INTENSIDAD = 'explícito'; si hay tortura, asesinato, cautiverio o sadismo, OSCURIDAD = 'very-dark' o 'extreme-dark'. Devuelve SIEMPRE oscuridad e intensidad.",
  `GÉNERO (uno): ${A_GENRES.join(" | ")}`,
  `DINÁMICAS (elige 3-5, las MÁS dominantes y coherentes entre sí): ${A_TROPES.join(" | ")}`,
  `INTENSIDAD (una): ${A_HEAT.join(" | ")}`,
  `TONO (1-3 dominantes): ${A_TONE.join(" | ")}`,
  `OSCURIDAD (una): ${A_DARKNESS.join(" | ")}`,
  'Responde SOLO con JSON, sin Markdown: {"genre":"","tropes":[],"heat":"","tone":[],"darkness":""}',
].join("\n");

export interface MatchTags {
  genre?: string;
  tropes: string[];
  heat_level: HeatLevel | null;
  tone: string[];
  darkness: string;
}

export async function extractMatchTags(text: string): Promise<MatchTags> {
  const empty: MatchTags = { tropes: [], heat_level: null, tone: [], darkness: "" };

  // 1) intento de PRECISIÓN con el modelo
  let model: MatchTags | null = null;
  try {
    if (assessOutput(text).ok) {
      const { text: out } = await getAnalysisProvider().complete({
        system: MATCH_TAGS_SYSTEM,
        messages: [{ role: "user", content: text.slice(0, 14000) }],
        maxTokens: 300,
        temperature: 0.1,
      });
      const raw = safeJson(out);
      if (raw) {
        const genre =
          pickVocab(raw.genre, A_GENRES) ||
          (typeof raw.genre === "string" && raw.genre.trim().length > 1 && raw.genre.trim().length <= 40
            ? raw.genre.trim().toLowerCase() : undefined);
        model = {
          genre,
          tropes: pickVocabMany(raw.tropes, A_TROPES, 5),
          heat_level: (pickVocab(raw.heat, A_HEAT) as HeatLevel) || null,
          tone: pickVocabMany(raw.tone, A_TONE, 3),
          darkness: pickVocab(raw.darkness, A_DARKNESS) || "",
        };
      }
    }
  } catch { /* cae al respaldo */ }

  const hasModel = !!model && !!(model.genre || model.tropes.length || model.tone.length || model.heat_level || model.darkness);
  if (hasModel) return model as MatchTags;

  // 2) RESPALDO: heurística (siempre da algo), recortada a límites de match
  try {
    const base = analyzeText(text);
    if (base.blocked) return empty;
    return {
      genre: base.genre || undefined,
      tropes: (base.tropes || []).slice(0, 5),
      heat_level: base.heat_level ?? null,
      tone: (base.tone || []).slice(0, 3),
      darkness: base.darkness || "",
    };
  } catch {
    return empty;
  }
}

/** Punto de entrada del extractor de perfil: seguridad → modelo (rico) →
    relleno con la heurística para lo que falte. El usuario revisa y ajusta. */
export async function extractProfile(text: string): Promise<ProfileDraft> {
  const safe = assessOutput(text);
  if (!safe.ok) {
    logIncident("extract: texto no permitido");
    return { blocked: true };
  }
  const base = analyzeText(text); // heurística (siempre da algo)
  if (base.blocked) return base;
  const model = await analyzeWithModel(text);

  // el modelo manda; la heurística rellena huecos
  const merged: ProfileDraft = {
    blocked: false,
    source: "extraído",
    genre: model?.genre || base.genre || "romance",
    tropes: (model?.tropes && model.tropes.length ? model.tropes : base.tropes) || [],
    heat_level: model?.heat_level ?? base.heat_level ?? null,
    tone: (model?.tone && model.tone.length ? model.tone : base.tone) || [],
    pov: model?.pov || base.pov || "",
    pacing: model?.pacing || base.pacing || "",
    archetype: model?.archetype || "",
    darkness: model?.darkness || "",
    scenes: model?.scenes || [],
    must_haves: base.must_haves || [],
    avoid: base.avoid || [],
    settings: base.settings || [],
  };
  return merged;
}

function norm(s: string): string {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function pick(text: string, map: Record<string, string[]>): string[] {
  const found: string[] = [];
  for (const [label, kws] of Object.entries(map)) {
    if (kws.some((k) => text.includes(k))) found.push(label);
  }
  return found;
}

const GENRE_MAP: Record<string, string[]> = {
  "dark romance": ["mafia", "capo", "cartel", "bajos fondos", "oscuro", "secuestr"],
  "romance paranormal": ["vampir", "lobo", "licantrop", "demonio", "bruj"],
  "romance contemporáneo": ["oficina", "jefe", "ciudad", "millonario", "ceo"],
  "romance histórico": ["duque", "siglo", "corte", "regencia", "victorian"],
};
const TROPE_MAP: Record<string, string[]> = {
  "enemigos a amantes": ["enemig", "odio", "rivales"],
  "amigos a amantes": ["amigos", "mejor amig"],
  "mafia / bajos fondos": ["mafia", "capo", "cartel"],
  "protagonista posesivo": ["posesiv", "celos", "mio", "mia"],
  "segundas oportunidades": ["volver", "reencuentr", "segunda oportunidad"],
  "matrimonio arreglado": ["matrimonio arreglad", "boda arreglad", "compromet"],
};
const TONE_MAP: Record<string, string[]> = {
  oscuro: ["oscur", "sombri", "cruel"],
  tenso: ["tens", "peligr", "amenaza"],
  dulce: ["dulce", "tierno", "ternura"],
  apasionado: ["pasion", "deseo", "ardiente"],
};
const SETTING_MAP: Record<string, string[]> = {
  "bajos fondos": ["bajos fondos", "calle", "barrio"],
  "alta sociedad": ["mansion", "alta sociedad", "elite", "lujo"],
  urbano: ["ciudad", "metropoli"],
};

function detectHeat(text: string): HeatLevel | null {
  const explicit = ["sexual", "desnud", "gemid", "penetr", "excit", "orgasm"];
  const warm = ["beso", "caricia", "abrazo", "roce"];
  const hits = explicit.filter((k) => text.includes(k)).length;
  if (hits >= 3) return "explícito";
  if (hits >= 1) return "picante";
  if (warm.some((k) => text.includes(k))) return "cálido";
  return "cerradas";
}

export function analyzeText(text: string): ProfileDraft {
  // 1) seguridad primero
  const safe = assessOutput(text);
  if (!safe.ok) {
    logIncident("extract: texto no permitido");
    return { blocked: true };
  }

  const t = norm(text);

  // 2) derivar etiquetas (nunca guardamos el texto)
  const genres = pick(t, GENRE_MAP);
  const tropes = pick(t, TROPE_MAP);
  const tone = pick(t, TONE_MAP);
  const settings = pick(t, SETTING_MAP);

  const pov = /primera persona|en primera|\byo \b/.test(t) ? "primera persona" : "";
  const pacing = /rapid|vertigin|intens/.test(t) ? "rápido / intenso"
    : /lent|pausad/.test(t) ? "lento / introspectivo" : "";
  const must_haves = /(final feliz|hea|felices para siempre)/.test(t) ? ["HEA obligatorio"] : [];
  const avoid = /(sin engano|no infidelidad|sin engaño)/.test(t) ? ["engaño"] : [];

  return {
    blocked: false,
    source: "extraído",
    genre: genres[0] || "romance",
    tropes,
    heat_level: detectHeat(t),
    tone,
    pov,
    pacing,
    must_haves,
    avoid,
    settings,
  };
}

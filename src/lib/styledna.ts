// ADN de estilo: extrae descriptores CONCRETOS de cómo se escribe una obra
// (voz, estructura) y DICCIONARIOS de escena (léxico real) para variar la
// "sensación de autor" entre libros.
// Principio innegociable: el léxico son PALABRAS y fragmentos ≤3 palabras
// (verbos, adjetivos, imágenes), NUNCA frases ni oraciones del libro.

import { getProvider, getAnalysisProvider, looksLikeRefusal } from "./provider";
import { extractMatchTags } from "./analyzer";
import type { VoiceKnobs, VoiceProfile, BibleVoice, Profile, VoiceTags, PlotBeat, CastProfile } from "./types";

export type StyleFacet = "structure" | "voice" | "sex" | "violence" | "action";
export const STYLE_FACETS: StyleFacet[] = ["structure", "voice", "sex", "violence", "action"];
export const SCENE_FACETS = ["sex", "violence", "action"] as const;

export const FACET_LABEL: Record<StyleFacet, string> = {
  structure: "Estructura del libro",
  voice: "Voz narrativa",
  sex: "Escenas de sexo",
  violence: "Escenas de violencia",
  action: "Escenas de acción",
};

export interface SceneCraft { craft: string; lexicon: string[] }

/* Muestra repartida por toda la obra para acotar tokens. */
export function sampleForStyle(textRaw: string, windows = 6, per = 2800): string {
  const t = textRaw.replace(/\s+/g, " ").trim();
  if (t.length <= windows * per) return t;
  const out: string[] = [];
  for (let i = 0; i < windows; i++) {
    const start = Math.floor((t.length - per) * (i / (windows - 1)));
    out.push(t.slice(start, start + per));
  }
  return out.join("\n\n[…]\n\n");
}

/* Señales léxicas por tipo de escena para muestrear las ventanas donde ESA
   escena de verdad ocurre (no un corte genérico del libro). Sin esto, en un
   libro de 50k palabras el muestreo casi no toca las escenas de sexo y el
   léxico sale suave. */
const SCENE_CUES: Record<(typeof SCENE_FACETS)[number], RegExp> = {
  sex: /\b(polla|verga|coñ?o|cl[íi]toris|semen|corr(?:er|ida|ió|o)|follar|foll\w+|penetr\w+|embesti\w+|gemi\w+|jade\w+|pez[óo]n|pezones|muslos?|h[úu]med\w+|erecci\w+|erecto|nalga\w*|orgasm\w+|excitaci\w+|caderas?|clav[óo]|empal\w+|mamada|chup\w+|glande|pene|pija|cipote|lengua|l[áa]mer|lam\w+|desnud\w+|gimi\w+)\b/gi,
  violence: /\b(sangre|sangr\w+|golpe\w*|puñ\w+|patada\w*|cuchill\w+|navaja|pistola|arma\w*|bala\w*|dispar\w+|herida\w*|hueso\w*|moret\w+|grit\w+|tortur\w+|romp\w+|quebr\w+|magull\w+|puñal\w+|cr[áa]neo|costilla\w*|mand[íi]bula|muerte|matar|asesin\w+|dolor|sangrand\w+)\b/gi,
  action: /\b(corr\w+|huir|huy\w+|persec\w+|escap\w+|salt\w+|esquiv\w+|dispar\w+|acelera\w*|frena\w*|volante|derrap\w+|golpe\w*|patada\w*|rod\w+|arrastr\w+|gatill\w+|explos\w+|motor|neum[áa]tic\w+|persigui\w+|corri\w+)\b/gi,
};

export function sampleForScene(textRaw: string, kind: (typeof SCENE_FACETS)[number], windows = 6, per = 2800): string {
  const t = textRaw.replace(/\s+/g, " ").trim();
  if (t.length <= windows * per) return t;
  const cue = SCENE_CUES[kind];
  const step = Math.floor(per * 0.75);
  const cand: { start: number; score: number }[] = [];
  for (let s = 0; s + per <= t.length; s += step) {
    const seg = t.slice(s, s + per);
    const m = seg.match(cue);
    cand.push({ start: s, score: m ? m.length : 0 });
  }
  cand.sort((a, b) => b.score - a.score);
  const chosen: number[] = [];
  for (const c of cand) {
    if (chosen.length >= windows) break;
    if (c.score === 0) break;                                   // sin señal → no rellenar con ruido
    if (chosen.some((x) => Math.abs(x - c.start) < per)) continue; // evita solapes
    chosen.push(c.start);
  }
  if (chosen.length === 0) return sampleForStyle(textRaw, windows, per); // libro sin esa escena → genérico
  chosen.sort((a, b) => a - b);                                          // orden narrativo
  return chosen.map((s) => t.slice(s, s + per)).join("\n\n[…]\n\n");
}

/* Vocabulario explícito de REGISTRO (genérico, no atado a ninguna obra). Se
   cosecha del propio texto muestreado para GARANTIZAR la capa cruda del léxico
   de sexo aunque el modelo la sanee. Solo se añaden los términos que de verdad
   aparecen en la obra. */
const EXPLICIT_REGISTER: string[] = [
  "polla", "verga", "cipote", "glande", "pene", "pija", "miembro",
  "coño", "clítoris", "chocho", "vagina", "sexo húmedo",
  "follar", "penetrar", "embestir", "mamada", "sexo oral", "semen", "corrida", "erección",
  "pezón", "pezones", "muslos", "nalgas", "húmedo", "clavar", "gemido", "jadeo",
  "embestida", "orgasmo", "excitación", "lamer", "chupar", "clímax",
];
function harvestExplicit(sample: string): string[] {
  const low = " " + sample.toLowerCase().replace(/\s+/g, " ") + " ";
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return EXPLICIT_REGISTER.filter((w) => {
    const parts = w.split(" ");
    const rx = parts.length > 1
      ? new RegExp("\\b" + parts.map(esc).join("\\s+") + "\\w{0,3}\\b")
      : new RegExp("\\b" + esc(w) + "\\w{0,3}\\b");
    return rx.test(low);
  });
}

const NO_COPY = `NUNCA copies oraciones ni frases del original (nada de >3 palabras seguidas del texto). Sin nombres de personajes/lugares ni trama.`;
const CONCRETE = `Sé CONCRETO y específico, no genérico. Prohibido el relleno vago tipo "ritmo rápido", "lenguaje directo", "mantiene al lector enganchado". En su lugar da rasgos medibles y observables.`;

/* --- Voz y estructura: prosa concreta (no genérica) --- */
const PROSE_PROMPT: Record<"structure" | "voice", string> = {
  voice:
    `Eres analista literario forense. DESCRIBE (no imites) la VOZ narrativa como una ficha técnica de estilo, con rasgos CONCRETOS y observables. Cubre, con especificidad: persona y tiempo verbal dominantes; longitud típica de frase (en palabras) y su variación; recurso sintáctico marca de la casa (p. ej. fragmentos, asíndeton, frases que arrancan con conjunción); densidad y TIPO de imágenes (¿de qué campos semánticos saca las metáforas?); grado de interioridad vs. acción; puntuación característica (guiones, puntos suspensivos, cursivas); 2-3 tics repetibles. ${CONCRETE} ${NO_COPY} TEXTO PLANO en español: NADA de Markdown (sin **negritas**, sin viñetas con guion, sin #). Sin preámbulos ni disculpas. Máx. 140 palabras. Termina siempre con una frase completa.`,
  structure:
    `Eres analista literario forense. Describe la ARQUITECTURA con rasgos CONCRETOS: con qué ARRANCAN los capítulos (acción/diálogo/reflexión) y con qué CIERRAN (gancho/giro/imagen); longitud típica de capítulo y de escena; cadencia (cuántas escenas por capítulo); patrón de tensión (dónde suben los picos); uso de saltos temporales y cambios de POV; densidad de párrafo. ${CONCRETE} ${NO_COPY} TEXTO PLANO en español: NADA de Markdown (sin **negritas**, sin viñetas, sin #). Sin preámbulos. Máx. 130 palabras. Termina con una frase completa.`,
};

function stripMd(s: string): string {
  return (s || "")
    .replace(/\*\*|__/g, "")                 // negritas
    .replace(/(^|\n)[ \t]*[-*•]\s+/g, "$1")   // viñetas
    .replace(/(^|\n)[ \t]*#{1,6}\s+/g, "$1")  // encabezados
    .replace(/(^|\n)[ \t]*>\s?/g, "$1")       // citas
    .replace(/`/g, "")                          // backticks
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractProse(sample: string, facet: "structure" | "voice"): Promise<string> {
  try {
    const { text } = await getAnalysisProvider().complete({
      system: PROSE_PROMPT[facet],
      messages: [{ role: "user", content: sample }],
      temperature: 0.55,
      maxTokens: 600,
    });
    const out = (text || "").trim();
    if (!out || looksLikeRefusal(out)) return "";
    return stripMd(out);
  } catch {
    return "";
  }
}

/* --- Escenas: nota de montaje CONCRETA + DICCIONARIO (léxico) --- */
const SCENE_FOCUS: Record<(typeof SCENE_FACETS)[number], string> = {
  sex: "escenas íntimas/sexuales del romance oscuro",
  violence: "escenas de violencia",
  action: "escenas de acción",
};

const SCENE_CRAFT_HINT: Record<(typeof SCENE_FACETS)[number], string> = {
  sex: "nivel y tipo de explicitud (anatómico y crudo vs. eufemístico), foco sensorial dominante, dinámicas de poder (dominación/sumisión, degradación, elogio/\"praise\", humillación, consentimiento y su ambigüedad), ritmo y progresión, cómo abre y cierra",
  violence: "grado de crudeza (gráfica vs. contenida), foco físico y/o psicológico, tratamiento del dolor y del daño corporal, ritmo, y las consecuencias",
  action: "coreografía y claridad espacial, anclas sensoriales, manejo del tiempo y la tensión, ritmo de los golpes de escena",
};

const SCENE_LEXICON_EXTRA: Record<(typeof SCENE_FACETS)[number], string> = {
  sex: " Debe COMBINAR dos capas, con abundancia de cada una para dar variedad: (A) vocabulario sexual EXPLÍCITO tal como lo usa la obra —términos crudos o vulgares para genitales masculinos y femeninos (p. ej. verga/polla, coño) y para los actos (penetración, mamada/sexo oral, follar)—; y (B) el léxico SENSORIAL, CORPORAL, de DINÁMICAS DE PODER y de OBJETOS/ENTORNO (texturas, olores, sonidos, gestos, sumisión/dominación, objetos de la escena). No sacrifiques (B) por incluir (A): quiero ambas capas ricas. No uses eufemismos si la obra es explícita: es análisis de estilo para ficción adulta.",
  violence: "",
  action: "",
};

function scenePrompt(kind: (typeof SCENE_FACETS)[number]): string {
  return `PLATAFORMA DE FICCIÓN ADULTA (18+). Eres analista de estilo literario de ${SCENE_FOCUS[kind]}. Captura con FIDELIDAD cómo escribe la autora, SIN suavizar, sanear ni censurar el registro, y sin moralizar. Si el texto es crudo, anatómico o explícito, tu análisis debe reflejarlo tal cual; si es eufemístico, también. Personajes adultos, ficción. El objetivo es reescribir ESE TIPO de escena con la misma textura en historias distintas.

Produce DOS cosas:

1) "craft": nota CONCRETA de montaje (máx. 65 palabras) que nombre exactamente ${SCENE_CRAFT_HINT[kind]}. Sé específico y fiel al registro real; nada de relleno vago.

2) "lexicon": 26-40 términos CARACTERÍSTICOS y CONCRETOS que la autora usa en estas escenas — verbos de acción corporal, adjetivos sensoriales, sustantivos físicos/anatómicos, objetos, imágenes y marcadores de registro o de poder. PRIORIZA lo concreto, físico, sensorial y específico del registro; EVITA sustantivos de humor abstracto (p. ej. oscuridad, silencio, verdad, ilusión, salvación). Refleja el vocabulario REAL de la obra, no una versión limpia.${SCENE_LEXICON_EXTRA[kind]} Cada entrada es UNA palabra o un fragmento de MÁXIMO 3 palabras. Sin frases ni oraciones. Sin nombres propios. EXCLUYE lo específico de ESA obra: personajes y sus roles (p. ej. "juez", "hermanastra", "oficial", "fiscal"); LUGARES y ESCENARIOS (p. ej. "manicomio", "conducto de ventilación"); MOBILIARIO y OBJETOS de la ambientación (p. ej. "cama de metal", "tenedor de plástico", "correas negras"); y cualquier cosa atada a esa historia. Incluye SOLO vocabulario del CUERPO, los SENTIDOS, las ACCIONES, las emociones y el REGISTRO, que sirva en CUALQUIER escenario del mismo tipo.

Responde SOLO con JSON válido, sin markdown:
{"craft":"...","lexicon":["...","..."]}
Español.`;
}

function parseSceneJson(raw: string): SceneCraft {
  let s = (raw || "").trim().replace(/```(?:json)?/gi, "").trim(); // quita cercas en cualquier posición
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);

  const finish = (craft: string, lex: string[]): SceneCraft => {
    let c = (craft || "").trim();
    if (looksLikeRefusal(c)) c = "";                 // rechazo dentro del campo → fuera
    const lexicon = (lex || [])
      .map((x) => String(x).trim())
      .filter((x) => x && x.split(/\s+/).length <= 3) // solo palabras/fragmentos ≤3
      .slice(0, 40);
    return { craft: c, lexicon };
  };

  try {
    const o = JSON.parse(s) as { craft?: string; lexicon?: unknown };
    const craft = typeof o.craft === "string" ? o.craft : "";
    const lexRaw = Array.isArray(o.lexicon) ? o.lexicon.map((x) => String(x)) : [];
    return finish(craft, lexRaw);
  } catch {
    // JSON truncado/mal formado → salvamento por regex; NUNCA volcamos el crudo.
    const cm = s.match(/"craft"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    const craft = cm ? cm[1].replace(/\\"/g, '"').replace(/\\n/g, " ").trim() : "";
    const lm = s.match(/"lexicon"\s*:\s*\[([^\]]*)\]/i);
    const lexicon = lm
      ? lm[1].split(",").map((x) => x.replace(/^\s*"|"\s*$/g, "").trim()).filter(Boolean)
      : [];
    return finish(craft, lexicon);
  }
}

export async function extractSceneCraft(sample: string, kind: (typeof SCENE_FACETS)[number]): Promise<SceneCraft> {
  // Capa cruda garantizada: términos explícitos que SÍ aparecen en la obra,
  // por si el modelo sanea el léxico de sexo. Solo para la faceta de sexo.
  const harvested = kind === "sex" ? harvestExplicit(sample) : [];

  const mergeHarvest = (lex: string[]): string[] => {
    if (harvested.length === 0) return lex;
    const seen = new Set(lex.map((x) => x.toLowerCase()));
    const extra = harvested.filter((w) => !seen.has(w.toLowerCase()));
    return [...extra, ...lex].slice(0, 40); // crudos primero, garantizados
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text } = await getAnalysisProvider().complete({
        system: scenePrompt(kind),
        messages: [{ role: "user", content: sample }],
        temperature: attempt === 0 ? 0.6 : 0.85,
        maxTokens: 1000,
      });
      if (!text || looksLikeRefusal(text)) continue; // rechazo del wrapper → reintenta
      const parsed = parseSceneJson(text);           // ya limpia rechazos incrustados en craft
      const lexicon = mergeHarvest(parsed.lexicon);
      if (parsed.craft || lexicon.length > 0) return { craft: parsed.craft, lexicon };
      // vacío tras limpiar → un reintento con más temperatura
    } catch {
      /* siguiente intento */
    }
  }
  // último recurso: si al menos cosechamos vocabulario explícito, no lo perdemos
  return { craft: "", lexicon: mergeHarvest([]) };
}

/* ------------------------- perillas duras (knobs) ------------------------- */

const KNOBS_SYSTEM = `Eres analista de estilo literario. Del texto extrae PARÁMETROS DUROS y accionables de la voz, y 3-5 REGLAS imperativas MUY cortas (máx. 6 palabras c/u) que capturen lo más distintivo y repetible del estilo (ej. "Presente, primera persona", "Frases cortas en tensión", "Nunca nombres la emoción", "Diálogo con raya, seco").
Responde SOLO con JSON válido, sin markdown ni comentarios:
{"sentenceAvg":[min,max],"paragraphLines":"cortos|medios|largos","dialogueRatio":"bajo|medio|alto","explicitness":1,"interiority":"baja|media|alta","tense":"presente|pasado","punctuation":["..."],"imperatives":["..."]}
- sentenceAvg: rango realista de palabras por frase (p. ej. [6,14]).
- explicitness: entero 1-5 (5 = muy explícito/anatómico).
Español.`;

function clampInt(n: unknown, lo: number, hi: number, def: number): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
}
function oneOf<T extends string>(v: unknown, opts: T[], def: T): T {
  const s = String(v || "").toLowerCase().trim();
  return (opts as string[]).includes(s) ? (s as T) : def;
}

export interface KnobsResult { knobs: VoiceKnobs; imperatives: string[] }

export async function extractKnobs(sample: string): Promise<KnobsResult> {
  const { text } = await getAnalysisProvider().complete({
    system: KNOBS_SYSTEM,
    messages: [{ role: "user", content: sample }],
    temperature: 0.3,
    maxTokens: 400,
  });
  const KNOBS_DEFAULT: KnobsResult = {
    knobs: { sentenceAvg: [8, 16], paragraphLines: "medios", dialogueRatio: "medio", explicitness: 3, interiority: "media", tense: "pasado", punctuation: [] },
    imperatives: [],
  };
  let s = (text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  if (!s || looksLikeRefusal(s)) return KNOBS_DEFAULT;
  const a = s.indexOf("{"); const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const sa = Array.isArray(o.sentenceAvg) ? o.sentenceAvg : [];
    const lo = clampInt(sa[0], 3, 40, 8);
    const hi = clampInt(sa[1], lo + 1, 60, Math.max(lo + 4, 14));
    const knobs: VoiceKnobs = {
      sentenceAvg: [lo, hi],
      paragraphLines: oneOf(o.paragraphLines, ["cortos", "medios", "largos"], "medios"),
      dialogueRatio: oneOf(o.dialogueRatio, ["bajo", "medio", "alto"], "medio"),
      explicitness: clampInt(o.explicitness, 1, 5, 3),
      interiority: oneOf(o.interiority, ["baja", "media", "alta"], "media"),
      tense: oneOf(o.tense, ["presente", "pasado"], "pasado"),
      punctuation: Array.isArray(o.punctuation) ? o.punctuation.map((x) => String(x).trim()).filter(Boolean).slice(0, 6) : [],
    };
    const imperatives = Array.isArray(o.imperatives)
      ? o.imperatives.map((x) => String(x).trim()).filter((x) => x && x.split(/\s+/).length <= 8).slice(0, 5)
      : [];
    return { knobs, imperatives };
  } catch {
    return {
      knobs: { sentenceAvg: [8, 16], paragraphLines: "medios", dialogueRatio: "medio", explicitness: 3, interiority: "media", tense: "pasado", punctuation: [] },
      imperatives: [],
    };
  }
}

/* --------------------- muestra de estilo (few-shot) ---------------------- */
/* Genera una escena ORIGINAL (personajes y situación nuevos, sin relación con
   ninguna obra) que DEMUESTRA la voz. Es prosa propia de Queneau: sirve de
   ejemplo imitable sin problemas de copyright. */
export async function generateStyleSample(voiceDesc: string, knobs: VoiceKnobs, imperatives: string[]): Promise<string> {
  const system =
    `Eres autor profesional de ficción en español. Escribe una micro-escena ORIGINAL y AUTÓNOMA de 150-200 palabras, con personajes y situación completamente INVENTADOS por ti. Su ÚNICO propósito es DEMOSTRAR el ritmo, la sintaxis y el registro de una voz narrativa (es una muestra de estilo). ` +
    `Escribe una escena de TENSIÓN o ATMÓSFERA; NO necesita ser explícita ni gráfica: enfócate en la CADENCIA y la textura del lenguaje, no en el contenido subido de tono. Es una pieza tuya, nueva, no relacionada con ninguna obra. Sin títulos ni encabezados ni disculpas: SOLO la prosa.`;
  const user =
    `Aplica el ritmo, la sintaxis y el registro de esta voz a tu escena original:\n${voiceDesc}\n\n` +
    `PARÁMETROS:\n` +
    `- Tiempo verbal: ${knobs.tense}.\n` +
    `- Frase promedio: ${knobs.sentenceAvg[0]}-${knobs.sentenceAvg[1]} palabras.\n` +
    `- Párrafos ${knobs.paragraphLines}; diálogo ${knobs.dialogueRatio}; interioridad ${knobs.interiority}.\n` +
    (imperatives.length ? `- Reglas: ${imperatives.join(" · ")}.\n` : "") +
    `\nEscribe SOLO la escena (tensión/atmósfera), inventada por ti.`;
  try {
    const { text } = await getProvider().complete({
      system,
      messages: [{ role: "user", content: user }],
      temperature: 0.85,
      maxTokens: 360,
    });
    const out = (text || "").trim();
    if (!out || looksLikeRefusal(out)) return "";
    return stripMd(out);
  } catch {
    return "";
  }
}

/* ----------------------- asignación de voz a un libro ----------------------- */

export function toBibleVoice(v: VoiceProfile): BibleVoice {
  return {
    name: v.name,
    imperatives: v.imperatives || [],
    knobs: v.knobs,
    styleSample: v.styleSample,
    lexicon: v.lexicon,
    plotBeats: v.plotBeats,
    cast: v.cast,
  };
}

/* Etiqueta la voz con el MISMO vocabulario que los perfiles (reutiliza el
   extractor de perfiles), para poder comparar contra la categoría del usuario. */
export async function extractTags(sample: string): Promise<VoiceTags> {
  try {
    const d = await extractMatchTags(sample);
    return {
      genre: d.genre || undefined,
      tropes: Array.isArray(d.tropes) ? d.tropes : [],
      heat: d.heat_level || undefined,
      tone: Array.isArray(d.tone) ? d.tone : [],
      darkness: d.darkness || undefined,
    };
  } catch {
    return { tropes: [], tone: [] };
  }
}

const norm = (s: string) =>
  (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const overlapCount = (a: string[] = [], b: string[] = []) => {
  const B = new Set(b.map(norm));
  return a.map(norm).filter((x) => B.has(x)).length;
};
const HEAT_ORDER = ["cerradas", "cálido", "picante", "explícito"];
function heatProximity(a?: string | null, b?: string): number {
  if (!a || !b) return 0;
  const i = HEAT_ORDER.indexOf(norm(a) as string);
  const j = HEAT_ORDER.map(norm).indexOf(norm(b));
  if (i < 0 || j < 0) return 0;
  return Math.max(0, 3 - Math.abs(i - j)); // 3 si igual, baja con la distancia
}

/* Puntúa cuánto se parece una voz a la categoría (perfil) del usuario. */
function scoreMatch(profile: Profile, tags?: VoiceTags): number {
  if (!tags) return 0;
  let s = 0;
  if (profile.genre && tags.genre && norm(profile.genre) === norm(tags.genre)) s += 5;
  s += overlapCount(profile.tropes, tags.tropes) * 2;
  s += overlapCount(Array.isArray(profile.tone) ? profile.tone : [], tags.tone);
  s += heatProximity(profile.heat_level, tags.heat);
  if (profile.darkness && tags.darkness && norm(profile.darkness) === norm(tags.darkness)) s += 2;
  return s;
}

/* Elige una voz haciendo MATCH con la categoría: puntúa todas, se queda con las
   más parecidas y elige UNA al azar entre ellas (estable por semilla). Si nada
   se parece, cae a cualquier voz utilizable para no dejar el libro sin voz. */
export function pickVoice(voices: VoiceProfile[] | undefined, profile: Profile, seed?: string): BibleVoice | undefined {
  const usable = (voices || []).filter((v) => v && (v.styleSample || (v.imperatives && v.imperatives.length > 0)));
  if (usable.length === 0) return undefined;

  const scored = usable.map((v) => ({ v, s: scoreMatch(profile, v.tags) }));
  const max = Math.max(...scored.map((x) => x.s));
  // candidatos: los más parecidos (dentro de un margen del mejor). Si nadie
  // puntúa (>0), usa todas para dar variedad.
  const pool = max > 0 ? scored.filter((x) => x.s >= max - 2 && x.s > 0) : scored;
  const list = pool.map((x) => x.v);

  let idx = Math.floor(Math.random() * list.length);
  if (seed) { let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0; idx = h % list.length; }
  return toBibleVoice(list[idx]);
}

/* --------------- arquitectura de trama (mapa replicable) ----------------- */
const PLOT_TYPES = [
  "pico de tensión", "plot twist", "confrontación", "punto de quiebre",
  "revés", "falsa victoria", "giro de medio libro", "punto de no retorno",
  "clímax", "resolución", "gancho inicial", "detonante",
];

const PLOT_SYSTEM =
  `Eres analista de estructura narrativa. Extrae el ESQUELETO ESTRUCTURAL de la obra como PATRÓN reutilizable en OTRAS historias, describiendo la FUNCIÓN dramática de cada hito, NUNCA su trama concreta.
PROHIBIDO ABSOLUTAMENTE: nombres de personajes, LUGARES o ESCENARIOS (p. ej. "manicomio", "universidad"), objetos y eventos específicos de esta obra. Si mencionas el escenario o el evento literal, está MAL.
Ejemplos:
  MAL: "la protagonista decide escapar del manicomio"  →  BIEN: "el protagonista rompe con su situación inicial"
  MAL: "logran escapar temporalmente"  →  BIEN: "una victoria aparente que resultará falsa"
Devuelve SOLO JSON válido, sin markdown:
{"beats":[{"at":0-100,"type":"...","note":"..."}],"tension":[n,...]}
- beats: 7-11 hitos ordenados por posición. "at" = % del libro (0-100). "type" preferentemente uno de: ${PLOT_TYPES.join(", ")}. "note" = FUNCIÓN abstracta del hito (máx. 12 palabras), sin trama, lugares ni eventos concretos.
- tension: 10 enteros 0-100 = curva de tensión repartida uniformemente por el libro (inicio→fin).
Español.`;

export interface PlotArch { beats: PlotBeat[]; tension: number[] }

export async function extractPlotArchitecture(sample: string): Promise<PlotArch> {
  const { text } = await getAnalysisProvider().complete({
    system: PLOT_SYSTEM,
    messages: [{ role: "user", content: sample }],
    temperature: 0.4,
    maxTokens: 700,
  });
  let s = (text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  if (!s || looksLikeRefusal(s)) return { beats: [], tension: [] };
  const a = s.indexOf("{"); const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const o = JSON.parse(s) as { beats?: unknown; tension?: unknown };
    const beatsRaw = Array.isArray(o.beats) ? o.beats : [];
    const beats: PlotBeat[] = beatsRaw
      .map((x) => {
        const r = x as { at?: unknown; type?: unknown; note?: unknown };
        return {
          at: Math.min(100, Math.max(0, Math.round(Number(r.at)))),
          type: String(r.type || "").trim().slice(0, 40),
          note: String(r.note || "").trim().slice(0, 120),
        };
      })
      .filter((x) => Number.isFinite(x.at) && x.type)
      .sort((x, y) => x.at - y.at)
      .slice(0, 12);
    const tRaw = Array.isArray(o.tension) ? o.tension : [];
    const tension = tRaw.map((n) => Math.min(100, Math.max(0, Math.round(Number(n))))).filter((n) => Number.isFinite(n)).slice(0, 12);
    return { beats, tension };
  } catch {
    return { beats: [], tension: [] };
  }
}

/* Extrae el PERFIL DE ELENCO del libro fuente: cuántos personajes con peso y qué
   papeles secundarios recurren. Sirve para que la generación varíe el reparto en
   vez de caer siempre en 2 protagonistas + 1 antagonista. */
const CAST_SYSTEM =
  "Analizas el REPARTO de una novela de romance oscuro. Devuelve SOLO JSON: " +
  '{"size": number, "secondary": string[], "note": string}. ' +
  "size = total de personajes con peso REAL en la trama (protagonistas + antagonista + secundarios relevantes; típico 3 a 6). " +
  "secondary = papeles secundarios recurrentes, en español y en minúsculas (p. ej. \"mejor amiga\", \"hermano\", \"segundo interés\", \"mano derecha\", \"rival\", \"mentora\"). " +
  "note = una frase breve sobre la estructura del elenco. Nada de texto fuera del JSON.";

export async function extractCast(sample: string): Promise<CastProfile> {
  try {
    const { text } = await getAnalysisProvider().complete({
      system: CAST_SYSTEM,
      messages: [{ role: "user", content: sample }],
      temperature: 0.3,
      maxTokens: 300,
    });
    let s = (text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    if (!s || looksLikeRefusal(s)) return {};
    const a = s.indexOf("{"); const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    const o = JSON.parse(s) as { size?: unknown; secondary?: unknown; note?: unknown };
    const sizeNum = Math.round(Number(o.size));
    const size = Number.isFinite(sizeNum) && sizeNum >= 2 && sizeNum <= 12 ? sizeNum : undefined;
    const secondary = Array.isArray(o.secondary)
      ? o.secondary.map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 6)
      : [];
    const note = typeof o.note === "string" ? o.note.trim().slice(0, 200) : "";
    return { size, secondary, note };
  } catch {
    return {};
  }
}

/* ---------------------------------------------------------------------------
   bible.ts — perfil (congelado) -> StoryBible.

   El CÓDIGO decide la estructura (nº de capítulos, roles, EDADES 18+, arco).
   El MODELO solo aporta lenguaje (premisa, ambientación, nombres, frases del
   arco). Si el modelo falla o devuelve algo inseguro, caemos a un esqueleto
   determinista y seguro: la biblia nunca se rompe.

   - deterministicBible(): pura, sin modelo (rápida, segura). Base y fallback.
   - buildBible(): async; superpone lenguaje del modelo sobre la base.
--------------------------------------------------------------------------- */
import type { Profile, FormatKey, StoryBible, BibleCharacter, CharacterRole } from "./types";
import { FORMATS } from "./constants";
import { LLMProvider, getProvider } from "./provider";
import { assessProfile, enforceAdultCharacters, assessOutput, logIncident } from "./safety";

// Re-exporta para compatibilidad con quien importe estos tipos desde "./bible".
export type { StoryBible, BibleCharacter, CharacterRole } from "./types";

export class SafetyError extends Error {}

/* --------------------------- utilidades --------------------------- */
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function chaptersFor(format?: FormatKey, explicit?: number): number {
  if (explicit && explicit > 0) return explicit;
  return (format && FORMATS[format]?.chapters) || 24;
}

/* ------------------------------ ARCOS -------------------------------
   Varias PLANTILLAS de arco (no una sola). Cada libro elige una por seed,
   así dos libros del mismo género no comparten el mismo esqueleto narrativo. */
const ARC_TEMPLATES: { name: string; stages: string[] }[] = [
  {
    name: "ascenso clásico",
    stages: [
      "Presentación del mundo y la protagonista",
      "Colisión: se cruzan los caminos",
      "Atracción y tensión crecientes",
      "Juego de poder y primera complicación",
      "Intimidad y vulnerabilidad",
      "Giro oscuro: traición o crisis",
      "Clímax y resolución",
    ],
  },
  {
    name: "in media res",
    stages: [
      "Arranque en plena crisis o peligro",
      "Tregua incómoda y primeras chispas",
      "El secreto que lo cambia todo asoma",
      "Alianza forzada bajo presión",
      "Punto de no retorno: cae una máscara",
      "Ruptura y consecuencias",
      "Confrontación final y nuevo equilibrio",
    ],
  },
  {
    name: "gato y ratón",
    stages: [
      "Dos agendas opuestas en marcha",
      "Primer encontronazo: quién domina a quién",
      "Maniobras, mentiras y deseo contenido",
      "Una trampa se vuelve en contra",
      "Rendición mutua que ninguno planeaba",
      "Doble traición y el costo de confiar",
      "Última jugada y desenlace",
    ],
  },
  {
    name: "lento incendio",
    stages: [
      "Mundo cotidiano y grieta inicial",
      "Cercanía obligada, distancia emocional",
      "Confianza frágil que se construye",
      "Deseo que desborda las reglas",
      "La amenaza externa aprieta",
      "Sacrificio y herida abierta",
      "Reconstrucción y elección final",
    ],
  },
  {
    name: "espiral descendente",
    stages: [
      "Aparente calma con una sombra debajo",
      "El encuentro que rompe la rutina",
      "Obsesión y líneas que se cruzan",
      "Lo prohibido se consuma",
      "Todo se desmorona: verdad brutal",
      "Punto más oscuro, sin salida aparente",
      "Catarsis y resolución ganada a pulso",
    ],
  },
];
function buildArc(n: number, tplIndex = 0) {
  const stages = ARC_TEMPLATES[tplIndex % ARC_TEMPLATES.length].stages;
  const out: { chapter: number; beat: string }[] = [];
  for (let i = 1; i <= n; i++) {
    const stage = Math.min(stages.length - 1, Math.floor(((i - 1) / n) * stages.length));
    out.push({ chapter: i, beat: stages[stage] });
  }
  return out;
}

/* ------- bancos de nombres por "sabor" (según subgénero/ambientación) -------
   El CÓDIGO elige los nombres (no el modelo), de listas grandes, para que no se
   repitan siempre Isabella/Marco. La heroína es femenina; interés y antagonista
   masculinos y distintos entre sí. Se añade apellido para multiplicar variedad. */
type Flavor = "italian" | "russian" | "spanish" | "english" | "fantasy";

const FEMALE: Record<Flavor, string[]> = {
  italian: ["Alessia","Bianca","Carla","Chiara","Dalila","Elisa","Federica","Gaia","Giulia","Ilaria","Lavinia","Marcella","Noemi","Ornella","Priscilla","Rosa","Serena","Tessa","Viola","Vittoria","Caterina","Greta","Lucrezia","Mira"],
  russian: ["Anya","Dasha","Galina","Irina","Katya","Lara","Lena","Mila","Nadia","Natasha","Nika","Olga","Polina","Sasha","Sofiya","Svetlana","Tatiana","Vera","Yana","Zoya","Alina","Marina","Oksana","Vasilisa"],
  spanish: ["Adriana","Bárbara","Carmen","Daniela","Elena","Fernanda","Gabriela","Inés","Julia","Lorena","Marisol","Natalia","Paloma","Renata","Salomé","Tamara","Valeria","Ximena","Abril","Catalina","Lucía","Mariana","Noa","Rocío"],
  english: ["Ashley","Brooke","Cora","Delia","Eleanor","Faye","Gemma","Harper","Ivy","Juliet","Kira","Lainey","Margot","Nora","Paige","Quinn","Reese","Sloane","Tessa","Willa","Amara","Hazel","Maeve","Rowan"],
  fantasy: ["Aelis","Briar","Caelia","Drusilla","Elowen","Faye","Isolde","Liraen","Morrigan","Nyx","Ravenna","Selene","Thalia","Yvaine","Aurelia","Calla","Eira","Lyra","Maren","Seraphine","Veyra","Wren","Zarael","Ondine"],
};
const MALE: Record<Flavor, string[]> = {
  italian: ["Alessandro","Antonio","Carmine","Cesare","Dante","Emilio","Fabrizio","Gabriele","Lorenzo","Luca","Marco","Massimo","Nico","Orlando","Raffaele","Salvatore","Stefano","Tommaso","Valerio","Vittorio","Damiano","Enzo","Matteo","Rocco"],
  russian: ["Aleksei","Andrei","Boris","Damir","Dmitri","Fyodor","Igor","Ivan","Kazimir","Konstantin","Lev","Maksim","Nikolai","Oleg","Roman","Sergei","Timur","Vadim","Viktor","Yuri","Anton","Mikhail","Pavel","Vasili"],
  spanish: ["Adrián","Alejandro","Andrés","Bruno","César","Diego","Emiliano","Gael","Iván","Joaquín","Leandro","Lucas","Mateo","Maximiliano","Nicolás","Octavio","Rafael","Ramiro","Salvador","Tomás","Augusto","Darío","Rómulo","Vicente"],
  english: ["Asher","Caleb","Damon","Declan","Elliot","Ezra","Gideon","Hayes","Jasper","Julian","Kane","Knox","Lucian","Maddox","Nathaniel","Orion","Roman","Silas","Theo","Wesley","Cole","Grayson","Royce","Sterling"],
  fantasy: ["Aric","Caelan","Damaris","Dorian","Eron","Fenris","Kael","Lucien","Malachi","Nereus","Orin","Ronan","Saber","Thane","Vaelor","Xander","Zephyr","Alaric","Caspian","Drystan","Lazarus","Soren","Valen","Riven"],
};
const SURNAME: Record<Flavor, string[]> = {
  italian: ["Rizzo","Moretti","Romano","De Luca","Conti","Esposito","Marchetti","Vitale","Ferraro","Lombardi","Caruso","Bellini","Greco","Salieri","Barone","Costa"],
  russian: ["Volkov","Sokolov","Morozov","Orlov","Kozlov","Petrov","Romanov","Sukov","Ivankov","Belov","Drozdov","Zorin","Tarasov","Lebedev","Vasiliev","Antonov"],
  spanish: ["Vargas","Salazar","Cortés","Reyes","Navarro","Castillo","Mendoza","Fuentes","Aguilar","Cabrera","Herrera","Ríos","Montero","Bravo","Lozano","Carrillo"],
  english: ["Sinclair","Vance","Hale","Blackwood","Sterling","Crowe","Ashford","Knight","Walsh","Calloway","Hawthorne","Marsh","Drake","Voss","Wilder","Thornton"],
  fantasy: ["Vexley","Nightshade","Ravenscar","Mortimer","Valdris","Ashthorne","Korr","Dravenholt","Vire","Sablewood","Greymoor","Thornevale","Duskbane","Mournhold","Vael","Wraithe"],
};

const FLAVOR_RULES: { test: RegExp; flavor: Flavor }[] = [
  { test: /mafia|cosa ?nostra|italian|sicil|napol|camorr|ndranghet|\bdon\b/i, flavor: "italian" },
  { test: /bratva|rus[oa]|russ|mosc|kremlin|\bvor\b|siberia/i, flavor: "russian" },
  { test: /romantas|fantas|\bfae\b|hada|vampir|paranormal|demon|[áa]ngel|bruj|witch|reino|corte|lic[áa]ntropo|lobo|shifter|sobrenatural/i, flavor: "fantasy" },
  { test: /billion|billon|mill[oó]n|\bceo\b|academ|college|universi|prison|prisi[oó]n|biker|motoclub|\bmc\b|stalker|terror|horror|secta|secret|sociedad secreta|deport/i, flavor: "english" },
];
function flavorFor(profile: Profile): Flavor {
  const blob = [profile.genre, ...(profile.settings || []), ...(profile.tropes || []), profile.archetype || ""].join(" ");
  return FLAVOR_RULES.find((r) => r.test.test(blob))?.flavor ?? "spanish";
}
function pickFrom<T>(arr: T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)];
}
function takeDistinct(arr: string[], rnd: () => number): [string, string] {
  const a = [...arr];
  const i = Math.floor(rnd() * a.length);
  const first = a.splice(i, 1)[0];
  const second = a[Math.floor(rnd() * a.length)];
  return [first, second];
}
/** Reparte nombres (con apellido) por rol, según el sabor del subgénero. */
function castNames(profile: Profile, rnd: () => number): Record<CharacterRole, string> {
  const f = flavorFor(profile);
  const female = pickFrom(FEMALE[f], rnd);
  const [m1, m2] = takeDistinct(MALE[f], rnd); // interés y antagonista distintos
  const sur = SURNAME[f];
  return {
    protagonista: `${female} ${pickFrom(sur, rnd)}`,
    interes: `${m1} ${pickFrom(sur, rnd)}`,
    antagonista: `${m2} ${pickFrom(sur, rnd)}`,
    secundario: `${pickFrom(FEMALE[f], rnd)} ${pickFrom(sur, rnd)}`,
  };
}

/* ------- ejes de variación de TRAMA (para que no empiecen todas igual) ------- */
const SETUPS = [
  "un matrimonio arreglado para sellar una alianza entre familias",
  "una deuda heredada que la arrastra al mundo de él",
  "ella presencia algo que no debía y él la retiene para silenciarla",
  "un secuestro como venganza contra la familia de ella",
  "un trato: su libertad a cambio de algo que solo ella puede dar",
  "ella se infiltra en la organización de él con su propia agenda secreta",
  "enemigos obligados a aliarse contra una amenaza mayor",
  "él la reclama como pago de una vieja deuda de sangre",
  "ella vuelve a casa y descubre que ya estaba prometida a él",
  "un intercambio de rehenes que sale mal y los deja atados",
  "ella lo persigue buscando venganza, y el cazador se vuelve presa",
  "un contrato de pareja falsa que empieza a volverse real",
  "ella hereda un imperio criminal y él es el lugarteniente que debía traicionarla",
  "se conocen sin saber quién es el otro, hasta que la verdad estalla",
  "un rescate que la deja en deuda con el hombre equivocado",
  "ella es entregada como ofrenda de paz entre dos bandos en guerra",
];
const POWER = [
  "él tiene todo el poder y ella debe forjar el suyo",
  "ella posee algo que él necesita con desesperación",
  "un equilibrio tenso: cada uno puede destruir al otro",
  "ella lo desestabiliza y él odia necesitarla",
  "el poder se invierte a mitad de la historia",
];
const HEROINE = [
  "astuta y de sangre fría, a quien todos subestiman",
  "una profesional brillante fuera de su elemento",
  "tan peligrosa como él, aunque lo disimule",
  "leal a su familia hasta el sacrificio",
  "vengativa, con una lista y un plan",
  "de apariencia frágil pero implacable por dentro",
  "una superviviente que ya no le teme a nada",
  "ingenua al principio, pero de aprendizaje rápido y feroz",
];
const OPENING = [
  "arranca en plena tensión o acción, sin presentación lenta",
  "abre con un cara a cara hostil cargado de química",
  "empieza con una amenaza concreta sobre la mesa",
  "abre con ella tomando una decisión arriesgada por voluntad propia",
];
/* MOTOR central del conflicto: lo que de verdad mueve la trama (más allá del setup). */
const ENGINE = [
  "una guerra de territorios que amenaza con estallar",
  "una traición interna que hay que destapar antes de que los mate",
  "una deuda imposible con un plazo que corre",
  "un secreto del pasado de él que sale a la luz",
  "una venganza meticulosa que ella ejecuta paso a paso",
  "un chantaje que los obliga a fingir lo que no son",
  "una herencia o sucesión que todos quieren arrebatar",
  "un enemigo común más peligroso que ellos dos juntos",
  "una investigación que la acerca demasiado a la verdad",
  "un trato con un tercero que ninguno puede romper sin perderlo todo",
  "una huida constante de algo que siempre los alcanza",
  "una lealtad dividida que tarde o temprano debe romperse",
];
/* SECRETO que reconfigura la historia a mitad de camino. */
const SECRET = [
  "él no es quien dijo ser desde el principio",
  "ella oculta una identidad que lo cambia todo",
  "alguien de confianza es en realidad el verdadero enemigo",
  "el origen de la deuda/venganza fue una mentira",
  "hay un vínculo del pasado que los une sin que lo sepan",
  "lo que ella busca proteger es justo lo que él quiere destruir",
  "una muerte que se creía cierta no lo fue",
  "el trato que los unió fue orquestado por un tercero",
];
/* COMPLICACIÓN/giro extra que evita el final predecible. */
const COMPLICATION = [
  "un tercero en discordia mueve sus propias fichas",
  "una decisión imposible que enfrenta amor y deber",
  "un sacrificio que cambia las reglas del juego",
  "una doble agenda que estalla en el peor momento",
  "una pérdida que obliga a redefinir qué están dispuestos a perder",
  "un cambio de bando inesperado",
];
function variationFor(seed: number) {
  const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0); // flujo independiente del de nombres
  return {
    setup: pickFrom(SETUPS, rnd),
    power: pickFrom(POWER, rnd),
    heroine: pickFrom(HEROINE, rnd),
    opening: pickFrom(OPENING, rnd),
    engine: pickFrom(ENGINE, rnd),
    secret: pickFrom(SECRET, rnd),
    complication: pickFrom(COMPLICATION, rnd),
    arcTpl: Math.floor(rnd() * ARC_TEMPLATES.length),
  };
}

/* ------- ATMÓSFERA por género: que un Terror dé miedo y un Militar sepa a deber ------- */
const GENRE_ATMOSPHERE: { test: RegExp; mood: string }[] = [
  { test: /terror|horror|miedo/i, mood: "verdadero terror y suspenso: presagios, amenaza constante, escenas que dan miedo de verdad, atmósfera opresiva. El romance crece DENTRO del horror, no lo reemplaza." },
  { test: /suspens|thriller|intriga/i, mood: "tensión de thriller: pistas, giros, peligro creciente y la sensación de que nada es lo que parece." },
  { test: /military|militar|soldad|guerra|navy|army/i, mood: "deber, jerarquía y vínculo de hermandad; secuelas del combate, misiones de alto riesgo, lealtad y honor bajo presión." },
  { test: /mafia|bratva|cartel|crimen|criminal/i, mood: "poder, violencia controlada, códigos de honor del bajo mundo y traiciones que cuestan sangre." },
  { test: /paranormal|vampir|licántropo|lobo|sobrenatural|fae|hada|demon|ángel/i, mood: "lo sobrenatural como amenaza y atracción: reglas del mundo oculto, peligro no humano, deseo prohibido." },
  { test: /fantas|romantas|reino|corte/i, mood: "mundo de fantasía con política, magia y peligro; lo épico se entrelaza con lo íntimo." },
  { test: /histórico|historico|época|regencia|victoria/i, mood: "ambiente de época creíble: normas sociales rígidas, decoro y deseo reprimido bajo la superficie." },
  { test: /deport|sport/i, mood: "competencia, presión pública, disciplina física y química que se enciende fuera de la cancha." },
  { test: /billion|billon|millon|ceo|oficina|jefe/i, mood: "lujo, poder corporativo, juegos de control y vulnerabilidad escondida tras el éxito." },
];
function atmosphereFor(profile: Profile): string {
  const blob = [profile.genre, ...(profile.settings || []), ...(profile.tropes || [])].join(" ");
  return GENRE_ATMOSPHERE.find((g) => g.test.test(blob))?.mood ?? "";
}

function firstName(full: string): string {
  return (full || "").split(" ")[0] || full;
}
const AGE_RANGE: Record<CharacterRole, [number, number]> = {
  protagonista: [24, 30], interes: [30, 38], antagonista: [38, 50], secundario: [22, 45],
};
const CORE_ROLES: CharacterRole[] = ["protagonista", "interes", "antagonista"];

function toneStr(p: Profile): string {
  return (Array.isArray(p.tone) ? p.tone.join(", ") : "") || "intenso";
}
function defaultTraits(role: CharacterRole, tone: string): string[] {
  switch (role) {
    case "protagonista": return ["decidida", "reservada", tone.split(",")[0].trim()];
    case "interes": return ["magnético", "peligroso", "leal a su manera"];
    case "antagonista": return ["calculador", "implacable"];
    default: return ["enigmático"];
  }
}

/* --------------------------- biblia determinista --------------------------- */
export function deterministicBible(profile: Profile, format?: FormatKey, seedStr?: string): StoryBible {
  const n = chaptersFor(format);
  const seed = hashStr(seedStr ?? JSON.stringify({ g: profile.genre, t: profile.tone, tr: profile.tropes, h: profile.heat_level }));
  const rnd = mulberry32(seed);
  const tone = toneStr(profile);
  const names = castNames(profile, rnd); // nombres por sabor del subgénero

  const characters: BibleCharacter[] = CORE_ROLES.map((role) => {
    const [lo, hi] = AGE_RANGE[role];
    return {
      role,
      name: names[role],
      age: lo + Math.floor(rnd() * (hi - lo + 1)), // siempre >= 18
      traits: defaultTraits(role, tone),
    };
  });

  const genre = profile.genre || "romance";
  const v = variationFor(seed);
  const atmosphere = atmosphereFor(profile);
  const her = firstName(characters[0].name);
  const him = firstName(characters[1].name);
  const premise =
    `${her} y ${him} quedan unidos por ${v.setup}. ` +
    `Ella es ${v.heroine}; ${v.power}. ` +
    `El conflicto se mueve por ${v.engine}, y a mitad de camino ${v.secret}.`;
  const setting = (profile.settings && profile.settings[0])
    ? `Ambientada en ${profile.settings[0]}, un mundo ${tone} donde el poder marca cada decisión.`
    : `Un mundo ${tone} donde el poder y la atracción marcan cada decisión.`;

  return {
    id: `bible_${seed.toString(16)}`,
    premise,
    setting,
    characters,
    tone,
    heat: profile.heat_level || "picante",
    archetype: profile.archetype || undefined,
    darkness: profile.darkness || undefined,
    mustHaves: Array.isArray(profile.must_haves) ? profile.must_haves : [],
    tropes: Array.isArray(profile.tropes) ? profile.tropes : [],
    setup: v.setup,
    powerDynamic: v.power,
    heroineAngle: v.heroine,
    openingTone: v.opening,
    engine: v.engine,
    secret: v.secret,
    complication: v.complication,
    atmosphere: atmosphere || undefined,
    arcTemplate: ARC_TEMPLATES[v.arcTpl].name,
    arc: buildArc(n, v.arcTpl),
  };
}

/* --------------------------- parseo laxo de JSON --------------------------- */
function parseJSONLoose(text: string): unknown | null {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/gi, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  const end = cleaned.lastIndexOf("}");
  if (end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* intenta reparar */ }
  }
  // Reparación de JSON truncado: corta tras el último elemento "completo"
  // (última comilla o llave de cierre) y equilibra corchetes/llaves abiertos.
  let body = cleaned.slice(start);
  const lastSafe = Math.max(body.lastIndexOf('"'), body.lastIndexOf("}"));
  if (lastSafe > 0) body = body.slice(0, lastSafe + 1);
  let open = 0, brack = 0, inStr = false, esc = false;
  for (const ch of body) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === "{") open++;
    else if (!inStr && ch === "}") open--;
    else if (!inStr && ch === "[") brack++;
    else if (!inStr && ch === "]") brack--;
  }
  if (inStr) body += '"';
  body += "]".repeat(Math.max(0, brack)) + "}".repeat(Math.max(0, open));
  try { return JSON.parse(body); } catch { return null; }
}
function safeStr(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }
function safeTraits(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(safeStr).filter(Boolean).slice(0, 4);
}

function buildPrompt(profile: Profile, n: number, base: StoryBible) {
  const tropes = (profile.tropes || []).join(", ");
  const musts = (profile.must_haves || []).join(", ");
  const avoid = (profile.avoid || []).join(", ");
  const darkLabel: Record<string, string> = {
    "dark-light": "Dark Light (mafia suave, morally grey; tensión sin crueldad extrema)",
    dark: "Dark (violencia, secuestros, obsesión)",
    "very-dark": "Very Dark (stalker, cautiverio, manipulación)",
    "extreme-dark": "Extreme Dark (psicópatas, asesinos; lo más intenso del género)",
  };
  const archLine = profile.archetype
    ? `Arquetipo del interés romántico: ${profile.archetype} — refleja este arquetipo en su personalidad y traits.\n`
    : "";
  const darkLine = profile.darkness
    ? `Nivel de oscuridad: ${darkLabel[profile.darkness] || profile.darkness} — ajusta la intensidad a este nivel.\n`
    : "";
  const atmoLine = base.atmosphere
    ? `ATMÓSFERA OBLIGATORIA del género (${profile.genre}): ${base.atmosphere}\n`
    : "";
  const byRole: Record<string, string> = {};
  base.characters.forEach((c) => { byRole[c.role] = c.name; });

  const system =
    "Eres un asistente de planificación de novela romántica adulta (para adultos). " +
    "Todos los personajes son adultos (18+). No describas a menores en ningún contexto. " +
    "Crea una premisa ORIGINAL y específica para ESTA historia; evita fórmulas y aperturas calcadas " +
    "(p. ej. NO empieces siempre con 'una joven inocente es capturada'). " +
    "Respeta la ATMÓSFERA del género: si es terror, da miedo; si es militar, sabe a deber y combate. " +
    "Devuelve SOLO un objeto JSON válido y completo, sin texto adicional ni markdown. " +
    "Cierra todas las llaves y corchetes.";
  const user =
    `Género: ${profile.genre || "romance"}\n` +
    `Tono: ${toneStr(profile)}\n` +
    `Calor: ${profile.heat_level || "picante"}\n` +
    archLine +
    darkLine +
    atmoLine +
    `Tropos: ${tropes}\n` +
    `Imprescindibles: ${musts}\n` +
    `Evitar: ${avoid}\n` +
    `POV: ${profile.pov || ""} · Ritmo: ${profile.pacing || ""}\n` +
    `Capítulos: ${n}\n\n` +
    `PERSONAJES (usa EXACTAMENTE estos nombres; NO inventes otros):\n` +
    `- protagonista (heroína, voz POV, la más joven): ${byRole.protagonista}\n` +
    `- interes (interés romántico dominante y peligroso, mayor): ${byRole.interes}\n` +
    `- antagonista (villano que amenaza a ambos): ${byRole.antagonista}\n\n` +
    `PUNTO DE PARTIDA OBLIGATORIO (construye la trama sobre esto, no lo ignores):\n` +
    `- Cómo quedan unidos: ${base.setup}\n` +
    `- Dinámica de poder: ${base.powerDynamic}\n` +
    `- La heroína es: ${base.heroineAngle} (NO la escribas como inocente pasiva salvo que de verdad encaje)\n` +
    `- Motor del conflicto: ${base.engine}\n` +
    `- Secreto que reconfigura la trama: ${base.secret}\n` +
    `- Complicación/giro extra: ${base.complication}\n` +
    `- Apertura: ${base.openingTone}\n` +
    `- Forma del arco: ${base.arcTemplate}\n\n` +
    `Devuelve JSON con esta forma exacta (beats: una frase concreta por capítulo, ${n} en total):\n` +
    `{"premise":"1-2 frases originales","setting":"1 frase","traits":{"protagonista":["rasgo","rasgo"],` +
    `"interes":["rasgo","rasgo"],"antagonista":["rasgo","rasgo"]},"beats":["...", "${n} en total"]}`;
  return { system, user };
}

/* --------------------------- buildBible (async) --------------------------- */
export async function buildBible(
  profile: Profile,
  opts?: { llm?: LLMProvider; format?: FormatKey; seed?: string }
): Promise<StoryBible> {
  // 1) pre-check del perfil (incluye must_haves/avoid/settings en el blob)
  const pre = assessProfile({
    genre: profile.genre,
    tone: Array.isArray(profile.tone) ? profile.tone.join(" ") : "",
    tropes: profile.tropes,
    notes: [profile.pov, profile.pacing, ...(profile.must_haves || []), ...(profile.avoid || []), ...(profile.settings || [])].join(" "),
  });
  if (!pre.ok) throw new SafetyError(pre.reason ?? "Perfil no permitido.");

  // 2) base determinista (estructura + fallback de lenguaje)
  const base = deterministicBible(profile, opts?.format, opts?.seed);

  // 3) lenguaje del modelo (con red de seguridad)
  const llm = opts?.llm ?? getProvider();
  const n = base.arc.length;
  let mPremise = "", mSetting = "";
  const mTraits: Record<string, string[]> = {};
  let mBeats: string[] = [];

  try {
    const { system, user } = buildPrompt(profile, n, base);

    // JSON estructurado: temperatura baja y tokens holgados para que no se trunque.
    // Hasta 2 intentos: el modelo a veces devuelve JSON incompleto/no parseable.
    const maxTok = Math.min(3000, 700 + n * 90);
    type ParsedBible = { premise?: unknown; setting?: unknown; traits?: unknown; beats?: unknown };
    let parsed: ParsedBible | null = null;

    for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
      const { text } = await llm.complete({
        system,
        messages: [{ role: "user", content: user }],
        maxTokens: maxTok,
        temperature: 0.7,
      });
      if (!assessOutput(text).ok) {
        logIncident("bible: salida insegura, fallback determinista");
        break; // si es insegura, no reintentar
      }
      parsed = parseJSONLoose(text) as ParsedBible | null;
      if (!parsed) logIncident(`bible: JSON no parseable (intento ${attempt})`);
    }

    if (parsed) {
      mPremise = safeStr(parsed.premise);
      mSetting = safeStr(parsed.setting);
      if (parsed.traits && typeof parsed.traits === "object") {
        const t = parsed.traits as Record<string, unknown>;
        for (const role of CORE_ROLES) mTraits[role] = safeTraits(t[role]);
      }
      if (Array.isArray(parsed.beats)) mBeats = (parsed.beats as unknown[]).map(safeStr);
    }
  } catch {
    logIncident("bible: el modelo falló, fallback determinista");
  }

  // 4) merge: lenguaje del modelo donde sea válido; estructura y NOMBRES mandan
  const characters: BibleCharacter[] = base.characters.map((c) => ({
    ...c,
    // el NOMBRE lo decide el código (no el modelo) para garantizar variedad
    traits: mTraits[c.role]?.length ? mTraits[c.role] : c.traits,
  }));
  const arc = base.arc.map((a, i) => ({ chapter: a.chapter, beat: mBeats[i]?.length ? mBeats[i] : a.beat }));
  const bible: StoryBible = {
    ...base,
    premise: mPremise || base.premise,
    setting: mSetting || base.setting,
    characters,
    arc,
  };

  // 5) post-checks duros
  const adult = enforceAdultCharacters(bible);
  if (!adult.ok) throw new SafetyError(adult.reason ?? "Personaje no permitido.");
  const langBlob = [bible.premise, bible.setting, ...characters.flatMap((c) => c.traits), ...arc.map((a) => a.beat)].join(" \n ");
  if (!assessOutput(langBlob).ok) throw new SafetyError("Contenido no permitido.");

  return bible;
}

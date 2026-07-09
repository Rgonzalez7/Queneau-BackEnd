/* ---------------------------------------------------------------------------
   safety.ts — CAPA DE SEGURIDAD. No se puede apagar.
   Corre ANTES (perfil/prompt) y DESPUÉS (cada salida del modelo).
   Línea absoluta e innegociable: nada que sexualice o ponga en riesgo a menores.
   El modelo NO es la salvaguarda; esta capa, en nuestro código, lo es.

   IMPORTANTE: esto es defensa en profundidad, no una garantía perfecta. En
   producción debe complementarse con un clasificador dedicado y, ante señales,
   revisión humana. Preferimos falsos positivos (bloquear de más) a dejar pasar.
--------------------------------------------------------------------------- */

export interface SafetyResult {
  ok: boolean;
  reason?: string;
}

/* Tipos laxos (estructurales) para no acoplar con otros módulos. */
type ProfileLike = {
  genre?: string;
  tone?: string;
  tropes?: string[];
  notes?: string;
  [k: string]: unknown;
};
type CharacterLike = { name?: string; age?: number };
type BibleLike = { characters?: CharacterLike[] };

/* ----------------------------- normalización ----------------------------- */
function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // quita acentos
}

/* ----------------------------- léxicos (detección) -----------------------------
   Términos para DETECTAR y BLOQUEAR. No son contenido, son filtros.

   IMPORTANTE: en español muchos diminutivos son AMBIGUOS y comunísimos en
   romance adulto ("buena niña" = good girl; "en menor medida"; "hermano menor"
   adulto; "berrinche infantil"). Si los tratáramos como indicio de menor,
   bloquearíamos prosa adulta legítima a cada rato. Por eso aquí dejamos solo
   marcadores INEQUÍVOCOS de minoría de edad. La protección dura real la dan,
   además, la regla de edad <18 y (en producción) un clasificador dedicado.
------------------------------------------------------------------------------- */
const MINOR_TERMS = [
  // español — inequívocos
  "menor de edad", "adolescente", "adolescentes", "preadolescente",
  "colegiala", "quinceanera", "puberal", "pubescente",
  // inglés — inequívocos
  "underage", "preteen", "schoolgirl", "schoolboy", "jailbait",
  "loli", "shota", "teen", "teenage", "child", "children",
];

const SEXUAL_TERMS = [
  // marcadores claramente sexuales (es/en), acotados
  "sexual", "sexo", "desnud", "excit", "orgasm", "penetr", "gemid",
  "erotic", "coito", "masturb", "clitor", "pene", "vagin", "pezon", "semen",
  "sex", "nude", "naked", "aroused", "moan", "genital", "intercourse",
];

function hasAny(text: string, terms: string[]): string | null {
  for (const t of terms) {
    // límite de palabra a ambos lados cuando aplica; para stems usamos inclusión
    const stem = t.length <= 4; // términos cortos -> match por palabra
    if (stem) {
      const re = new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`, "i");
      if (re.test(text)) return t;
    } else if (text.includes(t)) {
      return t;
    }
  }
  return null;
}

/* Edad explícita por debajo de 18 mencionada en texto: "17 años", "16 year(s)". */
function hasUnderageNumber(text: string): boolean {
  const re = /\b([0-9]|1[0-7])\s*(anos|year|years|yo|y\/o)\b/i;
  return re.test(text);
}

/* Posiciones de TODAS las apariciones de una lista de términos (misma semántica
   que hasAny: límite de palabra para stems cortos, inclusión para el resto). */
function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function findHits(text: string, terms: string[]): number[] {
  const out: number[] = [];
  for (const t of terms) {
    const stem = t.length <= 4;
    const re = stem
      ? new RegExp(`(?:^|[^a-z0-9])${escRe(t)}(?:[^a-z0-9]|$)`, "gi")
      : new RegExp(escRe(t), "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.push(m.index);
      if (re.lastIndex <= m.index) re.lastIndex = m.index + 1;
    }
  }
  return out.sort((a, b) => a - b);
}
/* ¿Algún término de A cae dentro de `win` caracteres de algún término de B?
   Co-ocurrencia en PROXIMIDAD (mismo contexto), no en todo el documento. */
function coOccurNear(text: string, aTerms: string[], bTerms: string[], win: number): boolean {
  const a = findHits(text, aTerms);
  if (a.length === 0) return false;
  const b = findHits(text, bTerms);
  if (b.length === 0) return false;
  for (const p of a) {
    let lo = 0, hi = b.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (b[mid] < p - win) lo = mid + 1; else hi = mid; }
    if (lo < b.length && b[lo] <= p + win) return true;
  }
  return false;
}

/* Núcleo: evalúa un texto libre. */
function assessText(raw: string): SafetyResult {
  const text = normalize(raw);

  if (hasUnderageNumber(text)) {
    logIncident("edad explicita <18 en texto");
    return { ok: false, reason: "Edad explícita por debajo de 18." };
  }

  // Co-ocurrencia en PROXIMIDAD (~200 caracteres = mismo contexto), NO en todo
  // el documento. En un libro completo un apodo, un recuerdo de infancia o un
  // "adolescente"/"teen" sueltos a capítulos de distancia de una escena sexual
  // NO son sexualización y disparaban un falso positivo que bloqueaba toda obra
  // adulta. Un término de menor JUNTO a uno sexual sí se bloquea. La regla de
  // edad <18 de arriba sigue siendo absoluta, independiente de la proximidad.
  if (coOccurNear(text, MINOR_TERMS, SEXUAL_TERMS, 200)) {
    logIncident("co-ocurrencia menor+sexual en proximidad");
    return { ok: false, reason: "Indicio de sexualización de menores." };
  }

  return { ok: true };
}

/* ------------------------------- API pública ------------------------------- */

/* Perfil/gustos del usuario antes de construir nada. */
export function assessProfile(p: ProfileLike): SafetyResult {
  const blob = [
    p.genre ?? "",
    p.tone ?? "",
    p.notes ?? "",
    ...(Array.isArray(p.tropes) ? p.tropes : []),
  ].join(" \n ");
  return assessText(blob);
}

/* Toda persona en escenas íntimas debe ser adulta. Edad presente y >= 18. */
export function enforceAdultCharacters(b: BibleLike): SafetyResult {
  const chars = Array.isArray(b.characters) ? b.characters : [];
  for (const c of chars) {
    if (typeof c.age !== "number" || Number.isNaN(c.age)) {
      logIncident("edad de personaje ausente/ambigua");
      return { ok: false, reason: `Edad ausente o ambigua para "${c.name ?? "?"}".` };
    }
    if (c.age < 18) {
      logIncident("personaje menor de 18");
      return { ok: false, reason: `Personaje "${c.name ?? "?"}" es menor de 18.` };
    }
  }
  return { ok: true };
}

/* Cada salida del modelo antes de persistir/mostrar. */
export function assessOutput(text: string): SafetyResult {
  return assessText(text);
}

/* ------------------------------- incidentes -------------------------------
   Registramos el MOTIVO, nunca el contenido ofensivo.
------------------------------------------------------------------------- */
export function logIncident(reason: string): void {
  // En producción: enviar a un log de auditoría. Nunca incluir el texto.
  // eslint-disable-next-line no-console
  console.warn(`[safety] bloqueo: ${reason} @ ${new Date().toISOString()}`);
}

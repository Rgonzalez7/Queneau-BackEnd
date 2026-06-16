/* ---------------------------------------------------------------------------
   analyzer.ts — EXTRACTOR de perfil de gustos a partir de texto pegado.
   (Distinto de bible.ts, que arma la biblia de la historia.)

   Devuelve un borrador de Profile + bandera `blocked`. NO guarda el texto
   fuente: solo deriva etiquetas a nivel de género (postura legal del producto).
   Pasa el texto por safety: si hay indicios no permitidos, blocked = true.

   Es heurístico (stub mejorable): el día que quieras, el modelo puede hacer
   esta extracción con más finura, pero la decisión de bloqueo sigue en código.
--------------------------------------------------------------------------- */
import type { Profile, HeatLevel } from "./types";
import { assessOutput, logIncident } from "./safety";

export type ProfileDraft = Partial<Profile> & { blocked: boolean };

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

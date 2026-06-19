/* ---------------------------------------------------------------------------
   generator.ts — produce sinopsis y capítulos.

   Dos rutas:
   - SÍNCRONA, determinista (genSynopsis / genChapter): sin modelo, instantánea
     y siempre segura. Es la que usa rules.ts hoy. Sirve de fallback.
   - ASÍNCRONA, con modelo (writeSynopsis / writeChapter): el camino "real".
     Cada salida pasa por safety; si es insegura, cae al texto determinista.
     Estas se enchufan a rules.ts cuando volvamos createOpening/purchaseOpening
     asíncronos (paso de cableado).

   La IA hace LENGUAJE; la estructura (biblia, arco, capítulos) la decide el código.
--------------------------------------------------------------------------- */
import type { Profile, Chapter, FormatKey, Story, StoryBible } from "./types";
import { FORMATS } from "./constants";
import { deterministicBible, buildBible } from "./bible";
import { LLMProvider, getProvider, looksLikeRefusal } from "./provider";
import { assessOutput, logIncident } from "./safety";

/* ============================ RUTA SÍNCRONA ============================ */

export function genSynopsis(profile: Profile, format: FormatKey, predecessor: Story | null): string {
  const bible = deterministicBible(profile, format);
  return synopsisFrom(bible, format, predecessor);
}

export function genChapter(profile: Profile, n: number): Chapter {
  const bible = deterministicBible(profile);
  return deterministicChapter(bible, n);
}

/* ============================ RUTA ASÍNCRONA ============================ */

/** Sinopsis con modelo (a partir de una biblia ya construida). */
export async function writeSynopsis(
  bible: StoryBible, format: FormatKey, predecessor: Story | null, llm?: LLMProvider
): Promise<string> {
  const model = llm ?? getProvider();
  const cont = predecessor ? " Es secuela: continúa a los mismos personajes." : "";
  const cast = bible.characters
    .map((c) => `${c.name} (${c.role})`)
    .join(", ");
  const system =
    "Eres un autor de romance adulto (para adultos). Personajes 18+. No describas menores. " +
    "Escribe una sinopsis comercial atractiva, 2-4 frases, sin spoilers del final. " +
    "Usa EXACTAMENTE los nombres de personaje que se te dan; no inventes nombres nuevos. " +
    "Evita fórmulas y aperturas calcadas: NO empieces con la típica 'joven inocente capturada'. " +
    "Haz que esta sinopsis se sienta distinta y específica." +
    (bible.atmosphere ? ` Respeta la atmósfera del género: ${bible.atmosphere}` : "");
  const axes =
    `\nPunto de partida: ${bible.setup || ""}\n` +
    `Dinámica de poder: ${bible.powerDynamic || ""}\n` +
    `La heroína es: ${bible.heroineAngle || ""}\n` +
    `Motor del conflicto (gancho central, úsalo): ${bible.engine || ""}`;
  const user =
    `Premisa: ${bible.premise}\nAmbientación: ${bible.setting}\nTono: ${bible.tone}\n` +
    `Personajes (usa estos nombres exactos): ${cast}\n` +
    `Tropos: ${bible.tropes.join(", ")}\nFormato: ${FORMATS[format].label}.${cont}${axes}`;
  try {
    const { text } = await model.complete({ system, messages: [{ role: "user", content: user }], maxTokens: 220, temperature: 0.8 });
    const clean = stripMarkdown(text.trim());
    if (clean && !looksLikeRefusal(clean) && assessOutput(clean).ok) return clean;
    logIncident("synopsis: salida insegura/rechazo/vacía, fallback");
  } catch {
    logIncident("synopsis: modelo falló, fallback");
  }
  return synopsisFrom(bible, format, predecessor);
}

/** Capítulo con modelo, con CONTINUIDAD. Devuelve {t,b}; si falla/insegura -> determinista. */
export async function writeChapter(args: {
  bible: StoryBible; index: number; storySoFar?: string; llm?: LLMProvider;
}): Promise<Chapter> {
  const { bible, index } = args;
  const model = args.llm ?? getProvider();
  const total = bible.arc.length;
  const beat = bible.arc[index - 1]?.beat ?? "Desarrollo";
  const cast = bible.characters
    .map((c) => `- ${c.name} — ${c.role}, ${c.age} años: ${c.traits.join(", ")}`)
    .join("\n");
  const arcList = bible.arc
    .map((a) => `${a.chapter === index ? "▶ " : "  "}Cap ${a.chapter}: ${a.beat}`)
    .join("\n");
  const soFar = (args.storySoFar || "").trim();

  // Directiva de explicitud según el nivel de calor del perfil (adultos).
  const heatDirective = (h: string): string => {
    switch ((h || "").toLowerCase()) {
      case "explícito":
      case "explicito":
        return "NIVEL DE CALOR: EXPLÍCITO. Cuando la escena lo pida, escribe las escenas sexuales de forma EXPLÍCITA, DETALLADA y SIN CORTES: describe los cuerpos, los actos, el ritmo y las sensaciones con lenguaje directo, crudo y vulgar (términos anatómicos y sexuales, sin eufemismos ni rodeos). Prohibido el 'fundido a negro' o saltarse el acto. SIEMPRE entre adultos que consienten.";
      case "picante":
        return "NIVEL DE CALOR: PICANTE. Las escenas íntimas son sensuales y sugerentes, con tensión física y algo de detalle, pero sin lenguaje vulgar explícito.";
      case "cálido":
      case "calido":
        return "NIVEL DE CALOR: CÁLIDO. Insinúa la intimidad con romanticismo; no describas el acto sexual de forma explícita.";
      default:
        return "NIVEL DE CALOR: PUERTAS CERRADAS. La intimidad ocurre fuera de escena; no describas actos sexuales.";
    }
  };
  const musts = (bible.mustHaves || []).filter(Boolean);

  // Motor del conflicto: presente en todo el libro. El secreto se revela cerca
  // del punto medio; la complicación entra en el tercio final. Así el giro cae
  // donde debe y cada libro avanza distinto.
  const phase = index / total;
  const plotDirectives =
    (bible.engine ? `MOTOR DEL CONFLICTO (mantenlo vivo en este capítulo): ${bible.engine}.\n` : "") +
    (bible.secret && phase >= 0.45 && phase <= 0.65
      ? `GIRO CLAVE: en torno a este punto del libro, deja caer o revela el secreto que reconfigura la trama: ${bible.secret}.\n`
      : "") +
    (bible.complication && phase >= 0.7
      ? `COMPLICACIÓN (tercio final): introduce o intensifica esta vuelta de tuerca: ${bible.complication}.\n`
      : "");

  // Escenas que la lectora pidió, asignadas por el código a ESTE capítulo.
  const sceneHere = (bible.scenePlan || []).filter((s) => s.chapter === index).map((s) => s.directive);
  const sceneDirective = sceneHere.length
    ? `ESCENAS PEDIDAS PARA ESTE CAPÍTULO (intégralas con naturalidad dentro de la trama y respeta el nivel de calor): ${sceneHere.join("; ")}.\n`
    : "";

  // Solo el capítulo 1: arranca distinto en cada libro según los ejes de variación.
  const opening = index === 1
    ? `APERTURA DEL LIBRO (capítulo 1): ${bible.openingTone || "engancha desde la primera línea"}. ` +
      `Presenta a la heroína como ${bible.heroineAngle || "una protagonista activa"} y pon en marcha la situación de origen: ${bible.setup || bible.premise}. ` +
      `Engancha desde la primera línea con una imagen, una acción o un conflicto concreto. ` +
      `EVITA aperturas calcadas y fórmulas tipo "una joven inocente es capturada".`
    : "";

  const system =
    "Eres un autor profesional de novela romántica adulta (para adultos) en español. " +
    "TODOS los personajes son adultos (18+); jamás describas a menores en ningún contexto. " +
    "Escribe prosa inmersiva, natural y correcta en español neutro. " +
    "REGLAS DE CONTINUIDAD (imprescindibles): " +
    "1) CONTINÚA la historia desde donde quedó; NO la reinicies. " +
    "2) NO repitas escenas, frases ni párrafos de capítulos anteriores; NO abras con la misma frase. " +
    "3) NO vuelvas a presentar a personajes ya presentados. " +
    "4) Avanza ÚNICAMENTE el objetivo de ESTE capítulo. " +
    "No incluyas encabezados, títulos ni notas: solo la prosa del capítulo. " +
    "Escribe en PROSA PLANA: nada de Markdown, sin asteriscos (* o **) ni almohadillas (#); los diálogos van con raya (—), nunca entre asteriscos. " +
    (bible.atmosphere ? `ATMÓSFERA DEL GÉNERO (cúmplela en cada escena): ${bible.atmosphere} ` : "") +
    heatDirective(bible.heat);

  const user =
    `BIBLIA (fija):\n- Premisa: ${bible.premise}\n- Ambientación: ${bible.setting}\n` +
    `- Tono: ${bible.tone} · Calor: ${bible.heat}\n` +
    (bible.archetype ? `- Arquetipo del interés: ${bible.archetype}\n` : "") +
    (bible.darkness ? `- Nivel de oscuridad: ${bible.darkness}\n` : "") +
    (musts.length ? `- Imprescindibles (inclúyelos cuando encajen): ${musts.join(", ")}\n` : "") +
    `- Personajes:\n${cast}\n\n` +
    `ARCO COMPLETO (▶ = capítulo a escribir):\n${arcList}\n\n` +
    `LO OCURRIDO HASTA AHORA:\n${soFar || "(este es el comienzo del libro)"}\n\n` +
    (opening ? `${opening}\n\n` : "") +
    (plotDirectives ? `${plotDirectives}\n` : "") +
    (sceneDirective ? `${sceneDirective}\n` : "") +
    `Escribe el CAPÍTULO ${index} de ${total}. Objetivo exclusivo de este capítulo: ${beat}. ` +
    `Empieza justo donde terminó el capítulo anterior y avanza la trama. ` +
    `Cierra el capítulo con una frase completa; no lo dejes a medias.`;

  try {
    const { text } = await model.complete({
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: 2200,
      temperature: 0.9,
    });
    const body = cleanChapterText(trimToLastSentence(text.trim()));
    if (body && !looksLikeRefusal(body) && assessOutput(body).ok) return { t: chapterTitle(index, beat), b: body };
    logIncident("chapter: salida insegura/rechazo/vacía, fallback determinista");
  } catch {
    logIncident("chapter: modelo falló, fallback determinista");
  }
  return deterministicChapter(bible, index);
}

/** Si el texto se cortó a media frase (sin puntuación de cierre), lo recorta
    hasta el último final de frase para no mostrar un corte feo ("...Arch"). */
function trimToLastSentence(text: string): string {
  const t = text.trimEnd();
  if (!t) return t;
  if (/[.!?…"”»]$/.test(t)) return t; // ya termina bien
  const m = t.match(/[\s\S]*[.!?…"”»]/); // hasta el último cierre de frase
  if (m && m[0].length > 200) return m[0].trimEnd();
  return t; // si no hay buen punto de corte, devuélvelo tal cual
}

/** Quita artefactos de Markdown (negritas/cursivas con * o _, encabezados #,
    citas >) que el lector mostraría literales. Normaliza los separadores de
    escena (***, ---, * * *) a "* * *". NO toca el texto, solo el formato. */
function stripMarkdown(raw: string): string {
  let t = (raw || "").replace(/\r/g, "");
  // separadores de escena -> sentinela temporal (para no borrar sus asteriscos)
  t = t.replace(/^[ \t]*([*\-_=]\s*){3,}[ \t]*$/gm, "\u0000SC\u0000");
  // encabezados y citas por línea
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "").replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  // cursivas con guion bajo: _texto_ -> texto (conservador, acotado por límites)
  t = t.replace(/(^|[\s(¡¿"“])_([^_\n]+?)_(?=[\s.,;:!?)"”…—-]|$)/g, "$1$2");
  // negritas/cursivas con asterisco: quita TODOS los * (el divisor está a salvo)
  t = t.replace(/\*/g, "");
  // restaura el separador de escena, aislado por líneas en blanco
  t = t.replace(/\s*\u0000SC\u0000\s*/g, "\n\n* * *\n\n");
  // limpia espacios al final de línea y colapsa saltos
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

/** Limpia un capítulo: además del Markdown, descarta un encabezado redundante
    al inicio ("**CAPÍTULO 5: …**", "# …"), porque la app ya pone el título. */
function cleanChapterText(raw: string): string {
  const lines = (raw || "").replace(/\r/g, "").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length) {
    const firstRaw = lines[0].trim();
    const noMd = firstRaw.replace(/^[*_#>\s]+/, "").replace(/[*_]+$/, "").trim();
    const isMdHeading = /^#{1,6}\s+\S/.test(firstRaw);
    // solo lo tratamos como encabezado de capítulo si trae número, ":" o markdown
    const isChapterHeading =
      /^cap[ií]tulo\b/i.test(noMd) && (/\d/.test(noMd) || noMd.includes(":") || /[*#]/.test(firstRaw));
    if (isMdHeading || isChapterHeading) {
      lines.shift();
      while (lines.length && !lines[0].trim()) lines.shift();
    }
  }
  return stripMarkdown(lines.join("\n"));
}

/** Construye una biblia con modelo (re-exporta buildBible para comodidad). */
export { buildBible };

/** Resumen de un capítulo (1-2 frases) para alimentar la continuidad. Usa el
    modelo; si falla, cae a un resumen heurístico. NO se muestra al usuario. */
export async function summarizeChapter(
  bible: StoryBible, index: number, body: string, llm?: LLMProvider
): Promise<string> {
  const model = llm ?? getProvider();
  try {
    const { text } = await model.complete({
      system:
        "Resume en 1-2 frases, en pasado y sin adornos, lo esencial que ocurre en el " +
        "capítulo (hechos clave y cambios en la relación). Devuelve solo el resumen.",
      messages: [{ role: "user", content: `Capítulo ${index}:\n${body.slice(0, 4000)}` }],
      maxTokens: 120,
      temperature: 0.3,
    });
    const t = text.trim();
    if (t) return t;
  } catch { /* fallback abajo */ }
  return heuristicSummary(body);
}

function heuristicSummary(body: string, maxChars = 240): string {
  const clean = body.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastDot = cut.lastIndexOf(".");
  return (lastDot > 80 ? cut.slice(0, lastDot + 1) : cut) + " …";
}

/* ============================ DETERMINISTA ============================ */

function synopsisFrom(bible: StoryBible, format: FormatKey, predecessor: Story | null): string {
  const cont = predecessor
    ? ` Continúa la historia de «${predecessor.title}», con los mismos personajes donde quedaron.`
    : "";
  return `${bible.premise} ${bible.setting} (${FORMATS[format].label.toLowerCase()}).${cont}`;
}

function chapterTitle(n: number, _beat?: string): string {
  return `Capítulo ${n}`;
}

function deterministicChapter(bible: StoryBible, n: number): Chapter {
  const beat = bible.arc[n - 1]?.beat ?? "Desarrollo";
  const a = bible.characters[0]?.name ?? "Ella";
  const b = bible.characters[1]?.name ?? "Él";
  const body =
    `${a} sabía que esa noche marcaría un antes y un después. ` +
    `El aire entre ${a} y ${b} estaba cargado de todo lo que ninguno se atrevía a decir. ` +
    `(${beat}.) Tono ${bible.tone}. ` +
    `\n\n[Borrador determinista — el modelo escribirá esta escena completa cuando se enchufe la ruta asíncrona.]`;
  return { t: chapterTitle(n, beat), b: body };
}

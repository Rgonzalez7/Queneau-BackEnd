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
import { LLMProvider, getProvider, getAnalysisProvider, looksLikeRefusal, looksLikeGarbage } from "./provider";
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

/* Ángulos de blurb: cada libro se inclina hacia uno distinto (sembrado) para que
   las contraportadas no se sientan calcadas. */
const SYN_ANGLES = [
  "Apóyate en la OBSESIÓN y la atracción prohibida.",
  "Apóyate en el PELIGRO y una amenaza inminente.",
  "Apóyate en la VENGANZA y todo lo que está en juego.",
  "Apóyate en la TENSIÓN de dos enemigos que se desean.",
  "Apóyate en el CONTROL: quién domina a quién.",
  "Apóyate en un SECRETO a punto de estallar.",
  "Apóyate en la delgada línea entre proteger y poseer.",
  "Apóyate en la cacería: quién persigue y quién es la presa.",
];

/* ESTRUCTURAS de contraportada (formas variadas, no una sola por POV). Se elige
   una por libro con la semilla, para que la sinopsis cambie de forma cada vez
   pero siga siendo un gancho de contraportada. Inspiradas en blurbs reales. */
const SYN_STRUCT_SINGLE = [
  "FORMA — Confesión rota: 7 a 10 líneas MUY cortas y fragmentadas en primera persona, desde la protagonista. Deseo y amenaza por sustracción (que se sientan sin nombrarlos). Sin encabezados.",
  "FORMA — Lo que soporto / lo que no: enumera en líneas cortas varias cosas que ella SÍ puede soportar (las mentiras, las traiciones, las amenazas…), luego el quiebre en su propia línea («Lo que no puedo soportar es a él.»), y 3-4 líneas de por qué. Cierra con un giro que muerde.",
  "FORMA — Misión en verbos: abre con una premisa simple en una línea; debajo 3 verbos en infinitivo, cada uno en su línea (p. ej. «Encontrarlo. / Capturarlo. / Entregarlo.»); luego un «Pero…» que lo derrumba todo, y 3-4 líneas de tensión y deseo.",
  "FORMA — Reglas rotas: tres reglas cortas, cada una en su línea (no lo mires, no lo desees, no confíes en él), y revela que ya rompió la última. Remata con 3-4 líneas de consecuencias.",
  "FORMA — Juramento roto: una línea de juramento o plan («Juré destruirlo.»); una línea de quiebre («Entonces dejó de ser tan simple.»); y 4-6 líneas de cómo el deseo cambió las reglas, en primera persona.",
];
const SYN_STRUCT_DUAL = [
  "FORMA — Dos voces con epíteto: dos bloques. Cada bloque abre con un EPÍTETO en MAYÚSCULAS en su propia línea (apodo evocador, p. ej. «LA REINA DEL HIELO», «EL MONSTRUO») y debajo 4 a 7 líneas MUY cortas en primera persona desde esa mirada. Primero ella; una línea en blanco; luego él.",
  "FORMA — Llamada y respuesta: dos bloques con epíteto en MAYÚSCULAS. La voz de él RESPONDE o contradice lo que dijo ella (que se sienta el duelo entre los dos). 4 a 6 líneas cortas cada bloque, una línea en blanco entre ambos.",
  "FORMA — Ella confiesa / Él amenaza: dos bloques con epíteto en MAYÚSCULAS. El de ella respira deseo que teme; el de él, posesión y amenaza. 4 a 6 líneas cortas cada uno, primera persona, con una línea en blanco en medio.",
];
const SYN_STRUCT_THIRD = [
  "FORMA — Contraportada en tercera persona: 6 a 9 líneas cortas en tercera persona, con EPÍTETOS en vez de nombres. Presenta a los dos y el choque inevitable entre ellos. Cierra con un anzuelo.",
  "FORMA — Sentencia y giro: tercera persona. Una sentencia rotunda sobre ella; otra sobre él; una tercera que los enfrenta; y un cierre que insinúa que ninguno saldrá igual. Líneas cortas.",
];

/** Sinopsis con modelo (a partir de una biblia ya construida). */
/* Título REAL del libro: corto (2-4 palabras), evocador, en clave dark, ligado a
   la trama. Se crea una sola vez al comprar. Devuelve "" si falla (el frontend
   cae al descriptor). */
export async function generateBookTitle(bible: StoryBible, opening: string): Promise<string> {
  try {
    const chars = (bible.characters || []).map((c) => c.name).filter(Boolean).slice(0, 3).join(", ");
    const { text } = await getAnalysisProvider().complete({
      system:
        "Eres titulador de novelas de ROMANCE OSCURO en español. Devuelve UN solo título: " +
        "corto (2 a 4 palabras), evocador, en clave dark/posesivo/mafia, ligado a la trama. " +
        "Sin subtítulo, sin comillas, sin punto final, sin el nombre del género ni del formato. " +
        "Responde SOLO con el título.",
      messages: [{ role: "user", content: `Premisa: ${bible.premise || "—"}\nPersonajes: ${chars || "—"}\nInicio del libro:\n${(opening || "").slice(0, 1600)}` }],
      temperature: 0.9,
      maxTokens: 24,
    });
    let t = (text || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
    t = t.replace(/^["'«»“”\s\-–—*]+|["'«»“”.\s\-–—*]+$/g, "").trim(); // quita comillas/puntuación de borde
    if (/^t[íi]tulo\b[:\-]?/i.test(t)) t = t.replace(/^t[íi]tulo\b[:\-]?\s*/i, "").trim(); // por si antepone "Título:"
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length > 5) t = words.slice(0, 5).join(" ");
    if (t.length > 44) t = t.slice(0, 44).trim();
    return t;
  } catch {
    return "";
  }
}

export async function writeSynopsis(
  bible: StoryBible, format: FormatKey, predecessor: Story | null, llm?: LLMProvider
): Promise<string> {
  const model = llm ?? getProvider();
  const cont = predecessor ? "Es secuela: continúa a los mismos personajes.\n" : "";
  const cast = bible.characters.map((c) => c.name).join(", ");

  // formato según el POV elegido en la categoría
  const pov = (bible.pov || "").toLowerCase();
  const twoVoices = /dual|m[úu]ltiple/.test(pov);
  const third = /tercera/.test(pov);
  // Estructura VARIADA (no una fija por POV): se elige del pool del POV con la
  // semilla del libro, así cada libro trae una forma de contraportada distinta.
  const structPool = twoVoices ? SYN_STRUCT_DUAL : third ? SYN_STRUCT_THIRD : SYN_STRUCT_SINGLE;
  const formatInstr = structPool[Math.floor(imRng(`${bible.id || "q"}:synstruct`)() * structPool.length)];

  const angle = SYN_ANGLES[Math.floor(imRng(`${bible.id || "q"}:blurb`)() * SYN_ANGLES.length)];

  const system =
    "Eres autor de dark romance adulto (18+); todos los personajes son mayores de edad y jamás describes menores. " +
    "Escribe la CONTRAPORTADA (blurb) del libro, NO un resumen de la trama. " +
    "Estilo: líneas cortas, fragmentadas, con saltos de línea; ritmo de gancho que venda tensión, obsesión, peligro y deseo. " +
    "Frases punzantes y evocadoras, sin spoilers del desenlace. " +
    "NO narres los hechos ni repitas nombres propios: usa EPÍTETOS evocadores, roles o pronombres (como mucho UN nombre en todo el texto, y solo si hace falta). " +
    "Muestra la emoción por sustracción: que se sientan el deseo y la amenaza sin nombrarlos. " +
    "Prosa plana: nada de Markdown, sin asteriscos ni almohadillas. " +
    formatInstr +
    (bible.atmosphere ? ` Respeta la atmósfera del género: ${bible.atmosphere}.` : "");

  const user =
    `Inspírate en esta vibra (no la copies literal):\n` +
    `Tono: ${bible.tone}\nIntensidad: ${bible.heat}\nTropos: ${bible.tropes.join(", ")}\n` +
    (bible.engine ? `Gancho central (insinúalo, no lo spoilees): ${bible.engine}\n` : "") +
    (bible.powerDynamic ? `Dinámica de poder: ${bible.powerDynamic}\n` : "") +
    (bible.lie ? `Subtexto de ella (no lo digas literal): ${bible.lie}\n` : "") +
    (bible.interestContradiction ? `Contradicción de él: ${bible.interestContradiction}\n` : "") +
    `Enfoque de ESTE blurb: ${angle}\n` +
    (cast ? `Si necesitaras un nombre (evítalos en lo posible), usa uno de estos: ${cast}\n` : "") +
    cont;

  try {
    const { text } = await model.complete({ system, messages: [{ role: "user", content: user }], maxTokens: 360, temperature: 0.92 });
    const clean = stripMarkdown(text.trim());
    if (clean && !looksLikeRefusal(clean) && !looksLikeGarbage(clean) && assessOutput(clean).ok) return clean;
    logIncident("synopsis: salida insegura/rechazo/vacía, fallback");
  } catch {
    logIncident("synopsis: modelo falló, fallback");
  }
  return synopsisFrom(bible, format, predecessor);
}

/** Capítulo con modelo, con CONTINUIDAD. Devuelve {t,b}; si falla/insegura -> determinista. */
/* --------- variación de intimidad: rompe el molde repetitivo de las escenas
   sexuales (mismo vocabulario, mismo "sin preámbulos", misma coreografía).
   Se siembra por libro + capítulo, así cada escena difiere de las anteriores
   y de las de otros libros. Solo aplica con calor picante/explícito. --------- */
function imRng(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* Ejes CONCRETOS de la escena íntima. La clave para que no se repitan no es solo
   variar el vocabulario, sino el MONTAJE: dónde, en qué postura, cómo empieza,
   qué forma tiene y qué significa para ellos aquí. Se rotan por índice de capítulo
   (con desfases distintos) para que dos escenas del mismo libro nunca coincidan. */
const INTIMACY_SETTING = [
  "en una cama, sin prisa",
  "contra una puerta recién cerrada",
  "en el suelo, sobre la ropa a medio quitar",
  "en un sofá, a medio vestir",
  "bajo el agua de la ducha",
  "a oscuras, guiándose solo por el tacto",
  "sobre una mesa o un escritorio",
  "en la cocina, contra la encimera",
  "en un coche detenido, apretados y a oscuras",
  "al aire libre, con el riesgo de que los descubran",
];
const INTIMACY_POSITION = [
  "ella encima, marcando el ritmo",
  "cara a cara, sin romper el contacto visual",
  "él detrás de ella, lento",
  "ella a horcajadas sobre él",
  "él de rodillas ante ella antes de nada",
  "entrelazados de lado, sin prisa",
  "ella sujeta entre el cuerpo de él y la superficie",
];
const INTIMACY_OPENING = [
  "empieza como una discusión que se vuelve física",
  "empieza despacio, la ropa cayendo pieza a pieza",
  "empieza con él pidiendo permiso en voz baja",
  "empieza con ella tomando el control primero",
  "empieza tras una provocación larga y contenida",
  "empieza a medias, con miedo a que los interrumpan",
  "empieza con una ternura inesperada que descoloca a ambos",
];
const INTIMACY_ARC = [
  "el ritmo se acelera poco a poco",
  "rápido y desesperado, pero con reacciones específicas, no genéricas",
  "empieza rudo y se ablanda hacia el final",
  "con pausas, provocación y retomadas",
  "el poder cambia de manos a mitad de la escena",
  "se corta antes del final y lo deja en el aire",
];
const INTIMACY_CHARGE = [
  "sexo de rabia: ninguno quiere ceder primero",
  "desesperación, como si fuera la última vez",
  "una primera vez con nervios y algo de torpeza real",
  "reconciliación: alivio y culpa mezclados",
  "un acto de posesión, de marcar territorio",
  "ternura que agrieta la fachada de uno de los dos",
  "consuelo callado después del peligro",
  "una despedida disfrazada de deseo",
];
const INTIMACY_REGISTER = [
  "lenguaje anatómico y directo: nombra las partes del cuerpo con palabras reales; evita eufemismos como «su sexo», «su centro», «su feminidad», «su intimidad», «su miembro» o «su humedad»",
  "lenguaje crudo y vulgar, con palabrotas dichas en voz alta durante el acto",
  "registro sensorial y físico: presión, calor, sabor, textura y sonido concretos por encima de las metáforas",
  "registro verbal y sucio: las órdenes, provocaciones y súplicas que se dicen pesan tanto como lo que hacen",
];
const INTIMACY_FOREGROUND = [
  "las manos y la boca: dónde se posan, qué evitan",
  "la voz, la respiración y los silencios",
  "la mirada sostenida y lo que se dicen sin hablar",
  "el control: quién lo tiene y cuándo lo pierde",
  "el después: el cuerpo, el cuarto, lo que queda sin decir",
];
// Prohibiciones SIEMPRE activas: el patrón exacto que más se repite.
const INTIMACY_BAN_CORE = [
  "la fórmula «la empotró/empujó contra la pared»",
  "«de un solo movimiento» o «de una sola embestida»",
  "«sin preámbulos» / «no hubo preámbulos»",
  "«profundo y brutal»",
  "«ahogó un gemido contra su hombro/cuello»",
  "«las piernas alrededor de su cintura»",
  "los eufemismos «su sexo», «su centro», «su humedad», «su entrada», «su feminidad», «su miembro»",
];
// Clichés gastados; se rota un subconjunto distinto por escena.
const INTIMACY_BAN_EXTRA = [
  "«arqueó la espalda»", "«oleadas de placer»", "«estalló en mil pedazos»",
  "«embistió con fuerza»", "«gimió su nombre»", "«tocó el cielo»",
  "«una corriente le recorrió la espina»", "«lo recibió por completo»",
  "«se hundió en ella»", "«explotó de placer»", "«sin aviso»",
];

function rotPick<T>(arr: T[], base: number, index: number, stride: number): T {
  return arr[(((base + index * stride) % arr.length) + arr.length) % arr.length];
}

function intimacyVariation(bible: StoryBible, index: number): string {
  if (!/expl[ií]cit|picante/i.test(bible.heat || "")) return "";
  const base = Math.floor(imRng(`${bible.id || "q"}:imbase`)() * 100000);
  const r = imRng(`${bible.id || "q"}:intim:${index}`);
  const extra = [...INTIMACY_BAN_EXTRA].sort(() => r() - 0.5).slice(0, 3);
  const bans = [...INTIMACY_BAN_CORE, ...extra].join("; ");
  return (
    `VARIEDAD ÍNTIMA (si en este capítulo hay escena sexual, debe sentirse DISTINTA a cualquier otra del libro):\n` +
    `• Escenario: ${rotPick(INTIMACY_SETTING, base, index, 3)}.\n` +
    `• Postura/configuración: ${rotPick(INTIMACY_POSITION, base, index, 5)}.\n` +
    `• Cómo empieza: ${rotPick(INTIMACY_OPENING, base, index, 2)}.\n` +
    `• Forma de la escena: ${rotPick(INTIMACY_ARC, base, index, 7)}.\n` +
    `• Carga emocional (qué significa para ellos aquí): ${rotPick(INTIMACY_CHARGE, base, index, 4)}.\n` +
    `• Registro de la prosa: ${rotPick(INTIMACY_REGISTER, base, index, 1)}.\n` +
    `• Pon el foco en: ${rotPick(INTIMACY_FOREGROUND, base, index, 3)}.\n` +
    `PROHIBIDO (son las fórmulas que más se repiten, no uses ninguna): ${bans}.\n` +
    `Cambia escenario, postura y arranque respecto a las escenas íntimas anteriores; que ninguna se sienta calcada.\n`
  );
}

/* Arco de personaje por fase: la grieta entre la máscara y la realidad. Refuerza
   la mentira al inicio, la agrieta a la mitad (con recaída), y la rompe al final
   en una elección costosa. Da profundidad sin volver al personaje "coherente". */
function characterDirective(bible: StoryBible, index: number, total: number): string {
  if (!bible.lie && !bible.flaw && !bible.facade) return "";
  const phase = total > 0 ? index / total : 0;
  const base = [
    bible.facade ? `Su fachada ante el mundo: ${bible.facade}.` : "",
    bible.flaw ? `Su defecto que la sabotea: ${bible.flaw}.` : "",
    bible.lie ? `La MENTIRA que cree: «${bible.lie}».` : "",
  ].filter(Boolean).join(" ");

  let phaseLine: string;
  if (phase < 0.34) {
    phaseLine = `En este punto: muestra la fachada en acción y deja entrever ${bible.wound || "una herida vieja"} sin nombrarla; su defecto la mete en problemas.`;
  } else if (phase < 0.72) {
    phaseLine = `En este punto: el mundo y la relación agrietan su mentira. Puede haber un falso avance y luego una RECAÍDA a su defecto bajo presión (no la cures en línea recta).`;
  } else {
    phaseLine = `En este punto: oblígala a confrontar la mentira; el cambio se prueba en una elección costosa que rompe su fachada hacia la verdad: ${bible.need || "soltar lo que la protegía"}.`;
  }
  const interest = bible.interestContradiction && phase >= 0.2 && phase < 0.85
    ? ` El interés romántico encarna una contradicción: ${bible.interestContradiction}.`
    : "";
  return `ARCO DEL PERSONAJE (mantén la grieta entre lo que dice ser y lo que hace bajo presión). ${base} ${phaseLine}${interest}\n`;
}

/* ---------------------- inyección de VOZ (fase 2) ------------------------ */
function pickLexicon(bible: StoryBible, index: number): string[] {
  const L = bible.voice?.lexicon;
  if (!L) return [];
  const explicit = /expl[ií]cit|picante/i.test(bible.heat || "");
  const pool: string[] = [];
  if (explicit) pool.push(...(L.sex || []), ...(L.sex || [])); // peso doble a lo íntimo si aplica
  pool.push(...(L.violence || []), ...(L.action || []));
  const uniq = [...new Set(pool.map((s) => s.trim()).filter(Boolean))];
  if (uniq.length === 0) return [];
  const r = imRng(`${bible.id || "q"}:lex:${index}`);
  const shuffled = uniq.sort(() => r() - 0.5);
  return shuffled.slice(0, explicit ? 12 : 8);
}

/* ¿El ADN pide un registro duro (crudo/explícito/oscuro)? */
function hardRegister(bible: StoryBible): boolean {
  const expl = (bible.voice?.knobs?.explicitness ?? 0) >= 4;
  const dark = /very-dark|extreme-dark/i.test(bible.darkness || "");
  const hot = /expl[ií]cit/i.test(bible.heat || "");
  return expl || dark || hot;
}

/* Deriva "vainilla": cúmulo de diminutivos/cursilerías impropio de un ADN duro. */
function looksTooSoft(text: string): boolean {
  const t = (text || "").toLowerCase();
  const tender = (t.match(/\b(nena|mi amor|mi vida|mi cielo|cariño|amorcito|princesa|mi reina)\b/g) || []).length;
  return tender >= 4;
}

function countWords(text: string): number {
  return (text || "").trim().split(/\s+/).filter(Boolean).length;
}

/* ¿El texto está narrado en PRIMERA persona? Cuenta marcadores de 1ª persona en
   la NARRACIÓN (quitando el diálogo, donde "yo/me/mi" es legítimo en cualquier POV). */
function isFirstPerson(text: string): boolean {
  const narration = (text || "")
    .replace(/—[^\n]*?(—|$)/gm, " ")   // quita segmentos de diálogo con raya
    .replace(/[""«»][^""«»]*[""«»]/g, " "); // y entrecomillados
  const words = countWords(narration) || 1;
  const fp = (narration.match(/\b(yo|me|m[ií]|mis|m[ií][oa]s?|conmigo)\b/gi) || []).length;
  return (fp / words) * 100 >= 1.0; // ≥1 marcador de 1ª persona por 100 palabras de narración
}

/* Persona objetivo del ADN: de las reglas ("primera/tercera persona") o, si no lo
   dicen, inferida de la muestra de estilo. null = sin señal (no se fuerza). */
function voicePerson(bible: StoryBible): "primera" | "tercera" | null {
  const v = bible.voice;
  if (!v) return null;
  const imp = (v.imperatives || []).join(" · ").toLowerCase();
  if (/\b(primera|1[ªa])\s*persona\b|narrador(a)?\s+protagonista/.test(imp)) return "primera";
  if (/\b(tercera|3[ªa])\s*persona\b/.test(imp)) return "tercera";
  if (v.styleSample) return isFirstPerson(v.styleSample) ? "primera" : "tercera";
  return null;
}

/* Detecta un capítulo "resumen": demasiado corto, o un solo bloque de narración
   que CUENTA los hechos en vez de mostrarlos como escena (poco diálogo, casi sin
   párrafos). */
function looksLikeSummary(text: string): boolean {
  const words = countWords(text);
  if (words < 350) return true; // anémico para el formato
  const paras = (text || "").split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean).length;
  const dashes = (text || "").match(/[—–]\s|(^|\n)\s*[-–—]\s/g)?.length || 0;
  if (paras <= 2 && dashes < 2 && words < 700) return true; // un bloque de "telling"
  return false;
}

function voiceDirective(bible: StoryBible, index: number): { top: string; sample: string } {
  const v = bible.voice;
  if (!v) return { top: "", sample: "" };
  const lines: string[] = [];
  if (v.imperatives && v.imperatives.length) {
    lines.push(`VOZ DEL LIBRO (obligatorio en TODO el capítulo): ${v.imperatives.join(" · ")}.`);
  }
  if (v.knobs) {
    const k = v.knobs;
    lines.push(
      `MÉTRICA DE VOZ: tiempo ${k.tense}; frase promedio ${k.sentenceAvg[0]}-${k.sentenceAvg[1]} palabras; ` +
      `párrafos ${k.paragraphLines}; diálogo ${k.dialogueRatio}; interioridad ${k.interiority}.`
    );
    const person = voicePerson(bible);
    if (person) {
      lines.push(
        `NARRADOR (obligatorio, constante en TODO el capítulo y en todo el libro): ${person === "primera" ? "PRIMERA persona (yo)" : "TERCERA persona (él/ella)"}, tiempo ${k.tense}. No cambies de narrador ni de tiempo verbal.`
      );
    }
  }
  const lex = pickLexicon(bible, index);
  if (lex.length) {
    lines.push(`PALETA LÉXICA del libro (cuando la escena sea íntima, violenta o de acción, ECHA MANO de estos términos con naturalidad y sin censurarte; no los enumeres ni los uses todos): ${lex.join(", ")}.`);
  }
  if (hardRegister(bible)) {
    lines.push(
      "REGISTRO OBLIGATORIO: crudo, visceral y directo, acorde al ADN. En escenas íntimas o de violencia NO te censures ni suavices. " +
      "En las escenas de SEXO nombra los actos y las partes del cuerpo con el vocabulario CRUDO y ANATÓMICO del ADN (verga, polla, coño, follar, penetración, etc.); PROHIBIDO el eufemismo romántico (\"llegó\", \"su centro\", \"su feminidad\", \"se unieron\", \"hicieron el amor\"). " +
      "Prohibido también derivar a romance azucarado o diminutivos cursis (\"nena\", \"mi amor\", \"cariño\") salvo con intención de poder o ironía. La ternura, si aparece, es tensa y contaminada, no dulce."
    );
  }
  const sample = v.styleSample
    ? `EJEMPLO DE LA VOZ (imita su ritmo, sintaxis y registro; NO copies su contenido, personajes ni situación):\n«${v.styleSample}»`
    : "";
  return { top: lines.join("\n"), sample };
}

/* Devuelve el hito estructural (patrón de la voz) que toca en este capítulo. */
function plotBeatFor(bible: StoryBible, index: number, total: number): string {
  const beats = bible.voice?.plotBeats;
  if (!beats || beats.length === 0 || total <= 0) return "";
  const phase = ((index - 0.5) / total) * 100;   // % del centro del capítulo
  const window = (100 / total) * 0.75;            // media ventana de capítulo
  const near = beats
    .filter((b) => Math.abs(b.at - phase) <= window)
    .sort((a, z) => Math.abs(a.at - phase) - Math.abs(z.at - phase));
  if (near.length === 0) return "";
  const b = near[0];
  return `HITO ESTRUCTURAL (patrón de la voz, ~${Math.round(b.at)}% del libro): ${b.type}${b.note ? ` — ${b.note}` : ""}. Haz que en este capítulo ocurra un momento de este TIPO, con tu propia trama (no copies ninguna historia).`;
}

/* Detecta bucles de repetición: una frase larga repetida 3+ veces, o demasiadas
   frases duplicadas (el modelo se atasca y repite el mismo intercambio). */
function looksRepetitive(text: string): boolean {
  const sents = (text || "")
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40);
  if (sents.length < 6) return false;
  const seen = new Map<string, number>();
  for (const s of sents) {
    const key = s.toLowerCase().replace(/\s+/g, " ");
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  let maxDup = 0;
  let dupExtra = 0;
  for (const c of seen.values()) { if (c > maxDup) maxDup = c; dupExtra += c - 1; }
  if (maxDup >= 3) return true;                 // misma frase larga 3+ veces = loop
  if (dupExtra / sents.length > 0.18) return true; // muchas frases repetidas
  return false;
}

/* Detecta "fuga de planificación": el modelo DESCRIBE lo que ocurrirá en vez de
   escribir la escena (resumen en futuro, meta-referencias al capítulo). */
const PLANNING_MARKERS: RegExp[] = [
  /\ben (la|una) escena (íntima|de sexo|del cap)/i,
  /\ben este cap[íi]tulo\b/i,
  /\bla escena se (desarrollar[áa]|desarrolla|inicia)\b/i,
  /\b(la pareja|los personajes|los protagonistas)\s+\w*\s*(tendr[áa]n?|se perder[áa]n?|comenzar[áa]n?|sentir[áa]n?)\b/i,
  /\bdel cap[íi]tulo \d+\b/i,
  /\ba medida que se acelera el ritmo\b/i,
  /\bdespués de su encuentro\b/i,
];
function looksLikePlanning(text: string): boolean {
  const t = text || "";
  if (PLANNING_MARKERS.some((re) => re.test(t))) return true;
  // densidad alta de verbos en futuro (poco propios de narración en pasado) sin
  // apenas diálogo => probable resumen/planificación, no prosa narrativa.
  const future = (t.match(/\b\w+rá(n)?\b/gi) || []).length;
  const dashes = (t.match(/[—–]\s|(^|\n)\s*[-–—]\s/g) || []).length;
  if (future >= 6 && dashes < 3) return true;
  return false;
}

/* Mide la longitud media de frase (para validar contra las perillas). */
function avgSentenceWords(text: string): number {
  const parts = (text || "").split(/[.!?…]+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length > 1);
  if (parts.length === 0) return 0;
  const words = parts.reduce((a, s) => a + s.split(/\s+/).length, 0);
  return words / parts.length;
}

/* ----------------------- anti-repetición inter-capítulo y entre libros -----
   Dos males distintos:
   (1) muletillas del MODELO que reaparecen en escenas parecidas de CADA libro
       ("sin previo aviso", "no hubo advertencia"…): lista fija, prohibida
       siempre y detectada para reintentar.
   (2) frases reutilizadas ENTRE capítulos del mismo libro: se extraen n-gramas
       distintivos ya usados y se prohíben en el siguiente capítulo.
--------------------------------------------------------------------------- */
const NARRATIVE_CRUTCHES = [
  "no hubo advertencia", "sin advertencia", "sin previo aviso", "sin aviso previo", "sin aviso",
  "sin mediar palabra", "sin darme tiempo", "de la nada", "sin más",
  "un escalofrío le recorrió", "un escalofrío recorrió", "una corriente le recorrió",
  "se le heló la sangre", "el corazón le dio un vuelco", "el tiempo se detuvo",
  "contuvo el aliento", "se le cortó la respiración",
  "una sonrisa que no llegó a sus ojos", "sus ojos se oscurecieron",
  // familia cardíaca (cliché fisiológico que se repite entre libros)
  "le martilleaba", "me martilleaba", "el corazón le latía con fuerza",
  "el corazón me latía con fuerza", "latía con fuerza contra", "el pulso se le disparó",
  "el pulso se me disparó", "el corazón se le aceleró", "el corazón se me aceleró",
  "contra mis costillas", "contra sus costillas", "contra las costillas", "martilleaba el pecho",
];
const deAccent = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
function crutchHits(text: string): string[] {
  const low = " " + deAccent(text).replace(/\s+/g, " ") + " ";
  return NARRATIVE_CRUTCHES.filter((c) => low.includes(deAccent(c)));
}
const NGRAM_STOP = new Set(
  "que de la el los las un una y o a en con por para su sus se le les lo mi me te tu del al como mas pero no si ya muy es era son fue habia he ha su esta este eso esa ese".split(" ")
);
function shingles(text: string, n: number): Set<string> {
  const w = deAccent(text).match(/[a-z0-9]+/g) || [];
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) {
    const g = w.slice(i, i + n);
    if (g.filter((x) => !NGRAM_STOP.has(x)).length >= 2) out.add(g.join(" ")); // ≥2 palabras de contenido = distintivo
  }
  return out;
}
/* n-gramas distintivos de `text` que YA aparecían en `prev` (capítulos previos). */
function reusedNgrams(text: string, prev: string, n = 5, cap = 12): string[] {
  if (!prev || !prev.trim()) return [];
  const prevSet = shingles(prev, n);
  if (prevSet.size === 0) return [];
  const hits: string[] = [];
  for (const g of shingles(text, n)) {
    if (prevSet.has(g)) { hits.push(g); if (hits.length >= cap) break; }
  }
  return hits;
}

/* Muletilla de ANTÍTESIS NEGATIVA: "no era X, sino Y" / "no era X, era Y" /
   "no ... sino que". El modelo la sobreusa en cada libro; es un patrón sintáctico
   (no una frase fija), así que se detecta por regex, no por la lista de frases. */
const ANTITHESIS_PATTERNS: RegExp[] = [
  /\bno\s+(era|eran|fue|fueron|es|son|se\s+trataba\s+de|habia|tenia|se\s+sentia|parecia)\b[^.;!?\n]{1,80}?\bsino\b/gi,
  /\bno\s+(era|eran|fue|fueron)\b[^.;!?\n]{1,60}?[,.]\s*(era|eran|fue|fueron)\b/gi,
  /\bno\s+[a-z]+\b[^.;!?\n]{1,50}?\bsino\s+que\b/gi,
];
function antithesisHits(text: string): number {
  const low = deAccent(text);
  let n = 0;
  for (const re of ANTITHESIS_PATTERNS) n += (low.match(re) || []).length;
  return n;
}

/* ------------------- registro léxico: ESPAÑOL LATINO -------------------
   Preferencias de vocabulario. Se piden en el prompt Y se aplican como pasada
   determinista al final (garantía por si el modelo se resiste).
   EDITABLE: cambia el término de la derecha por el de tu país. */
const LATIN_LEXICON: Array<[string, string]> = [
  // sustantivos
  ["pollas", "vergas"], ["polla", "verga"],
  // (coño se trata aparte: interjección -> mierda; anatómico -> término neutro)
  // verbo follar -> coger (formas frecuentes; de la más larga a la más corta)
  ["follándome", "cogiéndome"], ["follándote", "cogiéndote"], ["follándola", "cogiéndola"], ["follándolo", "cogiéndolo"],
  ["follármela", "cogérmela"], ["follártela", "cogértela"],
  ["follarme", "cogerme"], ["follarte", "cogerte"], ["follarla", "cogerla"], ["follarlo", "cogerlo"], ["follarnos", "cogernos"],
  ["follando", "cogiendo"], ["follados", "cogidos"], ["folladas", "cogidas"], ["follada", "cogida"], ["follado", "cogido"],
  ["follaron", "cogieron"], ["follaste", "cogiste"], ["follábamos", "cogíamos"], ["follaban", "cogían"], ["follabas", "cogías"], ["follaba", "cogía"],
  ["follamos", "cogemos"], ["folláis", "cogen"], ["follan", "cogen"], ["follas", "coges"], ["follo", "cojo"],
  ["follé", "cogí"], ["folló", "cogió"],
  ["follemos", "cojamos"], ["follen", "cojan"], ["folles", "cojas"], ["folle", "coja"],
  ["follar", "coger"], ["folla", "coge"],
];
const LATIN_RES: Array<{ re: RegExp; to: string }> = LATIN_LEXICON.map(([from, to]) => ({
  re: new RegExp(`(?<![a-z0-9áéíóúñü])${from}(?![a-z0-9áéíóúñü])`, "gi"),
  to,
}));
function applyCase(sample: string, repl: string): string {
  if (sample.length > 1 && sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return repl.toUpperCase();
  if (sample.charAt(0) === sample.charAt(0).toUpperCase()) return repl.charAt(0).toUpperCase() + repl.slice(1);
  return repl;
}
/* Aplica el registro latino al texto final del capítulo. */
function latinize(text: string): string {
  let out = text;
  for (const { re, to } of LATIN_RES) out = out.replace(re, (m) => applyCase(m, to));
  // Interjección "joder"/"coño" -> "mierda". Solo cuando abre la exclamación
  // (¡…!, —… en diálogo, o inicio de línea) y va seguida de puntuación/fin, para
  // NO tocar el verbo ("me vas a joder la vida") ni el uso anatómico ("en su coño.").
  out = out.replace(
    /(^|[\n—¡«"(])(joder|coños?)(?=[.,;:!?…»")—]|$)/gim,
    (_m, pre, w) => pre + applyCase(w, "mierda")
  );
  // "coño"/"coños" ANATÓMICO restante -> término neutro (no un sinónimo vulgar).
  // "sexo" encaja en casi cualquier contexto y respeta el género ("su sexo húmedo").
  out = out.replace(/(?<![a-z0-9áéíóúñü])coños(?![a-z0-9áéíóúñü])/gi, (m) => applyCase(m, "sexos"));
  out = out.replace(/(?<![a-z0-9áéíóúñü])coño(?![a-z0-9áéíóúñü])/gi, (m) => applyCase(m, "sexo"));
  return out;
}

export async function writeChapter(args: {
  bible: StoryBible; index: number; storySoFar?: string; llm?: LLMProvider;
}): Promise<Chapter | null> {
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

  // Variación de intimidad: cada escena sexual con registro/ritmo/foco distinto.
  const intimacyDirective = intimacyVariation(bible, index);
  // Arco de personaje (la Mentira/necesidad) inyectado por fase.
  const characterDir = characterDirective(bible, index, total);

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
    "NUNCA narres el capítulo ni la historia como objeto: prohibido «el capítulo termina/empieza con…», «en esta escena», «en este capítulo» o cualquier comentario sobre la narración; cuenta los hechos directamente. " +
    "PROSA POR SUSTRACCIÓN (muestra, no expliques): no nombres la emoción ni uses verbos filtro (sintió, pensó, supo, notó, se dio cuenta) ni adjetivos abstractos de emoción (tristeza, miedo, rabia); ancla la emoción en el cuerpo (manos, respiración, mirada, garganta) y en el entorno y los objetos. El ritmo de las frases ES la emoción: frases cortas y entrecortadas para la tensión y el miedo; frases largas y fluidas para la melancolía o el deseo. " +
    (bible.atmosphere ? `ATMÓSFERA DEL GÉNERO (cúmplela en cada escena): ${bible.atmosphere} ` : "") +
    `FRASES HECHAS PROHIBIDAS (las repites demasiado entre escenas y libros; no uses ninguna ni una variante cercana, di lo mismo de otra forma): ${NARRATIVE_CRUTCHES.map((c) => `«${c}»`).join("; ")}. ` +
    `EVITA LA MULETILLA DE ANTÍTESIS: no abuses de "no era X, sino Y" ni "no era X, era Y". Úsala como MUCHO una vez en todo el capítulo; el resto del tiempo afirma directamente lo que ocurre. ` +
    `REGISTRO LÉXICO (español LATINO): usa «verga» (no «polla») y «coger» (no «follar»). Para la anatomía femenina usa términos anatómicos o descriptivos según la escena (clítoris, labios, entrada, sexo) en vez de «coño» o sinónimos vulgares como «concha». «Coño» y «joder» como exclamación se dicen «mierda». Prefiere el vocabulario sexual latinoamericano en todo el libro. ` +
    heatDirective(bible.heat);

  const vd = voiceDirective(bible, index);
  const plotLine = plotBeatFor(bible, index, total);

  const baseUser =
    (vd.top ? `${vd.top}\n\n` : "") +
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
    (intimacyDirective ? `${intimacyDirective}\n` : "") +
    (characterDir ? `${characterDir}\n` : "") +
    (plotLine ? `${plotLine}\n` : "") +
    (vd.sample ? `${vd.sample}\n\n` : "");

  const tail =
    `Escribe el CAPÍTULO ${index} de ${total}. Objetivo exclusivo de este capítulo: ${beat}. ` +
    `Empieza justo donde terminó el capítulo anterior y AVANZA la trama con hechos NUEVOS. ` +
    `NO repitas revelaciones, confesiones ni giros que ya ocurrieron en "LO OCURRIDO HASTA AHORA": dalos por sabidos y sigue adelante. ` +
    `Escríbelo como ESCENA completa (acción y diálogo momento a momento), no como resumen. ` +
    `Cierra el capítulo con una frase completa; no lo dejes a medias.`;

  const gen = async (extra: string): Promise<string | null> => {
    const { text } = await model.complete({
      system,
      messages: [{ role: "user", content: baseUser + (extra ? extra + "\n" : "") + tail }],
      maxTokens: 2200,
      temperature: 0.8,
    });
    const body = cleanChapterText(trimToLastSentence(text.trim()));
    if (body && countWords(body) >= 40 && !looksLikeRefusal(body) && !looksLikeGarbage(body) && assessOutput(body).ok) return body;
    return null;
  };

  const REPAIR =
    "IMPORTANTE: escribe la ESCENA en prosa narrativa real, mostrando la acción y el diálogo tal como ocurren. " +
    "NO resumas ni anticipes lo que pasará (nada de \"la escena se desarrollará\", \"la pareja tendrá\", ni referencias a \"este capítulo\"). " +
    "NO repitas frases ni intercambios de diálogo: cada línea debe avanzar la historia.";

  // acepta un candidato solo si no es rechazo/basura/insegura, ni bucle, ni planificación
  const tryOne = async (extra: string): Promise<string | null> => {
    const cand = await gen(extra);
    if (!cand) return null;
    if (looksLikePlanning(cand)) { logIncident("chapter: fuga de planificación, reintento"); return null; }
    if (looksRepetitive(cand)) { logIncident("chapter: repetición en bucle, reintento"); return null; }
    return cand;
  };

  // Un intento completo: sub-intentos + pasos de calidad (registro, anti-resumen,
  // métrica). Devuelve el cuerpo o null.
  const oneRound = async (): Promise<string | null> => {
    let body: string | null = null;
    for (let attempt = 0; attempt < 3 && !body; attempt++) {
      body = await tryOne(attempt === 0 ? "" : REPAIR);
    }
    if (!body) return null;

    // Paso de REGISTRO: si el ADN es duro/explícito pero derivó a romance
    // azucarado, intenta UNA vez endurecerlo. Conserva el original si no mejora.
    if (hardRegister(bible) && looksTooSoft(body)) {
      logIncident("chapter: deriva a registro tierno, reintento de registro");
      const harder = await tryOne(
        "AJUSTE DE REGISTRO: este libro es oscuro/explícito. Endurece el registro: crudo, visceral, sin romance azucarado ni diminutivos cursis (\"nena\", \"mi amor\", \"cariño\"). En la intimidad y la violencia usa vocabulario directo y anatómico. " + REPAIR
      );
      if (harder && !looksTooSoft(harder)) body = harder;
    }

    // Paso ANTI-RESUMEN / ANTI-ANÉMICO: si salió flaco (resumen) o demasiado
    // corto (< ~450 palabras), intenta hasta 2 veces una escena más desarrollada.
    // Conserva siempre la versión más larga.
    if (looksLikeSummary(body) || countWords(body) < 450) {
      for (let a = 0; a < 2 && countWords(body) < 550; a++) {
        logIncident(`chapter: capítulo resumen/anémico (${countWords(body)} palabras), reintento ${a + 1} de escena completa`);
        const fuller = await tryOne(
          "DESARROLLA MÁS: escribe una ESCENA COMPLETA, no un resumen ni un capítulo anémico. Apunta a unas 700-900 palabras. Muestra la acción y el diálogo momento a momento, en varios párrafos, con espacio para el cuerpo, el entorno y la tensión. No narres de lejos ni comprimas los hechos. " + REPAIR
        );
        if (fuller && countWords(fuller) > countWords(body)) body = fuller;
      }
    }

    // Paso POV: si el ADN define una persona narrativa y el capítulo salió en la
    // equivocada (p. ej. tercera cuando el libro es en primera), reintenta. Solo
    // cambia el cuerpo si el reintento SÍ queda en la persona correcta.
    const person = voicePerson(bible);
    if (person && isFirstPerson(body) !== (person === "primera")) {
      logIncident(`chapter: POV incorrecto (se esperaba ${person} persona), reintento`);
      const tense = bible.voice?.knobs?.tense ? `, en tiempo ${bible.voice.knobs.tense}` : "";
      const fixed = await tryOne(
        `AJUSTE DE NARRADOR: escribe TODO el capítulo en ${person === "primera" ? "PRIMERA persona (yo)" : "TERCERA persona (él/ella)"}${tense}, como el resto del libro. No cambies de narrador a mitad. ` + REPAIR
      );
      if (fixed && isFirstPerson(fixed) === (person === "primera")) body = fixed;
    }

    // Validación de perillas: si la longitud media de frase se desvía mucho del
    // objetivo, reintenta una vez.
    const k = bible.voice?.knobs;
    if (k) {
      const mid = (k.sentenceAvg[0] + k.sentenceAvg[1]) / 2;
      const avg = avgSentenceWords(body);
      if (mid > 0 && (avg > mid * 1.7 || avg < mid * 0.6)) {
        const dir = avg > mid ? "MÁS CORTAS" : "MÁS LARGAS";
        const retry = await tryOne(
          `AJUSTE DE VOZ: tus frases deben ser ${dir}. Frase promedio objetivo: ${k.sentenceAvg[0]}-${k.sentenceAvg[1]} palabras. Respétalo sin sacrificar la historia. ${REPAIR}`
        );
        if (retry) body = retry;
      }
    }

    // Paso ANTI-REPETICIÓN: muletillas del modelo (se repiten entre libros) +
    // frases ya usadas en capítulos anteriores del MISMO libro. Reintenta una
    // vez prohibiéndolas explícitamente; conserva el reintento solo si repite MENOS.
    const reused = reusedNgrams(body, soFar, 5, 12);
    const crutches = crutchHits(body);
    const repCount = reused.length + crutches.length;
    const keepReg = hardRegister(bible)
      ? "MANTÉN el mismo nivel explícito y crudo del capítulo; no suavices el sexo ni la violencia al reescribir. "
      : "";
    if (repCount > 0) {
      logIncident(`chapter: repetición (${crutches.length} muletillas, ${reused.length} frases reusadas), reintento`);
      const banList = [...crutches, ...reused].slice(0, 18).map((s) => `«${s}»`).join("; ");
      const fixed = await tryOne(
        `NO REPITAS: estas frases son muletillas tuyas o ya aparecieron en capítulos anteriores del libro. NO las uses ni las parafrasees; expresa lo mismo con otras palabras: ${banList}. ${keepReg}` + REPAIR
      );
      if (fixed && reusedNgrams(fixed, soFar, 5, 12).length + crutchHits(fixed).length < repCount) body = fixed;
    }

    // Paso ANTI-ANTÍTESIS: si el capítulo abusa de "no era X, sino/era Y" (≥2),
    // reintenta pidiendo afirmaciones directas. Conserva solo si baja el conteo.
    const anti = antithesisHits(body);
    if (anti >= 2) {
      logIncident(`chapter: exceso de antítesis "no era...sino/era" (${anti}), reintento`);
      const fixed = await tryOne(
        `REESCRIBE eliminando la muletilla de antítesis negativa: no uses "no era X, sino Y" ni "no era X, era Y" más de UNA vez en todo el capítulo. Afirma las cosas de forma directa (di lo que SÍ es, sin el rodeo del "no era…"). Mantén la historia y los hechos idénticos. ${keepReg}` + REPAIR
      );
      if (fixed && antithesisHits(fixed) < anti) body = fixed;
    }

    // Revalidación FINAL de registro: los reintentos de arriba (repetición y
    // antítesis) regeneran el capítulo y pueden haberlo SUAVIZADO. Si el ADN es
    // duro/explícito y quedó blando, endurece una última vez (prioridad: que no
    // se pierda el registro explícito aunque reaparezca alguna repetición).
    if (hardRegister(bible) && looksTooSoft(body)) {
      logIncident("chapter: re-suavizado tras reintentos, re-endurecimiento final de registro");
      const harder = await tryOne(
        "AJUSTE DE REGISTRO (final): este libro es oscuro/explícito. Devuelve el registro crudo, visceral y anatómico en la intimidad y la violencia, con lenguaje directo y sin romance azucarado ni eufemismos. " + REPAIR
      );
      if (harder && !looksTooSoft(harder)) body = harder;
    }

    // Piso DURO: si tras todos los reintentos el capítulo sigue siendo un
    // resumen crítico (< 300 palabras), lo rechazamos devolviendo null para que
    // el bucle exterior regenere el capítulo entero desde cero (no publicamos un
    // stub anémico como el de ~90 palabras).
    if (countWords(body) < 300) {
      logIncident(`chapter: sigue anémico (${countWords(body)} palabras) tras reintentos; se regenera entero`);
      return "";
    }

    return body;
  };

  // Reintenta el capítulo completo con ESPERA si la cadena se agota (timeout /
  // ratelimit de un modelo grande). Devuelve null solo tras agotar los reintentos;
  // el llamador decide qué hacer (reintentar más tarde), sin publicar un stub.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let round = 0; round < 3; round++) {
    try {
      const body = await oneRound();
      if (body) return { t: chapterTitle(index, beat), b: latinize(body) };
      logIncident("chapter: salida insegura/rechazo/vacía");
    } catch {
      logIncident("chapter: modelo falló, reintento con espera");
    }
    if (round < 2) await sleep(2500 * (round + 1)); // 2.5s, luego 5s
  }
  logIncident("chapter: agotado tras reintentos");
  return null;
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
/* Quita la meta-narración: cuando el modelo narra el capítulo como objeto
   («El capítulo terminó con…», «Así concluye el capítulo», «Fin del capítulo»).
   Si el marco enmarca una acción, conserva la acción; si es puro meta, lo borra. */
function stripMetaNarration(text: string): string {
  const V = "(?:termin[óa]|concluy[óe]|cierra|cerró|comienz[ae]|comenzó|empiez[ae]|empezó|abre|abrió|inici[ae]|inició|finaliz[óa]|acab[óa])";
  const cap = (_m: string, pre: string, ch: string) => `${pre}${ch.toUpperCase()}`;
  let out = text;
  // marco "…el capítulo VERBO con X" -> deja la acción X (inicio de línea y a mitad de párrafo)
  out = out.replace(new RegExp(`(^|\\n)[ \\t]*(?:y\\s+)?(?:as[ií]\\s+(?:es\\s+como\\s+)?)?(?:el|este)\\s+cap[íi]tulo\\s+(?:se\\s+)?${V}\\s+con\\s+(.)`, "gi"), cap);
  out = out.replace(new RegExp(`([.!?]["»)]?\\s+)(?:el|este)\\s+cap[íi]tulo\\s+(?:se\\s+)?${V}\\s+con\\s+(.)`, "gi"), cap);
  // frases puramente meta (sin acción) -> elimínalas (ambos órdenes de palabra)
  const drop = (_m: string, pre: string) => pre.replace(/\n/, "");
  out = out.replace(new RegExp(`(^|\\n)[ \\t]*(?:y\\s+)?(?:as[ií]\\s+(?:es\\s+como\\s+)?)?(?:el|este)\\s+cap[íi]tulo\\s+(?:se\\s+)?(?:${V}|llega\\s+a\\s+su\\s+fin)[^\\n]{0,40}(?=\\n|$)`, "gi"), drop);
  out = out.replace(new RegExp(`(^|\\n)[ \\t]*(?:y\\s+)?(?:as[ií]\\s+)?(?:con\\s+esto\\s+)?${V}\\s+(?:as[ií]\\s+)?(?:el|este)\\s+cap[íi]tulo[^\\n]{0,30}(?=\\n|$)`, "gi"), drop);
  out = out.replace(/(^|\n)[ \t]*fin del cap[íi]tulo[^\n]*(?=\n|$)/gi, drop);
  return out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeDashes(s: string): string {
  return (s || "")
    // caracteres de "caja"/geométricos/bloque (U+2500–U+25FF) y barras/guiones
    // raros que algunos modelos sueltan como guion de diálogo → em dash estándar
    .replace(/[\u2500-\u25FF\u2015\u2E3A\u2E3B\uFE58\uFF0D\u2012\u2013]/g, "—")
    .replace(/—{2,}/g, "—")                                   // colapsa em dashes repetidos
    .replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ""); // quita reemplazo/controles
}

function cleanChapterText(raw: string): string {
  const lines = normalizeDashes(raw || "").replace(/\r/g, "").split("\n");
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
  return stripMetaNarration(stripMarkdown(lines.join("\n")));
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
    `La tensión entre ${a} y ${b} se espesó en el aire, densa como humo. ` +
    `${a} sabía que esa noche marcaría un antes y un después: lo sentía en el pulso acelerado, en la forma en que ${b} la miraba sin decir nada. ` +
    `Ninguno se atrevía a nombrar lo que ardía entre ellos, pero estaba ahí, inevitable. ` +
    `${b} dio un paso hacia ella, y el silencio se volvió una promesa y una amenaza a la vez. ` +
    `Lo que empezó como un pulso de miradas terminó marcándolos a los dos, sin retorno posible.`;
  return { t: chapterTitle(n, beat), b: body };
}

/** Capítulo de respaldo (coherente, sin nota de desarrollador) para el último
    recurso cuando la generación con modelo se agota tras reintentos. */
export function fallbackChapter(bible: StoryBible, n: number): Chapter {
  return deterministicChapter(bible, n);
}

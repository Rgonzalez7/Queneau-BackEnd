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
import { LLMProvider, getProvider, looksLikeRefusal, looksLikeGarbage } from "./provider";
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

/** Sinopsis con modelo (a partir de una biblia ya construida). */
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
  let formatInstr: string;
  if (twoVoices) {
    formatInstr =
      "FORMATO DOS VOCES: dos bloques. Cada bloque empieza con un EPÍTETO en MAYÚSCULAS en su propia línea " +
      "(un apodo evocador para ese personaje, p. ej. «LA REINA DEL HIELO», «EL MONSTRUO», «EL VERDUGO»), y debajo " +
      "de 4 a 7 líneas MUY cortas en primera persona desde su mirada. Primero la voz de ella; una línea en blanco; luego la de él.";
  } else if (third) {
    formatInstr =
      "FORMATO TERCERA PERSONA: de 6 a 9 líneas cortas, tipo contraportada, en tercera persona. " +
      "Nombra a cada protagonista con un epíteto evocador en vez de su nombre.";
  } else {
    formatInstr =
      "FORMATO UNA VOZ: de 7 a 10 líneas MUY cortas y fragmentadas, en primera persona, desde la protagonista. Sin encabezados.";
  }

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
    const { text } = await model.complete({ system, messages: [{ role: "user", content: user }], maxTokens: 360, temperature: 0.85 });
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
    (intimacyDirective ? `${intimacyDirective}\n` : "") +
    (characterDir ? `${characterDir}\n` : "") +
    `Escribe el CAPÍTULO ${index} de ${total}. Objetivo exclusivo de este capítulo: ${beat}. ` +
    `Empieza justo donde terminó el capítulo anterior y avanza la trama. ` +
    `Cierra el capítulo con una frase completa; no lo dejes a medias.`;

  try {
    const { text } = await model.complete({
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: 2200,
      temperature: 0.8,
    });
    const body = cleanChapterText(trimToLastSentence(text.trim()));
    if (body && !looksLikeRefusal(body) && !looksLikeGarbage(body) && assessOutput(body).ok) return { t: chapterTitle(index, beat), b: body };
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
    `${a} sabía que esa noche marcaría un antes y un después. ` +
    `El aire entre ${a} y ${b} estaba cargado de todo lo que ninguno se atrevía a decir. ` +
    `(${beat}.) Tono ${bible.tone}. ` +
    `\n\n[Borrador determinista — el modelo escribirá esta escena completa cuando se enchufe la ruta asíncrona.]`;
  return { t: chapterTitle(n, beat), b: body };
}

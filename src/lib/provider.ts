/* ---------------------------------------------------------------------------
   provider.ts — única puerta al modelo.
   La interfaz es neutral; las implementaciones se intercambian sin tocar
   analyzer/generator/bible. OpenAICompatProvider habla el formato
   /chat/completions, que es el mismo que exponen tanto proveedores
   "uncensored" como un modelo open-weight auto-hospedado (vLLM / Ollama / TGI).

   ChainProvider envuelve VARIOS modelos (mejor → respaldo): si uno falla por
   un problema transitorio reintenta el mismo con backoff; si falla de verdad
   (rechazo, moderación, vacío, o se agotan los reintentos) cae al siguiente.
   Como todo el código pasa por getProvider().complete(), la cadena cubre
   biblia, sinopsis, capítulos, resúmenes y análisis sin tocar esos archivos.

   Recordatorio de arquitectura: la IA hace LENGUAJE, no lógica. Estos métodos
   solo devuelven texto; la estructura del libro la decide el código.
--------------------------------------------------------------------------- */

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type CompleteInput = {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
};

export type CompleteResult = {
  text: string;
  usage?: { in: number; out: number };
};

export interface LLMProvider {
  readonly name: string;
  complete(input: CompleteInput): Promise<CompleteResult>;
}

/* Error con clasificación: `transient` decide reintentar el mismo modelo vs.
   caer al siguiente. */
class ProviderError extends Error {
  transient: boolean;
  status?: number;
  constructor(message: string, transient: boolean, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.transient = transient;
    this.status = status;
  }
}

/* ----------------------------- utilidades ----------------------------- */
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
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
function approxTokens(s: string): number {
  // estimación barata: ~4 chars por token
  return Math.max(1, Math.round(s.length / 4));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* Detección de rechazos del modelo, lo más fina posible SIN descartar prosa
   buena. El reto: en dark romance el diálogo en español dice "—No puedo" o
   "Lo siento" constantemente, así que NO se pueden buscar esas frases en
   cualquier parte. Tres capas con distinta agresividad:

   1) INGLÉS, en cualquier parte: como la historia es en español, una frase de
      rechazo en inglés es casi siempre un rechazo/meta real (anomalía).
   2) ESPAÑOL referido a la TAREA, en cualquier parte: "no puedo continuar con
      esta historia/escena/contenido…" — un rechazo habla de la tarea; el
      diálogo habla de la relación/los sentimientos. Esa diferencia desambigua.
   3) ESPAÑOL meta/negativa al INICIO o FINAL (donde caen los rechazos), nunca
      en el cuerpo (ahí vive el diálogo legítimo). */

// (1) Fórmulas de rechazo en inglés — se buscan en TODO el texto.
const EN_REFUSAL: RegExp[] = [
  /\bi'?m sorry,?\s+but\b/i,
  /\bi apologi[sz]e,?\s+but\b/i,
  /\bi (can'?t|cannot|won'?t|am not able to|will not|am unable to)\s+(write|create|generate|produce|provide|assist|help|comply|fulfill|continue this|continue with|continue the|continue writing|continue generating)\b/i,
  /\bi'?m (unable|not able)\s+to\s+(write|create|generate|assist|help|comply|fulfill|provide|continue)\b/i,
  /\bi (must|have to|will|am going to)\s+(decline|refuse|stop)\b/i,
  /\bas an?\s+(ai|a\.i\.|language model|assistant)\b/i,
  /\bi'?m just an? ai\b/i,
  /\bi cannot (and will not|fulfill|create|provide|generate|continue)\b/i,
  /\bi'?m not (comfortable|willing|going to)\b/i,
  /\b(this|that|your) (request|content|story|prompt) (violates|goes against|breaches)\b/i,
  /\bagainst my (guidelines|programming|principles|policy|policies)\b/i,
  /\b(content|trigger) warning\b/i,
  /\bi can'?t (assist|help) with (that|this)\b/i,
];

// (2) Negativa en español REFERIDA A LA TAREA — se busca en todo el texto.
// Exige un objeto-tarea (historia, escena, contenido…) para no chocar con el
// "no puedo seguir contigo" del diálogo.
const ES_TASK_REFUSAL: RegExp[] = [
  /\bno\s+(puedo|podré|voy a|debo|debería)\s+(continuar|seguir|escribir|generar|crear|completar|redactar|producir|describir|detallar|mostrar|representar|plasmar|narrar)\s+(con\s+)?(est[ae]|esto|el|la|los|las)?\s*(historia|escena|escenas|relato|contenido|capítulo|texto|petición|solicitud|material|acto|actos)\b/i,
  // verbos de escritura/representación en negativo: señal fuerte de meta-rechazo,
  // no aparecen en diálogo/narración romántica. Cubre el doble verbo
  // ("no puedo seguir escribiendo…") y "describir/detallar/mostrar".
  /\bno\s+(puedo|podré|voy a|debo|pienso|podría)\s+(seguir\s+|continuar\s+)?(escrib\w+|gener\w+|redact\w+|narr\w+|produci\w+|complet\w+|describ\w+|detall\w+|represent\w+|plasm\w+)\b/i,
  // negativa + objeto sexual/explícito en cualquier parte (rechazo de contenido):
  // "no puedo describir escenas de contenido sexual", "no puedo generar contenido explícito".
  /\bno\s+(puedo|podré|voy a|debo|pienso|podría|me\s+es\s+posible)\b[^.\n]{0,40}\b(escenas?|contenido|im[aá]genes?|actos?)\b[^.\n]{0,24}\b(sexual\w*|expl[ií]cit\w*|er[oó]tic\w*|porn\w*|gr[aá]fic\w*|de\s+sexo)\b/i,
  /\bno\s+(es|sería|me\s+es)\s+(posible|apropiado|adecuado|ético)\s+(continuar|escribir|generar|crear|seguir|describir|mostrar|detallar|representar)\b/i,
  /\b(no puedo|me niego a)\s+cumplir\s+(con\s+)?(esta|tu|la)\s+(petición|solicitud)\b/i,
  // "no puedo cumplir con los siguientes requerimientos/requisitos" (volcado de política)
  /\bno\s+(puedo|podr[ée]|podría|pienso)\s+cumplir\s+con\s+(los\s+siguientes\s+)?(requerimientos|requisitos|peticiones|solicitudes)\b/i,
  // lista de política (acción + objeto de menores/incesto): es un rechazo, nunca prosa
  /\b(describir|generar|crear|enviar|compartir|fomentar|promover|justificar|escribir|producir)\b[^.\n]{0,40}\b(menores\s+de\s+edad|material\s+sexual\s+de\s+menores|explotaci[oó]n\s+de\s+menores|incesto)\b/i,
  // inability en otros tiempos ("no he podido generar", "no logré producir…")
  // acotada a objeto META (contenido/petición/…) para no marcar prosa.
  /\bno\s+(puedo|pude|podr[ée]|podría|he\s+podido|logr[éo]|consigo|fui\s+capaz|he\s+sido\s+capaz)\s+(de\s+)?(gener\w+|escrib\w+|produci\w+|redact\w+|crear|complet\w+|cumplir|proporcionar|continu\w+|ofrecer)\b[^.\n]{0,30}\b(contenido|petici[oó]n|solicitud|material|lo\s+que\s+(pides|solicitas|me\s+pides|me\s+solicitas))\b/i,
  // frases de política/restricción de contenido (meta; no salen en prosa)
  /\b(restricciones|pol[ií]ticas|directrices|normas|l[ií]mites)\s+de\s+contenido\b/i,
  /\bnaturaleza\s+(oscura|expl[ií]cita|gr[aá]fica|sexual)\s+(de\s+(la|el|esta|este)\s+(trama|historia|narrativa|petici[oó]n|escena|solicitud)|del\s+contenido)\b/i,
  // meta-acuse del prompt ("has proporcionado un resumen/directrices…")
  /\b(has|me\s+has)\s+(proporcionado|dado|compartido|enviado|facilitado)\b[^.\n]{0,70}\b(resumen|directrices|instrucciones|indicaciones|petici[oó]n|descripci[oó]n)\b/i,
];

// (3) Meta / negativa en español que solo cuentan al INICIO o FINAL del texto.
const ES_EDGE_REFUSAL: RegExp[] = [
  /^\s*(lo siento|disculpa|perdón|lamento),?\s+(pero\s+)?no\s+(puedo|podré|voy a|debo)\b/im,
  /^\s*(como|soy)\s+(una?\s+)?(ia|inteligencia artificial|modelo de lenguaje|asistente)\b/im,
  /^\s*no\s+(es|sería)\s+(apropiado|ético|adecuado)\b/im,
  /^\s*(nota|aviso|advertencia|descargo)\s*[:\-—]/im,
  /^\s*no\s+voy\s+a\s+(escribir|continuar|seguir|generar|crear|ayudar)\b/im,
  // meta-acuse / asentimiento de chat en vez de prosa ("Sí, de acuerdo, puedo ayudarte a escribir ese capítulo")
  /^\s*(s[íi]|claro|por supuesto|desde luego|de acuerdo|entendido|perfecto)[,.: ]+[^.\n]{0,45}\b(puedo|podr[ée]|te\s+ayudo|con\s+gusto|encantad[oa])\b[^.\n]{0,45}\b(ayudar(te)?|escrib\w+|redact\w+|crear|gener\w+|continu\w+)\b/im,
  // preámbulo del modelo ("Aquí tienes el capítulo:")
  /^\s*(aqu[ií]\s+(tienes|est[áa]|va)\s+(el|tu|la)\s+(cap[ií]tulo|escena|historia|continuaci[oó]n))/im,
];

export function looksLikeRefusal(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // (1) y (2): en cualquier parte (formas que no aparecen en narración legítima).
  if (EN_REFUSAL.some((re) => re.test(t))) return true;
  if (ES_TASK_REFUSAL.some((re) => re.test(t))) return true;
  // (3): solo en los bordes, donde el modelo coloca disculpas/avisos; el cuerpo
  // se deja en paz para no marcar el diálogo ("—No puedo…", "Lo siento…").
  const head = t.slice(0, 320);
  const tail = t.slice(-320);
  return ES_EDGE_REFUSAL.some((re) => re.test(head) || re.test(tail));
}

/* Detecta salida ININTELIGIBLE (galimatías): tokens rotos, fugas de inglés en
   MAYÚSCULAS, palabras imposibles en español, glitches de puntuación. Pasa el
   texto a la SIGUIENTE opción del chain en vez de mostrar word-salad. Calibrado
   para NO marcar prosa legítima (gritos en mayúscula, carteles, nombres rusos). */
export function looksLikeGarbage(textRaw: string): boolean {
  const text = (textRaw || "").trim();
  if (text.length < 60) return false;
  const words = text.match(/[\p{L}]+/gu) || [];
  if (words.length < 15) return false;
  const VOW = /[aeiouáéíóúüy]/i;
  let noVowel = 0, overlong = 0, consoRun = 0;
  for (const w of words) {
    if (w.length >= 4 && !VOW.test(w)) noVowel++;
    if (w.length > 20) overlong++;
    if (/[bcdfghjklmnpqrstvwxyzñ]{5,}/i.test(w)) consoRun++;
  }
  // señales DURAS: varias palabras sin vocal, clusters imposibles o palabras larguísimas
  if (noVowel >= 2 || consoRun >= 1 || overlong >= 1) return true;

  let score = 0;
  // MAYÚSCULAS latinas embebidas (fuga de tokens, p.ej. "ter LANGUAGE")
  if (/[a-záéíóúñ,;]\s+[A-ZÁÉÍÓÚÑ]{4,}\b/.test(text)) score += 2;
  // letras sueltas (consonante aislada mid-frase, p.ej. "da c—")
  if ((text.match(/(^|\s)[bcdfghjklmnpqrstvwxz](\s|—|-|\.)/gi) || []).length >= 1) score += 1;
  // espacio antes de punto/coma (glitch de formato), repetido
  if ((text.match(/\s+[.,]/g) || []).length >= 2) score += 1;
  // palabra pegada a "(" (falta de espacio)
  if (/[a-záéíóúñ]\(/i.test(text)) score += 1;
  // arranques de palabra imposibles en español
  if ((text.match(/\b(ns|tz|gt|hs|sd|fk|mn|tl|zr|dn|kt)[a-záéíóú]/gi) || []).length >= 1) score += 1;
  return score >= 3;
}

/* ----------------------------- MockProvider -----------------------------
   Determinista: misma entrada -> misma salida. No usa red, no gasta nada.
   Sirve para probar el pipeline completo (opening -> bible -> capítulo 1)
   sin contratar ningún modelo. Devuelve texto de relleno coherente.
------------------------------------------------------------------------- */
export class MockProvider implements LLMProvider {
  readonly name = "mock";

  async complete(input: CompleteInput): Promise<CompleteResult> {
    const seedStr =
      input.system + "\n" + input.messages.map((m) => m.role + ":" + m.content).join("\n");
    const rnd = mulberry32(hashStr(seedStr));

    const openings = [
      "La lluvia golpeaba los ventanales como si quisiera entrar.",
      "Nadie en aquel salón sabía lo que estaba a punto de perder.",
      "El silencio entre ellos pesaba más que cualquier palabra.",
      "Había aprendido a no confiar, y aun así ahí estaba.",
    ];
    const middles = [
      "Lo miró una vez más, midiendo la distancia entre el deseo y la prudencia.",
      "Cada decisión la acercaba a un borde que no terminaba de ver.",
      "El pasado tenía la costumbre de cobrar sus deudas en el peor momento.",
      "Algo en su voz prometía ruina, y aun así sonaba a refugio.",
    ];
    const ends = [
      "Cuando por fin habló, ya era demasiado tarde para retroceder.",
      "El trato estaba hecho, y los dos lo sabían.",
      "Esa noche cambió las reglas que ninguno se atrevía a nombrar.",
      "Lo que vino después no tenía vuelta atrás.",
    ];
    const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];

    const target = input.maxTokens ?? 400;
    const paras: string[] = [];
    let used = 0;
    while (used < target && paras.length < 12) {
      const p = `${pick(openings)} ${pick(middles)} ${pick(ends)}`;
      paras.push(p);
      used += approxTokens(p);
    }
    const text = `[MOCK:${this.name}] ` + paras.join("\n\n");

    const inTok = approxTokens(seedStr);
    return { text, usage: { in: inTok, out: approxTokens(text) } };
  }
}

/* ------------------------- OpenAICompatProvider -------------------------
   Habla /chat/completions. Funciona con cualquier endpoint compatible:
   - proveedor hosted (uncensored) -> baseURL + apiKey del proveedor
   - modelo propio con vLLM/Ollama/TGI -> baseURL local (apiKey puede ir vacío)
   Config por entorno:
     GENERATOR_BASE_URL   ej. https://api.proveedor.com/v1
     GENERATOR_API_KEY    clave (opcional para self-host)
     GENERATOR_MODEL      nombre del modelo (un solo modelo / piso de la cadena)
------------------------------------------------------------------------- */
export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  private baseURL: string;
  private apiKey: string;
  private model: string;

  constructor(opts?: { baseURL?: string; apiKey?: string; model?: string }) {
    // Default: OpenRouter (API OpenAI-compatible). Para self-host, cambia la baseURL.
    this.baseURL = (opts?.baseURL ?? process.env.GENERATOR_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.apiKey = opts?.apiKey ?? process.env.GENERATOR_API_KEY ?? "";
    // Modelo por defecto: Cydonia 24B v4.1 (escritura creativa sin censura, 131K ctx).
    this.model = opts?.model ?? process.env.GENERATOR_MODEL ?? "thedrummer/cydonia-24b-v4.1";
    this.name = `openai-compat:${this.model}`;
    if (!this.baseURL) throw new Error("Falta GENERATOR_BASE_URL");
    if (!this.model) throw new Error("Falta GENERATOR_MODEL");
    if (this.baseURL.includes("openrouter.ai") && !this.apiKey) {
      throw new Error("Falta GENERATOR_API_KEY (OpenRouter requiere clave)");
    }
  }

  async complete(input: CompleteInput): Promise<CompleteResult> {
    const reqTemp = input.temperature ?? 0.9;
    const capTemp = Number(process.env.GENERATOR_TEMPERATURE);
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: input.system },
        ...input.messages,
      ],
      max_tokens: input.maxTokens ?? 1024,
      temperature: isFinite(capTemp) ? Math.min(reqTemp, capTemp) : reqTemp,
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    // OpenRouter recomienda (opcional) identificar la app:
    if (process.env.GENERATOR_REFERER) headers["HTTP-Referer"] = process.env.GENERATOR_REFERER;
    if (process.env.GENERATOR_TITLE) headers["X-Title"] = process.env.GENERATOR_TITLE;

    const url = `${this.baseURL}/chat/completions`;
    const ms = Number(process.env.GENERATOR_TIMEOUT_MS) || 90000; // modelos grandes son lentos
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const started = Date.now();
    console.log(`[llm] -> ${this.model} (${url})`);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      const msg = (e as Error)?.name === "AbortError" ? `timeout tras ${ms}ms` : (e as Error)?.message;
      console.warn(`[llm] x error de red: ${msg}`);
      throw new ProviderError(`red: ${msg}`, true); // red/timeout = transitorio
    } finally {
      clearTimeout(timer);
    }

    console.log(`[llm] <- ${res.status} en ${Date.now() - started}ms`);

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[llm] x ${res.status}: ${detail.slice(0, 300)}`);
      // 429 y 5xx son transitorios (reintentables); el resto, no.
      const transient = res.status === 429 || res.status >= 500;
      throw new ProviderError(`${res.status}: ${detail.slice(0, 200)}`, transient, res.status);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const choice = data.choices?.[0];
    // Moderación del proveedor: no tiene sentido reintentar el mismo modelo.
    if (choice?.finish_reason === "content_filter") {
      throw new ProviderError("bloqueado por moderación del proveedor", false);
    }

    const text = choice?.message?.content ?? "";
    const usage = data.usage
      ? { in: data.usage.prompt_tokens ?? 0, out: data.usage.completion_tokens ?? 0 }
      : undefined;

    return { text, usage };
  }
}

/* ------------------------------ ChainProvider ------------------------------
   Recorre la cadena de modelos (mejor → respaldo). Por cada modelo reintenta
   ante fallos transitorios con backoff; ante rechazo/moderación/vacío salta al
   siguiente. Solo lanza si TODOS fallan (entonces generator/bible aplican su
   propio fallback determinista como última red).
--------------------------------------------------------------------------- */
const MAX_RETRIES_PER_MODEL = 2; // reintentos extra ante fallos transitorios

/** Lista de modelos de la cadena (mejor → piso). Configurable por entorno:
 *  - GENERATOR_MODELS = "modelA,modelB,modelC"  (lista explícita, gana sobre todo)
 *  - o por piezas: GENERATOR_MODEL_PRIMARY / _SECONDARY / GENERATOR_MODEL (piso)
 *  Para forzar UN solo modelo: GENERATOR_MODELS=ese-modelo (cadena de 1).
 *  Slugs por defecto elegidos por calidad de prosa + permisividad + rendimiento;
 *  confírmalos en openrouter.ai (cambian con el tiempo). */
export function modelChain(): string[] {
  const csv = process.env.GENERATOR_MODELS?.trim();
  if (csv) {
    const list = csv.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) return Array.from(new Set(list));
  }
  const floor = process.env.GENERATOR_MODEL || "thedrummer/cydonia-24b-v4.1"; // piso (rápido/barato)
  const chain = [
    process.env.GENERATOR_MODEL_PRIMARY || "sao10k/l3.3-euryale-70b", // calidad de prosa (70B)
    process.env.GENERATOR_MODEL_SECONDARY || "deepseek/deepseek-chat", // coherente, largo, permisivo
    floor,
  ];
  return Array.from(new Set(chain)); // dedup por si el piso coincide con otro
}

export class ChainProvider implements LLMProvider {
  readonly name = "chain";
  private links: { model: string; provider: OpenAICompatProvider }[];

  constructor(models?: string[]) {
    const list = models ?? modelChain();
    this.links = list.map((model) => ({ model, provider: new OpenAICompatProvider({ model }) }));
    console.log(`[provider] cadena: ${list.join(" → ")}`);
  }

  async complete(input: CompleteInput): Promise<CompleteResult> {
    let lastMsg = "desconocido";

    for (let i = 0; i < this.links.length; i++) {
      const { model, provider } = this.links[i];
      for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
        try {
          const out = await provider.complete(input);
          const text = (out.text || "").trim();
          // Vacío o rechazo = fallo "real": salta al siguiente modelo (no reintenta).
          if (!text) throw new ProviderError("respuesta vacía", false);
          if (looksLikeRefusal(text)) throw new ProviderError("parece un rechazo del modelo", false);
          if (looksLikeGarbage(text)) throw new ProviderError("salida ininteligible (galimatías)", false);
          if (i > 0) console.warn(`[chain] generado con respaldo "${model}" (los anteriores no sirvieron)`);
          return out;
        } catch (e) {
          const err = e as ProviderError;
          lastMsg = err?.message || String(e);
          const transient = err instanceof ProviderError && err.transient;
          if (transient && attempt < MAX_RETRIES_PER_MODEL) {
            await sleep(400 * Math.pow(2, attempt)); // backoff 400ms, 800ms
            continue;
          }
          console.warn(`[chain] "${model}" falló (${lastMsg}); cayendo al siguiente`);
          break; // siguiente modelo
        }
      }
    }
    // Todos fallaron: generator.ts / bible.ts caen a su texto determinista.
    throw new Error(`cadena agotada: ningún modelo produjo texto. Último: ${lastMsg}`);
  }
}

/* ------------------------------- factory -------------------------------
   getProvider() elige automáticamente:
     - GENERATOR_PROVIDER = "mock" | "openai"  fuerza uno u otro.
     - si no se fuerza: hay GENERATOR_API_KEY -> cadena de modelos; si no -> mock.
------------------------------------------------------------------------- */
let _cached: LLMProvider | null = null;
export function getProvider(): LLMProvider {
  if (_cached) return _cached;
  const forced = (process.env.GENERATOR_PROVIDER ?? "").toLowerCase();
  let useModel: boolean;
  if (forced === "openai") useModel = true;
  else if (forced === "mock") useModel = false;
  else useModel = !!process.env.GENERATOR_API_KEY; // auto: con clave usa el modelo
  _cached = useModel ? new ChainProvider() : new MockProvider();
  console.log(`[provider] activo: ${_cached.name}`);
  return _cached;
}

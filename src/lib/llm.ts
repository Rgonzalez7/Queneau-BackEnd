import { HttpError } from "./constants";

/**
 * Cadena de modelos para la generación de historias.
 *
 * Estrategia: intenta del mejor al de respaldo. Si un modelo falla por un
 * problema transitorio (timeout, 429, 5xx) se reintenta el MISMO modelo con
 * backoff; si falla de verdad (rechazo, moderación, respuesta vacía, o se
 * agotan los reintentos) cae al siguiente. Así el usuario casi siempre obtiene
 * un capítulo, sin sacrificar prosa por un hipo de red.
 *
 * El fallback es por CAPÍTULO (unidad atómica): si un capítulo falla a medias,
 * se descarta el parcial y se regenera entero con el siguiente modelo. Los
 * capítulos completos anteriores ya están guardados y no se tocan.
 */

// Slugs por defecto, elegidos por calidad de prosa + permisividad + rendimiento.
// Confírmalos en openrouter.ai (los slugs y la disponibilidad cambian) y/o
// sobreescríbelos por variable de entorno sin tocar código.
export const MODEL_CHAIN: string[] = [
  // 1) Principal — calidad de prosa (finetune creativo 70B, permisivo)
  process.env.MODEL_PRIMARY || "sao10k/l3.3-euryale-70b",
  // 2) Secundario — coherente en arcos largos, contexto amplio, barato y permisivo;
  //    falla distinto a los finetunes, ideal como respaldo real
  process.env.MODEL_SECONDARY || "deepseek/deepseek-chat",
  // 3) Piso — rápido y barato (el que ya usas), último recurso para garantizar salida
  process.env.MODEL_FALLBACK || "thedrummer/cydonia-24b-v4.1",
];

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_RETRIES_PER_MODEL = 2; // reintentos ante fallos transitorios (además del intento inicial)
const REQUEST_TIMEOUT_MS = 90_000; // los modelos grandes son lentos: 90s por intento

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type GenResult = { text: string; model: string };
export type GenOpts = {
  temperature?: number;
  maxTokens?: number;
  /** Si el texto sale más corto que esto, se trata como fallo y se pasa al siguiente modelo. */
  minChars?: number;
  /** Parámetros extra para el cuerpo de OpenRouter (top_p, frequency_penalty, etc.). */
  extra?: Record<string, unknown>;
};

// Error interno con marca de "reintentable" para decidir reintento vs. caída.
class LlmError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "LlmError";
    this.retryable = retryable;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Patrones típicos de rechazo (en inglés y español). Solo se revisan al inicio
// del texto para no marcar por error un capítulo que mencione estas frases.
const REFUSAL_PATTERNS: RegExp[] = [
  /^\s*i('m| am)\s+sorry\b/i,
  /^\s*i can('|no)?t\b/i,
  /^\s*i cannot\b/i,
  /^\s*i'?m not able\b/i,
  /^\s*i won'?t\b/i,
  /^\s*i must (decline|refuse)\b/i,
  /^\s*as an ai\b/i,
  /\bi'?m unable to (assist|help|continue|write)\b/i,
  /^\s*lo siento\b/i,
  /^\s*no puedo\b/i,
  /^\s*no voy a\b/i,
];

function looksLikeRefusal(text: string): boolean {
  const head = text.slice(0, 200);
  return REFUSAL_PATTERNS.some((re) => re.test(head));
}

function isAbort(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "AbortError";
}

// Un solo intento contra un modelo concreto. Lanza LlmError clasificado.
async function callModelOnce(model: string, messages: ChatMessage[], opts: GenOpts): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new HttpError(500, "Falta OPENROUTER_API_KEY en el entorno.");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // Recomendados por OpenRouter para identificar tu app:
        "HTTP-Referer": process.env.PUBLIC_URL || "https://queneau.ai",
        "X-Title": "Queneau",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.9,
        max_tokens: opts.maxTokens ?? 2200,
        ...(opts.extra || {}),
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 429 y 5xx son transitorios (reintentables); el resto, no.
      const retryable = res.status === 429 || res.status >= 500;
      throw new LlmError(`HTTP ${res.status}: ${body.slice(0, 200)}`, retryable);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const choice = data?.choices?.[0];
    const text = (choice?.message?.content || "").trim();

    if (choice?.finish_reason === "content_filter") {
      throw new LlmError("bloqueado por moderación del proveedor", false);
    }
    if (!text) {
      throw new LlmError("respuesta vacía", false);
    }
    if (opts.minChars && text.length < opts.minChars) {
      throw new LlmError(`texto demasiado corto (${text.length} < ${opts.minChars})`, false);
    }
    if (looksLikeRefusal(text)) {
      throw new LlmError("parece un rechazo del modelo", false);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Genera texto recorriendo la cadena de modelos con reintentos y fallback.
 * Devuelve el texto y qué modelo lo produjo (útil para loguear/depurar).
 * Lanza HttpError(502) solo si los tres modelos fallan.
 */
export async function generateText(messages: ChatMessage[], opts: GenOpts = {}): Promise<GenResult> {
  let lastMsg = "desconocido";

  for (const model of MODEL_CHAIN) {
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
      try {
        const text = await callModelOnce(model, messages, opts);
        if (model !== MODEL_CHAIN[0]) {
          console.warn(`[llm] generado con respaldo "${model}" (el principal no estuvo disponible)`);
        }
        return { text, model };
      } catch (e) {
        const err = e as LlmError;
        lastMsg = err?.message || String(e);
        const transient = isAbort(e) || (err instanceof LlmError && err.retryable);

        // Transitorio y aún quedan reintentos en este modelo → espera y reintenta.
        if (transient && attempt < MAX_RETRIES_PER_MODEL) {
          await sleep(400 * Math.pow(2, attempt)); // 400ms, 800ms
          continue;
        }
        // Rechazo/moderación/no-reintentable, o se agotaron reintentos → siguiente modelo.
        console.warn(`[llm] "${model}" falló (${lastMsg}); cayendo al siguiente`);
        break;
      }
    }
  }

  throw new HttpError(502, `No se pudo generar el texto con ningún modelo. Último error: ${lastMsg}`);
}

/* ---------------------------------------------------------------------------
   provider.ts — única puerta al modelo.
   La interfaz es neutral; las implementaciones se intercambian sin tocar
   analyzer/generator. OpenAICompatProvider habla el formato /chat/completions,
   que es el mismo que exponen tanto proveedores "uncensored" como un modelo
   open-weight auto-hospedado (vLLM / Ollama / TGI). Una clase cubre ambas rutas.

   Recordatorio de arquitectura: la IA hace LENGUAJE, no lógica. Estos métodos
   solo devuelven texto; la estructura del libro la decide el código (analyzer).
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
     GENERATOR_MODEL      nombre del modelo
------------------------------------------------------------------------- */
export class OpenAICompatProvider implements LLMProvider {
  readonly name = "openai-compat";
  private baseURL: string;
  private apiKey: string;
  private model: string;

  constructor(opts?: { baseURL?: string; apiKey?: string; model?: string }) {
    // Default: OpenRouter (API OpenAI-compatible). Para self-host, cambia la baseURL.
    this.baseURL = (opts?.baseURL ?? process.env.GENERATOR_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.apiKey = opts?.apiKey ?? process.env.GENERATOR_API_KEY ?? "";
    // Modelo por defecto: Cydonia 24B v4.1 (escritura creativa sin censura, 131K ctx).
    this.model = opts?.model ?? process.env.GENERATOR_MODEL ?? "thedrummer/cydonia-24b-v4.1";
    if (!this.baseURL) throw new Error("Falta GENERATOR_BASE_URL");
    if (!this.model) throw new Error("Falta GENERATOR_MODEL");
    if (this.baseURL.includes("openrouter.ai") && !this.apiKey) {
      throw new Error("Falta GENERATOR_API_KEY (OpenRouter requiere clave)");
    }
  }

  async complete(input: CompleteInput): Promise<CompleteResult> {
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: input.system },
        ...input.messages,
      ],
      max_tokens: input.maxTokens ?? 1024,
      temperature: input.temperature ?? 0.9,
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    // OpenRouter recomienda (opcional) identificar la app:
    if (process.env.GENERATOR_REFERER) headers["HTTP-Referer"] = process.env.GENERATOR_REFERER;
    if (process.env.GENERATOR_TITLE) headers["X-Title"] = process.env.GENERATOR_TITLE;

    const url = `${this.baseURL}/chat/completions`;
    const ms = Number(process.env.GENERATOR_TIMEOUT_MS) || 60000;
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
      throw new Error(`LLM red: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    console.log(`[llm] <- ${res.status} en ${Date.now() - started}ms`);

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[llm] x ${res.status}: ${detail.slice(0, 300)}`);
      throw new Error(`LLM ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = data.choices?.[0]?.message?.content ?? "";
    const usage = data.usage
      ? { in: data.usage.prompt_tokens ?? 0, out: data.usage.completion_tokens ?? 0 }
      : undefined;

    return { text, usage };
  }
}

/* ------------------------------- factory -------------------------------
   getProvider() elige automáticamente:
     - GENERATOR_PROVIDER = "mock" | "openai"  fuerza uno u otro.
     - si no se fuerza: hay GENERATOR_API_KEY -> modelo real; si no -> mock.
------------------------------------------------------------------------- */
let _cached: LLMProvider | null = null;
export function getProvider(): LLMProvider {
  if (_cached) return _cached;
  const forced = (process.env.GENERATOR_PROVIDER ?? "").toLowerCase();
  let useModel: boolean;
  if (forced === "openai") useModel = true;
  else if (forced === "mock") useModel = false;
  else useModel = !!process.env.GENERATOR_API_KEY; // auto: con clave usa el modelo
  _cached = useModel ? new OpenAICompatProvider() : new MockProvider();
  console.log(`[provider] activo: ${_cached.name}`);
  return _cached;
}

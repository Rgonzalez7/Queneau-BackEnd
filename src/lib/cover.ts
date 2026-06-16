/* ============================================================
   cover.ts — portada IA (texto→imagen) con fal.ai + FLUX.

   El modelo genera SOLO el arte (atmósfera + emblema, sin texto).
   El título lo dibuja la tarjeta en HTML encima, así que la portada
   queda profesional sin texto basura del modelo.

   - Se genera en SEGUNDO PLANO al crear/leer el libro y se PERSISTE
     en disco (COVERS_DIR/<id>.png), servida como /covers/<id>.png.
   - Una sola vez por libro; si ya hay coverImage, no se regenera.
   - Si está deshabilitado (sin key) o falla, no pasa nada: el front
     cae al emblema vectorial.
   - El trabajo lento (la llamada al modelo) ocurre FUERA del lock de
     la DB; solo se toma el lock para leer la biblia y para guardar.

   Config por entorno (.env del backend):
     COVER_PROVIDER=fal          # "fal" | "none" (none = desactivado)
     COVER_API_KEY=...           # tu fal.ai key (o FAL_KEY)
     COVER_MODEL=fal-ai/flux/dev # fal-ai/flux/dev | fal-ai/flux-pro/v1.1 | fal-ai/flux/schnell
     COVER_BASE_URL=https://fal.run
     COVER_TIMEOUT_MS=90000
     COVERS_DIR=<ruta>           # por defecto <cwd>/public/covers
   ============================================================ */
import { promises as fs } from "fs";
import path from "path";
import type { StoryBible } from "./types";
import { withDB } from "./db";

const PROVIDER = (process.env.COVER_PROVIDER || "none").toLowerCase();
const API_KEY = process.env.COVER_API_KEY || process.env.FAL_KEY || "";
const MODEL = process.env.COVER_MODEL || "fal-ai/flux/dev";
const BASE = (process.env.COVER_BASE_URL || "https://fal.run").replace(/\/$/, "");
const TIMEOUT = Number(process.env.COVER_TIMEOUT_MS || 90000);

export const COVERS_DIR = process.env.COVERS_DIR || path.resolve(process.cwd(), "public", "covers");

const _covering = new Set<string>();

export function coverEnabled(): boolean {
  return PROVIDER === "fal" && !!API_KEY;
}

/* ---- prompt armado desde la biblia (emblema + paleta + ambiente) ---- */
/* ---- variedad determinista por libro (semilla = id) ---- */
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(arr: T[], rnd: () => number): T => arr[Math.floor(rnd() * arr.length)];

/* Repertorio ENORME de emblemas dark romance, agrupado por FAMILIAS.
   Genérico (no atado a la historia) y sin personas. La selección elige primero
   una familia al azar y luego un motivo dentro: así ningún objeto (ni la
   calavera) domina y las portadas se sienten variadas. */
const MOTIF_FAMILIES: string[][] = [
  // armas de fuego
  [
    "an ornate antique revolver resting on red roses",
    "a pair of crossed pistols over black roses",
    "a vintage pistol and a single red rose on dark velvet",
    "a golden revolver wreathed in thorny vines",
  ],
  // armas blancas
  [
    "an antique dagger entwined with thorny red roses",
    "twin crossed daggers over a blooming red rose",
    "a switchblade and scattered rose petals on black marble",
    "an ornate sword wrapped in thorny vines",
    "a straight razor resting on crimson silk and petals",
  ],
  // serpientes
  [
    "a black serpent coiled around a single red rose",
    "two serpents entwined around an ornate dagger",
    "a venomous snake wrapped around an hourglass",
    "a coiled cobra rising over black roses",
  ],
  // arañas y telarañas
  [
    "a black widow spider on a dewy spiderweb with a red rose",
    "an ornate spiderweb glistening over black roses",
    "a black spider crawling across crimson silk",
    "a delicate web spun between thorny rose stems",
  ],
  // calaveras humanas
  [
    "an ornate human skull wrapped in red roses and thorns",
    "a gilded human skull crowned with black roses",
    "a human skull and a dagger crossed over deep red roses",
    "a single red rose growing through the jaw of a skull",
  ],
  // calaveras de animales
  [
    "a ram skull with long curved horns among black roses",
    "a bull skull entwined with thorny vines",
    "a small bird skull beside a single red rose",
    "a stag skull with antlers wrapped in red roses",
  ],
  // máscaras y antifaces
  [
    "a venetian masquerade mask among black roses",
    "an ornate plague-doctor mask on dark velvet",
    "a black domino mask and red rose petals",
    "a gilded carnival mask wreathed in thorns",
  ],
  // prendas y telas (como objetos, no usadas por nadie)
  [
    "a black lace corset laid on dark silk",
    "fishnet stockings draped over an antique chair with rose petals",
    "a single stiletto heel beside scattered red roses",
    "tall black leather boots and a riding crop on velvet",
    "a silk necktie coiled around a red rose",
    "long black satin gloves and a red rose on velvet",
    "a black velvet choker with a ruby pendant on silk",
    "folds of dark red drapery around a single rose",
  ],
  // ataduras
  [
    "a pair of antique handcuffs over red roses",
    "heavy iron chains wrapped around a red rose",
    "a padlock and key on a chain over black roses",
    "a leather collar and chain on dark velvet",
    "rope coiled around thorny rose stems",
  ],
  // realeza y poder
  [
    "an ornate golden crown over crossed daggers",
    "a black king and queen chess piece beside a red rose",
    "a fallen crown among scattered rose petals",
    "a signet ring resting on spilled red wine and petals",
    "a toppled king chess piece over black roses",
  ],
  // alas y aves
  [
    "a pair of black feathered wings around a red rose",
    "a single black raven perched among thorny roses",
    "scattered black feathers over crimson silk",
    "a crow with spread black wings over roses",
    "a moth with intricate wings over a single red rose",
  ],
  // humo y atmósfera
  [
    "swirling dark smoke around a single red rose",
    "wisps of smoke rising from a snuffed candle and roses",
    "incense smoke curling around black roses",
  ],
  // sangre y vasijas
  [
    "crimson blood splatter across black roses",
    "a gothic chalice spilling blood over rose petals",
    "drops of blood falling onto a white rose",
    "a tipped wine glass spilling red across petals",
  ],
  // objetos góticos
  [
    "an antique hourglass wrapped in thorns and roses",
    "an ornate pocket watch and a red rose on velvet",
    "a candelabra with dripping wax among red roses",
    "a shattered mirror reflecting a single red rose",
    "a deck of black playing cards fanned over roses",
    "an ornate iron key on dark velvet with rose petals",
    "a cracked porcelain teacup spilling rose petals",
  ],
  // botánico
  [
    "a single dark red rose with sharp thorns",
    "a bouquet of black roses bound in ribbon",
    "thorny vines wrapped around a blooming red rose",
    "deadly nightshade and red roses on dark velvet",
    "black poppies and thorns on crimson silk",
  ],
];

const PALETTES = [
  "near-black background with deep blood red and charcoal, cold silver accents",
  "deep black and oxblood red with antique gold accents",
  "dark plum and black with antique gold accents",
  "deep burgundy and black with warm gold accents",
  "charcoal black and emerald green with tarnished gold accents",
  "black and deep wine red with rose-gold accents",
  "midnight blue-black and crimson with pale silver accents",
];
const LIGHTING = [
  "dramatic cinematic chiaroscuro lighting",
  "moody volumetric light with deep shadows",
  "soft candlelit glow and deep shadows",
  "high-contrast rim lighting on a dark background",
  "atmospheric foggy backlight with godrays",
];
const COMPOSITION = [
  "symmetrical centered emblem composition",
  "ornate centered heraldic crest composition",
  "elegant centered still-life composition",
];

export function buildCoverPrompt(
  bible: StoryBible,
  seedStr: string,
  avoid: number[] = []
): { prompt: string; negative: string; seed: number; family: number } {
  const rnd = mulberry32(hashStr(seedStr || "queneau"));
  // elige una familia evitando las recién usadas (si es posible)
  let fi = Math.floor(rnd() * MOTIF_FAMILIES.length);
  for (let tries = 0; tries < 8 && avoid.includes(fi); tries++) {
    fi = Math.floor(rnd() * MOTIF_FAMILIES.length);
  }
  const subject = pick(MOTIF_FAMILIES[fi], rnd); // motivo dentro de la familia
  const palette = pick(PALETTES, rnd);
  const lighting = pick(LIGHTING, rnd);
  const composition = pick(COMPOSITION, rnd);
  const darker = (bible.darkness || "").toLowerCase().includes("extreme") ? " very dark, low-key," : "";

  const prompt =
    `Professional dark romance book cover, a central emblem of ${subject}, ${palette}, ${lighting}, ${composition}, ` +
    `baroque ornate filigree, gold-foil accents, intricate hyper-detailed rendering, dramatic and striking, ` +
    `luxurious, glossy, deep rich shadows, cinematic,${darker} embossed look, ` +
    `strong vignette, darkened top and bottom edges, ` +
    `no text, no typography, no letters, no watermark, no people, no faces.`;
  const negative =
    "people, person, human, humans, man, woman, child, baby, infant, toddler, doll, figure, " +
    "silhouette, mannequin, statue, bust, portrait, face, faces, eyes, hands, arms, legs, body, skin, " +
    "nudity, explicit, " +
    "text, words, letters, title, typography, watermark, signature, logo, ui, frame border, " +
    "deformed, low quality, blurry, jpeg artifacts, cartoon, childish, oversaturated, flat";
  const seed = hashStr(seedStr) % 2147483647;
  return { prompt, negative, seed, family: fi };
}

/* ---- llamada a fal.ai (síncrona) + descarga del PNG ---- */
async function falGenerate(
  prompt: string,
  negative: string,
  seed: number
): Promise<{ buf: Buffer; blanked: boolean }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(`${BASE}/${MODEL}`, {
      method: "POST",
      headers: { Authorization: `Key ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        negative_prompt: negative,
        seed,
        image_size: { width: 768, height: 1152 }, // 2:3, igual que la tarjeta
        num_images: 1,
        output_format: "png",
        enable_safety_checker: true,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`fal ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const data = (await res.json()) as {
      images?: { url?: string }[];
      has_nsfw_concepts?: boolean[];
      nsfw_content_detected?: boolean[];
    };
    const url = data?.images?.[0]?.url;
    if (!url) throw new Error("fal: respuesta sin imagen");
    // Si el safety checker se dispara, fal devuelve la imagen EN NEGRO.
    const flagged = Boolean(data.has_nsfw_concepts?.[0] ?? data.nsfw_content_detected?.[0]);
    const img = await fetch(url, { signal: ctrl.signal });
    if (!img.ok) throw new Error(`descarga de imagen ${img.status}`);
    const buf = Buffer.from(await img.arrayBuffer());
    // Respaldo: un PNG real con detalle pesa bastante; uno casi negro pesa poquísimo.
    const blanked = flagged || buf.length < 25000;
    return { buf, blanked };
  } finally {
    clearTimeout(timer);
  }
}

/* ---- worker: genera y persiste la portada de un libro ---- */
export async function generateCover(storyId: string): Promise<void> {
  if (!coverEnabled()) return;
  if (_covering.has(storyId)) return;
  _covering.add(storyId);
  try {
    // 1) lee lo necesario bajo lock (rápido); nada lento aquí
    const job = await withDB((db) => {
      const s = db.stories.find((x) => x.id === storyId);
      if (!s || s.coverImage || !s.bibleSnapshot) return null;
      // familias de las últimas portadas (db.stories va de más nuevo a más viejo)
      // para no repetir el mismo objeto en portadas vecinas
      const recent: number[] = [];
      for (const st of db.stories) {
        if (st.id === storyId) continue;
        if (typeof st.coverFamily === "number") {
          recent.push(st.coverFamily);
          if (recent.length >= 4) break;
        }
      }
      return { bible: s.bibleSnapshot, avoid: recent };
    });
    if (!job) return;

    // 2) prompt genérico + llamada al modelo, FUERA del lock.
    //    Evita las familias recién usadas; si fal devuelve la imagen en negro
    //    (safety checker), reintenta con otra semilla/motivo hasta 3 veces.
    let buf: Buffer | null = null;
    let chosenFamily = -1;
    for (let attempt = 0; attempt < 3; attempt++) {
      const seedKey = attempt === 0 ? storyId : `${storyId}#${attempt}`;
      const { prompt, negative, seed, family } = buildCoverPrompt(job.bible, seedKey, job.avoid);
      const r = await falGenerate(prompt, negative, seed);
      buf = r.buf;
      chosenFamily = family;
      if (!r.blanked) break; // portada buena
      console.warn(`[cover] intento ${attempt + 1} salió en negro/censurado, reintento ${storyId}`);
    }
    if (!buf) return;

    // 3) guarda en disco
    await fs.mkdir(COVERS_DIR, { recursive: true });
    await fs.writeFile(path.join(COVERS_DIR, `${storyId}.png`), buf);

    // 4) marca la ruta y la familia usada en la DB bajo lock
    await withDB((db) => {
      const s = db.stories.find((x) => x.id === storyId);
      if (s) {
        s.coverImage = `/covers/${storyId}.png`;
        s.coverFamily = chosenFamily;
      }
      return null;
    });
    console.log(`[cover] listo ${storyId}`);
  } catch (e) {
    console.error(`[cover] fallo ${storyId}:`, (e as Error).message);
  } finally {
    _covering.delete(storyId);
  }
}

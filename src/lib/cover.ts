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

/* Repertorio de emblemas dark romance por FAMILIAS. Cada familia es "object"
   (objeto, sin personas) o "figure" (parte del cuerpo SIN rostro: piernas,
   espalda, torso, manos, o un primer plano íntimo de ojos/labios). La selección
   elige una familia al azar y luego un motivo, evitando repetir la familia
   vecina, para máxima variedad. Las rosas ya no están en casi todo. */
const MOTIF_FAMILIES: { kind: "object" | "figure"; motifs: string[] }[] = [
  // armas de fuego
  { kind: "object", motifs: [
    "an ornate antique revolver on black velvet",
    "a pair of crossed pistols on wet dark marble",
    "a vintage pistol beside scattered bullet casings",
    "a golden revolver half-lit in deep shadow",
    "a smoking pistol on a bloodstained table",
  ] },
  // armas blancas
  { kind: "object", motifs: [
    "an antique dagger on black silk",
    "twin crossed daggers on cold stone",
    "an ornate switchblade on dark marble",
    "an ornate sword laid across velvet",
    "a straight razor resting on crimson silk",
    "a curved dagger dripping a single drop of blood",
  ] },
  // serpientes
  { kind: "object", motifs: [
    "a black serpent coiled over wet marble",
    "two serpents entwined around an ornate dagger",
    "a venomous snake wrapped around an hourglass",
    "a coiled cobra rising from darkness",
    "an emerald snake slithering across dark silk",
  ] },
  // arañas y telarañas
  { kind: "object", motifs: [
    "a black widow spider on a dewy spiderweb",
    "an ornate spiderweb glistening in cold light",
    "a black spider crawling across crimson silk",
    "a dewy web spun between rusted iron bars",
  ] },
  // calaveras humanas
  { kind: "object", motifs: [
    "an ornate human skull wrapped in thorny vines",
    "a gilded human skull wearing a small crown",
    "a human skull and a dagger crossed on stone",
    "a human skull wreathed in swirling smoke",
    "a jewel-encrusted skull on black velvet",
  ] },
  // calaveras de animales
  { kind: "object", motifs: [
    "a ram skull with long curved horns",
    "a bull skull entwined with thorny vines",
    "a stag skull with wide antlers in shadow",
    "a raven skull beside a tarnished coin",
  ] },
  // máscaras y antifaces
  { kind: "object", motifs: [
    "a venetian masquerade mask on dark velvet",
    "an ornate plague-doctor mask in shadow",
    "a black domino mask on crimson silk",
    "a gilded carnival mask wreathed in smoke",
  ] },
  // coronas y realeza
  { kind: "object", motifs: [
    "an ornate golden crown over crossed daggers",
    "a fallen tarnished crown on cold stone",
    "a crown of thorns wrapped in gold wire",
    "a signet ring resting in spilled red wine",
    "a jeweled crown half-sunk in dark water",
  ] },
  // ajedrez (poder y estrategia)
  { kind: "object", motifs: [
    "a toppled black king chess piece on a marble board",
    "a black king and a white queen facing off",
    "an ornate black queen chess piece in a shaft of light",
    "a checkmate on a shattered chessboard",
    "a single king piece casting a long shadow",
  ] },
  // esqueletos (manos)
  { kind: "object", motifs: [
    "a skeletal hand gripping an ornate dagger",
    "a skeletal hand wearing a jeweled ring",
    "two crossed skeletal hands on black silk",
    "a skeletal hand reaching up through smoke",
  ] },
  // ataduras
  { kind: "object", motifs: [
    "a pair of antique handcuffs on dark velvet",
    "heavy iron chains coiled on stone",
    "a padlock and key on a chain",
    "a leather collar and chain on black silk",
    "rope coiled in an intricate knot",
  ] },
  // prendas y objetos de seducción
  { kind: "object", motifs: [
    "a black lace corset laid on dark silk",
    "a single red stiletto heel on marble",
    "tall black leather boots and a riding crop",
    "long black satin gloves on velvet",
    "a black velvet choker with a ruby pendant",
    "fishnet stockings draped over an antique chair",
  ] },
  // alas y aves
  { kind: "object", motifs: [
    "a pair of black feathered wings spread wide",
    "a single black raven perched on iron",
    "scattered black feathers over crimson silk",
    "a crow with spread black wings in fog",
    "a moth with intricate patterned wings",
  ] },
  // humo y atmósfera
  { kind: "object", motifs: [
    "swirling dark smoke in a shaft of light",
    "wisps of smoke rising from a snuffed candle",
    "incense smoke curling in the dark",
  ] },
  // sangre y vasijas
  { kind: "object", motifs: [
    "crimson blood splatter across dark marble",
    "a gothic chalice spilling dark blood",
    "drops of blood falling onto white silk",
    "a tipped wine glass spilling red across stone",
  ] },
  // objetos góticos
  { kind: "object", motifs: [
    "an antique hourglass wrapped in thorns",
    "an ornate pocket watch on dark velvet",
    "a candelabra with dripping wax in the dark",
    "a shattered mirror in a gilded frame",
    "a deck of black playing cards fanned out",
    "an ornate iron key on dark velvet",
    "a cracked porcelain teacup on a saucer",
  ] },
  // botánico (rosas — ya solo una familia)
  { kind: "object", motifs: [
    "a single dark red rose with sharp thorns",
    "a bouquet of black roses bound in ribbon",
    "thorny vines wrapped around a blooming rose",
    "deadly nightshade on dark velvet",
    "black poppies on crimson silk",
  ] },

  // ---- FIGURA: cuerpo SIN rostro ----
  // piernas
  { kind: "figure", motifs: [
    "a woman's crossed legs in fishnet stockings and red stiletto heels, cropped at the thighs, face out of frame",
    "bare legs draped over a dark velvet chaise, cropped at the waist, faceless",
    "legs in torn black stockings against dark silk, face not shown",
  ] },
  // espalda de mujer
  { kind: "figure", motifs: [
    "a woman seen from behind, her bare back and shoulder blades, head turned away and cropped",
    "the elegant curve of a woman's spine and shoulders in low light, faceless",
    "a woman's back laced into a black corset, head cropped out of frame",
  ] },
  // hombre sin rostro
  { kind: "figure", motifs: [
    "a shirtless muscular man cropped above the jaw, tattoos across his chest, face not shown",
    "a man's tattooed hands and forearms resting on his knees, face out of frame",
    "a man in an open black dress shirt, cropped below the chin, faceless",
  ] },
  // primer plano íntimo (ojos, labios, manos)
  { kind: "figure", motifs: [
    "an extreme close-up of a single intense eye framed by dark lashes",
    "extreme close-up of parted red lips and jaw, the rest of the face out of frame",
    "two hands clasped tightly, one gripping the other, dramatic light",
    "a hand with red-painted nails resting on a bare collarbone, cropped",
  ] },
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

/* ESTILOS de portada: cada uno es una receta distinta de composición + medio +
   acabado. Se elige uno por libro (evitando los recientes) para que la
   biblioteca no se sienta toda igual aunque cambie el objeto. Todos respetan
   "sin texto ni personas" (el título lo dibuja la tarjeta encima). */
type StyleFn = (subject: string, palette: string, lighting: string) => string;
// ACTIVOS (por ahora): solo el estilo fotográfico de la primera portada
// (macro-textura) y el atmosférico de la última (humo/brasas). Sin oro, sin
// filigrana, sin Art Déco. Para reactivar más variedad, mueve estilos desde
// COVER_STYLES_PARKED aquí abajo.
const COVER_STYLES: { name: string; build: StyleFn }[] = [
  {
    name: "macro-textura",
    build: (s, p, l) =>
      `Extreme close-up macro of ${s}. ${p}. ${l}. Full-bleed luxurious textured surface (black silk, velvet, wet marble, satin), shallow depth of field, fine dewdrops and tactile detail, abstract and sensual atmosphere, photographic`,
  },
  {
    name: "atmosferico-humo",
    build: (s, p, l) =>
      `${s} emerging from swirling smoke, embers and haze. ${p}. ${l}. Near-abstract atmospheric mood, drifting particles and godrays, soft-focus dark background, mysterious and cinematic, photographic`,
  },
];

// APARCADOS (desactivados por ahora). Para volver a usar alguno, córtalo y
// pégalo dentro de COVER_STYLES de arriba. Los tres primeros son los de oro /
// Art Déco que no gustaron.
const COVER_STYLES_PARKED: { name: string; build: StyleFn }[] = [
  {
    name: "emblema-ornamentado",
    build: (s, p, l) =>
      `A central emblem of ${s}. ${p}. ${l}. Symmetrical centered heraldic composition, baroque ornate filigree, gold-foil accents, intricate hyper-detailed rendering, embossed look, glossy and luxurious`,
  },
  {
    name: "grabado-dorado",
    build: (s, p) =>
      `${s}, as an intricate gold line engraving and etching on a flat near-black background. ${p}. Fine elegant linework, vintage botanical-illustration and tattoo style, graphic and symmetrical, flat 2D, no photographic depth`,
  },
  {
    name: "art-deco",
    build: (s, p) =>
      `${s} framed by an ornate art-deco geometric border. ${p}. Symmetrical deco linework, gold lines on black, 1920s luxury poster style, elegant geometry, crisp and graphic`,
  },
  {
    name: "minimalista",
    build: (s, p, l) =>
      `A single small ${s}, isolated. ${p}. ${l}. Minimalist composition with vast empty negative space and dark breathing room, refined and modern, subtle film grain, understated and elegant`,
  },
  {
    name: "oleo",
    build: (s, p, l) =>
      `${s}, rendered as a moody fine-art oil painting. ${p}. ${l}. Visible brushstrokes, old-master chiaroscuro, painterly baroque still life, dramatic gallery-quality artwork`,
  },
  {
    name: "floral-gotico",
    build: (s, p, l) =>
      `${s} surrounded by dense moody gothic florals and dark overgrown foliage. ${p}. ${l}. Lush decadent botanical arrangement filling the frame, baroque dark-cottagecore, rich and ornate`,
  },
];
void COVER_STYLES_PARKED; // referenciado para no romper lint por "no usado"

export function buildCoverPrompt(
  bible: StoryBible,
  seedStr: string,
  avoid: number[] = [],
  avoidStyles: number[] = []
): { prompt: string; negative: string; seed: number; family: number; style: number } {
  const rnd = mulberry32(hashStr(seedStr || "queneau"));
  // elige una familia de objeto evitando las recién usadas (si es posible)
  let fi = Math.floor(rnd() * MOTIF_FAMILIES.length);
  for (let tries = 0; tries < 8 && avoid.includes(fi); tries++) {
    fi = Math.floor(rnd() * MOTIF_FAMILIES.length);
  }
  // elige un ESTILO evitando los recién usados (si es posible)
  let si = Math.floor(rnd() * COVER_STYLES.length);
  for (let tries = 0; tries < 8 && avoidStyles.includes(si); tries++) {
    si = Math.floor(rnd() * COVER_STYLES.length);
  }

  const fam = MOTIF_FAMILIES[fi];
  const subject = pick(fam.motifs, rnd); // motivo dentro de la familia
  const isFigure = fam.kind === "figure";
  const palette = pick(PALETTES, rnd);
  const lighting = pick(LIGHTING, rnd);
  const darker = (bible.darkness || "").toLowerCase().includes("extreme") ? " Very dark and low-key." : "";

  const styleCore = COVER_STYLES[si].build(subject, palette, lighting);
  // Regla de personas: los objetos no llevan personas; las "figuras" permiten
  // cuerpo pero NUNCA un rostro reconocible (recortado, de espaldas o parcial).
  const peopleRule = isFigure
    ? "Do NOT show a full or recognizable face — crop it out, turn it away, or keep it a partial close-up; faceless. Tasteful, no explicit nudity."
    : "No people, no faces, no human figures.";
  const prompt =
    `Professional dark romance book cover. ${styleCore}. ` +
    `Premium, striking and decadent dark-romance aesthetic.${darker} ` +
    `Strong vignette with darkened top and bottom edges. ` +
    `No text, no typography, no letters, no title, no watermark. ${peopleRule}`;
  const negative = isFigure
    ? "full face, whole face, recognizable face, portrait, headshot, front-facing face, smiling, looking at camera, two people, crowd, " +
      "explicit nudity, genitalia, nipples, pornographic, " +
      "text, words, letters, title, typography, watermark, signature, logo, ui, frame border, " +
      "deformed, extra limbs, extra fingers, mutated hands, low quality, blurry, jpeg artifacts, cartoon, childish, oversaturated, flat colors"
    : "people, person, human, humans, man, woman, child, baby, infant, toddler, doll, figure, " +
      "silhouette, mannequin, statue, bust, portrait, face, faces, eyes, hands, arms, legs, body, skin, " +
      "nudity, explicit, " +
      "text, words, letters, title, typography, watermark, signature, logo, ui, frame border, " +
      "deformed, low quality, blurry, jpeg artifacts, cartoon, childish, oversaturated, flat colors";
  const seed = hashStr(seedStr) % 2147483647;
  return { prompt, negative, seed, family: fi, style: si };
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
      // familias y estilos de las últimas portadas (db.stories va de más nuevo a
      // más viejo) para no repetir el mismo objeto NI el mismo estilo en vecinas
      const recent: number[] = [];
      const recentStyles: number[] = [];
      for (const st of db.stories) {
        if (st.id === storyId) continue;
        if (typeof st.coverFamily === "number" && recent.length < 4) recent.push(st.coverFamily);
        if (typeof st.coverStyle === "number" && recentStyles.length < 3) recentStyles.push(st.coverStyle);
        if (recent.length >= 4 && recentStyles.length >= 3) break;
      }
      return { bible: s.bibleSnapshot, avoid: recent, avoidStyles: recentStyles };
    });
    if (!job) return;

    // 2) prompt genérico + llamada al modelo, FUERA del lock.
    //    Evita las familias recién usadas; si fal devuelve la imagen en negro
    //    (safety checker), reintenta con otra semilla/motivo hasta 3 veces.
    let buf: Buffer | null = null;
    let chosenFamily = -1;
    let chosenStyle = -1;
    for (let attempt = 0; attempt < 3; attempt++) {
      const seedKey = attempt === 0 ? storyId : `${storyId}#${attempt}`;
      const { prompt, negative, seed, family, style } = buildCoverPrompt(job.bible, seedKey, job.avoid, job.avoidStyles);
      const r = await falGenerate(prompt, negative, seed);
      buf = r.buf;
      chosenFamily = family;
      chosenStyle = style;
      if (!r.blanked) break; // portada buena
      console.warn(`[cover] intento ${attempt + 1} salió en negro/censurado, reintento ${storyId}`);
    }
    if (!buf) return;

    // 3) guarda en disco
    await fs.mkdir(COVERS_DIR, { recursive: true });
    await fs.writeFile(path.join(COVERS_DIR, `${storyId}.png`), buf);

    // 4) marca la ruta, la familia y el estilo usados en la DB bajo lock
    await withDB((db) => {
      const s = db.stories.find((x) => x.id === storyId);
      if (s) {
        s.coverImage = `/covers/${storyId}.png`;
        s.coverFamily = chosenFamily;
        s.coverStyle = chosenStyle;
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

/* Regenera la portada en un archivo APARTE (<id>-alt.png) SIN tocar la original,
   para que el usuario pueda elegir entre las dos. Devuelve la ruta pública o null.
   Usa una semilla distinta y evita repetir el estilo/motivo de la portada actual. */
export async function regenerateCover(storyId: string): Promise<string | null> {
  if (!coverEnabled()) return null;
  const job = await withDB((db) => {
    const s = db.stories.find((x) => x.id === storyId);
    if (!s || !s.bibleSnapshot) return null;
    const avoid: number[] = [];
    const avoidStyles: number[] = [];
    if (typeof s.coverFamily === "number") avoid.push(s.coverFamily); // no repetir el motivo actual
    if (typeof s.coverStyle === "number") avoidStyles.push(s.coverStyle); // ni el estilo actual
    return { bible: s.bibleSnapshot, avoid, avoidStyles };
  });
  if (!job) return null;

  let buf: Buffer | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const seedKey = `${storyId}#regen${attempt}${Date.now()}`; // semilla distinta => imagen distinta
    const { prompt, negative, seed } = buildCoverPrompt(job.bible, seedKey, job.avoid, job.avoidStyles);
    const r = await falGenerate(prompt, negative, seed);
    buf = r.buf;
    if (!r.blanked) break;
    console.warn(`[cover] regen intento ${attempt + 1} salió en negro/censurado, reintento ${storyId}`);
  }
  if (!buf) return null;

  await fs.mkdir(COVERS_DIR, { recursive: true });
  await fs.writeFile(path.join(COVERS_DIR, `${storyId}-alt.png`), buf);
  return `/covers/${storyId}-alt.png`;
}

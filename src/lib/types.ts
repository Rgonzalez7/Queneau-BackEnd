// Modelo de dominio de Quenu

export type HeatLevel = "cerradas" | "cálido" | "picante" | "explícito";
export type FormatKey = "corta" | "completa" | "saga";
export type Origin = "gratis" | "pagada_extra";
export type StoryStatus = "apertura" | "desbloqueada";

export type ScenePosition = "auto" | "inicio" | "medio" | "final";
export interface SceneSpec { type: string; count: number }
export interface CustomScene { text: string; position: ScenePosition }
export interface AutoPick {
  intensity?: boolean;
  tropes?: boolean;
  toneStructure?: boolean;
  details?: boolean;
  scenes?: boolean;
}

export interface Profile {
  id: string;
  name: string;
  source: string; // extraído | manual | mezcla
  genre?: string;
  tropes: string[];
  heat_level: HeatLevel | null;
  tone: string[];
  pov: string;
  pacing: string;
  archetype?: string;  // arquetipo del interés romántico
  darkness?: string;   // nivel de oscuridad
  must_haves: string[];
  avoid: string[];
  settings: string[];
  autopick?: AutoPick;          // qué pasos decide Queneau (true) vs la lectora (false)
  scenes?: SceneSpec[];         // escenas obligatorias por tipo + cantidad
  customScenes?: CustomScene[]; // escenas libres descritas por la lectora
  created: number;
}

export interface Chapter {
  t: string;
  b: string;
}

// --- Biblia de la historia (estructura decidida por código; congelada) ---
export type CharacterRole = "protagonista" | "interes" | "antagonista" | "secundario";

export interface BibleCharacter {
  name: string;
  role: CharacterRole;
  age: number; // SIEMPRE >= 18 (fijado por código)
  traits: string[];
}

export interface StoryBible {
  id: string;
  premise: string;
  setting: string;
  characters: BibleCharacter[];
  tone: string;
  pov?: string;          // punto de vista (para adaptar el formato de la sinopsis)
  heat: string; // heat_level del perfil
  archetype?: string; // arquetipo del interés
  darkness?: string;  // nivel de oscuridad
  mustHaves?: string[]; // imprescindibles del perfil (must_haves)
  tropes: string[];
  // ejes de variación (decididos por código) para que las historias no se sientan iguales
  setup?: string;        // cómo quedan unidos protagonista e interés
  powerDynamic?: string; // quién tiene el poder
  heroineAngle?: string; // qué tipo de heroína (no siempre "inocente capturada")
  openingTone?: string;  // cómo arranca la historia
  engine?: string;        // motor central del conflicto
  secret?: string;        // secreto que reconfigura la trama a mitad de camino
  complication?: string;  // giro extra del tercio final
  atmosphere?: string;    // atmósfera obligatoria del género
  arcTemplate?: string;   // nombre de la plantilla de arco elegida
  // arco de personaje (la Mentira y la necesidad moral) — profundidad, no relleno
  lie?: string;           // la creencia falsa que sostiene la protagonista
  need?: string;          // la verdad moral que debe aprender (choca con la mentira)
  wound?: string;         // la herida de origen que creó la mentira
  flaw?: string;          // el defecto que la sabotea bajo presión
  facade?: string;        // la máscara que muestra al mundo
  interestContradiction?: string; // la grieta entre lo que el interés dice y hace
  // escenas pedidas por la lectora, repartidas por capítulo (código decide DÓNDE)
  scenePlan?: { chapter: number; directive: string }[];
  arc: { chapter: number; beat: string }[];
}

export interface Story {
  id: string;
  profileSnapshot: Profile; // FOTO CONGELADA — no cambia aunque el perfil se edite/borre
  profileName: string;
  predecessorId: string | null;
  title: string;
  synopsis: string;
  format: FormatKey;
  bibleSnapshot?: StoryBible; // biblia congelada (opcional para historias antiguas)
  chapters: Chapter[];
  chaptersTotal?: number; // total esperado del formato (para mostrar progreso)
  generating?: boolean;   // true mientras el worker produce los capítulos restantes
  coverImage?: string | null; // ruta de la portada IA (/covers/<id>.png); null/undefined => usa vector
  coverFamily?: number; // índice de la familia de motivo usada (para no repetir objeto en portadas vecinas)
  coverStyle?: number;  // índice del estilo de portada usado (para no repetir estilo en portadas vecinas)
  origin: Origin;
  paid: boolean;
  created: number;
  expiresAt: number | null; // solo aperturas gratis; null si pagada (nunca caduca)
  status: StoryStatus;
  finished: boolean; // true cuando la lectora la marca como leída
}

export interface Account {
  id: string;
  created: number;
}

export interface DB {
  account: Account;
  profiles: Profile[];
  stories: Story[];
  craftStats?: CraftStats; // señal de craft AGREGADA y anónima (sin texto ni obras)
}

/* Estadística AGREGADA de estructura narrativa aprendida de PDFs subidos.
   Solo categorías de un vocabulario cerrado + conteos + posiciones (0-100).
   No contiene texto, nombres, ni filas por obra: no se puede reconstruir nada. */
export interface CraftStats {
  samples: number;
  updated: number;
  genre: Record<string, number>;
  pacing: Record<string, number>;
  engine: Record<string, number>;
  power: Record<string, number>;
  heroine: Record<string, number>;
  heat: Record<string, number>;
  imRegister: Record<string, number>;  // registro del lenguaje íntimo
  imPacing: Record<string, number>;    // ritmo de la escena íntima
  imInitiator: Record<string, number>; // quién inicia
  scenes: Record<string, number>;      // contabilidad por tipo de escena
  tropePairs: Record<string, number>; // "a|b" en orden alfabético -> conteo
  beatPos: Record<string, { n: number; sum: number; hist: number[] }>; // pos media + histograma (10 cubos)
}

export interface FormatInfo {
  chapters: number;
  price: number;
  label: string;
}

export interface Quota {
  used: number;
  total: number;
  available: number;
  hasPurchased: boolean;
}

// Lo que se expone al cliente (con el muro aplicado)
export interface PublicStory {
  id: string;
  title: string;
  profileName: string;
  genre: string;
  format: FormatKey;
  synopsis: string;
  paid: boolean;
  status: StoryStatus;
  origin: Origin;
  predecessorId: string | null;
  chapters: Chapter[];
  lockedChapters: number;
  chaptersReady: number; // capítulos ya generados y disponibles
  chaptersTotal: number; // total que tendrá el libro
  generating: boolean;   // true mientras se generan los que faltan
  coverImage?: string | null; // portada IA si está lista
  coverPending: boolean; // true mientras la IA la genera
  price: number;
  expiresInDays: number | null;
  finished: boolean;
}

export interface PublicState {
  brand: string;
  quota: Quota;
  formats: Record<FormatKey, FormatInfo>;
  profiles: Profile[];
  stories: PublicStory[];
}

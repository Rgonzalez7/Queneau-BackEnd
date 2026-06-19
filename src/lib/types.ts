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

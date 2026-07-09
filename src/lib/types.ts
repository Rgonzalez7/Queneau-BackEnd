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
  ownerId?: string; // usuario dueño (multiusuario); ausente = dato legado
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
  voice?: BibleVoice;     // voz/ADN de estilo asignado a ESTE libro (fase 2)
  arc: { chapter: number; beat: string }[];
}

/* Perillas DURAS de estilo: parámetros accionables y verificables. */
export interface VoiceKnobs {
  sentenceAvg: [number, number]; // rango de palabras por frase
  paragraphLines: "cortos" | "medios" | "largos";
  dialogueRatio: "bajo" | "medio" | "alto";
  explicitness: number;          // 1-5
  interiority: "baja" | "media" | "alta";
  tense: "presente" | "pasado";
  punctuation: string[];         // tics de puntuación característicos
}

/* Payload compacto de voz que se congela en la biblia de cada libro. */
export interface BibleVoice {
  name: string;
  imperatives: string[];                 // 3-5 reglas cortas, re-inyectadas por capítulo
  knobs?: VoiceKnobs;
  styleSample?: string;                  // escena original en esa voz (few-shot)
  lexicon?: { sex: string[]; violence: string[]; action: string[] };
  plotBeats?: PlotBeat[];                // mapa de trama (patrón) para replicar la estructura
  cast?: CastProfile;                    // perfil de elenco del libro fuente (para variar nº de personajes)
}

/* Perfil de ELENCO extraído del libro fuente: cuántos personajes centrales
   maneja y qué papeles secundarios recurren, para que la generación no caiga
   siempre en el mismo 2+1. */
export interface CastProfile {
  size?: number;         // total de personajes con peso real en la trama (típico 3-6)
  secondary?: string[];  // arquetipos secundarios recurrentes (p. ej. "mejor amiga", "hermano", "rival", "segundo interés", "mano derecha")
  note?: string;         // descripción breve de la estructura de elenco
}

/* Hito estructural de trama, posicionado por % del libro (PATRÓN abstracto,
   nunca la trama concreta de la obra). */
export interface PlotBeat {
  at: number;      // posición 0-100 (% del libro)
  type: string;    // pico de tensión, plot twist, confrontación, punto de quiebre, revés, falsa victoria, clímax…
  note: string;    // descripción abstracta del patrón (sin nombres ni eventos específicos)
}

export interface Story {
  id: string;
  ownerId?: string; // usuario dueño (multiusuario); ausente = dato legado
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
  bookTitle?: string;         // título real generado (corto, dark) una vez comprado; si no, se usa el descriptor
  coverImageOrig?: string | null; // portada original antes de regenerar (para poder volver a ella)
  coverImageAlt?: string | null;  // portada regenerada (la alternativa)
  coverRegenerated?: boolean;     // el usuario ya gastó su única regeneración de este libro
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

/* -------------------------------- Usuarios -------------------------------- */
export type Role = "user" | "admin";

export interface User {
  id: string;
  email: string;             // normalizado a minúsculas
  name: string;
  passwordHash?: string;     // solo cuentas email+contraseña
  googleId?: string;         // solo cuentas de Google (sub del ID token)
  dateOfBirth: string;       // ISO YYYY-MM-DD (declarada en el registro)
  role: Role;                // "admin" = superusuario (control total)
  envAdmin?: boolean;        // true si es admin POR SUPERUSER_EMAIL (no manual)
  suspended?: boolean;       // el admin puede suspender una cuenta
  avatar?: string;           // id de máscara elegido (cosmético, por usuario)
  avatarBg?: string;         // color de fondo del avatar (cosmético, por usuario)
  createdAt: number;
  lastLogin?: number;
}

/* Lo que se expone del usuario al cliente (nunca el hash ni datos sensibles). */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  adult: boolean;
  avatar?: string;
  avatarBg?: string;
  createdAt: number;
}

export interface DB {
  account: Account;          // legado (single-tenant); se conserva por compatibilidad
  users: User[];
  profiles: Profile[];
  stories: Story[];
  voices?: VoiceProfile[];   // ADN de estilo extraído de obras (voces reutilizables)
  craftStats?: CraftStats; // señal de craft AGREGADA y anónima (sin texto ni obras)
}

/* ADN de estilo: descriptores ABSTRACTOS de cómo se escribe una obra (nunca
   texto literal). Se usan para variar la "sensación de autor" entre libros. */
export interface VoiceProfile {
  id: string;
  name: string;
  source?: string;          // nombre del archivo (solo metadato)
  createdAt: number;
  createdBy: string;        // id del admin que lo creó
  structure: string;        // arquitectura del libro (capítulos, cadencia, ritmo)
  voice: string;            // esencia de la voz narrativa
  sceneCraft: {             // nota de montaje concreta por tipo de escena
    sex: string;
    violence: string;
    action: string;
  };
  lexicon?: {               // DICCIONARIO: léxico característico por tipo de escena
    sex: string[];
    violence: string[];
    action: string[];
  };
  knobs?: VoiceKnobs;       // perillas duras (fase 2)
  imperatives?: string[];   // reglas cortas re-inyectables (fase 2)
  styleSample?: string;     // escena original en esa voz, para few-shot (fase 2)
  tags?: VoiceTags;         // etiquetas para el match con la categoría del usuario
  plotBeats?: PlotBeat[];   // mapa de trama: hitos estructurales por % del libro
  tensionCurve?: number[];  // curva de tensión (8-12 puntos, 0-100)
  cast?: CastProfile;       // perfil de elenco del libro fuente
  stats?: { words?: number };
}

/* Etiquetas comparables (mismo vocabulario que los perfiles) para el match. */
export interface VoiceTags {
  genre?: string;
  tropes: string[];
  heat?: string;
  tone: string[];
  darkness?: string;
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
  bookTitle?: string | null;  // título real (corto, dark) si el libro ya está comprado/generado
  coverImageOrig?: string | null; // portada original (si hubo regeneración)
  coverImageAlt?: string | null;  // portada alternativa regenerada
  coverRegenerated?: boolean;     // ya se usó la única regeneración
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

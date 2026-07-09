import { promises as fs } from "fs";
import path from "path";
import type { DB } from "./types";
import { uid } from "./constants";

/*
 * ALMACENAMIENTO — funciona IGUAL en local y en producción; solo cambia el entorno.
 *
 *   - Si existe la variable MONGODB_URI  → usa MongoDB (producción / online).
 *   - Si NO existe                       → usa un archivo JSON local (data/db.json).
 *
 * El MISMO código corre en los dos sitios: para desarrollar en local no necesitas
 * Mongo, y para producción basta con definir MONGODB_URI en el entorno. La lógica
 * de negocio (rules.ts, cover.ts, generator.ts) NO cambia: la interfaz pública
 * (loadDB / saveDB / withDB) es exactamente la misma.
 *
 * En Mongo se guarda TODA la "db" como un único documento (account + profiles +
 * stories), igual que el archivo JSON. Esto preserva la semántica de
 * load → modificar → save y el candado en memoria de withDB sin tocar nada más.
 */

/* --------------------------- semilla inicial --------------------------- */
function initialDB(): DB {
  return {
    account: { id: "demo", created: Date.now() },
    users: [],
    profiles: [
      {
        id: uid(),
        name: "Mafia oscura",
        source: "manual",
        genre: "dark romance",
        tropes: ["mafia / bajos fondos", "enemigos a amantes", "protagonista posesivo"],
        heat_level: "explícito",
        tone: ["oscuro", "tenso"],
        pov: "primera persona dual",
        pacing: "rápido / intenso",
        must_haves: ["HEA obligatorio"],
        avoid: ["engaño"],
        settings: ["bajos fondos"],
        created: Date.now(),
      },
    ],
    stories: [],
  };
}

/* --------------------------- selección de backend --------------------------- */
const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || "queneau";
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || "app";
const DOC_ID = "main"; // un único documento contiene toda la db
const useMongo = !!MONGODB_URI;

/* --------------------------- backend: MongoDB --------------------------- */
/* Carga perezosa del driver: en local (sin Mongo) ni se importa. */
type MongoColl = {
  findOne: (q: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  replaceOne: (
    q: Record<string, unknown>,
    doc: Record<string, unknown>,
    opts: { upsert: boolean }
  ) => Promise<unknown>;
};
let _coll: Promise<MongoColl> | null = null;
function mongoColl(): Promise<MongoColl> {
  if (!_coll) {
    _coll = (async () => {
      const { MongoClient } = await import("mongodb");
      const Ctor = MongoClient as unknown as new (uri: string) => {
        connect: () => Promise<unknown>;
        db: (n: string) => { collection: (c: string) => MongoColl };
      };
      const client = new Ctor(MONGODB_URI);
      await client.connect();
      console.log(`[db] MongoDB conectado (${MONGODB_DB}.${MONGODB_COLLECTION})`);
      return client.db(MONGODB_DB).collection(MONGODB_COLLECTION);
    })();
  }
  return _coll;
}

/* --------------------------- backend: archivo JSON --------------------------- */
const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");

/* Asegura campos nuevos en bases ya existentes (multiusuario). No asigna dueños:
   los datos legados quedan sin ownerId hasta que el superusuario los reclama. */
function normalize(db: DB): DB {
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.profiles)) db.profiles = [];
  if (!Array.isArray(db.stories)) db.stories = [];
  if (!Array.isArray(db.voices)) db.voices = [];
  return db;
}

/* --------------------------- load / save --------------------------- */
export async function loadDB(): Promise<DB> {
  if (useMongo) {
    const col = await mongoColl();
    const doc = await col.findOne({ _id: DOC_ID });
    if (doc) {
      const obj = doc as Record<string, unknown>;
      delete obj._id; // el _id es de Mongo, no parte de la db
      return normalize(obj as unknown as DB);
    }
    const seed = initialDB();
    await saveDB(seed); // persistir la semilla para que los IDs sean estables
    return seed;
  }
  // archivo JSON local
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return normalize(JSON.parse(raw) as DB);
  } catch {
    const db = initialDB();
    await saveDB(db);
    return db;
  }
}

export async function saveDB(db: DB): Promise<void> {
  if (useMongo) {
    const col = await mongoColl();
    await col.replaceOne({ _id: DOC_ID }, { _id: DOC_ID, ...db }, { upsert: true });
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2));
}

/*
 * withDB — serializa load → modificar → save en una sola cola.
 *
 * Dos escrituras simultáneas (un handler HTTP y el worker de generación en
 * segundo plano) se pisarían (last-write-wins). withDB encadena las mutaciones
 * para que nunca se solapen. La función `fn` recibe la db ya cargada, la
 * modifica en memoria y, al terminar, se guarda.
 *
 * IMPORTANTE: no hagas trabajo lento (llamadas al modelo) dentro de `fn`; el
 * candado debe sostenerse solo durante el load-modify-save.
 *
 * Nota: el candado es en memoria, válido para UNA instancia del servidor. Si
 * algún día escalas a varias instancias, habrá que mover la cola a algo externo.
 */
let _chain: Promise<unknown> = Promise.resolve();
export function withDB<T>(fn: (db: DB) => T | Promise<T>): Promise<T> {
  const run = _chain.then(async () => {
    const db = await loadDB();
    const result = await fn(db);
    await saveDB(db);
    return result;
  });
  _chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

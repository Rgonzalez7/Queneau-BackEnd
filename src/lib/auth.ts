import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import type { DB, User, PublicUser, Role } from "./types";
import { uid, HttpError } from "./constants";

/* ============================================================================
 * AUTH — registro/login por email+contraseña y por Google, con gate de edad
 * (18+), sesión por JWT en cookie httpOnly y un superusuario (admin) por env.
 * ==========================================================================*/

export const COOKIE_NAME = "queneau_session";
const TOKEN_TTL_DAYS = 30;

// Secreto de firma. En prod DEBE venir por entorno; en local hay un fallback
// para no bloquear el desarrollo (con aviso).
const JWT_SECRET =
  process.env.JWT_SECRET ||
  (() => {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Falta JWT_SECRET en producción");
    }
    console.warn("[auth] JWT_SECRET no definido: usando secreto de desarrollo (NO usar en prod)");
    return "dev-secret-solo-para-local-cambia-esto";
  })();

// Superusuarios por env. Acepta varias formas para dos (o más) correos:
//  - SUPERUSER_EMAIL="a@x.com,b@y.com"  (lista separada por coma/espacio/;)
//  - SUPERUSER_EMAIL="a@x.com"  +  SUPERUSER_EMAIL_2="b@y.com"
//  - SUPERUSER_EMAILS="a@x.com b@y.com"
const SUPERUSER_EMAILS: Set<string> = new Set(
  [process.env.SUPERUSER_EMAIL, process.env.SUPERUSER_EMAIL_2, process.env.SUPERUSER_EMAILS]
    .filter(Boolean)
    .join(",")
    .split(/[,\s;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

/* ------------------------------- utilidades ------------------------------- */
export const normEmail = (e: string): string => (e || "").trim().toLowerCase();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validEmail(e: string): boolean {
  return EMAIL_RE.test(normEmail(e));
}

/** Rol según el correo: cualquier correo en SUPERUSER_EMAILS es admin. */
export function roleFor(email: string): Role {
  return SUPERUSER_EMAILS.has(normEmail(email)) ? "admin" : "user";
}

/** Edad en años a partir de una fecha ISO YYYY-MM-DD. */
export function ageFromDOB(dob: string): number {
  const d = new Date(dob);
  if (isNaN(d.getTime())) return NaN;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}
export function isAdultDOB(dob: string): boolean {
  const age = ageFromDOB(dob);
  return Number.isFinite(age) && age >= 18 && age < 120;
}

/* ------------------------------ contraseñas ------------------------------ */
export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 12);
}
export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(pw, hash);
  } catch {
    return false;
  }
}
/** Requisitos mínimos de contraseña (razonables, no molestos). */
export function validPassword(pw: string): boolean {
  return typeof pw === "string" && pw.length >= 8 && pw.length <= 200;
}

/* --------------------------------- JWT ----------------------------------- */
interface TokenPayload { sub: string; role: Role }

export function signToken(user: Pick<User, "id" | "role">): string {
  const payload: TokenPayload = { sub: user.id, role: user.role };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: `${TOKEN_TTL_DAYS}d` });
}
export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

/* -------------------------------- Google --------------------------------- */
/** Verifica un ID token de Google Identity Services. Devuelve datos básicos. */
export async function verifyGoogleIdToken(
  idToken: string
): Promise<{ googleId: string; email: string; name: string }> {
  if (!googleClient) throw new HttpError(500, "Google no está configurado (falta GOOGLE_CLIENT_ID)");
  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  } catch {
    throw new HttpError(401, "Token de Google inválido");
  }
  const p = ticket.getPayload();
  if (!p || !p.sub || !p.email) throw new HttpError(401, "Token de Google incompleto");
  if (p.email_verified === false) throw new HttpError(401, "El correo de Google no está verificado");
  return { googleId: p.sub, email: normEmail(p.email), name: p.name || p.email.split("@")[0] };
}

/* ------------------------------- cookies --------------------------------- */
/* Front (Vercel) y back (Fly) son dominios distintos → la cookie de sesión
   debe ser SameSite=None; Secure para viajar cross-site. En local se relaja. */
function cookieOpts() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: (isProd ? "none" : "lax") as "none" | "lax",
    maxAge: TOKEN_TTL_DAYS * 24 * 3600 * 1000,
    path: "/",
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  };
}
export function setAuthCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, cookieOpts());
}
export function clearAuthCookie(res: Response): void {
  const { maxAge, ...rest } = cookieOpts();
  void maxAge;
  res.clearCookie(COOKIE_NAME, rest);
}

/* ---------------------------- vista pública ------------------------------ */
export function publicUser(u: User): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    adult: isAdultDOB(u.dateOfBirth),
    avatar: u.avatar,
    avatarBg: u.avatarBg,
    createdAt: u.createdAt,
  };
}

/* ----------------------------- DB helpers -------------------------------- */
export function findUserByEmail(db: DB, email: string): User | undefined {
  const e = normEmail(email);
  return (db.users || []).find((u) => u.email === e);
}
export function findUserById(db: DB, id: string): User | undefined {
  return (db.users || []).find((u) => u.id === id);
}
export function findUserByGoogle(db: DB, googleId: string): User | undefined {
  return (db.users || []).find((u) => u.googleId === googleId);
}

/** Crea un usuario y, si es el superusuario, reclama los datos legados
 *  (perfiles/historias sin dueño) para que no queden huérfanos. */
export function createUser(db: DB, data: Omit<User, "id" | "role" | "createdAt">): User {
  if (!db.users) db.users = [];
  const user: User = {
    id: uid() + uid(),
    role: roleFor(data.email),
    createdAt: Date.now(),
    ...data,
    email: normEmail(data.email),
  };
  user.envAdmin = user.role === "admin"; // creado como admin por el env
  db.users.push(user);

  if (user.role === "admin") claimOrphans(db, user.id);
  return user;
}

/** Asigna al `ownerId` dado todo perfil/historia sin dueño (migración suave). */
export function claimOrphans(db: DB, ownerId: string): number {
  let n = 0;
  for (const p of db.profiles) if (!p.ownerId) { p.ownerId = ownerId; n++; }
  for (const s of db.stories) if (!s.ownerId) { s.ownerId = ownerId; n++; }
  return n;
}

/** Sincroniza el rol de UN usuario con SUPERUSER_EMAIL:
 *  - si su correo coincide y no es admin → lo promueve (admin por env) + reclama huérfanos.
 *  - si es admin POR ENV pero su correo ya NO coincide → lo degrada.
 *  Nunca toca admins manuales (envAdmin != true). Devuelve true si cambió algo. */
export function ensureSuperuser(db: DB, user: User): boolean {
  const shouldBeAdmin = roleFor(user.email) === "admin";
  if (shouldBeAdmin && user.role !== "admin") {
    user.role = "admin";
    user.envAdmin = true;
    claimOrphans(db, user.id);
    return true;
  }
  // envAdmin !== false => admin por env o heredado (sin flag). Los admins
  // MANUALES del panel quedan con envAdmin === false y NO se degradan.
  if (!shouldBeAdmin && user.role === "admin" && user.envAdmin !== false) {
    user.role = "user";
    user.envAdmin = false;
    return true;
  }
  return false;
}

/** Reconcilia TODOS los usuarios con SUPERUSER_EMAIL (se llama al arrancar):
 *  promueve al correo del env y degrada a cualquier admin-por-env obsoleto. */
export function reconcileSuperusers(db: DB): number {
  let n = 0;
  for (const u of db.users || []) if (ensureSuperuser(db, u)) n++;
  return n;
}

/* ------------------------------ middleware ------------------------------- */
/* Augmenta Request con el usuario autenticado (o null). */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { id: string; role: Role } | null;
    }
  }
}

/** Lee la cookie y adjunta req.auth (o null). No bloquea. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = (req.cookies && req.cookies[COOKIE_NAME]) || bearer(req);
  const payload = token ? verifyToken(token) : null;
  req.auth = payload ? { id: payload.sub, role: payload.role } : null;
  next();
}
function bearer(req: Request): string | null {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

/** Exige sesión válida. Úsalo tras `authenticate`. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) throw new HttpError(401, "Inicia sesión para continuar");
  next();
}
/** Exige rol admin (superusuario). */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) throw new HttpError(401, "Inicia sesión para continuar");
  if (req.auth.role !== "admin") throw new HttpError(403, "Requiere permisos de administrador");
  next();
}

/** Resuelve el usuario completo desde req.auth, verificando que existe y no está
 *  suspendido. Lanza 401/403 si algo no cuadra. */
export function currentUser(db: DB, req: Request): User {
  const id = req.auth?.id;
  const u = id ? findUserById(db, id) : undefined;
  if (!u) throw new HttpError(401, "Sesión inválida");
  if (u.suspended) throw new HttpError(403, "Cuenta suspendida");
  return u;
}

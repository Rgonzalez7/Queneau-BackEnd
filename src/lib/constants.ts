import type { FormatKey, FormatInfo } from "./types";

export const FORMATS: Record<FormatKey, FormatInfo> = {
  corta: { chapters: 10, price: 4.99, label: "Corta" },
  completa: { chapters: 24, price: 9.99, label: "Completa" },
  saga: { chapters: 20, price: 24.99, label: "Saga" }, // por libro; encadena secuelas
};

export const FREE_QUOTA = 3; // R1: 3 aperturas gratis activas
export const OPENING_TTL_MS = 30 * 24 * 3600 * 1000; // R2: 30 días

export const uid = (): string => Math.random().toString(36).slice(2, 10);

// Error con código HTTP para los route handlers
export class HttpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

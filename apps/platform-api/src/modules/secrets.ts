import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
/** Identificador de sesión: 256 bits aleatorios. Solo viaja en la cookie; en BD va su SHA-256. */
export const newSessionToken = () => randomBytes(32).toString('base64url');
export const isTokenShaped = (t: string) => /^[A-Za-z0-9_-]{43}$/.test(t);
/** Contraseña inicial generada (96 bits): se muestra UNA vez y nunca se registra. */
export const generatePassword = () => randomBytes(12).toString('base64url');

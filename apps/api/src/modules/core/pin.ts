import { createHmac, randomInt } from 'node:crypto';

export const PIN_LENGTH = 6;

/** PIN triviales que se descartan al generar: todos iguales o secuencias simples. */
export function isTrivialPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const ascending = '0123456789012345';
  const descending = '9876543210987654';
  return ascending.includes(pin) || descending.includes(pin);
}

/** PIN aleatorio criptográfico de 6 dígitos (con ceros a la izquierda), sin PIN triviales. */
export function generatePin(random: (maxExclusive: number) => number = (n) => randomInt(0, n)): string {
  for (let i = 0; i < 100; i += 1) {
    const pin = String(random(10 ** PIN_LENGTH)).padStart(PIN_LENGTH, '0');
    if (!isTrivialPin(pin)) return pin;
  }
  throw new Error('No se pudo generar un PIN no trivial');
}

export function isWellFormedPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

/**
 * Hash del PIN: HMAC-SHA256(pepper, organización ‖ ':' ‖ PIN).
 *  - El PIN nunca se guarda en claro.
 *  - El pepper vive fuera de la base de datos (con 6 dígitos, un hash sin secreto se rompería en segundos).
 *  - Incluir la organización hace que el mismo PIN en dos negocios produzca hashes distintos.
 *  - Es determinista a propósito: el kiosco identifica por PIN y la unicidad por negocio la impone un índice.
 */
export function hashPin(pin: string, organizationId: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`${organizationId}:${pin}`).digest('hex');
}

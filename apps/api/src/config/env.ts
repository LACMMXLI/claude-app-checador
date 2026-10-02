/** Lee variables de entorno obligatorias con mensajes claros. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : fallback;
}

/** El pepper del PIN debe ser un secreto largo, fuera de la base de datos. */
export function requirePinPepper(): string {
  const pepper = requireEnv('PIN_PEPPER');
  if (pepper.length < 32) {
    throw new Error('PIN_PEPPER debe tener al menos 32 caracteres');
  }
  return pepper;
}

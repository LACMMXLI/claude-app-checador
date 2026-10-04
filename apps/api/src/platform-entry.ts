/**
 * Punto de entrada para la CONSOLA DE PLATAFORMA (`apps/platform-api`, D-81). Reexporta únicamente lo que el plano de
 * plataforma reutiliza para no duplicar reglas: el aprovisionamiento de negocios, el esquema, el hash de contraseñas,
 * los errores de dominio y la preparación de la base de datos. La API de clientes NO importa este archivo.
 */
export { PlatformDb } from './common/tenancy/platform-db.js';
export type { Tx } from './common/tenancy/tenant-db.js';
export { DomainError, isPgError, raisedCode } from './common/errors.js';
export { PlatformAdminService, createOrganizationSchema, type ProvisionedOrganization } from './modules/organizations/provisioning.service.js';
export { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from './modules/auth/password.js';
export { isValidTimezone } from './common/time.js';
export { trustProxyFn, clientIp, trustedProxyConfigFromEnv, type TrustedProxyConfig } from './http/client-ip.js';
export { createPool } from './db/pool.js';
export { bootstrapRoles } from './db/bootstrap.js';
export { migrate, MIGRATIONS_DIR } from './db/migrate.js';
export { optionalEnv, requireEnv } from './config/env.js';
export * as schema from './db/schema/index.js';

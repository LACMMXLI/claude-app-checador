import { z } from 'zod';
import { DomainError } from '../../common/errors.js';

/**
 * Jerarquía de políticas (D-20): Plataforma → Negocio → Sucursal → Empleado.
 * Solo se guardan OVERRIDES; la política efectiva se calcula. Cada parámetro declara hasta qué
 * nivel puede sobrescribirse (también reforzado con CHECKs en PostgreSQL).
 */
export type PolicyScope = 'ORGANIZATION' | 'BRANCH' | 'EMPLOYEE';
export const POLICY_SCOPES: readonly PolicyScope[] = ['ORGANIZATION', 'BRANCH', 'EMPLOYEE'];

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'HH:MM');

interface ParamDef {
  schema: z.ZodType;
  /** Niveles en los que se permite un override. */
  scopes: readonly PolicyScope[];
}

const ALL: readonly PolicyScope[] = ['ORGANIZATION', 'BRANCH', 'EMPLOYEE'];
const UP_TO_BRANCH: readonly PolicyScope[] = ['ORGANIZATION', 'BRANCH'];
const ORG_ONLY: readonly PolicyScope[] = ['ORGANIZATION'];

export const POLICY_PARAMS = {
  entryToleranceMin: { schema: int(0, 240), scopes: ALL },
  exitToleranceMin: { schema: int(0, 240), scopes: ALL },
  maxBreaks: { schema: int(0, 10), scopes: ALL },
  breakAllowedMin: { schema: int(0, 600), scopes: ALL },
  breakToleranceMin: { schema: int(0, 120), scopes: ALL },
  requireBreak: { schema: z.boolean(), scopes: ALL },
  earlyEntryWindowMin: { schema: int(0, 720), scopes: UP_TO_BRANCH },
  absentAfterMin: { schema: int(1, 720), scopes: UP_TO_BRANCH },
  operationalCutoff: { schema: time, scopes: UP_TO_BRANCH },
  maxHoursUnscheduled: { schema: int(1, 48), scopes: UP_TO_BRANCH },
  debounceSec: { schema: int(0, 3600), scopes: UP_TO_BRANCH },
  pinMaxAttempts: { schema: int(1, 20), scopes: UP_TO_BRANCH },
  pinLockoutSec: { schema: int(1, 3600), scopes: UP_TO_BRANCH },
  weekStartDay: { schema: int(1, 7), scopes: ORG_ONLY },
} as const satisfies Record<string, ParamDef>;

export type PolicyKey = keyof typeof POLICY_PARAMS;
export const POLICY_KEYS = Object.keys(POLICY_PARAMS) as PolicyKey[];

export interface EffectivePolicy {
  entryToleranceMin: number;
  exitToleranceMin: number;
  maxBreaks: number;
  breakAllowedMin: number;
  breakToleranceMin: number;
  requireBreak: boolean;
  earlyEntryWindowMin: number;
  absentAfterMin: number;
  operationalCutoff: string;
  maxHoursUnscheduled: number;
  debounceSec: number;
  pinMaxAttempts: number;
  pinLockoutSec: number;
  weekStartDay: number;
}

/** Un nivel de la jerarquía: solo los parámetros sobrescritos (los ausentes/null heredan). */
export type PolicyLayer = Partial<{ [K in PolicyKey]: EffectivePolicy[K] | null }>;

/** Qué nivel aportó cada parámetro (útil para explicar la política en el panel). */
export type PolicySource = 'PLATFORM' | PolicyScope;

export interface ResolvedPolicy {
  policy: EffectivePolicy;
  sources: Record<PolicyKey, PolicySource>;
}

/**
 * Política efectiva: parte del nivel plataforma (completo) y aplica, en orden, los overrides de
 * Negocio, Sucursal y Empleado. El más específico gana, parámetro por parámetro.
 */
export function resolvePolicy(
  platform: EffectivePolicy,
  layers: { organization?: PolicyLayer; branch?: PolicyLayer; employee?: PolicyLayer },
): ResolvedPolicy {
  const policy: Record<string, unknown> = { ...platform };
  const sources = Object.fromEntries(POLICY_KEYS.map((k) => [k, 'PLATFORM'])) as Record<PolicyKey, PolicySource>;
  const ordered: [PolicyScope, PolicyLayer | undefined][] = [
    ['ORGANIZATION', layers.organization],
    ['BRANCH', layers.branch],
    ['EMPLOYEE', layers.employee],
  ];
  for (const [scope, layer] of ordered) {
    if (!layer) continue;
    for (const key of POLICY_KEYS) {
      const value = layer[key];
      if (value !== undefined && value !== null) {
        policy[key] = value;
        sources[key] = scope;
      }
    }
  }
  return { policy: policy as unknown as EffectivePolicy, sources };
}

/** Valida valores y niveles permitidos de un override. Devuelve los parámetros limpios. */
export function validateOverride(scope: PolicyScope, values: PolicyLayer): PolicyLayer {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!(key in POLICY_PARAMS)) throw new DomainError('POLICY_PARAM_UNKNOWN', { key });
    const def = POLICY_PARAMS[key as PolicyKey] as ParamDef;
    if (!def.scopes.includes(scope)) {
      throw new DomainError('POLICY_SCOPE_NOT_ALLOWED', { key, scope });
    }
    if (value === null) {
      clean[key] = null; // null = quitar el override (vuelve a heredar)
      continue;
    }
    const parsed = def.schema.safeParse(value);
    if (!parsed.success) throw new DomainError('POLICY_VALUE_INVALID', { key });
    clean[key] = parsed.data;
  }
  return clean as PolicyLayer;
}

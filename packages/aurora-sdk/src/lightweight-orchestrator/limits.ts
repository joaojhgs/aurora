import { AuroraError } from '../errors.js'
import type { JsonValue } from '../types.js'

export const DEFAULT_LIGHTWEIGHT_ORCHESTRATOR_LIMITS = Object.freeze({
  maxIterations: 6,
  maxTotalTools: 12,
  maxToolsPerIteration: 4,
  maxToolSchemas: 32,
  maxToolSchemasBytes: 64 * 1024,
  maxArgsBytes: 16 * 1024,
  maxResultBytes: 32 * 1024,
  maxHistoryMessages: 40,
  maxPromptBytes: 64 * 1024,
  maxProviderRequestBytes: 128 * 1024,
  maxProviderResponseBytes: 256 * 1024,
  turnTimeoutMs: 60_000,
  providerCallTimeoutMs: 20_000,
  confirmationTokenTimeoutMs: 300_000
})

export type LightweightOrchestratorLimits = typeof DEFAULT_LIGHTWEIGHT_ORCHESTRATOR_LIMITS

export type LightweightLimitName = keyof LightweightOrchestratorLimits

export class LightweightOrchestratorError extends AuroraError {
  readonly reasonCode: string

  constructor(reasonCode: string, message = 'Lightweight assistant request failed', detail?: unknown) {
    super({ code: reasonCode.includes('timeout') ? 'timeout' : 'validation', message, detail })
    this.name = 'LightweightOrchestratorError'
    this.reasonCode = reasonCode
  }
}

export function resolveLightweightOrchestratorLimits(
  overrides: Partial<LightweightOrchestratorLimits> = {}
): LightweightOrchestratorLimits {
  const merged = {
    ...DEFAULT_LIGHTWEIGHT_ORCHESTRATOR_LIMITS,
    ...overrides
  }
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new LightweightOrchestratorError('invalid_limit', 'Lightweight assistant limit must be a positive safe integer', { limit: key })
    }
  }
  return Object.freeze(merged)
}

export function assertSerializedBound(value: JsonValue | unknown, maxBytes: number, reasonCode: string): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new LightweightOrchestratorError(reasonCode, 'Lightweight assistant payload could not be serialized')
  }
  if (serialized === undefined || byteLength(serialized) > maxBytes) {
    throw new LightweightOrchestratorError(reasonCode, 'Lightweight assistant payload exceeded its bound', {
      maxBytes,
      actualBytes: serialized === undefined ? null : byteLength(serialized)
    })
  }
  return serialized
}

export function assertTextBound(value: string, maxBytes: number, reasonCode: string): string {
  if (byteLength(value) > maxBytes) {
    throw new LightweightOrchestratorError(reasonCode, 'Lightweight assistant text exceeded its bound', {
      maxBytes,
      actualBytes: byteLength(value)
    })
  }
  return value
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function redactedDiagnostic(reasonCode: string, detail: Record<string, JsonValue> = {}) {
  return {
    reasonCode,
    detail,
    secretsRedacted: true as const,
    redactedFields: ['prompt', 'arguments', 'result', 'providerResponse', 'error']
  }
}

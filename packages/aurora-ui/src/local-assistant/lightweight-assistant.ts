import {
  createLightweightOrchestrator,
  type LightweightAssistantProvider,
  type LightweightOrchestrator,
  type LightweightOrchestratorLimits,
  type LightweightToolClientPort,
} from '@aurora/client/lightweight-orchestrator'
import type { EnvelopeCryptoPort, LocalDataScope, LocalDataSession } from '@aurora/client/local-data'
import type { ToolingProjectionToolInfo } from '@aurora/client'

export interface LightweightAssistantDependencies {
  readonly provider?: LightweightAssistantProvider | null
  readonly tools?: LightweightToolClientPort | null
  readonly localData?: LocalDataSession | null
  readonly envelopeCrypto?: EnvelopeCryptoPort | null
  readonly scope?: LocalDataScope | null
  readonly availableTools?: readonly ToolingProjectionToolInfo[] | null
  readonly approvalPrincipalId?: string | null
  readonly limits?: Partial<LightweightOrchestratorLimits>
  readonly ids?: () => string
  readonly nowMs?: () => number
}

interface ReadyDependencies {
  readonly provider: LightweightAssistantProvider
  readonly tools: LightweightToolClientPort
  readonly localData: LocalDataSession
  readonly envelopeCrypto: EnvelopeCryptoPort
  readonly scope: LocalDataScope
  readonly availableTools: readonly ToolingProjectionToolInfo[]
}

export function isLightweightLocalAssistantAvailable(
  input: LightweightAssistantDependencies,
): boolean {
  return resolveReadiness(input).ready
}

export function createLightweightAssistantOrchestrator(
  input: LightweightAssistantDependencies,
): LightweightOrchestrator | null {
  const readiness = resolveReadiness(input)
  if (!readiness.ready) return null
  try {
    return createLightweightOrchestrator({
      provider: readiness.provider,
      tools: readiness.tools,
      localData: readiness.localData,
      localDataCrypto: readiness.envelopeCrypto,
      scope: readiness.scope,
      availableTools: readiness.availableTools,
      ...(input.approvalPrincipalId === undefined
        ? {}
        : { approvalPrincipalId: input.approvalPrincipalId }),
      ...(input.limits === undefined ? {} : { limits: input.limits }),
      ...(input.ids === undefined ? {} : { ids: input.ids }),
      ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    })
  } catch {
    return null
  }
}

function resolveReadiness(
  input: LightweightAssistantDependencies,
): { ready: false } | ({ ready: true } & ReadyDependencies) {
  if (
    input.provider === undefined ||
    input.provider === null ||
    input.tools === undefined ||
    input.tools === null ||
    input.localData === undefined ||
    input.localData === null ||
    input.envelopeCrypto === undefined ||
    input.envelopeCrypto === null ||
    input.scope === undefined ||
    input.scope === null ||
    input.availableTools === undefined ||
    input.availableTools === null
  ) {
    return { ready: false }
  }
  return {
    ready: true,
    provider: input.provider,
    tools: input.tools,
    localData: input.localData,
    envelopeCrypto: input.envelopeCrypto,
    scope: input.scope,
    availableTools: input.availableTools,
  }
}

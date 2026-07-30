'use client'

import type {
  LightweightAssistantProvider,
  LightweightProviderRequest,
  LightweightProviderResponse,
} from '@aurora/client/lightweight-orchestrator'
import { loadLightweightRemoteProjectionCatalog } from '@aurora/client/lightweight-orchestrator'
import type {
  AuroraBrowserLightweightAssistantConfig,
  AuroraBrowserRuntime,
} from './aurora-client'

const ASSISTANT_COMPLETION_ROUTE = '/api/assistant/completion'

export async function createAuroraBrowserLocalAssistantConfig(
  runtime: AuroraBrowserRuntime,
): Promise<AuroraBrowserLightweightAssistantConfig | null> {
  if (!runtime.features?.lightweightOrchestratorEnabled) return null
  if (!runtime.localData || !runtime.localNodeProviderStatus.localDataWritable || !runtime.localToolProvider) {
    return null
  }
  const enabled = await loadAssistantCompletionEnabled()
  if (!enabled) return null
  const remoteTools = await loadRemoteProjectionTools(runtime)
  return {
    provider: createSameOriginAssistantProvider(),
    remoteTools,
  }
}

function createSameOriginAssistantProvider(): LightweightAssistantProvider {
  return {
    async complete(request: LightweightProviderRequest): Promise<LightweightProviderResponse> {
      const response = await fetch(ASSISTANT_COMPLETION_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: request.messages,
          tools: request.tools,
          maxToolCalls: request.maxToolCalls,
        }),
        signal: request.signal,
      })
      if (!response.ok) throw new Error('assistant_unavailable')
      return await response.json() as LightweightProviderResponse
    },
  }
}

async function loadAssistantCompletionEnabled(): Promise<boolean> {
  try {
    const response = await fetch(ASSISTANT_COMPLETION_ROUTE, {
      method: 'GET',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const body = await response.json() as { enabled?: unknown }
    return body.enabled === true
  } catch {
    return false
  }
}

async function loadRemoteProjectionTools(
  runtime: AuroraBrowserRuntime,
): Promise<Awaited<ReturnType<typeof loadLightweightRemoteProjectionCatalog>>['tools']> {
  try {
    const snapshot = await loadLightweightRemoteProjectionCatalog(
      runtime.client.tools,
      { pageSize: 100, maxPages: 16 },
    )
    return snapshot.tools
  } catch {
    return []
  }
}

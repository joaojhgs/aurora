'use client'

import type {
  ToolingGetExportCatalogResponse,
  ToolingProjectionToolInfo,
} from '@aurora/client'
import type {
  LightweightAssistantProvider,
  LightweightProviderRequest,
  LightweightProviderResponse,
} from '@aurora/client/lightweight-orchestrator'
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
  if (!remoteTools) return null
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
): Promise<readonly ToolingProjectionToolInfo[] | null> {
  const tools: ToolingProjectionToolInfo[] = []
  let cursor: string | null = null
  for (let page = 0; page < 16; page += 1) {
    let response: ToolingGetExportCatalogResponse
    try {
      response = await runtime.client.tools.getExportCatalog({
        protocol_tier: 'projection_v1',
        page_size: 100,
        cursor,
      })
    } catch {
      return null
    }
    if (response.ok !== true || response.selected_protocol_tier !== 'projection_v1') return null
    tools.push(...response.tools)
    if (response.complete === true) return tools
    cursor = response.next_cursor
    if (!cursor) return null
  }
  return null
}

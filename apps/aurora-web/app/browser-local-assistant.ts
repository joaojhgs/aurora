'use client'

import type {
  ToolingGetExportCatalogResponse,
  ToolingProjectionToolInfo,
} from '@aurora/client'
import { parseToolingExportCatalogPage } from '@aurora/client'
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
): Promise<readonly ToolingProjectionToolInfo[]> {
  const tools: ToolingProjectionToolInfo[] = []
  let cursor: string | null = null
  let continuity: ProjectionContinuity | null = null
  for (let page = 0; page < 16; page += 1) {
    let rawResponse: unknown
    try {
      rawResponse = await runtime.client.tools.getExportCatalog({
        protocol_tier: 'projection_v1',
        page_size: 100,
        cursor,
        last_projection_revision: continuity?.projectionRevision ?? null,
        last_projection_digest: continuity?.projectionDigest ?? null,
      })
    } catch {
      return []
    }
    const parsed = parseToolingExportCatalogPage(rawResponse)
    if (!parsed.ok) return []
    const response = parsed.page
    if (!projectionContinuityMatches(response, continuity)) return []
    continuity ??= projectionContinuity(response)
    tools.push(...response.tools.filter(remoteToolAvailable))
    if (response.complete === true) return tools
    cursor = response.next_cursor
    if (!cursor) return []
  }
  return []
}

interface ProjectionContinuity {
  readonly providerPeerId: string
  readonly serviceInstanceId: string
  readonly projectionRevision: string
  readonly projectionDigest: string
  readonly authorityRevision: string
}

function projectionContinuity(page: ToolingGetExportCatalogResponse): ProjectionContinuity {
  return {
    providerPeerId: page.provider_peer_id,
    serviceInstanceId: page.service_instance_id,
    projectionRevision: page.projection_revision,
    projectionDigest: page.projection_digest,
    authorityRevision: JSON.stringify(page.authority_revision),
  }
}

function projectionContinuityMatches(
  page: ToolingGetExportCatalogResponse,
  continuity: ProjectionContinuity | null,
): boolean {
  if (!continuity) return page.page_index === 0
  return (
    page.provider_peer_id === continuity.providerPeerId
    && page.service_instance_id === continuity.serviceInstanceId
    && page.projection_revision === continuity.projectionRevision
    && page.projection_digest === continuity.projectionDigest
    && JSON.stringify(page.authority_revision) === continuity.authorityRevision
  )
}

function remoteToolAvailable(tool: ToolingProjectionToolInfo): boolean {
  return tool.execution_location === 'remote'
    && tool.exportable === true
    && tool.provider_available === true
}

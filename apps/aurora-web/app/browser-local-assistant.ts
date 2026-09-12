'use client'

import { loadLightweightRemoteProjectionCatalog } from '@aurora/client/lightweight-orchestrator'
import {
  createAuroraBrowserAssistantProvider,
  loadAuroraBrowserAssistantAvailability,
  type AuroraBrowserLightweightAssistantConfig,
  type AuroraBrowserRuntime,
} from './aurora-client'

export async function createAuroraBrowserLocalAssistantConfig(
  runtime: AuroraBrowserRuntime,
): Promise<AuroraBrowserLightweightAssistantConfig | null> {
  if (!runtime.features?.lightweightOrchestratorEnabled) return null
  if (!runtime.localData || !runtime.localNodeProviderStatus.localDataWritable || !runtime.localToolProvider) {
    return null
  }
  const bearerToken = () => runtime.client.auth.bearerToken()
  const enabled = await loadAuroraBrowserAssistantAvailability({ bearerToken })
  if (!enabled) return null
  const remoteTools = await loadRemoteProjectionTools(runtime)
  return {
    provider: createAuroraBrowserAssistantProvider({ bearerToken }),
    remoteTools,
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

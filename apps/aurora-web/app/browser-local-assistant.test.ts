import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ToolingGetExportCatalogResponse,
  ToolingProjectionToolInfo,
} from '@aurora/client'
import { createAuroraBrowserLocalAssistantConfig } from './browser-local-assistant'
import type { AuroraBrowserRuntime } from './aurora-client'

describe('createAuroraBrowserLocalAssistantConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('omits the browser assistant when the same-origin provider route is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ enabled: false }), { status: 404 })))

    await expect(createAuroraBrowserLocalAssistantConfig(fakeRuntime())).resolves.toBeNull()
  })

  it('keeps the local-tool-only assistant when remote projection tools fail to load', async () => {
    const fetch = vi.fn(async () => jsonResponse({ enabled: true }))
    vi.stubGlobal('fetch', fetch)
    const runtime = fakeRuntime({
      getExportCatalog: vi.fn(async () => {
        throw new Error('projection unavailable')
      }),
    })

    await expect(createAuroraBrowserLocalAssistantConfig(runtime)).resolves.toMatchObject({ remoteTools: [] })
    expect(fetch).toHaveBeenCalledWith('/api/assistant/completion', expect.objectContaining({ method: 'GET' }))
  })

  it('builds a same-origin provider and filters parsed available remote tools without exposing a raw provider key', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ enabled: true }))
      .mockResolvedValueOnce(jsonResponse({ type: 'message', content: 'Ready.' }))
    vi.stubGlobal('fetch', fetch)
    const remoteTool = projectionTool('remote.weather', 'remote')
    const unavailableRemoteTool = {
      ...projectionTool('remote.unavailable', 'remote'),
      provider_available: false,
    }
    const localProjectionTool = projectionTool('local.status', 'local')
    const runtime = fakeRuntime({
      getExportCatalog: vi.fn(async () => completeProjectionPage([remoteTool, unavailableRemoteTool, localProjectionTool])),
    })

    const config = await createAuroraBrowserLocalAssistantConfig(runtime)
    const response = await config?.provider.complete({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: config.remoteTools ?? [],
      maxToolCalls: 1,
      signal: new AbortController().signal,
    })

    expect(config?.remoteTools).toEqual([remoteTool])
    expect(response).toEqual({ type: 'message', content: 'Ready.' })
    expect(fetch).toHaveBeenLastCalledWith('/api/assistant/completion', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: expect.stringContaining('remote.weather'),
    }))
    const browserSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'browser-local-assistant.ts'), 'utf8')
    expect(browserSource).not.toMatch(/AURORA_LIGHTWEIGHT_ASSISTANT_API_KEY|apiKey|authorization/i)
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('provider-secret')
  })

  it('returns local-tool-only when projection identity changes across pages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ enabled: true })))
    const firstPage = partialProjectionPage([projectionTool('remote.weather', 'remote')], 'next-page')
    const secondPage = {
      ...completeProjectionPage([projectionTool('remote.files', 'remote')]),
      provider_peer_id: 'different-peer',
      page_index: 1,
    }
    const getExportCatalog = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)

    const config = await createAuroraBrowserLocalAssistantConfig(fakeRuntime({ getExportCatalog }))

    expect(config?.remoteTools).toEqual([])
    expect(getExportCatalog).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: 'next-page',
      last_projection_revision: firstPage.projection_revision,
      last_projection_digest: firstPage.projection_digest,
    }))
  })

  it('returns local-tool-only when projection pages do not pass the SDK parser', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ enabled: true })))
    const getExportCatalog = vi.fn(async () => ({
      ok: true,
      tools: [projectionTool('legacy.weather', 'remote')],
    }))

    const config = await createAuroraBrowserLocalAssistantConfig(fakeRuntime({ getExportCatalog }))

    expect(config?.remoteTools).toEqual([])
  })
})

function fakeRuntime(overrides: {
  getExportCatalog?: () => Promise<unknown>
} = {}): AuroraBrowserRuntime {
  return {
    features: {
      requestedNodeRole: 'mesh-node',
      activeNodeRole: 'mesh-node',
      meshNodeRuntimeEnabled: true,
      localToolProviderEnabled: true,
      lightweightOrchestratorEnabled: true,
    },
    localData: {
      session: { profileId: 'profile-1', localNodeId: 'node-1' },
      backend: {},
      crypto: {},
    },
    localToolProvider: {},
    localNodeProviderStatus: {
      available: true,
      state: 'available',
      productMessage: 'This device is available for sharing.',
      registeredFeatureCount: 1,
      localDataWritable: true,
    },
    client: {
      tools: {
        getExportCatalog: overrides.getExportCatalog ?? vi.fn(async () => completeProjectionPage([])),
      },
    },
  } as unknown as AuroraBrowserRuntime
}

function completeProjectionPage(tools: readonly ToolingProjectionToolInfo[]): ToolingGetExportCatalogResponse {
  return {
    ok: true,
    provider_peer_id: 'peer-python',
    service_instance_id: 'python:Tooling',
    selected_protocol_tier: 'projection_v1',
    authority_revision: {
      catalog_revision: 1,
      export_policy_revision: 1,
      auth_grant_revision: 1,
      manifest_revision: 1,
      switch_revision: 1,
      protocol_revision: 1,
    },
    projection_revision: 'projection-1',
    projection_digest: 'a'.repeat(64),
    page_index: 0,
    page_size: 100,
    page_hash: 'b'.repeat(64),
    tools: [...tools],
    retirements: [],
    complete: true,
    total_count: tools.length,
    final_checksum: 'c'.repeat(64),
  }
}

function partialProjectionPage(
  tools: readonly ToolingProjectionToolInfo[],
  nextCursor: string,
): ToolingGetExportCatalogResponse {
  const page = completeProjectionPage(tools)
  return {
    ...page,
    complete: false,
    next_cursor: nextCursor,
    total_count: undefined as never,
    final_checksum: undefined as never,
  }
}

function projectionTool(id: string, executionLocation: 'local' | 'remote'): ToolingProjectionToolInfo {
  return {
    name: id,
    local_name: id,
    global_tool_id: id,
    tool_id_scheme: 'aurora-tool',
    tool_id_version: 1,
    tool_contract_id: id,
    share_group_id: 'group-1',
    share_group_label: 'Tools',
    legacy_global_tool_ids: [],
    exportable: true,
    provider_peer_id: 'peer-python',
    provider_service_instance_id: 'python:Tooling',
    provider_available: true,
    namespace: 'remote',
    display_name: 'Weather',
    aliases: [],
    description: 'Look up weather.',
    args_schema: { type: 'object', properties: {} },
    schema: { type: 'object', properties: {} },
    argument_visibility: {},
    source_type: 'mesh_peer',
    source: 'mesh_peer',
    trust_tier: 'trusted',
    capability_class: 'read',
    resource_scope: [],
    execution_location: executionLocation,
    safety_class: 'safe',
    risk_class: 'low',
    data_egress: false,
    mutating: false,
    external: false,
    admin: false,
    privacy_hints: [],
    required_permissions: ['Tooling.ExecuteTool'],
    confirmation_required: false,
    provenance: {
      provider_kind: 'mesh_peer',
      provider_peer_id: 'peer-python',
      provider_service_instance_id: 'python:Tooling',
      source: 'mesh_peer',
      advertised_name: 'Weather',
    },
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

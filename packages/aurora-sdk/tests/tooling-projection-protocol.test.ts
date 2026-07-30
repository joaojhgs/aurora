import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  AuroraClient,
  MockAuroraTransport,
  TOOLING_METHODS,
  normalizePolicyOverrides,
  normalizeToolingMeshKillSwitches,
  normalizeToolingRemoteCatalogStatus,
  parseToolingExportCatalogPage,
  type AuroraTransportRequest,
  type ToolingGetExportCatalogRequest,
  type ToolingGetExportCatalogResponse,
  type ToolingProjectionInvalidated,
  type ToolingProjectionSyncRequested,
  type ToolingRemoteAvailability,
} from '../src/index.js'

const digest = 'a'.repeat(64)
const pageHash = 'b'.repeat(64)
const checksum = 'c'.repeat(64)
const authority = {
  catalog_revision: 11,
  export_policy_revision: 7,
  auth_grant_revision: 5,
  manifest_revision: 3,
  switch_revision: 2,
  protocol_revision: 1,
}

describe('Tooling projection-v1 SDK protocol', () => {
  it('serializes an authenticated projection request without a trusted peer selector', async () => {
    const requests: AuroraTransportRequest[] = []
    const completePage = projectionPage({
      complete: true,
      next_cursor: null,
      total_count: 0,
      final_checksum: checksum,
    })
    const transport = MockAuroraTransport.empty().register(TOOLING_METHODS.getExportCatalog, (request) => {
      requests.push(request)
      return completePage
    })
    const client = new AuroraClient({ transport })
    const request: ToolingGetExportCatalogRequest = {
      protocol_tier: 'projection_v1',
      page_size: 64,
      cursor: 'opaque-cursor',
      last_projection_revision: 'projection-10',
      last_projection_digest: digest,
    }
    // @ts-expect-error Recipient authority comes from the authenticated envelope.
    const forbiddenSelector: ToolingGetExportCatalogRequest = { peer_id: 'peer-spoofed' }

    const response = await client.tools.getExportCatalog(request)

    expect(TOOLING_METHODS.getExportCatalog).toBe('Tooling.GetExportCatalog')
    expect(requests).toEqual([expect.objectContaining({
      method: 'Tooling.GetExportCatalog',
      path: '/api/Tooling/GetExportCatalog',
      payload: request,
    })])
    expect(Object.keys(request)).not.toContain('peer_id')
    expect(Object.keys(request)).not.toContain('provider_peer_id')
    expect(forbiddenSelector).not.toEqual(request)
    expect(response).toEqual(completePage)
  })

  it('models partial pages and terminal count/checksum as distinct contracts', () => {
    const partial = projectionPage({ complete: false, next_cursor: 'opaque-next' })
    const complete = projectionPage({
      complete: true,
      next_cursor: null,
      total_count: 0,
      final_checksum: checksum,
    })

    const parsedPartial = parseToolingExportCatalogPage(partial)
    const parsedComplete = parseToolingExportCatalogPage(complete)
    expect(parsedPartial).toEqual({ ok: true, page: partial })
    expect(parsedComplete).toEqual({ ok: true, page: complete })

    if (parsedPartial.ok && !parsedPartial.page.complete) {
      expectTypeOf(parsedPartial.page.next_cursor).toEqualTypeOf<string>()
      expect(parsedPartial.page).not.toHaveProperty('final_checksum')
    }
    if (parsedComplete.ok && parsedComplete.page.complete) {
      expectTypeOf(parsedComplete.page.total_count).toEqualTypeOf<number>()
      expectTypeOf(parsedComplete.page.final_checksum).toEqualTypeOf<string>()
    }

    expect(parseToolingExportCatalogPage({ ...partial, total_count: 1 })).toMatchObject({
      ok: false,
      reasonCode: 'invalid_projection_page',
    })
    expect(parseToolingExportCatalogPage({ ...complete, final_checksum: undefined })).toMatchObject({
      ok: false,
      reasonCode: 'invalid_projection_page',
    })
  })

  it('fails closed when protocol tier evidence is missing or legacy', () => {
    for (const selected_protocol_tier of [undefined, null, 'legacy_unsupported', 'projection_v2']) {
      const raw = projectionPage({
        complete: true,
        next_cursor: null,
        total_count: 0,
        final_checksum: checksum,
      }) as unknown as Record<string, unknown>
      raw.selected_protocol_tier = selected_protocol_tier
      expect(parseToolingExportCatalogPage(raw)).toEqual({
        ok: false,
        selectedProtocolTier: 'legacy_unsupported',
        availability: 'protocol_unsupported',
        reasonCode: 'legacy_unverifiable',
      })
    }
  })

  it('counts projection identity bounds as Unicode code points', () => {
    const acceptedPeerId = '😀'.repeat(160)
    const rejectedPeerId = '😀'.repeat(161)
    const acceptedPage = emptyRemoteProjectionPage(acceptedPeerId)

    expect(parseToolingExportCatalogPage(acceptedPage)).toEqual({ ok: true, page: acceptedPage })
    expect(parseToolingExportCatalogPage(emptyRemoteProjectionPage(rejectedPeerId))).toMatchObject({
      ok: false,
      reasonCode: 'invalid_projection_page',
    })
  })

  it('rejects invalid Unicode surrogates before projection percent encoding', () => {
    expect(parseToolingExportCatalogPage(emptyRemoteProjectionPage('\uD800'))).toMatchObject({
      ok: false,
      reasonCode: 'invalid_projection_page',
    })
  })

  it('preserves every retained availability distinction and never binds legacy rows', () => {
    const availabilities: ToolingRemoteAvailability[] = [
      'active',
      'unshared',
      'permission_blocked',
      'provider_unavailable',
      'removed',
      'stale',
      'schema_changed',
      'protocol_unsupported',
    ]
    const status = normalizeToolingRemoteCatalogStatus({
      headers: [remoteHeader('projection_v1'), {
        ...remoteHeader('projection_v1'),
        peer_id: 'peer-legacy',
        provider_id: 'peer-legacy:Tooling',
        protocol_tier: undefined,
      }],
      tools: [
        ...availabilities.map((availability) => remoteTool('peer-stable-2', availability)),
        remoteTool('peer-legacy', 'active'),
      ],
      mesh_switches: {
        provider_mesh_tooling_enabled: true,
        consumer_mesh_tooling_enabled: true,
        revision: 9,
        enforcement_active: true,
      },
      secrets_redacted: true,
    })

    expect(status.tools.slice(0, availabilities.length).map((tool) => tool.availability)).toEqual(availabilities)
    expect(status.tools.at(-1)).toMatchObject({
      availability: 'protocol_unsupported',
      reason_code: 'legacy_unverifiable',
      active_generation: null,
    })
    expect(status.headers.at(-1)).toMatchObject({
      protocol_tier: 'legacy_unsupported',
      sync_state: 'legacy_stale',
      availability: 'protocol_unsupported',
    })
    expect(status.refresh_required).toBe(true)
    expect(status.refresh_reason_code).toBe('legacy_unverifiable')
  })

  it('exposes enforcement-active and metadata-only targeted refresh contracts', () => {
    expect(normalizeToolingMeshKillSwitches({
      provider_mesh_tooling_enabled: true,
      consumer_mesh_tooling_enabled: true,
      revision: 4,
      enforcement_active: true,
    })).toEqual({
      provider_mesh_tooling_enabled: true,
      consumer_mesh_tooling_enabled: true,
      revision: 4,
      updated_at: null,
      enforcement_active: true,
    })
    expect(normalizeToolingMeshKillSwitches({})).toMatchObject({
      provider_mesh_tooling_enabled: false,
      consumer_mesh_tooling_enabled: false,
      enforcement_active: false,
    })

    const invalidation: ToolingProjectionInvalidated = {
      provider_peer_id: 'peer-stable-2',
      service_instance_id: 'peer-stable-2:Tooling',
      authority_revision: authority,
      reason_code: 'export_policy_changed',
      correlation_id: 'corr-1',
    }
    const refresh: ToolingProjectionSyncRequested = {
      provider_peer_id: 'peer-stable-2',
      service_instance_id: 'peer-stable-2:Tooling',
      reason_code: 'projection_invalidated',
      force_full_snapshot: true,
    }
    expect(Object.keys(invalidation)).not.toEqual(expect.arrayContaining(['tools', 'tool_ids', 'names', 'schemas']))
    expect(refresh.force_full_snapshot).toBe(true)
  })

  it('does not infer approval or trust state from export/share state', () => {
    const [rule] = normalizePolicyOverrides({
      default_share: true,
      default_approval_mode: 'ask_each_time',
      policy_mode: 'enforce',
      default_token_ttl_seconds: 300,
      rules: [{
        rule_id: 'export-independent',
        share: false,
        approval_mode: 'approve_all_for_peer',
        trust_tier: 'trusted',
      }],
    })
    expect(rule).toMatchObject({
      share: false,
      approvalMode: 'approve_all_for_peer',
      trustTier: 'trusted',
    })
  })
})

function projectionPage(termination: Record<string, unknown>): ToolingGetExportCatalogResponse {
  return {
    ok: true,
    provider_peer_id: 'peer-stable-1',
    service_instance_id: 'local:peer-stable-1:Tooling',
    selected_protocol_tier: 'projection_v1',
    authority_revision: authority,
    projection_revision: 'projection-11',
    projection_digest: digest,
    page_index: 0,
    page_size: 64,
    page_hash: pageHash,
    tools: [],
    retirements: [],
    ...termination,
  } as unknown as ToolingGetExportCatalogResponse
}

function emptyRemoteProjectionPage(providerPeerId: string): ToolingGetExportCatalogResponse {
  return {
    ok: true,
    provider_peer_id: providerPeerId,
    service_instance_id: `remote:${providerPeerId}:Tooling`,
    selected_protocol_tier: 'projection_v1',
    authority_revision: authority,
    projection_revision: 'projection-boundary',
    projection_digest: digest,
    page_index: 0,
    page_size: 1,
    page_hash: pageHash,
    tools: [],
    blocked_tools: [],
    retirements: [],
    complete: true,
    next_cursor: null,
    total_count: 0,
    final_checksum: checksum,
  } as unknown as ToolingGetExportCatalogResponse
}

function remoteHeader(protocolTier: unknown) {
  return {
    peer_id: 'peer-stable-2',
    provider_id: 'peer-stable-2:Tooling',
    service_instance_id: 'peer-stable-2:Tooling',
    protocol_tier: protocolTier,
    projection_revision: 'projection-11',
    projection_digest: digest,
    authority_revision: authority,
    current_generation: 3,
    sync_state: 'committed',
    availability: 'active',
    updated_at: 10,
  }
}

function remoteTool(peerId: string, availability: ToolingRemoteAvailability) {
  return {
    peer_id: peerId,
    provider_id: `${peerId}:Tooling`,
    tool: { global_tool_id: `aurora-tool:v1:${availability}` },
    schema_hash: digest,
    availability,
    reason_code: `catalog_${availability}`,
    active_generation: availability === 'active' ? 3 : null,
    projection_revision: 'projection-11',
    authority_revision: authority,
    review_required: availability === 'schema_changed',
    first_seen_at: 1,
    last_seen_at: 10,
    updated_at: 10,
  }
}

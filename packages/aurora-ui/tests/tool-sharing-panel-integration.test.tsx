// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AuroraClient,
  MockAuroraTransport,
  TOOLING_METHODS,
  type AuroraTransportRequest,
  type ToolApprovalCardModel,
  type ToolExportDecisionModel,
  type ToolExportPolicyModel,
} from '@aurora/client'
import { ToolApprovalPanel, auroraNavSections, navItemSnapshot, type RouteAvailability } from '../src'

const localTool = {
  id: 'tool:stable:schedule', shareGroupId: 'group:scheduling', shareGroupLabel: 'Scheduling', exportable: true,
  name: 'Schedule a task', description: 'Schedules a task.', providerLabel: 'Aurora core', providerPeerId: 'local-peer-stable',
  serviceInstanceId: 'tooling-main', providerKind: 'mcp', sourceType: 'mcp', trustTier: 'untrusted', transport: 'local', routePath: ['Tooling', 'ExecuteTool'],
  riskClass: 'mutating', approvalRequired: true, requiresAdminAction: false, selectorRequired: false, providerSelectorRequired: false,
  dataEgress: false, mutating: true, requiredPermissions: [], argsSchema: null, argsPreview: null, argsHash: null, meshSelector: null,
  resourceSelector: null, approvalScopes: ['once'], requestedApprovalScope: null, tokenTtlSeconds: null, state: 'ready', disabledReason: null,
  denialReason: null, dryRunSupported: false, dryRunRequired: false, dryRunPreview: null, auditDestination: null, correlationId: null,
  policyDecisionId: null, approvalRequestId: null, expiresAt: null, providers: [], result: null, secretsRedacted: true,
} as ToolApprovalCardModel

const policy: ToolExportPolicyModel = {
  scope: { peerId: null, label: 'All peers', stale: false }, defaultState: 'shared', revision: 7, initialized: true,
  scopes: [{ peerId: null, label: 'All peers', stale: false }],
  migratedFromLegacy: false, updatedAt: 1, rules: [], staleToolIds: [], staleGroupIds: [], protocolTier: 'projection_v1',
  providerEnabled: true, consumerEnabled: true, enforcementActive: true, switchRevision: 4, secretsRedacted: true,
}

const decision: ToolExportDecisionModel = {
  effectiveState: 'shared', inheritedFrom: 'global_default', inheritedFromLabel: 'Global default', matchedRuleId: null,
  peerId: null, globalToolId: localTool.id, shareGroupId: 'group:scheduling', exportable: true, staleToolId: false, staleGroupId: false,
  prerequisites: [], policyRevision: 7, reasonCode: 'global_default',
}

describe('ToolApprovalPanel independent export and approval integration', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Element.prototype.scrollIntoView = () => undefined
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('routes sharing through export AdminAction only and approval through approval AdminAction only', async () => {
    const requests: AuroraTransportRequest[] = []
    const transport = managementTransport(requests)
    await mount(new AuroraClient({ transport }))

    expect(container.textContent).not.toContain('Controls which local tool definitions this device advertises')
    expect(container.textContent).not.toContain('Default for all local tools')
    expect(container.textContent).not.toContain('Apply to future tools')
    expect(container.textContent).not.toContain('Sets the default for every tool from this source')
    const toggle = container.querySelector<HTMLButtonElement>(`button[aria-label="Toggle details for ${localTool.name}"]`)
    await act(async () => toggle?.click())
    const sharingGroup = container.querySelector(`[role="group"][aria-label="Mesh sharing for ${localTool.name}"]`)
    const notShared = [...(sharingGroup?.querySelectorAll('button') ?? [])].find((node) => node.textContent === 'Not shared') as HTMLButtonElement
    await act(async () => notShared.click())
    await waitUntil(() => requests.some((request) => request.method === TOOLING_METHODS.upsertToolExportOverride))

    expect(requests.some((request) => request.method === TOOLING_METHODS.upsertToolPolicyOverride)).toBe(false)
    expect(requests.filter((request) => request.method === 'Gateway.AdminActionDraft')).toHaveLength(1)
    expect(requests.find((request) => request.method === TOOLING_METHODS.upsertToolExportOverride)?.payload).toMatchObject({
      global_tool_id: localTool.id,
      peer_id: null,
      state: 'unshared',
    })

    const approvalGroup = container.querySelector(`[role="group"][aria-label="Policy override for ${localTool.name}"]`)
    const trust = [...(approvalGroup?.querySelectorAll('button') ?? [])].find((node) => node.textContent === 'Trust') as HTMLButtonElement
    await act(async () => trust.click())
    await waitUntil(() => requests.some((request) => request.method === TOOLING_METHODS.upsertToolPolicyOverride))

    expect(requests.filter((request) => request.method === TOOLING_METHODS.upsertToolExportOverride)).toHaveLength(1)
    expect(requests.filter((request) => request.method === 'Gateway.AdminActionDraft')).toHaveLength(2)
    expect(requests.find((request) => request.method === TOOLING_METHODS.upsertToolPolicyOverride)?.payload).toMatchObject({
      global_tool_id: localTool.id,
      trust_tier: 'trusted',
    })
  })

  it('writes a sharing default for the selected tool group from the existing Tools card', async () => {
    const requests: AuroraTransportRequest[] = []
    await mount(new AuroraClient({ transport: managementTransport(requests) }))

    const group = container.querySelector(`[role="group"][aria-label="Mesh sharing for Scheduling group"]`)
    const notShared = [...(group?.querySelectorAll('button') ?? [])].find((node) => node.textContent === 'Not shared') as HTMLButtonElement
    await act(async () => notShared.click())
    await waitUntil(() => requests.some((request) => request.method === TOOLING_METHODS.upsertToolGroupExportPolicy))

    expect(requests.find((request) => request.method === TOOLING_METHODS.upsertToolGroupExportPolicy)?.payload).toMatchObject({
      share_group_id: 'group:scheduling',
      peer_id: null,
      state: 'unshared',
    })
  })

  it('keeps the saved sharing segment selected without requiring a refresh', async () => {
    const requests: AuroraTransportRequest[] = []
    await mount(new AuroraClient({ transport: managementTransport(requests) }))
    const group = container.querySelector(`[role="group"][aria-label="Mesh sharing for Scheduling group"]`)!
    const notShared = [...group.querySelectorAll('button')].find((node) => node.textContent === 'Not shared') as HTMLButtonElement
    await act(async () => notShared.click())
    await waitUntil(() => requests.some((request) => request.method === TOOLING_METHODS.upsertToolGroupExportPolicy))
    expect(notShared.getAttribute('aria-pressed')).toBe('true')
    expect(group.textContent).toContain('Not shared with mesh peers.')
  })

  it('refreshes an inherited tool decision from the backend instead of assuming the global default', async () => {
    const requests: AuroraTransportRequest[] = []
    const overriddenPolicy: ToolExportPolicyModel = {
      ...policy,
      rules: [{
        id: 'group-shared',
        peerId: null,
        scopeType: 'group',
        scopeId: localTool.shareGroupId!,
        state: 'shared',
        actorPrincipalId: 'admin',
        reason: 'group default',
        createdAt: 1,
        updatedAt: 1,
      }, {
        id: 'tool-unshared',
        peerId: null,
        scopeType: 'tool',
        scopeId: localTool.id,
        state: 'unshared',
        actorPrincipalId: 'admin',
        reason: 'tool override',
        createdAt: 1,
        updatedAt: 1,
      }],
    }
    const overriddenDecision: ToolExportDecisionModel = {
      ...decision,
      effectiveState: 'unshared',
      inheritedFrom: 'global_tool',
      inheritedFromLabel: 'Exact tool for all peers',
      matchedRuleId: 'tool-unshared',
    }
    await mount(
      new AuroraClient({ transport: managementTransport(requests) }),
      undefined,
      overriddenPolicy,
      overriddenDecision,
    )

    const toggle = container.querySelector<HTMLButtonElement>(`button[aria-label="Toggle details for ${localTool.name}"]`)
    await act(async () => toggle?.click())
    const sharingGroup = container.querySelector(`[role="group"][aria-label="Mesh sharing for ${localTool.name}"]`)!
    const inherit = [...sharingGroup.querySelectorAll('button')].find((node) => node.textContent === 'Inherit') as HTMLButtonElement
    await act(async () => inherit.click())

    await waitUntil(() => {
      expect(requests.some((request) => request.method === TOOLING_METHODS.clearToolExportOverride)).toBe(true)
      expect(sharingGroup.textContent).toContain('Shared')
      expect(sharingGroup.textContent).toContain('Effective via All peers group policy')
    })
    expect(requests.find((request) => request.method === TOOLING_METHODS.previewToolExportDecision)?.payload).toMatchObject({
      global_tool_id: localTool.id,
      share_group_id: localTool.shareGroupId,
      peer_id: null,
    })
  })

  it('keeps durable removed peer scopes discoverable from the expanded tool row', async () => {
    const stalePolicy: ToolExportPolicyModel = {
      ...policy,
      scope: { peerId: 'peer-removed', label: 'Former office Aurora', stale: true, ruleCount: 1, lastRuleUpdatedAt: 7 },
      scopes: [
        { peerId: null, label: 'All peers', stale: false },
        { peerId: 'peer-removed', label: 'Former office Aurora', stale: true, ruleCount: 1, lastRuleUpdatedAt: 7 },
      ],
      rules: [{
        id: 'global-off', peerId: null, scopeType: 'tool', scopeId: localTool.id, state: 'unshared',
        actorPrincipalId: 'admin', reason: 'recipient list', createdAt: 1, updatedAt: 7,
      }, {
        id: 'rule-removed', peerId: 'peer-removed', scopeType: 'tool', scopeId: localTool.id, state: 'shared',
        actorPrincipalId: 'admin', reason: 'retained override', createdAt: 1, updatedAt: 7,
      }],
    }
    await mount(new AuroraClient({ transport: managementTransport([]) }), [], stalePolicy)

    const toggle = container.querySelector<HTMLButtonElement>(`button[aria-label="Toggle details for ${localTool.name}"]`)
    await act(async () => toggle?.click())
    const picker = container.querySelector<HTMLButtonElement>('button[aria-label="Choose peers to share with"]')!
    expect(picker.textContent).toContain('Former office Aurora')
    await act(async () => picker.click())
    expect(document.body.textContent).toContain('Former office Aurora')
    expect(document.body.textContent).toContain('stale')
  })

  async function mount(
    client: AuroraClient,
    peers = [{ peerId: 'peer-stable-2', label: 'Kitchen Aurora', stale: false }],
    sharingPolicy: ToolExportPolicyModel = policy,
    sharingDecision: ToolExportDecisionModel = decision,
  ) {
    await act(async () => root.render(
      <ToolApprovalPanel
        client={client}
        route={toolsRoute()}
        initialTools={[localTool]}
        initialSchedulerJobs={[]}
        initialManagementState={{
          managementLoading: false, sharingPolicy, sharingPeers: peers,
          sharingDecisions: { [localTool.id]: sharingDecision }, sharingLoading: false,
          sourceSummaries: [], sourceDetails: {}, grants: [], pendingApprovals: [], auditEvents: [],
        }}
      />,
    ))
  }
})

function managementTransport(requests: AuroraTransportRequest[], delayedScopes = false): MockAuroraTransport {
  const transport = MockAuroraTransport.empty()
  const record = <T,>(handler: (request: AuroraTransportRequest) => T | Promise<T>) => async (request: AuroraTransportRequest) => {
    requests.push(request)
    return handler(request)
  }
  transport.register('Gateway.AdminActionDraft', record(() => ({
    action_id: 'aa-ui', nonce: 'nonce-ui', digest: 'digest-ui', method_id: 'tooling-write', affected_resources: [],
    required_phrase: 'CONFIRM', required_reason: true, required_reauth: true, expires_at: '2026-07-14T23:59:00Z', expires_in_seconds: 300,
    confirmation_headers: { action_id: 'X-Aurora-AdminAction-Id', confirmation_token: 'X-Aurora-AdminAction-Token', digest: 'X-Aurora-AdminAction-Digest' },
  })))
  transport.register('Gateway.AdminActionConfirm', record(() => ({
    action_id: 'aa-ui', confirmation_token: 'token-ui', digest: 'digest-ui', confirmed: true, expires_at: '2026-07-14T23:59:00Z', audit_receipt: 'audit-ui',
    confirmation_headers: { action_id: 'X-Aurora-AdminAction-Id', confirmation_token: 'X-Aurora-AdminAction-Token', digest: 'X-Aurora-AdminAction-Digest' },
  })))
  transport.register(TOOLING_METHODS.upsertToolExportOverride, record(() => mutationResponse()))
  transport.register(TOOLING_METHODS.clearToolExportOverride, record(() => mutationResponse()))
  transport.register(TOOLING_METHODS.upsertToolPolicyOverride, record(() => ({ ok: true })))
  transport.register(TOOLING_METHODS.getToolExportPolicy, record(async (request) => {
    const peerId = (request.payload as { peer_id?: string | null }).peer_id ?? null
    if (delayedScopes && peerId === 'peer-slow') await new Promise((resolve) => setTimeout(resolve, 60))
    return rawPolicy(peerId === 'peer-fast' ? 'shared' : peerId === 'peer-slow' ? 'unshared' : 'shared', peerId)
  }))
  transport.register(TOOLING_METHODS.upsertToolGroupExportPolicy, record(() => mutationResponse()))
  transport.register(TOOLING_METHODS.previewToolExportDecision, record((request) => {
    const peerId = (request.payload as { peer_id?: string | null }).peer_id ?? null
    return { decision: rawDecision(peerId) }
  }))
  return transport
}

function rawPolicy(groupState: 'shared' | 'unshared', peerId: string | null) {
  return {
    policy: { default_state: 'shared', revision: 8, initialized: true, migrated_from_legacy: false, updated_at: 2 },
    rules: peerId ? [{ rule_id: `rule-${peerId}`, peer_id: peerId, scope_type: 'group', scope_id: 'group:scheduling', state: groupState, actor_principal_id: 'admin', reason: 'test', created_at: 1, updated_at: 1 }] : [],
    stale_tool_ids: [], stale_group_ids: [], protocol_tier: 'projection_v1',
    mesh_switches: { provider_mesh_tooling_enabled: true, consumer_mesh_tooling_enabled: true, revision: 4, enforcement_active: true }, secrets_redacted: true,
  }
}

function rawDecision(peerId: string | null) {
  return {
    effective_state: peerId === 'peer-slow' ? 'unshared' : 'shared', inherited_from: peerId ? 'peer_group' : 'global_group', matched_rule_id: peerId ? `rule-${peerId}` : 'group-shared',
    peer_id: peerId, global_tool_id: localTool.id, share_group_id: 'group:scheduling', exportable: true, stale_tool_id: false, stale_group_id: false,
    prerequisites: { local_exportable: true, enforcement_active: true }, policy_revision: 8, reason_code: peerId ? 'peer_group' : 'global_default',
  }
}

function mutationResponse() {
  return { ok: true, policy: { default_state: 'shared', revision: 8, initialized: true, migrated_from_legacy: false, updated_at: 2 }, rule: null, cleared: false, changed: true, previous_revision: 7, revision: 8 }
}

function toolsRoute(): RouteAvailability {
  const item = auroraNavSections.flatMap((section) => section.items).find((candidate) => candidate.id === 'tools')!
  return { item: navItemSnapshot(item), state: 'available-local', explanation: 'Tooling available', providerLabel: 'local Tooling', blockers: [], repairActions: [], candidateProviders: [], evidenceSources: ['Tooling.GetToolCatalog'], selectorRequired: false, approvalRequired: false, routeable: true, disabled: false, requiresAdminAction: false }
}

async function waitUntil(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try { assertion(); return } catch { await new Promise((resolve) => setTimeout(resolve, 10)) }
  }
  assertion()
}

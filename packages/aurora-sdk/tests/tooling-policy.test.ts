import { describe, expect, it } from 'vitest'
import {
  AuroraClient,
  MockAuroraTransport,
  TOOLING_METHODS,
  cloneFixture,
  buildToolingPageView,
  getToolSourceDetailFromView,
  mergeToolManagementInventory,
  normalizeToolCatalog,
  toolCatalogFixture,
  toolingApprovalGrantsFixture,
  toolingMcpStatusFixture,
  toolingSharingPolicyFixture,
  type AuroraTransportRequest,
  type ToolCatalogResponse,
} from '../src/index.js'

describe('Tooling management SDK surface', () => {
  it('defines typed descriptors for Tooling management contracts supported by the backend', () => {
    expect(TOOLING_METHODS).toMatchObject({
      getStats: 'Tooling.GetStats',
      getMcpStatus: 'Tooling.GetMCPStatus',
      reloadMcpTools: 'Tooling.ReloadMCPTools',
      getSharingPolicy: 'Tooling.GetSharingPolicy',
      setSharingPolicy: 'Tooling.SetSharingPolicy',
      testSharingPolicy: 'Tooling.TestSharingPolicy',
      listApprovalGrants: 'Tooling.ListApprovalGrants',
      createApprovalGrant: 'Tooling.CreateApprovalGrant',
      revokeApprovalGrant: 'Tooling.RevokeApprovalGrant',
      evaluateApprovalGrant: 'Tooling.EvaluateApprovalGrant',
      clearSourcePolicy: 'Tooling.ClearSourcePolicy',
      clearToolPolicyOverride: 'Tooling.ClearToolPolicyOverride',
    })
  })

  it('builds source-first page reads from current backend API paths', async () => {
    const requests: AuroraTransportRequest[] = []
    const transport = MockAuroraTransport.empty()
      .register('Tooling.GetToolCatalog', (request) => { requests.push(request); return cloneFixture(toolCatalogFixture) })
      .register('Tooling.GetPolicySummary', (request) => {
        requests.push(request)
        return { policy: cloneFixture(toolingSharingPolicyFixture), policy_mode: 'enforce', default_approval_mode: 'approve_all_local_safe', default_share: true, active_grant_count: 1, pending_approval_count: 0, blocked_source_count: 0, blocked_tool_count: 0, source_count: 1, tool_count: 1, secrets_redacted: true }
      })
      .register('Tooling.ListToolSources', (request) => {
        requests.push(request)
        return { sources: [{ source_id: 'local:core', source: 'core', display_name: 'Core tools', tool_count: 1, secrets_redacted: true }], count: 1, generated_at: '2026-07-06T00:00:00Z', secrets_redacted: true }
      })
      .register('Tooling.GetToolSourceDetail', (request) => {
        requests.push(request)
        return { source: { source_id: 'local:core', source: 'core', display_name: 'Core tools', tool_count: 1, secrets_redacted: true }, tools: cloneFixture(toolCatalogFixture.tools), blocked_tools: [], grants: [], pending_approvals: [], policy_rules: [], found: true, secrets_redacted: true }
      })
      .register('Tooling.ListPendingApprovals', (request) => { requests.push(request); return { approvals: [], count: 0, secrets_redacted: true } })
      .register('Tooling.ListPolicyAuditEvents', (request) => { requests.push(request); return { events: [{ event: 'tooling.policy.set', correlation_id: 'corr-policy', details: { token: '[REDACTED]', secrets_redacted: true }, secrets_redacted: true }], total: 1, secrets_redacted: true } })
      .register('Tooling.SetPolicyMode', (request) => { requests.push(request); return { ok: true, correlation_id: 'corr-policy-mode' } })
    const client = new AuroraClient({ transport })

    await client.tools.getPolicySummary()
    await client.tools.listSources()
    await client.tools.getSourceDetail('local:core')
    await client.tools.listPendingApprovals({ status: 'pending' })
    await client.tools.listPolicyAuditEvents({ action: 'Tooling.SetSharingPolicy' })
    await client.tools.setPolicyMode({ policyMode: 'dry_run_only', reason: 'test policy mode path' })

    expect(requests.map((request) => [request.method, request.path])).toEqual(expect.arrayContaining([
      ['Tooling.GetPolicySummary', '/api/Tooling/GetPolicySummary'],
      ['Tooling.ListToolSources', '/api/Tooling/ListToolSources'],
      ['Tooling.GetToolSourceDetail', '/api/Tooling/GetToolSourceDetail'],
      ['Tooling.ListPendingApprovals', '/api/Tooling/ListPendingApprovals'],
      ['Tooling.ListPolicyAuditEvents', '/api/Tooling/ListPolicyAuditEvents'],
      ['Tooling.SetPolicyMode', '/api/Tooling/SetPolicyMode'],
    ]))
  })

  it('preserves per-source local MCP and plugin IDs when normalizing catalog tools', () => {
    const tools = normalizeToolCatalog({
      tools: [
        { global_tool_id: 'tool:mcp:mail.search', display_name: 'Mail search', source: 'mcp', source_id: 'local:mcp:mail', provider_kind: 'mcp', service_instance_id: 'mcp-mail' },
        { global_tool_id: 'tool:mcp:calendar.search', display_name: 'Calendar search', source: 'mcp', source_id: 'local:mcp:calendar', provider_kind: 'mcp', service_instance_id: 'mcp-calendar' },
        { global_tool_id: 'tool:plugin:weather.lookup', display_name: 'Weather lookup', source: 'plugin', source_id: 'local:plugin:weather', provider_kind: 'plugin', service_instance_id: 'plugin-weather' },
        { global_tool_id: 'tool:plugin:notes.lookup', display_name: 'Notes lookup', source: 'plugin', provider_kind: 'plugin', service_instance_id: 'plugin-notes' }
      ],
      secrets_redacted: true
    })

    expect(tools.map((tool) => tool.sourceId)).toEqual([
      'local:mcp:mail',
      'local:mcp:calendar',
      'local:plugin:weather',
      'local:plugin:notes'
    ])
  })

  it('normalizes canonical identity, backend share groups, aliases, and provenance while forcing remote tools non-exportable', () => {
    const [local, remote, legacy] = normalizeToolCatalog({
      tools: [
        {
          global_tool_id: 'aurora-tool:v1:peer-local:Tooling:mcp.mail.search',
          tool_id_scheme: 'aurora-tool',
          tool_id_version: 1,
          tool_contract_id: 'mcp.mail.search',
          share_group_id: 'mcp:mail-primary',
          share_group_label: 'Mail tools',
          legacy_global_tool_ids: ['tool:mcp:mail.search', 'tool:mcp:mail.search'],
          exportable: true,
          provider_peer_id: 'local-peer',
          provider_kind: 'mcp',
          source: 'mcp',
          provenance: {
            provider_peer_id: 'peer-local',
            provider_service_instance_id: 'mcp-session-1',
            provider_kind: 'local',
            source: 'mcp',
            advertised_name: 'Search mail',
            stable_source_id: 'mail-primary',
            provider_tool_id: 'search'
          }
        },
        {
          global_tool_id: 'aurora-tool:v1:peer-remote:Tooling:mcp.mail.search',
          tool_id_scheme: 'aurora-tool',
          tool_id_version: 1,
          tool_contract_id: 'mcp.mail.search',
          share_group_id: 'mcp:mail-primary',
          share_group_label: 'Mail tools',
          exportable: true,
          provider_peer_id: 'peer-remote',
          provider_kind: 'mesh_peer',
          source: 'mesh_peer',
          provenance: {
            provider_peer_id: 'peer-remote',
            provider_service_instance_id: 'remote-session-2',
            provider_kind: 'mesh_peer',
            source: 'mcp',
            advertised_name: 'Search mail',
            stable_source_id: 'mail-primary',
            provider_tool_id: 'search'
          }
        },
        { global_tool_id: 'tool:legacy:name-only', provider_kind: 'local' }
      ],
      secrets_redacted: true
    })

    expect(local).toMatchObject({
      toolIdScheme: 'aurora-tool', toolIdVersion: 1, toolContractId: 'mcp.mail.search',
      shareGroupId: 'mcp:mail-primary', shareGroupLabel: 'Mail tools', exportable: true,
      legacyGlobalToolIds: ['tool:mcp:mail.search'], provenanceStableSourceId: 'mail-primary',
      provenanceProviderToolId: 'search'
    })
    expect(remote).toMatchObject({ exportable: false, shareGroupId: 'mcp:mail-primary' })
    expect(legacy).toMatchObject({
      id: 'tool:legacy:name-only', toolIdScheme: null, toolIdVersion: null,
      toolContractId: null, shareGroupId: null, legacyGlobalToolIds: [], exportable: true
    })
  })

  it('keeps canonical and legacy-compatible fixture entries distinct', () => {
    const cards = normalizeToolCatalog(toolCatalogFixture)
    const canonical = cards.find((tool) => tool.toolContractId === 'core.diagnostics.service-health')
    const legacy = cards.find((tool) => tool.id === 'tool:local:filesystem.writeConfig')
    const remote = cards.find((tool) => tool.id === 'tool:remote:garageDoor.open')

    expect(canonical).toMatchObject({
      id: 'aurora-tool:v1:local-peer:Tooling:core.diagnostics.service-health',
      shareGroupId: 'core:diagnostics', shareGroupLabel: 'Diagnostics', exportable: true,
      provenanceStableSourceId: 'core:aurora', provenanceProviderToolId: 'diagnostics.service-health'
    })
    expect(legacy).toMatchObject({ toolIdScheme: null, toolIdVersion: null, shareGroupId: null })
    expect(remote).toMatchObject({ shareGroupId: 'core:hardware', exportable: false })
  })

  it('shows mesh peer names while retaining stable catalog and routing IDs', () => {
    const stablePeerId = 'aurora-da2c3842004492c887b3ce878c8eb0cb'
    const stableGlobalId = `${stablePeerId}:remote_${stablePeerId}_Tooling:tool:list_scheduled_tasks_tool`
    const stableSourceId = `mesh:${stablePeerId}:remote_${stablePeerId}_Tooling`
    const [tool] = normalizeToolCatalog({
      tools: [{
        global_tool_id: stableGlobalId,
        local_name: 'list_scheduled_tasks_tool',
        display_name: 'aurora-2.list_scheduled_tasks_tool',
        provider_label: 'aurora-2',
        provider_peer_id: stablePeerId,
        provider_service_instance_id: `remote:${stablePeerId}:Tooling`,
        source: 'mesh_peer',
        source_type: 'mesh_peer',
        source_id: stableSourceId
      }],
      secrets_redacted: true
    })

    expect(tool).toBeDefined()
    if (!tool) throw new Error('expected normalized mesh tool')
    expect(tool.name).toBe('aurora-2.list_scheduled_tasks_tool')
    expect(tool.providerLabel).toBe('aurora-2')
    expect(tool.providerKind).toBe('mesh_peer')
    expect(tool.serviceInstanceId).toBe(`remote:${stablePeerId}:Tooling`)
    expect(tool.id).toBe(stableGlobalId)
    expect(tool.providerPeerId).toBe(stablePeerId)
    expect(tool.sourceId).toBe(stableSourceId)
  })

  it('keeps permission-blocked peer tools out of bindable lists but visible and disabled in management inventory', () => {
    const stablePeerId = 'aurora-da2c3842004492c887b3ce878c8eb0cb'
    const stableToolId = `${stablePeerId}:remote_${stablePeerId}_Tooling:tool:list_scheduled_tasks_tool`
    const stableSourceId = `mesh:${stablePeerId}:remote_${stablePeerId}_Tooling`
    const catalog: ToolCatalogResponse = {
      tools: [],
      blocked_tools: [{
        reason_code: 'permission_denied',
        reason: 'caller principal lacks required tool permissions',
        missing_permissions: ['Scheduler.use'],
        tool: {
          global_tool_id: stableToolId,
          local_name: 'list_scheduled_tasks_tool',
          display_name: 'aurora-2.list_scheduled_tasks_tool',
          description: 'List scheduled tasks on aurora-2.',
          provider_label: 'aurora-2',
          provider_peer_id: stablePeerId,
          provider_service_instance_id: `remote:${stablePeerId}:Tooling`,
          source: 'mesh_peer',
          source_type: 'mesh_peer',
          source_id: stableSourceId,
          required_permissions: ['Scheduler.use']
        }
      }],
      providers: [{
        provider_peer_id: stablePeerId,
        provider_service_instance_id: `remote:${stablePeerId}:Tooling`,
        provider_label: 'aurora-2',
        provider_kind: 'mesh_peer',
        eligible: true
      }],
      secrets_redacted: true
    }

    const bindableTools = normalizeToolCatalog(catalog)
    const view = buildToolingPageView({ catalog })
    const detail = getToolSourceDetailFromView(view, stableSourceId, catalog)

    expect(bindableTools).toEqual([])
    expect(detail).not.toBeNull()
    if (!detail) throw new Error('expected management source detail')
    expect(detail.tools).toEqual([])
    expect(detail.blockedTools).toHaveLength(1)
    const [blockedTool] = detail.blockedTools
    expect(blockedTool).toBeDefined()
    if (!blockedTool) throw new Error('expected blocked management tool')
    expect(blockedTool).toMatchObject({
      id: stableToolId,
      name: 'aurora-2.list_scheduled_tasks_tool',
      providerPeerId: stablePeerId,
      sourceId: stableSourceId,
      state: 'unavailable',
      blockReasonCode: 'permission_denied',
      disabledReason: 'Missing required permission: Scheduler.use.'
    })
    expect(blockedTool.providers.every((provider) => !provider.selectable)).toBe(true)
    expect(mergeToolManagementInventory(detail.tools, detail.blockedTools).map((tool) => tool.id)).toEqual([stableToolId])
  })

  it('normalizes blocked reasons on the live Tooling.GetToolSourceDetail path', async () => {
    const stablePeerId = 'aurora-peer-stable'
    const stableToolId = `${stablePeerId}:remote_${stablePeerId}_Tooling:tool:calendar_list_tool`
    const stableSourceId = `mesh:${stablePeerId}:remote_${stablePeerId}_Tooling`
    const transport = MockAuroraTransport.empty().register('Tooling.GetToolSourceDetail', () => ({
      found: true,
      source: {
        source_id: stableSourceId,
        source: 'mesh_peer',
        display_name: 'office-aurora',
        provider_peer_id: stablePeerId,
        provider_service_instance_id: `remote:${stablePeerId}:Tooling`,
        provider_kind: 'mesh_peer',
        tool_count: 0,
        blocked_tool_count: 1,
        secrets_redacted: true
      },
      tools: [],
      blocked_tools: [{
        reason_code: 'permission_denied',
        missing_permissions: ['Calendar.write'],
        tool: {
          global_tool_id: stableToolId,
          display_name: 'office-aurora.calendar_list_tool',
          provider_label: 'office-aurora',
          provider_peer_id: stablePeerId,
          provider_service_instance_id: `remote:${stablePeerId}:Tooling`,
          source: 'mesh_peer',
          source_type: 'mesh_peer',
          source_id: stableSourceId,
          required_permissions: ['Tooling.use', 'Calendar.write']
        }
      }],
      grants: [],
      pending_approvals: [],
      policy_rules: [],
      secrets_redacted: true
    }))
    const client = new AuroraClient({ transport })

    const detail = await client.tools.getSourceDetail(stableSourceId)

    expect(detail?.tools).toEqual([])
    expect(detail?.blockedTools).toEqual([
      expect.objectContaining({
        id: stableToolId,
        providerPeerId: stablePeerId,
        sourceId: stableSourceId,
        state: 'unavailable',
        blockReasonCode: 'permission_denied',
        missingPermissions: ['Calendar.write'],
        disabledReason: 'Missing required permission: Calendar.write.'
      })
    ])
    expect(detail?.blockedTools[0]?.providers.every((provider) => !provider.selectable)).toBe(true)
  })

  it('keeps retained peer tools visible but disabled when the provider is unavailable', async () => {
    const stablePeerId = 'aurora-peer-stable'
    const stableToolId = `${stablePeerId}:remote_${stablePeerId}_Tooling:tool:list_tasks`
    const stableSourceId = `mesh:${stablePeerId}:remote_${stablePeerId}_Tooling`
    const transport = MockAuroraTransport.empty().register('Tooling.GetToolSourceDetail', () => ({
      found: true,
      source: {
        source_id: stableSourceId,
        source: 'mesh_peer',
        display_name: 'office-aurora',
        provider_peer_id: stablePeerId,
        provider_service_instance_id: `remote:${stablePeerId}:Tooling`,
        provider_kind: 'mesh_peer',
        status: 'provider_unavailable',
        tool_count: 0,
        retained_tool_count: 1,
        blocked_tool_count: 1,
        secrets_redacted: true
      },
      tools: [],
      blocked_tools: [],
      retained_tools: [{
        peer_id: stablePeerId,
        provider_id: stablePeerId,
        provider_label: 'office-aurora',
        service_instance_id: `remote:${stablePeerId}:Tooling`,
        source_id: stableSourceId,
        global_tool_id: stableToolId,
        local_tool_name: 'list_tasks',
        display_name: 'office-aurora.list_tasks',
        source: 'mesh_peer',
        retained_availability: 'active',
        effective_availability: 'provider_unavailable',
        reason_code: 'provider_unavailable',
        tool: {
          global_tool_id: stableToolId,
          local_name: 'list_tasks',
          display_name: 'office-aurora.list_tasks',
          provider_label: 'office-aurora',
          provider_peer_id: stablePeerId,
          provider_service_instance_id: `remote:${stablePeerId}:Tooling`,
          provider_kind: 'mesh_peer',
          source: 'mesh_peer',
          source_type: 'mesh_peer',
          source_id: stableSourceId
        },
        secrets_redacted: true
      }],
      grants: [],
      pending_approvals: [],
      policy_rules: [],
      secrets_redacted: true
    }))
    const client = new AuroraClient({ transport })

    const detail = await client.tools.getSourceDetail(stableSourceId)
    expect(detail).not.toBeNull()
    if (!detail) throw new Error('expected retained source detail')
    const inventory = mergeToolManagementInventory(
      detail.tools,
      detail.blockedTools,
      detail.retainedTools
    )

    expect(inventory).toEqual([
      expect.objectContaining({
        id: stableToolId,
        name: 'office-aurora.list_tasks',
        state: 'unavailable',
        blockReasonCode: 'provider_unavailable',
        disabledReason: 'Retained peer tool is currently unavailable: provider unavailable.'
      })
    ])
    expect(inventory[0]?.providers.every((provider) => !provider.selectable)).toBe(true)
  })

  it('matches MCP status servers to their per-source local IDs', () => {
    const view = buildToolingPageView({
      catalog: {
        generated_at: '2026-07-06T00:00:00Z',
        tools: [
          { global_tool_id: 'tool:mcp:mail.search', source: 'mcp', source_id: 'local:mcp:mail', provider_kind: 'mcp', service_instance_id: 'mcp-mail' },
          { global_tool_id: 'tool:mcp:calendar.search', source: 'mcp', source_id: 'local:mcp:calendar', provider_kind: 'mcp', service_instance_id: 'mcp-calendar' }
        ],
        secrets_redacted: true
      },
      policy: toolingSharingPolicyFixture,
      grants: [],
      pendingApprovals: [],
      auditEvents: [],
      mcpStatus: {
        total_servers: 2,
        active_servers: 2,
        servers: [
          { id: 'mcp-mail', name: 'Mail', active: true, tool_count: 1, secrets_redacted: true },
          { id: 'mcp-calendar', name: 'Calendar', active: true, tool_count: 1, secrets_redacted: true }
        ]
      },
      transportKind: 'mock',
      fixtureMode: false
    })

    const catalog = {
      generated_at: '2026-07-06T00:00:00Z',
      tools: [
        { global_tool_id: 'tool:mcp:mail.search', source: 'mcp', source_id: 'local:mcp:mail', provider_kind: 'mcp', service_instance_id: 'mcp-mail' },
        { global_tool_id: 'tool:mcp:calendar.search', source: 'mcp', source_id: 'local:mcp:calendar', provider_kind: 'mcp', service_instance_id: 'mcp-calendar' }
      ],
      secrets_redacted: true
    }
    const mail = getToolSourceDetailFromView(view, 'local:mcp:mail', catalog)
    const calendar = getToolSourceDetailFromView(view, 'local:mcp:calendar', catalog)

    expect(mail?.mcpServers.map((server) => server.id)).toEqual(['mcp-mail'])
    expect(calendar?.mcpServers.map((server) => server.id)).toEqual(['mcp-calendar'])
  })

  it('preserves removed and unshared mesh source states distinctly', async () => {
    const transport = MockAuroraTransport.empty().register('Tooling.ListToolSources', () => ({
      sources: [
        { source_id: 'mesh:peer-one:tooling', source: 'mesh_peer', display_name: 'Peer one', status: 'removed', secrets_redacted: true },
        { source_id: 'mesh:peer-two:tooling', source: 'mesh_peer', display_name: 'Peer two', status: 'unshared', secrets_redacted: true }
      ],
      secrets_redacted: true
    }))
    const client = new AuroraClient({ transport })

    const sources = await client.tools.listSources()

    expect(sources.map((source) => source.status)).toEqual(['removed', 'unshared'])
  })

  it('routes MCP and plugin onboarding through Tooling contracts while preserving redacted previews', async () => {
    const requests: AuroraTransportRequest[] = []
    const transport = MockAuroraTransport.empty()
      .register('Tooling.TestMCPSource', (request) => {
        requests.push(request)
        return { ok: false, source_id: 'local:mcp:mail', error: 'unsupported_in_current_runtime', message: 'unsupported', secrets_redacted: true }
      })
      .register('Tooling.CreateMCPSource', (request) => {
        requests.push(request)
        return { ok: false, source_id: 'local:mcp:mail', error: 'unsupported_in_current_runtime', message: 'unsupported', created: false, secrets_redacted: true }
      })
      .register('Tooling.TestPluginSource', (request) => {
        requests.push(request)
        return { ok: false, source_id: 'local:plugin:weather', error: 'unsupported_in_current_runtime', message: 'unsupported', secrets_redacted: true }
      })
      .register('Tooling.CreatePluginSource', (request) => {
        requests.push(request)
        return { ok: false, source_id: 'local:plugin:weather', error: 'unsupported_in_current_runtime', message: 'unsupported', created: false, secrets_redacted: true }
      })
    const client = new AuroraClient({ transport })

    const mcp = await client.tools.testMcpSource({ name: 'slack', command: 'npx server', env: { SLACK_TOKEN: 'sk-live-secret-token' } })
    await client.tools.createMcpSource({ name: 'slack', command: 'npx server', env: { SLACK_TOKEN: 'sk-live-secret-token' }, trustTier: 'untrusted' })
    await client.tools.testPluginSource({ packageName: 'calendar' })
    await client.tools.createPluginSource({ packageName: 'calendar', trustTier: 'untrusted' })

    expect(mcp.supported).toBe(false)
    expect(JSON.stringify(mcp)).toContain('[REDACTED]')
    expect(JSON.stringify(mcp)).not.toContain('sk-live-secret-token')
    expect(requests.map((request) => [request.method, request.path])).toEqual(expect.arrayContaining([
      ['Tooling.TestMCPSource', '/api/Tooling/TestMCPSource'],
      ['Tooling.CreateMCPSource', '/api/Tooling/CreateMCPSource'],
      ['Tooling.TestPluginSource', '/api/Tooling/TestPluginSource'],
      ['Tooling.CreatePluginSource', '/api/Tooling/CreatePluginSource'],
    ]))
  })

  it('preserves source state, redaction metadata, and scheduler dependency fields in normalized view models', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })

    const result = await client.tools.listSources()

    expect(result.some((source) => source.secretsRedacted)).toBe(true)
    expect(result.map((source) => source.kind)).toEqual(expect.arrayContaining(['core', 'mcp', 'mesh_peer']))
    expect(result.some((source) => source.staleGrantCount > 0 || source.status === 'blocked')).toBe(true)
    expect(result.some((source) => Array.isArray(source.schedulerDependencies))).toBe(true)
  })

  it('redacts MCP onboarding secrets before returning local unsupported previews to the UI', async () => {
    const client = new AuroraClient({ transport: MockAuroraTransport.empty() })

    const result = await client.tools.testMcpSource({ name: 'slack', command: 'npx server', env: { SLACK_TOKEN: 'sk-live-secret-token' } })

    expect(result.supported).toBe(false)
    expect(JSON.stringify(result)).toContain('[REDACTED]')
    expect(JSON.stringify(result)).not.toContain('sk-live-secret-token')
  })
})

import { describe, expect, it } from 'vitest'
import {
  AuroraClient,
  MockAuroraTransport,
  TOOLING_METHODS,
  cloneFixture,
  buildToolingPageView,
  getToolSourceDetailFromView,
  normalizeToolCatalog,
  toolCatalogFixture,
  toolingApprovalGrantsFixture,
  toolingMcpStatusFixture,
  toolingSharingPolicyFixture,
  type AuroraTransportRequest,
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

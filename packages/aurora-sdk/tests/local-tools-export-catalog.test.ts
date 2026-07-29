import { describe, expect, it } from 'vitest'

import {
  LocalToolRegistry,
  buildLocalToolExportCatalogPage,
  computeProjectionChecksum,
  computeProjectionPageHash,
  projectionDigest,
  type LocalToolDescriptorV1,
  type LocalToolProjectionContext
} from '../src/local-tools/index.js'

const authority = {
  catalog_revision: 1,
  export_policy_revision: 2,
  auth_grant_revision: 3,
  manifest_revision: 4,
  switch_revision: 5,
  protocol_revision: 1
}

const descriptor: LocalToolDescriptorV1 = {
  version: 1,
  toolContractId: 'core.scheduler.list',
  localName: 'schedule.list',
  displayName: 'List scheduled tasks',
  description: 'List scheduled tasks',
  argsSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', properties: { items: { type: 'array' } }, required: ['items'], additionalProperties: false },
  argumentVisibility: {},
  requiredPermissions: ['Scheduler.List'],
  resourceScopes: ['scheduler.local'],
  safetyClass: 'standard',
  privacyClass: 'personal',
  mutating: false,
  dataEgress: false,
  nativeRequirements: { capabilityIds: ['scheduler.read'], osPermissions: [] },
  confirmationPolicy: 'never',
  handlerId: 'core.scheduler.list'
}

const otherDescriptor: LocalToolDescriptorV1 = {
  ...descriptor,
  toolContractId: 'core.scheduler.other',
  localName: 'schedule.other',
  displayName: 'Other scheduled tasks',
  description: 'List other scheduled tasks',
  requiredPermissions: ['Scheduler.Other'],
  nativeRequirements: { capabilityIds: ['scheduler.other'], osPermissions: [] },
  handlerId: 'core.scheduler.other'
}

describe('local tool export catalog', () => {
  it('filters by trusted recipient grants and emits deterministic Python-shaped hashes', () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({ descriptor, handler: () => ({ items: [] }) })
    const context: LocalToolProjectionContext = {
      recipientPeerId: 'recipient',
      recipientPermissions: ['Tooling.GetTools', 'Tooling.ExecuteTool', 'Scheduler.List'],
      authorityRevision: authority,
      providerEnabled: true,
      serviceExported: true,
      discoveryExported: true,
      executionExported: true
    }

    const page = buildLocalToolExportCatalogPage({
      protocol_tier: 'projection_v1',
      page_size: 100
    }, {
      providerPeerId: 'provider',
      serviceInstanceId: 'remote:provider:Tooling',
      tools: registry.publicTools(),
      context,
      exportDecision: allowExport,
      cursorSecret: 'test-cursor-secret',
      nowSeconds: () => 10,
      nonce: () => 'nonce'
    })

    expect(page.complete).toBe(true)
    expect(page.tools).toHaveLength(1)
    expect(page.service_instance_id).toBe('remote:provider:Tooling')
    expect(page.tools[0]).toMatchObject({
      provider_peer_id: 'provider',
      provider_service_instance_id: 'remote:provider:Tooling',
      provenance: {
        provider_peer_id: 'provider',
        provider_service_instance_id: 'remote:provider:Tooling'
      }
    })
    expect(page.blocked_tools).toEqual([])
    expect(page.retirements).toEqual([])
    expect(page.final_checksum).toBe(computeProjectionChecksum(page.tools, [], []))
    expect(page.page_hash).toBe(computeProjectionPageHash(page))
    expect(page.projection_digest).toBe(page.final_checksum)
    expect(projectionDigest(page.tools, 'recipient', authority)).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('fails closed on cursor tamper and authority changes', () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({ descriptor, handler: () => ({ items: [] }) })
    const context: LocalToolProjectionContext = {
      recipientPeerId: 'recipient',
      recipientPermissions: ['Tooling.GetTools', 'Tooling.ExecuteTool', 'Scheduler.List'],
      authorityRevision: authority,
      providerEnabled: true,
      serviceExported: true,
      discoveryExported: true,
      executionExported: true
    }
    const firstTool = registry.publicTools()[0]!
    const secondTool = {
      ...firstTool,
      global_tool_id: 'aurora-tool:v1:provider:Tooling:core.scheduler.other',
      tool_contract_id: 'core.scheduler.other',
      local_name: 'schedule.other',
      name: 'schedule.other'
    }
    const first = buildLocalToolExportCatalogPage({ page_size: 1 }, {
      providerPeerId: 'provider',
      serviceInstanceId: 'remote:provider:Tooling',
      tools: [firstTool, secondTool],
      context,
      exportDecision: allowExport,
      cursorSecret: 'test-cursor-secret',
      nowSeconds: () => 10,
      nonce: () => 'nonce'
    })
    expect(first.complete).toBe(false)
    expect(first.next_cursor).toBeTruthy()
    expect(() => buildLocalToolExportCatalogPage({ page_size: 1, cursor: `${first.next_cursor ?? ''}A` }, {
      providerPeerId: 'provider',
      serviceInstanceId: 'remote:provider:Tooling',
      tools: registry.publicTools(),
      context,
      exportDecision: allowExport,
      cursorSecret: 'test-cursor-secret'
    })).toThrow(/projection_restart_required/)
    expect(() => buildLocalToolExportCatalogPage({ page_size: 2, cursor: first.next_cursor ?? null }, {
      providerPeerId: 'provider',
      serviceInstanceId: 'remote:provider:Tooling',
      tools: registry.publicTools(),
      context,
      exportDecision: allowExport,
      cursorSecret: 'test-cursor-secret'
    })).toThrow(/projection_restart_required/)
  })

  it('denies exports by default and rejects missing or expired cursor secrets', () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({ descriptor, handler: () => ({ items: [] }) })
    const context: LocalToolProjectionContext = {
      recipientPeerId: 'recipient',
      recipientPermissions: ['*'],
      authorityRevision: authority,
      providerEnabled: true,
      serviceExported: true,
      discoveryExported: true,
      executionExported: true
    }
    const firstTool = registry.publicTools()[0]!
    const secondTool = {
      ...firstTool,
      global_tool_id: 'aurora-tool:v1:provider:Tooling:core.scheduler.other',
      tool_contract_id: 'core.scheduler.other',
      local_name: 'schedule.other',
      name: 'schedule.other'
    }

    const empty = buildLocalToolExportCatalogPage({ page_size: 100 }, {
      providerPeerId: 'provider',
      serviceInstanceId: 'remote:provider:Tooling',
      tools: [firstTool],
      context
    })
    expect(empty).toMatchObject({ complete: true, total_count: 0, tools: [] })

    expect(() => buildLocalToolExportCatalogPage({ page_size: 1 }, {
      providerPeerId: 'provider',
      serviceInstanceId: 'remote:provider:Tooling',
      tools: [firstTool, secondTool],
      context,
      exportDecision: allowExport
    })).toThrow(/projection_cursor_secret_required/)

    const first = buildLocalToolExportCatalogPage({ page_size: 1 }, {
      providerPeerId: 'provider',
      serviceInstanceId: 'remote:provider:Tooling',
      tools: [firstTool, secondTool],
      context,
      exportDecision: allowExport,
      cursorSecret: 'test-cursor-secret',
      cursorTtlSeconds: 1,
      nowSeconds: () => 10,
      nonce: () => 'nonce'
    })
    expect(() => buildLocalToolExportCatalogPage({ page_size: 1, cursor: first.next_cursor ?? null }, {
      providerPeerId: 'provider',
      serviceInstanceId: 'remote:provider:Tooling',
      tools: [firstTool, secondTool],
      context,
      exportDecision: allowExport,
      cursorSecret: 'test-cursor-secret',
      nowSeconds: () => 11
    })).toThrow(/projection_restart_required/)
  })

  it('emits permission-blocked inventory with deterministic pagination and hashes', () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({ descriptor, handler: () => ({ items: [] }) })
    registry.register({ descriptor: otherDescriptor, handler: () => ({ items: [] }) })
    const context: LocalToolProjectionContext = {
      recipientPeerId: 'recipient',
      recipientPermissions: ['Tooling.GetTools', 'Tooling.ExecuteTool'],
      authorityRevision: authority,
      providerEnabled: true,
      serviceExported: true,
      discoveryExported: true,
      executionExported: true
    }

    const complete = buildLocalToolExportCatalogPage({ page_size: 100 }, {
      providerPeerId: 'provider',
      serviceInstanceId: 'remote:provider:Tooling',
      tools: registry.publicTools(),
      context,
      exportDecision: allowExport
    })
    expect(complete).toMatchObject({ complete: true, total_count: 2, tools: [] })
    const completeBlocked = complete.blocked_tools ?? []
    expect(completeBlocked).toHaveLength(2)
    expect(completeBlocked.map((blocked) => blocked.missing_permissions)).toEqual([
      ['Scheduler.List'],
      ['Scheduler.Other']
    ])
    expect(completeBlocked.map((blocked) => blocked.reason_code)).toEqual([
      'recipient_missing_tool_permissions',
      'recipient_missing_tool_permissions'
    ])
    expect(complete.final_checksum).toBe(computeProjectionChecksum([], [], completeBlocked))
    expect(complete.projection_digest).toBe(complete.final_checksum)
    expect(complete.page_hash).toBe(computeProjectionPageHash(complete))

    const first = buildLocalToolExportCatalogPage({ page_size: 1 }, {
      providerPeerId: 'provider',
      serviceInstanceId: 'remote:provider:Tooling',
      tools: registry.publicTools(),
      context,
      exportDecision: allowExport,
      cursorSecret: 'test-cursor-secret',
      nowSeconds: () => 10,
      nonce: () => 'nonce'
    })
    expect(first.complete).toBe(false)
    expect(first.tools).toEqual([])
    const firstBlocked = first.blocked_tools ?? []
    expect(firstBlocked).toHaveLength(1)
    expect(firstBlocked[0]?.missing_permissions).toEqual(['Scheduler.List'])

    const second = buildLocalToolExportCatalogPage({ page_size: 1, cursor: first.next_cursor ?? null }, {
      providerPeerId: 'provider',
      serviceInstanceId: 'remote:provider:Tooling',
      tools: registry.publicTools(),
      context,
      exportDecision: allowExport,
      cursorSecret: 'test-cursor-secret',
      nowSeconds: () => 10
    })
    expect(second.complete).toBe(true)
    expect(second.tools).toEqual([])
    const secondBlocked = second.blocked_tools ?? []
    expect(secondBlocked).toHaveLength(1)
    expect(secondBlocked[0]?.missing_permissions).toEqual(['Scheduler.Other'])
    expect(second.total_count).toBe(2)
  })

  it('does not disclose blocked inventory without Tooling discovery and execution authority', () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({ descriptor, handler: () => ({ items: [] }) })
    const baseContext: LocalToolProjectionContext = {
      recipientPeerId: 'recipient',
      recipientPermissions: [],
      authorityRevision: authority,
      providerEnabled: true,
      serviceExported: true,
      discoveryExported: true,
      executionExported: true
    }

    for (const recipientPermissions of [
      [],
      ['Tooling.GetTools'],
      ['Tooling.ExecuteTool']
    ]) {
      const page = buildLocalToolExportCatalogPage({ page_size: 100 }, {
        providerPeerId: 'provider',
        serviceInstanceId: 'remote:provider:Tooling',
        tools: registry.publicTools(),
        context: { ...baseContext, recipientPermissions },
        exportDecision: allowExport
      })
      expect(page).toMatchObject({ complete: true, total_count: 0, tools: [], blocked_tools: [] })
    }
  })
})

const allowExport = { isShared: () => true }

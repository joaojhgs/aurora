import { describe, expect, it } from 'vitest'

import { LocalToolRegistry, type LocalToolDescriptorV1 } from '../src/local-tools/index.js'

const descriptor: LocalToolDescriptorV1 = {
  version: 1,
  toolContractId: 'core.memory.upsert',
  localName: 'memory.upsert',
  displayName: 'Memory',
  description: 'Store a memory',
  argsSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      apiKey: { type: 'string' },
      note: { type: 'string' }
    },
    required: ['text']
  },
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  argumentVisibility: { text: 'public', apiKey: 'secret', note: 'private' },
  requiredPermissions: ['Memory.Upsert'],
  resourceScopes: ['memory.local'],
  safetyClass: 'sensitive',
  privacyClass: 'personal',
  mutating: true,
  dataEgress: false,
  nativeRequirements: { capabilityIds: ['memory.write'], osPermissions: [] },
  confirmationPolicy: 'sensitive',
  handlerId: 'core.memory.upsert'
}

describe('local tool registry', () => {
  it('keeps handler IDs private while exposing stable Tooling projection metadata', () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'peer-provider', providerLabel: 'Provider' })
    registry.register({ descriptor, handler: () => ({ ok: true }) })

    const [tool] = registry.publicTools()
    expect(tool).toMatchObject({
      name: 'memory.upsert',
      local_name: 'memory.upsert',
      global_tool_id: 'aurora-tool:v1:peer-provider:Tooling:core.memory.upsert',
      provider_peer_id: 'peer-provider',
      provider_service_instance_id: 'local:peer-provider:Tooling',
      exportable: true,
      argument_visibility: {
        text: 'display',
        apiKey: 'secret',
        note: 'hash_only'
      },
      required_permissions: ['Memory.Upsert'],
      confirmation_required: true
    })
    expect(JSON.stringify(tool)).not.toContain('handlerId')
    expect(registry.resolvePublicId('core.memory.upsert')).not.toHaveProperty('handler')
    expect(registry.resolveForDispatch('core.memory.upsert')?.descriptor.handlerId).toBe('core.memory.upsert')
  })

  it('rejects duplicate public and private authority IDs', () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'peer-provider' })
    registry.register({ descriptor, handler: () => null })
    expect(() => registry.register({ descriptor: { ...descriptor, handlerId: 'different.handler' }, handler: () => null })).toThrow(/duplicate_tool_contract_id/)
    expect(() => registry.register({
      descriptor: { ...descriptor, toolContractId: 'core.memory.other' },
      handler: () => null
    })).toThrow(/duplicate_local_name/)
    expect(() => registry.register({
      descriptor: { ...descriptor, toolContractId: 'core.memory.third', localName: 'memory.third' },
      handler: () => null
    })).toThrow(/duplicate_handler_id/)
  })
})

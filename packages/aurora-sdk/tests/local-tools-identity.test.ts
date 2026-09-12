import { describe, expect, it } from 'vitest'

import {
  localToolProjectionIdentity,
  parseLocalToolDescriptorV1,
  parseRemoteLocalToolDescriptorV1,
  publicLocalToolDescriptorV1
} from '../src/local-tools/descriptor-v1.js'
import { globalToolId, providerServiceInstanceId } from '../src/local-tools/identity.js'

const descriptor = {
  version: 1,
  toolContractId: 'core.memory.upsert',
  localName: 'memory.upsert',
  displayName: 'Memory',
  description: 'Store a memory',
  argsSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      privateNote: { type: 'string' }
    },
    required: ['text']
  },
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' }
    },
    required: ['ok']
  },
  argumentVisibility: {
    text: 'public',
    privateNote: 'secret'
  },
  requiredPermissions: ['Tooling.ExecuteTool'],
  resourceScopes: ['memory.local'],
  safetyClass: 'sensitive',
  privacyClass: 'personal',
  mutating: true,
  dataEgress: false,
  nativeRequirements: {
    capabilityIds: ['memory.write'],
    osPermissions: []
  },
  confirmationPolicy: 'sensitive',
  handlerId: 'core.memory.upsert'
} as const

describe('local tool descriptor v1', () => {
  it('normalizes local-only handler metadata separately from public projection identity', () => {
    const parsed = parseLocalToolDescriptorV1(descriptor)
    const publicDescriptor = publicLocalToolDescriptorV1(parsed)
    expect(publicDescriptor).not.toHaveProperty('handlerId')

    const identity = localToolProjectionIdentity('peer ☃', parsed)
    expect(identity.providerPeerId).toBe('peer ☃')
    expect(identity.providerServiceInstanceId).toBe(providerServiceInstanceId('peer ☃'))
    expect(identity.globalToolId).toBe(globalToolId('peer ☃', 'core.memory.upsert'))
    expect(identity.schemaHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(identity.descriptorHash).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('rejects remote descriptor shapes that attempt to select local handlers', () => {
    expect(() => parseRemoteLocalToolDescriptorV1(publicLocalToolDescriptorV1(parseLocalToolDescriptorV1(descriptor)))).not.toThrow()
    expect(() => parseRemoteLocalToolDescriptorV1(descriptor)).toThrow()
  })

  it('rejects unsupported or hostile descriptor shapes before registration', () => {
    expect(() => parseLocalToolDescriptorV1({ ...descriptor, unknown: true })).toThrow()
    expect(() => parseLocalToolDescriptorV1({ ...descriptor, toolContractId: ' core.memory.upsert' })).toThrow()
    expect(() => parseLocalToolDescriptorV1({ ...descriptor, safetyClass: 'dangerous', confirmationPolicy: 'sensitive' })).toThrow()
    expect(() => parseLocalToolDescriptorV1({ ...descriptor, argumentVisibility: { missing: 'secret' } })).toThrow()
    expect(() => parseLocalToolDescriptorV1({ ...descriptor, argsSchema: { type: 'object', constructor: 'polluted' } })).toThrow()
    expect(() => parseLocalToolDescriptorV1({ ...descriptor, argsSchema: { type: 'object', multipleOf: 0.25 } })).toThrow()
    expect(() => parseLocalToolDescriptorV1({ ...descriptor, argsSchema: { type: 'object', maximum: 1e20 } })).toThrow()
    expect(() => parseLocalToolDescriptorV1({ ...descriptor, argsSchema: { type: 'object', enum: sparseArray() } })).toThrow()
  })
})

function sparseArray(): unknown[] {
  const value = ['first', 'third']
  delete value[1]
  return value
}

import { describe, expect, it } from 'vitest'
import {
  AURORA_NODE_CONFIG_MODULES,
  AURORA_NODE_CONFIG_STORAGE_KEY,
  AuroraNodeConfigValidationError,
  AuroraServiceRoutingError,
  createAuroraNodeConfigTauriStore,
  emptyAuroraNodeConfigDocument,
  isAuroraNodeConfigModule,
  isAuroraNodeServiceExposed,
  migrateAuroraNodeConfigDocument,
  parseAuroraNodeConfigDocument,
  parseAuroraNodeConfigDocumentWire,
  resolveServiceRouting,
  sanitizeAuroraNodeConfigDocument,
  serializeAuroraNodeConfigDocument,
  TauriLocalTransport,
  type AuroraNodeConfigDocumentV1,
  type AuroraNodeConfigModule,
  type AuroraNodeConfigTauriTransport,
  type AuroraNodeRouteCandidate,
  type AuroraNodeRoutingFallback,
  type AuroraNodeRoutingPreference,
} from '../src/index.js'

  const remoteCandidate: AuroraNodeRouteCandidate = {
  peerId: 'home-peer',
  providerId: 'tts-provider',
    serviceInstanceId: 'tts-instance',
    module: 'tts',
  selector: {
    peerId: 'home-peer',
    providerId: 'tts-provider',
    serviceInstanceId: 'tts-instance',
    module: 'tts',
  },
}

function configFor(
  module: AuroraNodeConfigModule,
  prefer: AuroraNodeRoutingPreference,
  fallback: AuroraNodeRoutingFallback,
): AuroraNodeConfigDocumentV1 {
  const document = emptyAuroraNodeConfigDocument(100)
  document.services[module] = { routing: { prefer, fallback } }
  return document
}

describe('Aurora node config document', () => {
  it('provides explicit safe defaults and excludes local-only voice tasks', () => {
    const document = emptyAuroraNodeConfigDocument(100)

    expect(document.version).toBe(1)
    expect(document.updatedAtMs).toBe(100)
    expect(document.services.tooling).toEqual({
      routing: { prefer: 'local', fallback: 'network' },
      expose: { enabled: true },
    })
    expect(document.services.memory).toEqual({
      routing: { prefer: 'network_only', fallback: 'error' },
      expose: { enabled: false },
    })
    expect(Object.keys(document.services)).toEqual([...AURORA_NODE_CONFIG_MODULES])
    expect(isAuroraNodeConfigModule('wakeword')).toBe(false)
    expect(isAuroraNodeConfigModule('vad')).toBe(false)
    expect(isAuroraNodeServiceExposed(document, 'tooling')).toBe(true)
    expect(isAuroraNodeServiceExposed(document, 'tts')).toBe(false)
  })

  it('round-trips through sanitization and serialization without retaining unknown fields', () => {
    const document = emptyAuroraNodeConfigDocument(200)
    document.services.tts = {
      routing: { prefer: 'network', fallback: 'local' },
      expose: { enabled: false },
    }
    document.expose.featureOverrides.tooling = {
      'calendar.read': { enabled: true },
    }

    const parsed = parseAuroraNodeConfigDocument(serializeAuroraNodeConfigDocument(document))
    expect(parsed).toEqual(document)
    expect(sanitizeAuroraNodeConfigDocument(parsed)).toEqual(document)
  })

  it('migrates a sparse legacy policy while keeping missing modules at safe defaults', () => {
    const migrated = migrateAuroraNodeConfigDocument({
      version: 0,
      updatedAtMs: 300,
      services: {
        tts: { prefer: 'network', fallback: 'local' },
        wakeword: { prefer: 'network' },
      },
    }, 99)

    expect(migrated.updatedAtMs).toBe(300)
    expect(migrated.services.tts?.routing).toEqual({ prefer: 'network', fallback: 'local' })
    expect(migrated.services.memory?.routing).toEqual({ prefer: 'network_only', fallback: 'error' })
    expect(Object.prototype.hasOwnProperty.call(migrated.services, 'wakeword')).toBe(false)
  })

  it('migrates an absent document to defaults and reports the wire version', () => {
    const wire = parseAuroraNodeConfigDocumentWire(null, 400)

    expect(wire?.migratedFromVersion).toBe(0)
    expect(wire?.document).toEqual(emptyAuroraNodeConfigDocument(400))
  })

  it('rejects unsupported modules, secret-like fields, and invalid policy values', () => {
    const document = emptyAuroraNodeConfigDocument(100)
    const invalid = {
      ...document,
      services: {
        ...document.services,
        wakeword: { routing: { prefer: 'network', fallback: 'error' } },
      },
    }

    expect(() => sanitizeAuroraNodeConfigDocument(invalid)).toThrow(AuroraNodeConfigValidationError)
    expect(() => sanitizeAuroraNodeConfigDocument({
      ...document,
      token: 'must not persist',
    })).toThrow('unknown field')
    expect(() => sanitizeAuroraNodeConfigDocument({
      ...document,
      services: {
        ...document.services,
        tts: { routing: { prefer: 'sometimes', fallback: 'network' } },
      },
    })).toThrow('unsupported preference')
    const prototypePollution = JSON.parse('{"tts":{"__proto__":{"enabled":true}}}') as Record<string, unknown>
    expect(() => sanitizeAuroraNodeConfigDocument({
      ...document,
      expose: {
        featureOverrides: prototypePollution,
      },
    })).toThrow('feature ID')
    expect(parseAuroraNodeConfigDocument('{"version":1,"updatedAtMs":-1}')).toBeNull()
  })
})

describe('resolveServiceRouting', () => {
  const cases: Array<{
    name: string
    prefer: AuroraNodeRoutingPreference
    fallback: AuroraNodeRoutingFallback
    localAvailable: boolean
    remotes: AuroraNodeRouteCandidate[]
    source?: 'local' | 'remote'
  }> = [
    { name: 'local preference uses local', prefer: 'local', fallback: 'network', localAvailable: true, remotes: [], source: 'local' },
    { name: 'local preference falls back to network', prefer: 'local', fallback: 'network', localAvailable: false, remotes: [remoteCandidate], source: 'remote' },
    { name: 'network preference uses remote', prefer: 'network', fallback: 'local', localAvailable: true, remotes: [remoteCandidate], source: 'remote' },
    { name: 'network preference falls back to local', prefer: 'network', fallback: 'local', localAvailable: true, remotes: [], source: 'local' },
    { name: 'local-only stays local', prefer: 'local_only', fallback: 'network', localAvailable: true, remotes: [remoteCandidate], source: 'local' },
    { name: 'network-only uses remote', prefer: 'network_only', fallback: 'error', localAvailable: true, remotes: [remoteCandidate], source: 'remote' },
  ]

  for (const scenario of cases) {
    it(scenario.name, () => {
      const records: unknown[] = []
      const result = resolveServiceRouting({
        module: 'tts',
        config: configFor('tts', scenario.prefer, scenario.fallback),
        localCapability: { available: scenario.localAvailable, reason: 'pack missing' },
        remoteCandidates: scenario.remotes,
        emit: (record) => records.push(record),
        now: () => 500,
      })

      expect(result.source).toBe(scenario.source)
      expect(result.record.resolvedAtMs).toBe(500)
      expect(records).toEqual([result.record])
      if (result.source === 'remote') {
        expect(result.selector).toEqual(remoteCandidate.selector)
      } else {
        expect(result.selector).toBeNull()
      }
    })
  }

  it('returns remaining remote candidates in stable fallback order and ignores ineligible routes', () => {
    const second: AuroraNodeRouteCandidate = { peerId: 'backup-peer', module: 'tts' }
    const result = resolveServiceRouting({
      module: 'tts',
      config: configFor('tts', 'network', 'network'),
      localCapability: { available: false },
      remoteCandidates: [
        { ...remoteCandidate, eligible: false },
        remoteCandidate,
        second,
      ],
    })

    expect(result.source).toBe('remote')
    expect(result.selector).toEqual(remoteCandidate.selector)
    expect(result.fallback.map((attempt) => attempt.candidate)).toEqual([expect.objectContaining(second)])
    expect(result.record.remoteCandidateIds).toEqual([
      'home-peer|tts-provider|tts-instance|tts',
      'backup-peer|||tts',
    ])
  })

  it('keeps strict and explicit fallback attempts inside their selected route class', () => {
    const localOnly = resolveServiceRouting({
      module: 'tts',
      config: configFor('tts', 'local_only', 'network'),
      localCapability: { available: true },
      remoteCandidates: [remoteCandidate],
    })
    expect(localOnly.attempt.source).toBe('local')
    expect(localOnly.fallback).toEqual([])

    const remoteWithLocalFallback = resolveServiceRouting({
      module: 'tts',
      config: configFor('tts', 'network', 'local'),
      localCapability: { available: true },
      remoteCandidates: [remoteCandidate],
    })
    expect(remoteWithLocalFallback.attempt.source).toBe('remote')
    expect(remoteWithLocalFallback.fallback).toEqual([
      { id: 'local:tts', source: 'local', selector: null, candidate: null },
    ])
    expect(remoteWithLocalFallback.record.fallbackCandidateIds).toEqual(['local:tts'])

    for (const fallback of ['error', 'none'] as const) {
      const result = resolveServiceRouting({
        module: 'tts',
        config: configFor('tts', 'local', fallback),
        localCapability: { available: true },
        remoteCandidates: [remoteCandidate],
      })
      expect(result.fallback).toEqual([])
      expect(result.record.fallbackCandidateIds).toEqual([])
    }
  })

  it('supports the full preference/fallback availability matrix without implicit crossing', () => {
    const preferences = ['local', 'network', 'local_only', 'network_only'] as const
    const fallbacks = ['local', 'network', 'error', 'none'] as const
    for (const prefer of preferences) {
      for (const fallback of fallbacks) {
        for (const localAvailable of [false, true]) {
          for (const remotes of [[], [remoteCandidate]]) {
            let result: ReturnType<typeof resolveServiceRouting> | undefined
            try {
              result = resolveServiceRouting({
                module: 'tts',
                config: configFor('tts', prefer, fallback),
                localCapability: { available: localAvailable },
                remoteCandidates: remotes,
              })
            } catch (error) {
              expect(error).toBeInstanceOf(AuroraServiceRoutingError)
            }
            if (result === undefined) continue
            const attempts = [result.attempt, ...result.fallback]
            if (prefer.endsWith('_only')) {
              expect(attempts.every((attempt) => attempt.source === (prefer === 'local_only' ? 'local' : 'remote'))).toBe(true)
            }
            if (fallback === 'error' || fallback === 'none') expect(result.fallback).toEqual([])
            if (fallback === 'local') expect(result.fallback.every((attempt) => attempt.source === 'local')).toBe(true)
            if (fallback === 'network') expect(result.fallback.every((attempt) => attempt.source === 'remote')).toBe(true)
          }
        }
      }
    }
  })

  it('rejects selectors whose identity conflicts with the candidate audit identity', () => {
    expect(() => resolveServiceRouting({
      module: 'tts',
      config: configFor('tts', 'network', 'error'),
      localCapability: { available: false },
      remoteCandidates: [{ ...remoteCandidate, selector: { peerId: 'other-peer' } }],
    })).toThrow('does not match candidate identity')
    expect(() => resolveServiceRouting({
      module: 'tts',
      config: configFor('tts', 'network', 'error'),
      localCapability: { available: false },
      remoteCandidates: [{ ...remoteCandidate, selector: { peerId: 'home-peer', module: 'memory' } }],
    })).toThrow('does not match candidate identity')
    expect(() => resolveServiceRouting({
      module: 'tts',
      config: configFor('tts', 'network', 'error'),
      localCapability: { available: false },
      remoteCandidates: [{ ...remoteCandidate, selector: undefined, module: 'memory' }],
    })).toThrow('must match the requested service module')
  })

  it('never crosses local-only or network-only policies when the required route is unavailable', () => {
    for (const [prefer, localAvailable, remotes] of [
      ['local_only', false, [remoteCandidate]],
      ['network_only', true, []],
    ] as const) {
      expect(() => resolveServiceRouting({
        module: 'tts',
        config: configFor('tts', prefer, 'network'),
        localCapability: { available: localAvailable },
        remoteCandidates: remotes,
      })).toThrow(AuroraServiceRoutingError)
    }
  })

  it('emits a failure record and throws when a non-strict fallback cannot resolve', () => {
    const records: Array<{ reason: string; decision: string }> = []
    expect(() => resolveServiceRouting({
      module: 'memory',
      config: configFor('memory', 'local', 'error'),
      localCapability: { available: false, reason: 'RAG unavailable' },
      remoteCandidates: [],
      emit: (record) => records.push(record),
    })).toThrow(AuroraServiceRoutingError)
    expect(records[0]).toMatchObject({
      module: 'memory',
      decision: 'local',
      reason: 'RAG unavailable',
      localAvailable: false,
    })
  })

  it('does not make a failing observability sink affect routing', () => {
    const result = resolveServiceRouting({
      module: 'tts',
      config: configFor('tts', 'local', 'network'),
      localCapability: { available: true },
      remoteCandidates: [],
      emit: () => { throw new Error('telemetry unavailable') },
    })
    expect(result.source).toBe('local')
  })
})

describe('createAuroraNodeConfigTauriStore', () => {
  class FakeTauriTransport implements AuroraNodeConfigTauriTransport {
    readonly values = new Map<string, string>()

    async nodeConfigGet(): Promise<{ key: string; value: string | null }> {
      return { key: AURORA_NODE_CONFIG_STORAGE_KEY, value: this.values.get(AURORA_NODE_CONFIG_STORAGE_KEY) ?? null }
    }

    async nodeConfigSet(value: string): Promise<{ key: string; ok: boolean }> {
      this.values.set(AURORA_NODE_CONFIG_STORAGE_KEY, value)
      return { key: AURORA_NODE_CONFIG_STORAGE_KEY, ok: true }
    }

    async nodeConfigDelete(): Promise<{ key: string; ok: boolean }> {
      this.values.delete(AURORA_NODE_CONFIG_STORAGE_KEY)
      return { key: AURORA_NODE_CONFIG_STORAGE_KEY, ok: true }
    }
  }

  it('uses a dedicated secure-storage key and drops invalid persisted documents', async () => {
    const storage = new FakeTauriTransport()
    const store = createAuroraNodeConfigTauriStore(storage)
    const document = emptyAuroraNodeConfigDocument(600)

    await store.save(document)
    expect(storage.values.has(AURORA_NODE_CONFIG_STORAGE_KEY)).toBe(true)
    expect(await store.load()).toEqual(document)

    storage.values.set(AURORA_NODE_CONFIG_STORAGE_KEY, '{"version":1,"updatedAtMs":-1}')
    expect(await store.load()).toBeNull()
    expect(storage.values.has(AURORA_NODE_CONFIG_STORAGE_KEY)).toBe(false)
    await store.clear?.()
    expect(storage.values.size).toBe(0)
  })

  it('uses the real narrow TauriLocalTransport command boundary', async () => {
    const values = new Map<string, string>()
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const transport = new TauriLocalTransport({
      listen: async () => () => {},
      invoke: async (command, args) => {
        calls.push(args === undefined ? { command } : { command, args })
        if (command === 'aurora_node_config_get') {
          return { key: AURORA_NODE_CONFIG_STORAGE_KEY, value: values.get(AURORA_NODE_CONFIG_STORAGE_KEY) ?? null }
        }
        if (command === 'aurora_node_config_set') {
          values.set(AURORA_NODE_CONFIG_STORAGE_KEY, String(args?.value))
          return { key: AURORA_NODE_CONFIG_STORAGE_KEY, ok: true }
        }
        if (command === 'aurora_node_config_delete') {
          values.delete(AURORA_NODE_CONFIG_STORAGE_KEY)
          return { key: AURORA_NODE_CONFIG_STORAGE_KEY, ok: true }
        }
        throw new Error(`unexpected command ${command}`)
      },
    })
    const store = createAuroraNodeConfigTauriStore(transport)
    const document = emptyAuroraNodeConfigDocument(610)

    await store.save(document)
    expect(await store.load()).toEqual(document)
    await store.clear?.()
    expect(calls.map(({ command }) => command)).toEqual([
      'aurora_node_config_set',
      'aurora_node_config_get',
      'aurora_node_config_delete',
    ])
    expect(calls.some(({ command, args }) => command.startsWith('aurora_secure_storage') || args?.key !== undefined)).toBe(false)
  })
})

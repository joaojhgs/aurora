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
  type AuroraNodeConfigDocumentV1,
  type AuroraNodeConfigModule,
  type AuroraNodeConfigSecureStorage,
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
    peer_id: 'home-peer',
    provider_id: 'tts-provider',
    service_instance_id: 'tts-instance',
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
      config: configFor('tts', 'network', 'local'),
      localCapability: { available: false },
      remoteCandidates: [
        { ...remoteCandidate, eligible: false },
        remoteCandidate,
        second,
      ],
    })

    expect(result.source).toBe('remote')
    expect(result.selector).toEqual(remoteCandidate.selector)
    expect(result.fallback).toEqual([second])
    expect(result.record.remoteCandidateIds).toEqual([
      'home-peer|tts-provider|tts-instance',
      'backup-peer||',
    ])
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
  class FakeSecureStorage implements AuroraNodeConfigSecureStorage {
    readonly values = new Map<string, string>()

    async get(key: string): Promise<{ value: string | null }> {
      return { value: this.values.get(key) ?? null }
    }

    async set(key: string, value: string): Promise<{ ok: boolean }> {
      this.values.set(key, value)
      return { ok: true }
    }

    async delete(key: string): Promise<{ ok: boolean }> {
      this.values.delete(key)
      return { ok: true }
    }
  }

  it('uses a dedicated secure-storage key and drops invalid persisted documents', async () => {
    const storage = new FakeSecureStorage()
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
})

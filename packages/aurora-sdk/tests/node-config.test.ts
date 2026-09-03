import { describe, expect, it, vi } from 'vitest'
import { TTSRequestInputTTSRequestSchema } from '../src/generated/backend-contracts.zod.js'
import { MemoryClient } from '../src/memory.js'
import {
  AURORA_NODE_CONFIG_MODULES,
  AURORA_NODE_CONFIG_STORAGE_KEY,
  AURORA_NODE_RUNTIME_MODULES_BY_POLICY,
  AuroraNodeConfigValidationError,
  AuroraServiceRoutingError,
  createAuroraNodeConfigTauriStore,
  emptyAuroraNodeConfigDocument,
  isAuroraNodeConfigModule,
  isAuroraNodeServiceExposed,
  isRuntimeModuleForNodeConfigModule,
  migrateAuroraNodeConfigDocument,
  parseAuroraNodeConfigDocument,
  parseAuroraNodeConfigDocumentWire,
  resolveServiceRouting,
  sanitizeAuroraNodeConfigDocument,
  serializeAuroraNodeConfigDocument,
  runtimeModulesForNodeConfigModule,
  TauriLocalTransport,
  type AuroraNodeConfigDocumentV1,
  type AuroraNodeConfigModule,
  type AuroraNodeConfigTauriTransport,
  type AuroraNodeRouteCandidate,
  type AuroraNodeRoutingFallback,
  type AuroraNodeRoutingPreference,
} from '../src/index.js'
import type { AuroraClient } from '../src/client.js'

  const remoteCandidate: AuroraNodeRouteCandidate = {
  peerId: 'home-peer',
  providerId: 'tts-provider',
  serviceInstanceId: 'tts-instance',
  module: 'TTS',
  selector: {
    peer_id: 'home-peer',
    provider_id: 'tts-provider',
    service_instance_id: 'tts-instance',
    module: 'TTS',
  },
}

const remoteCandidateId = 'home-peer|tts-provider|tts-instance|TTS'
const backupCandidateId = 'backup-peer|backup-provider|backup-instance|TTS'

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
        expect(result.selector).toEqual({
          peer_id: 'home-peer',
          provider_id: 'tts-provider',
          service_instance_id: 'tts-instance',
        })
      } else {
        expect(result.selector).toBeNull()
      }
    })
  }

  it('returns remaining remote candidates in stable fallback order and ignores ineligible routes', () => {
    const second: AuroraNodeRouteCandidate = { peerId: 'backup-peer', module: 'TTS' }
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
    expect(result.selector).toEqual({
      peer_id: 'home-peer',
      provider_id: 'tts-provider',
      service_instance_id: 'tts-instance',
    })
    expect(result.fallback.map((attempt) => attempt.candidate)).toEqual([expect.objectContaining(second)])
    expect(result.record.remoteCandidateIds).toEqual([remoteCandidateId, 'backup-peer|||TTS'])
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
    type MatrixOutcome = {
      expectedSource: 'local' | 'remote' | 'error'
      expectedAttempts: string[]
    }
    type MatrixScenario = {
      prefer: AuroraNodeRoutingPreference
      fallback: AuroraNodeRoutingFallback
      outcomes: Record<'00' | '01' | '10' | '11', MatrixOutcome>
    }
    const matrix: MatrixScenario[] = [
      {
        prefer: 'local', fallback: 'local', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'error', expectedAttempts: [] },
          '10': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
          '11': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
        },
      },
      {
        prefer: 'local', fallback: 'network', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId, backupCandidateId] },
          '10': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
          '11': { expectedSource: 'local', expectedAttempts: ['local:tts', remoteCandidateId, backupCandidateId] },
        },
      },
      {
        prefer: 'local', fallback: 'error', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'error', expectedAttempts: [] },
          '10': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
          '11': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
        },
      },
      {
        prefer: 'local', fallback: 'none', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'error', expectedAttempts: [] },
          '10': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
          '11': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
        },
      },
      {
        prefer: 'network', fallback: 'local', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId] },
          '10': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
          '11': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId, 'local:tts'] },
        },
      },
      {
        prefer: 'network', fallback: 'network', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId, backupCandidateId] },
          '10': { expectedSource: 'error', expectedAttempts: [] },
          '11': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId, backupCandidateId] },
        },
      },
      {
        prefer: 'network', fallback: 'error', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId] },
          '10': { expectedSource: 'error', expectedAttempts: [] },
          '11': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId] },
        },
      },
      {
        prefer: 'network', fallback: 'none', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId] },
          '10': { expectedSource: 'error', expectedAttempts: [] },
          '11': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId] },
        },
      },
      {
        prefer: 'local_only', fallback: 'local', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'error', expectedAttempts: [] },
          '10': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
          '11': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
        },
      },
      {
        prefer: 'local_only', fallback: 'network', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'error', expectedAttempts: [] },
          '10': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
          '11': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
        },
      },
      {
        prefer: 'local_only', fallback: 'error', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'error', expectedAttempts: [] },
          '10': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
          '11': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
        },
      },
      {
        prefer: 'local_only', fallback: 'none', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'error', expectedAttempts: [] },
          '10': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
          '11': { expectedSource: 'local', expectedAttempts: ['local:tts'] },
        },
      },
      {
        prefer: 'network_only', fallback: 'local', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId] },
          '10': { expectedSource: 'error', expectedAttempts: [] },
          '11': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId] },
        },
      },
      {
        prefer: 'network_only', fallback: 'network', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId, backupCandidateId] },
          '10': { expectedSource: 'error', expectedAttempts: [] },
          '11': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId, backupCandidateId] },
        },
      },
      {
        prefer: 'network_only', fallback: 'error', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId] },
          '10': { expectedSource: 'error', expectedAttempts: [] },
          '11': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId] },
        },
      },
      {
        prefer: 'network_only', fallback: 'none', outcomes: {
          '00': { expectedSource: 'error', expectedAttempts: [] },
          '01': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId] },
          '10': { expectedSource: 'error', expectedAttempts: [] },
          '11': { expectedSource: 'remote', expectedAttempts: [remoteCandidateId] },
        },
      },
    ]

    const backupCandidate: AuroraNodeRouteCandidate = {
      peerId: 'backup-peer',
      providerId: 'backup-provider',
      serviceInstanceId: 'backup-instance',
      module: 'TTS',
      selector: {
        peer_id: 'backup-peer',
        provider_id: 'backup-provider',
        service_instance_id: 'backup-instance',
        module: 'TTS',
      },
    }

    for (const scenario of matrix) {
      for (const localAvailable of [false, true]) {
        for (const remoteAvailable of [false, true]) {
          const matrixKey = `${localAvailable ? '1' : '0'}${remoteAvailable ? '1' : '0'}` as keyof MatrixScenario['outcomes']
          const expected = scenario.outcomes[matrixKey]
          const remoteCandidates = remoteAvailable ? [remoteCandidate, backupCandidate] : []
          let result: ReturnType<typeof resolveServiceRouting> | undefined
          let error: unknown
          try {
            result = resolveServiceRouting({
              module: 'tts',
              config: configFor('tts', scenario.prefer, scenario.fallback),
              localCapability: { available: localAvailable },
              remoteCandidates,
            })
          } catch (caught) {
            error = caught
          }

          if (expected.expectedSource === 'error') {
            expect(result).toBeUndefined()
            expect(error).toBeInstanceOf(AuroraServiceRoutingError)
            expect((error as AuroraServiceRoutingError).record).toMatchObject({
              preference: scenario.prefer,
              fallbackPolicy: scenario.fallback,
              selectedCandidateId: null,
              fallbackCandidateIds: [],
            })
            continue
          }

          expect(error).toBeUndefined()
          expect(result?.source).toBe(expected.expectedSource)
          expect(result && [result.attempt, ...result.fallback].map((attempt) => attempt.id))
            .toEqual(expected.expectedAttempts)
          expect(result?.record.selectedCandidateId)
            .toBe(expected.expectedSource === 'remote' ? remoteCandidateId : null)
          expect(result?.record.fallbackCandidateIds).toEqual(expected.expectedAttempts.slice(1))
          expect(result?.record.remoteCandidateIds).toEqual(remoteAvailable
            ? [remoteCandidateId, backupCandidateId]
            : [])
        }
      }
    }
  })

  it('maps every policy domain to production capability module IDs', () => {
    expect(AURORA_NODE_RUNTIME_MODULES_BY_POLICY).toEqual({
      tooling: ['Tooling'],
      tts: ['TTS'],
      stt: ['STTCoordinator', 'Transcription'],
      orchestrator: ['Orchestrator'],
      memory: ['DB'],
    })

    for (const module of AURORA_NODE_CONFIG_MODULES) {
      const runtimeModules = runtimeModulesForNodeConfigModule(module)
      expect(runtimeModules.length).toBeGreaterThan(0)
      for (const runtimeModule of runtimeModules) {
        expect(isRuntimeModuleForNodeConfigModule(module, runtimeModule)).toBe(true)
        const result = resolveServiceRouting({
          module,
          config: configFor(module, 'network', 'error'),
          localCapability: { available: false },
          remoteCandidates: [{
            peerId: `${module}-peer`,
            providerId: `${module}-provider`,
            serviceInstanceId: `${module}-instance`,
            module: runtimeModule,
            selector: {
              peer_id: `${module}-peer`,
              provider_id: `${module}-provider`,
              service_instance_id: `${module}-instance`,
              module: runtimeModule,
            },
          }],
        })
        expect(result.source).toBe('remote')
        expect(result.attempt.candidate?.module).toBe(runtimeModule)
      }
    }
    expect(isRuntimeModuleForNodeConfigModule('tts', 'tts')).toBe(false)
  })

  it('emits selectors that survive generated speech parsing and memory routing', async () => {
    const result = resolveServiceRouting({
      module: 'tts',
      config: configFor('tts', 'network', 'error'),
      localCapability: { available: false },
      remoteCandidates: [{
        ...remoteCandidate,
        selector: {
          peerId: 'home-peer',
          providerId: 'tts-provider',
          serviceInstanceId: 'tts-instance',
          module: 'TTS',
        },
      }],
    })
    const expectedIdentity = {
      peer_id: 'home-peer',
      provider_id: 'tts-provider',
      service_instance_id: 'tts-instance',
    }

    expect(result.selector).toEqual(expectedIdentity)
    expect(result.attempt.selector).toEqual(expectedIdentity)
    expect(result.selector).not.toHaveProperty('peerId')
    expect(result.selector).not.toHaveProperty('providerId')
    expect(result.selector).not.toHaveProperty('serviceInstanceId')

    const parsedSpeechRequest = TTSRequestInputTTSRequestSchema.parse({
      text: 'hello from a selected peer',
      mesh_selector: result.selector,
    })
    expect(parsedSpeechRequest.mesh_selector).toMatchObject(expectedIdentity)
    expect(parsedSpeechRequest.mesh_selector).not.toHaveProperty('peerId')
    expect(parsedSpeechRequest.mesh_selector).not.toHaveProperty('providerId')
    expect(parsedSpeechRequest.mesh_selector).not.toHaveProperty('serviceInstanceId')

    const requestResult = vi.fn().mockResolvedValue({
      data: { messages: [], total: 0, has_more: false },
    })
    const memory = new MemoryClient({ requestResult } as unknown as AuroraClient)
    await memory.listMessages({ mesh_selector: result.selector })
    expect(requestResult).toHaveBeenCalledWith(
      'DB.GetMessages',
      { mesh_selector: expectedIdentity },
      { path: '/api/DB/GetMessages' },
    )
  })

  it('rejects selectors whose identity conflicts with the candidate audit identity', () => {
    for (const selector of [
      { peerId: 'other-peer' },
      { peer_id: 'home-peer', provider_id: 'other-provider' },
      { peer_id: 'home-peer', service_instance_id: 'other-instance' },
      { peer_id: 'home-peer', module: 'DB' },
    ]) {
      expect(() => resolveServiceRouting({
        module: 'tts',
        config: configFor('tts', 'network', 'error'),
        localCapability: { available: false },
        remoteCandidates: [{ ...remoteCandidate, selector }],
      })).toThrow('does not match candidate identity')
    }
    expect(() => resolveServiceRouting({
      module: 'tts',
      config: configFor('tts', 'network', 'error'),
      localCapability: { available: false },
      remoteCandidates: [{
        ...remoteCandidate,
        selector: { peer_id: 'home-peer', peerId: 'other-peer' },
      }],
    })).toThrow('snake_case and camelCase values must match')
    expect(() => resolveServiceRouting({
      module: 'tts',
      config: configFor('tts', 'network', 'error'),
      localCapability: { available: false },
      remoteCandidates: [{ ...remoteCandidate, selector: null, module: 'memory' }],
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

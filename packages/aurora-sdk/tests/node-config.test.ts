import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TTSRequestInputTTSRequestSchema } from '../src/generated/backend-contracts.zod.js'
import { MemoryClient } from '../src/memory.js'
import {
  AURORA_NODE_CONFIG_MODULES,
  AURORA_NODE_RUNTIME_MODULES_BY_POLICY,
  AuroraNodeConfigValidationError,
  AuroraNodeConfigRevisionConflictError,
  AuroraServiceRoutingError,
  createAuroraNodeConfigTauriStore,
  createAuroraNodeConfigV2TauriStore,
  emptyAuroraNodeConfigDocument,
  emptyAuroraNodeConfigDocumentV2,
  isAuroraNodeConfigModule,
  isAuroraNodeServiceExposed,
  isRuntimeModuleForNodeConfigModule,
  migrateAuroraNodeConfigDocument,
  migrateAuroraNodeConfigDocumentV2,
  parseAuroraNodeConfigDocument,
  parseAuroraNodeConfigDocumentWire,
  resolveSpeechStageRouting,
  resolveServiceRouting,
  sanitizeAuroraNodeConfigDocument,
  serializeAuroraNodeConfigDocument,
  runtimeModulesForNodeConfigModule,
  TauriLocalTransport,
  updateAuroraNodeConfigDocumentV2,
  type AuroraNodeConfigDocumentV2,
  type AuroraNodeConfigDocumentV1,
  type AuroraNodeConfigModule,
  type AuroraNodeConfigTauriTransport,
  type AuroraNodeRouteCandidate,
  type AuroraNodeRoutingFallback,
  type AuroraNodeRoutingPreference,
  type AuroraNodeRoutingResolutionRecord,
} from '../src/index.js'
import type { AuroraClient } from '../src/client.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

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

const remoteCandidateId = '["home-peer","tts-provider","tts-instance","TTS"]'
const backupCandidateId = '["backup-peer","backup-provider","backup-instance","TTS"]'

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

describe('Aurora native speech node config v2', () => {
  it('inherits STT/TTS routing while keeping KWS/VAD local-only and sharing disabled', () => {
    const document = emptyAuroraNodeConfigDocumentV2(700)

    expect(document.version).toBe(2)
    expect(document.speech.stages.stt.routing).toEqual({ prefer: 'local', fallback: 'network' })
    expect(document.speech.stages.tts.routing).toEqual({ prefer: 'local', fallback: 'network' })
    expect(document.speech.stages.kws.routing).toEqual({ prefer: 'local_only', fallback: 'error' })
    expect(document.speech.stages.vad.routing).toEqual({ prefer: 'local_only', fallback: 'error' })
    expect(document.speech.sharing).toEqual({ stt: false, tts: false, kws: false, vad: false })
    expect(document.legacyV1Snapshot).toBeNull()
  })

  it('migrates legacy routing independently and retains a read-only rollback snapshot', () => {
    const migrated = migrateAuroraNodeConfigDocumentV2({
      version: 1,
      updatedAtMs: 710,
      services: {
        stt: { routing: { prefer: 'network', fallback: 'local' } },
        tts: { routing: { prefer: 'local_only', fallback: 'error' } },
      },
      expose: { featureOverrides: {} },
    }, 999)

    expect(migrated.speech.stages.stt.routing).toEqual({ prefer: 'network', fallback: 'local' })
    expect(migrated.speech.stages.tts.routing).toEqual({ prefer: 'local_only', fallback: 'error' })
    expect(migrated.speech.stages.kws.experimentalRemote).toBe(false)
    expect(migrated.legacyV1Snapshot?.services.tts?.routing).toEqual({ prefer: 'local_only', fallback: 'error' })
  })

  it('uses compare-and-swap revisions and reports next-generation effectiveness', () => {
    const current = emptyAuroraNodeConfigDocumentV2(720)
    const draft = { ...current, speech: { ...current.speech, sharing: { ...current.speech.sharing, tts: true } } }
    const updated = updateAuroraNodeConfigDocumentV2(current, draft, 1, 721)

    expect(updated.document.revision).toBe(2)
    expect(updated.acknowledgement).toEqual({
      savedRevision: 2,
      effectiveRevision: 1,
      pendingNextGeneration: true,
      pendingRevision: 2,
    })
    expect(() => updateAuroraNodeConfigDocumentV2(current, draft, 0)).toThrow(AuroraNodeConfigRevisionConflictError)
  })

  it('routes explicitly enabled remote KWS and VAD stages through their runtime modules', () => {
    for (const [stage, runtimeModule] of [['kws', 'WakeWord'], ['vad', 'VAD']] as const) {
      const config = emptyAuroraNodeConfigDocumentV2(730)
      const records: AuroraNodeRoutingResolutionRecord[] = []
      config.speech.stages[stage] = {
        ...config.speech.stages[stage],
        routing: { prefer: 'network_only', fallback: 'error' },
        experimentalRemote: true,
      }

      const result = resolveSpeechStageRouting({
        stage,
        config,
        localCapability: { available: true },
        remoteCandidates: [{ peerId: `${stage}-peer`, module: runtimeModule }],
        emit: (record) => records.push(record),
      })

      expect(result.source).toBe('remote')
      expect(result.attempt.candidate?.module).toBe(runtimeModule)
      expect(result.record.stage).toBe(stage)
      expect(records).toEqual([result.record])
    }
  })

  it('uses the speech stage in local attempt IDs and routing errors', () => {
    const config = emptyAuroraNodeConfigDocumentV2(731)

    const local = resolveSpeechStageRouting({
      stage: 'kws',
      config,
      localCapability: { available: true },
      remoteCandidates: [],
    })
    expect(local.attempt.id).toBe('local:kws')
    expect(local.record).toMatchObject({ module: 'tts', stage: 'kws' })

    config.speech.stages.vad = {
      ...config.speech.stages.vad,
      routing: { prefer: 'network_only', fallback: 'error' },
      experimentalRemote: true,
    }
    expect(() => resolveSpeechStageRouting({
      stage: 'vad',
      config,
      localCapability: { available: false },
      remoteCandidates: [],
    })).toThrow('No vad route satisfies network_only/error')
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
    expect(result.record.remoteCandidateIds).toEqual([remoteCandidateId, '["backup-peer",null,null,"TTS"]'])
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

  it('rejects whitespace-only candidate identities and generated selector fields', () => {
    const identityCases = [
      ['peerId', 'peer_id'],
      ['providerId', 'provider_id'],
      ['serviceInstanceId', 'service_instance_id'],
    ] as const
    const validFallback: AuroraNodeRouteCandidate = {
      peerId: 'fallback-peer',
      providerId: 'fallback-provider',
      serviceInstanceId: 'fallback-instance',
      module: 'TTS',
    }

    for (const [candidateField, selectorField] of identityCases) {
      const malformedCandidate: AuroraNodeRouteCandidate = {
        ...remoteCandidate,
        [candidateField]: ' ',
        selector: {
          ...remoteCandidate.selector,
          [selectorField]: ' ',
        },
      }
      const result = resolveServiceRouting({
        module: 'tts',
        config: configFor('tts', 'network', 'error'),
        localCapability: { available: false },
        remoteCandidates: [malformedCandidate, validFallback],
      })

      expect(result.attempt.candidate?.peerId).toBe('fallback-peer')
      expect(result.record.remoteCandidateIds).toEqual(['["fallback-peer","fallback-provider","fallback-instance","TTS"]'])
      const parsed = TTSRequestInputTTSRequestSchema.safeParse({
        text: 'dispatch boundary',
        mesh_selector: {
          ...result.selector,
          [selectorField]: ' ',
        },
      })
      expect(parsed.success).toBe(false)
    }

    const optionalSelectorFields = [
      'resource_namespace',
      'tool_id',
      'data_scope',
      'hardware_target',
    ] as const
    for (const selectorField of optionalSelectorFields) {
      const malformedSelectorCandidate: AuroraNodeRouteCandidate = {
        ...remoteCandidate,
        selector: {
          ...remoteCandidate.selector,
          [selectorField]: ' ',
        },
      }

      expect(() => resolveServiceRouting({
        module: 'tts',
        config: configFor('tts', 'network', 'error'),
        localCapability: { available: false },
        remoteCandidates: [malformedSelectorCandidate],
      })).toThrow(AuroraNodeConfigValidationError)

      const parsed = TTSRequestInputTTSRequestSchema.safeParse({
        text: 'dispatch boundary',
        mesh_selector: {
          peer_id: 'home-peer',
          [selectorField]: ' ',
        },
      })
      expect(parsed.success).toBe(false)
    }
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

  it('uses collision-free structured route audit IDs', () => {
    const result = resolveServiceRouting({
      module: 'tts',
      config: configFor('tts', 'network', 'network'),
      localCapability: { available: false },
      remoteCandidates: [
        { peerId: 'peer|provider', providerId: 'route', serviceInstanceId: 'instance', module: 'TTS' },
        { peerId: 'peer', providerId: 'provider|route', serviceInstanceId: 'instance', module: 'TTS' },
      ],
    })

    expect(new Set(result.record.remoteCandidateIds).size).toBe(2)
    expect(result.record.selectedCandidateId).toBe(result.attempt.id)
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

describe('coordinator-backed node-config compatibility stores', () => {
  const documentToken = 'c'.repeat(64)

  beforeEach(() => {
    vi.stubGlobal('window', { __AURORA_NODE_CONFIG_DOCUMENT_TOKEN__: documentToken })
  })

  class FakeTauriTransport implements AuroraNodeConfigTauriTransport {
    document = emptyAuroraNodeConfigDocumentV2(600)
    readonly calls: Array<{ kind: 'read' } | { kind: 'compare-and-swap'; revision: number }> = []
    readonly casDraftHandles: string[] = []
    malformedRead: string | null = null
    nextHandle = 0
    activeHandle: string | null = null

    async nodeConfigPolicyRead(token: string): Promise<unknown> {
      expect(token).toBe(documentToken)
      this.calls.push({ kind: 'read' })
      this.activeHandle = (++this.nextHandle).toString(16).padStart(64, '0')
      return {
        documentJson: this.malformedRead ?? JSON.stringify(this.document),
        draftHandle: this.activeHandle
      }
    }

    async nodeConfigPolicyCompareAndSwap(request: {
      documentToken: string
      draftHandle: string
      expectedRevision: number
      draftJson: string
    }): Promise<unknown> {
      expect(request.documentToken).toBe(documentToken)
      this.calls.push({ kind: 'compare-and-swap', revision: request.expectedRevision })
      this.casDraftHandles.push(request.draftHandle)
      if (request.draftHandle !== this.activeHandle) throw new Error('profile receipt changed')
      if (request.expectedRevision !== this.document.revision) throw new Error('revision conflict')
      this.document = JSON.parse(request.draftJson) as AuroraNodeConfigDocumentV2
      return {
        documentJson: JSON.stringify(this.document),
        savedRevision: this.document.revision
      }
    }
  }

  it('projects V1 service settings through CAS and clear preserves speech policy', async () => {
    const storage = new FakeTauriTransport()
    storage.document.speech.stages.stt.target = { peerId: 'speech-peer', modelId: 'stt-model' }
    const speech = structuredClone(storage.document.speech)
    const store = createAuroraNodeConfigTauriStore(storage)
    const loaded = await store.load()
    expect(loaded?.version).toBe(1)

    const updated = { ...loaded!, updatedAtMs: 601 }
    updated.services.tts = { routing: { prefer: 'network', fallback: 'local' } }
    await store.save(updated)
    expect(storage.document.services.tts).toEqual(updated.services.tts)
    expect(storage.document.speech).toEqual(speech)

    await store.clear?.()
    expect(storage.document.services).toEqual(emptyAuroraNodeConfigDocument(602).services)
    expect(storage.document.expose).toEqual(emptyAuroraNodeConfigDocument(602).expose)
    expect(storage.document.speech).toEqual(speech)
    expect(storage.calls.map(({ kind }) => kind)).toEqual([
      'read', 'compare-and-swap', 'read', 'compare-and-swap'
    ])
  })

  it('keeps a V1 compatibility draft bound to the profile that loaded it', async () => {
    const storage = new FakeTauriTransport()
    storage.document.speech.stages.tts.target = { peerId: 'profile-a', modelId: 'tts-a' }
    const store = createAuroraNodeConfigTauriStore(storage)
    const profileA = await store.load()
    const draftA = { ...profileA!, services: { ...profileA!.services } }
    draftA.services.tts = { routing: { prefer: 'network', fallback: 'local' } }

    storage.document = emptyAuroraNodeConfigDocumentV2(600)
    storage.document.speech.stages.tts.target = { peerId: 'profile-b', modelId: 'tts-b' }
    await store.load()

    await expect(store.save(draftA)).rejects.toMatchObject({ code: 'save_unavailable' })
    expect(storage.calls.map(({ kind }) => kind)).toEqual(['read', 'read', 'compare-and-swap'])
    expect(storage.casDraftHandles).toEqual(['0'.repeat(63) + '1'])
    expect(storage.document.services.tts).toEqual(emptyAuroraNodeConfigDocumentV2(600).services.tts)
    expect(storage.document.speech.stages.tts.target).toEqual({ peerId: 'profile-b', modelId: 'tts-b' })
  })

  it('uses revision-bound policy receipts for V2 reads, saves, and clear', async () => {
    const storage = new FakeTauriTransport()
    const store = createAuroraNodeConfigV2TauriStore(storage)
    const current = await store.load()
    const updated = {
      ...current!,
      speech: {
        ...current!.speech,
        stages: {
          ...current!.speech.stages,
          tts: { ...current!.speech.stages.tts, routing: { prefer: 'network_only' as const, fallback: 'error' as const } }
        }
      }
    }
    const saved = await store.saveCas(updated, current!.revision)
    expect(saved.document.speech.stages.tts.routing).toEqual({ prefer: 'network_only', fallback: 'error' })
    expect(saved.acknowledgement).toMatchObject({
      savedRevision: current!.revision + 1,
      effectiveRevision: current!.revision,
      pendingNextGeneration: true,
      pendingRevision: current!.revision + 1
    })
    await expect(store.save(saved.document)).rejects.toThrow(/requires saveCas/u)
    await store.clear?.()
    expect(storage.document.speech.stages.tts.routing).toEqual({ prefer: 'local', fallback: 'network' })
    expect(storage.calls.some(({ kind }) => kind === 'compare-and-swap')).toBe(true)
  })

  it('keeps a V2 compatibility draft bound to the profile that loaded it', async () => {
    const storage = new FakeTauriTransport()
    storage.document.speech.stages.tts.target = { peerId: 'profile-a', modelId: 'tts-a' }
    const store = createAuroraNodeConfigV2TauriStore(storage)
    const profileA = await store.load()
    const draftA = {
      ...profileA!,
      speech: {
        ...profileA!.speech,
        stages: {
          ...profileA!.speech.stages,
          tts: { ...profileA!.speech.stages.tts, routing: { prefer: 'network_only' as const, fallback: 'error' as const } }
        }
      }
    }

    storage.document = emptyAuroraNodeConfigDocumentV2(600)
    storage.document.speech.stages.tts.target = { peerId: 'profile-b', modelId: 'tts-b' }
    await store.load()

    await expect(store.saveCas(draftA, profileA!.revision)).rejects.toMatchObject({ code: 'save_unavailable' })
    expect(storage.calls.map(({ kind }) => kind)).toEqual(['read', 'read', 'compare-and-swap'])
    expect(storage.casDraftHandles).toEqual(['0'.repeat(63) + '1'])
    expect(storage.document.speech.stages.tts.target).toEqual({ peerId: 'profile-b', modelId: 'tts-b' })
  })

  it('rejects an invalid canonical policy response without a legacy read or delete', async () => {
    const storage = new FakeTauriTransport()
    storage.malformedRead = '{"version":2,"revision":0,"secret":"unchanged"}'

    await expect(createAuroraNodeConfigV2TauriStore(storage).load())
      .rejects.toMatchObject({ code: 'invalid_document' })
    expect(storage.calls).toEqual([{ kind: 'read' }])
  })

  it('uses only the native policy command boundary through TauriLocalTransport', async () => {
    vi.stubGlobal('window', { __AURORA_NODE_CONFIG_DOCUMENT_TOKEN__: 'd'.repeat(64) })
    let document = emptyAuroraNodeConfigDocumentV2(610)
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    let handle = 0
    const transport = new TauriLocalTransport({
      listen: async () => () => {},
      invoke: async (command, args) => {
        calls.push(args === undefined ? { command } : { command, args })
        if (command === 'aurora_node_config_policy_read') {
          return {
            documentJson: JSON.stringify(document),
            draftHandle: (++handle).toString(16).padStart(64, '0')
          }
        }
        if (command === 'aurora_node_config_policy_compare_and_swap') {
          document = JSON.parse(String(args?.draftJson)) as AuroraNodeConfigDocumentV2
          return { documentJson: JSON.stringify(document), savedRevision: document.revision }
        }
        throw new Error(`unexpected command ${command}`)
      },
    })
    const store = createAuroraNodeConfigTauriStore(transport)
    const legacy = await store.load()
    if (!legacy) throw new Error('Expected loaded device settings')
    legacy.updatedAtMs = 611
    legacy.services.tts = { routing: { prefer: 'network_only', fallback: 'error' } }
    await store.save(legacy)
    expect((await store.load())?.services.tts).toEqual(legacy.services.tts)
    await store.clear?.()
    expect(calls.map(({ command }) => command)).toEqual([
      'aurora_node_config_policy_read',
      'aurora_node_config_policy_compare_and_swap',
      'aurora_node_config_policy_read',
      'aurora_node_config_policy_read',
      'aurora_node_config_policy_compare_and_swap'
    ])
    expect(calls.filter(({ command }) => command === 'aurora_node_config_policy_read')
      .every(({ args }) => args?.documentToken === 'd'.repeat(64))).toBe(true)
    expect(calls.filter(({ command }) => command === 'aurora_node_config_policy_compare_and_swap')
      .every(({ args }) => args?.documentToken === 'd'.repeat(64))).toBe(true)
  })
})

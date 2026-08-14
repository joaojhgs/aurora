import { describe, expect, it, vi } from 'vitest'

import {
  PeerHostContractRegistry,
  SessionPeerHostAuthorizationStore,
  WebRtcPeerHost,
  createToolingPeerHostRegistry,
  generatedPeerHostEventDescriptor,
  generatedPeerHostMethodDescriptor,
  registerGeneratedPeerHostEvent,
  registerGeneratedPeerHostMethod,
  type CallFrame,
  type LocalPeerGrantV1,
  type ToolingPeerHostHandlers
} from '../src/webrtc/index.js'

const TTS_MANAGEMENT_METHOD_IDS = [
  'TTS.ListLanguagePacks',
  'TTS.ListVoiceProfiles',
  'TTS.GetVoiceProfile',
  'TTS.UpdateVoiceProfile',
  'TTS.InstallVoiceProfile',
  'TTS.RemoveVoiceProfile',
  'TTS.SetDefaultVoice',
  'TTS.VoiceImportStart',
  'TTS.VoiceImportChunk',
  'TTS.VoiceImportEnd',
  'TTS.VoiceImportAbort',
  'TTS.CreateVoiceProfile',
  'TTS.DeleteVoiceProfile'
] as const

function peerGrant(allowedMethodIds: readonly string[]): LocalPeerGrantV1 {
  return {
    version: 1,
    grantId: 'generated-contract-grant',
    tokenId: 'generated-contract-token',
    claimantPeerId: 'peer-a',
    allowedMethodIds,
    allowedToolContractIds: [],
    capabilityPackIds: [],
    resourceScopes: [],
    createdAtMs: 1,
    grantRevision: 3
  }
}

function compatibleAck(manifest: Record<string, unknown>): Record<string, unknown> {
  const services = (manifest.shared_services as Array<Record<string, unknown>>)
    .map((service) => String(service.module))
    .sort()
  const evidence = manifest.recipient_projection_evidence as Record<string, unknown>
  return {
    type: 'manifest_ack',
    compatible_services: services,
    incompatible_services: [],
    unused_services: [],
    active_protocol: 'projection-v1',
    active_version: 'v1',
    active_tier: 'projection',
    protocol_revision: 'v1',
    registry_revision: evidence.registry_revision,
    export_policy_revision: evidence.policy_revision,
    auth_grant_revision: evidence.auth_grant_revision,
    projection_digest: evidence.projection_digest,
    services: services.map((serviceId) => ({
      service_id: serviceId,
      service_label: '',
      status: 'compatible',
      reason_codes: [],
      reason: ''
    }))
  }
}

describe('generated peer-host registration', () => {
  it('derives authorized bounded event metadata and validator types', () => {
    const registry = new PeerHostContractRegistry()
    const handler = async () => undefined
    const descriptor = generatedPeerHostEventDescriptor('TTS.AudioChunk', handler)

    expect(descriptor).toMatchObject({
      topic: 'TTS.AudioChunk',
      module: 'TTS',
      name: 'AudioChunk',
      outputSchemaId: 'TTS.AudioChunk.event.TTSAudioChunkEvent',
      requiredPermissions: ['TTS.use'],
      maxTtlSeconds: 120,
      maxEventBytes: 64 * 1024,
      orderedEventGroup: 'tts_text_stream'
    })
    expect(() => descriptor.outputSchema.parse({
      stream_id: 'stream-1',
      sequence: 0,
      audio_data: '',
      format: 'pcm_s16le',
      sample_rate: 24_000,
      channels: 1,
      duration_ms: 10,
      source_sequence: 0,
      is_final: false,
      correlation_id: 'corr-1'
    })).toThrow()
    registerGeneratedPeerHostEvent(registry, 'TTS.AudioChunk', handler)
    expect(registry.listEvents().map((event) => event.topic)).toEqual(['TTS.AudioChunk'])
  })

  it.each(TTS_MANAGEMENT_METHOD_IDS)(
    'derives manage projection and permissions for %s',
    (methodId) => {
      const descriptor = generatedPeerHostMethodDescriptor(
        methodId,
        async () => { throw new Error('not called') }
      )

      expect(descriptor).toMatchObject({
        methodId,
        module: 'TTS',
        name: methodId.slice('TTS.'.length),
        busTopic: methodId,
        methodType: 'unary',
        projectionMethodType: 'manage',
        requiredPermissions: ['TTS.manage'],
        callableFeatureIds: ['speech_voice_management'],
        speechConstraints: null
      })
      expect(descriptor.inputSchemaId.startsWith(`${methodId}.input.`)).toBe(true)
      expect(descriptor.outputSchemaId.startsWith(`${methodId}.output.`)).toBe(true)
    }
  )

  it.each([
    'WakeWord.ProcessAudio',
    'Transcription.ProcessAudio'
  ])('fails closed when a caller bypasses the continuous-audio type exclusion for %s', (methodId) => {
    const unsafeDescriptor = generatedPeerHostMethodDescriptor as unknown as (
      methodId: string,
      handler: () => Promise<unknown>
    ) => unknown

    expect(() => unsafeDescriptor(
      methodId,
      async () => ({})
    )).toThrow('continuous audio capture cannot be hosted across devices')
  })

  it('keeps Tooling registry handlers bound to generated method types', () => {
    const handlers: ToolingPeerHostHandlers = {
      getTools: async () => { throw new Error('not called') },
      getExportCatalog: async () => { throw new Error('not called') },
      prepareExecution: async () => { throw new Error('not called') },
      executeTool: async () => { throw new Error('not called') }
    }

    expect(createToolingPeerHostRegistry(handlers).list().map((method) => method.methodId)).toEqual([
      'Tooling.ExecuteTool',
      'Tooling.GetExportCatalog',
      'Tooling.GetTools',
      'Tooling.PrepareExecution'
    ])
  })

  it('groups mixed generated services and requires every advertised service ACK', async () => {
    const registry = new PeerHostContractRegistry()
    registerGeneratedPeerHostMethod(
      registry,
      'Tooling.GetTools',
      async () => { throw new Error('not called') }
    )
    const ttsHandler = vi.fn(async () => ({
      voice_id: 'standard:starter:voice',
      status: 'rejected' as const
    }))
    registerGeneratedPeerHostMethod(
      registry,
      'TTS.UpdateVoiceProfile',
      ttsHandler
    )
    for (const methodId of TTS_MANAGEMENT_METHOD_IDS) {
      if (methodId === 'TTS.UpdateVoiceProfile') continue
      registerGeneratedPeerHostMethod(
        registry,
        methodId,
        async () => { throw new Error('not called') }
      )
    }
    const peerHost = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry,
      authorizationStore: new SessionPeerHostAuthorizationStore([
        peerGrant(['Tooling.GetTools', ...TTS_MANAGEMENT_METHOD_IDS])
      ]),
      clock: () => 1_000,
      randomId: () => 'generated-contract-epoch'
    })
    const sent: unknown[] = []
    peerHost.attach({ sendFrame: async (frame) => { sent.push(frame) } })

    const manifest = await peerHost.startEpoch('peer-a')
    const services = manifest.shared_services as Array<Record<string, unknown>>
    expect(services.map((service) => service.module)).toEqual(['TTS', 'Tooling'])
    const toolingService = services.find((service) => service.module === 'Tooling')
    expect(toolingService).toMatchObject({
      capabilities: ['tool_discovery', 'tool_execution'],
      available_feature_ids: ['catalog_discovery'],
      callable_features: [{
        feature_id: 'catalog_discovery',
        module: 'Tooling',
        label: 'Catalog Discovery',
        summary: 'Read local and aggregate Tooling catalogs and status.',
        method_ids: [
          'Tooling.GetExportCatalog',
          'Tooling.GetMCPStatus',
          'Tooling.GetStats',
          'Tooling.GetToolByName',
          'Tooling.GetToolCatalog',
          'Tooling.GetTools'
        ]
      }]
    })
    expect((toolingService?.methods as Array<Record<string, unknown>>)[0]).toMatchObject({
      bus_topic: 'Tooling.GetTools',
      callable_feature_ids: ['catalog_discovery'],
      callable_features: [{
        feature_id: 'catalog_discovery',
        module: 'Tooling',
        method_ids: [
          'Tooling.GetExportCatalog',
          'Tooling.GetMCPStatus',
          'Tooling.GetStats',
          'Tooling.GetToolByName',
          'Tooling.GetToolCatalog',
          'Tooling.GetTools'
        ]
      }]
    })
    const ttsService = services.find((service) => service.module === 'TTS')
    expect(ttsService).toMatchObject({
      capabilities: [],
      available_feature_ids: ['speech_voice_management'],
      callable_features: [{
        feature_id: 'speech_voice_management',
        module: 'TTS',
        label: 'Voice Profile Management',
        summary: 'Administer local TTS voice profiles and bounded voice imports.',
        method_ids: [...TTS_MANAGEMENT_METHOD_IDS].sort()
      }]
    })
    const projectedTtsMethods = new Map(
      (ttsService?.methods as Array<Record<string, unknown>>)
        .map((method) => [String(method.bus_topic), method])
    )
    expect(projectedTtsMethods.size).toBe(TTS_MANAGEMENT_METHOD_IDS.length)
    for (const methodId of TTS_MANAGEMENT_METHOD_IDS) {
      expect(projectedTtsMethods.get(methodId)).toEqual(expect.objectContaining({
        bus_topic: methodId,
        method_type: 'manage',
        required_perms: ['TTS.manage'],
        callable_feature_ids: ['speech_voice_management'],
        callable_features: [{
          feature_id: 'speech_voice_management',
          module: 'TTS',
          label: 'Voice Profile Management',
          summary: 'Administer local TTS voice profiles and bounded voice imports.',
          method_ids: [...TTS_MANAGEMENT_METHOD_IDS].sort()
        }],
        speech_constraints: null
      }))
    }
    const evidence = manifest.recipient_projection_evidence as Record<string, unknown>
    const serviceIds = services.map((service) => String(service.module))
    const incompleteAck = {
      type: 'manifest_ack',
      compatible_services: ['Tooling'],
      incompatible_services: ['TTS'],
      unused_services: [],
      active_protocol: 'projection-v1',
      active_version: 'v1',
      active_tier: 'projection',
      protocol_revision: 'v1',
      registry_revision: evidence.registry_revision,
      export_policy_revision: evidence.policy_revision,
      auth_grant_revision: evidence.auth_grant_revision,
      projection_digest: evidence.projection_digest,
      services: [
        { service_id: 'Tooling', service_label: '', status: 'compatible', reason_codes: [], reason: '' },
        { service_id: 'TTS', service_label: '', status: 'incompatible', reason_codes: ['unsupported'], reason: '' }
      ]
    }
    expect(peerHost.markManifestAcknowledged(incompleteAck)).toBe(false)
    await peerHost.handleCall({
      type: 'call',
      id: 'tts-incompatible',
      method: 'TTS.UpdateVoiceProfile',
      params: {
        operation_id: 'update-incompatible',
        voice_id: 'standard:starter:voice',
        enabled: true
      },
      identity: { caller_peer_id: 'peer-a', effective_perms: ['TTS.manage'] }
    }, 'peer-a')
    expect(ttsHandler).not.toHaveBeenCalled()
    expect(sent.at(-1)).toMatchObject({
      type: 'error',
      id: 'tts-incompatible',
      error: { code: 425, reason_code: 'provider_not_ready' }
    })
    expect(sent.filter((frame) => (frame as { type?: string }).type === 'provider_lease')).toHaveLength(0)

    const completeAck = {
      ...incompleteAck,
      compatible_services: serviceIds,
      incompatible_services: [],
      services: serviceIds.map((serviceId) => ({
        service_id: serviceId,
        service_label: '',
        status: 'compatible',
        reason_codes: [],
        reason: ''
      }))
    }
    expect(peerHost.markManifestAcknowledged(completeAck)).toBe(true)
    await peerHost.handleCall({
      type: 'call',
      id: 'tts-compatible',
      method: 'TTS.UpdateVoiceProfile',
      params: {
        operation_id: 'update-compatible',
        voice_id: 'standard:starter:voice',
        enabled: true
      },
      identity: { caller_peer_id: 'peer-a', effective_perms: ['TTS.manage'] }
    }, 'peer-a')
    expect(ttsHandler).toHaveBeenCalledTimes(1)
    expect(sent.at(-1)).toMatchObject({
      type: 'result',
      id: 'tts-compatible',
      result: {
        voice_id: 'standard:starter:voice',
        status: 'rejected',
        idempotent: false
      }
    })
  })

  it('projects only granted TTS methods and rejects forged manage authority pre-dispatch', async () => {
    const registry = new PeerHostContractRegistry()
    const synthesisHandler = vi.fn(async () => ({
      audio_data: '',
      channels: 1,
      duration_ms: 0,
      format: 'wav',
      sample_rate: 24_000,
      text: 'hello'
    }))
    const manageHandler = vi.fn(async () => ({
      voice_id: 'standard:starter:voice',
      status: 'rejected' as const
    }))
    registerGeneratedPeerHostMethod(registry, 'TTS.Synthesize', synthesisHandler)
    registerGeneratedPeerHostMethod(registry, 'TTS.UpdateVoiceProfile', manageHandler)
    const peerHost = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry,
      authorizationStore: new SessionPeerHostAuthorizationStore([
        peerGrant(['TTS.Synthesize'])
      ]),
      clock: () => 1_000,
      randomId: () => 'tts-use-only-epoch'
    })
    const sent: unknown[] = []
    peerHost.attach({ sendFrame: async (frame) => { sent.push(frame) } })

    const manifest = await peerHost.startEpoch('peer-a')
    const services = manifest.shared_services as Array<Record<string, unknown>>
    expect(services).toHaveLength(1)
    expect(services[0]?.module).toBe('TTS')
    expect(services[0]?.methods).toEqual([
      expect.objectContaining({
        bus_topic: 'TTS.Synthesize',
        method_type: 'use',
        required_perms: ['TTS.Synthesize']
      })
    ])
    expect(peerHost.markManifestAcknowledged(compatibleAck(manifest))).toBe(true)

    await peerHost.handleCall({
      type: 'call',
      id: 'forged-manage',
      method: 'TTS.UpdateVoiceProfile',
      params: {
        operation_id: 'forged-manage',
        voice_id: 'standard:starter:voice',
        enabled: true
      },
      identity: { caller_peer_id: 'peer-a', effective_perms: ['TTS.manage'] }
    }, 'peer-a')

    expect(manageHandler).not.toHaveBeenCalled()
    expect(synthesisHandler).not.toHaveBeenCalled()
    expect(sent.at(-1)).toMatchObject({
      type: 'error',
      id: 'forged-manage',
      error: { code: 403 }
    })
  })

  it('rejects duplicate active generated TTS call IDs and allows reuse after cleanup', async () => {
    let notifyStarted!: () => void
    let releaseHandler!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    const blocked = new Promise<void>((resolve) => { releaseHandler = resolve })
    const handler = vi.fn(async () => {
      notifyStarted()
      await blocked
      return {
        voice_id: 'standard:starter:voice',
        status: 'rejected' as const
      }
    })
    const registry = new PeerHostContractRegistry()
    registerGeneratedPeerHostMethod(registry, 'TTS.UpdateVoiceProfile', handler)
    const peerHost = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry,
      authorizationStore: new SessionPeerHostAuthorizationStore([
        peerGrant(['TTS.UpdateVoiceProfile'])
      ]),
      clock: () => 1_000,
      randomId: () => 'tts-idempotency-epoch'
    })
    const sent: unknown[] = []
    peerHost.attach({ sendFrame: async (frame) => { sent.push(frame) } })
    const manifest = await peerHost.startEpoch('peer-a')
    expect(peerHost.markManifestAcknowledged(compatibleAck(manifest))).toBe(true)
    const frame: CallFrame = {
      type: 'call',
      id: 'tts-active-call',
      method: 'TTS.UpdateVoiceProfile',
      params: {
        operation_id: 'active-call',
        voice_id: 'standard:starter:voice',
        enabled: true
      },
      identity: { caller_peer_id: 'peer-a', effective_perms: ['TTS.manage'] }
    }

    const firstCall = peerHost.handleCall(frame, 'peer-a')
    await started
    await peerHost.handleCall(frame, 'peer-a')

    expect(handler).toHaveBeenCalledTimes(1)
    expect(sent.at(-1)).toMatchObject({
      type: 'error',
      id: 'tts-active-call',
      error: { code: 409, reason_code: 'request_in_progress' }
    })

    releaseHandler()
    await firstCall
    expect(sent.at(-1)).toMatchObject({ type: 'result', id: 'tts-active-call' })

    await peerHost.handleCall(frame, 'peer-a')
    expect(handler).toHaveBeenCalledTimes(2)
    expect(sent.at(-1)).toMatchObject({ type: 'result', id: 'tts-active-call' })
  })
})

import { describe, expect, it } from 'vitest'

import {
  PeerHostContractRegistry,
  SessionPeerHostAuthorizationStore,
  WebRtcPeerHost,
  generatedPeerHostMethodDescriptor,
  registerGeneratedPeerHostMethod,
  type LocalPeerGrantV1
} from '../src/webrtc/index.js'

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

describe('generated peer-host registration', () => {
  it('derives schemas, manage projection, and permissions from generated descriptors', () => {
    const descriptor = generatedPeerHostMethodDescriptor(
      'TTS.UpdateVoiceProfile',
      async () => { throw new Error('not called') }
    )

    expect(descriptor).toMatchObject({
      methodId: 'TTS.UpdateVoiceProfile',
      module: 'TTS',
      name: 'UpdateVoiceProfile',
      busTopic: 'TTS.UpdateVoiceProfile',
      methodType: 'unary',
      projectionMethodType: 'manage',
      inputSchemaId: 'TTS.UpdateVoiceProfile.input.TTSUpdateVoiceProfileRequest',
      outputSchemaId: 'TTS.UpdateVoiceProfile.output.TTSUpdateVoiceProfileResponse',
      requiredPermissions: ['TTS.manage'],
      callableFeatureIds: ['speech_voice_management'],
      speechConstraints: null
    })
  })

  it('fails closed when a caller bypasses the wake-audio type exclusion', () => {
    const unsafeDescriptor = generatedPeerHostMethodDescriptor as unknown as (
      methodId: string,
      handler: () => Promise<unknown>
    ) => unknown

    expect(() => unsafeDescriptor(
      'WakeWord.ProcessAudio',
      async () => ({})
    )).toThrow('continuous wake audio cannot be hosted across devices')
  })

  it('groups mixed generated services and requires every advertised service ACK', async () => {
    const registry = new PeerHostContractRegistry()
    registerGeneratedPeerHostMethod(
      registry,
      'Tooling.GetTools',
      async () => { throw new Error('not called') }
    )
    registerGeneratedPeerHostMethod(
      registry,
      'TTS.UpdateVoiceProfile',
      async () => { throw new Error('not called') }
    )
    const peerHost = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry,
      authorizationStore: new SessionPeerHostAuthorizationStore([
        peerGrant(['Tooling.GetTools', 'TTS.UpdateVoiceProfile'])
      ]),
      clock: () => 1_000,
      randomId: () => 'generated-contract-epoch'
    })
    peerHost.attach({ sendFrame: async () => undefined })

    const manifest = await peerHost.startEpoch('peer-a')
    const services = manifest.shared_services as Array<Record<string, unknown>>
    expect(services.map((service) => service.module)).toEqual(['TTS', 'Tooling'])
    expect(services.find((service) => service.module === 'Tooling')).toMatchObject({
      capabilities: ['tool_discovery', 'tool_execution'],
      available_feature_ids: ['catalog_discovery']
    })
    const ttsService = services.find((service) => service.module === 'TTS')
    expect(ttsService).toMatchObject({
      capabilities: [],
      available_feature_ids: ['speech_voice_management']
    })
    expect(ttsService?.methods).toEqual([
      expect.objectContaining({
        bus_topic: 'TTS.UpdateVoiceProfile',
        method_type: 'manage',
        required_perms: ['TTS.manage'],
        callable_feature_ids: ['speech_voice_management'],
        speech_constraints: null
      })
    ])

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
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createTestAuthority } from './helpers/wasm-authority.js'
import type { PeerGrantManagerPort } from '../src/peer-host/authority-types.js'

import {
  type EncryptedDataEnvelopeV1,
  type EnvelopeCryptoPort,
  type LocalDataKeyPurpose,
  type LocalToolStateRecord,
  MemoryLocalDataBackend,
  type LocalDataSession
} from '../src/local-data/index.js'
import {
  EncryptedPeerGrantRepository,
  type PeerRelationshipSelector
} from '../src/peer-host/index.js'
import {
  DurableFeatureSharingController,
  DurableFeatureSharingError,
  TrackingPeerPairingIssuer,
  type LocalFeatureSharingSnapshot
} from '../src/local-tools/durable-feature-sharing.js'
import {
  LocalToolRegistry,
  MESH_NODE_TOOLING_METHOD_IDS,
  type LocalToolDescriptorV1
} from '../src/local-tools/index.js'

const profileId = 'profile-1'
const localNodeId = 'provider'
const roomName = 'room-a'

const selector: PeerRelationshipSelector = {
  tokenId: 'token-1',
  claimantPeerId: 'peer-a',
  verifierPeerId: localNodeId,
  roomName
}

const secondSelector: PeerRelationshipSelector = {
  ...selector,
  tokenId: 'token-2'
}

const descriptor: LocalToolDescriptorV1 = {
  version: 1,
  toolContractId: 'aurora.local.native.share_text.v1',
  localName: 'native.share_text',
  displayName: 'Share text',
  description: 'Share selected text.',
  argsSchema: {
    type: 'object',
    properties: { text: { type: 'string', minLength: 1 } },
    required: ['text'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: { shared: { type: 'boolean' } },
    required: ['shared'],
    additionalProperties: false
  },
  argumentVisibility: { text: 'public' },
  requiredPermissions: ['Native.ShareText'],
  resourceScopes: ['native.share'],
  safetyClass: 'sensitive',
  privacyClass: 'personal',
  mutating: true,
  dataEgress: true,
  nativeRequirements: { capabilityIds: ['aurora.browser.share'], osPermissions: ['share'] },
  confirmationPolicy: 'sensitive',
  handlerId: 'native.share_text'
}

const statusDescriptor: LocalToolDescriptorV1 = {
  ...descriptor,
  toolContractId: 'aurora.local.native.get_device_status.v1',
  localName: 'native.get_device_status',
  displayName: 'Get device status',
  description: 'Return local device availability.',
  argsSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', properties: { online: { type: 'boolean' } }, required: ['online'], additionalProperties: false },
  argumentVisibility: {},
  requiredPermissions: ['Native.GetDeviceStatus'],
  resourceScopes: [],
  safetyClass: 'standard',
  mutating: false,
  dataEgress: false,
  nativeRequirements: { capabilityIds: ['aurora.device.status'], osPermissions: [] },
  confirmationPolicy: 'never',
  handlerId: 'native.get_device_status'
}

describe('durable local feature sharing controller', () => {
  it('denies synchronously before load and defaults registered features off', async () => {
    const fixture = await controllerFixture()
    const [tool] = fixture.registry.publicTools()

    expect(fixture.controller.isShared(tool!, projectionContext())).toBe(false)
    const snapshot = await fixture.controller.load()
    expect(feature(snapshot, descriptor.toolContractId)).toMatchObject({
      id: descriptor.toolContractId,
      enabled: false,
      label: 'Share text',
      serviceId: 'tooling',
      servicePermissionId: 'Tooling.use',
      serviceLabel: 'Tools',
      serviceDescription: 'Use tools this device makes available.',
      requiresAuroraOpen: true,
      requiresLocalConfirmation: true,
      permissionNeeded: true,
      nativeCapabilityIds: ['aurora.browser.share'],
      nativePermissionIds: ['share']
    })
    expect(snapshot.approvedDevices).toEqual([])
    expect(fixture.controller.isShared(tool!, projectionContext())).toBe(false)
  })

  it('persists local feature state and reloads it durably', async () => {
    const fixture = await controllerFixture()
    await fixture.controller.load()

    const seen: LocalFeatureSharingSnapshot[] = []
    const unsubscribe = fixture.controller.subscribe((snapshot) => seen.push(snapshot))
    await fixture.controller.setFeatureEnabled(descriptor.toolContractId, true)
    unsubscribe()

    expect(seen).toHaveLength(2)
    expect(feature(seen.at(-1)!, descriptor.toolContractId)).toMatchObject({ enabled: true })
    expect(await fixture.session.localTools.listLocalToolStates()).toEqual([
      expect.objectContaining({
        profileId,
        localNodeId,
        toolContractId: descriptor.toolContractId,
        enabled: true,
        revision: 1,
        descriptorHash: expect.stringMatching(/^[a-f0-9]{64}$/u)
      })
    ])

    const reloaded = new DurableFeatureSharingController(controllerOptions(fixture.session, fixture.registry, fixture.grantManager))
    expect(feature(await reloaded.load(), descriptor.toolContractId)).toMatchObject({ enabled: true })
  })

  it('persists tool-group defaults and per-tool approval overrides without changing shareable features', async () => {
    const fixture = await controllerFixture()
    await fixture.controller.load()
    const entry = fixture.registry.resolveForDispatch(descriptor.toolContractId)!
    const sourceId = entry.toolInfo.share_group_id

    await fixture.controller.setSourceApprovalPolicy(sourceId, 'untrusted', true)
    await fixture.controller.setToolApprovalOverride(descriptor.toolContractId, 'deny_all')
    await fixture.controller.setFeatureEnabled(descriptor.toolContractId, true)

    expect(await fixture.controller.loadApprovalPolicies()).toEqual({
      sourcePolicies: [{
        sourceId,
        trustTier: 'untrusted',
        includeFutureTools: true,
        knownToolContractIds: [descriptor.toolContractId],
        revision: 1,
        updatedAtMs: 1_000
      }],
      toolPolicies: [{
        toolContractId: descriptor.toolContractId,
        globalToolId: entry.toolInfo.global_tool_id,
        localToolName: descriptor.localName,
        trustTier: 'blocked',
        revision: 1,
        updatedAtMs: 1_000
      }],
      revision: 1,
      unavailable: false
    })
    expect(fixture.controller.resolveLocalToolApproval(entry)).toEqual({
      mode: 'deny_all',
      sourceId,
      unavailable: false
    })
    const records = await fixture.session.localTools.listLocalToolStates()
    expect(records).toHaveLength(2)
    expect(records.find((record) => record.toolContractId === descriptor.toolContractId)).toMatchObject({
      enabled: true,
      revision: 2,
      settingsEnvelope: expect.objectContaining({ version: 1 })
    })

    const reloaded = new DurableFeatureSharingController(
      controllerOptions(fixture.session, fixture.registry, fixture.grantManager, fixture.crypto)
    )
    expect((await reloaded.load()).features).toHaveLength(2)
    expect(await reloaded.loadApprovalPolicies()).toEqual(await fixture.controller.loadApprovalPolicies())
    expect(reloaded.resolveLocalToolApproval(entry).mode).toBe('deny_all')

    await reloaded.clearToolApprovalOverride(descriptor.toolContractId)
    expect(reloaded.resolveLocalToolApproval(entry).mode).toBe('ask_each_time')
    await reloaded.clearSourceApprovalPolicy(sourceId)
    expect(reloaded.resolveLocalToolApproval(entry).mode).toBe('inherit')
  })

  it('requires review for tools added after source trust unless future tools were included', async () => {
    const fixture = await controllerFixture()
    await fixture.controller.load()
    const existingEntry = fixture.registry.resolveForDispatch(descriptor.toolContractId)!
    const sourceId = existingEntry.toolInfo.share_group_id

    await fixture.controller.setSourceApprovalPolicy(sourceId, 'trusted', false)
    expect(fixture.controller.resolveLocalToolApproval(existingEntry).mode).toBe('approve_all_for_peer')

    const futureDescriptor: LocalToolDescriptorV1 = {
      ...descriptor,
      toolContractId: 'aurora.local.native.share_link.v1',
      localName: 'native.share_link',
      displayName: 'Share link',
      handlerId: 'native.share_link'
    }
    fixture.registry.register({ descriptor: futureDescriptor, handler: () => ({ shared: true }) })
    const futureEntry = fixture.registry.resolveForDispatch(futureDescriptor.toolContractId)!

    expect(fixture.controller.resolveLocalToolApproval(futureEntry)).toEqual({
      mode: 'ask_each_time',
      sourceId,
      unavailable: false
    })

    const reloaded = new DurableFeatureSharingController(
      controllerOptions(fixture.session, fixture.registry, fixture.grantManager, fixture.crypto)
    )
    await reloaded.load()
    expect(reloaded.resolveLocalToolApproval(existingEntry).mode).toBe('approve_all_for_peer')
    expect(reloaded.resolveLocalToolApproval(futureEntry).mode).toBe('ask_each_time')
  })

  it('marks unreadable local approval policy unavailable without publishing synthetic features', async () => {
    const fixture = await controllerFixture()
    await fixture.controller.load()
    const entry = fixture.registry.resolveForDispatch(descriptor.toolContractId)!
    await fixture.controller.setToolApprovalOverride(descriptor.toolContractId, 'ask_each_time')
    const failingCrypto: EnvelopeCryptoPort = {
      encrypt: fixture.crypto.encrypt.bind(fixture.crypto),
      decrypt: async () => { throw new Error('unreadable policy') },
      rotateKey: fixture.crypto.rotateKey.bind(fixture.crypto)
    }
    const reloaded = new DurableFeatureSharingController(
      controllerOptions(fixture.session, fixture.registry, fixture.grantManager, failingCrypto)
    )

    const sharing = await reloaded.load()

    expect(sharing.features.map((item) => item.id)).toEqual([
      statusDescriptor.toolContractId,
      descriptor.toolContractId
    ].sort())
    expect(await reloaded.loadApprovalPolicies()).toMatchObject({ unavailable: true })
    expect(reloaded.resolveLocalToolApproval(entry)).toMatchObject({
      mode: 'deny_all',
      unavailable: true
    })
  })

  it('does not mutate memory when a durable local-tool write fails', async () => {
    const fixture = await controllerFixture()
    await fixture.controller.load()
    const original = fixture.session.localTools.upsertLocalToolState.bind(fixture.session.localTools)
    ;(fixture.session.localTools as unknown as { upsertLocalToolState: typeof fixture.session.localTools.upsertLocalToolState }).upsertLocalToolState = async () => {
      throw new Error('write failed')
    }
    const controller = new DurableFeatureSharingController(controllerOptions(fixture.session, fixture.registry, fixture.grantManager))
    await controller.load()

    await expect(controller.setFeatureEnabled(descriptor.toolContractId, true)).rejects.toMatchObject({
      code: 'storage_unavailable'
    })
    ;(fixture.session.localTools as unknown as { upsertLocalToolState: typeof fixture.session.localTools.upsertLocalToolState }).upsertLocalToolState = original
    expect(feature(await controller.load(), descriptor.toolContractId)).toMatchObject({ enabled: false })
  })

  it('tracks pairing only after successful durable issue and exposes no selector material in snapshots', async () => {
    const fixture = await controllerFixture()
    await fixture.controller.load()
    await fixture.controller.setFeatureEnabled(descriptor.toolContractId, true)
    const authority = await createTestAuthority(() => 100)
    const issuer = new TrackingPeerPairingIssuer({
      delegate: authority.pairingIssuer,
      registry: fixture.controller,
      labelForSelector: () => 'Phone'
    })

    await expect(issuer.issue(selector)).resolves.toMatchObject({ tokenId: selector.tokenId })
    const snapshot = await fixture.controller.load()

    expect(snapshot.approvedDevices).toEqual([
      { peerId: selector.claimantPeerId, peerLabel: 'Phone', featureIds: [], expiresAtMs: null }
    ])
    expect(JSON.stringify(snapshot)).not.toMatch(/token-1|room-a|verifier|provider/u)

    const failingIssuer = new TrackingPeerPairingIssuer({
      delegate: {
        issue: async () => { throw new Error('persistence failed') },
        rollback: async () => undefined
      },
      registry: fixture.controller
    })
    await expect(failingIssuer.issue({ ...selector, claimantPeerId: 'peer-b', tokenId: 'token-b' })).rejects.toThrow(/persistence/u)
    expect((await fixture.controller.load()).approvedDevices.map((peer) => peer.peerId)).toEqual(['peer-a'])
  })

  it('applies the locally selected features when a pairing credential is issued', async () => {
    const fixture = await controllerFixture()
    await fixture.controller.load()
    await fixture.controller.setFeatureEnabled(descriptor.toolContractId, true)
    const authority = await createTestAuthority(() => 100)
    const issuer = new TrackingPeerPairingIssuer({
      delegate: authority.pairingIssuer,
      registry: fixture.controller,
      labelForSelector: () => 'Phone'
    })

    await expect(issuer.issue(selector, { featureIds: [descriptor.toolContractId] })).resolves.toMatchObject({
      grantedPermissions: ['Native.ShareText']
    })

    expect(await fixture.controller.load()).toMatchObject({
      approvedDevices: [{
        peerId: selector.claimantPeerId,
        peerLabel: 'Phone',
        featureIds: [descriptor.toolContractId],
        expiresAtMs: null
      }]
    })
  })

  it('rolls back a failed scope grant and lets a fresh pairing replace the same peer without ambiguity', async () => {
    const fixture = await controllerFixture()
    await fixture.controller.load()
    await fixture.controller.setFeatureEnabled(descriptor.toolContractId, true)
    const authority = await createTestAuthority(() => 100)
    const baseIssuer = authority.pairingIssuer
    const rollback = vi.spyOn(baseIssuer, 'rollback')
    vi.spyOn(fixture.grantManager, 'replaceGrant').mockRejectedValueOnce(new Error('grant write failed'))
    const issuer = new TrackingPeerPairingIssuer({
      delegate: baseIssuer,
      registry: fixture.controller,
      labelForSelector: () => 'Phone'
    })

    await expect(issuer.issue(selector, { featureIds: [descriptor.toolContractId] })).rejects.toMatchObject({
      code: 'sharing_unavailable'
    })
    await expect(authority.getVerifier(selector, 101)).resolves.toBeUndefined()
    expect((await fixture.controller.load()).approvedDevices).toEqual([])

    await issuer.issue(secondSelector, { featureIds: [descriptor.toolContractId] })

    expect(rollback).toHaveBeenCalledWith(selector)
    expect(await fixture.controller.load()).toMatchObject({
      approvedDevices: [{
        peerId: selector.claimantPeerId,
        peerLabel: 'Phone',
        featureIds: [descriptor.toolContractId],
        expiresAtMs: null
      }]
    })
    await expect(fixture.grantManager.listActiveGrants(selector)).resolves.toEqual([])
    await expect(fixture.grantManager.listActiveGrants(secondSelector)).resolves.toHaveLength(1)
  })

  it('rotates a previously delivered credential and grant when the same peer pairs again', async () => {
    const fixture = await controllerFixture()
    await fixture.controller.load()
    await fixture.controller.setFeatureEnabled(descriptor.toolContractId, true)
    const authority = await createTestAuthority(() => 100)
    const baseIssuer = authority.pairingIssuer
    const issuer = new TrackingPeerPairingIssuer({
      delegate: baseIssuer,
      registry: fixture.controller,
      labelForSelector: () => 'Phone'
    })

    await issuer.issue(selector, { featureIds: [descriptor.toolContractId] })
    await issuer.issue(secondSelector, { featureIds: [descriptor.toolContractId] })

    await expect(authority.getVerifier(selector, 101)).resolves.toBeUndefined()
    await expect(authority.getVerifier(secondSelector, 101)).resolves.toBeDefined()
    await expect(fixture.grantManager.listActiveGrants(selector)).resolves.toEqual([])
    await expect(fixture.grantManager.listActiveGrants(secondSelector)).resolves.toHaveLength(1)
    expect((await fixture.controller.load()).approvedDevices).toEqual([{
      peerId: selector.claimantPeerId,
      peerLabel: 'Phone',
      featureIds: [descriptor.toolContractId],
      expiresAtMs: null
    }])
  })

  it('fails closed when the previous credential cannot be retired and converges on retry', async () => {
    const fixture = await controllerFixture()
    await fixture.controller.load()
    await fixture.controller.setFeatureEnabled(descriptor.toolContractId, true)
    const authority = await createTestAuthority(() => 100)
    const baseIssuer = authority.pairingIssuer
    const issuer = new TrackingPeerPairingIssuer({
      delegate: baseIssuer,
      registry: fixture.controller,
      labelForSelector: () => 'Phone'
    })

    await issuer.issue(selector, { featureIds: [descriptor.toolContractId] })
    const rollback = vi.spyOn(baseIssuer, 'rollback')
    rollback.mockRejectedValueOnce(new Error('old verifier deletion failed'))

    await expect(issuer.issue(secondSelector, { featureIds: [descriptor.toolContractId] })).rejects.toThrow(
      'old verifier deletion failed'
    )

    await expect(authority.getVerifier(selector, 101)).resolves.toBeDefined()
    await expect(authority.getVerifier(secondSelector, 101)).resolves.toBeUndefined()
    await expect(fixture.grantManager.listActiveGrants(selector)).resolves.toHaveLength(1)
    await expect(fixture.grantManager.listActiveGrants(secondSelector)).resolves.toEqual([])
    expect((await fixture.controller.load()).approvedDevices).toEqual([{
      peerId: selector.claimantPeerId,
      peerLabel: 'Phone',
      featureIds: [descriptor.toolContractId],
      expiresAtMs: null
    }])

    await issuer.issue(secondSelector, { featureIds: [descriptor.toolContractId] })

    await expect(authority.getVerifier(selector, 101)).resolves.toBeUndefined()
    await expect(authority.getVerifier(secondSelector, 101)).resolves.toBeDefined()
    await expect(fixture.grantManager.listActiveGrants(selector)).resolves.toEqual([])
    await expect(fixture.grantManager.listActiveGrants(secondSelector)).resolves.toHaveLength(1)
    expect((await fixture.controller.load()).approvedDevices).toEqual([{
      peerId: selector.claimantPeerId,
      peerLabel: 'Phone',
      featureIds: [descriptor.toolContractId],
      expiresAtMs: null
    }])
  })

  it('converges after the old credential retires but the replacement grant write fails', async () => {
    const fixture = await controllerFixture()
    await fixture.controller.load()
    await fixture.controller.setFeatureEnabled(descriptor.toolContractId, true)
    const authority = await createTestAuthority(() => 100)
    const baseIssuer = authority.pairingIssuer
    const issuer = new TrackingPeerPairingIssuer({
      delegate: baseIssuer,
      registry: fixture.controller,
      labelForSelector: () => 'Phone'
    })

    await issuer.issue(selector, { featureIds: [descriptor.toolContractId] })
    vi.spyOn(fixture.grantManager, 'replaceGrant').mockRejectedValueOnce(new Error('replacement grant write failed'))

    await expect(issuer.issue(secondSelector, { featureIds: [descriptor.toolContractId] })).rejects.toMatchObject({
      code: 'sharing_unavailable'
    })

    await expect(authority.getVerifier(selector, 101)).resolves.toBeUndefined()
    await expect(authority.getVerifier(secondSelector, 101)).resolves.toBeUndefined()
    await expect(fixture.grantManager.listActiveGrants(selector)).resolves.toHaveLength(1)
    await expect(fixture.grantManager.listActiveGrants(secondSelector)).resolves.toEqual([])

    await issuer.issue(secondSelector, { featureIds: [descriptor.toolContractId] })

    await expect(authority.getVerifier(selector, 101)).resolves.toBeUndefined()
    await expect(authority.getVerifier(secondSelector, 101)).resolves.toBeDefined()
    await expect(fixture.grantManager.listActiveGrants(selector)).resolves.toEqual([])
    await expect(fixture.grantManager.listActiveGrants(secondSelector)).resolves.toHaveLength(1)
    expect((await fixture.controller.load()).approvedDevices).toEqual([{
      peerId: selector.claimantPeerId,
      peerLabel: 'Phone',
      featureIds: [descriptor.toolContractId],
      expiresAtMs: null
    }])
  })

  it('validates enabled registered features and writes exact grant contents and expiry', async () => {
    const fixture = await controllerFixture()
    await fixture.controller.load()
    fixture.controller.registerTrustedRelationship(selector, 'Phone')
    await fixture.controller.setFeatureEnabled(descriptor.toolContractId, true)

    await expect(fixture.controller.replacePeerSharing(selector.claimantPeerId, ['unknown'], 2_000)).rejects.toMatchObject({
      code: 'invalid_feature'
    })
    await expect(fixture.controller.replacePeerSharing(selector.claimantPeerId, [statusDescriptor.toolContractId], 2_000)).rejects.toMatchObject({
      code: 'feature_disabled'
    })
    await fixture.controller.replacePeerSharing(selector.claimantPeerId, [descriptor.toolContractId], 2_000)

    const grants = await fixture.grantManager.listActiveGrants(selector)
    expect(grants).toEqual([
      expect.objectContaining({
        claimantPeerId: selector.claimantPeerId,
        allowedMethodIds: [...MESH_NODE_TOOLING_METHOD_IDS].sort(),
        allowedToolContractIds: [descriptor.toolContractId],
        capabilityPackIds: ['aurora.browser.share'],
        resourceScopes: ['native.share'],
        expiresAtMs: 2_000,
        secretFieldsRedacted: true
      })
    ])
    expect(fixture.controller.isShared(publicTool(fixture.registry, descriptor.toolContractId), projectionContext())).toBe(true)
  })

  it('revokes sharing without revoking the credential relationship', async () => {
    const fixture = await controllerFixture()
    await fixture.controller.load()
    fixture.controller.registerTrustedRelationship(selector, 'Phone')
    await fixture.controller.setFeatureEnabled(descriptor.toolContractId, true)
    await fixture.controller.replacePeerSharing(selector.claimantPeerId, [descriptor.toolContractId], null)

    await fixture.controller.revokePeerSharing(selector.claimantPeerId)

    await expect(fixture.grantManager.listActiveGrants(selector)).resolves.toEqual([])
    await expect(fixture.controller.load()).resolves.toMatchObject({
      approvedDevices: [{ peerId: selector.claimantPeerId, peerLabel: 'Phone', featureIds: [], expiresAtMs: null }]
    })
  })

  it('rehydrates selectors only from validated encrypted grant metadata', async () => {
    const fixture = await controllerFixture()
    await fixture.repository.upsertGrant({
      version: 1,
      grantId: 'grant-1',
      ...selector,
      allowedMethodIds: MESH_NODE_TOOLING_METHOD_IDS,
      allowedToolContractIds: [descriptor.toolContractId],
      capabilityPackIds: ['aurora.browser.share'],
      resourceScopes: ['native.share'],
      createdAtMs: 1_000,
      expiresAtMs: 5_000,
      grantRevision: 1
    })
    await fixture.session.peerGrants.upsertPeerGrant({
      ...(await fixture.session.peerGrants.listPeerGrants())[0]!,
      grantId: 'unvalidated-metadata',
      tokenId: 'token-no-active-grant',
      claimantPeerId: 'peer-z'
    })
    await fixture.session.localTools.upsertLocalToolState({
      profileId,
      localNodeId,
      toolContractId: descriptor.toolContractId,
      descriptorJson: fixture.registry.resolvePublicId(descriptor.toolContractId)!.publicDescriptor as unknown as LocalToolStateRecord['descriptorJson'],
      descriptorHash: fixture.registry.resolvePublicId(descriptor.toolContractId)!.descriptorHash,
      enabled: true,
      settingsEnvelope: null,
      revision: 1,
      updatedAtMs: 1_000
    })

    const reloaded = new DurableFeatureSharingController(controllerOptions(fixture.session, fixture.registry, fixture.grantManager))
    const snapshot = await reloaded.load()

    expect(snapshot.approvedDevices).toEqual([
      { peerId: selector.claimantPeerId, peerLabel: selector.claimantPeerId, featureIds: [descriptor.toolContractId], expiresAtMs: 5_000 }
    ])
    expect(JSON.stringify(snapshot)).not.toMatch(/token|room-a|provider|verifier/u)
  })

  it('does not publish false empty sharing when grant reads are unavailable during load or refresh', async () => {
    const fixture = await controllerFixture()
    const throwingGrantManager = {
      listActiveGrants: async () => { throw new Error('grant store unavailable') },
      replaceGrant: fixture.grantManager.replaceGrant.bind(fixture.grantManager),
      revokeSharing: fixture.grantManager.revokeSharing.bind(fixture.grantManager)
    } as unknown as PeerGrantManagerPort
    const loadingController = new DurableFeatureSharingController(controllerOptions(fixture.session, fixture.registry, throwingGrantManager))
    loadingController.registerTrustedRelationship(selector, 'Phone')
    const loadListener = vi.fn()
    loadingController.subscribe(loadListener)

    await expect(loadingController.load()).rejects.toMatchObject({
      code: 'sharing_unavailable',
      message: 'Sharing choices are unavailable'
    })
    expect(loadListener).not.toHaveBeenCalled()
    expect(loadingController.isShared(publicTool(fixture.registry, descriptor.toolContractId), projectionContext())).toBe(false)

    const workingFixture = await controllerFixture()
    await workingFixture.controller.load()
    workingFixture.controller.registerTrustedRelationship(selector, 'Phone')
    await workingFixture.controller.setFeatureEnabled(descriptor.toolContractId, true)
    await workingFixture.controller.replacePeerSharing(selector.claimantPeerId, [descriptor.toolContractId], null)
    const beforeFailure = await workingFixture.controller.load()
    expect(beforeFailure.approvedDevices).toEqual([
      { peerId: selector.claimantPeerId, peerLabel: 'Phone', featureIds: [descriptor.toolContractId], expiresAtMs: null }
    ])
    expect(workingFixture.controller.isShared(publicTool(workingFixture.registry, descriptor.toolContractId), projectionContext())).toBe(true)

    const refreshListener = vi.fn()
    const statusListener = vi.fn()
    workingFixture.controller.subscribe(refreshListener)
    workingFixture.controller.subscribeStatus(statusListener)
    ;(workingFixture.grantManager as unknown as { listActiveGrants: typeof workingFixture.grantManager.listActiveGrants }).listActiveGrants = async () => {
      throw new Error('grant store unavailable')
    }
    workingFixture.controller.registerTrustedRelationship({ ...selector, claimantPeerId: 'peer-refresh', tokenId: 'token-refresh' }, 'Tablet')
    await nextTick()

    expect(refreshListener).toHaveBeenCalledTimes(1)
    expect(refreshListener.mock.calls[0]?.[0]).toEqual(beforeFailure)
    expect(statusListener).toHaveBeenLastCalledWith({
      ok: false,
      code: 'sharing_unavailable',
      message: 'Sharing choices are unavailable'
    })
    expect(workingFixture.controller.isShared(publicTool(workingFixture.registry, descriptor.toolContractId), projectionContext())).toBe(true)
    expect(JSON.stringify(statusListener.mock.calls)).not.toMatch(/token|room-a|provider|verifier/u)
  })

  it('accepts non-safe room names while keeping peer and token IDs safe', async () => {
    const fixture = await controllerFixture()
    const specialRoom = 'room with spaces / 東京 ?#=1'
    const specialSelector: PeerRelationshipSelector = {
      ...selector,
      roomName: specialRoom,
      tokenId: 'token-special'
    }
    const controller = new DurableFeatureSharingController({
      ...controllerOptions(fixture.session, fixture.registry, fixture.grantManager),
      roomName: specialRoom
    })

    controller.registerTrustedRelationship(specialSelector, 'Phone')
    const snapshot = await controller.load()

    expect(snapshot.approvedDevices).toEqual([
      { peerId: selector.claimantPeerId, peerLabel: 'Phone', featureIds: [], expiresAtMs: null }
    ])
    expect(JSON.stringify(snapshot)).not.toContain(specialRoom)
    expect(() => controller.registerTrustedRelationship({ ...specialSelector, tokenId: 'bad token' })).toThrow(DurableFeatureSharingError)
  })

  it('fails closed for ambiguous peer selectors and returns product-safe errors', async () => {
    const fixture = await controllerFixture()
    await fixture.controller.load()
    await fixture.controller.setFeatureEnabled(descriptor.toolContractId, true)
    fixture.controller.registerTrustedRelationship(selector, 'Phone')
    fixture.controller.registerTrustedRelationship(secondSelector, 'Phone')

    await expect(fixture.controller.replacePeerSharing(selector.claimantPeerId, [descriptor.toolContractId], null)).rejects.toMatchObject({
      code: 'ambiguous_peer',
      message: 'This device cannot be changed right now'
    })
    await expect(fixture.controller.revokePeerSharing(selector.claimantPeerId)).rejects.toBeInstanceOf(DurableFeatureSharingError)
  })

  it('sends immutable cloned snapshots to subscribers', async () => {
    const fixture = await controllerFixture()
    await fixture.controller.load()
    const listener = vi.fn((snapshot: LocalFeatureSharingSnapshot) => {
      ;(snapshot.features as unknown as Array<{ enabled: boolean }>)[0]!.enabled = true
    })
    fixture.controller.subscribe(listener)

    const snapshot = await fixture.controller.load()

    expect(listener).toHaveBeenCalled()
    expect(snapshot.features[0]?.enabled).toBe(false)
  })
})

function feature(snapshot: LocalFeatureSharingSnapshot, id: string) {
  const item = snapshot.features.find((candidate) => candidate.id === id)
  if (!item) throw new Error(`missing feature ${id}`)
  return item
}

function publicTool(registry: LocalToolRegistry, id: string) {
  const item = registry.publicTools().find((tool) => tool.tool_contract_id === id)
  if (!item) throw new Error(`missing public tool ${id}`)
  return item
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function controllerFixture() {
  const backend = new MemoryLocalDataBackend()
  const session = await backend.open(profileId, localNodeId)
  const registry = new LocalToolRegistry({ stablePeerId: localNodeId })
  registry.register({ descriptor, handler: () => ({ shared: true }) })
  registry.register({ descriptor: statusDescriptor, handler: () => ({ online: true }) })
  const crypto = new RecordingEnvelopeCryptoPort()
  const repository = new EncryptedPeerGrantRepository({
    metadataRepository: session.peerGrants,
    crypto,
    profileId,
    localNodeId
  })
  // The real authority decides what sharing means; the encrypted repository is
  // still where the resulting rows land, which is what these tests assert.
  let grantSequence = 0
  const authority = await createTestAuthority(() => 1_000, () => `grant-${++grantSequence}`)
  const grantManager = authority.grantManager(() => 1_000, repository)
  const controller = new DurableFeatureSharingController(controllerOptions(session, registry, grantManager, crypto))
  return { backend, session, registry, crypto, repository, grantManager, controller }
}

function controllerOptions(
  session: LocalDataSession,
  registry: LocalToolRegistry,
  grantManager: PeerGrantManagerPort,
  crypto?: EnvelopeCryptoPort
) {
  return {
    registry,
    session,
    grantManager,
    localVerifierPeerId: localNodeId,
    roomName,
    ...(crypto ? { crypto } : {}),
    now: () => 1_000
  }
}

function projectionContext() {
  return {
    recipientPeerId: selector.claimantPeerId,
    recipientPermissions: ['Tooling.GetTools', 'Tooling.ExecuteTool', 'Native.ShareText'],
    authorityRevision: {
      catalog_revision: 1,
      export_policy_revision: 1,
      auth_grant_revision: 1,
      manifest_revision: 1,
      switch_revision: 1,
      protocol_revision: 1
    },
    providerEnabled: true,
    serviceExported: true,
    discoveryExported: true,
    executionExported: true
  }
}

class RecordingEnvelopeCryptoPort implements EnvelopeCryptoPort {
  private readonly retained = new Map<string, { plaintext: Uint8Array; aad: string }>()
  private counter = 0

  async encrypt(keyPurpose: LocalDataKeyPurpose, plaintext: Uint8Array, aad: Uint8Array): Promise<EncryptedDataEnvelopeV1> {
    expect(keyPurpose).toBe('local-structured-data')
    this.counter += 1
    const ciphertextAndTagB64Url = encodeBase64Url(new Uint8Array([this.counter, ...new Uint8Array(16).fill(7)]))
    this.retained.set(ciphertextAndTagB64Url, {
      plaintext: new Uint8Array(plaintext),
      aad: new TextDecoder().decode(aad)
    })
    return {
      version: 1,
      algorithm: 'AES-GCM-256',
      keyId: `test-key-${this.counter}`,
      nonceB64Url: encodeBase64Url(new Uint8Array(12).fill(this.counter)),
      ciphertextAndTagB64Url,
      createdAtMs: 1_000 + this.counter
    }
  }

  async decrypt(envelope: EncryptedDataEnvelopeV1, aad: Uint8Array): Promise<Uint8Array> {
    const retained = this.retained.get(envelope.ciphertextAndTagB64Url)
    if (retained === undefined) throw new Error('ciphertext not found')
    if (retained.aad !== new TextDecoder().decode(aad)) throw new Error('aad mismatch')
    return new Uint8Array(retained.plaintext)
  }

  async rotateKey(_keyPurpose: LocalDataKeyPurpose): Promise<{ previousKeyId: string; newKeyId: string }> {
    return { previousKeyId: 'old', newKeyId: 'new' }
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

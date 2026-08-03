import {
  buildEnvelopeAad,
  type EnvelopeCryptoPort,
  type LocalDataSession,
  type LocalToolStateRecord,
  type PeerGrantMetadataRecord
} from '../local-data/index.js'
import type { IssuedPeerBearerCredential, PeerPairingIssueOptions, PeerRelationshipSelector } from '../peer-host/authority.js'
import { PeerGrantManager, type PeerGrantSummary } from '../peer-host/grant-management.js'
import type { ToolingProjectionToolInfo } from '../types.js'
import { MESH_NODE_TOOLING_METHOD_IDS } from './mesh-node-provider.js'
import type { LocalToolExportDecisionPort, LocalToolProjectionContext } from './export-catalog.js'
import { canonicalJsonSha256Hex } from './canonical-json.js'
import type { LocalToolDispatchEntry, LocalToolRegistry, RegisteredLocalTool } from './tool-registry.js'

const MAX_ID_LENGTH = 256
const SAFE_ID_RE = /^[A-Za-z0-9_.:@/-]+$/u
const SOURCE_POLICY_ROW_PREFIX = 'aurora.policy.tool_group.'
const LOCAL_TOOL_POLICY_VERSION = 1
const LOCAL_TOOL_POLICY_MAX_BYTES = 16 * 1024

export interface LocalDeviceFeature {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly serviceId: string
  readonly servicePermissionId: string
  readonly serviceLabel: string
  readonly serviceDescription: string
  readonly enabled: boolean
  readonly available: boolean
  readonly requiresAuroraOpen: boolean
  readonly requiresLocalConfirmation: boolean
  readonly permissionNeeded?: boolean | undefined
  readonly safetyClass: RegisteredLocalTool['descriptor']['safetyClass']
  readonly requiredPermissions: readonly string[]
  readonly nativeCapabilityIds: readonly string[]
  readonly nativePermissionIds: readonly string[]
  readonly resourceScopes: readonly string[]
  readonly descriptorHash: string
}

export interface LocalFeaturePeerSharing {
  readonly peerId: string
  readonly peerLabel: string
  readonly featureIds: readonly string[]
  readonly expiresAtMs: number | null
}

export interface LocalFeatureSharingSnapshot {
  readonly features: readonly LocalDeviceFeature[]
  readonly approvedDevices: readonly LocalFeaturePeerSharing[]
}

export interface LocalFeatureSharingPort {
  load(): Promise<LocalFeatureSharingSnapshot>
  subscribe?(listener: (snapshot: LocalFeatureSharingSnapshot) => void): () => void
  subscribeStatus?(listener: (status: LocalFeatureSharingStatus) => void): () => void
  setFeatureEnabled(featureId: string, enabled: boolean): Promise<void>
  replacePeerSharing(peerId: string, featureIds: readonly string[], expiresAtMs: number | null): Promise<void>
  revokePeerSharing(peerId: string): Promise<void>
  /** Tool approval policy is managed on the Tools page, separate from service sharing. */
  readonly toolApprovalPolicy?: LocalToolApprovalPolicyPort | undefined
}

export type LocalToolApprovalTrustTier = 'trusted' | 'untrusted' | 'blocked'
export type LocalToolApprovalMode = 'inherit' | 'approve_all_for_peer' | 'ask_each_time' | 'deny_all'

export interface LocalToolApprovalSourcePolicy {
  readonly sourceId: string
  readonly trustTier: LocalToolApprovalTrustTier
  readonly includeFutureTools: boolean
  readonly knownToolContractIds?: readonly string[] | undefined
  readonly revision: number
  readonly updatedAtMs: number
}

export interface LocalToolApprovalToolPolicy {
  readonly toolContractId: string
  readonly globalToolId: string
  readonly localToolName: string
  readonly trustTier: LocalToolApprovalTrustTier
  readonly revision: number
  readonly updatedAtMs: number
}

export interface LocalToolApprovalPolicySnapshot {
  readonly sourcePolicies: readonly LocalToolApprovalSourcePolicy[]
  readonly toolPolicies: readonly LocalToolApprovalToolPolicy[]
  readonly revision: number
  readonly unavailable: boolean
}

export interface LocalToolApprovalDecision {
  readonly mode: LocalToolApprovalMode
  readonly sourceId: string
  readonly unavailable: boolean
}

export interface LocalToolApprovalDecisionPort {
  resolveLocalToolApproval(entry: LocalToolDispatchEntry): LocalToolApprovalDecision
}

export interface LocalToolApprovalPolicyPort extends LocalToolApprovalDecisionPort {
  loadApprovalPolicies(): Promise<LocalToolApprovalPolicySnapshot>
  subscribeApprovalPolicies?(listener: (snapshot: LocalToolApprovalPolicySnapshot) => void): () => void
  setSourceApprovalPolicy(sourceId: string, trustTier: LocalToolApprovalTrustTier, includeFutureTools?: boolean): Promise<void>
  clearSourceApprovalPolicy(sourceId: string): Promise<void>
  setToolApprovalOverride(toolIdOrContractId: string, mode: Exclude<LocalToolApprovalMode, 'inherit'>): Promise<void>
  clearToolApprovalOverride(toolIdOrContractId: string): Promise<void>
}

export interface LocalFeatureSharingStatus {
  readonly ok: boolean
  readonly code: 'ready' | 'sharing_unavailable'
  readonly message: string
}

export interface PeerPairingIssuerLike {
  issue(selector: PeerRelationshipSelector, options?: PeerPairingIssueOptions): Promise<IssuedPeerBearerCredential>
  rollback(selector: PeerRelationshipSelector): Promise<void>
}

export interface TrustedPeerRelationshipRegistry {
  registerTrustedRelationship(selector: PeerRelationshipSelector, peerLabel?: string | null): void
  commitPairingRelationship(
    selector: PeerRelationshipSelector,
    peerLabel: string | null,
    featureIds: readonly string[],
    expiresAtMs: number | null,
    retireRelationships: (selectors: readonly PeerRelationshipSelector[]) => Promise<void>
  ): Promise<void>
  rollbackPairingRelationship(selector: PeerRelationshipSelector): Promise<void>
  requiredPermissionsForFeatures?(featureIds: readonly string[]): readonly string[]
}

export interface DurableFeatureSharingControllerOptions {
  readonly registry: LocalToolRegistry
  readonly session: LocalDataSession
  readonly grantManager: PeerGrantManager
  readonly localVerifierPeerId: string
  readonly roomName: string
  readonly crypto?: EnvelopeCryptoPort | undefined
  readonly now?: () => number
}

interface ToolState {
  readonly enabled: boolean
  readonly settingsEnvelope: LocalToolStateRecord['settingsEnvelope']
  readonly revision: number
  readonly updatedAtMs: number
}

interface StoredSourcePolicy extends LocalToolApprovalSourcePolicy {
  readonly knownToolContractIds: readonly string[]
  readonly rowId: string
  readonly settingsEnvelope: NonNullable<LocalToolStateRecord['settingsEnvelope']>
}

interface StoredToolPolicy extends LocalToolApprovalToolPolicy {
  readonly settingsEnvelope: NonNullable<LocalToolStateRecord['settingsEnvelope']>
}

interface TrustedRelationship {
  readonly selector: PeerRelationshipSelector
  readonly peerLabel: string
}

interface ActiveSharing {
  readonly featureIds: readonly string[]
  readonly expiresAtMs: number | null
}

export class DurableFeatureSharingError extends Error {
  readonly code:
    | 'not_loaded'
    | 'invalid_feature'
    | 'feature_disabled'
    | 'invalid_peer'
    | 'ambiguous_peer'
    | 'sharing_unavailable'
    | 'storage_unavailable'

  constructor(code: DurableFeatureSharingError['code']) {
    super(safeMessage(code))
    this.name = 'DurableFeatureSharingError'
    this.code = code
  }
}

export class TrackingPeerPairingIssuer implements PeerPairingIssuerLike {
  private readonly delegate: PeerPairingIssuerLike
  private readonly registry: TrustedPeerRelationshipRegistry
  private readonly labelForSelector?: ((selector: PeerRelationshipSelector) => string | null | undefined) | undefined

  constructor(options: {
    readonly delegate: PeerPairingIssuerLike
    readonly registry: TrustedPeerRelationshipRegistry
    readonly labelForSelector?: ((selector: PeerRelationshipSelector) => string | null | undefined) | undefined
  }) {
    this.delegate = options.delegate
    this.registry = options.registry
    this.labelForSelector = options.labelForSelector
  }

  async issue(selector: PeerRelationshipSelector, options: PeerPairingIssueOptions = {}): Promise<IssuedPeerBearerCredential> {
    const peerLabel = this.labelForSelector?.(selector) ?? null
    const issued = await this.delegate.issue(selector, options)
    try {
      await this.registry.commitPairingRelationship(
        selector,
        peerLabel,
        options.featureIds ?? [],
        options.expiresAtMs ?? null,
        async (replacedSelectors) => {
          for (const replaced of replacedSelectors) await this.delegate.rollback(replaced)
        }
      )
      const grantedPermissions = this.registry.requiredPermissionsForFeatures?.(options.featureIds ?? []) ?? []
      return {
        ...issued,
        grantedPermissions: [...grantedPermissions]
      }
    } catch (error) {
      await Promise.allSettled([
        this.registry.rollbackPairingRelationship(selector),
        this.delegate.rollback(selector)
      ])
      throw error
    }
  }

  async rollback(selector: PeerRelationshipSelector): Promise<void> {
    const results = await Promise.allSettled([
      this.registry.rollbackPairingRelationship(selector),
      this.delegate.rollback(selector)
    ])
    if (results.some((result) => result.status === 'rejected')) {
      throw new DurableFeatureSharingError('sharing_unavailable')
    }
  }
}

export class DurableFeatureSharingController implements LocalFeatureSharingPort, LocalToolApprovalPolicyPort, LocalToolExportDecisionPort, TrustedPeerRelationshipRegistry {
  private readonly registry: LocalToolRegistry
  private readonly session: LocalDataSession
  private readonly grantManager: PeerGrantManager
  private readonly localVerifierPeerId: string
  private readonly roomName: string
  private readonly crypto: EnvelopeCryptoPort | null
  private readonly now: () => number
  private readonly listeners = new Set<(snapshot: LocalFeatureSharingSnapshot) => void>()
  private readonly statusListeners = new Set<(status: LocalFeatureSharingStatus) => void>()
  private readonly approvalPolicyListeners = new Set<(snapshot: LocalToolApprovalPolicySnapshot) => void>()
  private readonly trustedRelationships = new Map<string, TrustedRelationship[]>()
  private readonly toolStates = new Map<string, ToolState>()
  private readonly sourceApprovalPolicies = new Map<string, StoredSourcePolicy>()
  private readonly toolApprovalPolicies = new Map<string, StoredToolPolicy>()
  private readonly activeSharing = new Map<string, ActiveSharing>()
  readonly toolApprovalPolicy: LocalToolApprovalPolicyPort = this
  private loaded = false
  private approvalPolicyUnavailable = false
  private writeQueue: Promise<void> = Promise.resolve()
  private lastSnapshot: LocalFeatureSharingSnapshot | null = null
  private lastApprovalPolicySnapshot: LocalToolApprovalPolicySnapshot | null = null
  private lastStatus: LocalFeatureSharingStatus = readyStatus()

  constructor(options: DurableFeatureSharingControllerOptions) {
    this.registry = options.registry
    this.session = options.session
    this.grantManager = options.grantManager
    this.localVerifierPeerId = validateId(options.localVerifierPeerId, 'invalid_peer')
    this.roomName = validateRoomName(options.roomName)
    this.crypto = options.crypto ?? null
    this.now = options.now ?? Date.now
  }

  isShared(tool: ToolingProjectionToolInfo, context: LocalToolProjectionContext): boolean {
    if (!this.loaded) return false
    if (typeof tool.tool_contract_id !== 'string') return false
    const featureId = tool.tool_contract_id
    if (!this.toolStates.get(featureId)?.enabled) return false
    const sharing = this.activeSharing.get(context.recipientPeerId)
    return sharing?.featureIds.includes(featureId) ?? false
  }

  subscribe(listener: (snapshot: LocalFeatureSharingSnapshot) => void): () => void {
    this.listeners.add(listener)
    if (this.lastSnapshot) listener(cloneSnapshot(this.lastSnapshot))
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  subscribeStatus(listener: (status: LocalFeatureSharingStatus) => void): () => void {
    this.statusListeners.add(listener)
    listener(cloneStatus(this.lastStatus))
    let active = true
    return () => {
      if (!active) return
      active = false
      this.statusListeners.delete(listener)
    }
  }

  subscribeApprovalPolicies(listener: (snapshot: LocalToolApprovalPolicySnapshot) => void): () => void {
    this.approvalPolicyListeners.add(listener)
    if (this.lastApprovalPolicySnapshot) listener(cloneApprovalPolicySnapshot(this.lastApprovalPolicySnapshot))
    let active = true
    return () => {
      if (!active) return
      active = false
      this.approvalPolicyListeners.delete(listener)
    }
  }

  async loadApprovalPolicies(): Promise<LocalToolApprovalPolicySnapshot> {
    this.requireLoaded()
    return cloneApprovalPolicySnapshot(this.lastApprovalPolicySnapshot ?? this.approvalPolicySnapshot())
  }

  resolveLocalToolApproval(entry: LocalToolDispatchEntry): LocalToolApprovalDecision {
    const sourceId = localToolApprovalSourceId(entry)
    if (!this.loaded || this.approvalPolicyUnavailable) {
      return { mode: 'deny_all', sourceId, unavailable: true }
    }
    const toolPolicy = this.toolApprovalPolicies.get(entry.descriptor.toolContractId)
    const sourcePolicy = this.sourceApprovalPolicies.get(sourceId)
    const sourcePolicyApplies = sourcePolicy
      ? sourcePolicy.includeFutureTools
        || sourcePolicy.knownToolContractIds.includes(entry.descriptor.toolContractId)
      : false
    const trustTier = toolPolicy?.trustTier
      ?? (sourcePolicy ? (sourcePolicyApplies ? sourcePolicy.trustTier : 'untrusted') : null)
    return {
      mode: approvalModeForTrustTier(trustTier),
      sourceId,
      unavailable: false
    }
  }

  async setSourceApprovalPolicy(
    sourceId: string,
    trustTier: LocalToolApprovalTrustTier,
    includeFutureTools = true
  ): Promise<void> {
    await this.withWriteLock(async () => {
      this.requireLoaded()
      const normalizedSourceId = validateId(sourceId, 'invalid_feature')
      const parsedTrustTier = validateApprovalTrustTier(trustTier)
      const rowId = sourcePolicyRowId(normalizedSourceId)
      const records = await this.session.localTools.listLocalToolStates()
      const previous = latestToolState(records, this.session.profileId, this.session.localNodeId, rowId)
      const nowMs = this.currentTime()
      const revision = (previous?.revision ?? 0) + 1
      const knownToolContractIds = this.registeredTools()
        .filter((tool) => localToolApprovalSourceId(tool) === normalizedSourceId)
        .map((tool) => tool.descriptor.toolContractId)
        .sort()
      const policy: LocalToolApprovalSourcePolicy = {
        sourceId: normalizedSourceId,
        trustTier: parsedTrustTier,
        includeFutureTools: Boolean(includeFutureTools),
        knownToolContractIds,
        revision,
        updatedAtMs: nowMs
      }
      const settingsEnvelope = await this.encryptPolicy(rowId, sourcePolicyDocument(policy))
      const descriptorJson = sourcePolicyDescriptor(normalizedSourceId)
      await this.writeToolState({
        profileId: this.session.profileId,
        localNodeId: this.session.localNodeId,
        toolContractId: rowId,
        descriptorJson,
        descriptorHash: canonicalJsonSha256Hex(descriptorJson),
        enabled: false,
        settingsEnvelope,
        revision,
        updatedAtMs: nowMs
      })
      this.sourceApprovalPolicies.set(normalizedSourceId, {
        ...policy,
        knownToolContractIds,
        rowId,
        settingsEnvelope
      })
      this.publishApprovalPolicies()
    })
  }

  async clearSourceApprovalPolicy(sourceId: string): Promise<void> {
    await this.withWriteLock(async () => {
      this.requireLoaded()
      const normalizedSourceId = validateId(sourceId, 'invalid_feature')
      const rowId = sourcePolicyRowId(normalizedSourceId)
      const records = await this.session.localTools.listLocalToolStates()
      const previous = latestToolState(records, this.session.profileId, this.session.localNodeId, rowId)
      if (!previous && !this.sourceApprovalPolicies.has(normalizedSourceId)) return
      const nowMs = this.currentTime()
      const descriptorJson = sourcePolicyDescriptor(normalizedSourceId)
      await this.writeToolState({
        profileId: this.session.profileId,
        localNodeId: this.session.localNodeId,
        toolContractId: rowId,
        descriptorJson,
        descriptorHash: canonicalJsonSha256Hex(descriptorJson),
        enabled: false,
        settingsEnvelope: null,
        revision: (previous?.revision ?? 0) + 1,
        updatedAtMs: nowMs
      })
      this.sourceApprovalPolicies.delete(normalizedSourceId)
      this.publishApprovalPolicies()
    })
  }

  async setToolApprovalOverride(
    toolIdOrContractId: string,
    mode: Exclude<LocalToolApprovalMode, 'inherit'>
  ): Promise<void> {
    await this.withWriteLock(async () => {
      this.requireLoaded()
      const tool = this.requireResolvableTool(toolIdOrContractId)
      const trustTier = trustTierForApprovalMode(mode)
      const current = this.toolStates.get(tool.descriptor.toolContractId)
        ?? { enabled: false, settingsEnvelope: null, revision: 0, updatedAtMs: 0 }
      const nowMs = this.currentTime()
      const revision = current.revision + 1
      const policy: LocalToolApprovalToolPolicy = {
        toolContractId: tool.descriptor.toolContractId,
        globalToolId: tool.toolInfo.global_tool_id,
        localToolName: tool.descriptor.localName,
        trustTier,
        revision,
        updatedAtMs: nowMs
      }
      const settingsEnvelope = await this.encryptPolicy(
        tool.descriptor.toolContractId,
        toolPolicyDocument(policy)
      )
      await this.writeToolState({
        profileId: this.session.profileId,
        localNodeId: this.session.localNodeId,
        toolContractId: tool.descriptor.toolContractId,
        descriptorJson: tool.publicDescriptor as unknown as LocalToolStateRecord['descriptorJson'],
        descriptorHash: tool.descriptorHash,
        enabled: current.enabled,
        settingsEnvelope,
        revision,
        updatedAtMs: nowMs
      })
      this.toolStates.set(tool.descriptor.toolContractId, {
        enabled: current.enabled,
        settingsEnvelope,
        revision,
        updatedAtMs: nowMs
      })
      this.toolApprovalPolicies.set(tool.descriptor.toolContractId, {
        ...policy,
        settingsEnvelope
      })
      this.publishApprovalPolicies()
    })
  }

  async clearToolApprovalOverride(toolIdOrContractId: string): Promise<void> {
    await this.withWriteLock(async () => {
      this.requireLoaded()
      const tool = this.requireResolvableTool(toolIdOrContractId)
      const current = this.toolStates.get(tool.descriptor.toolContractId)
        ?? { enabled: false, settingsEnvelope: null, revision: 0, updatedAtMs: 0 }
      if (!current.settingsEnvelope && !this.toolApprovalPolicies.has(tool.descriptor.toolContractId)) return
      const nowMs = this.currentTime()
      const revision = current.revision + 1
      await this.writeToolState({
        profileId: this.session.profileId,
        localNodeId: this.session.localNodeId,
        toolContractId: tool.descriptor.toolContractId,
        descriptorJson: tool.publicDescriptor as unknown as LocalToolStateRecord['descriptorJson'],
        descriptorHash: tool.descriptorHash,
        enabled: current.enabled,
        settingsEnvelope: null,
        revision,
        updatedAtMs: nowMs
      })
      this.toolStates.set(tool.descriptor.toolContractId, {
        enabled: current.enabled,
        settingsEnvelope: null,
        revision,
        updatedAtMs: nowMs
      })
      this.toolApprovalPolicies.delete(tool.descriptor.toolContractId)
      this.publishApprovalPolicies()
    })
  }

  registerTrustedRelationship(selector: PeerRelationshipSelector, peerLabel?: string | null): void {
    const parsed = normalizeSelector(selector)
    const peerId = parsed.claimantPeerId
    const existing = this.trustedRelationships.get(peerId) ?? []
    if (existing.some((item) => selectorEquals(item.selector, parsed))) return
    this.trustedRelationships.set(peerId, [...existing, {
      selector: parsed,
      peerLabel: sanitizeLabel(peerLabel) ?? peerId
    }])
    if (this.loaded) {
      void this.refreshActiveSharing()
        .then(() => {
          this.publishStatus(readyStatus())
          this.publishSnapshot()
        }, (error) => {
          this.publishStatus(statusFromError(error))
        })
    }
  }

  async commitPairingRelationship(
    selector: PeerRelationshipSelector,
    peerLabel: string | null,
    featureIds: readonly string[],
    expiresAtMs: number | null,
    retireRelationships: (selectors: readonly PeerRelationshipSelector[]) => Promise<void>
  ): Promise<void> {
    await this.withWriteLock(async () => {
      this.requireLoaded()
      const parsed = normalizeSelector(selector)
      const selectedTools = this.validateSelectedFeatures(featureIds)
      const peerId = parsed.claimantPeerId
      const previous = (this.trustedRelationships.get(peerId) ?? [])
        .filter((relationship) => !selectorEquals(relationship.selector, parsed))
      await retireRelationships(previous.map((relationship) => ({ ...relationship.selector })))
      let sharing: ActiveSharing
      try {
        sharing = await this.writeSharing(parsed, selectedTools, expiresAtMs)
        let cleanupFailed = false
        for (const relationship of previous) {
          try {
            await this.grantManager.revokeSharing(relationship.selector)
          } catch {
            cleanupFailed = true
          }
        }
        if (cleanupFailed) throw new DurableFeatureSharingError('sharing_unavailable')
      } catch (error) {
        await this.grantManager.revokeSharing(parsed).catch(() => undefined)
        if (error instanceof DurableFeatureSharingError) throw error
        throw new DurableFeatureSharingError('sharing_unavailable')
      }
      this.trustedRelationships.set(peerId, [{
        selector: parsed,
        peerLabel: sanitizeLabel(peerLabel) ?? peerId
      }])
      this.activeSharing.set(peerId, sharing)
      this.publishStatus(readyStatus())
      this.publishSnapshot()
    })
  }

  requiredPermissionsForFeatures(featureIds: readonly string[]): readonly string[] {
    return sortedUnique(
      this.validateSelectedFeatures(featureIds)
        .flatMap((tool) => tool.descriptor.requiredPermissions)
    )
  }

  async rollbackPairingRelationship(selector: PeerRelationshipSelector): Promise<void> {
    await this.withWriteLock(async () => {
      this.requireLoaded()
      const parsed = normalizeSelector(selector)
      try {
        await this.grantManager.revokeSharing(parsed)
      } catch {
        throw new DurableFeatureSharingError('sharing_unavailable')
      }
      const peerId = parsed.claimantPeerId
      const relationships = this.trustedRelationships.get(peerId) ?? []
      const remaining = relationships.filter((relationship) => !selectorEquals(relationship.selector, parsed))
      if (remaining.length === 0) this.trustedRelationships.delete(peerId)
      else this.trustedRelationships.set(peerId, remaining)
      this.activeSharing.delete(peerId)
      if (remaining.length === 1) {
        try {
          const active = (await this.activeGrants(remaining[0]!.selector))[0]
          this.activeSharing.set(peerId, active ? activeSharingFromSummary(active) : { featureIds: [], expiresAtMs: null })
        } catch (error) {
          this.publishStatus(statusFromError(error))
        }
      }
      this.publishSnapshot()
    })
  }

  async load(): Promise<LocalFeatureSharingSnapshot> {
    const tools = this.registeredTools()
    const states = await this.session.localTools.listLocalToolStates()
    this.toolStates.clear()
    this.sourceApprovalPolicies.clear()
    this.toolApprovalPolicies.clear()
    this.approvalPolicyUnavailable = false
    for (const tool of tools) {
      const record = latestToolState(states, this.session.profileId, this.session.localNodeId, tool.descriptor.toolContractId)
      this.toolStates.set(tool.descriptor.toolContractId, record
        ? {
            enabled: record.enabled,
            settingsEnvelope: record.settingsEnvelope,
            revision: record.revision,
            updatedAtMs: record.updatedAtMs
          }
        : { enabled: false, settingsEnvelope: null, revision: 0, updatedAtMs: 0 })
      if (record?.settingsEnvelope) {
        try {
          const policy = await this.decryptToolPolicy(record, tool)
          this.toolApprovalPolicies.set(tool.descriptor.toolContractId, policy)
        } catch {
          this.approvalPolicyUnavailable = true
        }
      }
    }
    for (const record of latestSourcePolicyStates(states, this.session.profileId, this.session.localNodeId)) {
      if (!record.settingsEnvelope) continue
      try {
        const policy = await this.decryptSourcePolicy(record)
        this.sourceApprovalPolicies.set(policy.sourceId, policy)
      } catch {
        this.approvalPolicyUnavailable = true
      }
    }
    await this.rehydrateTrustedRelationships()
    await this.refreshActiveSharing()
    this.loaded = true
    this.publishStatus(readyStatus())
    this.publishApprovalPolicies()
    return this.publishSnapshot()
  }

  async setFeatureEnabled(featureId: string, enabled: boolean): Promise<void> {
    await this.withWriteLock(async () => {
      this.requireLoaded()
      const tool = this.requireTool(featureId)
      const current = this.toolStates.get(tool.descriptor.toolContractId)
        ?? { enabled: false, settingsEnvelope: null, revision: 0, updatedAtMs: 0 }
      const nowMs = this.currentTime()
      const record: LocalToolStateRecord = {
        profileId: this.session.profileId,
        localNodeId: this.session.localNodeId,
        toolContractId: tool.descriptor.toolContractId,
        descriptorJson: tool.publicDescriptor as unknown as LocalToolStateRecord['descriptorJson'],
        descriptorHash: tool.descriptorHash,
        enabled,
        settingsEnvelope: current.settingsEnvelope,
        revision: current.revision + 1,
        updatedAtMs: nowMs
      }
      try {
        await this.session.localTools.upsertLocalToolState(record)
      } catch {
        throw new DurableFeatureSharingError('storage_unavailable')
      }
      this.toolStates.set(tool.descriptor.toolContractId, {
        enabled,
        settingsEnvelope: record.settingsEnvelope,
        revision: record.revision,
        updatedAtMs: nowMs
      })
      this.publishSnapshot()
    })
  }

  async replacePeerSharing(peerId: string, featureIds: readonly string[], expiresAtMs: number | null): Promise<void> {
    await this.withWriteLock(async () => {
      this.requireLoaded()
      const normalizedPeerId = validateId(peerId, 'invalid_peer')
      const selector = this.exactSelectorForPeer(normalizedPeerId)
      const selectedTools = this.validateSelectedFeatures(featureIds)
      this.activeSharing.set(normalizedPeerId, await this.writeSharing(selector, selectedTools, expiresAtMs))
      this.publishSnapshot()
    })
  }

  async revokePeerSharing(peerId: string): Promise<void> {
    await this.withWriteLock(async () => {
      this.requireLoaded()
      const normalizedPeerId = validateId(peerId, 'invalid_peer')
      const selector = this.exactSelectorForPeer(normalizedPeerId)
      try {
        await this.grantManager.revokeSharing(selector)
      } catch {
        throw new DurableFeatureSharingError('sharing_unavailable')
      }
      this.activeSharing.set(normalizedPeerId, { featureIds: [], expiresAtMs: null })
      this.publishSnapshot()
    })
  }

  private async rehydrateTrustedRelationships(): Promise<void> {
    const records = await this.session.peerGrants.listPeerGrants()
    const candidates = candidateSelectors(records, this.session.profileId, this.session.localNodeId, this.localVerifierPeerId, this.roomName, this.currentTime())
    for (const selector of candidates) {
      const active = await this.activeGrants(selector)
      if (active.length > 0) this.registerTrustedRelationship(selector, selector.claimantPeerId)
    }
    this.dropAmbiguousPeers()
  }

  private async refreshActiveSharing(): Promise<void> {
    const next = new Map<string, ActiveSharing>()
    for (const [peerId, relationships] of this.trustedRelationships) {
      if (relationships.length !== 1) continue
      const grants = await this.activeGrants(relationships[0]!.selector)
      const active = grants[0]
      next.set(peerId, active ? activeSharingFromSummary(active) : { featureIds: [], expiresAtMs: null })
    }
    this.activeSharing.clear()
    for (const [peerId, sharing] of next) this.activeSharing.set(peerId, sharing)
  }

  private async activeGrants(selector: PeerRelationshipSelector): Promise<readonly PeerGrantSummary[]> {
    try {
      return await this.grantManager.listActiveGrants(selector)
    } catch {
      throw new DurableFeatureSharingError('sharing_unavailable')
    }
  }

  private async writeSharing(
    selector: PeerRelationshipSelector,
    selectedTools: readonly RegisteredLocalTool[],
    expiresAtMs: number | null
  ): Promise<ActiveSharing> {
    if (selectedTools.length === 0) {
      try {
        await this.grantManager.revokeSharing(selector)
      } catch {
        throw new DurableFeatureSharingError('sharing_unavailable')
      }
      return { featureIds: [], expiresAtMs: null }
    }
    const selection = {
      allowedMethodIds: MESH_NODE_TOOLING_METHOD_IDS,
      allowedToolContractIds: selectedTools.map((tool) => tool.descriptor.toolContractId),
      capabilityPackIds: sortedUnique(selectedTools.flatMap((tool) => tool.descriptor.nativeRequirements.capabilityIds)),
      resourceScopes: sortedUnique(selectedTools.flatMap((tool) => tool.descriptor.resourceScopes)),
      ...(expiresAtMs === null ? {} : { expiresAtMs })
    }
    try {
      return activeSharingFromSummary(await this.grantManager.replaceGrant(selector, selection))
    } catch {
      throw new DurableFeatureSharingError('sharing_unavailable')
    }
  }

  private validateSelectedFeatures(featureIds: readonly string[]): RegisteredLocalTool[] {
    if (!Array.isArray(featureIds) || featureIds.length > 128) throw new DurableFeatureSharingError('invalid_feature')
    const selected = sortedUnique(featureIds.map((featureId) => validateId(featureId, 'invalid_feature')))
    return selected.map((featureId) => {
      const tool = this.requireTool(featureId)
      if (!this.toolStates.get(tool.descriptor.toolContractId)?.enabled) throw new DurableFeatureSharingError('feature_disabled')
      return tool
    })
  }

  private exactSelectorForPeer(peerId: string): PeerRelationshipSelector {
    const relationships = this.trustedRelationships.get(peerId) ?? []
    if (relationships.length === 0) throw new DurableFeatureSharingError('invalid_peer')
    if (relationships.length !== 1) throw new DurableFeatureSharingError('ambiguous_peer')
    return relationships[0]!.selector
  }

  private async writeToolState(record: LocalToolStateRecord): Promise<void> {
    try {
      await this.session.localTools.upsertLocalToolState(record)
    } catch {
      throw new DurableFeatureSharingError('storage_unavailable')
    }
  }

  private async encryptPolicy(
    rowId: string,
    document: Record<string, unknown>
  ): Promise<NonNullable<LocalToolStateRecord['settingsEnvelope']>> {
    if (!this.crypto) throw new DurableFeatureSharingError('storage_unavailable')
    const plaintext = new TextEncoder().encode(JSON.stringify(document))
    if (plaintext.byteLength > LOCAL_TOOL_POLICY_MAX_BYTES) {
      throw new DurableFeatureSharingError('storage_unavailable')
    }
    try {
      return await this.crypto.encrypt(
        'local-structured-data',
        plaintext,
        this.policyAad(rowId)
      )
    } catch {
      throw new DurableFeatureSharingError('storage_unavailable')
    }
  }

  private async decryptToolPolicy(
    record: LocalToolStateRecord,
    tool: RegisteredLocalTool
  ): Promise<StoredToolPolicy> {
    const document = await this.decryptPolicy(record)
    if (document.kind !== 'tool') throw new Error('invalid local tool policy kind')
    const toolContractId = validateId(stringField(document, 'toolContractId'), 'invalid_feature')
    if (toolContractId !== tool.descriptor.toolContractId) throw new Error('local tool policy identity mismatch')
    const revision = safeIntegerField(document, 'revision')
    const updatedAtMs = safeIntegerField(document, 'updatedAtMs')
    if (revision > record.revision || updatedAtMs > record.updatedAtMs) {
      throw new Error('local tool policy revision mismatch')
    }
    return {
      toolContractId,
      globalToolId: exactStringField(document, 'globalToolId', tool.toolInfo.global_tool_id),
      localToolName: exactStringField(document, 'localToolName', tool.descriptor.localName),
      trustTier: validateApprovalTrustTier(stringField(document, 'trustTier')),
      revision,
      updatedAtMs,
      settingsEnvelope: record.settingsEnvelope!
    }
  }

  private async decryptSourcePolicy(record: LocalToolStateRecord): Promise<StoredSourcePolicy> {
    const document = await this.decryptPolicy(record)
    if (document.kind !== 'source') throw new Error('invalid local source policy kind')
    const sourceId = validateId(stringField(document, 'sourceId'), 'invalid_feature')
    const rowId = sourcePolicyRowId(sourceId)
    if (rowId !== record.toolContractId) throw new Error('local source policy identity mismatch')
    return {
      sourceId,
      trustTier: validateApprovalTrustTier(stringField(document, 'trustTier')),
      includeFutureTools: booleanField(document, 'includeFutureTools'),
      knownToolContractIds: optionalIdArrayField(document, 'knownToolContractIds'),
      revision: exactSafeIntegerField(document, 'revision', record.revision),
      updatedAtMs: exactSafeIntegerField(document, 'updatedAtMs', record.updatedAtMs),
      rowId,
      settingsEnvelope: record.settingsEnvelope!
    }
  }

  private async decryptPolicy(record: LocalToolStateRecord): Promise<Record<string, unknown>> {
    if (!this.crypto || !record.settingsEnvelope) throw new Error('local policy crypto unavailable')
    const plaintext = await this.crypto.decrypt(record.settingsEnvelope, this.policyAad(record.toolContractId))
    if (plaintext.byteLength === 0 || plaintext.byteLength > LOCAL_TOOL_POLICY_MAX_BYTES) {
      throw new Error('invalid local policy size')
    }
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown
    if (!isPlainObject(parsed) || parsed.version !== LOCAL_TOOL_POLICY_VERSION) {
      throw new Error('invalid local policy document')
    }
    return parsed
  }

  private policyAad(rowId: string): Uint8Array {
    return buildEnvelopeAad({
      table: 'local_tool_states',
      recordId: `${this.session.profileId}:${this.session.localNodeId}:${rowId}`,
      field: 'settings_envelope_json',
      profileId: this.session.profileId,
      localNodeId: this.session.localNodeId
    })
  }

  private requireLoaded(): void {
    if (!this.loaded) throw new DurableFeatureSharingError('not_loaded')
  }

  private requireTool(featureId: string): RegisteredLocalTool {
    const parsed = validateId(featureId, 'invalid_feature')
    const tool = this.registry.resolvePublicId(parsed)
    if (!tool || tool.descriptor.toolContractId !== parsed) throw new DurableFeatureSharingError('invalid_feature')
    return tool
  }

  private requireResolvableTool(toolIdOrContractId: string): RegisteredLocalTool {
    const parsed = validateId(toolIdOrContractId, 'invalid_feature')
    const tool = this.registry.resolvePublicId(parsed)
    if (!tool) throw new DurableFeatureSharingError('invalid_feature')
    return tool
  }

  private registeredTools(): RegisteredLocalTool[] {
    return this.registry.list()
  }

  private publishSnapshot(): LocalFeatureSharingSnapshot {
    const snapshot = this.snapshot()
    this.lastSnapshot = snapshot
    for (const listener of [...this.listeners]) listener(cloneSnapshot(snapshot))
    return cloneSnapshot(snapshot)
  }

  private publishApprovalPolicies(): LocalToolApprovalPolicySnapshot {
    const snapshot = this.approvalPolicySnapshot()
    this.lastApprovalPolicySnapshot = snapshot
    for (const listener of [...this.approvalPolicyListeners]) {
      listener(cloneApprovalPolicySnapshot(snapshot))
    }
    return cloneApprovalPolicySnapshot(snapshot)
  }

  private publishStatus(status: LocalFeatureSharingStatus): void {
    this.lastStatus = cloneStatus(status)
    publishToStatusListeners(this.statusListeners, status)
  }

  private snapshot(): LocalFeatureSharingSnapshot {
    const enabledToolIds = new Set([...this.toolStates.entries()].filter(([, state]) => state.enabled).map(([id]) => id))
    const features = this.registeredTools().map((tool): LocalDeviceFeature => ({
      id: tool.descriptor.toolContractId,
      label: tool.descriptor.displayName,
      description: tool.descriptor.description,
      serviceId: 'tooling',
      servicePermissionId: 'Tooling.use',
      serviceLabel: 'Tools',
      serviceDescription: 'Use tools this device makes available.',
      enabled: enabledToolIds.has(tool.descriptor.toolContractId),
      available: true,
      requiresAuroraOpen: true,
      requiresLocalConfirmation: tool.descriptor.confirmationPolicy !== 'never',
      permissionNeeded: tool.descriptor.nativeRequirements.osPermissions.length > 0 ? true : undefined,
      safetyClass: tool.descriptor.safetyClass,
      requiredPermissions: [...tool.descriptor.requiredPermissions].sort(),
      nativeCapabilityIds: [...tool.descriptor.nativeRequirements.capabilityIds].sort(),
      nativePermissionIds: [...tool.descriptor.nativeRequirements.osPermissions].sort(),
      resourceScopes: [...tool.descriptor.resourceScopes].sort(),
      descriptorHash: tool.descriptorHash
    })).sort((left, right) => left.id.localeCompare(right.id))
    const approvedDevices = [...this.trustedRelationships.entries()]
      .filter(([, relationships]) => relationships.length === 1)
      .map(([peerId, relationships]): LocalFeaturePeerSharing => {
        const active = this.activeSharing.get(peerId)
        return {
          peerId,
          peerLabel: relationships[0]!.peerLabel,
          featureIds: [...(active?.featureIds ?? [])].filter((featureId) => enabledToolIds.has(featureId)).sort(),
          expiresAtMs: active?.expiresAtMs ?? null
        }
      })
      .sort((left, right) => left.peerLabel.localeCompare(right.peerLabel) || left.peerId.localeCompare(right.peerId))
    return { features, approvedDevices }
  }

  private approvalPolicySnapshot(): LocalToolApprovalPolicySnapshot {
    const sourcePolicies = [...this.sourceApprovalPolicies.values()]
      .map((policy): LocalToolApprovalSourcePolicy => ({
        sourceId: policy.sourceId,
        trustTier: policy.trustTier,
        includeFutureTools: policy.includeFutureTools,
        knownToolContractIds: [...policy.knownToolContractIds],
        revision: policy.revision,
        updatedAtMs: policy.updatedAtMs
      }))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    const toolPolicies = [...this.toolApprovalPolicies.values()]
      .map(({ settingsEnvelope: _settingsEnvelope, ...policy }) => policy)
      .sort((left, right) => left.toolContractId.localeCompare(right.toolContractId))
    const revision = [...sourcePolicies, ...toolPolicies]
      .reduce((current, policy) => Math.max(current, policy.revision), 0)
    return {
      sourcePolicies,
      toolPolicies,
      revision,
      unavailable: this.approvalPolicyUnavailable
    }
  }

  private dropAmbiguousPeers(): void {
    for (const [peerId, relationships] of [...this.trustedRelationships]) {
      const uniqueKeys = new Set(relationships.map((item) => selectorKey(item.selector)))
      if (uniqueKeys.size > 1) this.activeSharing.delete(peerId)
    }
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue
    let release!: () => void
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private currentTime(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) throw new DurableFeatureSharingError('storage_unavailable')
    return value
  }
}

function latestToolState(
  records: readonly LocalToolStateRecord[],
  profileId: string,
  localNodeId: string,
  toolContractId: string
): LocalToolStateRecord | undefined {
  return records
    .filter((record) => record.profileId === profileId && record.localNodeId === localNodeId && record.toolContractId === toolContractId)
    .sort((left, right) => right.revision - left.revision || right.updatedAtMs - left.updatedAtMs)[0]
}

function latestSourcePolicyStates(
  records: readonly LocalToolStateRecord[],
  profileId: string,
  localNodeId: string
): LocalToolStateRecord[] {
  const latest = new Map<string, LocalToolStateRecord>()
  for (const record of records) {
    if (record.profileId !== profileId || record.localNodeId !== localNodeId) continue
    if (!record.toolContractId.startsWith(SOURCE_POLICY_ROW_PREFIX)) continue
    const current = latest.get(record.toolContractId)
    if (!current || record.revision > current.revision || (
      record.revision === current.revision && record.updatedAtMs > current.updatedAtMs
    )) {
      latest.set(record.toolContractId, record)
    }
  }
  return [...latest.values()].sort((left, right) => left.toolContractId.localeCompare(right.toolContractId))
}

function sourcePolicyRowId(sourceId: string): string {
  return `${SOURCE_POLICY_ROW_PREFIX}${canonicalJsonSha256Hex({ sourceId })}`
}

function sourcePolicyDescriptor(sourceId: string): LocalToolStateRecord['descriptorJson'] {
  return {
    kind: 'local_tool_group_policy',
    sourceId,
    version: LOCAL_TOOL_POLICY_VERSION
  }
}

function sourcePolicyDocument(policy: LocalToolApprovalSourcePolicy): Record<string, unknown> {
  return {
    version: LOCAL_TOOL_POLICY_VERSION,
    kind: 'source',
    sourceId: policy.sourceId,
    trustTier: policy.trustTier,
    includeFutureTools: policy.includeFutureTools,
    knownToolContractIds: [...(policy.knownToolContractIds ?? [])],
    revision: policy.revision,
    updatedAtMs: policy.updatedAtMs
  }
}

function toolPolicyDocument(policy: LocalToolApprovalToolPolicy): Record<string, unknown> {
  return {
    version: LOCAL_TOOL_POLICY_VERSION,
    kind: 'tool',
    toolContractId: policy.toolContractId,
    globalToolId: policy.globalToolId,
    localToolName: policy.localToolName,
    trustTier: policy.trustTier,
    revision: policy.revision,
    updatedAtMs: policy.updatedAtMs
  }
}

function localToolApprovalSourceId(entry: Pick<LocalToolDispatchEntry, 'toolInfo'>): string {
  return validateId(
    entry.toolInfo.share_group_id
      || entry.toolInfo.source_id
      || entry.toolInfo.source,
    'invalid_feature'
  )
}

function approvalModeForTrustTier(trustTier: LocalToolApprovalTrustTier | null): LocalToolApprovalMode {
  if (trustTier === 'trusted') return 'approve_all_for_peer'
  if (trustTier === 'untrusted') return 'ask_each_time'
  if (trustTier === 'blocked') return 'deny_all'
  return 'inherit'
}

function trustTierForApprovalMode(
  mode: Exclude<LocalToolApprovalMode, 'inherit'>
): LocalToolApprovalTrustTier {
  if (mode === 'approve_all_for_peer') return 'trusted'
  if (mode === 'ask_each_time') return 'untrusted'
  if (mode === 'deny_all') return 'blocked'
  throw new DurableFeatureSharingError('invalid_feature')
}

function validateApprovalTrustTier(value: unknown): LocalToolApprovalTrustTier {
  if (value === 'trusted' || value === 'untrusted' || value === 'blocked') return value
  throw new DurableFeatureSharingError('invalid_feature')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string') throw new Error(`invalid ${key}`)
  return field
}

function exactStringField(value: Record<string, unknown>, key: string, expected: string): string {
  const field = stringField(value, key)
  if (field !== expected) throw new Error(`invalid ${key}`)
  return field
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const field = value[key]
  if (typeof field !== 'boolean') throw new Error(`invalid ${key}`)
  return field
}

function optionalIdArrayField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key]
  if (field === undefined) return []
  if (!Array.isArray(field) || field.length > 256) throw new Error(`invalid ${key}`)
  return sortedUnique(field.map((item) => {
    if (typeof item !== 'string') throw new Error(`invalid ${key}`)
    return validateId(item, 'invalid_feature')
  }))
}

function exactSafeIntegerField(value: Record<string, unknown>, key: string, expected: number): number {
  const field = safeIntegerField(value, key)
  if (field !== expected) throw new Error(`invalid ${key}`)
  return field
}

function safeIntegerField(value: Record<string, unknown>, key: string): number {
  const field = value[key]
  if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) {
    throw new Error(`invalid ${key}`)
  }
  return field
}

function cloneApprovalPolicySnapshot(
  snapshot: LocalToolApprovalPolicySnapshot
): LocalToolApprovalPolicySnapshot {
  return {
    sourcePolicies: snapshot.sourcePolicies.map((policy) => ({
      ...policy,
      ...(policy.knownToolContractIds
        ? { knownToolContractIds: [...policy.knownToolContractIds] }
        : {})
    })),
    toolPolicies: snapshot.toolPolicies.map((policy) => ({ ...policy })),
    revision: snapshot.revision,
    unavailable: snapshot.unavailable
  }
}

function candidateSelectors(
  records: readonly PeerGrantMetadataRecord[],
  profileId: string,
  localNodeId: string,
  verifierPeerId: string,
  roomName: string,
  nowMs: number
): PeerRelationshipSelector[] {
  const byKey = new Map<string, PeerRelationshipSelector>()
  for (const record of records) {
    if (record.profileId !== profileId || record.localNodeId !== localNodeId) continue
    if (record.revokedAtMs !== null && record.revokedAtMs <= nowMs) continue
    const selector = normalizeSelector({
      tokenId: record.tokenId,
      claimantPeerId: record.claimantPeerId,
      verifierPeerId,
      roomName
    })
    byKey.set(selectorKey(selector), selector)
  }
  return [...byKey.values()].sort((left, right) => selectorKey(left).localeCompare(selectorKey(right)))
}

function activeSharingFromSummary(summary: PeerGrantSummary): ActiveSharing {
  return {
    featureIds: [...summary.allowedToolContractIds].sort(),
    expiresAtMs: summary.expiresAtMs ?? null
  }
}

function normalizeSelector(selector: PeerRelationshipSelector): PeerRelationshipSelector {
  return {
    tokenId: validateId(selector.tokenId, 'invalid_peer'),
    claimantPeerId: validateId(selector.claimantPeerId, 'invalid_peer'),
    verifierPeerId: validateId(selector.verifierPeerId, 'invalid_peer'),
    roomName: validateRoomName(selector.roomName)
  }
}

function validateId<TCode extends DurableFeatureSharingError['code']>(value: string, code: TCode, maxLength = MAX_ID_LENGTH): string {
  if (typeof value !== 'string') throw new DurableFeatureSharingError(code)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maxLength || !SAFE_ID_RE.test(normalized)) {
    throw new DurableFeatureSharingError(code)
  }
  return normalized
}

function validateRoomName(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new DurableFeatureSharingError('invalid_peer')
  }
  return value
}

function selectorKey(selector: PeerRelationshipSelector): string {
  return JSON.stringify([selector.tokenId, selector.claimantPeerId, selector.verifierPeerId, selector.roomName])
}

function selectorEquals(left: PeerRelationshipSelector, right: PeerRelationshipSelector): boolean {
  return left.tokenId === right.tokenId &&
    left.claimantPeerId === right.claimantPeerId &&
    left.verifierPeerId === right.verifierPeerId &&
    left.roomName === right.roomName
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function sanitizeLabel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (normalized.length === 0) return null
  return normalized.length > 120 ? normalized.slice(0, 120) : normalized
}

function cloneSnapshot(snapshot: LocalFeatureSharingSnapshot): LocalFeatureSharingSnapshot {
  return structuredClone(snapshot)
}

function cloneStatus(status: LocalFeatureSharingStatus): LocalFeatureSharingStatus {
  return { ...status }
}

function readyStatus(): LocalFeatureSharingStatus {
  return { ok: true, code: 'ready', message: 'Sharing choices are ready' }
}

function statusFromError(error: unknown): LocalFeatureSharingStatus {
  if (error instanceof DurableFeatureSharingError && error.code === 'sharing_unavailable') {
    return { ok: false, code: 'sharing_unavailable', message: error.message }
  }
  return { ok: false, code: 'sharing_unavailable', message: safeMessage('sharing_unavailable') }
}

function publishToStatusListeners(
  listeners: Set<(status: LocalFeatureSharingStatus) => void>,
  status: LocalFeatureSharingStatus
): void {
  for (const listener of [...listeners]) listener(cloneStatus(status))
}

function safeMessage(code: DurableFeatureSharingError['code']): string {
  switch (code) {
    case 'not_loaded':
      return 'Sharing choices are not ready'
    case 'invalid_feature':
      return 'This feature is unavailable'
    case 'feature_disabled':
      return 'This feature is off on this device'
    case 'invalid_peer':
    case 'ambiguous_peer':
      return 'This device cannot be changed right now'
    case 'sharing_unavailable':
    case 'storage_unavailable':
      return 'Sharing choices are unavailable'
  }
}

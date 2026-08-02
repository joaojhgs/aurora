import type { LocalDataSession, LocalToolStateRecord, PeerGrantMetadataRecord } from '../local-data/index.js'
import type { IssuedPeerBearerCredential, PeerPairingIssueOptions, PeerRelationshipSelector } from '../peer-host/authority.js'
import { PeerGrantManager, type PeerGrantSummary } from '../peer-host/grant-management.js'
import type { ToolingProjectionToolInfo } from '../types.js'
import { MESH_NODE_TOOLING_METHOD_IDS } from './mesh-node-provider.js'
import type { LocalToolExportDecisionPort, LocalToolProjectionContext } from './export-catalog.js'
import type { LocalToolRegistry, RegisteredLocalTool } from './tool-registry.js'

const MAX_ID_LENGTH = 256
const SAFE_ID_RE = /^[A-Za-z0-9_.:@/-]+$/u

export interface LocalDeviceFeature {
  readonly id: string
  readonly label: string
  readonly description: string
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
  readonly now?: () => number
}

interface ToolState {
  readonly enabled: boolean
  readonly revision: number
  readonly updatedAtMs: number
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

export class DurableFeatureSharingController implements LocalFeatureSharingPort, LocalToolExportDecisionPort, TrustedPeerRelationshipRegistry {
  private readonly registry: LocalToolRegistry
  private readonly session: LocalDataSession
  private readonly grantManager: PeerGrantManager
  private readonly localVerifierPeerId: string
  private readonly roomName: string
  private readonly now: () => number
  private readonly listeners = new Set<(snapshot: LocalFeatureSharingSnapshot) => void>()
  private readonly statusListeners = new Set<(status: LocalFeatureSharingStatus) => void>()
  private readonly trustedRelationships = new Map<string, TrustedRelationship[]>()
  private readonly toolStates = new Map<string, ToolState>()
  private readonly activeSharing = new Map<string, ActiveSharing>()
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()
  private lastSnapshot: LocalFeatureSharingSnapshot | null = null
  private lastStatus: LocalFeatureSharingStatus = readyStatus()

  constructor(options: DurableFeatureSharingControllerOptions) {
    this.registry = options.registry
    this.session = options.session
    this.grantManager = options.grantManager
    this.localVerifierPeerId = validateId(options.localVerifierPeerId, 'invalid_peer')
    this.roomName = validateRoomName(options.roomName)
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
    for (const tool of tools) {
      const record = latestToolState(states, this.session.profileId, this.session.localNodeId, tool.descriptor.toolContractId)
      this.toolStates.set(tool.descriptor.toolContractId, record
        ? { enabled: record.enabled, revision: record.revision, updatedAtMs: record.updatedAtMs }
        : { enabled: false, revision: 0, updatedAtMs: 0 })
    }
    await this.rehydrateTrustedRelationships()
    await this.refreshActiveSharing()
    this.loaded = true
    this.publishStatus(readyStatus())
    return this.publishSnapshot()
  }

  async setFeatureEnabled(featureId: string, enabled: boolean): Promise<void> {
    await this.withWriteLock(async () => {
      this.requireLoaded()
      const tool = this.requireTool(featureId)
      const current = this.toolStates.get(tool.descriptor.toolContractId) ?? { enabled: false, revision: 0, updatedAtMs: 0 }
      const nowMs = this.currentTime()
      const record: LocalToolStateRecord = {
        profileId: this.session.profileId,
        localNodeId: this.session.localNodeId,
        toolContractId: tool.descriptor.toolContractId,
        descriptorJson: tool.publicDescriptor as unknown as LocalToolStateRecord['descriptorJson'],
        descriptorHash: tool.descriptorHash,
        enabled,
        settingsEnvelope: null,
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

  private requireLoaded(): void {
    if (!this.loaded) throw new DurableFeatureSharingError('not_loaded')
  }

  private requireTool(featureId: string): RegisteredLocalTool {
    const parsed = validateId(featureId, 'invalid_feature')
    const tool = this.registry.resolvePublicId(parsed)
    if (!tool || tool.descriptor.toolContractId !== parsed) throw new DurableFeatureSharingError('invalid_feature')
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

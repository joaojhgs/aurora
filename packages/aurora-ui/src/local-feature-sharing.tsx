import type { PermissionCatalogEntry } from '@aurora/client'

export interface LocalDeviceFeature {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly enabled: boolean
  readonly available: boolean
  readonly requiresAuroraOpen: boolean
  readonly requiresLocalConfirmation: boolean
  readonly permissionNeeded?: boolean | undefined
  readonly requiredPermissions?: readonly string[] | undefined
  readonly nativeCapabilityIds?: readonly string[] | undefined
  readonly nativePermissionIds?: readonly string[] | undefined
  readonly resourceScopes?: readonly string[] | undefined
  /** Service-level sharing metadata emitted by the peer host that owns this feature. */
  readonly serviceId: string
  readonly servicePermissionId: string
  readonly serviceLabel: string
  readonly serviceDescription: string
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

export interface LocalToolApprovalPolicyPort {
  loadApprovalPolicies(): Promise<LocalToolApprovalPolicySnapshot>
  subscribeApprovalPolicies?(listener: (snapshot: LocalToolApprovalPolicySnapshot) => void): () => void
  setSourceApprovalPolicy(sourceId: string, trustTier: LocalToolApprovalTrustTier, includeFutureTools?: boolean): Promise<void>
  clearSourceApprovalPolicy(sourceId: string): Promise<void>
  setToolApprovalOverride(toolIdOrContractId: string, mode: Exclude<LocalToolApprovalMode, 'inherit'>): Promise<void>
  clearToolApprovalOverride(toolIdOrContractId: string): Promise<void>
}

export interface LocalShareableServiceScope {
  readonly id: string
  readonly permissionId: string
  readonly label: string
  readonly description: string
  readonly featureIds: readonly string[]
}

/**
 * Project the local tool provider as the service it actually exposes to peers.
 * Tool-level choices stay on the Tools page; pairing grants service-level access.
 */
export function localShareableServiceScopes(
  snapshot: LocalFeatureSharingSnapshot,
): LocalShareableServiceScope[] {
  const scopes = new Map<string, LocalShareableServiceScope>()
  for (const feature of snapshot.features) {
    if (!feature.available) continue
    const serviceId = feature.serviceId.trim()
    if (!serviceId) continue
    const existing = scopes.get(serviceId)
    const permissionId = feature.servicePermissionId.trim()
    const label = feature.serviceLabel.trim()
    const description = feature.serviceDescription.trim()
    if (!permissionId || !label || !description) continue
    if (
      existing
      && (
        existing.permissionId !== permissionId
        || existing.label !== label
        || existing.description !== description
      )
    ) continue
    scopes.set(serviceId, {
      id: serviceId,
      permissionId,
      label,
      description,
      featureIds: [...(existing?.featureIds ?? []), feature.id],
    })
  }
  return [...scopes.values()].sort((left, right) => left.label.localeCompare(right.label))
}

export function selectedLocalServicePermissions(
  snapshot: LocalFeatureSharingSnapshot,
  scopes = localShareableServiceScopes(snapshot),
): string[] {
  const enabled = new Set(
    snapshot.features
      .filter((feature) => feature.available && feature.enabled)
      .map((feature) => feature.id),
  )
  return scopes
    .filter((scope) => scope.featureIds.some((featureId) => enabled.has(featureId)))
    .map((scope) => scope.permissionId)
}

export function localFeatureIdsForServicePermissions(
  scopes: readonly LocalShareableServiceScope[],
  permissionIds: readonly string[],
): string[] {
  const selected = new Set(permissionIds)
  return [...new Set(
    scopes
      .filter((scope) => selected.has(scope.permissionId))
      .flatMap((scope) => scope.featureIds),
  )]
}

export function localServicePermissionCatalog(
  scopes: readonly LocalShareableServiceScope[],
): PermissionCatalogEntry[] {
  return scopes.map((scope) => ({
    id: scope.permissionId,
    label: scope.label,
    description: scope.description,
    service: scope.permissionId.split('.', 1)[0] ?? null,
    action: scope.permissionId.includes('.')
      ? scope.permissionId.slice(scope.permissionId.indexOf('.') + 1)
      : null,
    kind: 'method',
    methodType: null,
    exposure: null,
    busTopic: null,
    routePath: null,
    availableOverHttp: false,
    requiredBy: [],
  }))
}

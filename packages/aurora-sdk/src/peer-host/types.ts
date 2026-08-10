import type { z } from 'zod/v4'

import type { CallableFeatureContract, JsonObject } from '../types.js'
import type { AuthenticatedPeerContext, PeerRevocationBroadcaster } from './authority.js'

export type PeerHostMethodType = 'unary' | 'stream' | 'event'
export type PeerHostProjectionMethodType = 'use' | 'manage'
export type PeerHostMethodExposure = 'internal' | 'external' | 'both'

export interface PeerHostIdentity {
  readonly callerPeerId: string
  readonly principalId?: string | null
  readonly effectivePermissions: readonly string[]
  readonly authGrantRevision?: number | null
  readonly manifestRevision?: string | number | null
}

export interface PeerHostCallContext {
  readonly id: string
  readonly methodId: string
  readonly remotePeerId: string
  readonly identity: PeerHostIdentity
  readonly authenticatedPeerContext?: AuthenticatedPeerContext
  readonly signal: AbortSignal
  readonly receivedAtMs: number
  readonly deadlineAtMs: number
}

export interface PeerHostEventEmitOptions {
  readonly correlationId?: string
}

export interface PeerHostEventEmissionContext {
  readonly correlationId?: string
}

export type PeerHostEventEmissionValidator<TEvent = unknown> = (
  event: TEvent,
  context: PeerHostEventEmissionContext
) => void

export interface PeerHostSubscribeContext<TEvent = unknown> {
  readonly id: string
  readonly topic: string
  readonly remotePeerId: string
  readonly authenticatedPeerContext?: AuthenticatedPeerContext
  readonly topics: readonly string[]
  readonly correlationIds: readonly string[]
  readonly ttlSeconds: number
  readonly signal: AbortSignal
  readonly receivedAtMs: number
  emit(event: TEvent, options?: PeerHostEventEmitOptions): Promise<boolean>
}

export interface PeerHostSubscriptionHandle {
  close(reason?: string): void | Promise<void>
}

export interface PeerHostErrorBody {
  readonly code: number
  readonly message: string
  readonly reason_code: string
  readonly error_ref?: string
  readonly schema_id?: string
  readonly boundary?: string
  readonly issues?: readonly { path: string; code: string; message: string }[]
}

export interface PeerHostMethodDescriptor<TInput = unknown, TOutput = unknown> {
  readonly methodId: string
  readonly module?: string
  readonly name?: string
  readonly summary?: string
  readonly busTopic?: string
  readonly exposure?: PeerHostMethodExposure
  readonly methodType: PeerHostMethodType
  readonly projectionMethodType?: PeerHostProjectionMethodType
  readonly inputSchemaId: string
  readonly outputSchemaId: string
  readonly inputModel?: string
  readonly outputModel?: string
  readonly inputSchema: z.ZodType<TInput>
  readonly outputSchema: z.ZodType<TOutput>
  readonly requiredPermissions: readonly string[]
  readonly callableFeatureIds?: readonly string[]
  readonly callableFeatures?: readonly CallableFeatureContract[]
  readonly speechConstraints?: JsonObject | null
  readonly serviceCapabilities?: readonly string[]
  readonly serviceVersion?: string
  readonly maxConcurrent?: number
  readonly maxRequestBytes?: number
  readonly timeoutMs?: number
  readonly handler: (input: TInput, context: PeerHostCallContext) => Promise<TOutput> | TOutput
  readonly streamHandler?: (input: TInput, context: PeerHostCallContext) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
}

export interface PeerHostEventDescriptor<TEvent = unknown> {
  readonly topic: string
  readonly module?: string
  readonly name?: string
  readonly outputSchemaId: string
  readonly outputSchema: z.ZodType<TEvent>
  readonly requiredPermissions: readonly string[]
  readonly maxTtlSeconds?: number
  readonly maxEventBytes?: number
  readonly orderedEventGroup?: string | null
  readonly createEmissionValidator?: () => PeerHostEventEmissionValidator<TEvent>
  readonly handler: (context: PeerHostSubscribeContext<TEvent>) => Promise<PeerHostSubscriptionHandle | void> | PeerHostSubscriptionHandle | void
}

export interface PeerHostAuthorizeRequest {
  readonly remotePeerId: string
  readonly methodId: string
  readonly requiredPermissions: readonly string[]
  readonly identity: PeerHostIdentity
  readonly authenticatedPeerContext?: AuthenticatedPeerContext
  readonly nowMs: number
}

export interface PeerHostAuthorizationDecision {
  readonly allowed: boolean
  readonly reasonCode?: string
  readonly grantRevision?: number
  readonly grantedMethodIds?: readonly string[]
  readonly grantedPermissions?: readonly string[]
}

export interface PeerHostManifestAuthoritySnapshot {
  readonly recipientPeerId?: string
  readonly grantedMethodIds: readonly string[]
  readonly grantedPermissions?: readonly string[]
  readonly authGrantRevision: number
  readonly authGrantState: 'unknown' | 'pending' | 'active' | 'revoked'
}

export interface PeerHostAuthorizationStore {
  authorize(request: PeerHostAuthorizeRequest): Promise<PeerHostAuthorizationDecision>
  snapshotManifestAuthority?(request: {
    readonly remotePeerId?: string
    readonly authenticatedPeerContext?: AuthenticatedPeerContext
    readonly nowMs: number
    readonly correlationId?: string
  }): PeerHostManifestAuthoritySnapshot | Promise<PeerHostManifestAuthoritySnapshot>
}

export interface LocalPeerGrantV1 {
  readonly version: 1
  readonly grantId: string
  readonly tokenId: string
  readonly claimantPeerId: string
  readonly allowedMethodIds: readonly string[]
  readonly allowedToolContractIds: readonly string[]
  readonly capabilityPackIds: readonly string[]
  readonly resourceScopes: readonly string[]
  readonly createdAtMs: number
  readonly expiresAtMs?: number
  readonly revokedAtMs?: number
  readonly grantRevision: number
}

export interface LocalPeerCredentialVerifierV1 {
  readonly version: 1
  readonly tokenId: string
  readonly claimantPeerId: string
  readonly verifierPeerId: string
  readonly roomName: string
  readonly tokenHashHex: string
  readonly createdAtMs: number
  readonly expiresAtMs?: number
  readonly revokedAtMs?: number
  readonly credentialRevision: number
}

export interface PeerHostManifest {
  readonly type: 'manifest'
  readonly peer_id: string
  readonly node_name: string
  readonly aurora_version: string
  readonly shared_services: readonly JsonObject[]
  readonly granted_permissions: null
  readonly active_protocol: 'projection-v1'
  readonly active_version: 'v1'
  readonly active_tier: 'projection'
  readonly supported_protocols: readonly ['legacy-unfiltered-v0', 'projection-v1']
  readonly projection_supported: true
  readonly projection_active: true
  readonly recipient_projection_evidence: JsonObject
  readonly timestamp: string
}

export interface ProviderLeaseRecord {
  readonly type: 'provider_lease' | 'provider_unavailable'
  readonly peer_id: string
  readonly connection_epoch: string
  readonly availability_revision: number
  readonly issued_at_ms: number
  readonly expires_at_ms: number
  readonly available: boolean
  readonly reason_code?: string
}

export interface PeerHostFrameSender {
  sendFrame(frame: Record<string, unknown>, signal?: AbortSignal): Promise<void>
}

export interface PeerHostOptions {
  readonly localPeerId: string
  readonly nodeName: string
  readonly registry: import('./contract-registry.js').PeerHostContractRegistry
  readonly authorizationStore: PeerHostAuthorizationStore
  readonly revocationBroadcaster?: PeerRevocationBroadcaster
  readonly clock?: () => number
  readonly randomId?: () => string
  readonly maxRequestBytes?: number
  readonly defaultTimeoutMs?: number
}

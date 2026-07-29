import { z } from 'zod/v4'

import {
  buildEnvelopeAad,
  type EnvelopeCryptoPort,
  type LocalAuditRepository,
  type JsonValue as LocalDataJsonValue,
  type PeerGrantMetadataRepository
} from '../local-data/index.js'
import { parseLocalDataBoundary } from '../local-data/validation.js'
import type {
  InboundCredentialVerifierStore,
  LocalPeerAuditRecord,
  LocalPeerCredentialVerifierV1,
  LocalPeerGrantV1,
  PeerAuthorityDecision,
  PeerAuthorityDecisionReason,
  PeerAuditSink,
  PeerGrantRepository,
  PeerGrantResolutionRequest,
  PeerRelationshipSelector
} from './authority.js'

const MAX_ID_LENGTH = 256
const MAX_ROOM_LENGTH = 512
const MAX_AUDIT_DETAIL_STRING = 512
const HEX64_RE = /^[0-9a-f]{64}$/u
const LOCAL_DATA_KEY_PURPOSE = 'local-structured-data'

const safeIdSchema = z.string().min(1).max(MAX_ID_LENGTH).regex(/^[A-Za-z0-9_.:@/-]+$/u)
const roomNameSchema = z.string().min(1).max(MAX_ROOM_LENGTH)
const connectionEpochSchema = z.string().min(1).max(MAX_ID_LENGTH)
const epochMsSchema = z.number().int().safe().nonnegative().refine((value) => !Object.is(value, -0))
const selectorSchema = z.object({
  tokenId: safeIdSchema,
  claimantPeerId: safeIdSchema,
  verifierPeerId: safeIdSchema,
  roomName: roomNameSchema
}).strict()
const verifierSchema = selectorSchema.extend({
  version: z.literal(1),
  tokenHashHex: z.string().regex(HEX64_RE),
  createdAtMs: epochMsSchema,
  expiresAtMs: epochMsSchema.optional(),
  revokedAtMs: epochMsSchema.optional(),
  credentialRevision: epochMsSchema
}).strict()
const grantSchema = selectorSchema.extend({
  version: z.literal(1),
  grantId: safeIdSchema,
  allowedMethodIds: z.array(safeIdSchema).max(512),
  allowedToolContractIds: z.array(safeIdSchema).max(512),
  capabilityPackIds: z.array(safeIdSchema).max(512),
  resourceScopes: z.array(z.string().min(1).max(512)).max(512),
  createdAtMs: epochMsSchema,
  expiresAtMs: epochMsSchema.optional(),
  revokedAtMs: epochMsSchema.optional(),
  grantRevision: epochMsSchema
}).strict()

/**
 * Secure storage port for inbound peer verifier records.
 *
 * Implementations must store values in encrypted, OS-protected, or WebCrypto-
 * protected storage. Values are opaque JSON records containing verifier hashes,
 * never bearer tokens. Callers provide exact selector-bound keys and this
 * adapter does not enumerate or derive records from a broader secret store.
 */
export interface InboundVerifierSecretStoragePort {
  getOpaqueSecret(key: string): Promise<string | undefined>
  setOpaqueSecret(key: string, value: string): Promise<void>
  deleteOpaqueSecret(key: string): Promise<void>
}

export interface SecureInboundCredentialVerifierStoreOptions {
  readonly storage: InboundVerifierSecretStoragePort
  readonly keyPrefix?: string
}

export interface EncryptedPeerGrantRepositoryOptions {
  readonly metadataRepository: PeerGrantMetadataRepository
  readonly crypto: EnvelopeCryptoPort
  readonly profileId: string
  readonly localNodeId: string
}

export interface LocalDataPeerAuditSinkOptions {
  readonly auditRepository: LocalAuditRepository
  readonly profileId: string
  readonly localNodeId: string
  readonly randomId?: () => string
}

export class SecureInboundCredentialVerifierStore implements InboundCredentialVerifierStore {
  private readonly storage: InboundVerifierSecretStoragePort
  private readonly keyPrefix: string

  constructor(options: SecureInboundCredentialVerifierStoreOptions) {
    this.storage = options.storage
    this.keyPrefix = options.keyPrefix ?? 'aurora.peer-host.inbound-verifier.v1'
  }

  async getVerifier(selector: PeerRelationshipSelector, nowMs = Date.now()): Promise<LocalPeerCredentialVerifierV1 | undefined> {
    const verifier = await this.readVerifier(selector)
    if (verifier === undefined) return undefined
    if (verifier.expiresAtMs !== undefined && verifier.expiresAtMs <= nowMs) return undefined
    if (verifier.revokedAtMs !== undefined && verifier.revokedAtMs <= nowMs) return undefined
    return cloneVerifier(verifier)
  }

  async upsertVerifier(verifier: LocalPeerCredentialVerifierV1): Promise<void> {
    const parsed = parseVerifier(verifier)
    const existing = await this.readVerifier(selectorFrom(parsed))
    if (existing !== undefined && parsed.credentialRevision <= existing.credentialRevision) return
    await this.storage.setOpaqueSecret(this.keyFor(selectorFrom(parsed)), JSON.stringify(parsed))
  }

  async revokeVerifier(selector: PeerRelationshipSelector, revokedAtMs: number): Promise<LocalPeerCredentialVerifierV1 | undefined> {
    parseSelector(selector)
    assertEpochMs(revokedAtMs, 'revokedAtMs')
    const verifier = await this.readVerifier(selector)
    if (verifier === undefined) return undefined
    const revoked = parseVerifier({
      ...verifier,
      revokedAtMs,
      credentialRevision: verifier.credentialRevision + 1
    })
    await this.storage.setOpaqueSecret(this.keyFor(selector), JSON.stringify(revoked))
    return cloneVerifier(revoked)
  }

  async deleteVerifier(selector: PeerRelationshipSelector): Promise<void> {
    parseSelector(selector)
    await this.storage.deleteOpaqueSecret(this.keyFor(selector))
  }

  private async readVerifier(selector: PeerRelationshipSelector): Promise<LocalPeerCredentialVerifierV1 | undefined> {
    parseSelector(selector)
    const raw = await this.storage.getOpaqueSecret(this.keyFor(selector))
    if (raw === undefined) return undefined
    try {
      const parsed = parseVerifier(JSON.parse(raw))
      return selectorEquals(parsed, selector) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  private keyFor(selector: PeerRelationshipSelector): string {
    const parsed = parseSelector(selector)
    return [
      this.keyPrefix,
      encodeKeyPart(parsed.verifierPeerId),
      encodeKeyPart(parsed.claimantPeerId),
      encodeKeyPart(parsed.roomName),
      encodeKeyPart(parsed.tokenId)
    ].join(':')
  }
}

export class EncryptedPeerGrantRepository implements PeerGrantRepository {
  private readonly metadataRepository: PeerGrantMetadataRepository
  private readonly crypto: EnvelopeCryptoPort
  private readonly profileId: string
  private readonly localNodeId: string

  constructor(options: EncryptedPeerGrantRepositoryOptions) {
    this.metadataRepository = options.metadataRepository
    this.crypto = options.crypto
    this.profileId = parseStorageIdentity(options.profileId, 'profileId')
    this.localNodeId = parseStorageIdentity(options.localNodeId, 'localNodeId')
  }

  async upsertGrant(grant: LocalPeerGrantV1): Promise<void> {
    const parsed = parseGrant(grant)
    const existing = await this.readGrantMetadata(parsed.grantId)
    if (existing !== undefined && parsed.grantRevision <= existing.revision) return
    const envelope = await this.crypto.encrypt(
      LOCAL_DATA_KEY_PURPOSE,
      encodeJson(parsed),
      this.aadForGrant(parsed.grantId)
    )
    await this.metadataRepository.upsertPeerGrant({
      grantId: parsed.grantId,
      profileId: this.profileId,
      localNodeId: this.localNodeId,
      claimantPeerId: parsed.claimantPeerId,
      tokenId: parsed.tokenId,
      scopeEnvelope: envelope,
      revision: parsed.grantRevision,
      createdAtMs: parsed.createdAtMs,
      expiresAtMs: parsed.expiresAtMs ?? null,
      revokedAtMs: parsed.revokedAtMs ?? null
    })
  }

  async resolveGrant(request: PeerGrantResolutionRequest): Promise<PeerAuthorityDecision> {
    parseSelector(request.selector)
    assertEpochMs(request.nowMs, 'nowMs')
    const result = await this.readMatchingGrants(request.selector)
    if (result.unreadable) return { allowed: false, reasonCode: 'grant_store_unreadable' }
    const candidates = result.grants.sort(compareGrants)
    let blockedReason: PeerAuthorityDecisionReason = 'grant_not_found'
    for (const grant of candidates) {
      if (grant.revokedAtMs !== undefined && grant.revokedAtMs <= request.nowMs) {
        blockedReason = 'grant_revoked'
        continue
      }
      if (grant.expiresAtMs !== undefined && grant.expiresAtMs <= request.nowMs) {
        blockedReason = 'grant_expired'
        continue
      }
      const reason = grantCoverageFailure(grant, request)
      if (reason === undefined) return { allowed: true, grant: cloneGrant(grant) }
      blockedReason = reason
    }
    return { allowed: false, reasonCode: blockedReason }
  }

  async listRecipientGrants(selector: PeerRelationshipSelector, nowMs: number): Promise<readonly LocalPeerGrantV1[]> {
    parseSelector(selector)
    assertEpochMs(nowMs, 'nowMs')
    const result = await this.readMatchingGrants(selector)
    if (result.unreadable) return []
    return result.grants
      .filter((grant) => (grant.revokedAtMs === undefined || grant.revokedAtMs > nowMs) && (grant.expiresAtMs === undefined || grant.expiresAtMs > nowMs))
      .sort(compareGrants)
      .map(cloneGrant)
  }

  async revokeGrants(selector: PeerRelationshipSelector, revokedAtMs: number): Promise<readonly LocalPeerGrantV1[]> {
    parseSelector(selector)
    assertEpochMs(revokedAtMs, 'revokedAtMs')
    const revoked: LocalPeerGrantV1[] = []
    const result = await this.readMatchingGrants(selector)
    for (const grant of result.grants) {
      const next = parseGrant({
        ...grant,
        revokedAtMs,
        grantRevision: grant.grantRevision + 1
      })
      await this.upsertGrant(next)
      revoked.push(cloneGrant(next))
    }
    return revoked.sort(compareGrants)
  }

  private async readMatchingGrants(selector: PeerRelationshipSelector): Promise<{ grants: LocalPeerGrantV1[]; unreadable: boolean }> {
    const records = await this.metadataRepository.listPeerGrants()
    const grants: LocalPeerGrantV1[] = []
    let unreadable = false
    for (const record of records) {
      if (record.profileId !== this.profileId || record.localNodeId !== this.localNodeId) continue
      if (record.claimantPeerId !== selector.claimantPeerId || record.tokenId !== selector.tokenId) continue
      try {
        const plaintext = await this.crypto.decrypt(record.scopeEnvelope, this.aadForGrant(record.grantId))
        const grant = parseGrant(decodeJson(plaintext))
        if (grant.grantId !== record.grantId) continue
        if (grant.claimantPeerId !== record.claimantPeerId || grant.tokenId !== record.tokenId) continue
        if (!selectorEquals(grant, selector)) continue
        grants.push(grant)
      } catch {
        unreadable = true
      }
    }
    return { grants, unreadable }
  }

  private async readGrantMetadata(grantId: string) {
    for (const record of await this.metadataRepository.listPeerGrants()) {
      if (record.profileId === this.profileId && record.localNodeId === this.localNodeId && record.grantId === grantId) return record
    }
    return undefined
  }

  private aadForGrant(grantId: string): Uint8Array {
    return buildEnvelopeAad({
      table: 'peer_grant_metadata',
      recordId: grantId,
      field: 'scope_envelope_json',
      profileId: this.profileId,
      localNodeId: this.localNodeId
    })
  }
}

export class LocalDataPeerAuditSink implements PeerAuditSink {
  private readonly auditRepository: LocalAuditRepository
  private readonly profileId: string
  private readonly localNodeId: string
  private readonly randomId: () => string

  constructor(options: LocalDataPeerAuditSinkOptions) {
    this.auditRepository = options.auditRepository
    this.profileId = parseStorageIdentity(options.profileId, 'profileId')
    this.localNodeId = parseStorageIdentity(options.localNodeId, 'localNodeId')
    this.randomId = options.randomId ?? defaultAuditId
  }

  async record(record: LocalPeerAuditRecord): Promise<void> {
    const selector = parseSelector(record.selector)
    await this.auditRepository.appendAudit({
      id: parseStorageIdentity(this.randomId(), 'auditId'),
      profileId: this.profileId,
      localNodeId: this.localNodeId,
      peerId: selector.claimantPeerId,
      action: parseStorageIdentity(record.action, 'action'),
      decision: parseStorageIdentity(record.decision, 'decision'),
      resultStatus: record.decision === 'accepted' || record.decision === 'issued' ? 'complete' : record.decision,
      connectionEpoch: optionalConnectionEpoch(record.connectionEpoch),
      methodId: optionalBounded(record.methodId),
      toolContractId: optionalBounded(record.toolContractId),
      correlationId: optionalBounded(record.correlationId),
      redactedDetailJson: redactedAuditDetails(record),
      createdAtMs: record.createdAtMs
    })
  }
}

export function inboundVerifierSecretKey(selector: PeerRelationshipSelector, keyPrefix = 'aurora.peer-host.inbound-verifier.v1'): string {
  const parsed = parseSelector(selector)
  return [
    keyPrefix,
    encodeKeyPart(parsed.verifierPeerId),
    encodeKeyPart(parsed.claimantPeerId),
    encodeKeyPart(parsed.roomName),
    encodeKeyPart(parsed.tokenId)
  ].join(':')
}

function parseSelector(value: unknown): PeerRelationshipSelector {
  return parseLocalDataBoundary(selectorSchema, value, 'peer_authority.selector')
}

function parseVerifier(value: unknown): LocalPeerCredentialVerifierV1 {
  const parsed = parseLocalDataBoundary(verifierSchema, value, 'peer_authority.verifier')
  return {
    version: parsed.version,
    tokenId: parsed.tokenId,
    claimantPeerId: parsed.claimantPeerId,
    verifierPeerId: parsed.verifierPeerId,
    roomName: parsed.roomName,
    tokenHashHex: parsed.tokenHashHex,
    createdAtMs: parsed.createdAtMs,
    ...(parsed.expiresAtMs !== undefined ? { expiresAtMs: parsed.expiresAtMs } : {}),
    ...(parsed.revokedAtMs !== undefined ? { revokedAtMs: parsed.revokedAtMs } : {}),
    credentialRevision: parsed.credentialRevision
  }
}

function parseGrant(value: unknown): LocalPeerGrantV1 {
  const parsed = parseLocalDataBoundary(grantSchema, value, 'peer_authority.grant')
  return {
    version: parsed.version,
    grantId: parsed.grantId,
    tokenId: parsed.tokenId,
    claimantPeerId: parsed.claimantPeerId,
    verifierPeerId: parsed.verifierPeerId,
    roomName: parsed.roomName,
    allowedMethodIds: parsed.allowedMethodIds,
    allowedToolContractIds: parsed.allowedToolContractIds,
    capabilityPackIds: parsed.capabilityPackIds,
    resourceScopes: parsed.resourceScopes,
    createdAtMs: parsed.createdAtMs,
    ...(parsed.expiresAtMs !== undefined ? { expiresAtMs: parsed.expiresAtMs } : {}),
    ...(parsed.revokedAtMs !== undefined ? { revokedAtMs: parsed.revokedAtMs } : {}),
    grantRevision: parsed.grantRevision
  }
}

function parseStorageIdentity(value: string, field: string): string {
  return parseLocalDataBoundary(safeIdSchema, value, `peer_authority.${field.toLowerCase()}`)
}

function assertEpochMs(value: number, field: string): void {
  parseLocalDataBoundary(epochMsSchema, value, `peer_authority.${field.toLowerCase()}`)
}

function selectorEquals(left: PeerRelationshipSelector, right: PeerRelationshipSelector): boolean {
  return left.tokenId === right.tokenId &&
    left.claimantPeerId === right.claimantPeerId &&
    left.verifierPeerId === right.verifierPeerId &&
    left.roomName === right.roomName
}

function selectorFrom(value: PeerRelationshipSelector): PeerRelationshipSelector {
  return {
    tokenId: value.tokenId,
    claimantPeerId: value.claimantPeerId,
    verifierPeerId: value.verifierPeerId,
    roomName: value.roomName
  }
}

function grantCoverageFailure(grant: LocalPeerGrantV1, request: PeerGrantResolutionRequest): PeerAuthorityDecisionReason | undefined {
  if (request.methodId !== undefined && !grant.allowedMethodIds.includes(request.methodId)) return 'method_not_granted'
  if (request.toolContractId !== undefined && !grant.allowedToolContractIds.includes(request.toolContractId)) return 'tool_not_granted'
  if (request.capabilityPackId !== undefined && !grant.capabilityPackIds.includes(request.capabilityPackId)) return 'capability_not_granted'
  if (request.resourceScope !== undefined && !grant.resourceScopes.includes(request.resourceScope)) return 'resource_not_granted'
  return undefined
}

function compareGrants(left: LocalPeerGrantV1, right: LocalPeerGrantV1): number {
  return right.grantRevision - left.grantRevision ||
    right.createdAtMs - left.createdAtMs ||
    left.grantId.localeCompare(right.grantId)
}

function cloneVerifier(verifier: LocalPeerCredentialVerifierV1): LocalPeerCredentialVerifierV1 {
  return { ...verifier }
}

function cloneGrant(grant: LocalPeerGrantV1): LocalPeerGrantV1 {
  return {
    ...grant,
    allowedMethodIds: [...grant.allowedMethodIds],
    allowedToolContractIds: [...grant.allowedToolContractIds],
    capabilityPackIds: [...grant.capabilityPackIds],
    resourceScopes: [...grant.resourceScopes]
  }
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function decodeJson(value: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(value))
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value).replace(/\./gu, '%2E')
}

function optionalBounded(value: string | undefined): string | null {
  if (value === undefined) return null
  return value.slice(0, MAX_ID_LENGTH)
}

function optionalConnectionEpoch(value: string | undefined): string | null {
  if (value === undefined) return null
  return parseLocalDataBoundary(connectionEpochSchema, value, 'peer_authority.connectionepoch')
}

function redactedAuditDetails(record: LocalPeerAuditRecord): Record<string, LocalDataJsonValue> {
  const details: Record<string, LocalDataJsonValue> = {
    redacted: true,
    secretsRedacted: true,
    redactedFields: ['sensitivePeerAuthorityMaterial']
  }
  if (record.reasonCode !== undefined) details.reasonCode = boundedJsonString(record.reasonCode)
  if (record.authorityState !== undefined) details.authorityState = boundedJsonString(record.authorityState)
  if (record.capabilityPackId !== undefined) details.capabilityPackId = boundedJsonString(record.capabilityPackId)
  if (record.resourceScope !== undefined) details.resourceScope = boundedJsonString(record.resourceScope)
  return scrubForbiddenAuditDetails(details)
}

function boundedJsonString(value: string): LocalDataJsonValue {
  return value.slice(0, MAX_AUDIT_DETAIL_STRING)
}

function scrubForbiddenAuditDetails(details: Record<string, LocalDataJsonValue>): Record<string, LocalDataJsonValue> {
  const text = JSON.stringify(details).toLowerCase()
  if (text.includes('bearer') || text.includes('tokenhashhex') || text.includes('proofhex') || text.includes('verifierkey')) {
    return { redacted: true, secretsRedacted: true, redactedFields: ['sensitivePeerAuthorityMaterial'] }
  }
  return details
}

function defaultAuditId(): string {
  return `peer-audit-${Date.now()}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
}

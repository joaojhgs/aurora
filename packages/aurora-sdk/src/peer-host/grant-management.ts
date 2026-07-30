import type {
  LocalPeerGrantV1,
  PeerGrantRepository,
  PeerRelationshipSelector
} from './authority.js'

const MAX_IDENTIFIER_LENGTH = 256
const MAX_RESOURCE_SCOPE_LENGTH = 512
const MAX_SELECTION_ITEMS = 128
const DEFAULT_MAX_EXPIRY_WINDOW_MS = 366 * 24 * 60 * 60 * 1000
const SAFE_ID_RE = /^[A-Za-z0-9_.:@/-]+$/u
const FORBIDDEN_SECRET_RE = /bearer|proof|token|tokenhash|verifier|credential|password|secret|private[-_]?key/iu
const FORBIDDEN_EXECUTION_RE = /\b(sql|sqlite|select|insert|update|delete|drop|alter|pragma|shell|process|spawn|exec|chmod|chown|sudo|bash|sh|powershell|cmd)\b/iu

export type PeerGrantManagementErrorCode =
  | 'invalid_selector'
  | 'invalid_selection'
  | 'invalid_expiry'
  | 'repository_unavailable'
  | 'secure_random_unavailable'

export interface PeerGrantSelection {
  readonly allowedMethodIds?: readonly string[]
  readonly allowedToolContractIds?: readonly string[]
  readonly capabilityPackIds?: readonly string[]
  readonly resourceScopes?: readonly string[]
  readonly expiresAtMs?: number
}

export interface PeerGrantSummary {
  readonly grantId: string
  readonly claimantPeerId: string
  readonly verifierPeerId: string
  readonly roomName: string
  readonly allowedMethodIds: readonly string[]
  readonly allowedToolContractIds: readonly string[]
  readonly capabilityPackIds: readonly string[]
  readonly resourceScopes: readonly string[]
  readonly createdAtMs: number
  readonly expiresAtMs?: number
  readonly revokedAtMs?: number
  readonly grantRevision: number
  readonly sharingState: 'active' | 'expired' | 'revoked'
  readonly secretFieldsRedacted: true
  readonly redactedFields: readonly string[]
}

export interface PeerGrantManagerOptions {
  readonly repository: PeerGrantRepository
  readonly now?: () => number
  readonly randomId?: () => string
  readonly maxFutureExpiryMs?: number
}

export class PeerGrantManagementError extends Error {
  readonly code: PeerGrantManagementErrorCode

  constructor(code: PeerGrantManagementErrorCode, message: string) {
    super(message)
    this.name = 'PeerGrantManagementError'
    this.code = code
  }
}

export class PeerGrantManager {
  private readonly repository: PeerGrantRepository
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly usesDefaultRandomId: boolean
  private readonly maxFutureExpiryMs: number
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: PeerGrantManagerOptions) {
    this.repository = options.repository
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? defaultGrantId
    this.usesDefaultRandomId = options.randomId === undefined
    this.maxFutureExpiryMs = options.maxFutureExpiryMs ?? DEFAULT_MAX_EXPIRY_WINDOW_MS
  }

  async listActiveGrants(selector: PeerRelationshipSelector): Promise<readonly PeerGrantSummary[]> {
    const parsedSelector = validateSelector(selector)
    const nowMs = this.currentTime()
    try {
      const grants = await this.repository.listRecipientGrants(parsedSelector, nowMs)
      return grants
        .filter((grant) => isActive(grant, nowMs))
        .sort(compareGrants)
        .map((grant) => summarizeGrant(grant, nowMs))
    } catch {
      throw new PeerGrantManagementError('repository_unavailable', 'Sharing settings are unavailable')
    }
  }

  async replaceGrant(selector: PeerRelationshipSelector, selection: PeerGrantSelection): Promise<PeerGrantSummary> {
    return await this.withWriteLock(async () => {
      const parsedSelector = validateSelector(selector)
      const nowMs = this.currentTime()
      const normalized = normalizeSelection(selection, nowMs, this.maxFutureExpiryMs)
      const defaultGrantIdForCreate = this.usesDefaultRandomId ? validateGrantId(this.randomId()) : undefined
      let existing: readonly LocalPeerGrantV1[]
      try {
        existing = await this.repository.listRecipientGrants(parsedSelector, nowMs)
      } catch {
        throw new PeerGrantManagementError('repository_unavailable', 'Sharing settings are unavailable')
      }

      const activeExisting = existing.filter((grant) => isActive(grant, nowMs)).sort(compareGrants)
      let revoked: readonly LocalPeerGrantV1[] = []
      if (activeExisting.length > 0) {
        try {
          revoked = await this.repository.revokeGrants(parsedSelector, nowMs)
        } catch {
          throw new PeerGrantManagementError('repository_unavailable', 'Sharing settings are unavailable')
        }
      }

      const nextRevision = Math.max(0, ...existing.map((grant) => grant.grantRevision), ...revoked.map((grant) => grant.grantRevision)) + 1
      const grant: LocalPeerGrantV1 = {
        version: 1,
        ...parsedSelector,
        grantId: activeExisting[0]?.grantId ?? defaultGrantIdForCreate ?? validateGrantId(this.randomId()),
        allowedMethodIds: normalized.allowedMethodIds,
        allowedToolContractIds: normalized.allowedToolContractIds,
        capabilityPackIds: normalized.capabilityPackIds,
        resourceScopes: normalized.resourceScopes,
        createdAtMs: nowMs,
        ...(normalized.expiresAtMs !== undefined ? { expiresAtMs: normalized.expiresAtMs } : {}),
        grantRevision: nextRevision
      }
      try {
        await this.repository.upsertGrant(grant)
      } catch {
        throw new PeerGrantManagementError('repository_unavailable', 'Sharing settings are unavailable')
      }
      return summarizeGrant(grant, nowMs)
    })
  }

  async revokeSharing(selector: PeerRelationshipSelector): Promise<readonly PeerGrantSummary[]> {
    return await this.withWriteLock(async () => {
      const parsedSelector = validateSelector(selector)
      const nowMs = this.currentTime()
      try {
        const active = await this.repository.listRecipientGrants(parsedSelector, nowMs)
        if (active.length === 0) return []
        const revoked = await this.repository.revokeGrants(parsedSelector, nowMs)
        return [...revoked].sort(compareGrants).map((grant) => summarizeGrant(grant, nowMs))
      } catch {
        throw new PeerGrantManagementError('repository_unavailable', 'Sharing settings are unavailable')
      }
    })
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
    if (!Number.isSafeInteger(value) || value < 0) throw new PeerGrantManagementError('invalid_expiry', 'Sharing time is invalid')
    return value
  }
}

function normalizeSelection(selection: PeerGrantSelection, nowMs: number, maxFutureExpiryMs: number): Required<Omit<PeerGrantSelection, 'expiresAtMs'>> & { expiresAtMs?: number } {
  const normalized = {
    allowedMethodIds: normalizeIdentifiers(selection.allowedMethodIds ?? [], 'method'),
    allowedToolContractIds: normalizeIdentifiers(selection.allowedToolContractIds ?? [], 'tool'),
    capabilityPackIds: normalizeIdentifiers(selection.capabilityPackIds ?? [], 'capability'),
    resourceScopes: normalizeResourceScopes(selection.resourceScopes ?? [])
  }
  const selectionSize = normalized.allowedMethodIds.length +
    normalized.allowedToolContractIds.length +
    normalized.capabilityPackIds.length +
    normalized.resourceScopes.length
  if (selectionSize === 0) {
    throw new PeerGrantManagementError('invalid_selection', 'Choose at least one item to share')
  }
  if (selection.expiresAtMs === undefined) return normalized
  if (!Number.isSafeInteger(selection.expiresAtMs) || selection.expiresAtMs <= nowMs || selection.expiresAtMs > nowMs + maxFutureExpiryMs) {
    throw new PeerGrantManagementError('invalid_expiry', 'Sharing expiry is invalid')
  }
  return { ...normalized, expiresAtMs: selection.expiresAtMs }
}

function normalizeIdentifiers(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values) || values.length > MAX_SELECTION_ITEMS) {
    throw new PeerGrantManagementError('invalid_selection', `Too many ${field} selections`)
  }
  const normalized = values.map((value) => normalizeIdentifier(value, field, MAX_IDENTIFIER_LENGTH))
  return [...new Set(normalized)].sort()
}

function normalizeResourceScopes(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > MAX_SELECTION_ITEMS) {
    throw new PeerGrantManagementError('invalid_selection', 'Too many resource selections')
  }
  const normalized = values.map((value) => normalizeIdentifier(value, 'resource', MAX_RESOURCE_SCOPE_LENGTH))
  return [...new Set(normalized)].sort()
}

function normalizeIdentifier(value: string, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new PeerGrantManagementError('invalid_selection', `Invalid ${field} selection`)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maxLength) throw new PeerGrantManagementError('invalid_selection', `Invalid ${field} selection`)
  if (normalized === '*' || normalized.includes('..') || normalized.startsWith('/') || normalized.startsWith('~') || normalized.includes('\\')) {
    throw new PeerGrantManagementError('invalid_selection', `Invalid ${field} selection`)
  }
  if (!SAFE_ID_RE.test(normalized)) throw new PeerGrantManagementError('invalid_selection', `Invalid ${field} selection`)
  if (FORBIDDEN_SECRET_RE.test(normalized) || FORBIDDEN_EXECUTION_RE.test(normalized)) {
    throw new PeerGrantManagementError('invalid_selection', `Invalid ${field} selection`)
  }
  return normalized
}

function validateSelector(selector: PeerRelationshipSelector): PeerRelationshipSelector {
  return {
    tokenId: validateSelectorPart(selector.tokenId, 'selector'),
    claimantPeerId: validateSelectorPart(selector.claimantPeerId, 'selector'),
    verifierPeerId: validateSelectorPart(selector.verifierPeerId, 'selector'),
    roomName: validateSelectorPart(selector.roomName, 'selector', MAX_RESOURCE_SCOPE_LENGTH)
  }
}

function validateSelectorPart(value: string, field: string, maxLength = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new PeerGrantManagementError('invalid_selector', `Invalid ${field}`)
  }
  return value
}

function validateGrantId(value: string): string {
  return normalizeIdentifier(value, 'grant', MAX_IDENTIFIER_LENGTH)
}

function summarizeGrant(grant: LocalPeerGrantV1, nowMs: number): PeerGrantSummary {
  return {
    grantId: grant.grantId,
    claimantPeerId: grant.claimantPeerId,
    verifierPeerId: grant.verifierPeerId,
    roomName: grant.roomName,
    allowedMethodIds: [...grant.allowedMethodIds].sort(),
    allowedToolContractIds: [...grant.allowedToolContractIds].sort(),
    capabilityPackIds: [...grant.capabilityPackIds].sort(),
    resourceScopes: [...grant.resourceScopes].sort(),
    createdAtMs: grant.createdAtMs,
    ...(grant.expiresAtMs !== undefined ? { expiresAtMs: grant.expiresAtMs } : {}),
    ...(grant.revokedAtMs !== undefined ? { revokedAtMs: grant.revokedAtMs } : {}),
    grantRevision: grant.grantRevision,
    sharingState: sharingState(grant, nowMs),
    secretFieldsRedacted: true,
    redactedFields: ['sensitivePeerAuthorityMaterial']
  }
}

function sharingState(grant: LocalPeerGrantV1, nowMs: number): PeerGrantSummary['sharingState'] {
  if (grant.revokedAtMs !== undefined && grant.revokedAtMs <= nowMs) return 'revoked'
  if (grant.expiresAtMs !== undefined && grant.expiresAtMs <= nowMs) return 'expired'
  return 'active'
}

function isActive(grant: LocalPeerGrantV1, nowMs: number): boolean {
  return sharingState(grant, nowMs) === 'active'
}

function compareGrants(left: LocalPeerGrantV1, right: LocalPeerGrantV1): number {
  return right.grantRevision - left.grantRevision ||
    right.createdAtMs - left.createdAtMs ||
    left.grantId.localeCompare(right.grantId)
}

function defaultGrantId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `grant-${globalThis.crypto.randomUUID()}`
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)
    return `grant-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }
  throw new PeerGrantManagementError('secure_random_unavailable', 'Sharing cannot start without secure random IDs')
}

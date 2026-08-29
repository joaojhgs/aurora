import type { TauriInvoke } from '../tauri.js'

import type {
  PeerHostAuthorizationDecision,
  PeerHostAuthorizationStore,
  PeerHostAuthorizeRequest,
  PeerHostManifestAuthoritySnapshot
} from './types.js'
import type {
  AuthenticatedPeerContext,
  GrantDimensions,
  InboundCredentialVerifierStore,
  IssuedPeerBearerCredential,
  PeerAuditSink,
  IssueReconnectChallengeRequest,
  LocalPeerCredentialVerifierV1,
  LocalPeerGrantV1,
  PeerAuthorityDecision,
  PeerAuthorityResolverPort,
  PeerGrantManagerPort,
  PeerGrantRepository,
  PeerGrantSelection,
  PeerGrantSummary,
  PeerPairingIssueOptions,
  PeerPairingIssuerPort,
  LocalPeerAuditRecord,
  PeerRelationshipSelector,
  PeerRevocationController,
  PeerRevocationEvent,
  ReconnectChallengeRecord,
  VerifyReconnectProofRequest,
  VerifyReconnectProofResult
} from './authority-types.js'

/**
 * The `PeerHostAuthorizationStore` backed by the Rust mesh authority.
 *
 * Workstream R2 moves grants, permission evaluation, execution policy and the
 * denial paths into `rust/crates/aurora-mesh-authority`. This is the seam the
 * TypeScript side asks through afterwards: the same interface
 * (`peer-host/types.ts`) the peer host already calls, dispatching to Tauri IPC
 * on a native shell and to WebAssembly on the web.
 *
 * Runtime is chosen by **platform, never by lifecycle** — see the R0 boundary
 * note, section 1. A native shell uses the Rust authority in foreground and
 * background alike; it does not fall back to a TypeScript implementation when
 * the webview is frozen, because after R2 there is no TypeScript implementation
 * to fall back to. Two authorities is drift in the one layer where drift is a
 * vulnerability.
 *
 * Decisions cross this seam; storage does not. The durable adapters in
 * `local-data-authority-adapters.ts` stay TypeScript and *hydrate* the authority
 * at session start through {@link RustPeerHostAuthorizationStore.hydrate}.
 */

/**
 * Refuses everything.
 *
 * Not an authority implementation — the *absence* of one. It exists so a
 * composition that has no authority wired fails closed instead of failing open,
 * and it decides nothing: there is no grant to consult and no state to hold.
 */
export class DenyAllPeerHostAuthorizationStore implements PeerHostAuthorizationStore {
  async authorize(): Promise<PeerHostAuthorizationDecision> {
    return { allowed: false, reasonCode: 'authorization_store_unavailable' }
  }
}

/** What the authority needs replayed into it before it can answer. */
export interface RustAuthorityHydration {
  readonly verifiers: readonly LocalPeerCredentialVerifierV1[]
  readonly grants: readonly LocalPeerGrantV1[]
}

/**
 * Projects a decision's granted tool contracts into product permission labels.
 *
 * The mapping needs the local tool registry, which is TypeScript data the
 * authority has no business holding — so the authority reports what is granted
 * and this projects the labels. It reads the decision; it never widens it.
 */
export type GrantedPermissionsProjection = (grantedToolContractIds: readonly string[]) => readonly string[]

/**
 * Loads one relationship's durable rows so the authority can answer about it.
 *
 * The durable adapters are keyed per relationship, and so is the authority, so
 * hydration is lazy: the rows for a peer are replayed the first time a question
 * is asked about that peer, not eagerly for every peer the device has ever
 * paired with.
 */
export type RustAuthorityHydrationLoader = (
  selector: PeerRelationshipSelector
) => Promise<RustAuthorityHydration>

/** Payload-free signal emitted when drained authority audit rows are lost. */
export interface RustAuthorityAuditFailure {
  readonly code: 'authority_audit_drain_failed' | 'authority_audit_persist_failed'
  readonly droppedRecordCount?: number
}

export type RustAuthorityAuditFailureReporter = (failure: RustAuthorityAuditFailure) => void

/** Durable rows that must move with one authority revocation. */
export interface RustAuthorityRevocationPersistence {
  readonly verifierStore: InboundCredentialVerifierStore
  readonly grantRepository: PeerGrantRepository
}

/** The subset of the Rust authority this store dispatches to. */
export interface RustAuthorityPort {
  hydrate(hydration: RustAuthorityHydration): Promise<void>
  resolveGrant(
    context: AuthenticatedPeerContext,
    dimensions: GrantDimensions & { readonly nowMs: number }
  ): Promise<PeerAuthorityDecision>
  issueReconnectChallenge(
    request: IssueReconnectChallengeRequest
  ): Promise<ReconnectChallengeRecord>
  verifyReconnectProof(request: VerifyReconnectProofRequest): Promise<VerifyReconnectProofResult>
  issuePairingCredential(
    selector: PeerRelationshipSelector,
    options: PeerPairingIssueOptions,
    nowMs: number
  ): Promise<IssuedPeerBearerCredential>
  rollbackPairingCredential(selector: PeerRelationshipSelector): Promise<void>
  listActiveGrants(
    selector: PeerRelationshipSelector,
    nowMs: number
  ): Promise<readonly PeerGrantSummary[]>
  replaceGrant(
    selector: PeerRelationshipSelector,
    selection: PeerGrantSelection,
    nowMs: number
  ): Promise<PeerGrantSummary>
  revokeSharing(
    selector: PeerRelationshipSelector,
    nowMs: number
  ): Promise<readonly PeerGrantSummary[]>
  revokePeerAuthority(
    selector: PeerRelationshipSelector,
    reasonCode: string,
    revokedAtMs: number
  ): Promise<PeerRevocationEvent>
  authorize(request: PeerHostAuthorizeRequest): Promise<PeerHostAuthorizationDecision>
  snapshotManifestAuthority(request: {
    readonly remotePeerId?: string
    readonly authenticatedPeerContext?: AuthenticatedPeerContext
    readonly nowMs: number
    readonly correlationId?: string
  }): Promise<PeerHostManifestAuthoritySnapshot>
  drainAuditRecords(): Promise<readonly LocalPeerAuditRecord[]>
  exportGrants(selector: PeerRelationshipSelector): Promise<readonly LocalPeerGrantV1[]>
}

/** Tauri command names. Typed constants, never literals at a call site. */
export const MESH_AUTHORITY_COMMANDS = Object.freeze({
  hydrate: 'aurora_mesh_authority_hydrate',
  authorize: 'aurora_mesh_authority_authorize',
  snapshotManifest: 'aurora_mesh_authority_snapshot_manifest',
  issueReconnectChallenge: 'aurora_mesh_authority_issue_reconnect_challenge',
  verifyReconnectProof: 'aurora_mesh_authority_verify_reconnect_proof',
  listActiveGrants: 'aurora_mesh_authority_list_active_grants',
  replaceGrant: 'aurora_mesh_authority_replace_grant',
  revokePeerAuthority: 'aurora_mesh_authority_revoke_peer_authority',
  resolveGrant: 'aurora_mesh_authority_resolve_grant',
  issuePairingCredential: 'aurora_mesh_authority_issue_pairing_credential',
  rollbackPairingCredential: 'aurora_mesh_authority_rollback_pairing_credential',
  revokeSharing: 'aurora_mesh_authority_revoke_sharing',
  drainAudit: 'aurora_mesh_authority_drain_audit',
  exportGrants: 'aurora_mesh_authority_export_grants'
} as const)

/** Dispatch to the native authority over Tauri IPC. */
export function createTauriAuthorityPort(invoke: TauriInvoke): RustAuthorityPort {
  return {
    async hydrate(hydration) {
      await invoke(MESH_AUTHORITY_COMMANDS.hydrate, {
        request: { verifiers: [...hydration.verifiers], grants: [...hydration.grants] }
      })
    },
    async authorize(request) {
      return (await invoke(MESH_AUTHORITY_COMMANDS.authorize, {
        request
      })) as PeerHostAuthorizationDecision
    },
    async snapshotManifestAuthority(request) {
      return (await invoke(MESH_AUTHORITY_COMMANDS.snapshotManifest, {
        request
      })) as PeerHostManifestAuthoritySnapshot
    },
    async resolveGrant(context, dimensions) {
      const { nowMs, ...rest } = dimensions
      return (await invoke(MESH_AUTHORITY_COMMANDS.resolveGrant, {
        context,
        dimensions: rest,
        nowMs
      })) as PeerAuthorityDecision
    },
    async issueReconnectChallenge(request) {
      return (await invoke(
        MESH_AUTHORITY_COMMANDS.issueReconnectChallenge,
        { request }
      )) as ReconnectChallengeRecord
    },
    async verifyReconnectProof(request) {
      return (await invoke(MESH_AUTHORITY_COMMANDS.verifyReconnectProof, {
        request
      })) as VerifyReconnectProofResult
    },
    async issuePairingCredential(selector, options, nowMs) {
      return (await invoke(MESH_AUTHORITY_COMMANDS.issuePairingCredential, {
        selector,
        expiresAtMs: options.expiresAtMs ?? null,
        nowMs
      })) as IssuedPeerBearerCredential
    },
    async rollbackPairingCredential(selector) {
      await invoke(MESH_AUTHORITY_COMMANDS.rollbackPairingCredential, { selector })
    },
    async listActiveGrants(selector, nowMs) {
      return (await invoke(MESH_AUTHORITY_COMMANDS.listActiveGrants, {
        selector,
        nowMs
      })) as readonly PeerGrantSummary[]
    },
    async replaceGrant(selector, selection, nowMs) {
      return (await invoke(MESH_AUTHORITY_COMMANDS.replaceGrant, {
        selector,
        selection,
        nowMs
      })) as PeerGrantSummary
    },
    async revokeSharing(selector, nowMs) {
      return (await invoke(MESH_AUTHORITY_COMMANDS.revokeSharing, {
        selector,
        nowMs
      })) as readonly PeerGrantSummary[]
    },
    async revokePeerAuthority(selector, reasonCode, revokedAtMs) {
      return (await invoke(MESH_AUTHORITY_COMMANDS.revokePeerAuthority, {
        selector,
        reasonCode,
        revokedAtMs
      })) as PeerRevocationEvent
    },
    async drainAuditRecords() {
      return (await invoke(MESH_AUTHORITY_COMMANDS.drainAudit)) as readonly LocalPeerAuditRecord[]
    },
    async exportGrants(selector) {
      return (await invoke(MESH_AUTHORITY_COMMANDS.exportGrants, {
        selector
      })) as readonly LocalPeerGrantV1[]
    }
  }
}

/**
 * The WebAssembly authority, as `@aurora/mesh-authority-web` exposes it.
 *
 * Structural rather than an import so the SDK does not take a hard dependency
 * on the web package; the web shell supplies the instance it already loaded.
 */
export interface WasmAuthorityLike {
  hydrate(
    verifiers: readonly LocalPeerCredentialVerifierV1[],
    grants: readonly LocalPeerGrantV1[]
  ): Promise<void>
  authorize(request: PeerHostAuthorizeRequest): Promise<PeerHostAuthorizationDecision>
  snapshotManifestAuthority(request: {
    readonly remotePeerId?: string
    readonly authenticatedPeerContext?: AuthenticatedPeerContext
    readonly nowMs: number
    readonly correlationId?: string
  }): Promise<PeerHostManifestAuthoritySnapshot>
  resolveGrant(
    context: AuthenticatedPeerContext,
    dimensions: GrantDimensions,
    nowMs: number
  ): Promise<PeerAuthorityDecision>
  issueReconnectChallenge(request: IssueReconnectChallengeRequest): Promise<ReconnectChallengeRecord>
  verifyReconnectProof(request: VerifyReconnectProofRequest): Promise<VerifyReconnectProofResult>
  issuePairingCredential(
    selector: PeerRelationshipSelector,
    expiresAtMs: number | undefined,
    nowMs: number
  ): Promise<IssuedPeerBearerCredential>
  rollbackPairingCredential(selector: PeerRelationshipSelector): Promise<void>
  listActiveGrants(
    selector: PeerRelationshipSelector,
    nowMs: number
  ): Promise<readonly PeerGrantSummary[]>
  replaceGrant(
    selector: PeerRelationshipSelector,
    selection: PeerGrantSelection,
    nowMs: number,
    grantId: string
  ): Promise<PeerGrantSummary>
  revokeSharing(
    selector: PeerRelationshipSelector,
    nowMs: number
  ): Promise<readonly PeerGrantSummary[]>
  revokePeerAuthority(
    selector: PeerRelationshipSelector,
    reasonCode: string,
    revokedAtMs: number
  ): Promise<PeerRevocationEvent>
  drainAuditRecords(): Promise<readonly LocalPeerAuditRecord[]> | readonly LocalPeerAuditRecord[]
  exportGrants(
    selector: PeerRelationshipSelector
  ): Promise<readonly LocalPeerGrantV1[]> | readonly LocalPeerGrantV1[]
}

/**
 * Dispatch to the WebAssembly authority.
 *
 * `newGrantId` supplies the identifier a fresh grant is minted under. The
 * authority refuses to invent one — a grant id must come from a secure source
 * the platform owns, which is the same rule the TypeScript implementation
 * followed when it reached for `globalThis.crypto`.
 */
export function createWasmAuthorityPort(
  authority: WasmAuthorityLike,
  newGrantId: () => string = defaultGrantId
): RustAuthorityPort {
  return {
    async hydrate(hydration) {
      await authority.hydrate(hydration.verifiers, hydration.grants)
    },
    async authorize(request) {
      return await authority.authorize(request)
    },
    async snapshotManifestAuthority(request) {
      return await authority.snapshotManifestAuthority(request)
    },
    async resolveGrant(context, dimensions) {
      const { nowMs, ...rest } = dimensions
      return await authority.resolveGrant(context, rest, nowMs)
    },
    async issueReconnectChallenge(request) {
      return await authority.issueReconnectChallenge(request)
    },
    async verifyReconnectProof(request) {
      return await authority.verifyReconnectProof(request)
    },
    async issuePairingCredential(selector, options, nowMs) {
      return await authority.issuePairingCredential(selector, options.expiresAtMs, nowMs)
    },
    async rollbackPairingCredential(selector) {
      await authority.rollbackPairingCredential(selector)
    },
    async listActiveGrants(selector, nowMs) {
      return await authority.listActiveGrants(selector, nowMs)
    },
    async replaceGrant(selector, selection, nowMs) {
      return await authority.replaceGrant(selector, selection, nowMs, newGrantId())
    },
    async revokeSharing(selector, nowMs) {
      return await authority.revokeSharing(selector, nowMs)
    },
    async revokePeerAuthority(selector, reasonCode, revokedAtMs) {
      return await authority.revokePeerAuthority(selector, reasonCode, revokedAtMs)
    },
    async drainAuditRecords() {
      return authority.drainAuditRecords()
    },
    async exportGrants(selector) {
      return authority.exportGrants(selector)
    }
  }
}

function defaultGrantId(): string {
  const crypto = globalThis.crypto
  if (typeof crypto?.randomUUID === 'function') return `grant-${crypto.randomUUID()}`
  if (typeof crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return `grant-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }
  throw new Error('Sharing cannot start without secure random IDs')
}

/**
 * Asks the Rust authority every permission question.
 *
 * Holds no grant and evaluates no permission of its own — it is a transport for
 * the question and the answer, which is what keeps the authority a single
 * implementation.
 */
export class RustPeerHostAuthorizationStore implements PeerHostAuthorizationStore {
  private readonly hydrationByRelationship = new Map<string, Promise<void>>()

  constructor(
    private readonly port: RustAuthorityPort,
    private readonly projectPermissions?: GrantedPermissionsProjection,
    private readonly loadHydration?: RustAuthorityHydrationLoader,
    private readonly auditSink?: PeerAuditSink,
    private readonly reportAuditFailure?: RustAuthorityAuditFailureReporter
  ) {}

  /**
   * Move the authority's audit rows into durable storage.
   *
   * The authority records who asked for what and what it answered; the durable
   * store is TypeScript's, so the rows are drained across the seam after each
   * question. A storage failure must not turn a denial into an allow, so it is
   * swallowed here and the decision stands on its own.
   */
  private async drainAudit(): Promise<void> {
    if (this.auditSink === undefined) return
    let records: readonly LocalPeerAuditRecord[]
    try {
      records = await this.port.drainAuditRecords()
    } catch {
      this.reportAuditLoss({ code: 'authority_audit_drain_failed' })
      return
    }
    for (const [index, record] of records.entries()) {
      try {
        await this.auditSink.record(record)
      } catch {
        this.reportAuditLoss({
          code: 'authority_audit_persist_failed',
          droppedRecordCount: records.length - index
        })
        return
      }
    }
  }

  private reportAuditLoss(failure: RustAuthorityAuditFailure): void {
    try {
      this.reportAuditFailure?.(failure)
    } catch {
      // Reporting an audit loss must not change the authority's decision.
    }
  }

  /**
   * Replay a relationship's durable rows the first time it is asked about.
   *
   * A failure here is deliberately not swallowed into an allow: the caller sees
   * the error and the authority answers nothing rather than answering blind.
   */
  private async ensureHydrated(selector?: PeerRelationshipSelector): Promise<void> {
    const loadHydration = this.loadHydration
    if (loadHydration === undefined || selector === undefined) return
    const key = JSON.stringify([
      selector.tokenId,
      selector.claimantPeerId,
      selector.verifierPeerId,
      selector.roomName
    ])
    const existing = this.hydrationByRelationship.get(key)
    if (existing !== undefined) {
      await existing
      return
    }

    const hydration = (async () => {
      await this.port.hydrate(await loadHydration(selector))
    })()
    this.hydrationByRelationship.set(key, hydration)
    try {
      await hydration
    } catch (error) {
      if (this.hydrationByRelationship.get(key) === hydration) {
        this.hydrationByRelationship.delete(key)
      }
      throw error
    }
  }

  /** Replay durable verifiers and grants into the authority at session start. */
  async hydrate(hydration: RustAuthorityHydration): Promise<void> {
    await this.port.hydrate(hydration)
  }

  async authorize(request: PeerHostAuthorizeRequest): Promise<PeerHostAuthorizationDecision> {
    await this.ensureHydrated(request.authenticatedPeerContext?.selector)
    const decision = await this.port.authorize(request)
    await this.drainAudit()
    if (this.projectPermissions === undefined || decision.grantedToolContractIds === undefined) {
      return decision
    }
    return {
      ...decision,
      grantedPermissions: this.projectPermissions(decision.grantedToolContractIds)
    }
  }

  async snapshotManifestAuthority(request: {
    readonly remotePeerId?: string
    readonly authenticatedPeerContext?: AuthenticatedPeerContext
    readonly nowMs: number
    readonly correlationId?: string
  }): Promise<PeerHostManifestAuthoritySnapshot> {
    await this.ensureHydrated(request.authenticatedPeerContext?.selector)
    const snapshot = await this.port.snapshotManifestAuthority(request)
    await this.drainAudit()
    return snapshot
  }

  /** The resolver seam, answered by the same authority. */
  asResolverPort(): PeerAuthorityResolverPort {
    return {
      issueReconnectChallenge: async (request) =>
        await this.port.issueReconnectChallenge(request),
      verifyReconnectProof: async (request) => {
        await this.ensureHydrated(request.selector)
        return await this.port.verifyReconnectProof(request)
      },
      resolveGrant: async (context, request) => {
        await this.ensureHydrated(context.selector)
        return await this.port.resolveGrant(context, request)
      }
    }
  }

  /**
   * The pairing issuer seam, answered by the same authority.
   *
   * The authority owns credential generation, while `persist` owns the durable
   * verifier row needed to authenticate the claimant after this process is
   * recreated. The bearer token is not returned until that verifier is durable.
   */
  asPairingIssuerPort(
    persist: InboundCredentialVerifierStore,
    now: () => number = Date.now
  ): PeerPairingIssuerPort {
    return {
      issue: async (selector, options = {}) => {
        const issued = await this.port.issuePairingCredential(selector, options, now())
        try {
          await persist.upsertVerifier(issued.verifier)
          return issued
        } catch (error) {
          // A credential whose verifier is not durable must never escape. Both
          // cleanup paths are attempted because a storage operation may fail
          // after partially completing.
          await Promise.allSettled([
            this.port.rollbackPairingCredential(selector),
            persist.deleteVerifier(selector)
          ])
          throw error
        }
      },
      rollback: async (selector) => {
        const results = await Promise.allSettled([
          this.port.rollbackPairingCredential(selector),
          persist.deleteVerifier(selector)
        ])
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        )
        if (failed !== undefined) throw failed.reason
      }
    }
  }

  /**
   * The revocation seam, answered by the same authority.
   *
   * The decision is Rust's; `hub` only delivers the resulting event to live
   * subscribers so an in-flight request can be cancelled.
   */
  asRevocationControllerPort(
    hub: { publish(event: PeerRevocationEvent): Promise<void> },
    persist: RustAuthorityRevocationPersistence,
    now: () => number = Date.now
  ): PeerRevocationController {
    return {
      revoke: async (selector, reasonCode = 'peer_authority_revoked', revokedAtMs = now()) => {
        await this.ensureHydrated(selector)
        const event = await this.port.revokePeerAuthority(selector, reasonCode, revokedAtMs)
        // Publish only after every durable authority row has been withdrawn.
        // The live Rust authority is already fail-closed if persistence fails,
        // and the rejection prevents callers from claiming success. The
        // verifier tombstone is the restart-safety boundary. Persist it before
        // touching grants: if later cleanup fails, the old grants are
        // unreachable because the relationship can no longer authenticate.
        await persist.verifierStore.revokeVerifier(selector, event.revokedAtMs)
        await persist.grantRepository.revokeGrants(selector, event.revokedAtMs)
        await hub.publish(event)
        return event
      }
    }
  }

  /**
   * The sharing-settings seam, answered by the same authority.
   *
   * `persist` writes the authority's resulting grant rows back to durable
   * storage. Without it a sharing change would survive only until the process
   * ends, because the authority holds its rows in memory by design — durable
   * storage stayed TypeScript's, so the write-back has to happen here.
   */
  asGrantManagerPort(
    now: () => number = Date.now,
    persist?: PeerGrantRepository
  ): PeerGrantManagerPort {
    const writeBack = async (selector: PeerRelationshipSelector): Promise<void> => {
      if (persist === undefined) return
      for (const grant of await this.port.exportGrants(selector)) {
        await persist.upsertGrant(grant)
      }
    }
    return {
      listActiveGrants: async (selector) => {
        await this.ensureHydrated(selector)
        return await this.port.listActiveGrants(selector, now())
      },
      replaceGrant: async (selector, selection) => {
        await this.ensureHydrated(selector)
        const summary = await this.port.replaceGrant(selector, selection, now())
        await writeBack(selector)
        return summary
      },
      revokeSharing: async (selector) => {
        await this.ensureHydrated(selector)
        const summaries = await this.port.revokeSharing(selector, now())
        await writeBack(selector)
        return summaries
      }
    }
  }
}

/**
 * Read a relationship's durable rows out of the storage adapters.
 *
 * This is the whole of what `local-data-authority-adapters.ts` does after R2:
 * it stores and it reads back. It decides nothing.
 */
export function createDurableHydrationLoader(options: {
  readonly verifierStore: InboundCredentialVerifierStore
  readonly grantRepository: PeerGrantRepository
  readonly now?: () => number
}): RustAuthorityHydrationLoader {
  const now = options.now ?? Date.now
  return async (selector) => {
    const nowMs = now()
    const verifier = await options.verifierStore.getVerifier(selector, nowMs)
    const grants = await options.grantRepository.listRecipientGrants(selector, nowMs)
    return {
      verifiers: verifier === undefined ? [] : [verifier],
      grants: [...grants]
    }
  }
}

/**
 * WebAssembly host boundary for the Aurora mesh peer authority.
 *
 * The web half of workstream R2. The authority itself is Rust
 * (`rust/crates/aurora-mesh-authority`); this package loads its `wasm-bindgen`
 * bindings and presents them as the `PeerHostAuthorizationStore` seam the peer
 * host already asks through, so the calling code changes its construction and
 * nothing else.
 *
 * Per the R0 boundary note (`docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md`, section
 * 1) this is the *authority store* and not a session registry: it is keyed by
 * peer identity, holds no transport state, and never learns which connection a
 * peer arrived on.
 *
 * Decisions cross this boundary; storage does not. TypeScript hydrates the
 * authority at session start from the durable adapters it already owns, and the
 * same Rust core answers every permission question on native through Tauri IPC.
 * There is no third implementation.
 */

/** The four-part key a peer relationship is stored under. */
export interface PeerRelationshipSelector {
  readonly tokenId: string
  readonly claimantPeerId: string
  readonly verifierPeerId: string
  readonly roomName: string
}

/** A peer relationship without its credential identity. */
export interface PeerRelationshipIdentity {
  readonly claimantPeerId: string
  readonly verifierPeerId: string
  readonly roomName: string
}

/** What a reconnect proof is bound to on the wire. */
export interface ReconnectTransportAttestation {
  readonly channelBinding: string
  readonly claimantSignalingPeerId: string
  readonly verifierSignalingPeerId: string
}

/** The result of a successful reconnect proof: who this peer is, proven. */
export interface AuthenticatedPeerContext {
  readonly selector: PeerRelationshipSelector
  readonly transport: ReconnectTransportAttestation
  readonly connectionEpoch?: string
  readonly credentialRevision: number
  readonly authenticatedAtMs: number
}

/** One durable authorization grant. */
export interface LocalPeerGrantV1 {
  readonly version: 1
  readonly grantId: string
  readonly tokenId: string
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
}

/** The stored half of a bearer credential. */
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

/** Who a call claims to be. */
export interface PeerHostIdentity {
  readonly callerPeerId: string
  readonly principalId?: string | null
  readonly effectivePermissions: readonly string[]
  readonly authGrantRevision?: number | null
  readonly manifestRevision?: string | number | null
}

/** The question the peer host asks on every inbound call. */
export interface PeerHostAuthorizeRequest {
  readonly remotePeerId: string
  readonly methodId: string
  readonly requiredPermissions: readonly string[]
  readonly identity: PeerHostIdentity
  readonly authenticatedPeerContext?: AuthenticatedPeerContext
  readonly nowMs: number
}

/** The authority's answer. */
export interface PeerHostAuthorizationDecision {
  readonly allowed: boolean
  readonly reasonCode?: string
  readonly grantRevision?: number
  readonly grantedMethodIds?: readonly string[]
  readonly grantedPermissions?: readonly string[]
}

/** What the peer host asks for when it composes a manifest. */
export interface PeerHostManifestAuthorityRequest {
  readonly remotePeerId?: string
  readonly authenticatedPeerContext?: AuthenticatedPeerContext
  readonly nowMs: number
  readonly correlationId?: string
}

/** What the manifest advertises about a recipient's authority. */
export interface PeerHostManifestAuthoritySnapshot {
  readonly recipientPeerId?: string
  readonly grantedMethodIds: readonly string[]
  readonly grantedPermissions?: readonly string[]
  readonly authGrantRevision: number
  readonly authGrantState: 'unknown' | 'pending' | 'active' | 'revoked'
}

/** What a person chose to share. */
export interface PeerGrantSelection {
  readonly allowedMethodIds?: readonly string[]
  readonly allowedToolContractIds?: readonly string[]
  readonly capabilityPackIds?: readonly string[]
  readonly resourceScopes?: readonly string[]
  readonly expiresAtMs?: number
}

/** One issued reconnect challenge. */
export interface ReconnectChallengeRecord {
  readonly challenge: string
  readonly identity: PeerRelationshipIdentity
  readonly transport: ReconnectTransportAttestation
  readonly issuedAtMs: number
  readonly expiresAtMs: number
  readonly consumedAtMs?: number
  readonly rejectedAtMs?: number
}

/** Outcome of a reconnect proof check. */
export interface VerifyReconnectProofResult {
  readonly ok: boolean
  readonly context?: AuthenticatedPeerContext
  readonly reasonCode?: string
}

interface MeshAuthorityBindings {
  hydrateVerifier(verifier: unknown): Promise<void>
  hydrateGrant(grant: unknown): Promise<void>
  issueReconnectChallenge(request: unknown): Promise<unknown>
  verifyReconnectProof(request: unknown): Promise<unknown>
  resolveGrant(context: unknown, dimensions: unknown, nowMs: number): Promise<unknown>
  issuePairingCredential(
    selector: unknown,
    expiresAtMs: number | undefined,
    nowMs: number
  ): Promise<unknown>
  rollbackPairingCredential(selector: unknown): Promise<void>
  authorize(request: unknown): Promise<unknown>
  snapshotManifestAuthority(request: unknown): Promise<unknown>
  listActiveGrants(selector: unknown, nowMs: number): Promise<unknown>
  replaceGrant(selector: unknown, selection: unknown, nowMs: number, grantId: string): Promise<unknown>
  exportGrants(selector: unknown): unknown
  revokeSharing(selector: unknown, nowMs: number): Promise<unknown>
  revokePeerAuthority(selector: unknown, reasonCode: string, revokedAtMs: number): Promise<unknown>
  describeMethod(methodId: string): unknown
  describeEvent(topic: string): unknown
  validateTtsAudioChunk(subscriptionId: string, event: unknown, correlationId?: string): void
  closeTtsSubscription(subscriptionId: string): void
  drainAuditRecords(): unknown
  free(): void
}

interface MeshAuthorityModule {
  default: (options?: { module_or_path: BufferSource }) => Promise<unknown>
  MeshAuthority: new () => MeshAuthorityBindings
}

/**
 * Where the `wasm-bindgen` bindings come from.
 *
 * Injectable because a browser and a test harness reach them differently: a
 * browser lets the generated loader fetch its own `.wasm` beside the JS, while a
 * Node test has to hand over bytes it read from disk. Keeping this a parameter
 * is what lets `src/` stay free of Node built-ins — this is a web package.
 */
export interface MeshAuthorityWasmSource {
  /** Import the generated `wasm-bindgen` JS module. */
  readonly importBindings: () => Promise<unknown>
  /** Supply the `.wasm` bytes, or omit to let the loader fetch them itself. */
  readonly wasmBytes?: () => Promise<BufferSource>
}

const browserWasmSource: MeshAuthorityWasmSource = {
  // Resolved against this module's own URL rather than written as a literal
  // specifier: the bindings are generated by `scripts/build-wasm.mjs` and are
  // not present at source typecheck time. The build output keeps the relative
  // import so bundlers can statically include the generated loader and its
  // sibling `.wasm`.
  importBindings: async () =>
    // @ts-expect-error generated into dist/wasm before package build
    await import('./wasm/aurora_mesh_authority.js')
}

let modulePromise: Promise<MeshAuthorityModule> | undefined

/**
 * Load the authority's WebAssembly bindings once per process.
 *
 * Idempotent: repeated calls share one instantiation, because the generated
 * module is a singleton and re-initialising it would reset every authority
 * built on top of it.
 */
export async function loadMeshAuthorityModule(
  source: MeshAuthorityWasmSource = browserWasmSource
): Promise<MeshAuthorityModule> {
  if (modulePromise === undefined) {
    modulePromise = (async () => {
      const bindings = (await source.importBindings()) as MeshAuthorityModule
      if (source.wasmBytes === undefined) {
        await bindings.default()
      } else {
        await bindings.default({ module_or_path: await source.wasmBytes() })
      }
      return bindings
    })()
  }
  return await modulePromise
}

/**
 * The mesh authority, as the web build sees it.
 *
 * Satisfies the shape of `PeerHostAuthorizationStore` from
 * `packages/aurora-sdk/src/peer-host/types.ts`, which is the interface the R0
 * boundary note promises W1 and R3 they may ask through.
 */
export class WasmPeerHostAuthorizationStore {
  private constructor(private readonly authority: MeshAuthorityBindings) {}

  /** Load the bindings and construct an empty authority. */
  static async create(
    source?: MeshAuthorityWasmSource
  ): Promise<WasmPeerHostAuthorizationStore> {
    const module = await loadMeshAuthorityModule(source)
    return new WasmPeerHostAuthorizationStore(new module.MeshAuthority())
  }

  /** Load durable credential verifiers and grants at session start. */
  async hydrate(
    verifiers: readonly LocalPeerCredentialVerifierV1[],
    grants: readonly LocalPeerGrantV1[]
  ): Promise<void> {
    for (const verifier of verifiers) await this.authority.hydrateVerifier(verifier)
    for (const grant of grants) await this.authority.hydrateGrant(grant)
  }

  /** May this peer call this method right now? */
  async authorize(request: PeerHostAuthorizeRequest): Promise<PeerHostAuthorizationDecision> {
    return (await this.authority.authorize(request)) as PeerHostAuthorizationDecision
  }

  /** What does this peer's manifest advertise about its authority? */
  async snapshotManifestAuthority(
    request: PeerHostManifestAuthorityRequest
  ): Promise<PeerHostManifestAuthoritySnapshot> {
    return (await this.authority.snapshotManifestAuthority(
      request
    )) as PeerHostManifestAuthoritySnapshot
  }

  /** Mint a single-use reconnect challenge. */
  async issueReconnectChallenge(request: {
    readonly identity: PeerRelationshipIdentity
    readonly transport: ReconnectTransportAttestation
    readonly nowMs: number
  }): Promise<ReconnectChallengeRecord> {
    return (await this.authority.issueReconnectChallenge(request)) as ReconnectChallengeRecord
  }

  /** Check a reconnect proof and, on success, mint the authenticated context. */
  async verifyReconnectProof(request: {
    readonly proofHex: string
    readonly selector: PeerRelationshipSelector
    readonly transport: ReconnectTransportAttestation
    readonly challenge: string
    readonly nowMs: number
  }): Promise<VerifyReconnectProofResult> {
    return (await this.authority.verifyReconnectProof(request)) as VerifyReconnectProofResult
  }

  /** Evaluate a grant across method, tool, capability-pack, and resource dimensions. */
  async resolveGrant(
    context: AuthenticatedPeerContext,
    dimensions: Readonly<Record<string, string | undefined>>,
    nowMs: number
  ): Promise<unknown> {
    return await this.authority.resolveGrant(context, dimensions, nowMs)
  }

  /** Mint the claimant half of a pairing credential inside the Rust authority. */
  async issuePairingCredential(
    selector: PeerRelationshipSelector,
    expiresAtMs: number | undefined,
    nowMs: number
  ): Promise<unknown> {
    return await this.authority.issuePairingCredential(selector, expiresAtMs, nowMs)
  }

  /** Undo a pairing flow that did not complete. */
  async rollbackPairingCredential(selector: PeerRelationshipSelector): Promise<void> {
    await this.authority.rollbackPairingCredential(selector)
  }

  /** Every live grant for a relationship, as the sharing settings render it. */
  async listActiveGrants(selector: PeerRelationshipSelector, nowMs: number): Promise<unknown[]> {
    return (await this.authority.listActiveGrants(selector, nowMs)) as unknown[]
  }

  /** Replace a relationship's sharing with a new selection. */
  async replaceGrant(
    selector: PeerRelationshipSelector,
    selection: PeerGrantSelection,
    nowMs: number,
    grantId: string
  ): Promise<unknown> {
    return await this.authority.replaceGrant(selector, selection, nowMs, grantId)
  }

  /** Every grant row held for a relationship, for durable write-back. */
  async exportGrants(selector: PeerRelationshipSelector): Promise<unknown[]> {
    return this.authority.exportGrants(selector) as unknown[]
  }

  /** Withdraw every grant for a relationship. */
  async revokeSharing(selector: PeerRelationshipSelector, nowMs: number): Promise<unknown[]> {
    return (await this.authority.revokeSharing(selector, nowMs)) as unknown[]
  }

  /** Revoke a relationship outright: verifier, grants and challenges. */
  async revokePeerAuthority(
    selector: PeerRelationshipSelector,
    reasonCode: string,
    revokedAtMs: number
  ): Promise<unknown> {
    return await this.authority.revokePeerAuthority(selector, reasonCode, revokedAtMs)
  }

  /** The execution policy for one projected method. */
  describeMethod(methodId: string): unknown {
    return this.authority.describeMethod(methodId)
  }

  /** The execution policy for one projected event topic. */
  describeEvent(topic: string): unknown {
    return this.authority.describeEvent(topic)
  }

  /** Check one `TTS.AudioChunk` emission against its stream's state machine. */
  validateTtsAudioChunk(subscriptionId: string, event: unknown, correlationId?: string): void {
    this.authority.validateTtsAudioChunk(subscriptionId, event, correlationId)
  }

  /** Forget a subscription's TTS stream state when it closes. */
  closeTtsSubscription(subscriptionId: string): void {
    this.authority.closeTtsSubscription(subscriptionId)
  }

  /** The audit rows recorded so far, oldest first. */
  async drainAuditRecords(): Promise<unknown[]> {
    return this.authority.drainAuditRecords() as unknown[]
  }

  /** Release the WebAssembly instance's handle. */
  free(): void {
    this.authority.free()
  }
}

import type { TauriInvoke } from '../tauri.js'

import type {
  PeerHostAuthorizationDecision,
  PeerHostAuthorizationStore,
  PeerHostAuthorizeRequest,
  PeerHostManifestAuthoritySnapshot
} from './types.js'
import type { AuthenticatedPeerContext, LocalPeerCredentialVerifierV1, LocalPeerGrantV1 } from './authority.js'

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

/** What the authority needs replayed into it before it can answer. */
export interface RustAuthorityHydration {
  readonly verifiers: readonly LocalPeerCredentialVerifierV1[]
  readonly grants: readonly LocalPeerGrantV1[]
}

/** The subset of the Rust authority this store dispatches to. */
export interface RustAuthorityPort {
  hydrate(hydration: RustAuthorityHydration): Promise<void>
  authorize(request: PeerHostAuthorizeRequest): Promise<PeerHostAuthorizationDecision>
  snapshotManifestAuthority(request: {
    readonly remotePeerId?: string
    readonly authenticatedPeerContext?: AuthenticatedPeerContext
    readonly nowMs: number
    readonly correlationId?: string
  }): Promise<PeerHostManifestAuthoritySnapshot>
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
  revokePeerAuthority: 'aurora_mesh_authority_revoke_peer_authority'
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
}

/** Dispatch to the WebAssembly authority. */
export function createWasmAuthorityPort(authority: WasmAuthorityLike): RustAuthorityPort {
  return {
    async hydrate(hydration) {
      await authority.hydrate(hydration.verifiers, hydration.grants)
    },
    async authorize(request) {
      return await authority.authorize(request)
    },
    async snapshotManifestAuthority(request) {
      return await authority.snapshotManifestAuthority(request)
    }
  }
}

/**
 * Asks the Rust authority every permission question.
 *
 * Holds no grant and evaluates no permission of its own — it is a transport for
 * the question and the answer, which is what keeps the authority a single
 * implementation.
 */
export class RustPeerHostAuthorizationStore implements PeerHostAuthorizationStore {
  constructor(private readonly port: RustAuthorityPort) {}

  /** Replay durable verifiers and grants into the authority at session start. */
  async hydrate(hydration: RustAuthorityHydration): Promise<void> {
    await this.port.hydrate(hydration)
  }

  async authorize(request: PeerHostAuthorizeRequest): Promise<PeerHostAuthorizationDecision> {
    return await this.port.authorize(request)
  }

  async snapshotManifestAuthority(request: {
    readonly remotePeerId?: string
    readonly authenticatedPeerContext?: AuthenticatedPeerContext
    readonly nowMs: number
    readonly correlationId?: string
  }): Promise<PeerHostManifestAuthoritySnapshot> {
    return await this.port.snapshotManifestAuthority(request)
  }
}

# `aurora-mesh-authority`

The mesh peer authority: grants, permission evaluation, execution policy, and
the denial paths. This is workstream **R2** of
[`docs/mesh/THIN-CLIENT-MESH-PARITY-PLAN.md`](../../../docs/mesh/THIN-CLIENT-MESH-PARITY-PLAN.md),
built against the seam settled in
[`docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md`](../../../docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md).

## What this crate is, and is not

Per section 1 of the R0 boundary note there are two per-peer maps, and building
both in both languages is the failure that note prevents.

| | Session registry | **Authority store** |
|---|---|---|
| Holds | session handle, signaling port, bridge, pairing state, roster snapshot | grants, permission evaluation, execution policy, revocation, reconnect challenges |
| Answers | "who am I connected to, and how is that connection doing?" | **"is this peer allowed to do this?"** |
| Owner | TypeScript, permanently | **this crate** |

So: the authority is keyed by peer identity, holds no transport state, and never
learns which `RTCPeerConnection` a peer arrived on. That is what makes
*authority contexts never cross peers* checkable in one place — and it is
checked, in `tests/parity_corpus.rs::authority_holds_no_transport_state`.

## Layout

| Module | Ported from |
|---|---|
| `authority` | `peer-host/authority.ts` — selectors, verifiers, grants, the reconnect challenge replay guard, audit, revocation, the resolver |
| `authorization` | `peer-host/authorization.ts` — the three `PeerHostAuthorizationStore` implementations |
| `grant_management` | `peer-host/grant-management.ts` — what a person may share, expressed as validation |
| `contract_registry` | `peer-host/contract-registry.ts` — execution policy and the TTS emission sequencer |
| `types` | `peer-host/types.ts` — the authority half; see the module docs for what stays host-side |
| `crypto` | the reconnect-proof subset of `webrtc/crypto.ts` |
| `wasm` | the `wasm-bindgen` boundary, behind `cfg(target_arch = "wasm32")` |

Deliberately **not** ported: `webrtc-peer-host.ts` (the host is R3's),
`provider-lease.ts`, and `local-data-authority-adapters.ts`. The adapters stay
in TypeScript on purpose — see "Persistence" below.

## Parity

Both authorities are driven from one file,
[`tests/fixtures/mesh_authority_parity_vectors.json`](../../../tests/fixtures/mesh_authority_parity_vectors.json),
regenerated with:

```bash
uv run python scripts/generate_mesh_authority_fixtures.py
```

| Consumer | Command |
|---|---|
| Rust | `cargo test -p aurora-mesh-authority` |
| TypeScript | `pnpm --filter @aurora/sdk exec vitest run tests/mesh-authority-parity-vectors.test.ts` |

The corpus covers grants, permission evaluation, execution policy and the denial
paths, and it carries **84 hostile cases** — expired grants, revoked authority,
a grant for a different peer presented by this peer, replayed reconnect
challenges, selector and transport mismatch, permission escalation, wildcards,
path traversal, secret-shaped and execution-shaped identifiers, malformed and
oversized input. Both test suites assert the hostile count has not fallen, so
the corpus cannot quietly stop being a guard.

## Persistence

This crate decides; it does not store. Grants, verifiers and challenges live in
memory and TypeScript hydrates them at session start from the durable adapters
it already owns (`peer-host/local-data-authority-adapters.ts`:
`EncryptedPeerGrantRepository`, `SecureInboundCredentialVerifierStore`,
`LocalDataPeerAuditSink`). Encryption at rest, IndexedDB and the
`aurora_local_data_*` commands stay where they are; Rust becomes the single
place a permission question is answered. Teaching Rust to call back into
IndexedDB would move persistence across the seam for no decision benefit.

---

# Blocked: the Tauri command surface

⚠️ **Not applied.** `apps/aurora-tauri/src-tauri/src/lib.rs` and
`apps/aurora-tauri/src-tauri/Cargo.toml` are cross-platform Tauri bootstrap
files, reserved by `AGENTS.md` for one owner at a time, and the R1 agent holds
them. This section is the exact diff to apply once they are released.

## 1. `apps/aurora-tauri/src-tauri/Cargo.toml`

Add one dependency, in the existing alphabetical block of path dependencies:

```toml
aurora-mesh-authority = { path = "../../../rust/crates/aurora-mesh-authority" }
```

## 2. `apps/aurora-tauri/src-tauri/src/lib.rs`

Add the module and register eight commands. The surface mirrors the WASM
boundary exactly, so the TypeScript caller differs only in transport:

```rust
mod mesh_authority;
```

and in the `tauri::generate_handler!` list, alongside the existing
`aurora_local_data_*` entries:

```rust
mesh_authority::aurora_mesh_authority_hydrate,
mesh_authority::aurora_mesh_authority_authorize,
mesh_authority::aurora_mesh_authority_snapshot_manifest,
mesh_authority::aurora_mesh_authority_issue_reconnect_challenge,
mesh_authority::aurora_mesh_authority_verify_reconnect_proof,
mesh_authority::aurora_mesh_authority_list_active_grants,
mesh_authority::aurora_mesh_authority_replace_grant,
mesh_authority::aurora_mesh_authority_revoke_peer_authority,
```

## 3. New file `apps/aurora-tauri/src-tauri/src/mesh_authority.rs`

Owned entirely by this lane, so it lands with no conflict. Shape:

```rust
//! Tauri command surface for the mesh authority.

use std::sync::Arc;

use aurora_mesh_authority::authority::{ /* … */ };
use aurora_mesh_authority::types::{PeerHostAuthorizationStore, PeerHostAuthorizeRequest, /* … */};
use serde_json::Value;
use tokio::sync::Mutex;

/// One authority per app, keyed internally by peer identity.
pub struct MeshAuthorityState(Arc<Mutex<NativeAuthority>>);

#[tauri::command]
pub async fn aurora_mesh_authority_authorize(
    state: tauri::State<'_, MeshAuthorityState>,
    request: PeerHostAuthorizeRequest,
) -> Result<Value, String> { /* … */ }

// …seven more, one per command above.
```

Notes for whoever sequences this:

- The state is `Arc<Mutex<…>>` because the authority's write paths take
  `&mut self` — that is the Rust replacement for the TypeScript promise
  write-queue and it must not be worked around with interior mutability.
- Commands take and return the same camelCase JSON as the WASM boundary. One
  TypeScript adapter can therefore dispatch to either, choosing by platform and
  never by lifecycle (R0 section 1).
- `apps/aurora-tauri/src-tauri/capabilities/*.json` needs the eight command
  names added to the allowlist, and `gen/schemas/acl-manifests.json` regenerates
  from that — both are also R1-owned right now.
- No change to `build.rs` is required.

---

# Blocked: deleting the TypeScript authority

⚠️ **Not applied.** A concurrent agent is landing the M1 peer registry against
`PeerHostAuthorizationStore` right now. This is a **non-negotiable acceptance
criterion of R2**, not an optional cleanup — "two authorities is drift in the
one layer where drift is a vulnerability" — and it is sequenced after parity is
proven, which it now is.

## Files deleted outright

| File | Bytes |
|---|---|
| `packages/aurora-sdk/src/peer-host/authority.ts` | 34 KB |
| `packages/aurora-sdk/src/peer-host/authorization.ts` | 7.8 KB |
| `packages/aurora-sdk/src/peer-host/grant-management.ts` | 13 KB |
| `packages/aurora-sdk/src/peer-host/contract-registry.ts` | 14.5 KB |

`types.ts` is **not** deleted. Its `PeerHostAuthorizationStore`,
`PeerHostAuthorizeRequest`, `PeerHostAuthorizationDecision` and
`PeerHostManifestAuthoritySnapshot` remain as the interface the TypeScript side
asks *through* — the R0 note promises W1 and R3 exactly that. What leaves
`types.ts` is nothing; what changes is that the only implementation becomes the
Rust-backed adapter.

## Exported symbols that go

From `peer-host/index.ts`, the value exports:

`DenyAllPeerHostAuthorizationStore`, `PeerAuthorityHostAuthorizationStore`,
`SessionPeerHostAuthorizationStore`, `DenyAllInboundCredentialVerifierStore`,
`DenyAllPeerGrantRepository`, `MemoryInboundCredentialVerifierStore`,
`MemoryPeerAuditSink`, `MemoryPeerGrantRepository`,
`MemoryPeerRevocationBroadcaster`, `MemoryPeerRevocationController`,
`MemoryReconnectChallengeStore`, `NoopPeerAuditSink`,
`NoopPeerRevocationBroadcaster`, `NoopReconnectChallengeStore`,
`PeerAuthorityResolver`, `PeerPairingIssuer`, `createReconnectProofForBearer`,
`PeerGrantManagementError`, `PeerGrantManager`, `PeerHostContractRegistry`,
`createToolingPeerHostRegistry`, `generatedPeerHostEventDescriptor`,
`generatedPeerHostMethodDescriptor`, `registerGeneratedPeerHostEvent`,
`registerGeneratedPeerHostMethod`.

And the type-only exports that describe them: `AuthenticatedPeerContext`,
`InboundCredentialVerifierStore`, `IssuedPeerBearerCredential`,
`LocalPeerApprovalRequest`, `LocalPeerAuditAction`, `LocalPeerAuditRecord`,
`PeerAuthorityDecision`, `PeerAuthorityDecisionReason`,
`PeerAuthorityResolverOptions`, `PeerGrantRepository`,
`PeerGrantResolutionRequest`, `PeerRelationshipIdentity`,
`PeerPairingIssuerOptions`, `PeerRelationshipSelector`,
`PeerRevocationBroadcaster`, `PeerRevocationController`, `PeerRevocationEvent`,
`ReconnectChallengeConsumeResult`, `ReconnectChallengeConsumeStatus`,
`ReconnectChallengeRecord`, `ReconnectChallengeStore`,
`ReconnectTransportAttestation`, `IssueReconnectChallengeRequest`,
`VerifyReconnectProofRequest`, `VerifyReconnectProofResult`,
`ProviderLocalPeerCredentialVerifierV1`, `ProviderLocalPeerGrantV1`,
`PeerGrantManagementErrorCode`, `PeerGrantManagerOptions`,
`PeerGrantSelection`, `PeerGrantSummary`, `GeneratedPeerHostEventHandler`,
`GeneratedPeerHostEventRegistrationOptions`, `GeneratedPeerHostMethodHandler`,
`GeneratedPeerHostMethodId`, `GeneratedPeerHostRegistrationOptions`,
`ToolingPeerHostHandlers`.

The *type* names survive as declarations — the Rust boundary speaks the same
camelCase JSON, so they become the shape of what crosses IPC rather than the
shape of a local class. They should be regenerated from the Rust types rather
than hand-maintained, which is a follow-up worth its own slice.

## What must be re-pointed first, and at what

Ordered by how much each blocks the others.

1. **`peer-host/local-data-authority-adapters.ts`** (484 lines) implements
   `PeerGrantRepository`, `InboundCredentialVerifierStore` and `PeerAuditSink`
   over encrypted local data. It stays, but inverts: instead of *being* the
   store the resolver reads through, it becomes the hydration source that feeds
   `hydrateGrant` / `hydrateVerifier` and the sink that persists what the Rust
   authority decides. **This is the largest piece of work in the deletion and
   should land before anything is removed.**

2. **`peer-host/webrtc-peer-host.ts`** calls `authorizationStore.authorize` and
   `snapshotManifestAuthority`. Re-point at the adapter that dispatches to Tauri
   IPC or WASM. R3 owns this file; coordinate rather than pre-empt.

3. **The M1 peer registry** (`packages/aurora-sdk/src/webrtc/peer-registry.ts`,
   currently in flight) holds a reference to the authorization store. It must
   hold the adapter, and — per R0 section 1 — must still not cache or evaluate a
   grant itself.

4. **`packages/aurora-ui/`** sharing settings call `PeerGrantManager` directly
   for `listActiveGrants` / `replaceGrant` / `revokeSharing`. Re-point at the
   three corresponding commands.

5. **Test suites that construct the deleted classes directly** and would fail to
   import: `peer-authority-memory.test.ts`, `peer-grant-management.test.ts`,
   `peer-authority-contract.test.ts`, `peer-authority-local-data-adapters.test.ts`,
   `generated-peer-host.test.ts`, `peer-host.test.ts`, and the parity suite
   `mesh-authority-parity-vectors.test.ts` itself. The parity suite is the one
   that changes *shape*: once there is a single authority it stops being a
   cross-language comparison and becomes the Rust authority's contract test,
   driven from the same corpus through the IPC/WASM adapter. Keep the corpus.

6. **`packages/aurora-sdk/src/peer-host/index.ts`** and any
   `*-package-boundary.test.ts` asserting its export list.

## Suggested sequence

1. Land the Tauri commands (blocked step one) so both platforms have a
   dispatchable surface.
2. Write the TypeScript adapter implementing `PeerHostAuthorizationStore` over
   IPC/WASM, and run the existing peer-host suites against it unchanged. This is
   where the parity corpus earns its keep a second time.
3. Invert `local-data-authority-adapters.ts` into hydration plus persistence.
4. Re-point callers in the order above.
5. Delete the four files and prune `index.ts`.
6. Re-shape the parity suite onto the adapter.

Nothing in this crate needs to change for any of it.

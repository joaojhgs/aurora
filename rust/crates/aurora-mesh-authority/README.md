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

# Blocked step 1: the Tauri command surface

⚠️ **Not applied.** `apps/aurora-tauri/src-tauri/**` is cross-platform Tauri
bootstrap, reserved by `AGENTS.md` for one owner at a time. This section is the
exact change to apply once the coordinator sequences it. Five files, four edits
and one new file.

## 1.1 New file — `apps/aurora-tauri/src-tauri/src/mesh_authority.rs`

Owned entirely by this lane, so it lands with no conflict.

```rust
//! Tauri command surface for the mesh authority.
//!
//! Decisions cross this boundary; storage does not. TypeScript hydrates the
//! authority at session start from the durable adapters it already owns, and
//! asks every permission question through here. See the crate README.

use std::sync::Arc;

use aurora_mesh_authority::authority::{
    InboundCredentialVerifierStore, IssueReconnectChallengeRequest,
    LocalPeerCredentialVerifierV1, LocalPeerGrantV1, MemoryInboundCredentialVerifierStore,
    MemoryPeerAuditSink, MemoryPeerGrantRepository, MemoryPeerRevocationBroadcaster,
    MemoryPeerRevocationController, MemoryReconnectChallengeStore, PeerAuthorityResolver,
    PeerGrantRepository, PeerRelationshipIdentity, PeerRelationshipSelector, RandomSource,
    ReconnectTransportAttestation, VerifyReconnectProofRequest,
};
use aurora_mesh_authority::authorization::PeerAuthorityHostAuthorizationStore;
use aurora_mesh_authority::grant_management::{PeerGrantManager, PeerGrantSelection};
use aurora_mesh_authority::types::{
    PeerHostAuthorizationStore, PeerHostAuthorizeRequest, PeerHostManifestAuthorityRequest,
};
use serde_json::Value;
use tokio::sync::Mutex;

/// Bytes from the OS CSPRNG. `getrandom` is already a direct dependency.
struct OsRandomSource;

impl RandomSource for OsRandomSource {
    fn random_bytes(&self, length: usize) -> Vec<u8> {
        let mut out = vec![0_u8; length];
        getrandom::getrandom(&mut out).expect("OS random source is unavailable");
        out
    }
}

type NativeAuthority = PeerAuthorityHostAuthorizationStore<
    MemoryInboundCredentialVerifierStore,
    MemoryPeerGrantRepository,
    MemoryReconnectChallengeStore,
    MemoryPeerAuditSink,
>;

/// One authority per app, keyed internally by peer identity and holding no
/// transport state — see the R0 boundary note, section 1.
pub struct MeshAuthorityState(Arc<Mutex<NativeAuthority>>);

impl Default for MeshAuthorityState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(PeerAuthorityHostAuthorizationStore::new(
            PeerAuthorityResolver::new(
                MemoryInboundCredentialVerifierStore::new(),
                MemoryPeerGrantRepository::new(),
                MemoryReconnectChallengeStore::new(Box::new(OsRandomSource)),
                MemoryPeerAuditSink::default(),
            ),
        ))))
    }
}

#[tauri::command]
pub async fn aurora_mesh_authority_hydrate(
    state: tauri::State<'_, MeshAuthorityState>,
    verifiers: Vec<LocalPeerCredentialVerifierV1>,
    grants: Vec<LocalPeerGrantV1>,
) -> Result<(), String> { /* upsert each, map errors with to_string */ }

#[tauri::command]
pub async fn aurora_mesh_authority_authorize(
    state: tauri::State<'_, MeshAuthorityState>,
    request: PeerHostAuthorizeRequest,
) -> Result<Value, String> { /* store.authorize(&request) -> serde_json::to_value */ }

#[tauri::command]
pub async fn aurora_mesh_authority_snapshot_manifest(
    state: tauri::State<'_, MeshAuthorityState>,
    request: PeerHostManifestAuthorityRequest,
) -> Result<Value, String> { /* … */ }

#[tauri::command]
pub async fn aurora_mesh_authority_issue_reconnect_challenge(
    state: tauri::State<'_, MeshAuthorityState>,
    request: IssueReconnectChallengeRequest,
) -> Result<Value, String> { /* … */ }

#[tauri::command]
pub async fn aurora_mesh_authority_verify_reconnect_proof(
    state: tauri::State<'_, MeshAuthorityState>,
    request: VerifyReconnectProofRequest,
) -> Result<Value, String> { /* … */ }

#[tauri::command]
pub async fn aurora_mesh_authority_list_active_grants(
    state: tauri::State<'_, MeshAuthorityState>,
    selector: PeerRelationshipSelector,
    now_ms: i64,
) -> Result<Value, String> { /* PeerGrantManager over the borrowed repository */ }

#[tauri::command]
pub async fn aurora_mesh_authority_replace_grant(
    state: tauri::State<'_, MeshAuthorityState>,
    selector: PeerRelationshipSelector,
    selection: PeerGrantSelection,
    now_ms: i64,
) -> Result<Value, String> { /* grant id from OsRandomSource */ }

#[tauri::command]
pub async fn aurora_mesh_authority_revoke_peer_authority(
    state: tauri::State<'_, MeshAuthorityState>,
    selector: PeerRelationshipSelector,
    reason_code: String,
    revoked_at_ms: i64,
) -> Result<Value, String> { /* MemoryPeerRevocationController */ }
```

`IssueReconnectChallengeRequest` and `VerifyReconnectProofRequest` need
`#[derive(Deserialize)]` with the camelCase renames the WASM boundary already
declares inline; adding those derives in `authority.rs` is a one-line change in
this crate and is the only crate-side work the wiring needs.

## 1.2 `apps/aurora-tauri/src-tauri/Cargo.toml`

One line in `[dependencies]`, alphabetically before `base64`:

```diff
 aes-gcm = { version = "=0.10.3", default-features = false, features = ["aes", "alloc", "zeroize"] }
+aurora-mesh-authority = { path = "../../../rust/crates/aurora-mesh-authority" }
 base64 = "=0.22.1"
```

`getrandom`, `serde`, `serde_json`, `tokio` (`sync`) and `thiserror` are already
there; nothing else is added.

## 1.3 `apps/aurora-tauri/src-tauri/src/lib.rs`

Two edits. Declare the module beside the existing ones near line 67:

```diff
 mod native_webrtc;
+mod mesh_authority;
```

and extend `tauri::generate_handler!` (the list starting at line 8730), after
`aurora_local_data_envelope_rotate` at line 8823:

```diff
             aurora_local_data_envelope_rotate,
+            mesh_authority::aurora_mesh_authority_hydrate,
+            mesh_authority::aurora_mesh_authority_authorize,
+            mesh_authority::aurora_mesh_authority_snapshot_manifest,
+            mesh_authority::aurora_mesh_authority_issue_reconnect_challenge,
+            mesh_authority::aurora_mesh_authority_verify_reconnect_proof,
+            mesh_authority::aurora_mesh_authority_list_active_grants,
+            mesh_authority::aurora_mesh_authority_replace_grant,
+            mesh_authority::aurora_mesh_authority_revoke_peer_authority,
```

plus `.manage(mesh_authority::MeshAuthorityState::default())` in the builder
chain, beside the existing `LocalDataCommandState`.

## 1.4 `apps/aurora-tauri/src-tauri/build.rs`

The `AppManifest::commands(&[…])` list is the allowlist Tauri generates
permissions from, so the eight names must be added or every call is refused at
runtime. After `"aurora_local_data_envelope_rotate"`:

```diff
             "aurora_local_data_envelope_rotate",
+            "aurora_mesh_authority_hydrate",
+            "aurora_mesh_authority_authorize",
+            "aurora_mesh_authority_snapshot_manifest",
+            "aurora_mesh_authority_issue_reconnect_challenge",
+            "aurora_mesh_authority_verify_reconnect_proof",
+            "aurora_mesh_authority_list_active_grants",
+            "aurora_mesh_authority_replace_grant",
+            "aurora_mesh_authority_revoke_peer_authority",
```

## 1.5 New permission and its capabilities

New file `apps/aurora-tauri/src-tauri/permissions/aurora-mesh-authority.toml`,
following `aurora-local-data-storage.toml`:

```toml
[[permission]]
identifier = "aurora-mesh-authority"
description = "Allow the thin shell to ask the Rust mesh authority whether a peer may call a method, to hydrate it from durable storage, and to manage or revoke what a peer is allowed. The authority is keyed by peer identity and holds no transport state; no bearer token or verifier hash ever crosses this boundary."
commands.allow = [
  "aurora_mesh_authority_hydrate",
  "aurora_mesh_authority_authorize",
  "aurora_mesh_authority_snapshot_manifest",
  "aurora_mesh_authority_issue_reconnect_challenge",
  "aurora_mesh_authority_verify_reconnect_proof",
  "aurora_mesh_authority_list_active_grants",
  "aurora_mesh_authority_replace_grant",
  "aurora_mesh_authority_revoke_peer_authority"
]
```

Add `"aurora-mesh-authority"` to the `permissions` array of the four capability
files that already carry `"aurora-local-data-storage"` — `aurora-thin.json`,
`aurora-android-thin.json`, `aurora-ios-thin.json`, `aurora-mobile-mesh.json`.
`gen/schemas/*.json` and `permissions/autogenerated/` regenerate from `build.rs`
on the next build; both are committed artefacts and will show as changed.

## 1.6 Verification for that slice

```bash
cargo check --manifest-path apps/aurora-tauri/src-tauri/Cargo.toml
cargo test  --manifest-path apps/aurora-tauri/src-tauri/Cargo.toml
```

---

# Blocked step 2: deleting the TypeScript authority

⚠️ **Not applied**, and **not dropped** — it is a non-negotiable acceptance
criterion of R2. The blocker was M1 landing against `PeerHostAuthorizationStore`;
M1 has landed (`86b6199e`, `b14fa87f`, `e95de9ca`) and parity is now proven, so
the only remaining prerequisite is the adapter in step 2.3 below.

## 2.1 Files deleted

| File | Size |
|---|---|
| `packages/aurora-sdk/src/peer-host/authority.ts` | 34 KB |
| `packages/aurora-sdk/src/peer-host/authorization.ts` | 7.8 KB |
| `packages/aurora-sdk/src/peer-host/grant-management.ts` | 13 KB |
| `packages/aurora-sdk/src/peer-host/contract-registry.ts` | 14.5 KB |

`types.ts` is **not** deleted: `PeerHostAuthorizationStore`,
`PeerHostAuthorizeRequest`, `PeerHostAuthorizationDecision` and
`PeerHostManifestAuthoritySnapshot` stay as the interface TypeScript asks
*through*, which is exactly what the R0 note promises W1 and R3. What changes is
that its only implementation becomes the Rust-backed adapter.

`webrtc-peer-host.ts`, `provider-lease.ts` and
`local-data-authority-adapters.ts` are **not** deleted.

## 2.2 Exported symbols removed from `peer-host/index.ts`

Values (25): `DenyAllPeerHostAuthorizationStore`,
`PeerAuthorityHostAuthorizationStore`, `SessionPeerHostAuthorizationStore`,
`DenyAllInboundCredentialVerifierStore`, `DenyAllPeerGrantRepository`,
`MemoryInboundCredentialVerifierStore`, `MemoryPeerAuditSink`,
`MemoryPeerGrantRepository`, `MemoryPeerRevocationBroadcaster`,
`MemoryPeerRevocationController`, `MemoryReconnectChallengeStore`,
`NoopPeerAuditSink`, `NoopPeerRevocationBroadcaster`,
`NoopReconnectChallengeStore`, `PeerAuthorityResolver`, `PeerPairingIssuer`,
`createReconnectProofForBearer`, `PeerGrantManagementError`, `PeerGrantManager`,
`PeerHostContractRegistry`, `createToolingPeerHostRegistry`,
`generatedPeerHostEventDescriptor`, `generatedPeerHostMethodDescriptor`,
`registerGeneratedPeerHostEvent`, `registerGeneratedPeerHostMethod`.

Types (33): `AuthenticatedPeerContext`, `InboundCredentialVerifierStore`,
`IssuedPeerBearerCredential`, `LocalPeerApprovalRequest`,
`LocalPeerAuditAction`, `LocalPeerAuditRecord`, `PeerAuthorityDecision`,
`PeerAuthorityDecisionReason`, `PeerAuthorityResolverOptions`,
`PeerGrantRepository`, `PeerGrantResolutionRequest`,
`PeerRelationshipIdentity`, `PeerPairingIssuerOptions`,
`PeerRelationshipSelector`, `PeerRevocationBroadcaster`,
`PeerRevocationController`, `PeerRevocationEvent`,
`ReconnectChallengeConsumeResult`, `ReconnectChallengeConsumeStatus`,
`ReconnectChallengeRecord`, `ReconnectChallengeStore`,
`ReconnectTransportAttestation`, `IssueReconnectChallengeRequest`,
`VerifyReconnectProofRequest`, `VerifyReconnectProofResult`,
`ProviderLocalPeerCredentialVerifierV1`, `ProviderLocalPeerGrantV1`,
`PeerGrantManagementErrorCode`, `PeerGrantManagerOptions`,
`PeerGrantSelection`, `PeerGrantSummary`, `GeneratedPeerHostEventHandler`,
`ToolingPeerHostHandlers` (and the remaining `GeneratedPeerHost*` option and
handler aliases).

The **type** names survive as declarations — the Rust boundary speaks the same
camelCase JSON, so they describe what crosses IPC rather than a local class.
They move to a new `peer-host/authority-types.ts`, ideally generated from the
Rust types rather than hand-maintained.

## 2.3 Every import site that must be re-pointed

Measured on `55ecb3e1`. Ten source files, none of them in `peer-host/` itself.

| File | Imports | Becomes |
|---|---|---|
| `local-tools/authority-policy.ts` | `AuthenticatedPeerContext`, `PeerAuthorityResolver` | type from `authority-types.ts`; resolver calls become adapter calls |
| `local-tools/durable-feature-sharing.ts` | `IssuedPeerBearerCredential`, `PeerPairingIssueOptions`, `PeerRelationshipSelector`, `PeerGrantManager`, `PeerGrantSummary` | types from `authority-types.ts`; `PeerGrantManager` → `listActiveGrants`/`replaceGrant`/`revokeSharing` commands |
| `local-tools/mesh-node-provider.ts` | `DenyAllPeerHostAuthorizationStore`, `PeerAuthorityHostAuthorizationStore`, `PeerHostContractRegistry`, `createToolingPeerHostRegistry`, `PeerAuthorityResolver`, `LocalPeerGrantV1`, `PeerHostOptions`, `WebRtcPeerHost` | **the heaviest site.** Both stores → the one adapter; the registry → `describeMethod`/`describeEvent` |
| `local-tools/tool-registry.ts` | `AuthenticatedPeerContext` | type only |
| `local-tools/tooling-provider.ts` | `ToolingPeerHostHandlers`, `PeerHostCallContext` | `ToolingPeerHostHandlers` stays TypeScript — these are the *handlers*, which are the host's, not the authority's |
| `webrtc/mesh-peer-bridge.ts` | `WebRtcPeerHost`, `AuthenticatedPeerContext` | type only |
| `webrtc/peer-registry.ts` (M1) | `AuthenticatedPeerContext` | type only — and per R0 §1 it must still hold only a *reference*, never a grant |
| `webrtc/peer-session.ts` | `AuthenticatedPeerContext` | type only |
| `webrtc/runtime.ts` | `AuthenticatedPeerContext`, `WebRtcPeerHost`, `PeerAuthorityResolver`, `PeerPairingIssuer`, `PeerRelationshipSelector` | resolver and issuer → adapter; rest type only |
| `webrtc/index.ts` | re-exports from `peer-host/index.js` | prune to match 2.2 |

Seven of the ten are **type-only** imports of `AuthenticatedPeerContext` and
friends, so they need a changed import path and nothing else. The real work is
`mesh-node-provider.ts`, `runtime.ts` and `durable-feature-sharing.ts`.

## 2.4 What `WebRtcPeerHost` still needs from TypeScript afterwards

It keeps four collaborators through `PeerHostOptions`:

1. **`authorizationStore`** — now the adapter. `webrtc-peer-host.ts:413` and
   `:517` call `authorize`, `:665` calls `snapshotManifestAuthority`. Both
   signatures are unchanged, which is the point of keeping `types.ts`.
2. **`registry`** — the *handler* half stays TypeScript. `:436` `dispatch`,
   `:580` `openSubscription`, `:707` `openStream`, `:710`/`:740` `parseOutput`
   and `parseEventOutput`. The Rust registry answers *policy* questions
   (`describeMethod`, blocked methods, limits); it cannot run a TypeScript
   handler, and should not. The TypeScript registry shrinks to a handler table
   plus Zod parsing and takes its limits from `describeMethod`.
3. **`revocationBroadcaster`** — `:877`/`:882` subscribe to revocations. Becomes
   a Tauri event / WASM callback fed by the Rust controller.
4. **`clock`, `randomId`, `localPeerId`, `nodeName`** — unchanged.

`effectivePermissionsForMethods` (`:687`) also stays: it maps granted method ids
to permission labels for the manifest, reading the registry's descriptors.

## 2.5 Test suites that must move with it

Fail-to-import on deletion: `peer-authority-memory.test.ts`,
`peer-grant-management.test.ts`, `peer-authority-contract.test.ts`,
`peer-authority-local-data-adapters.test.ts`, `peer-host.test.ts`,
`local-tools-authority-policy.test.ts`,
`local-tools-durable-feature-sharing.test.ts`,
`local-tools-mesh-provider-composition.test.ts`,
`local-tools-policy-provider.test.ts`, `native-capability-pack.test.ts`,
`webrtc-mesh-peer-bridge.test.ts`, `webrtc-peer-session.test.ts`,
`webrtc-runtime.test.ts`, and `mesh-authority-parity-vectors.test.ts`.

The parity suite is the one that changes *shape*: with a single authority it
stops being a cross-language comparison and becomes the Rust authority's
contract test, driven from the same corpus through the adapter. **Keep the
corpus** — it is the regression net for the whole migration.

## 2.6 Suggested order

1. Land blocked step 1 so native has a dispatchable surface.
2. Write `peer-host/rust-authorization-store.ts` implementing
   `PeerHostAuthorizationStore` over Tauri IPC or WASM, chosen by platform and
   never by lifecycle (R0 §1).
3. Run `peer-host.test.ts` unchanged against it. This is where the parity
   corpus earns its keep a second time.
4. Invert `local-data-authority-adapters.ts` from "the store the resolver reads
   through" into "hydration plus persistence".
5. Extract `authority-types.ts` and re-point the seven type-only sites.
6. Re-point `mesh-node-provider.ts`, `runtime.ts`, `durable-feature-sharing.ts`.
7. Delete the four files, prune `index.ts` and `webrtc/index.ts`.
8. Re-shape the parity suite onto the adapter.

Nothing in this crate has to change for any of it.

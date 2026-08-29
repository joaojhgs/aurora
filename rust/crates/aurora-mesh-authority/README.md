# `aurora-mesh-authority`

The single mesh peer permission authority for grants, permission evaluation,
execution policy, reconnect challenges, audit, and revocation. This crate is
workstream R2 of
[`docs/mesh/THIN-CLIENT-MESH-PARITY-PLAN.md`](../../../docs/mesh/THIN-CLIENT-MESH-PARITY-PLAN.md)
and follows the ownership seam in
[`docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md`](../../../docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md).

## Ownership boundary

The authority is keyed by stable peer identity, holds no transport state, and
never infers trust from a connected `RTCPeerConnection` or DataChannel.

| Concern | Owner |
| --- | --- |
| Per-peer sessions, signaling, roster, and bridge selection | TypeScript/WebView runtime; native Rust session for Tauri background transport |
| Grants, permission evaluation, execution policy, reconnect challenges, audit, and revocation | This crate |
| Durable grants, verifier records, audit persistence, and encrypted local data | Existing TypeScript/native storage adapters |

Browser/WebView code uses the same Rust authority through the
`@aurora/mesh-authority-web` WebAssembly package. Tauri desktop and mobile use
the command surface in `apps/aurora-tauri/src-tauri/src/mesh_authority.rs`.
There is no second TypeScript grant evaluator.

## Layout

| Module | Responsibility |
| --- | --- |
| `authority` | selectors, verifiers, grants, reconnect replay guard, audit, revocation, and resolution |
| `authorization` | authority-backed peer-host authorization stores |
| `grant_management` | validation of what may be shared |
| `contract_registry` | execution policy and TTS emission sequencing |
| `types` | authority-side request, response, identity, manifest, and grant models |
| `crypto` | reconnect-proof cryptography |
| `wasm` | `wasm-bindgen` boundary for browser/WebView consumers |

The peer host, provider lease, local-data repositories, WebRTC transport, and
signaling remain outside this crate.

## Persistence and hydration

This crate decides; it does not choose a storage engine. The caller hydrates
grants and verifier records at session start, persists exported redacted state
through the existing encrypted adapters, and applies revocation/audit effects.
Raw bearer material is returned only at issuance and must not cross generic IPC
or storage APIs.

Tauri exposes typed commands for hydration, authorization, manifest snapshots,
reconnect challenge/proof, grant resolution/list/replace/export/revocation,
pairing credential issue/rollback, sharing revocation, and audit drain. Every
request remains peer-bound and fail-closed.

## Parity and verification

Rust and TypeScript/WASM consumers share
[`tests/fixtures/mesh_authority_parity_vectors.json`](../../../tests/fixtures/mesh_authority_parity_vectors.json),
generated with:

```bash
uv run python scripts/generate_mesh_authority_fixtures.py
```

Run:

```bash
cargo test --manifest-path rust/Cargo.toml -p aurora-mesh-authority
pnpm --filter @aurora/mesh-authority-web run build:wasm
pnpm --filter @aurora/mesh-authority-web test
pnpm --filter @aurora/client exec vitest run tests/peer-authority-local-data-adapters.test.ts tests/rust-authorization-store.test.ts
pnpm --filter @aurora/tauri-ui exec vitest run src/tauri-mesh-node-services.test.ts
```

The hostile parity corpus covers expired/revoked/cross-peer grants, replayed
challenges, selector and transport mismatches, permission escalation,
wildcards, path traversal, malformed/oversized input, and secret- or
execution-shaped identifiers. Do not lower its guarded hostile-case count.

## Invariants

- Authority contexts and revisions never cross peers.
- Transport presence is never authorization.
- Stale or mismatched grant/manifest evidence fails closed.
- Revocation blocks new work and closes work owned by the revoked context.
- Durable storage adapters never become a second decision engine.
- Tauri and WebAssembly bindings expose typed/redacted data, not raw secrets.

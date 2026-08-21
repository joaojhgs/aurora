# Handoff — thin-client mesh parity, M7 and M8 remaining

Written for the agent taking this over. Everything here is state as of the handoff commit;
nothing is aspirational. Read `docs/mesh/THIN-CLIENT-MESH-PARITY-PLAN.md` first — it is the
authoritative brief and it has not changed.

## Where the work stands

**Branch:** `mesh-parity-implementation`. **Nothing has been pushed** and nothing should be
until the user asks. 34 commits landed this session, from `f06d0067` to the handoff commit.

The durable ledger is `omc ultragoal`, plan id
`1787151812964-thin-client-mesh-parity-implementation-p`, artifacts under
`.omc/ultragoal/plans/<planId>/`. Drive it with
`omc ultragoal status --plan-id <planId>` / `complete-goals` / `checkpoint`.

**7 of 9 complete. Two remain:**

| Goal | Milestone | State |
|---|---|---|
| `G008-m7-r6-r7` | M7 — R6 budgets and priority, R7 iOS | **in flight when handed off** — see below |
| `G009-m8-r8-w7-w8` | M8 — R8 assistant, W7 lifecycle, W8 hardening | not started; W8's audit and W7's design note are already written |

### M7 (R6 + R7) — the state you are inheriting

The M7 agent was **stopped mid-implementation** when the budget ran out. It committed
**nothing**. All of its work is uncommitted in the working tree — 11 files, +339/-6. Inspected
directly rather than taken on report:

```
app/services/gateway/mesh/models.py                | 16 +++-
app/services/gateway/mesh/peer_registry.py         | 60 ++++++++++++++-
app/services/gateway/webrtc/peer_protocol.py       | 86 ++++++++++++++++++++++
app/services/gateway/webrtc/protocol_contract.py   |  8 ++
app/services/gateway/webrtc/rtc_client.py          | 33 +++++++++
packages/aurora-sdk/src/webrtc-protocol-contract.ts | 10 ++-
packages/aurora-sdk/src/webrtc/index.ts            |  7 ++
packages/aurora-sdk/src/webrtc/mesh-peer-bridge.ts | 36 ++++++++-
packages/aurora-sdk/src/webrtc/protocol.ts         | 83 ++++++++++++++++++++-
rust/crates/aurora-mesh-session/src/ownership.rs   |  5 ++
rust/crates/aurora-mesh-session/tests/session_liveness.rs | 1 +
```

**What it had designed, and it is a good design — keep it rather than restart:**

- The signal is a new frame type `mesh_peer_standby_v1` (`MESH_PEER_STANDBY_TYPE` in
  `protocol.ts`), carrying a `MeshPeerStandbyReason` of `connection_budget` (R6's shed),
  `surface_suspended` (R7's iOS path) or `user_requested` (a person disconnecting on purpose).
  All three mean the same thing to the peer left behind: the absence is deliberate, the
  credential stays valid, and returning is a reconnect rather than a pairing.
- `resume_expected` was added as a **new optional field** rather than a meaning loaded onto an
  existing one, explicitly following the precedent R3 set with `retry_when` on the deferral
  body — additive, so a peer that has never heard of it still reads a well-formed frame.
- Python gains a `"standby"` peer status alongside `stale`, with a comment recording why they
  must not be collapsed: a shed peer announced itself and is expected back, a stale peer stopped
  answering and may be gone; collapsing them makes a shed indistinguishable from a loss, which
  is the whole point of the signal.
- It reasoned explicitly that neither silence nor `provider_unavailable` can carry this —
  silence is exactly what a lost peer produces, and `provider_unavailable` says the provider is
  gone and the caller should stop routing, a different claim.

**State of the tree, verified not assumed:** all four changed Python files parse. Nothing is
known to be broken. But **none of it has been run** — no test was executed against it, the
cross-language fixtures were **not** regenerated, and invariant #8's three-property test does
not exist yet. Treat it as a coherent design, complete on the contract-definition side, and
entirely unverified.

**What was clearly not reached:** the budget defaults and priority ordering
(`peer-registry.ts` is untouched), invariant #8's test, R7's iOS profile beyond the
`surface_suspended` reason existing, and the fixture regeneration.

Its original brief was:

- **R6 budget**: keyed by surface and lifecycle. Keep the plan's starting defaults — mobile 8
  foreground / 2 background, desktop unbounded — because R5 only ran on Waydroid, where battery
  came back `measured_non_physical` and thermal `not_available`. Container figures cannot move a
  budget. Say so in a comment so nobody mistakes the defaults for measured.
- **R6 priority**: user-pinned → depended-upon → most recently used. "Depended-upon" means a
  peer something currently routes to. Extend `MeshPeerConnectionPolicy` in
  `packages/aurora-sdk/src/webrtc/peer-registry.ts` — W6 already made this a policy the registry
  enforces, not a structural limit.
- **R6 contract change** — the substantial half, cross-language. Python evicts on silence today:
  `_check_stale_peers` (`app/services/gateway/mesh/peer_registry.py:1096`) marks a peer `stale`
  when `now - last_ping > stale_peer_timeout_s`, default `120.0`. Peer status is
  `"connected" | "authenticated" | "negotiated" | "stale" | "provider_unavailable"`
  (`app/services/gateway/mesh/models.py:203`). A peer shed to stay inside budget is not a lost
  peer: it needs its own signal and its own status, not silence and not `stale`.
- **R7 iOS**: parity with a smaller budget; suspend-and-resume is the expected path, not a
  failure. No iOS device or simulator exists here — verify by compilation and unit tests and say
  on-device behaviour is unverified.

**Invariant #8 is M7's and is the last uncovered one.** Three properties, all asserted on
effect: a shed peer is reported differently from a silent one on both sides; Python does not
evict a peer that announced it was going away; and a shed peer that returns re-authenticates on
its existing credential with **no pairing prompt** — assert that no `pairing_v2_*` frame is
produced, since a flag check would fake this.

### M8 (R8 + W7 + W8) — not started, but two thirds is already designed

- **W8** — `docs/mesh/W8-PYTHON-SDK-PARITY-AUDIT.md` is done. All 83 fields of the Python
  per-peer state map walked: no gaps, two written exclusions, one row left explicitly unresolved
  (tooling projection invalidation — no SDK code references it by name, but its delivery
  mechanism was never traced end to end). What remains of W8 is the *concurrency hardening*,
  including the one-per-host defect family below.
- **W7** — `docs/mesh/W7-ORPHANED-PEER-ROW-PRUNING.md` is done and **is a safety constraint, not
  a suggestion**. Pruning peer rows on a `node_name` match is an eviction vector: any room member
  picks its own name, so a name match would let anyone evict an approved peer and then occupy
  that name, so the user re-approves the attacker by hand. Safe auto-pruning is limited to rows
  pending in both directions with no credential either way, past a configurable window.
  Everything else is a user decision. The note records the failing test the fix needs.
- **R8** — system assistant reaches the mesh. Not started, not designed. `ROLE_ASSISTANT`,
  `AuroraAssistActivity` and the voice interaction services already exist; the join is missing.
  Scope to one path per the plan.

## Known gaps that are recorded, not hidden

These are real and deliberately visible. Do not treat them as done.

1. **A backgrounded phone does not yet serve tools.** R3 built the deferral half correctly, but
   `background_execution_for()` returns `None` for every method and the executor enum is empty.
   The mesh exposes exactly four methods (`Tooling.GetTools`, `Tooling.GetExportCatalog`,
   `Tooling.PrepareExecution`, `Tooling.ExecuteTool`, from `createToolingPeerHostRegistry`) and
   all four are implemented by the TypeScript local tool provider. The authorization half does
   hold — the deferral is decided after authorization, so an unauthorized peer gets the same
   denial in both lifecycles. Closing this needs Rust to hold a tool catalog, which R2
   deliberately avoided; it belongs to the wider settled decision that *tool dispatch moves to
   Rust*. Written up in the boundary note under "Implementation status after R3".
2. **`frames_served_by_rust_today()` returns only `["call", "ping"]`.** R0 §3's table assigns far
   more to Rust. Everything else is still `mesh-peer-bridge.ts`, queued in the per-peer FIFO when
   TypeScript sleeps. A test fails if the list and the table drift apart.
3. **No physical-device verification anywhere.** The APK build fails on
   `AURORA_SHERPA_ONNX_ANDROID_ARM64_V8A_LIB_DIR`; the installed Waydroid package predates R3,
   R4 and R5. Waydroid is a container and does not reproduce Doze, standby buckets or OEM process
   killing. R3's 120 s hold, background answer and ordered drain are proven **only** by the Rust
   suite. The Linux `desktop-client-live` job has also never run end-to-end locally.
4. **The 15 Tauri authority commands have never been invoked over real IPC** from a running
   shell. They compile, their bodies are unit-tested, and their generated permission TOMLs are
   now committed — but nothing has called them for real.
5. **One-per-host state remains in the peer host.** R3 fixed `lastRecipientPeerId`, but
   `acceptingInbound`, `connectionEpoch` and the pending-manifest slots are still one-per-host
   rather than one-per-peer. Same defect family, invisible until two peers negotiate manifests
   concurrently. This is M8 hardening work.
6. **Invariant #3 is the last read-and-run row.** See `docs/mesh/INVARIANT-TEST-COVERAGE.md`.

## Invariants — the user called these non-negotiable

`docs/mesh/INVARIANT-TEST-COVERAGE.md` is the ledger: which invariant, which test, and **how
hard that test was confirmed**. It distinguishes *mutation-confirmed* (enforcement deliberately
broken, named test observed failing, then restored) from *read-and-run* (passes, assertions read
to confirm they assert on an effect). Keep that distinction — conflating them makes the ledger
worse than none.

Seven of nine covered, five mutation-confirmed. **#8 is M7's and uncovered. #3 (one stable id,
one session) is the last read-and-run row** and was left only because `peer-registry.ts` was
being edited live; close it once M7 lands.

One trap recorded there: `authority_holds_no_transport_state` sounds like it owns invariant #5
but is purely structural and does **not** catch a cross-peer leak. Six corpus cases do.

## Decisions taken this session that are not in the original plan

- **R0's two-map rule.** The *session registry* (TypeScript, permanent) and the *authority store*
  (Rust, after R2) are different things. A registry entry may reference an
  `AuthenticatedPeerContext` so a roster can render pairing state, but must never hold or
  evaluate a grant. This exists to stop the peer model being built twice and it gated W1 and R2.
- **`protocol_hello` ownership is split and asymmetric.** TypeScript composes the local hello
  because the capability set is rollout-flag policy; Rust owns the negotiated result and is the
  sole enforcer of limits. Re-deriving limits in TypeScript would be a second enforcer that can
  disagree.
- **The 65,535-byte ceiling guards bypasses, not routine sends.** Correctly fragmented traffic
  peaks near 22 KB (16 KiB payload, base64'd, plus envelope).
- **Invite v2 (`amv2.`) means the invite addresses the mesh, not one device.** `amv1.`'s
  `node.peer_id` is demoted to a `legacy-hint` origin and decoded forever — not a migration
  window.
- **W3 split discovery from session binding.** Presence widens the roster; an explicit
  per-session allowlist decides who may drive an established session. Dropping
  `expectedStablePeerId` without that would have removed an anti-impersonation control.
- **The TypeScript authority was deleted, not kept as a fallback**, per the plan. `types.ts`
  stays as the interface TypeScript asks *through*; the contract registry keeps its handler half
  because Rust answers policy questions but cannot run a TypeScript handler.
- **Rust logic lives in `rust/crates/`, not `src-tauri`** — logic in `src-tauri` has no runnable
  tests in this environment. `src-tauri` carries decisions out; the crates make them.
- **Frame interception sits inside `native_webrtc`'s `on_message`, not behind a command**, because
  a frozen webview issues no commands.

## Hazards learned the hard way — please inherit these

- **Never run `git stash`.** An agent ran `git stash push` with an untracked path in the
  pathspec; the push failed, the chained `pop` applied an unrelated stash and conflicted four
  Kotlin files. The list holds **11 stashes of other people's work**. Use copy-aside/restore for
  baselines.
- **Never use a broad `git add`.** One agent swept another lane's corpus files into its own
  commit that way. Stage explicit paths.
- **`rust/Cargo.toml` globs `crates/*`.** A crate directory without `src/lib.rs` breaks parsing
  for the *entire* workspace, which breaks the `@aurora/voice-web` wasm build, which breaks every
  UI test importing `assistant-view`. This happened. Run `cargo check` before stopping.
- **No em-dashes anywhere in `packages/aurora-ui/src/**`.** `tests/primitives.test.tsx` walks
  every `.ts`/`.tsx` and rejects the character. Three separate lanes tripped this.
- **Generated Tauri permission TOMLs must be committed.** 72 are tracked; an untracked set means
  the commands exist and are refused at runtime.
- **This repo does not use `wasm-pack`.** The precedent is `cargo build --target
  wasm32-unknown-unknown` plus the `wasm-bindgen` CLI, pinned at 0.2.126. An agent wrongly
  declared a criterion unverifiable for want of `wasm-pack`.
- **`cargo check` of the Tauri shell works** if `AURORA_SHERPA_ONNX_LIB_DIR` points at any
  existing directory — the build script only gates on the path existing. Linking still needs the
  real artifact.

## Baselines — anything beyond these is yours

- `packages/aurora-sdk`: **4 failed / 709 passed**. The 4 are pre-existing backend-inventory drift
  in `conformance.test.ts` and `client.test.ts` (`checked: 40` vs `checked: 34`). No commit in
  this effort touched `fixtures.ts`, `descriptors.ts` or any generated inventory. One run in
  eight reported 5; it did not reproduce in five subsequent runs.
- `packages/aurora-ui`: **10 failing files / 101 failing tests**, all pre-existing, measured
  against `e97b8430` in a separate worktree. Plus 3 pre-existing tsc errors in
  `assistant-view.tsx` and `runtime-profile.ts`, which belong to another agent's lane.
- Rust: `cargo test -p aurora-mesh-authority` 21 passed; `-p aurora-mesh-session` 36 passed.
- Python: run as `uv run python -m pytest <path> -q --no-cov`. `pytest` is not on PATH and
  `pytest.ini` injects coverage args that need `--no-cov`.

## Concurrent work you must not disturb

Another agent owns, on the parent branch: `apps/aurora-web/**` and
`packages/aurora-ui/src/{assistant-view,browser-speech-pack,platform-surface,voice-settings-view}.ts*`
and their tests. Never revert or absorb those. `platform-surface.ts` has been edited surgically
by this effort (the `supportsNativeWebRtcBridge` derivation only) — keep any further edits there
equally narrow, and re-read immediately before editing.

Two now-unused constants remain at `platform-surface.ts` (`nativeSaysLinux`,
`userAgentSaysLinux`); R1 left them deliberately rather than risk a conflict in a contended file.

## The contract

Root `AGENTS.md` is the development contract. Typed bus contracts only, never literal topics. No
`VITE_AURORA_RUNTIME_MODE`. Production UI copy must not leak implementation vocabulary —
`packages/aurora-ui/src/product-copy-forbidden-terms.ts` is enforced by lint and tests. Commit
coherent verified slices with evidence in the message. **Do not push.**

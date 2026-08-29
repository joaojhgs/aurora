# R0 — The Native / TypeScript Boundary

Status: **settled**. This note is the seam that `W1` (peer registry), `R2` (authority core in
Rust) and `R3` (session liveness and background tool serving) are all built against. It exists so
those three do not each invent their own answer to "who owns this" and end up with the peer model
implemented twice.

The substance was decided in
[`THIN-CLIENT-MESH-PARITY-PLAN.md`](./THIN-CLIENT-MESH-PARITY-PLAN.md): **transport, liveness, tool
dispatch and authorization on the Rust side; orchestration and UI in TypeScript.** This note makes
that precise.

---

## 1. The rule that gates W1 and R2

Two different per-peer maps are easy to confuse, and building both in both languages is the failure
this note prevents.

| | **Session registry** | **Authority store** |
|---|---|---|
| Holds | per stable peer id: session handle, signaling port, bridge, pairing state, roster snapshot | grants, permission evaluation, execution policy, revocation, reconnect challenges |
| Answers | "who am I connected to, and how is that connection doing?" | "is this peer allowed to do this?" |
| Owner | **TypeScript**, permanently | **Rust**, after R2 |
| Built by | W1 | R2 |
| Consumed by | UI roster, Connect/Mesh selection, orchestration routing | the peer host, on every inbound call |

**W1 builds the session registry and nothing else.** A registry entry may hold a *reference* to the
authenticated peer context (`AuthenticatedPeerContext`, `peer-host/authority.ts`) so it can render
"paired / approved / needs attention", but it must not hold, cache, derive or evaluate a grant. Any
authorization question is asked through the `PeerHostAuthorizationStore` interface
(`peer-host/types.ts`), which R2 reimplements behind Tauri IPC and WASM. If W1 stores a permission
set on a registry entry, R2 has to tear it back out.

**R2 does not build a session registry.** The Rust authority is keyed by peer identity and is
stateless with respect to transport. It never learns which `RTCPeerConnection` a peer arrived on.
That keeps the invariant *authority contexts never cross peers* checkable in one place.

The corollary for R3: when Rust starts owning sessions on native surfaces, the TypeScript registry
entry's transport half becomes a **handle** to a Rust-owned session rather than a TypeScript-owned
`WebRtcPeerSession`. The entry, its snapshot, and the roster stay in TypeScript. Runtime is chosen
by platform, never by lifecycle — a native shell uses the Rust session in foreground and background
alike.

---

## 2. Layer map

Today, every layer is TypeScript and the Rust side is a transparent `RTCPeerConnection` proxy:

```
MeshP2PTransport            mesh.ts            routes by peerId (bound to one defaultPeerId today)
  WebRtcMeshPeerBridge      mesh-peer-bridge.ts logical frames, correlation, streams, fragments
    WebRtcPeerSession       peer-session.ts     signaling, SDP/ICE, DataChannel, auth state machine
      PeerConnectionLike    ────────────────    browser RTCPeerConnection
                                                 OR native_webrtc.rs over Tauri IPC  ← seam today
    WebRtcPeerHost          peer-host/          inbound dispatch, authorization, manifest, lease
```

`WebRtcPeerSession` is already port-shaped — it takes `signaling`, `createPeerConnection`, `codec`,
`auth` and `timers` as injected ports (`PeerSessionOptions`, `peer-session.ts:213`). That is the
reason this move is a re-hosting rather than a rewrite: the seam moves *up* through existing
interfaces rather than cutting new ones.

After R3, on a native shell:

```
TypeScript   orchestration, roster, pairing UX, Connect/Mesh selection
────────────────────────────────────────────────────────────────────────  seam
Rust         session, signaling, framing, fragmentation, liveness,
             tool dispatch, authorization (R2), manifest, provider lease
```

On web the same Rust authority runs as WASM (`aurora-voice-wasm` is the precedent — a `cdylib` with
a `cfg(target_arch = "wasm32")` `wasm-bindgen` block), while the session stays in the browser's own
`RTCPeerConnection`. There is no third implementation.

---

## 3. Frame-ownership table

The assignment rule is one sentence: **a frame belongs to Rust if it can be answered correctly with
the webview frozen, and to TypeScript if answering it needs a human or the orchestrator.**

`←` = inbound (we answer it), `→` = outbound (we originate it).

| Frame | Owner after R3 | Background? | Note |
|---|---|---|---|
| `protocol_hello` ←→ | **Rust** | yes | Rust fragments, so Rust owns the negotiated result — §4 |
| `fragment` ←→ | **Rust** | yes | fragmentation and reassembly, incl. the 65,535-byte ceiling |
| `ping` ← / `pong` → | **Rust** | yes | R3's headline: hold the session past the 120 s stale window |
| `mesh_auth_challenge_v1` ←→ | **Rust** | yes | reconnect proof is deterministic from a durable credential |
| `mesh_auth_proof_v1` ←→ | **Rust** | yes | single-use per peer; the existing replay guard moves with it |
| `auth` / `reauth` ←→ | **Rust** | yes | credential presentation only — never credential *creation* |
| `pairing_v2_commit` ←→ | **TypeScript** | **no** | SAS needs a human comparing a code |
| `pairing_v2_reveal` ←→ | **TypeScript** | **no** | ditto |
| `pairing_v2_terminal` ←→ | **TypeScript** | **no** | ditto |
| `call` ← | **Rust** | yes | authorize + execute against `aurora_local_data_*` — §6 |
| `call` → | **TypeScript** | no | outbound calls are orchestration; queued while frozen |
| `result` / `error` → | **Rust** | yes | including the deferral body — §6 |
| `result` / `error` ← | TypeScript | no | resolves a TypeScript-side pending RPC |
| `chunk` / `eof` ←→ | **Rust** | yes | stream framing; delivery into TypeScript resumes on thaw |
| `cancel` ←→ | **Rust** | yes | must reach in-flight work whatever language it runs in |
| `event` → | **Rust** | partial | Rust emits events it sources; orchestrator-sourced events queue |
| `event` ← | TypeScript | no | fan-out to UI subscribers |
| `subscribe` / `unsubscribe` ← | **Rust** | yes | admission is an authority decision |
| `subscribed` / `subscribe_rejected` / `unsubscribed` → | **Rust** | yes | |
| `manifest` / `manifest_request` / `manifest_ack` ←→ | **Rust** | yes | manifest content derives from the authority + contract registry |
| `provider_lease` / `provider_unavailable` ←→ | **Rust** | yes | lease renewal is a timer that must survive the background |
| `capacity_update` ←→ | **Rust** | yes | |
| `presence` / `presence_departed` ← | **Rust** | yes | roster observation; projected into TypeScript for the UI |
| `offer` / `answer` / `candidate` ←→ | **Rust** (reconnect) / **TypeScript** (first contact) | reconnect only | §5 |
| `mesh_event` ←→ | TypeScript | no | |

Frames marked "Background? no" are not *refused* while backgrounded — they are **deferred** with the
typed response in §6. A frozen webview must never look like a peer that went away.

### Implementation status after M6

The table above is the settled destination, not a description of the whole tree. R3 moved two
rows: `ping`/`pong` and inbound `call`. `frames_served_by_rust_today()` in
`aurora-mesh-session` returns exactly `["call", "ping"]`, and a test fails if that list and the
ownership table drift apart. Everything else the table assigns to Rust — fragmentation,
`protocol_hello`, manifest, provider lease, subscriptions, reconnect auth — is still
`mesh-peer-bridge.ts`, dispatched when TypeScript is awake and queued in the per-peer FIFO when
it is not.

M6 closes the R3 tool-serving gap for a deliberately bounded native subset. Rust can execute the
four Tooling meta methods (`Tooling.GetTools`, `Tooling.GetExportCatalog`,
`Tooling.PrepareExecution`, `Tooling.ExecuteTool`) while the WebView is frozen, but the catalog it
projects contains only `aurora.local.native.get_device_status.v1` / `native.get_device_status`.
That tool is read-only, takes no arguments, requires no confirmation, and returns bounded native
status from the platform capability manifest. Foreground calls still go to the TypeScript local
tool provider and its full registry.

The security boundary remains the same: Rust asks the authority first, then serves, defers or
denies. A background Tooling method serves only when the decision grants the method id and the
native status tool contract id. Caller-supplied peer ids, permission labels, arguments and
confirmation tokens are ignored or rejected by schema-validated responses.

### Ordering guarantee

Rust holds one FIFO queue per peer for frames it has accepted but cannot complete without
TypeScript. Resume is a two-phase handoff: the shell enters `resuming`, delivers a drain batch, and
then acknowledges each delivered batch with a follow-up drain call. Rust keeps queuing arrivals
during `resuming`; only an acknowledged empty drain moves the surface to `foreground`, where new
frames dispatch directly again. R3's acceptance criterion — "drains queued frames in order on resume
with no re-pairing" — is a test against this queue, not an aspiration.

---

## 4. Who owns the negotiated `protocol_hello` limits

Split by origin, and it is not symmetric:

- **TypeScript composes the local hello.** `role` follows the node role, and the capability set is a
  product of rollout flags — `localProtocolCapabilities(flags, nodeRole)` in `web-thin-runtime.ts`
  turns `webrtc_fragmentation`, `webrtc_scoped_subscriptions` and the consumer-only role into the
  advertised list. That is policy, and policy stays in TypeScript. TypeScript hands Rust a composed
  hello; it does not hand Rust a set of flags to interpret.
- **Rust owns the negotiated result and is the only enforcer.** Once Rust fragments, only Rust can
  guarantee it stays inside `fragment_payload_bytes`, `max_logical_bytes`,
  `max_peer_aggregate_bytes`, `max_fragments` and `incomplete_ttl_seconds`. Re-deriving the
  negotiated limits in TypeScript would be a second enforcer that can disagree — the same class of
  bug the plan rejects for the authority. TypeScript receives the negotiated limits **read-only**,
  for diagnostics and for sizing its own outbound payloads before handing them down.
- **Renegotiation resets reassembly.** Today `setRemoteProtocol` (`mesh-peer-bridge.ts:691`) discards
  the reassembler and builds a fresh one bound to the new limits. Rust must keep that behaviour: a
  new hello invalidates every partial message from that peer. Carrying fragments across a
  renegotiation lets a peer widen `max_logical_bytes` mid-message.

### The hard ceiling sits under the negotiated limits

The measured single-message SCTP ceiling is **65,535 bytes** (65,535 round-trips; 65,536 does not;
131,072 fails outright). The negotiated limits are bounded well below it: `fragment_payload_bytes`
maxes at 16 KiB, and a fragment frame carries that payload base64-encoded (~21,848 chars) inside a
small JSON envelope — roughly 22 KB on the wire, a third of the ceiling. So correctly fragmented
Aurora traffic never approaches it.

The ceiling is therefore a **guard against anything that bypasses fragmentation**, not a routine
limit. R1 makes a single send above 65,535 bytes fail with a typed error rather than a panic or a
silent truncation. Rust owns that check because Rust owns the send.

---

## 5. What a backgrounded reconnect may do

A backgrounded reconnect runs without the TypeScript auth state machine
(`WebRtcPeerSession`'s `PeerSessionAuthPort`). Its permission envelope:

**May:**
- Re-run signaling for a peer whose stable id it **already holds a credential for**, and re-establish
  the `RTCPeerConnection` and data channel.
- Answer a `mesh_auth_challenge_v1` and present `mesh_auth_proof_v1` from the stored credential.
- Present `auth` / `reauth` with an existing credential.
- Re-send `protocol_hello` and re-negotiate limits.
- Re-announce its manifest and renew its provider lease.
- Serve inbound `call` frames under the authorization decision the stored grant already implies.

**May not:**
- **Pair.** No `pairing_v2_*` frame is originated or accepted while backgrounded. Room membership is
  not authority — every peer still needs its own SAS pairing and explicit approval, and that needs a
  human. A pairing attempt arriving at a backgrounded peer is deferred (§6), not denied, so a
  legitimate peer is not pushed into a failure path by the other side's lifecycle.
- **Accept a new stable identity.** A reconnect binds to the stable id already in the session
  registry. One stable id, one session: a stable identity presenting on a second transport is
  rejected, matching what Python already does.
- **Create or widen a grant.** The Rust authority is asked; it is not told. A reconnect can only
  produce a decision the existing grant already supports.
- **Re-use a reconnect challenge.** Challenges stay single-use per peer under the existing replay
  guard, which moves into Rust with the frames.
- **Rotate the room secret**, or act on a forget. Forgetting a peer revokes approval, not
  reachability, and it is a foreground action.

The practical consequence for R3's acceptance test: a phone that has been backgrounded for longer
than the 120 s `stale_peer_timeout_s` window must come back on the *same* credential, answer a
remote tool call with the *same* authorization decision it would make in foreground, and never show
a pairing prompt on resume.

---

## 6. The typed deferral response

A backgrounded phone stays **reachable** and **serves tools**, but **defers orchestration**. That
deferral is a typed error body on the existing `error` frame, not a timeout, not a silent drop, and
not `provider_unavailable` — which means something different (the provider is gone; the peer should
stop routing to it).

```jsonc
{
  "type": "error",
  "id": "<call id>",
  "correlation_id": "<call id>",
  "error": {
    "code": 503,
    "message": "deferred until the device is back in use",
    "reason_code": "orchestration_deferred",
    "retry_when": "peer_foreground"
  }
}
```

- `code: 503` follows the existing HTTP-shaped numeric codes in `webrtc-peer-host.ts`
  (400 validation, 403 revoked, 499 cancelled, 500 handler failure, 504 timeout). It is retryable by
  construction.
- `reason_code: "orchestration_deferred"` joins the existing `reason_code` vocabulary
  (`request_timeout`, `peer_authority_revoked`, `request_cancelled`, `handler_failed`,
  `schema_validation_failed`, `lease_expired`).
- `retry_when` is a new **optional** field on `PeerHostErrorBody` (`peer-host/types.ts:59`). It is
  additive, so an older peer that ignores it still sees a well-formed retryable 503. Its only value
  today is `"peer_foreground"`.

Rules:

1. **Deferral is not eviction.** The peer stays in the roster, keeps its lease, and keeps answering
   `ping`. A caller that receives a deferral must not drop the peer or re-pair. This is the same
   distinction R6 formalises for budget-driven shedding: *shedding a peer to stay inside budget must
   be distinguishable from a lost peer and must not cost a re-pair*.
2. **Only orchestration defers.** A tool call that the Rust side can authorize and execute against
   the `aurora_local_data_*` commands is answered, not deferred. Deferral is for work that needs the
   orchestrator, which lives in the frozen webview.
3. **The deferral is decided after authorization, not before.** An unauthorized call from a peer
   with no grant gets 403, whether foreground or background. Answering "deferred" to a caller that
   would have been denied leaks whether a grant exists.
4. **Product copy stays product copy.** `message` is user-facing if it ever surfaces, so it says
   "deferred until the device is back in use" — not "orchestration deferred, webview frozen". The
   machine-readable part is `reason_code`. See `product-copy-forbidden-terms.ts`.

---

## 7. Invariants this boundary carries, and where each is tested

Each needs a test that fails loudly. This table is the checklist those tests are written against;
the workstream that owns each is named.

| Invariant | Enforced at | Owner |
|---|---|---|
| Room membership is not authority — every peer needs its own SAS pairing and explicit approval | pairing stays TypeScript-and-foreground (§3, §5) | W3, W7 |
| A per-session signaling allowlist replaces `expectedStablePeerId` | the drop at `signaling-mqtt.ts:500` becomes a roster observation plus a per-session allowlist; a session accepts signaling only from the peer it belongs to | W3 |
| One stable id, one session | the session registry rejects a second transport for a known stable id (§1, §5) | W1 |
| Reconnect challenges stay single-use per peer | replay guard moves into Rust with the auth frames (§3) | R2, R3 |
| Authority contexts never cross peers | the Rust authority is keyed by peer identity and holds no transport state (§1) | R2 |
| One Aurora in the notification shade | one reference-counted foreground service shared by voice and mesh | R4 |
| Runtime is chosen by platform, never by lifecycle | the registry entry's transport half is a Rust handle in foreground and background alike (§1) | R1, R3 |
| Shedding is distinguishable from loss and costs no re-pair | the deferral body, and R6's "going away, keep my credential" signal (§6) | R3, R6 |
| Product copy stays product copy | `message` fields are product copy; `reason_code` carries the machine meaning (§6) | all |

---

## 8. What this means concretely

**For W1** — build the registry keyed by stable peer id, replacing the `session` / `bridge`
singletons at `runtime.ts:242,244` and the transport bound to one `defaultPeerId` at
`runtime.ts:466`. Each entry owns session, signaling port, bridge, pairing state and snapshot. Do
**not** put grants or permission evaluation on an entry — ask through
`PeerHostAuthorizationStore`. Keep the single-peer snapshot as a derived view so the existing
single-peer tests pass untouched. Enforce one-stable-id-one-session here.

**For W2** — the router dispatches on `request.peerId` into the per-peer bridge. `WebRtcMeshPeerBridge`
is already per-peer (`mesh-peer-bridge.ts:126`, constructed with one `remotePeerId`), so this is
routing, not a rewrite. An unroutable peer id fails with a typed error.

**For R2** — port `authority`, `authorization`, `grant-management`, `contract-registry` and `types`
into `rust/crates/aurora-mesh-authority`, expose via Tauri commands and `wasm-bindgen`, and
**delete** the TypeScript implementation. Two authorities is drift in the one layer where drift is a
vulnerability. Do not port session or transport state — it is not the authority's business.

**For R3** — Rust takes the rows marked Rust in §3, holds the per-peer FIFO for deferred work, and
answers with the §6 body. Fix `lastRecipientPeerId` (`webrtc-peer-host.ts:68`) here: it is a single
mutable "who did I last talk to", which is exactly the wrong shape once the host serves several
peers, and it is read as a fallback recipient at `webrtc-peer-host.ts:664`.

**Reference for W8's parity audit** — the Python per-peer state map is
`app/services/gateway/webrtc/rtc_client.py:391–515`. It is the row-by-row target: every entry there
is either matched in the SDK or carries a written exclusion.

# Mesh Roadmap ↔ UI Production Task Integration Review

**Date:** 2026-06-14  
**Scope:** `.omx/multica/mesh-roadmap-tasks`, `.omx/specs/ui-production-tasks`, `modules/ui-mock-reference`, and mesh/gateway source anchors.  
**Constraint:** Multica server is unavailable by user instruction; No `multica` CLI/API calls were run. This review uses local files only.

## Executive decision

The mesh roadmap materially changes the final shape of the UI roadmap. The UI task set is directionally correct, but it should not be treated as final, ready-to-execute production work for mesh-dependent surfaces until the mesh roadmap has at least completed P0-P2, and ideally until P0-P6 is either implemented or explicitly deferred.

Recommended path:

1. **Implement mesh roadmap P0-P2 first as contract-freezing work.** These tasks define stable identity, diagnostics, auth/token semantics, config parity, E2EE behavior, capability graph, hybrid addressing, and provider aggregation.
2. **Run a UI spec sync immediately after P0-P2.** Update SDK contracts, backend contract tasks, mock data/types, and mesh UI tasks against the real implemented models.
3. **Implement mesh P3-P6 before executing UI tasks that expose remote tools, data/RAG sharing, remote audio, delegated scheduler, Auth/Config mesh exposure, distributed tracing, and chaos/failure diagnostics.**
4. **Only then push or execute mesh-facing UI tasks as production-ready tickets.** If board visibility is needed earlier, push them as blocked/backlog tasks with explicit cross-links to mesh issues, not as ready-to-run work.

This recommendation is stronger than “push everything and patch later” because the current backend code still contains the exact classes of instability the mesh roadmap is designed to fix.

## Evidence inspected

### Mesh roadmap artifacts

- `.omx/multica/mesh-roadmap-tasks/00-meshepic-mesh-polishing-roadmap-secure-cross-peer-service-fabric.md`
- `.omx/multica/mesh-roadmap-tasks/01-*` through `20-*`
- `.omx/multica/mesh-roadmap-tasks/task-index.json`
- `.omx/multica/mesh-roadmap-tasks/created-issues.json`
- `.omx/multica/mesh-roadmap-tasks/generate_and_push.py`
- `.omx/multica/mesh-roadmap-tasks/resume_push.py`

`created-issues.json` already records the mesh board upload:

- Project: `5345dd7c-2f0b-4a4b-b636-c1db93067f0a`
- Parent issue: `PER-126`
- Child issues: `PER-127` through `PER-146`
- `expected_count: 21`
- `mesh_issue_count: 21`

### UI task artifacts

- `.omx/specs/ui-production-tasks/manifest.md`
- `.omx/specs/ui-production-tasks/tasks/*.md` — 97 task files
- Key mesh-sensitive tasks:
  - `SDK-006`, `SDK-010`, `SDK-012`, `SDK-014`
  - `BE-013`, `BE-014`, `BE-017`, `BE-018`
  - `MESH-001` through `MESH-004`
  - `ADM-006`, `ADM-008`, `ADM-009`, `ADM-011`, `ADM-013`
  - `UI-002`, `UI-005`, `UIA-003`, `UIA-004`, `UIA-006`
  - `QA-008`

### Mock source artifacts

- `modules/ui-mock-reference/components/aurora/mesh/mesh-view.tsx`
- `modules/ui-mock-reference/components/aurora/assistant/route-sheet.tsx`
- `modules/ui-mock-reference/components/aurora/admin/devices-view.tsx`
- `modules/ui-mock-reference/components/aurora/admin/overview.tsx`
- `modules/ui-mock-reference/components/aurora/diagnostics/diagnostics-view.tsx`
- `modules/ui-mock-reference/lib/aurora/types.ts`
- `modules/ui-mock-reference/lib/aurora/data.ts`

### Backend source evidence that mesh semantics are not yet stable

- `app/services/gateway/webrtc/rtc_client.py:90-102` still supports a legacy `_default` saved token.
- `app/services/gateway/webrtc/rtc_client.py:830-835` skips reverse pairing when *any* saved token exists, not when this peer has a scoped token.
- `app/services/gateway/webrtc/rtc_client.py:915-929` sends `next(iter(self._saved_auth_tokens.values()), None)` on DataChannel open, which is single-peer-biased and unsafe for multi-peer mesh.
- `app/services/gateway/mesh/routing_table.py:77-100` resolves network routing to one `get_best_provider()` result.
- `app/services/gateway/mesh/peer_registry.py:318-335` exposes provider selection as single best provider, even though future UI wants provider aggregation and explainability.
- `app/services/gateway/config.py:10-36` runtime mesh service config includes `allowed_peers`, `min_version`, and `required_capabilities`.
- `app/services/config/config_schema.json:1198-1220` generated config schema only exposes `share`, `max_concurrent`, `prefer`, and `fallback` in the inspected region.
- `app/shared/config/models.py:598-615` generated `MeshSharing` likewise lacks `allowed_peers`, `min_version`, and `required_capabilities`.

## Mesh roadmap impact matrix

| Mesh task | Existing Multica issue | UI impact | UI/spec tasks affected | Mock impact |
|---|---:|---|---|---|
| P0-T01 regression truth map/test matrix | `PER-127` | Establishes real mesh behavior baseline and mode matrix before UI parity tests. | `QA-008`, `SDK-014`, `MESH-*` | Add fixture states for known-good, degraded, partitioned, and unsupported mesh. |
| P0-T02 mesh status/route diagnostics | `PER-128` | Defines diagnostics payloads that UI must render instead of inventing. | `BE-014`, `MESH-004`, `ADM-009`, `ADM-013` | Expand diagnostics mock with ICE/signaling/channel/auth/route timeline. |
| P1-T01 stable identity | `PER-129` | Peer identity becomes stable across WebRTC/Auth/registry/manifests. | `ADM-011`, `MESH-001`, `MESH-002`, `SDK-004`, `SDK-006`, `SDK-010` | Add stable peer ID vs session ID vs device/principal identity. |
| P1-T02 peer-scoped tokens | `PER-130` | UI must show credential state per peer, not global connection status. | `ADM-004`, `ADM-005`, `ADM-011`, `MESH-001`, `MESH-002`, `TAURI-003` | Add token state: missing, valid, expired, revoked, wrong-peer, rotation-needed. |
| P1-T03 bilateral reverse pairing | `PER-131` | Pairing UI must distinguish one-way, reverse-pending, bilateral-trusted. | `ADM-011`, `MESH-001`, `MESH-002`, `UI-003` | Add bilateral state machine and asymmetric permission display. |
| P1-T04 config schema parity | `PER-132` | Config UI and route policy editor need real schema fields. | `ADM-006`, `MESH-003`, `SDK-012`, `BE-010`, `BE-013` | Add allowed peers, min version, required capability, fallback/prefer combinations. |
| P1-T05 app-layer E2EE behavior | `PER-133` | UI must report DTLS-only vs app-layer E2EE status honestly. | `BE-014`, `MESH-004`, `UI-005`, `SDK-012`, `QA-003` | Add encryption status badges, compatibility warnings, blocked route reasons. |
| P2-T01 capability graph models | `PER-134` | This is the backend source of truth for `SDK-006`; do not freeze SDK graph before it. | `SDK-006`, `BE-002`, `BE-013`, `UI-002`, `ADM-001`, `ADM-013` | Replace simple peer/service arrays with capability graph/provider nodes. |
| P2-T02 hybrid addressing | `PER-135` | RouteSheet and policy engine need selectors for peer/provider/resource/namespace/tool/hardware/data scope. | `SDK-010`, `SDK-012`, `MESH-003`, `UI-005`, `UIA-*` | Add selector editor/summary states and route explanation examples. |
| P2-T03 provider aggregation | `PER-136` | UI must render candidate sets, not one selected remote. | `BE-013`, `SDK-006`, `SDK-012`, `MESH-003`, `UI-005` | Add provider ranking, exclusion reasons, capacity/version/trust comparison. |
| P3-T01 remote tool IDs/metadata | `PER-137` | Tool list and approval cards need remote provenance and stable tool identity. | `BE-011`, `UIA-003`, `ADM-007`, `SDK-006`, `SDK-013` | Add remote tool source, owner peer, namespace, stable remote ID. |
| P3-T02 remote tool execution/audit | `PER-138` | UI approvals must show route, peer, audit provenance, and remote failure classes. | `UIA-003`, `ADM-008`, `ADM-009`, `SDK-012`, `SDK-013` | Add remote tool execution receipt and redacted payload trail. |
| P3-T03 orchestrator local+remote binding | `PER-139` | Assistant route explanations must show why a tool was local/remote/blocked. | `UIA-001`, `UIA-003`, `UIA-007`, `UI-005` | Add mixed local/remote tool plan states. |
| P4-T01 DB/data sharing modes | `PER-140` | Admin/config/memory UI must understand per-domain ownership policy. | `BE-017`, `ADM-010`, `ADM-006`, `UIA-006`, `SDK-012` | Add data domain ownership, export/delete limitations, conflict risk. |
| P4-T02 RAG/memory replication | `PER-141` | Memory UI must show provenance, replication, conflict, tombstone, peer source. | `BE-017`, `UIA-006`, `ADM-010`, `QA-003` | Add replicated memory cards and conflict resolution states. |
| P5-T01 remote audio boundaries | `PER-142` | Voice UI must separate mic streaming, remote STT, remote TTS synthesis, and playback. | `UIA-004`, `UI-004`, `AND-005`, `IOS-006`, `SDK-006` | Add audio boundary warnings and consent prompts. |
| P5-T02 remote scheduler policy | `PER-143` | Scheduler admin UI must understand namespace/delegated action boundaries. | `BE-018`, `ADM-012`, `SDK-013`, `QA-003` | Add delegated job namespace and remote action provenance. |
| P5-T03 Auth/Config exposure boundaries | `PER-144` | RBAC/config dashboards must not expose mesh-internal capabilities by accident. | `ADM-003`, `ADM-004`, `ADM-006`, `ADM-011`, `BE-004`, `BE-010`, `SDK-005` | Add mesh-exposure disabled/denied/explained states. |
| P6-T01 distributed tracing/audit | `PER-145` | Diagnostics and audit need correlation IDs across HTTP/local/mesh hops. | `BE-005`, `ADM-008`, `ADM-009`, `MESH-004`, `QA-008` | Add trace waterfall and cross-peer audit receipts. |
| P6-T02 chaos/failure suite | `PER-146` | QA and UX must cover partitions, stale peers, bad tokens, route fallback, partial trust. | `QA-008`, `QA-005`, `QA-006`, `MESH-*`, `UIA-002` | Add failure-mode fixtures and visual states. |

## UI tasks that must be updated after mesh P0-P2

These tasks should not be final-frozen until mesh P0-P2 lands:

- `SDK-006 — Implement capability graph engine`
  - Needs backend mesh capability graph models from `PER-134`.
  - Must represent provider nodes, service instances, trust tier, latency/capacity/version, policy decisions, and unavailable reasons.
- `SDK-010 — Implement mesh/P2P transport interface`
  - Needs peer-scoped identity/token/session semantics from `PER-129`/`PER-130`/`PER-131`.
  - Needs route addressing shape from `PER-135`.
- `SDK-012 — Implement route/privacy policy engine`
  - Needs config schema parity from `PER-132`, E2EE decision from `PER-133`, and provider aggregation from `PER-136`.
- `BE-013 — Add peer capability manifest and mesh route explain contracts`
  - Should be rebased onto mesh roadmap outputs instead of independently inventing a UI-serving manifest.
- `BE-014 — Add WebRTC/ICE/data-channel diagnostics endpoints/events`
  - Should be rebased onto mesh diagnostics/status contracts from `PER-128` and E2EE/auth state from `PER-133`.
- `MESH-001` through `MESH-004`
  - Current tasks cover the right UI surfaces but not all final mesh state dimensions.
- `QA-008 — Build thread/process/mesh transport parity gate`
  - Should wait for diagnostics/tracing and chaos outputs, otherwise it will be mostly mock-driven.

## UI mocks that need another pass

The current mock is useful for product direction, but it is not enough for the post-roadmap mesh end-state.

Required mock additions:

1. **Mesh identity/session split**
   - Stable peer identity
   - Live WebRTC session/channel state
   - Device/principal/token identity
   - One-way vs bilateral trust
2. **Peer-scoped credential state**
   - Per-peer token lifecycle
   - Expired/revoked/wrong-peer token warnings
   - Rotation/re-auth affordances
3. **Capability graph and provider aggregation**
   - Provider graph/tree
   - Multiple providers per service/module/tool
   - Exclusion reasons: version, trust, capacity, policy, missing capability, latency
4. **Hybrid route selector UI**
   - Peer selector
   - Provider selector
   - Resource namespace selector
   - Tool ID selector
   - Hardware target selector
   - Data-scope selector
5. **RouteSheet/E2EE expansion**
   - DTLS-only vs app-layer E2EE
   - Payload privacy class
   - Route decision receipts
   - Blocked/fallback explanation
6. **Remote tool provenance**
   - Tool owner/source peer
   - Stable remote tool ID
   - Remote execution receipt
   - Approval card redacted payload and route path
7. **Data/RAG sharing and replication**
   - Domain ownership
   - Replication state
   - Provenance chain
   - Conflict/tombstone UI
8. **Remote audio boundaries**
   - Local microphone capture vs remote STT
   - Remote TTS synthesis vs local playback
   - Explicit consent and platform limits
9. **Remote scheduler delegation**
   - Namespace-aware jobs
   - Delegated action policy
   - Remote execution/audit origin
10. **Mesh diagnostics and chaos states**
    - ICE/signaling/DataChannel/auth timeline
    - Correlation ID waterfall
    - Partition, stale manifest, route fallback, partial trust, bad token, version mismatch

High-priority mock files to update after mesh contracts freeze:

- `modules/ui-mock-reference/components/aurora/mesh/mesh-view.tsx`
- `modules/ui-mock-reference/components/aurora/assistant/route-sheet.tsx`
- `modules/ui-mock-reference/components/aurora/admin/devices-view.tsx`
- `modules/ui-mock-reference/components/aurora/admin/secondary-surface.tsx`
- `modules/ui-mock-reference/components/aurora/diagnostics/diagnostics-view.tsx`
- `modules/ui-mock-reference/components/aurora/admin/audit-view.tsx`
- `modules/ui-mock-reference/components/aurora/admin/config-view.tsx`
- `modules/ui-mock-reference/lib/aurora/types.ts`
- `modules/ui-mock-reference/lib/aurora/data.ts`

## Recommended implementation/order strategy

### Track A — Mesh roadmap first

Run mesh tasks in their existing order. Treat the following as **UI contract gates**. In this document, a gate means the relevant backend contracts and tests have landed and are stable enough for UI task sync; it does not mean the UI should assume unimplemented behavior:

1. **Mesh gate 1: Identity/security gate**
   - `PER-127` through `PER-133`
   - Establishes the contract baseline for peer identity, token scoping, bilateral pairing, config parity, and E2EE behavior.
2. **Mesh gate 2: Capability/routing gate**
   - `PER-134` through `PER-136`
   - Establishes the contract baseline for capability graph, addressing primitives, provider aggregation, and route explain shape.
3. **Mesh gate 3: Remote execution/data/audio/admin gate**
   - `PER-137` through `PER-144`
   - Establishes the contract baseline for remote tools, orchestrator binding, data/RAG policy, audio boundaries, scheduler policy, Auth/Config exposure.
4. **Mesh gate 4: Observability/reliability gate**
   - `PER-145` through `PER-146`
   - Establishes the contract baseline for tracing, audit views, and chaos/failure-mode test expectations.

### Track B — UI work that can proceed before mesh completion

These can be pushed/executed earlier **only for non-mesh baseline scope**. Any mesh-expanded fields, remote provenance, selector semantics, cross-peer policy, or versioned credential schema must remain deferred until the relevant mesh gate closes:

- `P0-001`, `P0-002`, `P0-003`, `P0-004`
- `SDK-001`, `SDK-003`, `SDK-004`, `SDK-005`, `SDK-007`, `SDK-008`, `SDK-009`, `SDK-011`, `SDK-013` with a guardrail not to finalize mesh-specific permission expansion, graph/policy fields, remote provenance, or delegated action receipts
- `BE-001`, `BE-002`, `BE-003`, `BE-004`, `BE-005`, `BE-006`, `BE-007`, `BE-008`, `BE-009`, `BE-010`, `BE-011`, `BE-012`, `BE-015`, `BE-016`, and baseline `BE-018` where they are not implementing mesh-expanded semantics yet. For `BE-018`, only local/server scheduler management can proceed early; delegated remote scheduler semantics wait for `PER-143`.
- `TAURI-001` through `TAURI-007` as shell/bridge/sidecar work, provided secure storage keeps mesh credential schemas versioned and migratable
- Android/iOS native baseline tasks, as long as native capability manifests are designed to consume SDK capability graph updates later
- Generic app shell and non-mesh assistant/admin visuals with mesh controls capability-gated

### Track C — UI work to hold until mesh gate 2 at minimum

- `SDK-006`
- `SDK-010`
- `SDK-012`
- `SDK-014`
- `BE-013`
- `BE-014`
- `UI-002`
- `UI-005`
- `ADM-001`/`ADM-013` mesh-capability parts
- `MESH-001` through `MESH-004`
- `QA-008`

### Track D — UI work to hold until mesh gate 3/4 if it exposes distributed semantics

- `UIA-003` remote tools and approvals
- `UIA-004` remote audio paths
- `UIA-006` memory/RAG provenance and replication
- `ADM-006` mesh config fields
- `ADM-008` distributed audit
- `ADM-009` trace/support bundles
- `ADM-012` delegated scheduler
- `QA-003` mesh privacy/security cases
- `QA-005`/`QA-006` degraded/offline/release runbooks with mesh claims

## Should the mesh implementation be worked out first?

Yes, for production readiness.

The strongest recommendation is:

- **Implement mesh P0-P2 before freezing/pushing final mesh-dependent UI tasks.**
- **Implement all mesh P0-P6 before declaring the full UI roadmap production-ready end-to-end.**
- **Do not push all UI tasks as ready-to-run now** unless they are explicitly marked as blocked by the mesh issues and expected to be revised.

Reason: the mesh roadmap changes model identity, routing shape, policy fields, provider cardinality, provenance, diagnostics, and failure modes. Those are not cosmetic details; they affect SDK public API, UI task acceptance criteria, mock types, tests, and security/privacy copy.

A practical compromise if task-board visibility is needed:

1. Push UI epic and non-mesh foundation tasks now.
2. Push mesh-sensitive UI tasks only with labels such as `blocked-by-mesh-roadmap`, `contract-sync-required`, and dependency links to `PER-127..PER-146`.
3. Add a single required task: **UI-MESH-SYNC — Rebase UI SDK/mocks/tasks after mesh roadmap gates**.
4. Do not schedule implementation of blocked mesh UI tasks until the corresponding mesh gate is closed.

## Multica push tooling reuse

The mesh roadmap includes reusable local patterns for pushing future UI tasks, but the scripts should not be run now and should not be copied verbatim without generalization.

Reusable patterns from `.omx/multica/mesh-roadmap-tasks/generate_and_push.py` and `resume_push.py`:

- Structured task metadata emits one markdown file per task.
- `task-index.json` is the resumable source of truth.
- Parent epic is created first.
- Children are linked to the parent.
- Labels are ensured before issue creation.
- Created issues are recorded in `created-issues.json`.
- Upload can resume from title matches and existing created issue ledger.
- Final count is verified against `expected_count`.

Recommended UI push workflow later:

1. Create `.omx/multica/ui-production-tasks/`.
2. Generate a UI `task-index.json` from `.omx/specs/ui-production-tasks/manifest.md` plus task markdown files.
3. Add a cross-roadmap dependency map that records which UI tasks are blocked by `PER-127..PER-146`.
4. Reuse the created-issues ledger shape.
5. Prefer refactoring the mesh scripts into a generic `multica_issue_push.py` helper with pluggable project ID, epic title, labels, source directory, and transport adapter.
6. When Multica is available, run a dry-run/list-only preflight first, then upload/resume.

Do not reuse hardcoded mesh values:

- Mesh project ID and labels
- Mesh epic title
- Mesh `COMMON_CONTEXT`
- Mesh task array embedded in `generate_and_push.py`
- Any direct CLI invocation while the server is unavailable

## Required updates to current UI specs after mesh gates

After mesh gate 2, update these specs/tasks:

- `.omx/specs/ui-refinement/aurora-ui-sdk-contract.md`
  - Add mesh capability graph primitives.
  - Add stable identity/session/credential model.
  - Add provider aggregation and hybrid addressing selectors.
  - Add route explain decision/receipt schema.
- `.omx/specs/ui-production-tasks/tasks/SDK-006-*.md`
  - Depend on mesh capability graph contracts, not only generated gateway registry.
- `.omx/specs/ui-production-tasks/tasks/SDK-010-*.md`
  - Add P2P transport identity/session/token state, connection lifecycle, and route RPC envelope details.
- `.omx/specs/ui-production-tasks/tasks/SDK-012-*.md`
  - Add E2EE, provider aggregation, privacy class, fallback, and selector policy.
- `.omx/specs/ui-production-tasks/tasks/BE-013-*.md`
  - Align with mesh P2 capability/routing output.
- `.omx/specs/ui-production-tasks/tasks/BE-014-*.md`
  - Align with mesh P0/P1 diagnostics/auth/E2EE output.
- `.omx/specs/ui-production-tasks/tasks/MESH-001-*.md` through `MESH-004-*.md`
  - Add stable identity, peer-scoped credentials, bilateral pairing, E2EE, provider graph, hybrid route explain, and failure modes.
- `.omx/specs/ui-production-tasks/tasks/QA-008-*.md`
  - Add concrete matrix cases from mesh chaos/failure suite.

After mesh gates 3 and 4, update:

- `UIA-003`, `UIA-004`, `UIA-006`
- `ADM-006`, `ADM-008`, `ADM-009`, `ADM-012`
- `BE-017`, `BE-018`
- `QA-003`, `QA-005`, `QA-006`, `QA-007`

## Decision options for the user

### Option 1 — Recommended: mesh-first, then final UI push

- Finish mesh roadmap implementation first.
- Re-run UI spec/task/mock sync.
- Push finalized UI tasks to Multica.

Best for correctness and least rework.

### Option 2 — Hybrid: push UI foundations now, hold mesh-dependent tasks

- Push UI epic, P0, generic SDK, HTTP/Tauri shell, and non-mesh backend/admin work.
- Keep mesh-sensitive UI tasks blocked until mesh gates close.

Best if you want board momentum while avoiding contract churn.

### Option 3 — Push all UI tasks now as blocked backlog

- Push everything, but mark mesh-sensitive tasks blocked by `PER-127..PER-146` and require a future sync task.

Best for visibility only. Highest risk of stale task details and duplicated updates.

### Option 4 — Push all UI tasks now as ready-to-run

Not recommended. It would freeze unstable mesh assumptions into SDK, mocks, acceptance criteria, and QA.

## Bottom line

The mesh roadmap is a prerequisite roadmap for the most complex parts of the UI. The current UI tasks are good as a broad implementation plan, but the mesh-facing subset needs a contract sync after mesh P0-P2 and another sync after P3-P6. The safest production path is to complete mesh first, reuse the mesh Multica push pattern later for UI, and avoid spending implementation effort on UI routes/types/mocks that will be invalidated by the mesh contract changes.

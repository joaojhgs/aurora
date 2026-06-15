# Deep Interview Spec: UI All-in-One Distributed Assistant

- Source transcript: `.omx/interviews/ui-all-in-one-distributed-assistant-20260610T194238Z.md`
- Context snapshot: `.omx/context/ui-all-in-one-distributed-assistant-20260610T192332Z.md`
- Crystallized: 20260610T194238Z
- Mode: roadmap/spec only; no source implementation.

## Intent

Design a durable, all-in-one UI architecture for Aurora that preserves the existing bus-first service model while enabling:

1. Cloud/server UI over the HTTP Gateway.
2. Standalone desktop UI packaged with Tauri and local offline Python services.
3. P2P mesh UI shell that routes work to peer capabilities.
4. Android/iOS bundles with native OS integration and realistic mobile inference plans.
5. A reusable Admin / Operator Console for server deployments, local nodes, and authorized mesh peers.

## Non-Goals

- No source-code implementation or scaffolding in this planning pass.
- No claim that iOS can replace Siri globally. Use supported Apple integration surfaces only.
- No premature rejection of official Tauri/Rust or Python-backed Tauri. Both must remain in the decision matrix until evidence gates complete.
- No direct service-method calls from UI; communication must remain contract/bus/gateway mediated.
- Admin/control-plane operations must use scoped contracts, `manage` authorization, confirmation/diff UX, and audit logging.

## Must-Have Plan Sections

- Architecture decisions.
- Platform feasibility matrix.
- UX/product surface map.
- Build/release roadmap.
- Security/privacy model.
- Admin / Operator Console requirements and surface map.

## Acceptance Criteria for the Plan

- References repo evidence for current UI, gateway, bus, mesh, and dependency constraints.
- Cites current official/upstream sources for Tauri mobile, Tauri sidecars/plugins, Android assistant role, Apple App Intents/SiriKit, and mobile inference options.
- Defines a transport abstraction that supports HTTP, local native/Tauri, and P2P mesh without forking product UI.
- Defines how Admin Console surfaces reuse the same UI/client layer across server, local, mesh, desktop, and mobile modes.
- Separates UI/product surfaces from backend execution/runtime choices.
- Defines feasible desktop/mobile packaging tracks with decision gates instead of one-way assumptions.
- Includes a roadmap with phase gates, risks, security/privacy requirements, and verification steps.

## Handoff

Use `.omx/plans/ui-all-in-one-distributed-assistant-roadmap.md` as the primary follow-up plan. Recommended next execution mode after plan acceptance is `$ultragoal` for durable goal tracking, with `$team` for parallel implementation/research lanes.

## Change Request Addendum — 2026-06-10 20:25:59Z

User added that the same UI must also serve as an Admin / Operator Dashboard for server deployments and reusable local/mesh/mobile admin subsets. This is now part of the plan scope:

- RBAC/principals/permissions/tokens/devices.
- Peer pairing, mesh trust, and peer permission management.
- Service registry, service health, generated routes, and diagnostics.
- Service configuration, validation, plugin management, and reload/status visibility.
- Audit/compliance views and admin action provenance.

The dashboard is not a separate product; it is a permission-scoped domain inside the same transport-adaptive Aurora UI.

# Aurora UI reference mock

This module is a visual reference application generated from the Aurora UI planning artifacts and completed as a UI-only mock. It is not production runtime code, not the production Tauri implementation, and does not wire to the Aurora Gateway, LocalBus, MeshBus, or native plugins.

## Scope covered

Primary routes:

- `/` assistant cockpit: conversation, route/privacy sheet, tool approval visuals, activity rail.
- `/onboarding`: server web, desktop local, mesh shell, mobile thin/local-light, and offline demo entry paths.
- `/mesh`: peer topology, trust queue, route-preview states, and peer approval confirmation.
- `/models`: local/server/mesh/mobile runtime inventory, routing policy, benchmark snapshots, and mobile local-light constraints.
- `/diagnostics`: health probes, redacted export preview, event timeline, and export confirmation.
- `/settings`: privacy, voice, desktop native, Android assistant-role, and iOS App Intents/Shortcuts permission surfaces.
- `/memory` and `/tools`: existing v0 assistant support surfaces.

Admin/operator routes:

- `/admin`: overview.
- `/admin/services`: service health and service-control visuals.
- `/admin/access`: RBAC/principal/permission visuals.
- `/admin/tokens`: token creation/revoke visuals.
- `/admin/devices`: paired/trusted/revoked device visuals.
- `/admin/config`: config edit/diff/restart-risk visuals.
- `/admin/audit`: audit log visuals.
- `/admin/contracts`: Gateway/Bus contract and SDK envelope readiness visuals.
- `/admin/plugins`: plugin/MCP/native bridge management visuals.
- `/admin/pairing`: device and mesh pairing workflow visuals.
- `/admin/backups`: backup/restore policy and missing-contract visuals.

## Design-system notes

- The app intentionally keeps the v0/shadcn/Tailwind visual language: compact cards, muted operational surfaces, status pills, route/privacy badges, confirmation dialogs, and diff previews.
- Feature availability is driven by fixture data in `lib/aurora/data.ts` and typed states in `lib/aurora/types.ts`, including backend coverage labels (`implemented`, `partial`, `internal_only`, `missing_contract`, `planned`, `mock_only`).
- High-impact operator actions use `AdminConfirmDialog` to show the target, impact, diff/metadata, action draft id, payload digest, nonce/expiry, confirmation mode, and audit expectation.
- Route selection explicitly shows local/remote/mesh/native mobile options and the sensitive-route guard from the planning specs, including a redacted payload/target/audit preview shape.

## Running the mock

```bash
cd modules/ui-mock-reference
pnpm install --store-dir /tmp/aurora-pnpm-store
pnpm dev
```

## Quality harness

The package owns its frontend-readiness checks so future UI/SDK work can run the same command set in local development and CI:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The combined gate is:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

These checks validate only the reference package. They do not prove Gateway, mesh, native, Tauri IPC, audio, storage, or backend service behavior.

## Future implementation boundary

The production client should reuse this mock as a visual/component reference only. Import or migrate components deliberately into the future production package; do not run this module as backend-integrated UI. Actual implementation should be built around the planned `AuroraClient` SDK, capability graph, admin action wrapper, official Tauri 2/Rust shell, desktop Python sidecar for local mode, HTTP Gateway transport for server mode, Mesh/WebRTC transport for peer mode, and mobile native plugins for Android/iOS capability providers.

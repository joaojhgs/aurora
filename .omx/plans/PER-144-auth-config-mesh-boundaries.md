# PER-144 Plan: Auth and Config Mesh Exposure Boundaries

## Requirements Summary

- Source issue: PER-144 `[MESH][P5-T03] Define Auth and Config mesh exposure boundaries`.
- Scope: make Auth/Config mesh exposure policy explicit, keep pairing/login infrastructure working, and avoid config defaults that imply unsupported broad Auth/Config sharing.
- Privacy constraint: Auth credentials, token state, peer trust, and local configuration remain local-authoritative by default.
- Message-bus constraint: preserve RPC-to-bus behavior; do not call service implementations directly.
- Referenced `.omx/specs/deep-interview-mesh-distributed-integration.md` and `.omx/multica/mesh-roadmap-tasks/*` are absent from this checkout after fetching the latest migration branch. Adjacent PER-132 and PER-140 plans document the same missing-doc fallback.

## Exposure Categories

- Infra-required: `Auth.PairingStart`, `Auth.PairingConnect`, `Auth.PairingExchange`, and `Auth.Login` stay available to unauthenticated WebRTC peers through the existing RPC infrastructure bypass.
- Local peer administration: Auth mesh peer list/get/approve/deny/update/remove contracts are local admin surfaces. They may be exposed through local Gateway routes with normal permissions, but are not automatically shared as a mesh provider.
- Broad Auth admin: principal, token, permission, device, audit, and password management are never transparently routed by default.
- Config diagnostics/mutation: Config get/validate/plugin reads and Config set/plugin writes are not transparently routed by default; config mutation stays local unless a future explicit remote-admin policy is designed.
- Never-share: raw credential material, token hashes, inbound mesh tokens, API keys, and config secrets.

## Implementation Steps

1. Remove `services.auth.mesh_sharing` and `services.config.mesh_sharing` from the config schema so generated defaults and keys stop advertising unsupported broad mesh sharing knobs.
2. Regenerate config artifacts from schema.
3. Keep Gateway mesh config service wiring limited to currently supported shared service modules.
4. Add focused RPC tests that broad Auth/Config calls are denied when not explicitly shared, while pairing/login infrastructure still bypasses ordinary service sharing gates.
5. Add an explicit test that manually shared Auth still requires normal method permissions, proving sharing is not enough to bypass RBAC.
6. Update pairing/config docs to name the Auth/Config exposure categories and explain infrastructure bypass behavior.

## Acceptance Criteria

- Auth/Config sharing policy is explicit in docs.
- Config schema, generated defaults, generated keys, and generated models no longer imply Auth/Config are supported mesh-shareable services.
- Pairing/login infrastructure remains functional through WebRTC RPC.
- Broad Auth/Config calls are denied by the mesh sharing gate unless an explicit in-memory service sharing policy is present.
- Explicit sharing does not bypass Auth/Config method permissions.

## Verification Strategy

- `make generate-config`
- `make check-config-generated`
- `uv run pytest tests/unit/gateway/test_rpc.py tests/unit/app/config/test_mesh_sharing_schema.py -q`
- `git diff --check`

## Risks and Mitigations

- Risk: removing Auth/Config mesh keys could surprise operators who saw generated defaults. Mitigation: docs state these were not wired into Gateway mesh service sharing and broad remote admin remains unsupported.
- Risk: confusing pairing/login bypass with broad Auth sharing. Mitigation: docs and tests separate infra-required methods from Auth admin methods.
- Risk: future remote admin work needs config surfaces. Mitigation: leave room for a future explicit policy instead of silently exposing current broad contracts.

## Stop Condition

PER-144 is ready for QA when generated config artifacts are in sync, RPC and config tests pass, docs describe the policy, a commit is pushed, and a PR is opened.

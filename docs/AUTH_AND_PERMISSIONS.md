# Auth and permissions

**Status:** Current source of truth

Aurora separates identity, permission policy, and service execution. External callers enter through Gateway/Auth boundaries; service work still happens through typed bus contracts.

## Components

| Component | Path | Responsibility |
| --- | --- | --- |
| AuthService | `app/services/auth/` | Pairing records, token/principal records, auth audit events, and auth contract methods. |
| Gateway ACL | `app/services/gateway/acl/` | Request identity extraction, permission checks, audit context, and route enforcement. |
| Gateway auth proxy | `app/services/gateway/auth_proxy.py` | Gateway-to-AuthService request boundary. |
| Contract metadata | `@method_contract(... required_perms=...)` | Declares required permission strings for exposed methods. |
| Shared auth models | `app/shared/auth/` and `app/shared/contracts/models/auth.py` | Typed principal/token/pairing/audit payloads. |

## Principal and token model

Aurora uses principals to represent authenticated users, devices, peers, or service actors. Tokens are tied to principals and are checked at Gateway/API boundaries. Mesh pairing flows also create or negotiate peer trust material before service access is allowed.

The exact token/pairing payloads live in `app/shared/contracts/models/auth.py` and are served through AuthService contract methods.

## Permission strings

Permissions are service/topic oriented. Method contracts may declare required permissions such as:

```python
@method_contract(
    method_id=BackupMethods.CREATE,
    exposure="external",
    method_type="manage",
    required_perms=["Backup.manage"],
)
```

Common forms:

| Form | Meaning |
| --- | --- |
| `Service.use` | Permission to invoke normal/use methods for a service area. |
| `Service.manage` | Permission to invoke administrative or mutating methods. |
| `Service.*` | Service-wide wildcard where policy permits it. |
| Explicit method/topic permission | Fine-grained method control for sensitive surfaces. |

Contract-required permissions are additive with Gateway/Auth policy. Do not bypass them by calling service methods directly.

### Speech permissions and voice ownership

Speech projection applies the same exact, wildcard, type-level, and global permission matching as every other service:

- `TTS.GetCapabilities` and `TTS.ListVoices` are use-safe discovery methods guarded by `TTS.use`; `TTS.Synthesize` declares the exact `TTS.Synthesize` permission and is also eligible under an applicable use-level or wildcard grant.
- `TTS.ListVoiceProfiles`, `TTS.GetVoiceProfile`, profile update/install/remove/default operations, bounded voice import, and profile create/delete are `method_type="manage"` and require `TTS.manage`.
- A recipient projection contains only methods authorized for that peer. A forged caller permission, method type, or manifest field cannot add a management method that was not granted.
- Use-safe voice listing returns only standard voices and cloned voices visible to the authenticated owner or allowed peer. Administrative profile inventory remains separate and omits source paths, uploaded media, engine internals, and other private storage details.
- Voice-management mutations carry a payload-bound `operation_id`. Replaying the same operation is idempotent; reusing the ID with different input is rejected. The first attempted mutation emits one redacted required audit record before side effects, and an audit-storage failure blocks the mutation.

Permission, visibility, capability, and provider availability are conjunctive gates. Passing one never bypasses the others.

## External request flow

```text
HTTP/SSE/WebRTC request
  -> Gateway identity extraction
  -> Auth/ACL permission check
  -> generated route or mesh peer bridge
  -> bus request/event with typed model
  -> service method contract
  -> audit/result metadata returned to caller
```

## WebRTC client auth validation

WebView client peers use the same public production Auth/Gateway permission boundary as Python peers. The maintained Chromium/Firefox/Playwright-WebKit direct, STUN, and forced-TURN reports, hosted Chromium peer flow, hosted mesh-node flow, and packaged Linux desktop live E2E validate the following with the Python HTTP API disabled and Aurora traffic on the DataChannel:

- bilateral SAS pairing is required before authorized service calls;
- canonical reconnect HMAC validation can re-authorize a returning peer without another SAS prompt;
- credential revocation fails closed;
- the uncertain-loss mutation window is at-most-once: `G009Interop.Mutate` starts, `G009Interop.MutationStarted` is observed, disconnect happens before the response settles, and Python records execution count 1;
- event delivery is subscription/correlation scoped; and
- lane reports pass redacted secret scans.

Tracked cross-engine reports live under `reports/webrtc-interop/{direct,firefox-direct,webkit-direct,stun,firefox-stun,webkit-stun,turn,firefox-turn,webkit-turn}/report.json`; each passing lane includes `selectedCandidatePair` captured from browser `RTCPeerConnection.getStats()` and separates raw selected category (`host`, `srflx`, `prflx`, or `relay`) from lane validation. Hosted Chromium peer behavior is maintained by `pnpm test:hosted-peer:live`; hosted mesh-node behavior is maintained by `scripts/hosted_mesh_node_e2e.sh`; browser persistence and packaged Linux desktop live behavior are maintained by `pnpm test:web-persistence` and `pnpm test:desktop-client:live`. Those commands/scripts write per-run diagnostics to local generated locations rather than committed docs. Packaged macOS/Windows WebViews and physical mobile runtime behavior are not claimed by those reports. A packaged Android API 30 application-launch smoke passes on the workspace emulator; full WebView/Chrome auth and mesh interop plus physical-device validation remain open. iOS runtime/build validation needs macOS/Xcode with the required simulator/runtime/toolchain prerequisites.

## Mesh and peer trust

Mesh access is not equivalent to local trust. A peer must pass pairing/authentication and still satisfy capability, permission, routing, and data-sharing policy checks. For mesh-specific flow details, see [`PEER_PAIRING_FLOW.md`](PEER_PAIRING_FLOW.md) and [`DATA_SHARING_POLICY.md`](DATA_SHARING_POLICY.md).

Runtime-role mesh nodes keep pairing and provider authorization separate:

- Pairing establishes stable peer identity, bilateral approval, and the reconnect credential relationship.
- Provider-side authorization stores verifier records and peer-specific grants separately from claimant/outbound credential storage.
- The provider stores only SHA-256 verifier material for inbound reconnect and returns any raw bearer material once to the claimant.
- Grants control which local methods, local tool contract IDs, capability packs, and resource scopes a peer may discover or invoke.
- Revocation rejects outstanding challenges, blocks new calls, and cancels active work tied to the revoked credential or grant.

Hosted browser stores verifier secrets through the encrypted WebCrypto-backed vault and keeps grant metadata in the lightweight local-data repository. Tauri desktop, Android, and iOS use OS secure storage for verifier material and the shared lightweight local-data repository for redacted/encrypted grant metadata. Memory fallback is session-only and must not claim durable reconnect.

## Admin and sensitive surfaces

Admin-style surfaces must declare `method_type="manage"` and explicit permissions. Examples include backup/restore, config mutation, peer management, and high-risk tooling. Destructive operations should also expose dry-run/impact-plan behavior where practical.

## Configuration security

Configuration reads/writes are mediated by ConfigService and Gateway/Auth policy. Sensitive values should be redacted externally and sourced from `.env` where appropriate. See [`CONFIG_SERVICE_PATTERN.md`](CONFIG_SERVICE_PATTERN.md) for service access rules.

Historical config-security investigation artifacts are archived in `docs/archive/` and are not current policy.

## Validation references

- Contract models: `app/shared/contracts/models/auth.py`, `app/shared/contracts/models/gateway.py`.
- Gateway ACL: `app/services/gateway/acl/`.
- Auth service tests: `tests/unit/services`, `tests/unit/gateway`, and integration/e2e auth coverage where present.
- SDK/backend conformance: [`SDK_BACKEND_CONFORMANCE_CI.md`](SDK_BACKEND_CONFORMANCE_CI.md).

### Tooling source-first management console

Aurora's `/tools` UI is the operator-facing control center for tool catalog policy. It is source-first rather than tool-card-first: core tools, MCP servers, plugins, mesh peers, unknown/quarantined sources, and blocked sources are grouped in a source rail, and individual tools expand only after a source is selected. The page consumes the Aurora SDK only; it does not call Python services directly.

Backend authority stays in Tooling/Auth/Config contracts:

- `Tooling.GetPolicySummary` reports global policy mode, default approval behavior, counts, and redaction state.
- `Tooling.ListToolSources` and `Tooling.GetToolSourceDetail` expose grouped source rows, selected-source tools, grants, policy rules, pending approvals, and mesh cache metadata.
- `Tooling.SetPolicyMode`, `Tooling.UpsertSourcePolicy`, and `Tooling.UpsertToolPolicyOverride` are manage methods guarded by `Tooling.manage`; dangerous unrestricted mode requires the confirmation text `ALLOW NON-BLOCKED TOOLS`.
- `Tooling.ListPendingApprovals` and `Tooling.ListPolicyAuditEvents` provide redacted management queues/history. Assistant inline approval remains separate: it resumes one exact paused tool call in the assistant thread, while `/tools` manages durable policy/grants.
- `Tooling.TestMCPSource`, `Tooling.CreateMCPSource`, `Tooling.TestPluginSource`, and `Tooling.CreatePluginSource` provide UI-safe onboarding contracts. Until a concrete backend installer/connector is available, these contracts return explicit unsupported results with secrets redacted.

Mesh tool catalogs shown here come from negotiated/cached Tooling announcements. The UI must not fan out to peers during prompt or page render; it displays epoch/hash/stale/unshared/removed state from the local Tooling cache. Newly announced child tools require review unless the operator explicitly enabled future-tool trust.

Surface behavior is resolved through `getAuroraSurfaceProfile`, while runtime role is stored in the runtime profile: desktop-local may show local sidecar affordances, remote-console clients show Gateway/home-peer controls only, mesh-node clients expose local capabilities only from real grants and platform evidence, and Android/iOS/mobile must not claim a Python sidecar. Sample/mock data must stay test-only or be explicitly labeled outside production UI.

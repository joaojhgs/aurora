# Mesh service routing and Tool sharing operations

This runbook covers the v2 mesh policy rollout, rollback, and RBAC review. It
does not replace peer RBAC: export policy and RBAC are independent, conjunctive
gates.

## Semantics

- **Shared from this device** controls which callable services, features,
  methods, tool groups, and tools this provider exports.
- **Route requests through peers** controls where this device sends outbound
  work. It never grants inbound access.
- Peer policy is stored by stable authenticated peer ID. Node names are display
  labels only.
- `allowed_provider_peer_ids: null` means any otherwise eligible provider;
  `[]` means no remote provider; a populated list selects stable peer IDs.
- RBAC remains authoritative for every call. A shared method without a matching
  exact, wildcard, type, or global grant is denied. A grant does not override an
  unshared service, feature, method, group, or tool.

## Speech provider routing

Speech methods add a capability gate to export policy and RBAC. Recipient-specific projections carry exact-language coverage, automatic-language coverage, declared locale fallbacks, ready logical voice IDs, resident-model identity, and a speech capability revision.

- TTS language selection is exact. A request without a language may use normal selection among providers with valid resident speech capability evidence; a request that names a language or logical voice may reach only a provider that projects that exact ready capability.
- Automatic STT selection is eligible only when the provider explicitly supports automatic detection and covers the bounded candidate language set.
- Legacy peers that omit speech constraints remain visible in route explanations but are non-routable for constrained speech work. Missing evidence is not treated as universal language or voice support.
- Provider availability is lease-based. A newer ordered `provider_unavailable` tombstone withdraws the provider immediately; an older lease, manifest, or availability frame cannot resurrect it.
- Route selection creates trusted `SpeechRouteBinding` metadata containing the service instance, projection digest/revision, provider lease epoch/revision, speech capability revision, and request-requirement digest. Callers cannot supply or override that binding through public TTS/STT payloads.
- Gateway RPC and target services validate the binding against current state before capacity accounting, bus dispatch, or handler work. A structured pre-accept `capability_changed` result may trigger at most one automatic re-resolution for an unpinned use call. Explicit targets and management calls never escape their selected provider, and work is never replayed after acceptance is uncertain.

Use `Gateway.ExplainRoute` with typed `speech` hints to inspect this decision without sending text, audio, or other request payload data. See [`GATEWAY.md`](GATEWAY.md).

## Forward migration

Startup migrates legacy `mesh_sharing` routing fields into `mesh_routing`. If
both old and new values exist, the new value wins and its representable legacy
mirror is updated. `null` and `[]` are preserved distinctly.

Before replacing the config, Aurora creates:

1. a full local backup with mode `0600`; it may contain credentials and must
   never be attached to a support bundle; and
2. a separate redacted `0600` receipt containing hashes, versions, counts, and
   path metadata but no backup content.

Aurora also creates a redacted RBAC preflight report. A prior inbound allowlist
may have blocked a peer that broad RBAC now reaches. Review every
`release_blocking` service and narrow peer grants where necessary. Migration
never silently changes peer grants.

## RBAC review

For each formerly allowlisted shared service:

1. list approved peers and their effective outbound permissions;
2. identify exact, `Service.*`, `Service.use`, `Service.manage`, and `*` grants;
3. compare those grants with the old allowlist evidence in the redacted report;
4. narrow or revoke grants before release if the old allowlist excluded a peer;
5. restart or refresh Config so the report is regenerated from the live Auth
   inventory.

Do not paste tokens, room passwords, signaling credentials, config backups, or
raw tool catalogs into an issue or support bundle.

## Safe reverse migration

Legacy binaries cannot represent feature/method exclusions, granular Tooling
rules, retained stale identities, or projection state. Reverse migration must
therefore collapse unrepresentable surfaces to coarse deny; it must never
broaden access.

```bash
uv run python scripts/migrate_mesh_service_config.py config.json \
  --reverse \
  --output config.legacy.json \
  --tooling-export-snapshot tooling-export.redacted.json \
  --fail-closed-required-provider-features
```

The Tooling snapshot must be produced by the local management contract and be
explicitly redacted. Before creating the downgrade receipt, disable both
`provider_mesh_tooling_enabled` and `consumer_mesh_tooling_enabled`. A granular
or ambiguous policy becomes `share=false`/`default_share=false`; durable DB
policies, grants, refusals, and retained catalogs are not deleted.

For an intentional in-place reverse migration, additionally pass
`--in-place --acknowledge-unsafe-downgrade`. Prefer a separate output and review
the diff first.

## Legacy-target startup refusal

A projection-incapable target must start with:

- `AURORA_TOOLING_TARGET_MODE=legacy`;
- `AURORA_CONFIG_FILE` pointing at the reverse-migrated config; and
- `AURORA_TOOLING_EXPORT_SNAPSHOT` pointing at the exact redacted snapshot used
  for the receipt.

Supervisor verifies the `0600` receipt, config hash, snapshot hash, both disabled
switches, and coarse Tooling deny before initializing a bus. A missing,
insecure, stale, or tampered receipt fails with `unsafe_downgrade_blocked`.
Regenerate the reverse migration from current state; do not edit the receipt.

## Rollback choices

- **Return to the v2 binary:** keep the v2 config and durable DB. Re-enable
  Tooling switches only after projection readiness is healthy.
- **Run a legacy binary:** use the fail-closed reverse migration above.
- **Exact pre-migration restore:** restore the secure full backup only after
  explicitly accepting loss of all post-migration config policy changes. The
  redacted receipt is not a backup and cannot restore configuration.

After any rollback, verify RBAC, service exports, outbound provider modes,
Tooling switches, and a fresh recipient manifest/catalog. Never infer live
authority from retained catalog rows.

## Protocol and diagnostics

- `legacy_unverifiable`: non-routable; granular Tooling export fails closed.
- `projection_v1`: full recipient-specific snapshot with revision/digest-bound
  pages.
- `baseline_required`: a delta-capable peer has no verified full baseline; it
  remains non-routable until a full snapshot succeeds.
- `language_capability_unknown`: a speech provider omitted required language
  capability evidence.
- `language_incompatible`: the provider cannot serve the exact language or
  bounded automatic-language candidate set.
- `voice_unavailable`: the requested logical voice is not ready on the
  provider.
- `speech_route_binding_unavailable`: Aurora could not create current trusted
  revision/lease binding evidence, so dispatch is blocked.
- `provider_unavailable`: the active provider lease was withdrawn or expired.

The redacted support bundle reports canonical reason codes, numeric revisions,
projection counts, sync duration, retry counts, switch state, and protocol
status. It omits raw tool arguments, schemas, cursors, newly hidden tool names,
credentials, room details, host paths, and migration backup contents.

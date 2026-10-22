# Saved local profile preservation — V1098

The worker source fix is complete and the affected production frontend candidate builds. Applying local setup again now preserves the matching saved profile's name, label, languages and recognized preferences. The original implementation retained only the profile ID and rebuilt default contents, losing those settings.

The production change is `sanitizeRuntimeProfile(existing ?? freshDefaults)`. Matching still requires the same inspected native identity, local Python-full profile, no home connection or mesh membership, and empty sharing capability packs. Package capability, persistent storage, sanitization, save/readback and rebuild guards remain unchanged. The separate fresh-setup test remains.

## Finite validation

- The [original regression](regression-red.log) failed against the previous product source because the saved values were lost.
- The [second failure](canonical-fixture-failure.log) exposed only the test's noncanonical `pt-BR` seed versus existing stored `pt-br` normalization. Both failed attempts remain intact. Only the seed was corrected; no product normalization or equality predicate was changed.
- The [four affected tests](regression-green-RESULT.json) passed at 15:41:54 UTC on 2026-10-16. The [Tauri typecheck](tauri-typecheck-RESULT.json) passed at 15:42:34.
- [Existing Sol review](SOL-REVIEW.md) approves the production preservation fix and unchanged authority guards. Its production source pin matches the current source; the later test-only canonical spelling adjustment is recorded in [source delta](SOURCE-DELTA.json).
- [Production frontend build](FRONTEND-RESULT.json) ran 15:43:10–15:43:46 UTC, exit 0, with unchanged admitted source. It produced 78 files / 6,847,611 bytes. The development file-audio hook is absent. [Artifact](frontend-production-v1096.tar.gz) SHA256 `5bf007ceb99c5b6e746f744869bc56fd8b76c945907d7cc2d658730056ccf1a0`.
- [Future native input packet](reviewed-source-delta-v1097.tar.gz) has all 10 member hashes verified by archive readback, SHA256 `919b893d17d0fb050680cb8ec6cd3b5eddbf06fa5c8444d65e9df38ba067e1aa`. Its [manifest](NATIVE-INPUT-MANIFEST.json) retains the original pre-repair base hashes and new frontend binding.

The prior 45 shared-UI and 19 native profile-module checks, shared-UI types and original Sol review remain accepted for their unaffected scope. They were not repeated. The latest four tests replace the affected four-test result; this is not an additional scenario matrix. The full native crate environment gap remains recorded in [the earlier repair](../desktop-local-setup-repair-v1082/REPORT.md).

## Boundaries and continuation

V1096/V1097 replace only the future frontend/source candidates V1087/V1089; all historical artifacts and failed records are preserved. Nothing was transferred, built, launched or modified on Personal. The frozen C06 source, ELF, models, counts and reservation remain untouched. A genuine new native package and ordinary UI send/history validation are still open; neither gates the first distributed file-audio route.

Current C06 state is unknown after the Orca submission observation gap: last verified 14:49 UTC, 273 attempted / 272 completed of 900, 15 excluded warmups. Original requests `219e01dc-8616-42f6-90e6-6a5ce1590fea` and `d2cc0e31-dc5f-43d7-b2d2-cd85d538d2b6` remain uncertain; unchanged retry/read/input loops are closed under the original monitor's instruction. Preserve the lease until supported owning-client reconciliation supplies changed evidence. No process exit is inferred.

[First distributed K1](../distributed-k1-http-v994/REPORT.md) actually launched at 09:48 UTC, failed warmup 1 on TCP refusal, and has zero measured requests. Its replacement needs an existing approved reachable authenticated Gateway origin or supported existing forward, actual requester/receiver stage correlation and resource admission. There is no grounded start ETA while that capability is missing. [Exact remaining surface entries](../remaining-performance-entries-monitor-20261016T1326.md) remain unchanged. Closed CPU/local/HTTP/browser cohorts are not repeated or topped up, and no UI, microphone, Android, packaging or full13 acceptance gate is added.

Original Root/thread/branch/worktree and original monitor sole methodology ownership are preserved. No goal completion, PR/CI/network/security change or new worker/session is claimed.

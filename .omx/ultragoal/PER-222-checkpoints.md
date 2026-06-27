# PER-222 Ultragoal Checkpoints

## G001 — Plan And Scope

- Status: complete
- Evidence: `.omx/plans/PER-222-sdk-backend-contract-conformance-ci.md`
- Notes: Focused on CI/evidence gate only; no production UI wiring.

## G002 — Implement Conformance Gate

- Status: complete
- Evidence:
  - `scripts/generate_backend_inventory.py` now emits Gateway OpenAPI paths.
  - `scripts/check_sdk_backend_conformance.py` validates live backend inventory against SDK fixtures and writes evidence artifacts.
  - `.github/workflows/sdk-backend-contract-conformance.yml` runs backend inventory generation, conformance check, SDK typecheck, SDK tests, SDK build, and artifact upload.
  - `docs/SDK_BACKEND_CONFORMANCE_CI.md` documents commands, artifacts, skipped/manual device gates, owner, release runbook links, and readiness cross-links.
- Verification:
  - `uv run ruff check scripts/generate_backend_inventory.py scripts/check_sdk_backend_conformance.py` — passed.
  - `uv run ruff format --check scripts/generate_backend_inventory.py scripts/check_sdk_backend_conformance.py` — passed.
  - `uv run python scripts/generate_backend_inventory.py --fail-on-ui-fixture-errors --output /tmp/per222-inventory.json` — passed.
  - `uv run python scripts/check_sdk_backend_conformance.py --inventory /tmp/per222-inventory.json --evidence-dir .artifacts/sdk-backend-conformance` — passed with zero fatal issues and 174 non-fatal findings.
  - `pnpm --filter @aurora/client typecheck` — passed.
  - `pnpm --filter @aurora/client test` — passed, 3 files and 94 tests.
  - `pnpm --filter @aurora/client build` — passed.
- Review limitation: native `code-reviewer`/`architect` subagent launch tooling is not exposed in this runtime, and `omx` has no `code-review` CLI subcommand here. Independent code-review evidence is unavailable in-session; QA should treat this as a handoff review focus item rather than a merge-ready review claim.

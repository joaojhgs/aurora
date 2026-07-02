# Documentation maintenance policy

**Status:** Current source of truth
**Audience:** contributors and agents editing documentation

Aurora documentation must describe the current repository clearly. Historical artifacts are allowed only when they are labeled and isolated from user-facing guidance.

## Status labels

Every durable doc should start with one of these statuses when ambiguity is possible:

- **Current source of truth** — canonical guidance for current behavior.
- **Current bounded check** — accurate for a specific test/build/harness boundary, but not a full production proof.
- **Partial feature** — some implementation exists, but the doc must state what is missing.
- **Legacy/current bridge reference** — current only for a fallback or migration boundary.
- **Historical/provenance** — not current guidance; belongs under `docs/archive/` or `.omx/plans/`.

## What belongs in `docs/`

Keep only durable, user-facing documentation:

- architecture and subsystem explanations
- install/run/test/build/CI guidance
- current API, contract, SDK, frontend, Gateway, mesh, auth, backup, and dependency docs
- bounded harness docs that clearly state what they prove and what they do not prove

## What does not belong in `docs/`

Do not commit these as current docs:

- generated dependency trees, security-audit snapshots, report JSON/TXT, or temporary run outputs
- task-specific PER/QA report docs or release checklists
- agent handoff files
- implementation journals that duplicate commit history
- plans that have been superseded by current documentation

Use these homes instead:

| Artifact type | Location |
| --- | --- |
| Agent/runtime state and ultragoal ledgers | `.omx/` |
| Preserved planning artifacts | `.omx/plans/` |
| Human-readable historical provenance | `docs/archive/` |
| Regeneratable reports | local `.artifacts/`, package `reports/`, or CI artifacts |

## Link and freshness rules

- Relative links in current docs must resolve.
- Do not link current docs to archived docs as the main source of truth.
- When renaming workflows, package scripts, or docs, update `docs/DOCS_INDEX.md`, `docs/CI_CD.md`, `tests/README.md`, and relevant package READMEs in the same change.
- When adding a service or contract model, update `docs/ARCHITECTURE.md`, `docs/FEATURE_MATRIX.md`, and either `docs/API_AND_CONTRACTS.md` or `docs/SERVICE_METHODS_REFERENCE.md`.
- When adding frontend/Tauri behavior, update `docs/FRONTEND_AND_UI_ARCHITECTURE.md` and package-local READMEs only as concise entry points.

## Validation

Run the docs check before claiming documentation cleanup is complete:

```bash
uv run python scripts/check_docs.py
```

The check verifies current markdown links, stale workflow/gate references, generated report artifacts under `docs/`, and task-specific PER/QA docs outside archive/provenance locations.

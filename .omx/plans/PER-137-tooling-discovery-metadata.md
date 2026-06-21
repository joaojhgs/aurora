# PER-137 Tooling Discovery Metadata Plan

## Scope
- Issue: PER-137 `[MESH][P3-T01] Extend Tooling discovery with peer/source metadata and stable remote tool IDs`.
- Source docs available in this checkout: issue description/metadata, `AGENTS.md`, `app/services/AGENTS.md`, `app/shared/AGENTS.md`, `app/shared/contracts/AGENTS.md`, `app/messaging/AGENTS.md`, `tests/AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/GATEWAY.md`, `docs/SERVICE_METHODS_REFERENCE.md`.
- Source docs named by the issue but missing in this checkout: `.omx/specs/deep-interview-mesh-distributed-integration.md`, `.omx/multica/mesh-roadmap-tasks/P3-T01*`.

## Implementation
- Add typed Tooling discovery item models with stable identity, provider peer/service identity, namespace/display aliases, execution location, safety/policy hints, schema, and provenance.
- Preserve backward compatibility by keeping local-only `name` equal to the local tool name and retaining `args_schema`.
- Namespace provider-selected/remote discovery names so colliding remote tool names do not bind as the same LLM tool.
- Let Tooling execution resolve local names, stable global IDs, and namespaced discovery names back to the provider-local tool.
- Update orchestrator call sites to use Tooling contract request models instead of legacy messaging payload aliases.
- Update docs and focused tests for typed discovery metadata, local regression, and two remote providers with colliding local tool names.

## Verification
- Run targeted Tooling tests.
- Run targeted orchestrator tests impacted by request model changes if dependencies permit.
- Run formatting/lint checks as feasible in this runtime.

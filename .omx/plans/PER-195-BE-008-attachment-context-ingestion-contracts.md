# PER-195 / BE-008 Attachment Context Ingestion Contracts

## Scope

Implement the backend contract slice for assistant attachment and shared-context ingestion. The issue scope is limited to typed request/response models, an external Orchestrator method surface, privacy-first policy handling, audit/RAG bus integration points, and focused tests.

## Source Context

- Multica issue PER-195 / BE-008.
- `.omx/specs/ui-production-tasks/tasks/BE-008-add-attachment-context-ingestion-contracts.md`.
- `.omx/specs/ui-refinement/aurora-ui-sdk-contract.md`.
- `.omx/specs/ui-production-tasks/backend-gap-crosswalk.md`.
- Root and subsystem `AGENTS.md` files for services, contracts, messaging, and tests.

## Invariants

- Services communicate through the message bus only.
- Externally exposed methods use `@method_contract`, typed IO models, and explicit permissions.
- Privacy-sensitive classes are rejected by default.
- Raw context content is not echoed in responses or audit details.
- RAG persistence is opt-in through an explicit storage policy.

## Plan

1. Add typed attachment/context ingestion models to Orchestrator contracts.
2. Register `Orchestrator.IngestContext` as an external `use` method requiring `Orchestrator.use`.
3. Implement ingestion in Orchestrator with size limits, privacy-class rejection, secret redaction, optional DB RAG storage, and Auth audit logging over the bus.
4. Add unit tests for registry metadata, redaction and RAG storage, oversized rejection, and blocked privacy classes.
5. Verify with targeted unit and registry/inventory tests plus Ruff on changed files.

## Verification

- `.venv/bin/pytest tests/unit/orchestrator/test_context_ingestion_contracts.py -q`
- `.venv/bin/ruff check app/shared/contracts/models/orchestrator.py app/services/orchestrator/service.py tests/unit/orchestrator/test_context_ingestion_contracts.py`
- `.venv/bin/pytest tests/unit/orchestrator/test_model_runtime_contracts.py tests/unit/gateway/test_backend_inventory.py -q`

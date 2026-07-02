# API and contracts

**Status:** Current source of truth

Aurora service APIs are contract-first. Python services declare typed bus methods with `@method_contract`; the Gateway exposes eligible methods as HTTP routes; the TypeScript SDK mirrors supported frontend-facing behavior through typed transports and conformance fixtures.

## Contract sources

| Source | Purpose |
| --- | --- |
| `app/shared/contracts/registry.py` | `@method_contract`, module registration, and contract lookup. |
| `app/shared/contracts/models/*.py` | Typed method constants and Pydantic IO models. |
| Service methods under `app/services/*/` | Actual implementations decorated with contract metadata. |
| `docs/SERVICE_METHODS_REFERENCE.md` | Human-readable method reference; manually maintained. |
| `packages/aurora-sdk` | TypeScript client, fixtures, transports, and conformance expectations. |

## Adding or changing a service method

1. Define or update the typed method constant and IO models in `app/shared/contracts/models/`.
2. Decorate the service method with `@method_contract`.
3. Use absolute imports and Pydantic models for all bus payloads.
4. Set `exposure`, `method_type`, and `required_perms` deliberately.
5. Add/update tests for the service behavior and Gateway exposure when external.
6. Update SDK fixtures/client surfaces if frontend-visible.
7. Update `docs/SERVICE_METHODS_REFERENCE.md` or the relevant subsystem doc.

## Exposure levels

| Exposure | Meaning |
| --- | --- |
| `internal` | Bus-only service method. Not exposed by generated Gateway routes. |
| `external` | Exposed externally through Gateway when policy allows it. |
| `both` | Internal and external use. |

External exposure is not enough by itself: Gateway/Auth permission checks still apply.

## Gateway route generation

Gateway discovers service announcements and contract metadata, then creates FastAPI routes for exposed methods. Requests are validated against the input model and forwarded over the bus. Responses are validated/serialized from output models.

See [`GATEWAY.md`](GATEWAY.md).

## Events and streaming

Gateway event streams expose selected backend events through SDK-compatible shapes. The SDK event API preserves IDs, topics, correlation IDs, peer/target metadata, redaction metadata, and transport evidence.

UI code should consume events through `AuroraClient`, not raw SSE or Tauri commands.

## SDK conformance

`SDK Backend Contract Conformance` checks prevent silent drift between backend contracts and TypeScript fixtures. The conformance docs live in [`SDK_BACKEND_CONFORMANCE_CI.md`](SDK_BACKEND_CONFORMANCE_CI.md).

Relevant package commands:

```bash
pnpm --filter @aurora/client build
pnpm --filter @aurora/client test
pnpm --filter @aurora/client test:resilience
```

## Documentation ownership

- Use `docs/SERVICE_METHODS_REFERENCE.md` for human-readable service method summaries.
- Use subsystem docs for policy/architecture details.
- Do not create one-off method report docs. If a report is generated, publish it as a CI artifact or local `.artifacts/` output.

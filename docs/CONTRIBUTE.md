# Contributing to Aurora

**Status:** Current source of truth

Aurora is a bus-first Python/TypeScript workspace. Keep changes small, typed, documented, and verified with the narrowest checks that prove the change.

## Setup

```bash
uv sync --extra dev
pnpm install --frozen-lockfile
```

Use Python 3.10-3.11. Do not use Conda for this repo.

## Before editing

Read the subsystem guide for the area you are touching:

| Area | Guide |
| --- | --- |
| Services/lifecycle | [`../app/services/AGENTS.md`](../app/services/AGENTS.md) |
| Gateway/mesh/API | [`../app/services/gateway/AGENTS.md`](../app/services/gateway/AGENTS.md) |
| Auth | [`../app/services/auth/AGENTS.md`](../app/services/auth/AGENTS.md) |
| Messaging | [`../app/messaging/AGENTS.md`](../app/messaging/AGENTS.md) |
| Shared code | [`../app/shared/AGENTS.md`](../app/shared/AGENTS.md) |
| Contracts | [`../app/shared/contracts/AGENTS.md`](../app/shared/contracts/AGENTS.md) |
| Tests | [`../tests/AGENTS.md`](../tests/AGENTS.md) |
| Config | [`CONFIG_SERVICE_PATTERN.md`](CONFIG_SERVICE_PATTERN.md) |
| Docs | [`DOC_MAINTENANCE.md`](DOC_MAINTENANCE.md) |

## Core rules

- Communicate between services through the message bus, not direct service calls.
- Use typed topic constants and Pydantic IO models from `app/shared/contracts/models/`.
- Register service methods with `@method_contract`.
- Use structured Aurora logging helpers, not ad-hoc loggers.
- Protect shared mutable state; bus delivery is concurrent.
- Keep documentation current when behavior, workflows, scripts, or public surfaces change.

## Checks

Python:

```bash
make format
make lint
make check
make unit
make integration
uv run python scripts/check_docs.py
```

TypeScript:

```bash
pnpm --filter @aurora/client build
pnpm --filter @aurora/client test
pnpm --filter @aurora/ui test
pnpm --filter @aurora/tauri-ui test
```

Process mode / Docker:

```bash
docker compose -f docker-compose.process.yml config --quiet
```

See [`CI_CD.md`](CI_CD.md) and [`../tests/README.md`](../tests/README.md) for the full CI/test map.

## Pull request expectations

A PR should state:

- what behavior changed;
- which docs were updated;
- which tests/checks were run;
- any known validation gaps;
- whether any external secrets, package signing, or production deployment steps are intentionally out of scope.

Use durable docs for long-lived guidance. Do not add task-specific handoffs, generated reports, or PER/QA checklists under `docs/`; see [`DOC_MAINTENANCE.md`](DOC_MAINTENANCE.md).

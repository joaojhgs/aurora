---
name: Tilt process-mode dev
overview: Tilt + Docker Compose process mode with auth/gateway parity, per-service debug logging, optional ngrok, docs, and agent guidance.
todos:
  - id: tiltfile-compose
    content: Add root Tiltfile with docker_compose merge of process + tilt compose; project_name
    status: completed
  - id: debug-buttons
    content: ext://uibuttons + scripts/tilt-set-service-log-level.sh + .env.tilt.local.example + docker-compose.tilt.yml
    status: completed
  - id: ngrok
    content: Optional local_resource ngrok-gateway (auto_init=False); documented in docs/TILT.md
    status: completed
  - id: docs-agents
    content: docs/TILT.md + AGENTS.md (Tilt, no official Tilt MCP, compose/health checks)
    status: completed
  - id: verify-db-dockerfile
    content: docker/services/Dockerfile.db present and referenced by compose
    status: completed
  - id: compose-auth-gateway-parity
    content: auth-service + gateway-service in docker-compose.process.yml; app/services/gateway/__main__.py; Dockerfiles auth/gateway
    status: completed
isProject: false
---

# Status (implemented Feb 2026)

## Delivered

- **Compose**: `docker-compose.process.yml` includes **redis**, **config**, **db**, **auth**, **orchestrator**, **gateway** (port `GATEWAY_HOST_PORT`→8000), **tooling**, **scheduler**, **tts**, **stt-*** , **stt-coordinator**. No supervisor container — Compose + Redis replace multi-process startup.
- **Dockerfiles**: `Dockerfile.db`, `Dockerfile.auth`, `Dockerfile.gateway` under `docker/services/`.
- **Gateway entrypoint**: `app/services/gateway/__main__.py` + `service-gateway` / `python -m app.services.gateway` parity with other services.
- **Tilt**: Root `Tiltfile` — `docker_compose(['docker-compose.process.yml', 'docker-compose.tilt.yml'])`, `ext://uibuttons` DEBUG/INFO per service, optional `ngrok-gateway` `local_resource`.
- **Scripts**: `scripts/tilt-set-service-log-level.sh` (bash, portable `case` map).
- **Docs**: `docs/TILT.md`, `README.process-mode.md` (services/deps/gateway port), `AGENTS.md` (supervisor vs compose, Tilt, MCP note).
- **Tooling**: `.gitignore` allows `.env.tilt.local.example`; `Makefile` `DOCKER_COMPOSE` auto-detect, `compose-validate-tilt`, `tilt-up`.
- **Test**: `tests/unit/test_gateway_main.py` asserts `run` and async `main`.

## Verification

- **CI / no Docker Compose plugin**: `uv run pytest tests/unit/test_gateway_main.py`; `uv run python` PyYAML parse of both compose files.
- **With Docker**: `make compose-validate-tilt`; full stack `make docker-process-up` then `curl -sf http://127.0.0.1:${GATEWAY_HOST_PORT:-8000}/api/health`.
- **Tilt**: `tilt up` (requires Tilt CLI); UI buttons update `.env.tilt.local` and recreate one service.

## Architecture (short)

- **Thread mode**: `Supervisor` starts in-process services including Gateway and Auth.
- **Process / Docker mode**: one container per service; **Auth** and **Gateway** are normal services, not folded into Supervisor.

---

(Legacy investigation sections from the original plan are superseded by the status above.)

# Tilt: process-mode development

[Tilt](https://docs.tilt.dev/) drives **Docker Compose** for Aurora process mode with optional **per-service log levels** and an optional **ngrok** tunnel to the gateway.

## Prerequisites

- **Docker Engine** (daemon reachable; `docker info` works).
- **Docker Compose v2** on the host (`docker compose version`). If you only have `docker` without the plugin, install it (e.g. Debian/Ubuntu: `sudo apt install docker-compose-plugin`) or use the fallback below.
- **[Tilt](https://docs.tilt.dev/install.html)** on your PATH (optional; only for `tilt up` / Tilt MCP).
- From repo root: `uv sync --extra dev-local-cpu` (or your usual dev extra) for local Python tests.

### Compose without the host plugin

From repo root:

```bash
./scripts/compose-docker.sh -f docker-compose.process.yml -f docker-compose.tilt.yml config --quiet
```

This runs `docker compose` inside the `docker:24-cli` image with your repo bind-mounted. If you see `no such file or directory` for the compose file inside the container, the daemon cannot see your project path (fix Docker Desktop **file sharing**, or use a local Linux path).

### Check resource status (same as tilt-mcp `get_all_resources`)

With **`tilt up`** running (or after partial `tilt ci`), in another terminal:

```bash
export PATH="$(git rev-parse --show-toplevel)/scripts:$PATH"
./scripts/tilt-check-resources.sh
```

That shells out to **`tilt get uiresource -o json`**, like the **`tilt-mcp`** server. In Cursor, enable **`.cursor/mcp.json`** → **`tilt-mcp`** and ask the agent to use tool **`get_all_resources`** / **`get_resource_logs`**.

**Force rebuild / update** (after code or image changes; requires **Tilt CLI** and **`tilt up`** running):

```bash
tilt trigger config-service
tilt trigger auth-service
tilt trigger gateway-service
# ... other resources as needed
```

**tilt-mcp** (0.1.x) does not expose trigger; use the shell or Tilt UI.

Run **`docker compose`** and **`tilt up`** from the **repo root** so build context and bind mounts resolve correctly for your Docker daemon.

### Cursor: Tilt MCP (community)

The repo includes **`.cursor/mcp.json`** registering **`tilt-mcp`** via **`uvx`** (isolated env — does not change Aurora’s `uv.lock`):

```json
"command": "uvx",
"args": ["--from", "tilt-mcp==0.1.3", "tilt-mcp"]
```

Reload MCP / restart Cursor after changing this file. **`tilt-mcp` shells out to `tilt`** (`tilt get uiresource`, etc.), so the **Tilt CLI** must be installed and **`tilt up`** running for tools to return data.

## Parallel builds and memory

`tilt up` / `tilt ci` may build **many images at once**, which can hit **OOM (exit 137)** or overload the daemon on smaller machines. **Mitigation:** build images **one service at a time**, then start Tilt (it will reuse cached layers):

```bash
export PATH="$(git rev-parse --show-toplevel)/scripts:$PATH"
./scripts/tilt-build-all.sh
tilt up
```

Process-mode **TTS** and **STT transcription** Dockerfiles pin **CPU PyTorch** via `docker/services/constraints-tts-cpu.txt` and `constraints-stt-cpu.txt` so builds do not pull multi‑GB CUDA wheels from PyPI by default.

Docker build variants are derived from `config.json` before Compose runs. The supported Make/Tilt scripts call `scripts/config_to_docker_env.py`, which maps:

- `services.db.embeddings.use_local` -> `DB_EMBEDDINGS_MODE`
- `services.orchestrator.llm.provider` and `services.orchestrator.hardware_acceleration` -> orchestrator build args
- `services.tts.hardware_acceleration` and `services.stt.hardware_acceleration` -> TTS/STT build args

Use `python scripts/config_to_docker_env.py --format env` to inspect the values Compose will see.

## Quick start

Tilt’s `docker_compose()` runs a **`docker-compose`** executable. If you only have Compose **v2** (`docker compose`), put the repo shim on your **`PATH`** first:

```bash
export PATH="$(git rev-parse --show-toplevel)/scripts:$PATH"
```

(`scripts/docker-compose` forwards to `docker compose`.)

```bash
# One env file for secrets + Compose/Tilt (see .env.example)
cp .env.example .env   # first time only; edit as needed

tilt up
```

Compose and Tilt load **`.env`** from the repo root. The tilt overlay adds per-service **`AURORA_LOG_LEVEL`** (from variables like `GATEWAY_SERVICE_LOG_LEVEL`, default `INFO`) and **Python hot reload**: **`working_dir: /app/host`** plus **`watchmedo`** watching **`/app/host/app`** and **`/app/host/modules`**. Code is read from the **same** repo bind-mount as process mode (`/app/host`). Edits under `app/` / `modules/` restart that service **without** rebuilding images.

**Tilt reload noise:** `scripts/sync-stt-audio-gid-in-dotenv.sh` updates **`STT_HOST_AUDIO_GID`** in `.env` **only when** the host value changes, so routine `tilt up` does not rewrite env every time.

**One-time after upgrading:** `watchdog` was added to the **`mode-processes`** extra in `pyproject.toml`. Rebuild images **once** so the new dependency is in the layer cache (incremental, not from scratch):

```bash
docker compose -f docker-compose.process.yml build
```

After that, day-to-day `tilt up` reuses images; only changed code on disk is picked up via mounts.

### Rebuild images without `tilt down`

Python under **`/app/host`** hot-reloads on save; you only need a **Docker rebuild** when **`Dockerfile`s, `pyproject.toml` / lockfile, or baked image deps** change.

You do **not** need to stop the whole stack:

1. **Tilt web UI** (http://localhost:10350): open a service → use **Rebuild** / force update for that resource. Other containers (e.g. Redis) keep running.
2. **CLI** (same project and compose files as the Tiltfile):
   - **`./scripts/tilt-compose-rebuild.sh`** — builds all process services **sequentially**, then runs **`tilt trigger`** for each Compose service if `tilt up` is already running (so Tilt recreates containers from the new images).
   - One or a few services: **`./scripts/tilt-compose-rebuild.sh db-service auth-service`**
   - **Make**: **`make tilt-compose-rebuild`** or **`make tilt-compose-rebuild SERVICES="db-service"`**

Underlying behavior: **`docker compose … build`** updates image layers; **`tilt trigger config-service`** (etc.) tells Tilt to re-apply that resource (rebuild + recreate that container) while the session stays up.

**Tuning:** set **`AURORA_HOT_RELOAD_DEBOUNCE_SEC`** in **`.env`** to debounce bursts of saves (default `0.5`).

**Config file:** With **`working_dir: /app/host`**, a relative **`config.json`** would resolve under the repo mount (and can be missing or accidentally a **directory**, causing `IsADirectoryError`). The tilt overlay sets **`AURORA_CONFIG_FILE=/app/config.json`** (same as the image’s baked-in path). Override with **`AURORA_CONFIG_FILE=/app/host/config.json`** if your repo root has a real **`config.json` file** you want services to use.

**Without hot reload:** use **`docker-compose.process.yml` only** (e.g. `tilt up` with a local **`Tiltfile`** that omits the tilt overlay, or `docker compose -f docker-compose.process.yml up`). To keep per-service log envs but drop watch mounts/commands, edit **`docker-compose.tilt.yml`** locally (not committed) or maintain a small private override file.

### Without Tilt (Compose only)

```bash
docker compose -p aurora-process -f docker-compose.process.yml -f docker-compose.tilt.yml up -d --build
```

Compose reads **`.env`** from the project directory automatically (defaults still apply via `${VAR:-INFO}` where set in the YAML).

## UI buttons (per-service DEBUG / INFO)

The **Tiltfile** loads `ext://uibutton` (from [tilt-extensions](https://github.com/tilt-dev/tilt-extensions); clone into `~/.local/share/tilt-dev/tilt_modules/github.com/tilt-dev/tilt-extensions` if missing) and registers **Nav** buttons that run:

`scripts/tilt-set-service-log-level.sh <compose-service-name> DEBUG|INFO`

That updates **`.env`** and recreates **only** that container (no dependency restart).

## Ngrok (optional)

1. Install [ngrok](https://ngrok.com/) and set `NGROK_AUTHTOKEN` in your environment.
2. In the Tilt UI, enable the **`ngrok-gateway`** resource (`auto_init=False` — not started by default).
3. By default the tunnel targets host port **8000**. Override with `NGROK_GATEWAY_PORT` if you mapped the gateway elsewhere (`GATEWAY_HOST_PORT` in Compose).

You can also run manually:

```bash
ngrok http "${NGROK_GATEWAY_PORT:-8000}"
```

## Architecture note: Supervisor vs Compose

- **Thread mode**: `Supervisor` starts in-process services.
- **Process mode**: **no supervisor container** — **Docker Compose** (plus Redis) is the orchestrator. **Auth** and **Gateway** are normal services with their own images (`Dockerfile.auth`, `Dockerfile.gateway`) and `python -m app.services.auth` / `python -m app.services.gateway`.

## Agents: MCP for Tilt

There is no official “Tilt MCP” from Tilt.dev. This repo standardizes on **[tilt-mcp](https://pypi.org/project/tilt-mcp/)** via **`.cursor/mcp.json`** + **`uvx`** (see above). Alternatives:

1. **CLI**: `tilt get`, `tilt dump`, `tilt logs` (when Tilt is running).
2. **Compose**: `docker compose -f docker-compose.process.yml ps` and `docker compose ... logs <service>` for health checks without Tilt.

### Suggested health check (gateway)

After the stack is up (host port from `GATEWAY_HOST_PORT`, default `8000`):

```bash
curl -sf "http://127.0.0.1:${GATEWAY_HOST_PORT:-8000}/api/health"
```

See `docs/GATEWAY.md` for the full HTTP API.

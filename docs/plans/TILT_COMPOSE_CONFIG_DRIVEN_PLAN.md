# Plan: Config-driven Docker / Tilt (images + optional services)

**Status:** Done — implementation merged.  
**Related fixes (done separately):** STT coordinator `Config.Get` timeout, transcription HF cache writability, wakeword `/app/models/...` path resolution (`path_utils.resolve_path`).

## Goals

1. **Build args / image layers** reflect `config.json` (and documented env fallbacks), e.g.:
   - `services.db.embeddings.use_local` → DB image includes `langchain-huggingface` / local embedding stack vs API-only.
   - `services.orchestrator.llm` provider / hardware → orchestrator image extras (`ORCHESTRATOR_LLM_MODE`, GPU CPU variants) aligned with config, not only `.env`.
2. **Operator control** over **which compose services run** (Tilt + `docker-compose.process.yml`), with a **single source of truth** section in config (or a small generated manifest) so “disable gateway” or “disable STT” is explicit and documented.

## Non-goals (this document)

- Replacing `config.json` as runtime truth inside containers (already `AURORA_CONFIG_FILE`).
- Implementing the dependency matrix in Dockerfiles in this pass — only the **plan and todos**.

---

## Service matrix: required vs optional (process mode)

| Service | Required? | Rationale |
|--------|-----------|-----------|
| **redis** | **Yes** | BullMQBus backbone for all processes. |
| **config-service** | **Yes** | Every service uses `ConfigAPI` / bus `Config.*`. |
| **db-service** | **Yes** | History, RAG, cron persistence, auth/mesh stores. |
| **auth-service** | **Yes** (if gateway enabled) | Gateway WebRTC/HTTP auth, pairing, mesh trust. For a **headless bus-only** lab profile, could be optional if nothing calls `Auth.*` — **not** supported today without code changes. |
| **tooling-service** | **Yes** (for assistant) | Orchestrator expects tools registry; disabling breaks normal LLM+tools flows. |
| **orchestrator-service** | **Yes** (for assistant) | Core LLM pipeline. |
| **scheduler-service** | **Optional** | Cron / scheduled jobs only. |
| **tts-service** | **Optional** | No TTS if UI/voice reply not needed. |
| **stt-wakeword**, **stt-transcription**, **stt-coordinator** | **Optional** (but coupled) | Voice input; coordinator streams audio to the other two. Disabling **coordinator** effectively disables mic pipeline; wakeword/transcription alone are useless without coordinator (and bus contracts). |
| **gateway-service** | **Optional** | External HTTP/WebRTC API; CLI/thread mode users may omit. |

**Supervisor note (threads mode):** `_start_services_processes` always includes STT trio; thread mode starts STT when building full stack. Making STT optional in **process** compose is easier than changing supervisor without a **config-driven process launcher** (future work).

---

## Proposed `config.json` section (sketch)

```json
{
  "services": {
        "gateway":  true,
        "scheduler":  true,
        "tts":  true,
        "stt":  true
      },
}
```

- **`inherit`** = derive from existing keys (`services.db.embeddings.use_local`, `services.orchestrator.llm.*`, etc.).
- Implementation can **generate** `.env` or a `docker-compose.override.generated.yml` via `scripts/render-compose-from-config.py` (or Tilt `local_resource`).

---

## Implementation approaches

### A. Compose profiles (low friction)

- Add `profiles:` to optional services (`gateway`, `scheduler`, `tts`, `stt-*` group).
- `COMPOSE_PROFILES` or `docker compose --profile voice --profile api up`.
- Tiltfile sets profiles from env file produced by a small script that reads `config.json`.

### B. Build args from config (CI / local)

- Extend existing pattern: `DB_EMBEDDINGS_MODE`, `ORCHESTRATOR_LLM_MODE` — add `scripts/config-to-docker-env.sh` that outputs export lines for `docker compose build`.
- Dockerfiles already branch on args; keep **one** script as SSOT to avoid drift.

### C. Document-only phase 1

- Document matrix + env vars in `docs/TILT.md` / `README.process-mode.md` until automation exists.

---

## Risk / edge cases

- **Auth without gateway:** Still needed if any other service gains external surface; today treat as required in default profile.
- **Orchestrator without tooling:** Possible for minimal LLM smoke tests; not a normal product profile.
- **STT partial enable:** supported to some degree, user can want to use wakeword and stt services to serve outside users without the stt-coordinator for in-device usage, but if the stt-coordinator is turned on the others should be as well. Do no try to validade for this, if the user want's to mess around with the config he can.
- **Local embeddings:** DB container must match `use_local` + model download paths/volumes; document `data/` ownership (same class of issue as HF cache for transcription).

---

## Todo list (implementation)

1. [ ] Add `deployment.docker` schema to config documentation and optional Pydantic/validation in ConfigService (if desired).
2. [x] Implement `scripts/config_to_docker_env.py` emitting build-arg exports.
3. [ ] Add Compose `profiles` for optional stacks; keep default `docker compose up` behavior backward-compatible.
4. [x] Update `Tiltfile` to derive optional services and build args from config.
5. [x] Align `Dockerfile.db` / `Dockerfile.orchestrator` args with generator output.
6. [ ] Supervisor / process launcher: optional follow-up to skip STT processes when `deployment.docker.services.stt.enabled` is false (avoid orphan bus subscribers) — requires design review.

---

## References

- `docker-compose.process.yml` — service list and existing build args.
- `docker-compose.tilt.yml` — hot-reload overlay.
- `app/services/supervisor.py` — thread vs process service lists.
- `AGENTS.md` — architecture and dependency rules.

# Configuration access pattern for services

**ConfigService** is the only component that should own **ConfigManager** and the **config.json** file on disk. Every other service reads and updates configuration **through the message bus** via **ConfigAPI**.

Following this pattern avoids:

- **Wrong or empty config** in process mode (each container has its own filesystem; a local ConfigManager() does not see the shared file other services use).
- **ConfigAPI.get() returning defaults** when called from **async** code (it detects a running event loop and returns the default without calling the bus; use **aget** instead).
- **Startup races**: ConfigService may not answer Config.Get within the default timeout if its BullMQ workers are still starting; use a longer **config_timeout** for early startup reads.
- **Accidental config.json creation** in non-config processes (avoid importing ConfigManager or the module-level config_manager unless you are ConfigService or an offline admin script).

---

## Rules (quick reference)

| Do | Do not |
|----|--------|
| Use **ConfigAPI** from **app.shared.config.interface** | Call **ConfigManager()** / **get_config_manager()** in service runtime code |
| Use **await config.aget("section.key", default=...)** in **async** methods | Use **config.get(...)** inside coroutines or async handlers |
| Use **await config.aget_config(section="gateway", timeout=20.0)** for whole sections when needed | Assume **aget_config()** default 5s timeout is enough right after container start |
| Use **await config.aupdate_config("path.to.key", value, timeout=15.0)** to persist changes | Call **ConfigManager.set()** from Gateway or other services |
| Subscribe to **Config.Updated** / implement **reload()** on **BaseService** for hot reload | Silently **except Exception: pass** when loading config on startup; log failures |
| Set **AURORA_CONFIG_FILE** (e.g. /app/config.json) in Compose for ConfigService | Rely on relative **config.json** from **working_dir** if it points at an empty bind mount |

---

## Reads (async services)

```python
from app.shared.config.interface import ConfigAPI
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import Stt as SttConfig

async def on_start(self) -> None:
    config = ConfigAPI()

    # Typed section access — returns a Pydantic model
    stt_cfg = await config.aget(ConfigKeys.services.stt, SttConfig)
    sample_rate = stt_cfg.coordinator.audio_input.sample_rate if stt_cfg.coordinator else 16000

    # Scalar/leaf access — returns a plain value
    sample_rate = await config.aget(
        ConfigKeys.services.stt.coordinator.audio_input.sample_rate,
        default=16000,
        config_timeout=20.0,
    )
```

**Sync-only code** (rare in services): if there is **no** running event loop, **get()** / **get_config()** can run **asyncio.run(bus.request(...))**. If you are inside **async def**, always use **aget** / **aget_config**.

---

## Writes (persist for all processes)

Only **ConfigService** writes **config.json**. Other services ask it to update via the bus:

```python
from app.shared.config.interface import ConfigAPI

async def persist_room_name(self, room: str) -> bool:
    config = ConfigAPI()
    return await config.aupdate_config("gateway.webrtc.room", room, timeout=20.0)
```

Secrets that must also live in **.env** (e.g. **AURORA_TOKEN_SECRET**) can still be written to disk from Gateway **in addition to** **aupdate_config("gateway.token_secret", ...)** so all services see the same value via Config.Get.

---

## Process mode (AURORA_ARCHITECTURE_MODE=processes)

- **ConfigAPI** does not require the Config contract to be registered **in this process**; Config.Get is served by the **config-service** container over Redis.
- **depends_on: config-service** in Compose does not wait until Config is **ready**, only until the container **starts**. Prefer **config_timeout** and/or retries for critical startup paths.
- **Mesh / JWT crypto**: never use sync **get("gateway.token_secret")** from async paths; use **await config.aget("gateway.token_secret", ...)**.

---

## ConfigService-only exceptions

- **ConfigService** uses **ConfigManager** directly (**app/services/config/service.py**).
- **Offline tooling** (scripts/config_updater.py, tests, migrations) may construct **ConfigManager()** explicitly.
- **ConfigAPI.migrate_from_env()** intentionally uses **ConfigManager** for one-shot admin migration.

---

## New service checklist

1. No **from app.services.config.config_manager import ConfigManager** in service.py (unless implementing ConfigService).
2. Load settings in **async def on_start** with **ConfigAPI().aget** / **aget_config** and appropriate **timeout** / **config_timeout**.
3. Implement **reload()** for sections you care about; use **aget**, not **get**, inside async **reload**.
4. If the service needs lazy state for contract registration (e.g. **AuthService._manager**), initialize it **before** **super().__init__(...)** so **BaseService** contract scan does not touch unset attributes.
5. Log warnings with **exc_info=True** when config load fails; do not swallow errors silently.

---

## Schema-first workflow

The JSON Schema at **app/services/config/config_schema.json** is the single source of truth.

```bash
make generate-config   # regenerates models.py, keys.py, config_defaults.json
```

Generated artifacts:
- **app/shared/config/models.py** — Pydantic models (via `datamodel-code-generator`)
- **app/shared/config/keys.py** — nested `ConfigKeys` path object (every dot-path in the schema)
- **app/services/config/config_defaults.json** — default values extracted from schema

CI enforces sync: `make generate-config && git diff --exit-code` fails if generated files are stale.

---

## Mesh sharing policy examples

Per-service `mesh_sharing` combines sharing and routing policy. Defaults are privacy-first:
`share=false`, local routing is preferred, no version floor is set, and no extra remote
capabilities are required. `allowed_peers=null` means any authenticated peer may use the
service only after that service is explicitly shared.

Auth and Config do not expose operator-facing `mesh_sharing` blocks. Pairing/login
infrastructure is handled by the WebRTC RPC auth gate, and local Auth peer management
or Config mutation remains local-admin behavior. Do not model broad remote Auth admin
or Config writes as ordinary transparent mesh service sharing.

Home LAN / VPN: share a low-risk local service with authenticated peers, but keep local
execution preferred and fall back locally if the peer is unavailable.

```json
{
  "services": {
    "tts": {
      "mesh_sharing": {
        "share": true,
        "max_concurrent": 2,
        "allowed_peers": null,
        "prefer": "local",
        "fallback": "local",
        "min_version": null,
        "required_capabilities": []
      }
    }
  }
}
```

Process cluster: prefer a known provider for a service that is safe to route inside the
cluster, while allowing local fallback during rolling restarts.

```json
{
  "services": {
    "orchestrator": {
      "mesh_sharing": {
        "share": false,
        "max_concurrent": 4,
        "allowed_peers": ["peer-gpu-node-01"],
        "prefer": "network",
        "fallback": "local",
        "min_version": "1.0.0",
        "required_capabilities": ["llm"]
      }
    }
  }
}
```

Internet-crossing peers: require explicit stable peer IDs, version policy, and capabilities.
Use `network_only` only when the local node should not satisfy the call itself; otherwise
prefer `network` with `fallback=error` so failures are visible instead of silently routing
to an unintended provider.

```json
{
  "services": {
    "tooling": {
      "mesh_sharing": {
        "share": true,
        "max_concurrent": 1,
        "allowed_peers": ["peer-admin-laptop"],
        "prefer": "network",
        "fallback": "error",
        "min_version": "1.0.0",
        "required_capabilities": ["tools"]
      }
    }
  }
}
```

---

## See also

- **app/shared/config/interface.py** -- ConfigAPI implementation.
- **app/shared/config/models_base.py** -- `BaseConfigModel` with `extra='ignore'`.
- **scripts/generate_config_artifacts.py** -- generation script.
- **docs/MESSAGING_ARCHITECTURE.md** -- bus overview and config note.
- **app/services/AGENTS.md** -- service lifecycle and startup order.
- **docker-compose.tilt.yml** -- **AURORA_CONFIG_FILE** for process + hot reload.

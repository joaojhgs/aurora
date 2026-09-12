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

## Mesh export and outbound routing policy examples

Per-service mesh policy has two independent blocks:

- `mesh_sharing` is the **export policy for this device**. `share` determines whether the
  service is advertised to authenticated peers, `max_concurrent` limits inbound remote
  calls, and `unshared_feature_ids` / `unshared_method_ids` subtract callable features or
  canonical bus topics from the exported service. Empty exclusion lists share every
  current external-or-both feature and method, including compatible methods added later.
- `mesh_routing` is the **outbound provider-selection policy for work originating on this
  device**. It controls local-versus-network preference and fallback, eligible stable
  provider peer IDs, provider version, required recipient-visible feature IDs, required
  provider metadata tags, and explicit-selector requirements. It never grants a peer
  inbound authority.

Inbound authority remains the intersection of service export, feature/method export, and
the authenticated peer's RBAC scopes. Outbound provider filters do not replace or grant
RBAC. Defaults are privacy-first: services are not exported, local execution is preferred,
and no remote provider requirements are configured.

Auth and Config do not expose operator-facing `mesh_sharing` blocks. Pairing/login
infrastructure is handled by the WebRTC RPC auth gate, and local Auth peer management
or Config mutation remains local-admin behavior. Do not model broad remote Auth admin
or Config writes as ordinary transparent mesh service sharing.

Home LAN / VPN: export a low-risk local service to authenticated peers, while keeping this
device's own outbound work local-first.

```json
{
  "services": {
    "tts": {
      "mesh_sharing": {
        "share": true,
        "max_concurrent": 2,
        "unshared_feature_ids": [],
        "unshared_method_ids": []
      },
      "mesh_routing": {
        "prefer": "local",
        "fallback": "local",
        "allowed_provider_peer_ids": null,
        "min_version": null,
        "required_provider_feature_ids": [],
        "required_provider_capability_tags": [],
        "require_explicit_selector": false
      }
    }
  }
}
```

Process cluster: do not export the local Orchestrator, but route this device's Orchestrator
work to one known provider and allow local fallback during rolling restarts.

```json
{
  "services": {
    "orchestrator": {
      "mesh_sharing": {
        "share": false,
        "max_concurrent": 4,
        "unshared_feature_ids": [],
        "unshared_method_ids": []
      },
      "mesh_routing": {
        "prefer": "network",
        "fallback": "local",
        "allowed_provider_peer_ids": ["peer-gpu-node-01"],
        "min_version": "1.0.0",
        "required_provider_feature_ids": ["inference"],
        "required_provider_capability_tags": ["llm"],
        "require_explicit_selector": false
      }
    }
  }
}
```

Internet-crossing peers: export only the intended local Tooling features and methods, and
separately require explicit stable provider IDs, version policy, and provider features for
outbound Tooling routes.
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
        "unshared_feature_ids": ["approval_administration", "policy_administration"],
        "unshared_method_ids": []
      },
      "mesh_routing": {
        "prefer": "network",
        "fallback": "error",
        "allowed_provider_peer_ids": ["peer-admin-laptop"],
        "min_version": "1.0.0",
        "required_provider_feature_ids": ["execution"],
        "required_provider_capability_tags": ["tools"],
        "require_explicit_selector": true
      }
    }
  }
}
```

> **Migration-only compatibility:** older generated configs may still contain routing or
> peer-filter keys inside `mesh_sharing`. They are compatibility input during migration,
> not the current policy-authoring model. New configuration and operator-facing guidance
> must write export controls to `mesh_sharing` and outbound provider controls to
> `mesh_routing`; inbound peer authorization belongs to Auth RBAC.

---

## See also

- **app/shared/config/interface.py** -- ConfigAPI implementation.
- **app/shared/config/models_base.py** -- `BaseConfigModel` with `extra='ignore'`.
- **scripts/generate_config_artifacts.py** -- generation script.
- **docs/MESSAGING_ARCHITECTURE.md** -- bus overview and config note.
- **app/services/AGENTS.md** -- service lifecycle and startup order.
- **docker-compose.tilt.yml** -- **AURORA_CONFIG_FILE** for process + hot reload.

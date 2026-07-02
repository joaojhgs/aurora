# Native Pydantic Configuration Migration Plan

> **SUPERSEDED** — This plan has been implemented and superseded by
> `docs/plans/CONFIG_SCHEMA_FIRST_PLAN.md`. The schema-first approach
> generates Pydantic models from `config_schema.json` via
> `make generate-config`, which is now the canonical workflow.

## 1. Rationale and Objective
Currently, Aurora relies on a string-based configuration lookup system (`config_api.get("services.gateway.api.port")`). This architecture has a few drawbacks:
- Lack of static type checking (MyPy/Pyright cannot validate if `"services.gateway.api.port"` returns an `int` or a `str`).
- Magic strings are prone to typos and refactoring breaks.
- Requires maintaining separate `config_defaults.json` and a verbose `config_schema.json` to enforce limits, which duplicates the source of truth.

**Objective**: Migrate from string-dict access to a strongly typed, deeply nested Pydantic model tree (e.g., `config.services.gateway.api.port`).

## 2. Target Architecture

We will define our configuration schema natively in Python code under `app/shared/config/models/`.

```python
from pydantic import BaseModel, Field, ConfigDict
from typing import Literal

# Base model for all configs to ensure distributed compatibility
class BaseConfigModel(BaseModel):
    model_config = ConfigDict(extra='ignore') # Crucial for distributed forward-compatibility

class GatewayApiConfig(BaseConfigModel):
    host: str = "0.0.0.0"
    port: int = Field(default=8000, ge=1, le=65535)
    request_timeout_s: float = 30.0
    token_secret: str = ""

# ... (Other nested models for STT, TTS, Orchestrator, etc.)

class ServicesConfig(BaseConfigModel):
    gateway: GatewayConfig = Field(default_factory=GatewayConfig)
    orchestrator: OrchestratorConfig = Field(default_factory=OrchestratorConfig)
    # ...

class AppConfig(BaseConfigModel):
    ui: UIConfig = Field(default_factory=UIConfig)
    system: SystemConfig = Field(default_factory=SystemConfig)
    services: ServicesConfig = Field(default_factory=ServicesConfig)
```

## 3. Phased Execution Strategy

To prevent a massive breaking change across the distributed architecture, this must be executed incrementally:

### Phase 1: Model Definition & Internal Validation Replacement
1. Build the full `AppConfig` hierarchy mirroring the current `services.*` structure.
2. Update `ConfigManager` to load `config.json` and `.env` map variables directly into the `AppConfig` class constructor to validate them natively.
3. *Backward Compatibility Bridge*: Maintain the `ConfigManager.get("dot.path")` functionality by converting the instantiated `AppConfig` back to a dictionary (`AppConfig.model_dump()`) internally for querying.

### Phase 2: Deprecate `config_schema.json` and `defaults.json`
1. Remap the UI Bridge metadata (currently fed by `config_schema.json`) to use Pydantic's native `AppConfig.model_json_schema()`. 
2. UI-specific properties like `ui_type: file` can be embedded directly in the `json_schema_extra` kwarg inside Pydantic `Field`s.
3. Delete `config_schema.json` and `config_defaults.json`. 

### Phase 3: Typified Exposure
Update `ConfigAPI` in `app/shared/config/interface.py` to expose the typed root object:
```python
async def aget_app_config(self) -> AppConfig:
    # Fetches from bus or cache, returns verified object.
```

### Phase 4: Service Refactoring
Perform an incremental sweep over all microservices (`TTS`, `STT`, `Gateway`, `Orchestrator`), switching them from string-key fetches to Pydantic object property dots.
```python
# Before
enabled = await config_api.aget("services.orchestrator.enabled")

# After
config = await config_api.aget_app_config()
enabled = config.services.orchestrator.enabled
```

### Phase 5: Complete Cleanup
Once no services use `config_api.get()`, remove the underlying string-query logic from `ConfigManager` and `ConfigAPI` entirely.

## 4. Distributed Systems & Version Negotiation Consideration

Because Aurora operates in a distributed containerized mesh (`process mode`), one service might roll out with `v1.2` of the `AppConfig` schema while `ConfigService` or another container runs on `v1.1`.

**The Reconciliation Rule (Robustness Principle):**
- Pydantic models MUST strictly enforce `ConfigDict(extra='ignore')`. If a newer ConfigService broadcasts a dict with an unknown `new_shiny_feature` key, older services will quietly ignore it rather than crashing upon validation.
- Fields must rarely be deleted or tightly restricted after deployment. If deprecated, they should remain as `Optional[type] = None` for several versions.
- Default values (`Field(default=X)`) handle missing keys from older deployments smoothly.

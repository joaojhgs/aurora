# Config Restructure Plan

## Rationale
Configuration is currently split across root keys like `general`, `plugins`, `mcp`, `gateway`, `deployment`. 
As the codebase migrated to a modular service architecture, the configuration must follow: config parameters should sit directly alongside their target service. This clarifies domain-boundaries, simplifies fallback logic, and naturally creates the ability to enable/disable ANY service uniformly via a `enabled` toggle.

## Proposed Strategy
Move from scattered properties to a unified `services` dictionary. 
Global app state like `ui` and `system.models_dir` will remain outside the services block.

## Schema Layout Example
```json
{
  "ui": {
    "activate": false,
    "dark_mode": false,
    "debug": false
  },
  "system": {
    "models_dir": "voice_models/"
  },
  "services": {
    "gateway": {
      "enabled": false,
      "api": {
          "host": "0.0.0.0",
          "port": 8000,
          "request_timeout_s": 30.0,
          "cors": { "origins": ["*"], "allow_credentials": true },
          "token_secret": ""
      },
      "mesh_network": {
          "enabled": false,
          "node_name": "",
          "version_policy": "compatible",
          "peer_selection": "lowest_latency"
      },
      "webrtc": { ... },
      "signaling_mqtt": { ... }
    },
    "auth": {
      "enabled": false,
      "mesh_sharing": { "share": false },
      "api_keys": [],
      "token_expiry_days": 365,
      ...
    },
    "tts": {
      "enabled": false,
      "mesh_sharing": { "share": false, "max_concurrent": 10, "prefer": "local", "fallback": "local" },
      "hardware_acceleration": false,
      "model_file_path": "voice_models/en_US-lessac-medium.onnx",
      "model_config_file_path": "voice_models/en_US-lessac-medium.onnx.txt",
      "piper_path": ""
    },
    "stt": {
      "language": "en",
      "coordinator": {
        "enabled": false,
        "mesh_sharing": { "share": false, "max_concurrent": 10 },
        "session_timeout_s": 10.0,
        "multi_turn_enabled": false,
        "pause_tts_on_listen": true,
        "ambient_transcription": { "enable": false },
        "audio_input": { "sample_rate": 16000 }
      },
      "wakeword": {
        "enabled": false,
        "mesh_sharing": { "share": false, "max_concurrent": 10 },
        "enabled": true,
        "backend": "oww",
        ...
      },
      "transcription": {
        "enabled": false,
        "mesh_sharing": { "share": false, "max_concurrent": 10 },
        "vad_enabled": true,
        "realtime_model": { "enabled": true, ... },
        "accurate_model": { "enabled": true, ... }
      },
      "hardware_acceleration": false
    },
    "orchestrator": {
      "enabled": true,
      "mesh_sharing": { "share": false, "max_concurrent": 10 },
      "hardware_acceleration": false,
      "llm": {
         "provider": "openai",
         "third_party": { ... },
         "local": { ... }
      }
    },
    "db": {
      "enabled": true,
      "mesh_sharing": { "share": false, "max_concurrent": 10 },
      "embeddings": { "use_local": true }
    },
    "tooling": {
      "enabled": true,
      "mesh_sharing": { "share": false, "max_concurrent": 10 },
      "hardware_acceleration": {
         "ocr_bg": false,
         "ocr_curr": false
      },
      "mcp": { "enabled": true, "servers": {} },
      "plugins": {
         "jira": { ... },
         "slack": { ... },
         "google": { ... }
      }
    },
    "scheduler": {
      "enabled": true,
      "mesh_sharing": { "share": false }
    },
    "config": {
      "enabled": true,
      "mesh_sharing": { "share": false }
    }
  }
}
```

## Migration Paths & Blast Radius

1. **`app/services/config/config_defaults.json` & `config_schema.json`**: Completely restructure to match the snippet above.
2. **`app/services/config/env_config.py`**: Update all `.env` variable map pointers (e.g. `plugins.github.activate` -> `services.tooling.plugins.github.activate`).
3. **`app/shared/services/base_service.py`**: Re-map `SERVICE_TO_DEPLOYMENT_KEY` so that it accesses `services.{service}.enabled` to decide lifecycle dormancy.
4. **`Tiltfile`**: Re-map Python Starlark dict lookups from `deployment.services.*` to `services.*.enabled`.
5. **Gateway Logic**: 
   - `gateway/service.py`'s fetch must adapt. Instead of `gateway.mesh.services.<service>`, Gateway will need to iterate over known services and ask `ConfigAPI` for `${service}.mesh_sharing`.
6. **Isolated API usages**:
   - `services/stt_transcription/service.py`: `general.speech_to_text.language` -> `services.stt.language`.
   - `services/tts/tts_engine.py`: `general.text_to_speech...` -> `services.tts...`.
   - `services/orchestrator/agents/chatbot.py`: `general.llm` -> `services.orchestrator.llm`.
   - `services/tooling/tools_manager.py`: `plugins.*` and `mcp.*` -> `services.tooling.*`.

This provides absolute clarity on what config drives what service, avoiding global bucket blobs entirely.

## Implementation Detail: Gateway Mesh Routing
Currently, Gateway reads `gateway.mesh.services` to expose local contracts to peers. Since this is now decentralized per-service (`services.<service>.mesh_sharing`), the `GatewayService._get_gateway_config()` method will execute:
```python
all_services = await config_api.aget_config("services")
mesh_cfg = gateway_config.get("mesh_network", {})
mesh_cfg["services"] = {}

for svc_name, svc_block in all_services.items():
    if isinstance(svc_block, dict) and "mesh_sharing" in svc_block:
        # Gateway expects capitalized matching or we just adapt match logic
        mesh_cfg["services"][svc_name] = svc_block["mesh_sharing"]
```
This isolates the config change from needing to rewrite `app/services/gateway/mesh/*.py`.

## Strategy for Optionality Settings
The user asked: "should we hide the keys for the specific services that are not optional? or allow the user to configure it...". 
We should let *everything* be optional. By providing a `enabled: boolean` structure systematically to every single service, the user has total power. If they turn off `config` or `db`, the application will naturally crash or fail to initialize those components. Later, external orchestration logic (like a custom setup UI or CLI profile script) can inject predefined profiles ("text-only", "head-less", etc.) that simply flip the relevant switches. `stt` is an excellent example, where components are nested explicitly so you could just run `transcription` without a `coordinator` mic grab.

## Migration Script
To prevent destroying developers' configuration states (like OpenAI keys or GitHub credentials), we should deploy a Python script `scripts/migrate_config_to_services_layout.py` that reads the old `config.json`, copies it to `config.old.json`, maps all properties dynamically to the new schema, and dumps it back.

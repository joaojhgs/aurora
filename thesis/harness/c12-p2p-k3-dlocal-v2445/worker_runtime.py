"""Normal requester Supervisor and retained passive ICE observation, after release."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys
import time

from admission_boundary import require_predecessor_release
from campaign import atomic, now, sha, write_once
from config_semantics import _active_config_semantics, _changed_config_paths
from runtime_pins import _read_runtime_pins, _verify_loaded_modules

STAGE = Path(__file__).resolve().parent


def _config(path):
    raw = Path(path).read_bytes()
    parsed = json.loads(raw)
    return hashlib.sha256(raw).hexdigest(), parsed


def _remaining_setup(manifest):
    end = datetime.fromisoformat(manifest["resourceAdmission"]["setupDeadlineUtc"])
    remaining = end.timestamp() - time.time()
    if remaining <= 0:
        raise RuntimeError("frozen_setup_deadline_reached")
    return remaining


@asynccontextmanager
async def open_worker_runtime(manifest):
    require_predecessor_release()
    output = Path(manifest["requesterOutput"])
    source = Path(manifest["workerSourceRoot"])
    private = Path(manifest["workerPrivateRoot"])
    config = Path(manifest["workerConfigPath"])
    assert output.is_dir() and private.is_dir() and source.is_dir()
    assert all(sha(STAGE / name) == value for name, value in manifest["sourceHashes"].items())
    assert sha(manifest["workerSourceInventory"]) == manifest["workerSourceInventorySha256"]
    before_sha, before = await asyncio.to_thread(_config, config)
    assert before_sha == manifest["workerConfigSha256"]
    # Only qualified environment settings and existing file references are reused.
    os.environ.update(manifest["workerEffectiveEnvironment"])
    os.environ["AURORA_BACKUP_DIR"] = str(private / "backups")
    os.environ["AURORA_ARCHITECTURE_MODE"] = "threads"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    os.environ["AURORA_VOICE_STAGE_HOST_ID"] = "worker-c12-p2p-k3-dlocal-v2445"
    os.environ["AURORA_VOICE_TELEMETRY_V430"] = "1"
    os.environ["AURORA_CONFIG_FILE"] = str(config)
    # Reuse the approved profile's references. Never copy its credential file or
    # silently create a different data store through a changed working directory.
    os.environ["AURORA_ENV_FILE"] = manifest["workerExistingEnvFile"]
    os.environ["AURORA_DATA_DIR"] = manifest["workerExistingDataDir"]
    os.environ["AURORA_VOICE_STAGE_OUTPUT"] = str(output / "voice-stages.jsonl")
    os.environ["AURORA_V409_OBSERVER_PATH"] = str(STAGE / "observer.py")
    os.chdir(private)
    sys.path[:0] = [str(STAGE), str(source)]

    # Before ordinary app startup, suppress application logs that may contain
    # bootstrap information. Explicit content-free observers remain active.
    from app.helpers.aurora_logger import logger as aurora_logger

    aurora_logger.logger.addFilter(lambda record: False)
    pins, pin_evidence = await asyncio.to_thread(
        _read_runtime_pins,
        STAGE,
        {"implementation": {"routeRuntimePinsSha256": manifest["sourceHashes"]["route_runtime_pins.json"]}},
    )
    import bindings

    assert Path(bindings.__file__).resolve() == STAGE / "bindings.py"
    bindings.install()
    for name in ("aiortc.rtcpeerconnection", "aiortc.rtcicetransport", "aioice.ice"):
        importlib.import_module(name)
    _verify_loaded_modules(pins)

    from app.services.gateway.mesh.peer_bridge import PeerBridge
    from app.shared.contracts.models.orchestrator import OrchestratorMethods
    from app.shared.contracts.models.stt import TranscriptionMethods
    from app.shared.contracts.models.tts import TTSMethods
    import mesh_route_observer
    from route_observation_sink import RouteObservationSink

    sink = RouteObservationSink(output / "mesh-route-observations.jsonl", output / "mesh-route-sink-status.json")
    sink.start()
    supervisor = None
    shutdown = False
    try:
        from authority_observer import install as observe_authority

        topics = (TranscriptionMethods.TRANSCRIBE, OrchestratorMethods.EXTERNAL_USER_INPUT, TTSMethods.SYNTHESIZE)
        observe_authority(PeerBridge, output / "dispatch-context-observations.jsonl", topics)
        mesh_route_observer.install_peer_bridge_observer(
            PeerBridge,
            sink.write,
            topic_filter=topics,
        )
        from aurora_voice_telemetry_v430 import install

        install()
        import main  # Ordinary config/dotenv loading; never enter its CLI loop.

        assert Path(main.__file__).resolve() == source / "main.py"
        from app.services.supervisor import Supervisor

        supervisor = Supervisor()

        async def start():
            await supervisor.initialize()
            await supervisor._subscribe_registered_contracts()
            await supervisor.start_services()
            await supervisor._subscribe_to_config_changes()

        await asyncio.wait_for(start(), timeout=_remaining_setup(manifest))
        after_sha, after = await asyncio.to_thread(_config, config)
        same = _active_config_semantics(before) == _active_config_semantics(after)
        write_once(output / "WORKER-RUNTIME-INITIALIZED.json", {
            "at": now(), "pid": os.getpid(),
            "configInputSha256": before_sha, "configAfterStartupSha256": after_sha,
            "changedConfigKeyPaths": _changed_config_paths(before, after),
            "effectiveConfigSemanticsUnchanged": same,
            "runtimePrefix": sys.prefix, "routeRuntimePinsSha256": pin_evidence["sha256"],
            "resolvedRuntimeFiles": pin_evidence["resolved_files"],
            "explicitCredentialOrGrantMutationCallsByHarness": False,
            "observationLimit": "Passive before/after selected-ICE snapshots; no pair ID or continuous-stability claim",
        })
        assert same, "startup_changed_effective_requester_configuration"
        yield supervisor
    finally:
        try:
            if supervisor is not None:
                await supervisor.shutdown()
                shutdown = True
        finally:
            drained = sink.close()
            write_once(output / "WORKER-RUNTIME-TERMINAL.json", {
                "at": now(), "pid": os.getpid(), "supervisorShutdownCompleted": shutdown,
                "routeSinkDrained": drained, "actualProcessRetirement": "Root must independently reconcile original PID/start ticks after exit",
            })


async def admit_routes(supervisor, manifest):
    """Use the production catalogue/selector decision; never evaluate grants here."""
    require_predecessor_release()
    from app.messaging.mesh_bus import MeshBus
    from app.shared.contracts.models.gateway import (
        CapabilityCatalogRequest, CapabilityCatalogResponse, GatewayMethods,
        RouteExplainRequest, RouteExplainResponse, RouteExplainSpeechConstraints,
    )
    from app.shared.contracts.models.mesh import MeshAddressSelector
    from app.shared.contracts.models.orchestrator import OrchestratorMethods
    from app.shared.contracts.models.stt import TranscriptionMethods
    from app.shared.contracts.models.tts import TTSMethods

    assert isinstance(supervisor.bus, MeshBus)
    expected = manifest["admittedPeers"]
    end = time.monotonic() + min(manifest["routeAdmissionCapSeconds"], _remaining_setup(manifest))
    output = Path(manifest["requesterOutput"])
    while time.monotonic() < end:
        raw = await supervisor.bus.request(
            GatewayMethods.GET_CAPABILITY_CATALOG,
            CapabilityCatalogRequest(modules=["Transcription", "Orchestrator", "TTS"], include_schemas=False),
            timeout=min(10, max(0.01, end - time.monotonic())),
        )
        routes = {}
        admitted = False
        catalogue = None
        if raw.ok:
            catalogue = CapabilityCatalogResponse.model_validate(raw.data)
            admitted = catalogue.local_peer_id == manifest["expectedLocalPeerId"]
            for name, topic in (
                ("stt", TranscriptionMethods.TRANSCRIBE),
                ("assistant", OrchestratorMethods.EXTERNAL_USER_INPUT),
                ("tts", TTSMethods.SYNTHESIZE),
            ):
                peer = expected[name]["peer_id"]
                answer = await supervisor.bus.request(
                    GatewayMethods.EXPLAIN_ROUTE,
                    RouteExplainRequest(
                        topic=topic,
                        speech=RouteExplainSpeechConstraints() if name != "assistant" else None,
                        selector=MeshAddressSelector(peer_id=peer),
                    ),
                    timeout=min(10, max(0.01, end - time.monotonic())),
                )
                if not answer.ok:
                    admitted = False
                    continue
                route = RouteExplainResponse.model_validate(answer.data)
                routes[name] = route.model_dump(mode="json")
                admitted = admitted and route.selector_valid and route.selected_peer_id == peer and not route.blockers and not route.security_privacy_blockers and any(p.peer_id == peer and p.eligible for p in catalogue.providers)
        row = {
            "at": now(), "monotonic_ns": time.monotonic_ns(),
            "status": "admitted" if admitted and len(routes) == 3 else "waiting",
            "catalogue": catalogue.model_dump(mode="json") if catalogue else None,
            "routes": routes, "modelRequests": 0,
            "authorityDecision": "Production Gateway/Rust-owned decision; exact selector prevents fallback",
        }
        atomic(output / "MESH-ROUTE-ADMISSION.json", row)
        if row["status"] == "admitted":
            return row
        await asyncio.sleep(min(2, max(0, end - time.monotonic())))
    raise RuntimeError("ordinary_exact_peer_catalogue_route_admission_deadline")

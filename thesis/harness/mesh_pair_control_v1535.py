"""Finite normal Aurora MQTT/ICE/pairing preparation, with no model services.

Config, DB, Auth and Gateway use their real contracts and implementation. Each
app process owns only its new private task directory. No direct SDP exchange,
trust-table writes, synthetic grants, HTTP listener or inference is provided.
Pair approval requires Root to compare both observed SAS/session fingerprints
and then submit an exact peer/session-scoped command. This is control readiness,
not proof of model service availability or a measured performance condition.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import runpy
import signal
import socket
import secrets
import sys
import time
import traceback


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def write(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".new")
    with temporary.open("w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def unwrap(response):
    if getattr(response, "ok", True) is False:
        raise RuntimeError("typed_bus_request_failed")
    return getattr(response, "data", response)


async def run(args) -> None:
    root = args.private_dir.resolve()
    root.mkdir(parents=True, exist_ok=args.reuse_task_state, mode=0o700)
    os.chdir(root)
    sys.path.insert(0, str(args.source_root.resolve()))
    # Read only the approved room parameters. All unrelated developer settings
    # and credentials are excluded from this task-local application config.
    parameters = json.loads(args.parameters.resolve().read_bytes())
    config = json.loads((args.source_root / "app/services/config/config_defaults.json").read_bytes())
    for service in config["services"].values():
        if isinstance(service, dict) and "enabled" in service:
            service["enabled"] = False
    gateway_config = config["services"]["gateway"]
    gateway_config["enabled"] = False  # Disable only the HTTP listener.
    allowed_webrtc = {"enabled", "strategy", "app_id", "room", "password", "encrypt_signaling",
                      "enable_app_layer_e2ee", "legacy_event_broadcast", "stun_servers", "turn_servers",
                      "turn_username", "turn_password"}
    gateway_config["webrtc"] = {key: value for key, value in parameters["webrtc"].items()
                                if key in allowed_webrtc}
    gateway_config["webrtc"]["enabled"] = True
    gateway_config["signaling_mqtt"] = parameters["signaling_mqtt"]
    if args.existing_configured_fallback:
        legacy = parameters["webrtc"].get("signaling_brokers", [])
        assert len(legacy) > 1 and legacy[1] not in gateway_config["signaling_mqtt"]["brokers"]
        gateway_config["signaling_mqtt"] = dict(gateway_config["signaling_mqtt"])
        gateway_config["signaling_mqtt"]["brokers"] = [legacy[1]]
    gateway_config["mesh_network"]["enabled"] = True
    gateway_config["mesh_network"]["node_name"] = "aurora-tcc-pair-v1535-" + args.role
    # No service is exported simply because a schema exists in the registry.
    for service in config["services"].values():
        if isinstance(service, dict) and isinstance(service.get("mesh_sharing"), dict):
            service["mesh_sharing"]["share"] = False
    config["services"]["auth"]["default_pairing_permissions"] = []
    config["services"]["auth"]["enabled"] = True
    config["services"]["auth"]["mesh_peer_orphan_pruning_enabled"] = False
    if (root / "config.json").exists():
        config = json.loads((root / "config.json").read_bytes())
        # Keep the same task-local database/identity. Fix only this unmeasured
        # control config, never the current benchmark's config or environment.
        config["services"]["gateway"]["webrtc"] = gateway_config["webrtc"]
        config["services"]["gateway"]["signaling_mqtt"] = gateway_config["signaling_mqtt"]
    from dotenv import dotenv_values
    existing_secret = dotenv_values(root / ".env").get("AURORA_TOKEN_SECRET")
    if not config["services"]["gateway"]["api"].get("token_secret") and not existing_secret:
        config["services"]["gateway"]["api"]["token_secret"] = secrets.token_urlsafe(32)
    write(root / "config.json", config)
    os.environ["AURORA_CONFIG_FILE"] = str(root / "config.json")
    os.environ["AURORA_ENV_FILE"] = str(root / ".env")
    os.environ["AURORA_DATA_DIR"] = str(root / "data")
    os.environ["AURORA_ARCHITECTURE_MODE"] = "threads"
    os.environ["AURORA_DEBUG_LOGS"] = "false"
    (root / "data").mkdir(exist_ok=args.reuse_task_state, mode=0o700)
    from dotenv import load_dotenv
    load_dotenv(root / ".env", override=False)

    # Normal Auth bootstraps app-local state. Suppress its INFO bootstrap
    # credential message rather than retaining it in any private/public log.
    from app.helpers.aurora_logger import logger as aurora_logger
    startup_errors = []

    class StartupErrors(logging.Filter):
        def filter(self, record):
            message = record.getMessage()
            if message.startswith("JSON Schema constraint violation"):
                return False  # Unrelated unset model defaults are not startup transport errors.
            if record.levelno >= logging.WARNING and len(startup_errors) < 50:
                from dotenv import dotenv_values
                secrets = [parameters["webrtc"].get(key) for key in ("password", "room", "app_id")]
                secrets.extend(parameters["webrtc"].get(key) for key in ("turn_password", "turn_username"))
                secrets.extend(parameters["signaling_mqtt"].get(key) for key in ("password", "username"))
                secrets.extend(value for key, value in dotenv_values(root / ".env").items()
                               if value and any(word in key for word in ("SECRET", "PASSWORD", "TOKEN", "KEY")))
                for value in secrets:
                    if value:
                        message = message.replace(str(value), "[private value]")
                startup_errors.append({"message": message[:2000],
                                       "exceptionCategory": record.exc_info[0].__name__ if record.exc_info else None})
            return False  # Never emit production payloads or bootstrap credentials.

    aurora_logger.logger.addFilter(StartupErrors())
    aurora_logger.logger.setLevel(logging.WARNING)
    from app.messaging.local_bus import LocalBus
    from app.messaging.bus_runtime import set_bus as set_runtime_bus
    from app.shared.messaging.bus_init import set_bus
    from app.services.auth.service import AuthService
    from app.services.config.service import ConfigService
    from app.services.db.service import DBService
    from app.services.gateway.service import GatewayService
    from app.shared.contracts.models.auth import (
        AuthMethods, ListPendingPairingsRequest, ListPendingPairingsResponse,
        PairingApproveRequest, PairingApproveResponse,
    )
    from app.shared.contracts.models.common import EmptyInput
    from app.shared.contracts.models.gateway import GatewayMethods, WebRTCDiagnosticsResponse
    from app.shared.contracts.models.mesh import MeshPeerListRequest, MeshPeerListResponse

    bus = LocalBus()
    set_bus(bus)
    set_runtime_bus(bus)
    await bus.start()
    state = {
        "at": datetime.now(timezone.utc).isoformat(), "host": socket.gethostname(),
        "pid": os.getpid(), "role": args.role, "phase": "starting",
        "newModelRequests": 0, "modelServicesStarted": [], "httpListenerStarted": False,
        "normalProductionContracts": True, "sourceRoot": str(args.source_root),
    }
    write(root / "STATUS.json", state)
    gateway = None
    db = None
    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, stopping.set)
    try:
        config_service = ConfigService()
        await config_service._subscribe_registered_contracts()
        db = DBService(str(root / "data/aurora.db"))
        await db._subscribe_registered_contracts()
        await db.db_manager.initialize()
        await db.scheduler_db.initialize()
        auth = AuthService()
        await auth._subscribe_registered_contracts()
        await auth.on_start()
        await config_service.on_start()
        gateway = GatewayService()
        await gateway._subscribe_registered_contracts()
        state["phase"] = "normal_gateway_start"
        write(root / "STATUS.json", state)
        await asyncio.wait_for(gateway.on_start(), timeout=120)
        if gateway._rtc_client is None:
            state.update(phase="control_plane_blocked", startupErrors=startup_errors)
            return  # End the finite admission; do not leave repeated reconnect traffic.
        end = time.monotonic() + args.lifetime
        approved = set()
        while not stopping.is_set() and time.monotonic() < end:
            rtc = gateway._rtc_client
            diagnostic = unwrap(await bus.request(
                GatewayMethods.GET_WEBRTC_DIAGNOSTICS, EmptyInput(), timeout=10,
            ))
            diagnostic = WebRTCDiagnosticsResponse.model_validate(diagnostic).model_dump(mode="json")
            pending = unwrap(await bus.request(
                AuthMethods.LIST_PENDING_PAIRINGS, ListPendingPairingsRequest(), timeout=10,
            ))
            pending = ListPendingPairingsResponse.model_validate(pending)
            peers = unwrap(await bus.request(
                AuthMethods.MESH_LIST_PEERS, MeshPeerListRequest(), timeout=10,
            ))
            peers = MeshPeerListResponse.model_validate(peers)
            safe_pending = [{
                "remotePeerId": item.remote_peer_id,
                "pairingSessionSha256": digest(item.pairing_session_id),
                "verificationCodeSha256": digest(item.verification_code),
                "sessionPresent": bool(item.pairing_session_id),
                "verificationPresent": bool(item.verification_code),
                "status": item.status,
            } for item in pending.pairings]
            command = root / "APPROVE.json"
            if command.exists():
                request = json.loads(command.read_bytes())
                # Root must compare the two real SAS results before approval.
                assert request.get("bothEndpointsSasComparedEqual") is True
                assert request.get("permissions") == args.permissions
                for item in pending.pairings:
                    if (item.remote_peer_id == request["peerId"]
                            and digest(item.pairing_session_id) == request["pairingSessionSha256"]
                            and digest(item.verification_code) == request["verificationCodeSha256"]
                            and item.pairing_session_id and item.verification_code
                            and item.pairing_session_id not in approved):
                        result = unwrap(await bus.request(
                            AuthMethods.PAIRING_APPROVE,
                            PairingApproveRequest(code=item.code, permissions=args.permissions, is_admin=False),
                            timeout=30,
                        ))
                        if not PairingApproveResponse.model_validate(result).success:
                            raise RuntimeError("normal_pairing_approval_rejected")
                        approved.add(item.pairing_session_id)
            # The product diagnostic includes non-bearer SAS values; publish
            # only fingerprints so output cannot become a credential channel.
            for peer in diagnostic.get("peers", []):
                for key in ("verification_code", "pairing_session_id"):
                    value = peer.pop(key, "")
                    peer[key + "_sha256"] = digest(value) if value else None
            trust = [{
                "peerId": item.peer_id, "outboundStatus": item.outbound_status,
                "inboundStatus": item.inbound_status,
                "outboundPermissions": item.outbound_permissions,
                "inboundPermissions": item.inbound_permissions,
            } for item in peers.peers]
            route_rows = []
            if args.route_observer:
                sample_route = runpy.run_path(str(args.route_observer))["sample_peer_route"]
                for peer in diagnostic.get("peers", []):
                    if peer.get("stable_peer_id"):
                        route_rows.append(sample_route(rtc, peer["stable_peer_id"]))
            state.update(at=datetime.now(timezone.utc).isoformat(),
                         phase="control_plane_live" if diagnostic.get("started") else "control_plane_not_ready",
                         diagnostic=diagnostic, pending=safe_pending, trust=trust,
                         normalApprovalCount=len(approved), allowedPeerPermissions=args.permissions,
                         startupErrors=startup_errors, observedRoutes=route_rows)
            write(root / "STATUS.json", state)
            await asyncio.sleep(2)
        state["phase"] = "finite_control_window_complete"
    except Exception as error:
        state.update(phase="control_plane_failed", errorCategory=type(error).__name__,
                     errorLocation=[{"file": Path(frame.filename).name, "function": frame.name, "line": frame.lineno}
                                    for frame in traceback.extract_tb(error.__traceback__)[-5:]])
        raise
    finally:
        if gateway is not None:
            try:
                await asyncio.wait_for(gateway.on_stop(), timeout=20)
            except Exception as error:
                state["shutdownErrorCategory"] = type(error).__name__
        await bus.stop()
        state.update(at=datetime.now(timezone.utc).isoformat(), ownRuntimeRetired=True)
        write(root / "STATUS.json", state)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--private-dir", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--parameters", type=Path, required=True)
    parser.add_argument("--role", choices=["worker", "personal"], required=True)
    parser.add_argument("--lifetime", type=int, default=600)
    parser.add_argument("--reuse-task-state", action="store_true")
    parser.add_argument("--existing-configured-fallback", action="store_true")
    parser.add_argument("--route-observer", type=Path)
    parser.add_argument("--permissions", nargs="+", required=True)
    args = parser.parse_args()
    assert 60 <= args.lifetime <= 900
    assert all(permission not in {"*", "all"} and not permission.endswith(".*")
               for permission in args.permissions)
    args.private_dir = args.private_dir.resolve()
    args.source_root = args.source_root.resolve()
    args.parameters = args.parameters.resolve()
    if args.route_observer:
        args.route_observer = args.route_observer.resolve()
    os.umask(0o077)
    try:
        asyncio.run(run(args))
    except Exception as error:
        # No exception text/locals: a runtime error can contain signaling data.
        print(json.dumps({"errorCategory": type(error).__name__, "missingModule": getattr(error, "name", None),
                          "errorLocation": [{"file": Path(frame.filename).name, "function": frame.name, "line": frame.lineno}
                                            for frame in traceback.extract_tb(error.__traceback__)[-5:]],
                          "newModelRequests": 0}), flush=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()

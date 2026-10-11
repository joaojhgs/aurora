#!/usr/bin/env python3
"""Own an isolated real thread-mode Aurora stack for the iOS voice flow."""

from __future__ import annotations

import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from contextlib import suppress
from pathlib import Path
from typing import Any

STARTUP_TIMEOUT_SECONDS = 180
STOP_TIMEOUT_SECONDS = 20
TOKEN_SCOPES = ["Orchestrator.use"]
_stop_requested = threading.Event()


def _write_private(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())


def _http_json(
    url: str, payload: dict[str, Any] | None = None, *, headers: dict[str, str] | None = None
) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request_headers = {"Accept": "application/json", **(headers or {})}
    if body is not None:
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            decoded = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        # Do not copy response bodies into logs: they may contain credentials.
        raise RuntimeError(f"Gateway request failed with HTTP {error.code}") from None
    except Exception as error:
        raise RuntimeError(f"Gateway request failed ({type(error).__name__})") from None
    if not isinstance(decoded, dict):
        raise RuntimeError("Gateway returned an invalid response")
    return decoded


def _gateway_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _write_config(repo: Path, runtime: Path, port: int, api_key: str, token_secret: str) -> Path:
    defaults = json.loads(
        (repo / "app/services/config/config_defaults.json").read_text(encoding="utf-8")
    )
    services = defaults["services"]
    services["config"]["enabled"] = True
    services["db"]["enabled"] = True
    services["db"].setdefault("embeddings", {})["use_local"] = False
    services["auth"]["enabled"] = True
    services["auth"]["api_keys"] = [api_key]
    services["gateway"]["enabled"] = True
    services["gateway"]["api"].update(
        {"host": "127.0.0.1", "port": port, "token_secret": token_secret}
    )
    services["orchestrator"]["enabled"] = False
    # Offline Assistant turns use the pinned on-device model; Gateway remains the real readiness boundary.
    services["tts"]["enabled"] = False
    services["stt"]["wakeword"]["enabled"] = False
    services["stt"]["transcription"]["enabled"] = False
    services["stt"]["coordinator"]["enabled"] = False
    defaults["ui"]["activate"] = False
    config_path = runtime / "config.json"
    _write_private(config_path, json.dumps(defaults, indent=2).encode("utf-8"))
    return config_path


def _issue_bearer(base_url: str, api_key: str) -> str:
    headers = {"X-API-Key": api_key}
    token_payload = {
        "principal_id": "system-user-id",
        "scopes": TOKEN_SCOPES,
        "expires_in_days": 1,
    }
    draft = _http_json(
        f"{base_url}/api/Gateway/AdminActionDraft",
        {
            "method_id": "Auth.CreateToken",
            "payload": token_payload,
            "affected_resources": ["principal:system-user-id"],
        },
        headers=headers,
    )
    action_id = str(draft.get("action_id") or "")
    nonce = str(draft.get("nonce") or "")
    digest = str(draft.get("digest") or "")
    if not action_id or not nonce or not digest:
        raise RuntimeError("Gateway did not return an Auth.CreateToken action draft")
    confirmed = _http_json(
        f"{base_url}/api/Gateway/AdminActionConfirm",
        {
            "action_id": action_id,
            "nonce": nonce,
            "digest": digest,
            "reason": "Isolated iOS native voice main-flow credential",
            "reauth_confirmed": True,
            "phrase": "CONFIRM",
        },
        headers=headers,
    )
    confirmation_token = str(confirmed.get("confirmation_token") or "")
    if not confirmation_token:
        raise RuntimeError("Gateway did not confirm the Auth.CreateToken action")
    created = _http_json(
        f"{base_url}/api/Auth/CreateToken",
        token_payload,
        headers={
            **headers,
            "X-Aurora-AdminAction-Id": action_id,
            "X-Aurora-AdminAction-Token": confirmation_token,
            "X-Aurora-AdminAction-Digest": digest,
        },
    )
    bearer = created.get("token")
    if not isinstance(bearer, str) or not bearer:
        raise RuntimeError("Auth did not issue the scoped Orchestrator bearer")
    return bearer


def _stop_process_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=STOP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def _handle_stop(_signum: int, _frame: object) -> None:
    _stop_requested.set()


def run(repo: Path, runtime: Path, dto_path: Path) -> None:
    runtime.mkdir(parents=True, exist_ok=True)
    data_dir = runtime / "data"
    data_dir.mkdir(mode=0o700)
    env_file = runtime / ".env"
    _write_private(env_file, b"")
    api_key = "ios-main." + secrets.token_urlsafe(32)
    token_secret = secrets.token_urlsafe(48)
    port = _gateway_port()
    config_path = _write_config(repo, runtime, port, api_key, token_secret)
    log_path = runtime / "main.log"
    child_env = dict(os.environ)
    # Prevent user/runner Aurora settings and the checkout's .env from changing
    # this isolated configuration or selecting a different provider/model.
    for key in tuple(child_env):
        if key.startswith("AURORA_") or key == "LLM_PROVIDER":
            child_env.pop(key, None)
    child_env.update(
        {
            "AURORA_ARCHITECTURE_MODE": "threads",
            "AURORA_CONFIG_FILE": str(config_path),
            "AURORA_DATA_DIR": str(data_dir),
            "AURORA_ENV_FILE": str(env_file),
            "AURORA_UI_ACTIVATE": "false",
            "PYTHONUNBUFFERED": "1",
            "PYTHONPATH": str(repo)
            + (os.pathsep + os.environ["PYTHONPATH"] if os.environ.get("PYTHONPATH") else ""),
        }
    )
    process: subprocess.Popen[bytes] | None = None
    try:
        with log_path.open("ab", buffering=0) as log_file:
            process = subprocess.Popen(
                [str(repo / ".venv/bin/python"), "main.py"],
                cwd=repo,
                env=child_env,
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            base_url = f"http://127.0.0.1:{port}"
            deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
            while time.monotonic() < deadline:
                if _stop_requested.is_set():
                    raise RuntimeError("Gateway startup was cancelled")
                if process.poll() is not None:
                    raise RuntimeError("Owned Aurora process exited before Gateway readiness")
                try:
                    health = _http_json(f"{base_url}/api/health")
                    if health:
                        break
                except RuntimeError:
                    pass
                time.sleep(0.5)
            else:
                raise RuntimeError("Timed out waiting for the owned Aurora Gateway")
            bearer = _issue_bearer(base_url, api_key)
            dto = {"gateway": base_url, "bearer": bearer}
            _write_private(dto_path, json.dumps(dto, separators=(",", ":")).encode("utf-8"))
            bearer = ""
            while not _stop_requested.wait(0.5):
                if process.poll() is not None:
                    raise RuntimeError("Owned Aurora process exited during the voice flow")
    finally:
        if process is not None:
            _stop_process_group(process)
        # The parent owns the enclosing temp directory and removes it only
        # after this helper exits and the owned process group has stopped.
        if dto_path.exists():
            with suppress(FileNotFoundError):
                dto_path.unlink()


def main() -> int:
    if len(sys.argv) != 4:
        return 64
    repo, runtime, dto_path = (Path(value).resolve() for value in sys.argv[1:])
    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)
    try:
        run(repo, runtime, dto_path)
        return 0
    except Exception as error:
        # Error text is deliberately secret-free and no service logs are copied.
        print(f"iOS voice Gateway setup failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

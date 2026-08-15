"""Process-mode gates for speech configuration compatibility.

These tests exercise ConfigService across the BullMQ/Redis boundary with a
temporary config file. They skip only when the process-mode dependencies or live
Redis are unavailable.
"""

# mypy: disable-error-code="untyped-decorator"

from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any, cast

import pytest

from app.messaging.bullmq_bus import BullMQBus
from app.services.config.messages import GetConfigQuery, ReloadServiceCommand, UpdateConfigCommand
from app.shared.contracts.models.config import (
    ConfigChange,
    ConfigCommitChangeSetRequest,
    ConfigDiffPreviewRequest,
    ConfigMethods,
)

pytest.importorskip("bullmq")
redis_sync = pytest.importorskip("redis")


pytestmark = [
    pytest.mark.integration,
    pytest.mark.process_mode,
    pytest.mark.bullmq_redis,
]

REDIS_URL = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379")
TEST_REDIS_URL = os.environ.get("AURORA_PROCESS_TEST_REDIS_URL", f"{REDIS_URL}/15")
SUBPROCESS_TIMEOUT_S = 10.0

TTS_MESH_POLICY: dict[str, Any] = {
    "mesh_sharing": {
        "share": False,
        "max_concurrent": 10,
        "allowed_peers": None,
        "prefer": "local",
        "fallback": "local",
        "min_version": None,
        "required_capabilities": [],
        "require_explicit_selector": False,
        "unshared_feature_ids": [],
        "unshared_method_ids": [],
    },
    "mesh_routing": {
        "prefer": "local",
        "fallback": "local",
        "allowed_provider_peer_ids": None,
        "min_version": None,
        "required_provider_feature_ids": [],
        "required_provider_capability_tags": [],
        "require_explicit_selector": False,
    },
}


@pytest.fixture
def redis_live() -> Iterator[Any]:
    """Use an isolated Redis DB and skip honestly when it is unavailable."""
    client = redis_sync.Redis.from_url(TEST_REDIS_URL, decode_responses=True)
    try:
        client.ping()
    except redis_sync.ConnectionError:
        pytest.skip("Redis not reachable - start Redis or set REDIS_URL")
    client.flushdb()
    yield client
    client.flushdb()
    client.close()


@pytest.fixture
def clean_process_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Clear speech env aliases so individual tests control precedence."""
    for name in (
        "AURORA_TTS_PROVIDER",
        "AURORA_TTS_FALLBACK_PROVIDER",
        "AURORA_TTS_MODEL_FILE_PATH",
        "AURORA_TTS_MODEL_CONFIG_FILE_PATH",
        "AURORA_TTS_MODEL_SAMPLE_RATE",
        "PIPER_PATH",
        "STT_LANGUAGE",
        "AURORA_PRIMARY_LANGUAGE",
        "AURORA_VOICE_LANGUAGE",
    ):
        monkeypatch.delenv(name, raising=False)


def _write_config(config_path: Path, payload: dict[str, Any]) -> str:
    serialized = json.dumps(payload, separators=(",", ":"))
    config_path.write_text(serialized, encoding="utf-8")
    return serialized


def _config_with_tts(tts: dict[str, Any]) -> dict[str, Any]:
    return {"services": {"tts": {**TTS_MESH_POLICY, **tts}}}


def _config_with_tts_and_stt(stt: dict[str, Any]) -> dict[str, Any]:
    return {"services": {"tts": {**TTS_MESH_POLICY}, "stt": stt}}


def _process_env(config_path: Path, extra_env: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "AURORA_ARCHITECTURE_MODE": "processes",
            "AURORA_CONFIG_FILE": str(config_path),
            "REDIS_URL": TEST_REDIS_URL,
            "PYTHONPATH": str(Path.cwd()),
        }
    )
    python_bin = Path(sys.executable).resolve().parent
    env["PATH"] = f"{python_bin}{os.pathsep}{env.get('PATH', '')}"
    if extra_env:
        env.update(extra_env)
    return env


def _start_config_service(
    config_path: Path,
    *,
    extra_env: dict[str, str] | None = None,
) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-m", "app.services.config"],
        cwd=Path.cwd(),
        env=_process_env(config_path, extra_env),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )


def _terminate_process(proc: subprocess.Popen[str]) -> tuple[str, str, float]:
    started = time.monotonic()
    if proc.poll() is None:
        with suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=SUBPROCESS_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            with suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=SUBPROCESS_TIMEOUT_S)
    elapsed = time.monotonic() - started
    stdout, stderr = proc.communicate(timeout=SUBPROCESS_TIMEOUT_S)
    return stdout, stderr, elapsed


def _child_pids(pid: int) -> list[int]:
    if shutil.which("ps") is None:
        return []
    result = subprocess.run(
        ["ps", "-o", "pid=", "--ppid", str(pid)],
        check=False,
        capture_output=True,
        text=True,
    )
    return [int(line.strip()) for line in result.stdout.splitlines() if line.strip()]


@asynccontextmanager
async def _running_config_service(
    config_path: Path,
    *,
    extra_env: dict[str, str] | None = None,
) -> AsyncIterator[tuple[BullMQBus, subprocess.Popen[str], list[str]]]:
    proc = _start_config_service(config_path, extra_env=extra_env)
    bus = BullMQBus(redis_url=TEST_REDIS_URL, validate_topics=False)
    await bus.start()
    shutdown_output: list[str] = []
    try:
        await _wait_for_config_service(bus, proc)
        yield bus, proc, shutdown_output
    finally:
        await bus.stop()
        stdout, stderr, elapsed = _terminate_process(proc)
        shutdown_output.extend([stdout, stderr, f"{elapsed:.3f}"])
        assert elapsed < SUBPROCESS_TIMEOUT_S
        assert "Task was destroyed but it is pending" not in stderr
        assert _child_pids(proc.pid) == []


async def _wait_for_config_service(bus: BullMQBus, proc: subprocess.Popen[str]) -> None:
    deadline = asyncio.get_running_loop().time() + SUBPROCESS_TIMEOUT_S
    last_error = ""
    while asyncio.get_running_loop().time() < deadline:
        if proc.poll() is not None:
            stdout, stderr = proc.communicate(timeout=SUBPROCESS_TIMEOUT_S)
            raise AssertionError(
                f"ConfigService exited before readiness; rc={proc.returncode}\n"
                f"stdout={stdout}\nstderr={stderr}"
            )
        result = await bus.request(
            ConfigMethods.GET,
            GetConfigQuery(section="system"),
            timeout=1.0,
            origin="integration-test",
        )
        if result.ok:
            return
        last_error = result.error or ""
        await asyncio.sleep(0.15)
    raise AssertionError(f"ConfigService did not become ready: {last_error}")


async def _get_section(bus: BullMQBus, section: str | None = None) -> dict[str, Any]:
    result = await bus.request(
        ConfigMethods.GET,
        GetConfigQuery(section=section),
        timeout=SUBPROCESS_TIMEOUT_S,
        origin="integration-test",
    )
    assert result.ok, result.error
    assert isinstance(result.data, dict)
    return cast(dict[str, Any], result.data["config"])


async def _set_config(bus: BullMQBus, key_path: str, value: Any) -> dict[str, Any]:
    result = await bus.request(
        ConfigMethods.SET,
        UpdateConfigCommand(key_path=key_path, value=value),
        timeout=SUBPROCESS_TIMEOUT_S,
        origin="integration-test",
    )
    assert isinstance(result.data, dict)
    return result.data


async def _preview_config(bus: BullMQBus, key_path: str, value: Any) -> dict[str, Any]:
    result = await bus.request(
        ConfigMethods.PREVIEW_DIFF,
        ConfigDiffPreviewRequest(changes=[ConfigChange(key_path=key_path, value=value)]),
        timeout=SUBPROCESS_TIMEOUT_S,
        origin="integration-test",
    )
    assert result.ok, result.error
    assert isinstance(result.data, dict)
    return result.data


async def _commit_config(
    bus: BullMQBus,
    *,
    key_path: str,
    value: Any,
    base_revision: int,
    preview_token: str,
) -> dict[str, Any]:
    result = await bus.request(
        ConfigMethods.COMMIT_CHANGE_SET,
        ConfigCommitChangeSetRequest(
            changes=[ConfigChange(key_path=key_path, value=value)],
            base_revision=base_revision,
            preview_token=preview_token,
        ),
        timeout=SUBPROCESS_TIMEOUT_S,
        origin="integration-test",
    )
    assert result.ok, result.error
    assert isinstance(result.data, dict)
    return result.data


def _piper_config(config: dict[str, Any]) -> dict[str, Any]:
    return cast(dict[str, Any], config["providers"]["piper"])


@pytest.mark.parametrize(
    ("payload", "env", "expected_model_path"),
    [
        (
            {
                "services": {
                    "tts": {
                        **TTS_MESH_POLICY,
                        "model_file_path": "legacy.onnx",
                        "providers": {"piper": {"model_file_path": "nested.onnx"}},
                    }
                }
            },
            {"AURORA_TTS_MODEL_FILE_PATH": "env.onnx"},
            "nested.onnx",
        ),
        (
            _config_with_tts({"model_file_path": "legacy.onnx"}),
            {"AURORA_TTS_MODEL_FILE_PATH": "env.onnx"},
            "legacy.onnx",
        ),
        (
            _config_with_tts({}),
            {"AURORA_TTS_MODEL_FILE_PATH": "env.onnx"},
            "env.onnx",
        ),
        (
            _config_with_tts({}),
            {},
            "voice_models/en_US-lessac-medium.onnx",
        ),
    ],
    ids=[
        "nested-canonical-wins",
        "legacy-flat-wins",
        "env-alias-wins",
        "generated-default-wins",
    ],
)
@pytest.mark.asyncio
async def test_tts_piper_precedence_crosses_config_process_boundary(
    tmp_path: Path,
    redis_live: Any,
    clean_process_env: None,
    payload: dict[str, Any],
    env: dict[str, str],
    expected_model_path: str,
) -> None:
    """TTS/Piper precedence is preserved across ConfigService and BullMQ."""
    config_path = tmp_path / "config.json"
    _write_config(config_path, payload)

    async with _running_config_service(config_path, extra_env=env) as (bus, _proc, _output):
        tts_config = await _get_section(bus, "services.tts")

    assert _piper_config(tts_config)["model_file_path"] == expected_model_path


@pytest.mark.parametrize(
    ("payload", "env", "expected_system"),
    [
        (
            _config_with_tts_and_stt({"language": "pt"}),
            {"AURORA_PRIMARY_LANGUAGE": "de", "AURORA_VOICE_LANGUAGE": "fr"},
            {"primary_language": "pt", "voice_language": "pt"},
        ),
        (
            _config_with_tts_and_stt({}),
            {
                "STT_LANGUAGE": "pt",
                "AURORA_PRIMARY_LANGUAGE": "de",
                "AURORA_VOICE_LANGUAGE": "fr",
            },
            {"primary_language": "pt", "voice_language": "pt"},
        ),
        (
            _config_with_tts_and_stt({}),
            {"AURORA_PRIMARY_LANGUAGE": "de", "AURORA_VOICE_LANGUAGE": "fr"},
            {"primary_language": "de", "voice_language": "fr"},
        ),
        (_config_with_tts({}), {}, {"primary_language": "en", "voice_language": "auto"}),
    ],
    ids=[
        "legacy-language-wins",
        "configservice-env-alias-wins",
        "central-env-wins",
        "generated-default-wins",
    ],
)
@pytest.mark.asyncio
async def test_speech_language_precedence_crosses_config_process_boundary(
    tmp_path: Path,
    redis_live: Any,
    clean_process_env: None,
    payload: dict[str, Any],
    env: dict[str, str],
    expected_system: dict[str, str],
) -> None:
    """Central speech language precedence is preserved across ConfigService and BullMQ."""
    config_path = tmp_path / "config.json"
    _write_config(config_path, payload)

    async with _running_config_service(config_path, extra_env=env) as (bus, _proc, _output):
        system_config = await _get_section(bus, "system")

    assert {
        "primary_language": system_config["primary_language"],
        "voice_language": system_config["voice_language"],
    } == expected_system


@pytest.mark.asyncio
async def test_legacy_speech_config_load_does_not_rewrite_source_file(
    tmp_path: Path,
    redis_live: Any,
    clean_process_env: None,
) -> None:
    """Legacy speech config loads canonically without mutating the source file."""
    config_path = tmp_path / "config.json"
    original = _write_config(
        config_path,
        {
            "services": {
                "tts": {
                    **TTS_MESH_POLICY,
                    "model_file_path": "legacy.onnx",
                    "model_config_file_path": "legacy.onnx.json",
                    "model_sample_rate": 16000,
                    "piper_path": "/opt/legacy-piper",
                }
            }
        },
    )

    async with _running_config_service(config_path) as (bus, _proc, _output):
        tts_config = await _get_section(bus, "services.tts")

    assert _piper_config(tts_config) == {
        "model_file_path": "legacy.onnx",
        "model_config_file_path": "legacy.onnx.json",
        "model_sample_rate": 16000,
        "executable_path": "/opt/legacy-piper",
    }
    assert config_path.read_text(encoding="utf-8") == original


@pytest.mark.asyncio
async def test_legacy_speech_config_logs_one_deprecation_warning_per_process_load(
    tmp_path: Path,
    redis_live: Any,
    clean_process_env: None,
) -> None:
    """A legacy process load emits exactly one structured deprecation warning."""
    config_path = tmp_path / "config.json"
    _write_config(config_path, _config_with_tts({"model_file_path": "legacy.onnx"}))

    async with _running_config_service(config_path) as (bus, _proc, output):
        await _get_section(bus, "services.tts")

    stdout, stderr = output[:2]
    assert f"{stdout}\n{stderr}".count("deprecated_speech_config_loaded") == 1


@pytest.mark.asyncio
async def test_old_and_new_tts_shapes_return_same_effective_canonical_values(
    tmp_path: Path,
    redis_live: Any,
    clean_process_env: None,
) -> None:
    """Old and new TTS shapes expose the same effective canonical values."""
    legacy_path = tmp_path / "legacy.json"
    canonical_path = tmp_path / "canonical.json"
    legacy_original = _write_config(
        legacy_path,
        {
            "services": {
                "tts": {
                    **TTS_MESH_POLICY,
                    "model_file_path": "same.onnx",
                    "model_config_file_path": "same.onnx.json",
                    "model_sample_rate": 24000,
                    "piper_path": "/opt/same-piper",
                }
            }
        },
    )
    canonical_original = _write_config(
        canonical_path,
        {
            "services": {
                "tts": {
                    **TTS_MESH_POLICY,
                    "providers": {
                        "piper": {
                            "model_file_path": "same.onnx",
                            "model_config_file_path": "same.onnx.json",
                            "model_sample_rate": 24000,
                            "executable_path": "/opt/same-piper",
                        }
                    },
                }
            }
        },
    )

    async with _running_config_service(legacy_path) as (bus, _proc, _output):
        legacy_tts = await _get_section(bus, "services.tts")
    redis_live.flushdb()
    async with _running_config_service(canonical_path) as (bus, _proc, _output):
        canonical_tts = await _get_section(bus, "services.tts")

    assert _piper_config(legacy_tts) == _piper_config(canonical_tts)
    assert legacy_path.read_text(encoding="utf-8") == legacy_original
    assert canonical_path.read_text(encoding="utf-8") == canonical_original


@pytest.mark.asyncio
async def test_commit_change_set_serializes_reload_consistently_across_process_boundary(
    tmp_path: Path,
    redis_live: Any,
    clean_process_env: None,
) -> None:
    """Committed speech changes serialize and publish reload metadata consistently."""
    config_path = tmp_path / "config.json"
    _write_config(config_path, _config_with_tts({}))

    async with _running_config_service(config_path) as (bus, _proc, _output):
        events: list[dict[str, Any]] = []
        event_bus = BullMQBus(redis_url=TEST_REDIS_URL, validate_topics=True)
        await event_bus.start()

        async def on_config_updated(envelope: Any) -> None:
            events.append(envelope.payload)

        try:
            event_bus.subscribe(ConfigMethods.UPDATED, on_config_updated)
            await asyncio.sleep(0.2)
            preview = await _preview_config(
                bus,
                "services.tts.providers.piper.model_file_path",
                "committed.onnx",
            )
            assert preview["valid"] is True
            assert preview["preview_token"]

            committed = await _commit_config(
                bus,
                key_path="services.tts.providers.piper.model_file_path",
                value="committed.onnx",
                base_revision=preview["base_revision"],
                preview_token=preview["preview_token"],
            )
            assert committed["success"] is True
            assert committed["changed_paths"] == ["services.tts.providers.piper.model_file_path"]

            deadline = asyncio.get_running_loop().time() + SUBPROCESS_TIMEOUT_S
            while not events and asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.05)
            assert events

            tts_config = await _get_section(bus, "services.tts")
        finally:
            await event_bus.stop()

    persisted = json.loads(config_path.read_text(encoding="utf-8"))
    assert _piper_config(tts_config)["model_file_path"] == "committed.onnx"
    assert persisted["services"]["tts"]["providers"]["piper"]["model_file_path"] == (
        "committed.onnx"
    )
    assert events[0]["key_path"] == "services.tts.providers.piper.model_file_path"
    assert events[0]["changed_paths"] == ["services.tts.providers.piper.model_file_path"]
    assert events[0]["config_revision"] == committed["revision"]
    assert "services.tts" in events[0]["affected_sections"]


@pytest.mark.parametrize(
    ("key_path", "invalid_value", "healthy_section", "healthy_value"),
    [
        ("services.tts.provider", "not-a-provider", "services.tts", "piper"),
        ("system.primary_language", "en--US", "system", "en"),
    ],
    ids=["invalid-provider", "invalid-language"],
)
@pytest.mark.asyncio
async def test_invalid_speech_update_retains_previous_healthy_config(
    tmp_path: Path,
    redis_live: Any,
    clean_process_env: None,
    key_path: str,
    invalid_value: str,
    healthy_section: str,
    healthy_value: str,
) -> None:
    """Rejected invalid speech updates keep the previous healthy value."""
    config_path = tmp_path / "config.json"
    _write_config(
        config_path,
        {"system": {"primary_language": "en"}, "services": {"tts": {**TTS_MESH_POLICY}}},
    )

    async with _running_config_service(config_path) as (bus, _proc, _output):
        rejected = await _set_config(bus, key_path, invalid_value)
        current = await _get_section(bus, healthy_section)

    assert rejected["success"] is False
    if healthy_section == "system":
        assert current["primary_language"] == healthy_value
    else:
        assert current["provider"] == healthy_value


@pytest.mark.asyncio
async def test_reload_service_request_and_shutdown_are_bounded_without_leftover_processes(
    tmp_path: Path,
    redis_live: Any,
    clean_process_env: None,
) -> None:
    """ConfigService handles reload requests and exits without leftover children."""
    config_path = tmp_path / "config.json"
    _write_config(config_path, _config_with_tts({}))

    async with _running_config_service(config_path) as (bus, proc, _output):
        result = await bus.request(
            ConfigMethods.RELOAD_SERVICE,
            ReloadServiceCommand(service_name="TTS", reason="integration-test"),
            timeout=SUBPROCESS_TIMEOUT_S,
            origin="integration-test",
        )
        assert result.ok, result.error
        assert proc.poll() is None

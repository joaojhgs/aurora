"""PocketTTS process-mode gates using BullMQ and a deterministic fake package."""

# mypy: disable-error-code="untyped-decorator"

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import io
import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import time
import wave
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, cast

import pytest

from app.messaging.bullmq_bus import BullMQBus
from app.services.config.messages import GetConfigQuery, UpdateConfigCommand
from app.services.tts.providers.pockettts import (
    POCKETTTS_CONFIGS,
    PocketTTSProviderConfig,
    resolve_pockettts_base_identity_spec,
    resolve_pockettts_config,
)
from app.services.tts.voice_registry import VoiceRegistry
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.tts import (
    TTSAudioChunkEvent,
    TTSMethods,
    TTSStopRequest,
    TTSStreamChunkRequest,
    TTSStreamStartRequest,
    TTSSynthesizeRequest,
)

pytest.importorskip("bullmq")
redis_sync = pytest.importorskip("redis")


pytestmark = [
    pytest.mark.integration,
    pytest.mark.process_mode,
    pytest.mark.bullmq_redis,
]

REPO_ROOT = Path(__file__).resolve().parents[3]
FAKE_PACKAGE_ROOT = REPO_ROOT / "tests" / "fixtures" / "pockettts_fake_pkg"
REDIS_URL = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379")
TEST_REDIS_URL = os.environ.get("AURORA_POCKETTTS_PROCESS_TEST_REDIS_URL", f"{REDIS_URL}/14")
SUBPROCESS_TIMEOUT_S = 20.0
TEST_VOICE_ID = "standard:aurora_process:neutral"
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
FORBIDDEN_STDERR_FRAGMENTS = (
    str(REPO_ROOT),
    str(FAKE_PACKAGE_ROOT),
    "Task was destroyed but it is pending",
    "Traceback (most recent call last)",
)


@pytest.fixture(autouse=True)
def fake_pockettts_on_parent_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """Let the pytest process resolve fake packaged PocketTTS config resources."""
    monkeypatch.syspath_prepend(str(FAKE_PACKAGE_ROOT))


@pytest.fixture
def redis_live() -> Iterator[Any]:
    """Use a Redis DB isolated from other process-mode suites."""
    client = redis_sync.Redis.from_url(TEST_REDIS_URL, decode_responses=True)
    try:
        client.ping()
    except redis_sync.ConnectionError:
        pytest.skip("Redis not reachable - start Redis or set REDIS_URL")
    client.flushdb()
    yield client
    client.flushdb()
    client.close()


def _write_config(config_path: Path, payload: dict[str, Any]) -> None:
    config_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def _pockettts_config(
    *,
    registry_dir: Path,
    language: str = "en",
    voice_id: str = TEST_VOICE_ID,
    quality_tier: str = "compact",
    preload_voice_ids: list[str] | None = None,
    request_timeout_s: float = 8.0,
    initialization_timeout_s: float = 8.0,
) -> dict[str, Any]:
    return {
        "system": {"primary_language": language, "voice_language": "auto"},
        "services": {
            "tts": {
                **TTS_MESH_POLICY,
                "enabled": True,
                "provider": "pockettts",
                "default_voice_id": voice_id,
                "providers": {
                    "pockettts": {
                        "quality_tier": quality_tier,
                        "device": "cpu",
                        "preload_model": True,
                        "preload_voice_ids": preload_voice_ids or [voice_id],
                        "request_timeout_s": request_timeout_s,
                        "initialization_timeout_s": initialization_timeout_s,
                    }
                },
                "voice_registry": {
                    "cache_dir": str(registry_dir),
                    "standard_pack_enabled": True,
                    "cloning_enabled": False,
                },
            }
        },
    }


def _process_env(
    config_path: Path,
    fake_state: Path,
    extra_env: dict[str, str] | None = None,
) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "AURORA_ARCHITECTURE_MODE": "processes",
            "AURORA_CONFIG_FILE": str(config_path),
            "REDIS_URL": TEST_REDIS_URL,
            "PYTHONPATH": f"{FAKE_PACKAGE_ROOT}{os.pathsep}{REPO_ROOT}",
            "POCKETTTS_FAKE_TELEMETRY": str(fake_state / "telemetry.jsonl"),
            "POCKETTTS_FAKE_STATE_DIR": str(fake_state),
            "POCKETTTS_FAKE_CACHE_DIR": str(fake_state / "cache"),
            "PYTHONWARNINGS": 'ignore:Field name "schema" in "ToolingToolInfo":UserWarning',
        }
    )
    python_bin = Path(sys.executable).resolve().parent
    env["PATH"] = f"{python_bin}{os.pathsep}{env.get('PATH', '')}"
    if extra_env:
        env.update(extra_env)
    return env


def _start_service(
    module: str,
    config_path: Path,
    fake_state: Path,
    *,
    extra_env: dict[str, str] | None = None,
) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-m", module],
        cwd=REPO_ROOT,
        env=_process_env(config_path, fake_state, extra_env),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )


def _terminate_process(proc: subprocess.Popen[str]) -> tuple[str, str, float]:
    started = time.monotonic()
    if proc.poll() is None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=SUBPROCESS_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
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


def _assert_sanitized_stderr(stderr: str) -> None:
    for fragment in FORBIDDEN_STDERR_FRAGMENTS:
        assert fragment not in stderr


@asynccontextmanager
async def _running_config_and_tts(
    config_path: Path,
    fake_state: Path,
    *,
    extra_env: dict[str, str] | None = None,
) -> AsyncIterator[
    tuple[BullMQBus, list[subprocess.Popen[str]], list[tuple[str, str, str, float]]]
]:
    config_proc = _start_service(
        "app.services.config", config_path, fake_state, extra_env=extra_env
    )
    tts_proc: subprocess.Popen[str] | None = None
    bus = BullMQBus(redis_url=TEST_REDIS_URL, validate_topics=False)
    await bus.start()
    output: list[tuple[str, str, str, float]] = []
    try:
        await _wait_for_config_service(bus, config_proc)
        tts_proc = _start_service("app.services.tts", config_path, fake_state, extra_env=extra_env)
        await _wait_for_tts_service(
            bus,
            config_proc,
            tts_proc,
            fake_state=fake_state,
            synth_probe=not (extra_env or {}).get("POCKETTTS_FAKE_BLOCK_FILE"),
        )
        yield bus, [config_proc, tts_proc], output
    finally:
        await bus.stop()
        terminated: list[tuple[str, subprocess.Popen[str], str, str, float, list[int]]] = []
        for name, proc in (("tts", tts_proc), ("config", config_proc)):
            if proc is None:
                continue
            child_pid_snapshot = _child_pids(proc.pid)
            stdout, stderr, elapsed = _terminate_process(proc)
            output.append((name, stdout, stderr, elapsed))
            terminated.append((name, proc, stdout, stderr, elapsed, child_pid_snapshot))
        for _name, proc, _stdout, stderr, elapsed, child_pid_snapshot in terminated:
            assert elapsed < SUBPROCESS_TIMEOUT_S
            assert child_pid_snapshot == []
            assert _child_pids(proc.pid) == []
            _assert_sanitized_stderr(stderr)


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


async def _wait_for_tts_service(
    bus: BullMQBus,
    config_proc: subprocess.Popen[str],
    tts_proc: subprocess.Popen[str],
    *,
    fake_state: Path,
    synth_probe: bool,
) -> None:
    deadline = asyncio.get_running_loop().time() + SUBPROCESS_TIMEOUT_S
    last_error = ""
    while asyncio.get_running_loop().time() < deadline:
        for name, proc in (("ConfigService", config_proc), ("TTSService", tts_proc)):
            if proc.poll() is not None:
                stdout, stderr = proc.communicate(timeout=SUBPROCESS_TIMEOUT_S)
                raise AssertionError(
                    f"{name} exited before readiness; rc={proc.returncode}\n"
                    f"stdout={stdout}\nstderr={stderr}"
                )
        if not any(event.get("event") == "load_model" for event in _read_events(fake_state)):
            await asyncio.sleep(0.15)
            continue
        if synth_probe:
            result = await _synthesize(bus, "ready", timeout=2.0)
            if result.ok:
                return
            last_error = result.error or ""
        else:
            return
        await asyncio.sleep(0.15)
    raise AssertionError(f"TTSService did not become ready: {last_error}")


async def _synthesize(
    bus: BullMQBus,
    text: str,
    *,
    voice: str | None = TEST_VOICE_ID,
    language: str | None = None,
    quality: str | None = None,
    timeout: float = SUBPROCESS_TIMEOUT_S,
) -> Any:
    del language, quality
    return await bus.request(
        TTSMethods.SYNTHESIZE,
        TTSSynthesizeRequest(text=text, voice=voice, format="wav", sample_rate=24000),
        timeout=timeout,
        origin="integration-test",
    )


async def _set_config(bus: BullMQBus, key_path: str, value: Any) -> dict[str, Any]:
    result = await bus.request(
        ConfigMethods.SET,
        UpdateConfigCommand(key_path=key_path, value=value),
        timeout=SUBPROCESS_TIMEOUT_S,
        origin="integration-test",
    )
    assert isinstance(result.data, dict)
    return result.data


def _read_events(fake_state: Path) -> list[dict[str, Any]]:
    telemetry = fake_state / "telemetry.jsonl"
    if not telemetry.exists():
        return []
    return [json.loads(line) for line in telemetry.read_text(encoding="utf-8").splitlines() if line]


async def _wait_for_event(fake_state: Path, event_name: str) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + SUBPROCESS_TIMEOUT_S
    while asyncio.get_running_loop().time() < deadline:
        for event in _read_events(fake_state):
            if event.get("event") == event_name:
                return event
        await asyncio.sleep(0.05)
    raise AssertionError(f"fake telemetry event not observed: {event_name}")


async def _wait_for_event_after(
    fake_state: Path,
    event_name: str,
    start_index: int,
) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + SUBPROCESS_TIMEOUT_S
    while asyncio.get_running_loop().time() < deadline:
        for event in _read_events(fake_state)[start_index:]:
            if event.get("event") == event_name:
                return event
        await asyncio.sleep(0.05)
    raise AssertionError(f"fake telemetry event not observed after Config.SET: {event_name}")


def _max_active(fake_state: Path) -> int:
    try:
        return int((fake_state / "max_active.txt").read_text(encoding="utf-8").strip())
    except FileNotFoundError:
        return 0


def _safetensors_bytes() -> bytes:
    tensor_data = struct.pack("<f", 1.0)
    header = json.dumps(
        {"prompt.offset": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}},
        separators=(",", ":"),
    ).encode("utf-8")
    return struct.pack("<Q", len(header)) + header + tensor_data


async def _install_voice(
    registry_dir: Path, *, language: str = "en", quality_tier: str = "compact"
) -> str:
    config_info = resolve_pockettts_config(language, cast(Any, quality_tier))
    identity = resolve_pockettts_base_identity_spec(
        PocketTTSProviderConfig(effective_language=language, quality_tier=cast(Any, quality_tier))
    ).voice_base_identity
    artifact_bytes = _safetensors_bytes()
    artifact_root = registry_dir.parent / f"voice-source-{config_info.config_id}"
    artifact_root.mkdir(parents=True, exist_ok=True)
    artifact_path = artifact_root / "neutral.safetensors"
    artifact_path.write_bytes(artifact_bytes)
    digest = hashlib.sha256(artifact_bytes).hexdigest()
    manifest_path = artifact_root / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "pack_id": "aurora_process",
                "pack_version": f"test-{config_info.config_id}",
                "minimum_aurora_version": "0",
                "minimum_runtime_version": "0",
                "assets": [
                    {
                        "asset_id": "neutral",
                        "logical_voice_id": TEST_VOICE_ID,
                        "display_name": "Neutral",
                        "runtime_target": identity.runtime_target,
                        "language_bundle": identity.language_bundle,
                        "compatibility_group": identity.compatibility_group,
                        "artifact_revision": "test-rev",
                        "feature": "voice-state",
                        "size_bytes": len(artifact_bytes),
                        "sha256": digest,
                        "relative_path": artifact_path.name,
                        "compression": "none",
                        "unpacked_size_bytes": len(artifact_bytes),
                        "license_name": "Aurora test fixture",
                        "redistribution": "approved",
                        "attribution": None,
                        "upstream_source": None,
                    }
                ],
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    await VoiceRegistry(registry_dir).install_standard_pack(manifest_path, artifact_root)
    return str(config_info.config_id)


def _decode_wav_response(result: Any, expected_text: str) -> tuple[bytes, int]:
    assert result.ok, result.error
    assert isinstance(result.data, dict)
    assert result.data["format"] == "wav"
    assert result.data["sample_rate"] == 24000
    assert result.data["channels"] == 1
    assert result.data["text"] == expected_text
    payload = base64.b64decode(result.data["audio_data"])
    with wave.open(cast(Any, io.BytesIO(payload)), "rb") as wav_file:
        assert wav_file.getframerate() == 24000
        assert wav_file.getnchannels() == 1
        assert wav_file.getsampwidth() == 2
        frames = wav_file.readframes(wav_file.getnframes())
    assert frames
    return frames, result.data["sample_rate"]


async def _subscribe_audio_chunks() -> tuple[list[TTSAudioChunkEvent], BullMQBus]:
    events: list[TTSAudioChunkEvent] = []
    event_bus = BullMQBus(redis_url=TEST_REDIS_URL, validate_topics=False)
    await event_bus.start()

    async def on_audio_chunk(envelope: Any) -> None:
        events.append(TTSAudioChunkEvent.model_validate(envelope.payload))

    await event_bus.subscribe_event(TTSMethods.AUDIO_CHUNK, on_audio_chunk)
    return events, event_bus


async def test_finite_synthesis_crosses_process_boundary_with_valid_24k_wav(
    tmp_path: Path, redis_live: Any
) -> None:
    del redis_live
    registry_dir = tmp_path / "voice-pack"
    await _install_voice(registry_dir)
    fake_state = tmp_path / "fake"
    config_path = tmp_path / "config.json"
    _write_config(config_path, _pockettts_config(registry_dir=registry_dir))

    async with _running_config_and_tts(config_path, fake_state) as (bus, _procs, _output):
        result = await _synthesize(bus, "finite process audio")

    frames, sample_rate = _decode_wav_response(result, "finite process audio")
    assert sample_rate == 24000
    assert len(frames) % 2 == 0
    assert any(event["event"] == "generate_audio_begin" for event in _read_events(fake_state))


async def test_concurrent_synthesis_keeps_single_model_entry_under_bullmq_concurrency(
    tmp_path: Path, redis_live: Any
) -> None:
    del redis_live
    registry_dir = tmp_path / "voice-pack"
    await _install_voice(registry_dir)
    fake_state = tmp_path / "fake"
    block_file = tmp_path / "block"
    release_file = tmp_path / "release"
    block_file.write_text("block\n", encoding="utf-8")
    config_path = tmp_path / "config.json"
    _write_config(config_path, _pockettts_config(registry_dir=registry_dir))

    async with _running_config_and_tts(
        config_path,
        fake_state,
        extra_env={
            "POCKETTTS_FAKE_BLOCK_FILE": str(block_file),
            "POCKETTTS_FAKE_RELEASE_FILE": str(release_file),
        },
    ) as (bus, _procs, _output):
        first = asyncio.create_task(_synthesize(bus, "first blocked", timeout=SUBPROCESS_TIMEOUT_S))
        await _wait_for_event(fake_state, "blocked")
        second = asyncio.create_task(
            _synthesize(bus, "second queued", timeout=SUBPROCESS_TIMEOUT_S)
        )
        await asyncio.sleep(0.2)
        assert _max_active(fake_state) == 1
        release_file.write_text("release\n", encoding="utf-8")
        first_result, second_result = await asyncio.gather(first, second)

    _decode_wav_response(first_result, "first blocked")
    _decode_wav_response(second_result, "second queued")
    assert _max_active(fake_state) == 1


async def test_ordered_stream_and_scoped_stop_emit_one_terminal_without_late_events(
    tmp_path: Path, redis_live: Any
) -> None:
    del redis_live
    registry_dir = tmp_path / "voice-pack"
    await _install_voice(registry_dir)
    fake_state = tmp_path / "fake"
    config_path = tmp_path / "config.json"
    _write_config(config_path, _pockettts_config(registry_dir=registry_dir))
    stream_id = "process-stream"
    correlation_id = "corr-process-stream"

    async with _running_config_and_tts(config_path, fake_state) as (bus, _procs, _output):
        chunks, event_bus = await _subscribe_audio_chunks()
        try:
            start = await bus.request(
                TTSMethods.STREAM_START,
                TTSStreamStartRequest(
                    stream_id=stream_id,
                    voice=TEST_VOICE_ID,
                    format="raw",
                    sample_rate=24000,
                    play_on_server=False,
                    correlation_id=correlation_id,
                ),
                timeout=SUBPROCESS_TIMEOUT_S,
                origin="integration-test",
                correlation_id=correlation_id,
            )
            assert start.ok, start.error
            for sequence, text in ((1, "second"), (0, "first"), (2, "third")):
                result = await bus.request(
                    TTSMethods.STREAM_CHUNK,
                    TTSStreamChunkRequest(
                        stream_id=stream_id,
                        sequence=sequence,
                        text=text,
                        correlation_id=correlation_id,
                    ),
                    timeout=SUBPROCESS_TIMEOUT_S,
                    origin="integration-test",
                    correlation_id=correlation_id,
                )
                assert result.ok, result.error
            deadline = asyncio.get_running_loop().time() + SUBPROCESS_TIMEOUT_S
            while len([chunk for chunk in chunks if not chunk.is_final]) < 3:
                assert asyncio.get_running_loop().time() < deadline
                await asyncio.sleep(0.05)
            stopped = await bus.request(
                TTSMethods.STOP,
                TTSStopRequest(
                    stream_id=stream_id,
                    correlation_id=correlation_id,
                    reason="stopped",
                ),
                timeout=SUBPROCESS_TIMEOUT_S,
                origin="integration-test",
                correlation_id=correlation_id,
            )
            assert stopped.ok, stopped.error
            deadline = asyncio.get_running_loop().time() + SUBPROCESS_TIMEOUT_S
            while not any(chunk.is_final for chunk in chunks):
                assert asyncio.get_running_loop().time() < deadline
                await asyncio.sleep(0.05)
            count_after_terminal = len(chunks)
            await asyncio.sleep(0.3)
        finally:
            await event_bus.stop()

    non_terminal = [chunk for chunk in chunks if not chunk.is_final]
    terminal = [chunk for chunk in chunks if chunk.is_final]
    assert [chunk.text for chunk in non_terminal[:3]] == ["first", "second", "third"]
    assert [chunk.source_sequence for chunk in non_terminal[:3]] == [0, 1, 2]
    assert len(terminal) == 1
    assert terminal[0].reason == "stopped"
    assert terminal[0].correlation_id == correlation_id
    assert len(chunks) == count_after_terminal


async def test_failed_config_reload_retains_old_working_pockettts_runtime(
    tmp_path: Path, redis_live: Any
) -> None:
    del redis_live
    registry_dir = tmp_path / "voice-pack"
    await _install_voice(registry_dir)
    fake_state = tmp_path / "fake"
    fail_file = tmp_path / "fail-load"
    config_path = tmp_path / "config.json"
    _write_config(config_path, _pockettts_config(registry_dir=registry_dir))

    async with _running_config_and_tts(
        config_path,
        fake_state,
        extra_env={"POCKETTTS_FAKE_FAIL_LOAD_FILE": str(fail_file)},
    ) as (bus, _procs, _output):
        before = await _synthesize(bus, "before reload")
        fail_file.write_text("fail\n", encoding="utf-8")
        telemetry_start = len(_read_events(fake_state))
        updated = await _set_config(
            bus,
            "services.tts.providers.pockettts.temperature",
            0.5,
        )
        assert updated["success"] is True
        await _wait_for_event_after(fake_state, "load_failed", telemetry_start)
        after = await _synthesize(bus, "after failed reload")

    _decode_wav_response(before, "before reload")
    _decode_wav_response(after, "after failed reload")


async def test_sigterm_restart_is_bounded_and_reuses_persistent_cache_marker(
    tmp_path: Path, redis_live: Any
) -> None:
    del redis_live
    registry_dir = tmp_path / "voice-pack"
    await _install_voice(registry_dir, language="fr", quality_tier="quality")
    fake_state = tmp_path / "fake"
    config_path = tmp_path / "config.json"
    _write_config(
        config_path,
        _pockettts_config(registry_dir=registry_dir, language="fr", quality_tier="quality"),
    )

    async with _running_config_and_tts(config_path, fake_state) as (bus, _procs, output_one):
        first = await _synthesize(bus, "first lifecycle")

    assert output_one
    restart_redis = redis_sync.Redis.from_url(TEST_REDIS_URL, decode_responses=True)
    restart_redis.flushdb()
    restart_redis.close()

    async with _running_config_and_tts(config_path, fake_state) as (bus, _procs, _output_two):
        second = await _synthesize(bus, "second lifecycle")

    _decode_wav_response(first, "first lifecycle")
    _decode_wav_response(second, "second lifecycle")
    events = _read_events(fake_state)
    assert any(event["event"] == "cache_created" for event in events)
    assert any(event["event"] == "cache_reused" for event in events)


@pytest.mark.parametrize(
    ("language", "quality_tier", "expected_config_id"),
    [
        ("en", "compact", "english_2026-04"),
        ("de", "compact", "german"),
        ("de", "quality", "german_24l"),
        ("pt", "quality", "portuguese_24l"),
        ("it", "compact", "italian"),
        ("es", "quality", "spanish_24l"),
        ("fr", "quality", "french_24l"),
    ],
)
async def test_reachable_language_quality_routes_to_exact_packaged_config_id(
    tmp_path: Path,
    redis_live: Any,
    language: str,
    quality_tier: str,
    expected_config_id: str,
) -> None:
    del redis_live
    registry_dir = tmp_path / "voice-pack"
    installed_config_id = await _install_voice(
        registry_dir, language=language, quality_tier=quality_tier
    )
    assert installed_config_id == expected_config_id
    fake_state = tmp_path / "fake"
    config_path = tmp_path / "config.json"
    _write_config(
        config_path,
        _pockettts_config(registry_dir=registry_dir, language=language, quality_tier=quality_tier),
    )

    async with _running_config_and_tts(config_path, fake_state) as (bus, _procs, _output):
        result = await _synthesize(bus, f"route {language} {quality_tier}")

    _decode_wav_response(result, f"route {language} {quality_tier}")
    load_events = [event for event in _read_events(fake_state) if event["event"] == "load_model"]
    assert load_events[-1]["language"] == expected_config_id
    assert expected_config_id in POCKETTTS_CONFIGS


async def test_fake_package_inventory_matches_pockettts_config_table() -> None:
    ids = sorted(POCKETTTS_CONFIGS)
    assert len(ids) == 12
    for config_id in ids:
        assert (FAKE_PACKAGE_ROOT / "pocket_tts" / "config" / f"{config_id}.yaml").is_file()

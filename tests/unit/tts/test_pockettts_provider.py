"""PocketTTS provider tests."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import inspect
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest

from app.services.tts.providers.base import (
    TTSProviderError,
    TTSSynthesisRequest,
    VoiceSelectionMode,
)
from app.services.tts.providers.pockettts import (
    POCKETTTS_CONFIGS,
    PocketTTSProvider,
    PocketTTSProviderConfig,
    PocketTTSVoiceStateConfig,
    resolve_pockettts_base_identity_spec,
    resolve_pockettts_config,
)
from app.services.tts.voice_registry import VoiceStateArtifactHandle

_CONFIG_BYTES = b"language: english\nmodel: pockettts-model.safetensors\nrevision: test\n"
_DEFAULT_VOICE_ID = "standard:starter_en:alba"
_BOUNDED_STOP_SUBPROCESS_TIMEOUT_S = 20
_BOUNDED_STOP_ALLOWED_SLACK_S = 1.0
_STOP_ELAPSED_STDOUT_PREFIX = "stop-elapsed-s="
_STOP_BOUND_STDOUT_PREFIX = "stop-bound-s="


class FakeTensor:
    shape = (1,)
    dtype = "float32"

    def isfinite(self) -> object:
        return type("Finite", (), {"all": lambda self: True})()


class NonFiniteTensor(FakeTensor):
    def isfinite(self) -> object:
        return type("Finite", (), {"all": lambda self: False})()


class FakePocketTTSModel:
    load_calls: list[dict[str, object]] = []
    generation_calls: list[dict[str, object]] = []
    imported_payloads: list[bytes] = []
    imported_suffixes: list[str] = []
    imported_parent_modes: list[int] = []
    imported_path_exists_after_read: list[Path] = []
    active_entries = 0
    max_active_entries = 0
    fail_load = False
    loaded_device = "cpu"
    loaded_sample_rate = 24000
    block_generation: threading.Event | None = None
    block_stream_after_first: threading.Event | None = None
    forever_stream_after_first = False
    stream_completed = False

    def __init__(self, language: str) -> None:
        self.language = language
        self.sample_rate = type(self).loaded_sample_rate
        self.device = type(self).loaded_device
        self.origin = type("Origin", (), {"name": f"{language}.safetensors"})()
        self.state_calls: list[Path] = []
        self.generated_texts: list[str] = []

    @classmethod
    def reset(cls) -> None:
        cls.load_calls = []
        cls.generation_calls = []
        cls.imported_payloads = []
        cls.imported_suffixes = []
        cls.imported_parent_modes = []
        cls.imported_path_exists_after_read = []
        cls.active_entries = 0
        cls.max_active_entries = 0
        cls.fail_load = False
        cls.loaded_device = "cpu"
        cls.loaded_sample_rate = 24000
        cls.block_generation = None
        cls.block_stream_after_first = None
        cls.forever_stream_after_first = False
        cls.stream_completed = False

    @classmethod
    def load_model(
        cls,
        *,
        language: str,
        quantize: bool,
        temp: float | None = None,
        lsd_decode_steps: int | None = None,
        noise_clamp: float | None = None,
        eos_threshold: float | None = None,
    ) -> FakePocketTTSModel:
        if cls.fail_load:
            raise RuntimeError("/secret/model/path failed")
        call = {"language": language, "quantize": quantize}
        if temp is not None:
            call["temp"] = temp
        if lsd_decode_steps is not None:
            call["lsd_decode_steps"] = lsd_decode_steps
        if noise_clamp is not None:
            call["noise_clamp"] = noise_clamp
        if eos_threshold is not None:
            call["eos_threshold"] = eos_threshold
        cls.load_calls.append(call)
        return cls(language)

    def get_state_for_audio_prompt(self, voice: Path) -> dict[str, object]:
        assert isinstance(voice, Path)
        assert voice.suffix == ".safetensors"
        payload = voice.read_bytes()
        assert payload
        type(self).imported_payloads.append(payload)
        type(self).imported_suffixes.append(voice.suffix)
        type(self).imported_parent_modes.append(voice.parent.stat().st_mode & 0o777)
        type(self).imported_path_exists_after_read.append(voice)
        self.state_calls.append(voice)
        return {"voice": {"offset": FakeTensor()}, "decoder_cache": {"state": FakeTensor()}}

    def generate_audio(
        self,
        state,
        text: str,
        **kwargs,
    ) -> list[float]:
        type(self).active_entries += 1
        type(self).max_active_entries = max(
            type(self).max_active_entries, type(self).active_entries
        )
        try:
            event = type(self).block_generation
            if event is not None:
                while not event.is_set():
                    time.sleep(0.005)
            assert kwargs["max_tokens"] == 4
            assert kwargs["frames_after_eos"] == 1
            assert kwargs["copy_state"] is True
            type(self).generation_calls.append({"state": state, "text": text, **kwargs})
            self.generated_texts.append(text)
            return [0.0, 0.5, -0.5]
        finally:
            type(self).active_entries -= 1

    def generate_audio_stream(
        self,
        state,
        text: str,
        **kwargs,
    ):
        assert state["voice"]
        assert text
        assert kwargs["max_tokens"] == 4
        assert kwargs["frames_after_eos"] == 1
        assert kwargs["copy_state"] is True
        type(self).generation_calls.append({"state": state, "text": text, **kwargs})
        yield [0.25]
        if type(self).forever_stream_after_first:
            while True:
                time.sleep(0.05)
        event = type(self).block_stream_after_first
        if event is not None:
            while not event.is_set():
                time.sleep(0.005)
        yield [-0.25]
        type(self).stream_completed = True


class MalformedStateModel(FakePocketTTSModel):
    state: object = {"cache": 1}

    def get_state_for_audio_prompt(self, voice: Path) -> object:
        type(self).imported_payloads.append(voice.read_bytes())
        type(self).imported_suffixes.append(voice.suffix)
        type(self).imported_parent_modes.append(voice.parent.stat().st_mode & 0o777)
        type(self).imported_path_exists_after_read.append(voice)
        self.state_calls.append(voice)
        return type(self).state


@pytest.fixture(autouse=True)
def reset_fake_model():
    FakePocketTTSModel.reset()


def _voice_state(
    voice_id: str = _DEFAULT_VOICE_ID,
    display_name: str = "Alba",
    *,
    effective_language: str = "en",
    quality_tier: str = "compact",
    config_id: str | None = None,
    payload: bytes = b"fake safetensors state",
) -> PocketTTSVoiceStateConfig:
    with tempfile.TemporaryFile() as file:
        file.write(payload)
        file.flush()
        file.seek(0)
        fd = os.dup(file.fileno())
    identity = resolve_pockettts_base_identity_spec(
        PocketTTSProviderConfig(
            effective_language=effective_language,
            quality_tier=quality_tier,  # type: ignore[arg-type]
            config_id=config_id,
            voices=(),
            package_version="2.1.0",
            config_yaml_bytes=_CONFIG_BYTES,
            config_asset_refs=("pockettts-model.safetensors",),
        )
    ).voice_base_identity
    digest = hashlib.sha256(payload).hexdigest()
    return PocketTTSVoiceStateConfig(
        voice_id=voice_id,
        display_name=display_name,
        artifact_handle=VoiceStateArtifactHandle(
            voice_id=voice_id,
            runtime_target=identity.runtime_target,
            language_bundle=identity.language_bundle,
            compatibility_group=identity.compatibility_group,
            artifact_revision="rev1",
            relative_ref="artifacts/profile/voice-state.safetensors",
            sha256=digest,
            size_bytes=len(payload),
            format="safetensors",
            fd=fd,
        ),
    )


def _pockettts_config(**kwargs: object) -> PocketTTSProviderConfig:
    effective_language = str(kwargs.get("effective_language", "en"))
    quality_tier = str(kwargs.get("quality_tier", "compact"))
    kwargs.setdefault(
        "voices",
        (_voice_state(effective_language=effective_language, quality_tier=quality_tier),),
    )
    kwargs.setdefault("package_version", "2.1.0")
    kwargs.setdefault("effective_language", effective_language)
    kwargs.setdefault("config_yaml_bytes", _CONFIG_BYTES)
    kwargs.setdefault("config_asset_refs", ("pockettts-model.safetensors",))
    return PocketTTSProviderConfig(**kwargs)  # type: ignore[arg-type]


def _fd_is_closed(fd: int) -> bool:
    try:
        os.fstat(fd)
    except OSError:
        return True
    return False


def _run_bounded_stop_subprocess(code: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            [sys.executable, "-c", code],
            cwd=Path(__file__).resolve().parents[3],
            text=True,
            capture_output=True,
            timeout=_BOUNDED_STOP_SUBPROCESS_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        pytest.fail(
            "PocketTTS bounded-stop subprocess exceeded "
            f"{_BOUNDED_STOP_SUBPROCESS_TIMEOUT_S}s\n"
            f"stdout:\n{stdout}\n"
            f"stderr:\n{stderr}"
        )


def _assert_bounded_stop_elapsed(stdout: str) -> None:
    values: dict[str, float] = {}
    for line in stdout.splitlines():
        for prefix in (_STOP_ELAPSED_STDOUT_PREFIX, _STOP_BOUND_STDOUT_PREFIX):
            if line.startswith(prefix):
                values[prefix] = float(line.removeprefix(prefix))

    elapsed_s = values.get(_STOP_ELAPSED_STDOUT_PREFIX)
    bound_s = values.get(_STOP_BOUND_STDOUT_PREFIX)
    assert elapsed_s is not None, stdout
    assert bound_s is not None, stdout
    assert elapsed_s <= bound_s + _BOUNDED_STOP_ALLOWED_SLACK_S, stdout


def _pockettts_worker_threads() -> list[threading.Thread]:
    return [
        thread for thread in threading.enumerate() if thread.name.startswith("aurora-pockettts")
    ]


def test_pockettts_official_api_signature_conformance_without_model_download() -> None:
    pocket_tts = pytest.importorskip("pocket_tts")
    load_signature = inspect.signature(pocket_tts.TTSModel.load_model)
    finite_signature = inspect.signature(pocket_tts.TTSModel.generate_audio)
    stream_signature = inspect.signature(pocket_tts.TTSModel.generate_audio_stream)

    assert "device" not in load_signature.parameters
    for name in ("temp", "lsd_decode_steps", "noise_clamp", "eos_threshold"):
        assert name in load_signature.parameters
        assert name not in finite_signature.parameters
        assert name not in stream_signature.parameters
    for signature in (finite_signature, stream_signature):
        assert {"max_tokens", "frames_after_eos", "copy_state"}.issubset(signature.parameters)


def test_pockettts_inventory_contains_exact_pinned_configs() -> None:
    assert set(POCKETTTS_CONFIGS) == {
        "english",
        "english_2026-01",
        "english_2026-04",
        "french_24l",
        "german",
        "german_24l",
        "italian",
        "italian_24l",
        "portuguese",
        "portuguese_24l",
        "spanish",
        "spanish_24l",
    }


@pytest.mark.parametrize(
    ("language", "tier", "expected"),
    [
        ("en", "compact", "english_2026-04"),
        ("english", "quality", "english_2026-04"),
        ("de", "compact", "german"),
        ("de", "quality", "german_24l"),
        ("pt-BR", "compact", "portuguese"),
        ("pt", "quality", "portuguese_24l"),
        ("it", "compact", "italian"),
        ("it", "quality", "italian_24l"),
        ("es", "compact", "spanish"),
        ("es", "quality", "spanish_24l"),
        ("fr", "quality", "french_24l"),
    ],
)
def test_pockettts_resolves_language_and_quality_to_config(
    language: str, tier: str, expected: str
) -> None:
    assert resolve_pockettts_config(language, tier).config_id == expected


def test_pockettts_rejects_plain_french_and_missing_compact_french() -> None:
    with pytest.raises(TTSProviderError) as plain_french:
        resolve_pockettts_config("fr", "quality", config_id="french")
    with pytest.raises(TTSProviderError) as compact_french:
        resolve_pockettts_config("fr", "compact")

    assert plain_french.value.code == "unsupported_voice"
    assert compact_french.value.code == "unsupported_voice"


def test_pockettts_allows_english_legacy_configs_only_as_explicit_compatibility() -> None:
    assert resolve_pockettts_config("en", "compact", config_id="english").config_id == "english"
    assert (
        resolve_pockettts_config("en", "compact", config_id="english_2026-01").config_id
        == "english_2026-01"
    )
    assert resolve_pockettts_config("en", "compact").config_id == "english_2026-04"


def test_pockettts_rejects_explicit_tier_mismatch_and_custom_config() -> None:
    with pytest.raises(TTSProviderError) as tier_mismatch:
        resolve_pockettts_config("de", "quality", config_id="german")
    with pytest.raises(TTSProviderError) as custom_config:
        resolve_pockettts_config("de", "compact", config_id="custom_german")

    assert tier_mismatch.value.code == "unsupported_voice"
    assert custom_config.value.code == "unsupported_voice"


def test_pockettts_identity_changes_with_config_bytes_and_refs_and_has_no_paths() -> None:
    base = resolve_pockettts_base_identity_spec(
        _pockettts_config(config_yaml_bytes=b"model: a.safetensors\nrevision: one\n")
    )
    changed_bytes = resolve_pockettts_base_identity_spec(
        _pockettts_config(config_yaml_bytes=b"model: a.safetensors\nrevision: two\n")
    )
    changed_refs = resolve_pockettts_base_identity_spec(
        _pockettts_config(
            config_yaml_bytes=b"model: a.safetensors\nrevision: one\n",
            config_asset_refs=("b.safetensors",),
        )
    )

    assert base.health_identity != changed_bytes.health_identity
    assert base.health_identity != changed_refs.health_identity
    assert "/" not in base.health_identity
    assert "\\" not in base.health_identity


def test_pockettts_identity_preserves_hf_uri_authority_and_rejects_unsafe_refs() -> None:
    first = resolve_pockettts_base_identity_spec(
        _pockettts_config(config_yaml_bytes=b"model: hf://org/repo/model.safetensors\n")
    )
    second = resolve_pockettts_base_identity_spec(
        _pockettts_config(config_yaml_bytes=b"model: hf://other/repo/model.safetensors\n")
    )

    assert first.health_identity != second.health_identity
    for ref in (
        b"model: hf:/org/repo/model.safetensors\n",
        b"model: /tmp/model.safetensors\n",
        b"model: ../model.safetensors\n",
        b"model: C:/model.safetensors\n",
    ):
        with pytest.raises(TTSProviderError) as exc_info:
            resolve_pockettts_base_identity_spec(_pockettts_config(config_yaml_bytes=ref))
        assert exc_info.value.code == "unavailable"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"config_yaml_bytes": b""},
        {"config_yaml_bytes": b": not: yaml:"},
        {"config_yaml_bytes": b"language: english\n"},
    ],
)
def test_pockettts_identity_rejects_unusable_config_yaml(kwargs: dict[str, object]) -> None:
    with pytest.raises(TTSProviderError) as exc_info:
        resolve_pockettts_base_identity_spec(_pockettts_config(**kwargs))

    assert exc_info.value.code == "unavailable"


def test_pockettts_direct_identity_builder_rejects_unusable_config_yaml() -> None:
    from app.services.tts.providers.pockettts import build_pockettts_base_identity_spec

    with pytest.raises(TTSProviderError) as exc_info:
        build_pockettts_base_identity_spec(
            config_info=resolve_pockettts_config("en", "compact"),
            model_revision="pocket-tts-2.1.0",
            package_version="2.1.0",
            config_yaml_bytes=b"language: english\n",
            config_asset_refs=(),
        )

    assert exc_info.value.code == "unavailable"


@pytest.mark.asyncio
async def test_pockettts_rejects_empty_and_duplicate_voice_configs_without_model_load() -> None:
    empty = PocketTTSProvider(
        _pockettts_config(voices=()),
        model_class=FakePocketTTSModel,
    )
    with pytest.raises(TTSProviderError) as empty_error:
        await empty.start()

    first = _voice_state()
    second = _voice_state()
    duplicate = PocketTTSProvider(
        _pockettts_config(voices=(first, second)),
        model_class=FakePocketTTSModel,
    )
    with pytest.raises(TTSProviderError) as duplicate_error:
        await duplicate.start()

    assert empty_error.value.code == "unsupported_voice"
    assert duplicate_error.value.code == "unsupported_voice"
    assert _fd_is_closed(first.artifact_handle.fd)
    assert _fd_is_closed(second.artifact_handle.fd)
    assert FakePocketTTSModel.load_calls == []


@pytest.mark.asyncio
async def test_pockettts_rejects_oversized_voice_state_before_buffering() -> None:
    voice = _voice_state()
    fd = voice.artifact_handle.fd
    oversized = PocketTTSVoiceStateConfig(
        voice_id=voice.voice_id,
        display_name=voice.display_name,
        artifact_handle=VoiceStateArtifactHandle(
            voice_id=voice.artifact_handle.voice_id,
            runtime_target=voice.artifact_handle.runtime_target,
            language_bundle=voice.artifact_handle.language_bundle,
            compatibility_group=voice.artifact_handle.compatibility_group,
            artifact_revision=voice.artifact_handle.artifact_revision,
            relative_ref=voice.artifact_handle.relative_ref,
            sha256=voice.artifact_handle.sha256,
            size_bytes=65 * 1024 * 1024,
            format=voice.artifact_handle.format,
            fd=fd,
        ),
    )
    provider = PocketTTSProvider(
        _pockettts_config(voices=(oversized,)),
        model_class=FakePocketTTSModel,
    )

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.start()

    assert exc_info.value.code == "unsupported_voice"
    assert _fd_is_closed(fd)


@pytest.mark.asyncio
async def test_pockettts_start_loads_model_and_multiple_voice_states() -> None:
    provider = PocketTTSProvider(
        _pockettts_config(
            effective_language="de",
            quality_tier="quality",
            max_tokens=4,
            voices=(
                _voice_state(
                    "standard:starter_de:anna",
                    "Anna",
                    effective_language="de",
                    quality_tier="quality",
                ),
                _voice_state(
                    "clone:00000000-0000-4000-8000-000000000001",
                    "Local",
                    effective_language="de",
                    quality_tier="quality",
                ),
            ),
        ),
        model_class=FakePocketTTSModel,
    )

    await provider.start()

    assert FakePocketTTSModel.load_calls == [{"language": "german_24l", "quantize": False}]
    assert provider.capabilities.voice_selection_mode is VoiceSelectionMode.SHARED_MODEL_STATE
    assert provider.capabilities.max_resident_base_models == 1
    assert provider.capabilities.supports_inflight_cancel is False
    health = await provider.health()
    assert health.ready is True
    assert health.active_voice == "standard:starter_de:anna"
    assert health.base_identity is not None
    assert health.base_identity.startswith("pockettts:german:german_24l:layers-24:sha256:")
    assert "clone.wav" not in health.base_identity
    voices = await provider.list_voices()
    assert [
        (voice.voice_id, voice.display_name, voice.ready, voice.language) for voice in voices
    ] == [
        ("standard:starter_de:anna", "Anna", True, "german"),
        ("clone:00000000-0000-4000-8000-000000000001", "Local", True, "german"),
    ]
    await provider.stop()
    assert _pockettts_worker_threads() == []


@pytest.mark.asyncio
async def test_pockettts_imports_verified_safetensors_path_and_closes_fd() -> None:
    payload = b"verified voice state bytes"
    voice = _voice_state(payload=payload)
    fd = voice.artifact_handle.fd
    provider = PocketTTSProvider(
        _pockettts_config(voices=(voice,), max_tokens=4),
        model_class=FakePocketTTSModel,
    )

    await provider.start()

    imported_path = FakePocketTTSModel.imported_path_exists_after_read[-1]
    assert FakePocketTTSModel.imported_payloads == [payload]
    assert FakePocketTTSModel.imported_suffixes == [".safetensors"]
    assert FakePocketTTSModel.imported_parent_modes == [0o700]
    assert imported_path.exists() is False
    assert imported_path.parent.exists() is False
    assert _fd_is_closed(fd)
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_rejects_cross_identity_voice_state_and_closes_fd() -> None:
    voice = _voice_state(effective_language="en")
    fd = voice.artifact_handle.fd
    provider = PocketTTSProvider(
        _pockettts_config(effective_language="de", quality_tier="quality", voices=(voice,)),
        model_class=FakePocketTTSModel,
    )

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.start()

    assert exc_info.value.code == "unsupported_voice"
    assert _fd_is_closed(fd)
    assert FakePocketTTSModel.imported_payloads == []


@pytest.mark.parametrize(
    "state",
    [
        {},
        {"cache": 1},
        {"voice": {"offset": NonFiniteTensor()}},
        {"voice": {"cache": FakeTensor()}},
    ],
)
@pytest.mark.asyncio
async def test_pockettts_rejects_malformed_imported_state_before_readiness(state: object) -> None:
    MalformedStateModel.state = state
    voice = _voice_state()
    fd = voice.artifact_handle.fd
    provider = PocketTTSProvider(
        _pockettts_config(voices=(voice,)),
        model_class=MalformedStateModel,
    )

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.start()

    assert exc_info.value.code == "unsupported_voice"
    assert _fd_is_closed(fd)
    health = await provider.health()
    assert health.ready is False


@pytest.mark.asyncio
async def test_pockettts_rejects_loaded_model_config_mismatch_before_voice_import() -> None:
    class WrongOriginModel(FakePocketTTSModel):
        def __init__(self, language: str) -> None:
            super().__init__(language)
            self.origin = type("Origin", (), {"name": "spanish.safetensors"})()

    voice = _voice_state(effective_language="de", quality_tier="quality")
    fd = voice.artifact_handle.fd
    provider = PocketTTSProvider(
        _pockettts_config(effective_language="de", quality_tier="quality", voices=(voice,)),
        model_class=WrongOriginModel,
    )

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.start()

    assert exc_info.value.code == "unavailable"
    assert FakePocketTTSModel.imported_payloads == []
    assert _fd_is_closed(fd)


@pytest.mark.parametrize(
    ("missing", "expected_code"),
    [
        ("device", "unavailable"),
        ("origin", "unavailable"),
        ("sample_rate", "invalid_audio"),
        ("float_sample_rate", "invalid_audio"),
    ],
)
@pytest.mark.asyncio
async def test_pockettts_rejects_missing_required_model_metadata(
    missing: str, expected_code: str
) -> None:
    class MissingMetadataModel(FakePocketTTSModel):
        def __init__(self, language: str) -> None:
            super().__init__(language)
            if missing == "device":
                del self.device
            elif missing == "origin":
                del self.origin
            elif missing == "sample_rate":
                del self.sample_rate
            elif missing == "float_sample_rate":
                self.sample_rate = 24000.0

    voice = _voice_state()
    fd = voice.artifact_handle.fd
    provider = PocketTTSProvider(
        _pockettts_config(voices=(voice,)),
        model_class=MissingMetadataModel,
    )

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.start()

    assert exc_info.value.code == expected_code
    assert FakePocketTTSModel.imported_payloads == []
    assert _fd_is_closed(fd)


@pytest.mark.asyncio
async def test_pockettts_start_cancellation_closes_fds_and_clears_executor() -> None:
    class BlockingLoadModel(FakePocketTTSModel):
        started = threading.Event()
        release = threading.Event()

        @classmethod
        def load_model(cls, *, language: str, quantize: bool, **kwargs) -> FakePocketTTSModel:
            del kwargs
            cls.load_calls.append({"language": language, "quantize": quantize})
            cls.started.set()
            cls.release.wait()
            return cls(language)

    voice = _voice_state()
    fd = voice.artifact_handle.fd
    provider = PocketTTSProvider(
        _pockettts_config(voices=(voice,), init_timeout_s=5),
        model_class=BlockingLoadModel,
    )
    task = asyncio.create_task(provider.start())
    await asyncio.to_thread(BlockingLoadModel.started.wait)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=1)
    BlockingLoadModel.release.set()
    await asyncio.sleep(0.05)

    assert _fd_is_closed(fd)
    assert provider._executor is None


@pytest.mark.asyncio
async def test_pockettts_reload_cancellation_closes_new_fds_and_keeps_old_state() -> None:
    class SecondLoadBlockingModel(FakePocketTTSModel):
        load_count = 0
        started = threading.Event()
        release = threading.Event()

        @classmethod
        def load_model(cls, *, language: str, quantize: bool, **kwargs) -> FakePocketTTSModel:
            del kwargs
            cls.load_count += 1
            cls.load_calls.append({"language": language, "quantize": quantize})
            if cls.load_count == 2:
                cls.started.set()
                cls.release.wait()
            return cls(language)

    provider = PocketTTSProvider(
        _pockettts_config(effective_language="en", max_tokens=4),
        model_class=SecondLoadBlockingModel,
    )
    await provider.start()
    original_health = await provider.health()
    new_voice = _voice_state(
        "standard:starter_de:anna",
        "Anna",
        effective_language="de",
        quality_tier="quality",
    )
    new_fd = new_voice.artifact_handle.fd
    reload_task = asyncio.create_task(
        provider.reload(
            _pockettts_config(
                effective_language="de",
                quality_tier="quality",
                max_tokens=4,
                voices=(new_voice,),
            )
        )
    )
    await asyncio.to_thread(SecondLoadBlockingModel.started.wait)

    reload_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(reload_task, timeout=1)
    SecondLoadBlockingModel.release.set()
    await asyncio.sleep(0.05)

    assert _fd_is_closed(new_fd)
    health = await provider.health()
    assert health.ready is True
    assert health.base_identity == original_health.base_identity
    assert (await provider.synthesize(TTSSynthesisRequest(text="still works"))).voice == (
        "standard:starter_en:alba"
    )
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_preload_false_lazy_loads_once_for_concurrent_requests() -> None:
    provider = PocketTTSProvider(
        _pockettts_config(effective_language="en", max_tokens=4, preload=False),
        model_class=FakePocketTTSModel,
    )
    await provider.start()

    assert FakePocketTTSModel.load_calls == []
    first, second = await asyncio.gather(
        provider.synthesize(TTSSynthesisRequest(text="one")),
        provider.synthesize(TTSSynthesisRequest(text="two")),
    )

    assert first.audio
    assert second.audio
    assert FakePocketTTSModel.load_calls == [{"language": "english_2026-04", "quantize": False}]
    assert FakePocketTTSModel.max_active_entries == 1
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_restart_after_stop_recreates_executor() -> None:
    provider = PocketTTSProvider(
        _pockettts_config(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    await provider.synthesize(TTSSynthesisRequest(text="before"))
    await provider.stop()

    provider = PocketTTSProvider(
        _pockettts_config(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    result = await provider.synthesize(TTSSynthesisRequest(text="after"))

    assert result.audio
    assert FakePocketTTSModel.load_calls == [
        {"language": "english_2026-04", "quantize": False},
        {"language": "english_2026-04", "quantize": False},
    ]
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_synthesizes_provider_neutral_pcm_and_wav() -> None:
    provider = PocketTTSProvider(
        _pockettts_config(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()

    raw = await provider.synthesize(
        TTSSynthesisRequest(text="hello", voice="standard:starter_en:alba", audio_format="raw")
    )
    wav = await provider.synthesize(
        TTSSynthesisRequest(text="hello", voice="standard:starter_en:alba", audio_format="wav")
    )

    assert raw.audio == b"\x00\x00\x00@\x00\xc0"
    assert raw.audio_format == "raw"
    assert raw.sample_rate == 24000
    assert raw.channels == 1
    assert raw.duration_ms == pytest.approx(3 / 24000 * 1000)
    assert raw.voice == "standard:starter_en:alba"
    assert wav.audio.startswith(b"RIFF")
    assert wav.audio_format == "wav"
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_stream_normalizes_ordered_chunks() -> None:
    provider = PocketTTSProvider(
        _pockettts_config(effective_language="es", quality_tier="quality", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()

    chunks = [
        chunk
        async for chunk in provider.stream(
            TTSSynthesisRequest(
                text="hola", voice="standard:starter_en:alba", request_id="stream-1"
            )
        )
    ]

    assert [(chunk.sequence, chunk.audio, chunk.is_final) for chunk in chunks] == [
        (0, b"\x00 ", False),
        (1, b"\x00\xe0", False),
        (2, b"", True),
    ]
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_stream_yields_first_chunk_before_generator_completion() -> None:
    release = threading.Event()
    FakePocketTTSModel.block_stream_after_first = release
    provider = PocketTTSProvider(
        _pockettts_config(effective_language="es", quality_tier="quality", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    stream = provider.stream(TTSSynthesisRequest(text="hola", request_id="stream-1"))

    first = await asyncio.wait_for(stream.__anext__(), timeout=1)

    assert first.sequence == 0
    assert first.audio == b"\x00 "
    assert FakePocketTTSModel.stream_completed is False
    release.set()
    rest = [chunk async for chunk in stream]
    assert [(chunk.sequence, chunk.is_final) for chunk in rest] == [(1, False), (2, True)]
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_stream_cancellation_stops_delivery_without_state_leak() -> None:
    release = threading.Event()
    FakePocketTTSModel.block_stream_after_first = release
    provider = PocketTTSProvider(
        _pockettts_config(effective_language="es", quality_tier="quality", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    stream = provider.stream(TTSSynthesisRequest(text="hola", request_id="stream-1"))
    first = await stream.__anext__()

    await provider.cancel("stream-1")
    release.set()
    with pytest.raises(TTSProviderError) as exc_info:
        await stream.__anext__()

    assert first.audio
    assert exc_info.value.code == "cancelled"
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_stream_stop_reports_blocked_executor_producer_then_restarts() -> None:
    release = threading.Event()
    FakePocketTTSModel.block_stream_after_first = release
    provider = PocketTTSProvider(
        _pockettts_config(
            effective_language="es",
            quality_tier="quality",
            max_tokens=4,
            queue_timeout_s=0.05,
            request_timeout_s=0.1,
        ),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    stream = provider.stream(TTSSynthesisRequest(text="hola", request_id="stream-forever"))
    first = await asyncio.wait_for(stream.__anext__(), timeout=1)

    with pytest.raises(TTSProviderError) as busy:
        await provider.synthesize(TTSSynthesisRequest(text="blocked"))
    with pytest.raises(TTSProviderError) as stop_error:
        await asyncio.wait_for(provider.stop(), timeout=1)
    health = await provider.health()
    release.set()
    while provider._stream_futures:
        await asyncio.sleep(0.01)
    await stream.aclose()
    restarted = PocketTTSProvider(
        _pockettts_config(effective_language="es", quality_tier="quality", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await restarted.start()
    restarted_health = await restarted.health()
    await restarted.stop()

    assert first.audio == b"\x00 "
    assert busy.value.code == "resource_exhausted"
    assert stop_error.value.code == "resource_exhausted"
    assert health.ready is False
    assert restarted_health.ready is True
    assert not any(thread.name == "aurora-pockettts-stream" for thread in threading.enumerate())


@pytest.mark.asyncio
async def test_pockettts_cancelled_stop_mid_stream_drain_keeps_survivor_for_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = threading.Event()
    FakePocketTTSModel.block_stream_after_first = release
    voice = _voice_state(effective_language="es", quality_tier="quality")
    fd = voice.artifact_handle.fd
    provider = PocketTTSProvider(
        _pockettts_config(
            effective_language="es",
            quality_tier="quality",
            voices=(voice,),
            max_tokens=4,
            request_timeout_s=0.1,
            queue_timeout_s=0.05,
        ),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    stream = provider.stream(TTSSynthesisRequest(text="hola", request_id="stream-cancel"))
    first = await asyncio.wait_for(stream.__anext__(), timeout=1)
    original_drain = provider._drain_stream_futures
    drain_started = asyncio.Event()

    async def blocked_drain(timeout_s: float) -> bool:
        del timeout_s
        drain_started.set()
        await asyncio.sleep(10)
        return False

    monkeypatch.setattr(provider, "_drain_stream_futures", blocked_drain)
    stop_task = asyncio.create_task(provider.stop())
    await asyncio.wait_for(drain_started.wait(), timeout=1)
    stop_task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await stop_task
    health = await provider.health()

    assert first.audio == b"\x00 "
    assert health.ready is False
    assert health.error == "PocketTTS model work did not stop"
    assert provider._executor is not None
    assert _fd_is_closed(fd)

    monkeypatch.setattr(provider, "_drain_stream_futures", original_drain)
    release.set()
    while provider._stream_futures:
        await asyncio.sleep(0.01)
    await stream.aclose()
    await provider.stop()

    assert _pockettts_worker_threads() == []


@pytest.mark.asyncio
async def test_pockettts_cancelled_stop_mid_executor_shutdown_keeps_executor_for_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = threading.Event()
    FakePocketTTSModel.block_generation = release
    voice = _voice_state()
    fd = voice.artifact_handle.fd
    provider = PocketTTSProvider(
        _pockettts_config(
            voices=(voice,),
            max_tokens=4,
            request_timeout_s=5,
            queue_timeout_s=0.05,
        ),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    synthesis = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="blocked", request_id="synth-cancel"))
    )
    deadline = asyncio.get_running_loop().time() + 1
    while FakePocketTTSModel.active_entries == 0:
        if asyncio.get_running_loop().time() > deadline:
            pytest.fail("synthesis did not enter")
        await asyncio.sleep(0.01)
    executor = provider._ensure_executor()
    original_shutdown = executor.shutdown_bounded
    shutdown_started = threading.Event()

    def slow_shutdown(timeout_s: float, *, cancel_futures: bool = False) -> bool:
        shutdown_started.set()
        time.sleep(0.2)
        return original_shutdown(timeout_s, cancel_futures=cancel_futures)

    monkeypatch.setattr(executor, "shutdown_bounded", slow_shutdown)
    stop_task = asyncio.create_task(provider.stop())
    assert await asyncio.to_thread(shutdown_started.wait, 1)
    stop_task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await stop_task
    health = await provider.health()

    assert health.ready is False
    assert health.error == "PocketTTS model work did not stop"
    assert provider._executor is executor
    assert _fd_is_closed(fd)

    monkeypatch.setattr(executor, "shutdown_bounded", original_shutdown)
    release.set()
    with contextlib.suppress(TTSProviderError, asyncio.CancelledError):
        await asyncio.wait_for(synthesis, timeout=1)
    await provider.stop()

    assert _pockettts_worker_threads() == []


def test_pockettts_forever_stream_subprocess_exits_after_bounded_stop_failure() -> None:
    code = r"""
import asyncio
import hashlib
import os
import tempfile
import threading
import time
from pathlib import Path

from app.services.tts.providers.base import TTSSynthesisRequest, TTSProviderError
from app.services.tts.providers.pockettts import (
    PocketTTSProvider,
    PocketTTSProviderConfig,
    PocketTTSVoiceStateConfig,
    resolve_pockettts_base_identity_spec,
)
from app.services.tts.voice_registry import VoiceStateArtifactHandle


class Tensor:
    shape = (1,)
    dtype = "float32"
    def isfinite(self):
        return type("Finite", (), {"all": lambda self: True})()


class Model:
    @classmethod
    def load_model(cls, *, language, quantize, **kwargs):
        del quantize, kwargs
        return cls(language)
    def __init__(self, language):
        self.sample_rate = 24000
        self.device = "cpu"
        self.origin = type("Origin", (), {"name": f"{language}.safetensors"})()
    def get_state_for_audio_prompt(self, voice: Path):
        assert voice.read_bytes()
        return {"voice": {"offset": Tensor()}, "decoder_cache": {"state": Tensor()}}
    def generate_audio_stream(self, state, text, **kwargs):
        yield [0.25]
        while True:
            time.sleep(0.05)


def voice_state(config):
    payload = b"state"
    f = tempfile.TemporaryFile()
    f.write(payload)
    f.flush()
    f.seek(0)
    fd = os.dup(f.fileno())
    f.close()
    identity = resolve_pockettts_base_identity_spec(config).voice_base_identity
    return PocketTTSVoiceStateConfig(
        voice_id="standard:starter_en:alba",
        artifact_handle=VoiceStateArtifactHandle(
            voice_id="standard:starter_en:alba",
            runtime_target=identity.runtime_target,
            language_bundle=identity.language_bundle,
            compatibility_group=identity.compatibility_group,
            artifact_revision="rev1",
            relative_ref="artifacts/profile/voice-state.safetensors",
            sha256=hashlib.sha256(payload).hexdigest(),
            size_bytes=len(payload),
            format="safetensors",
            fd=fd,
        ),
    )


async def main():
    base = PocketTTSProviderConfig(
        effective_language="en",
        request_timeout_s=0.1,
        queue_timeout_s=0.05,
        max_tokens=4,
        package_version="2.1.0",
        config_yaml_bytes=b"model: pockettts-model.safetensors\nrevision: test\n",
        config_asset_refs=("pockettts-model.safetensors",),
    )
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(**{**base.__dict__, "voices": (voice_state(base),)}),
        model_class=Model,
    )
    await provider.start()
    stream = provider.stream(TTSSynthesisRequest(text="hola", request_id="forever"))
    first = await stream.__anext__()
    assert first.audio
    stop_started_s = time.monotonic()
    try:
        await provider.stop()
    except TTSProviderError as exc:
        stop_elapsed_s = time.monotonic() - stop_started_s
        assert exc.code == "resource_exhausted"
    else:
        raise AssertionError("stop should fail for non-cooperative stream")
    health = await provider.health()
    assert health.ready is False
    print(f"stop-bound-s={base.request_timeout_s:.6f}")
    print(f"stop-elapsed-s={stop_elapsed_s:.6f}")
    print("clean-exit")

asyncio.run(main())
"""
    result = _run_bounded_stop_subprocess(code)

    assert result.returncode == 0, result.stderr
    assert "clean-exit" in result.stdout
    _assert_bounded_stop_elapsed(result.stdout)


def test_pockettts_forever_synthesis_subprocess_exits_after_bounded_stop_failure() -> None:
    code = r"""
import asyncio
import hashlib
import os
import tempfile
import time
from pathlib import Path

from app.services.tts.providers.base import TTSSynthesisRequest, TTSProviderError
from app.services.tts.providers.pockettts import (
    PocketTTSProvider,
    PocketTTSProviderConfig,
    PocketTTSVoiceStateConfig,
    resolve_pockettts_base_identity_spec,
)
from app.services.tts.voice_registry import VoiceStateArtifactHandle


class Tensor:
    shape = (1,)
    dtype = "float32"
    def isfinite(self):
        return type("Finite", (), {"all": lambda self: True})()


class Model:
    active_entries = 0

    @classmethod
    def load_model(cls, *, language, quantize, **kwargs):
        del quantize, kwargs
        return cls(language)
    def __init__(self, language):
        self.sample_rate = 24000
        self.device = "cpu"
        self.origin = type("Origin", (), {"name": f"{language}.safetensors"})()
    def get_state_for_audio_prompt(self, voice: Path):
        assert voice.read_bytes()
        return {"voice": {"offset": Tensor()}, "decoder_cache": {"state": Tensor()}}
    def generate_audio(self, state, text, **kwargs):
        type(self).active_entries += 1
        while True:
            time.sleep(0.05)


def voice_state(config):
    payload = b"state"
    f = tempfile.TemporaryFile()
    f.write(payload)
    f.flush()
    f.seek(0)
    fd = os.dup(f.fileno())
    f.close()
    identity = resolve_pockettts_base_identity_spec(config).voice_base_identity
    return PocketTTSVoiceStateConfig(
        voice_id="standard:starter_en:alba",
        artifact_handle=VoiceStateArtifactHandle(
            voice_id="standard:starter_en:alba",
            runtime_target=identity.runtime_target,
            language_bundle=identity.language_bundle,
            compatibility_group=identity.compatibility_group,
            artifact_revision="rev1",
            relative_ref="artifacts/profile/voice-state.safetensors",
            sha256=hashlib.sha256(payload).hexdigest(),
            size_bytes=len(payload),
            format="safetensors",
            fd=fd,
        ),
    )


async def main():
    base = PocketTTSProviderConfig(
        effective_language="en",
        request_timeout_s=0.1,
        queue_timeout_s=0.05,
        max_tokens=4,
        package_version="2.1.0",
        config_yaml_bytes=b"model: pockettts-model.safetensors\nrevision: test\n",
        config_asset_refs=("pockettts-model.safetensors",),
    )
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(**{**base.__dict__, "voices": (voice_state(base),)}),
        model_class=Model,
    )
    await provider.start()
    task = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="hola", request_id="forever"))
    )
    deadline = asyncio.get_running_loop().time() + 1
    while Model.active_entries == 0:
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("synthesis did not enter")
        await asyncio.sleep(0.01)
    stop_started_s = time.monotonic()
    try:
        await provider.stop()
    except TTSProviderError as exc:
        stop_elapsed_s = time.monotonic() - stop_started_s
        assert exc.code == "resource_exhausted"
    else:
        raise AssertionError("stop should fail for non-cooperative synthesis")
    health = await provider.health()
    assert health.ready is False
    assert health.error == "PocketTTS model work did not stop"
    task.cancel()
    try:
        await asyncio.wait_for(task, timeout=0.1)
    except (asyncio.CancelledError, TimeoutError, TTSProviderError):
        pass
    print(f"stop-bound-s={base.request_timeout_s:.6f}")
    print(f"stop-elapsed-s={stop_elapsed_s:.6f}")
    print("clean-exit")

asyncio.run(main())
"""
    result = _run_bounded_stop_subprocess(code)

    assert result.returncode == 0, result.stderr
    assert "clean-exit" in result.stdout
    _assert_bounded_stop_elapsed(result.stdout)


@pytest.mark.asyncio
async def test_pockettts_stream_completion_hands_gate_to_queued_synthesis_until_done() -> None:
    release_stream = threading.Event()
    release_synthesis = threading.Event()
    FakePocketTTSModel.block_stream_after_first = release_stream
    FakePocketTTSModel.block_generation = release_synthesis
    provider = PocketTTSProvider(
        _pockettts_config(
            effective_language="es",
            quality_tier="quality",
            max_tokens=4,
            queue_timeout_s=0.05,
            request_timeout_s=5,
        ),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    stream = provider.stream(TTSSynthesisRequest(text="hola", request_id="stream-race"))
    first = await asyncio.wait_for(stream.__anext__(), timeout=1)
    queued_synthesis = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="queued", request_id="synth-race"))
    )

    release_stream.set()
    rest = [chunk async for chunk in stream]
    deadline = asyncio.get_running_loop().time() + 1
    while FakePocketTTSModel.active_entries == 0:
        if asyncio.get_running_loop().time() > deadline:
            pytest.fail("queued synthesis did not enter after stream completion")
        await asyncio.sleep(0.01)
    with pytest.raises(TTSProviderError) as busy:
        blocked_stream = provider.stream(TTSSynthesisRequest(text="blocked", request_id="stream-2"))
        await blocked_stream.__anext__()

    assert first.audio == b"\x00 "
    assert [(chunk.sequence, chunk.is_final) for chunk in rest] == [(1, False), (2, True)]
    assert busy.value.code == "resource_exhausted"
    assert FakePocketTTSModel.max_active_entries == 1
    release_synthesis.set()
    result = await queued_synthesis
    assert result.audio
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_serializes_model_entry_and_cancels_active_delivery() -> None:
    release = threading.Event()
    FakePocketTTSModel.block_generation = release
    provider = PocketTTSProvider(
        _pockettts_config(
            effective_language="en",
            max_tokens=4,
            request_timeout_s=5,
            queue_timeout_s=5,
        ),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    first = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="one", request_id="request-1"))
    )
    await asyncio.sleep(0.05)
    second = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="two", request_id="request-2"))
    )
    await asyncio.sleep(0.05)

    await provider.cancel("request-1")
    release.set()

    with pytest.raises(TTSProviderError) as exc_info:
        await first
    await second

    assert exc_info.value.code == "cancelled"
    assert FakePocketTTSModel.max_active_entries == 1
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_timeout_keeps_entry_gate_until_blocking_call_finishes() -> None:
    release = threading.Event()
    FakePocketTTSModel.block_generation = release
    provider = PocketTTSProvider(
        _pockettts_config(
            effective_language="en",
            max_tokens=4,
            request_timeout_s=0.05,
            queue_timeout_s=0.05,
        ),
        model_class=FakePocketTTSModel,
    )
    await provider.start()

    with pytest.raises(TTSProviderError) as timed_out:
        await provider.synthesize(TTSSynthesisRequest(text="blocked", request_id="request-1"))
    with pytest.raises(TTSProviderError) as still_busy:
        await provider.synthesize(TTSSynthesisRequest(text="queued", request_id="request-2"))

    assert timed_out.value.code == "resource_exhausted"
    assert still_busy.value.code == "resource_exhausted"
    assert FakePocketTTSModel.max_active_entries == 1
    release.set()
    await asyncio.sleep(0.1)
    result = await provider.synthesize(TTSSynthesisRequest(text="after"))
    assert result.audio
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_reload_rejects_new_work_while_draining_then_swaps() -> None:
    release = threading.Event()
    FakePocketTTSModel.block_generation = release
    provider = PocketTTSProvider(
        _pockettts_config(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    active = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="active", request_id="request-1"))
    )
    await asyncio.sleep(0.05)
    reload_task = asyncio.create_task(
        provider.reload(
            _pockettts_config(effective_language="de", quality_tier="quality", max_tokens=4)
        )
    )
    await asyncio.sleep(0.05)

    with pytest.raises(TTSProviderError) as rejected:
        await provider.synthesize(TTSSynthesisRequest(text="during-reload"))

    assert rejected.value.code == "capability_changed"
    release.set()
    await active
    await reload_task
    health = await provider.health()
    assert health.ready is True
    assert health.base_identity is not None
    assert ":german:german_24l:" in health.base_identity
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_failed_reload_retains_old_healthy_state() -> None:
    provider = PocketTTSProvider(
        _pockettts_config(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    original_health = await provider.health()

    FakePocketTTSModel.fail_load = True
    with pytest.raises(TTSProviderError) as exc_info:
        await provider.reload(
            _pockettts_config(effective_language="de", quality_tier="quality", max_tokens=4)
        )

    assert exc_info.value.code == "unavailable"
    health = await provider.health()
    assert health.ready is True
    assert health.base_identity == original_health.base_identity
    result = await provider.synthesize(TTSSynthesisRequest(text="still works"))
    assert result.voice == "standard:starter_en:alba"
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_forwards_supported_settings_and_omits_null_temperature() -> None:
    provider = PocketTTSProvider(
        _pockettts_config(
            effective_language="pt",
            quality_tier="quality",
            max_tokens=4,
            quantize=True,
            device="cpu",
            temperature=None,
            lsd_decode_steps=8,
            noise_clamp=0.25,
            eos_threshold=0.5,
        ),
        model_class=FakePocketTTSModel,
    )
    await provider.start()

    await provider.synthesize(TTSSynthesisRequest(text="settings"))

    assert FakePocketTTSModel.load_calls == [
        {
            "language": "portuguese_24l",
            "quantize": True,
            "lsd_decode_steps": 8,
            "noise_clamp": 0.25,
            "eos_threshold": 0.5,
        }
    ]
    generation = FakePocketTTSModel.generation_calls[-1]
    assert "temp" not in generation
    assert "lsd_decode_steps" not in generation
    assert "noise_clamp" not in generation
    assert "eos_threshold" not in generation
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_rejects_unsupported_provider_and_request_settings() -> None:
    unsupported_device = PocketTTSProvider(
        _pockettts_config(effective_language="en", max_tokens=4, device="cuda"),
        model_class=FakePocketTTSModel,
    )
    with pytest.raises(TTSProviderError) as device_error:
        await unsupported_device.start()

    provider = PocketTTSProvider(
        _pockettts_config(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    for request in (
        TTSSynthesisRequest(text="bad-format", audio_format="mp3"),  # type: ignore[arg-type]
        TTSSynthesisRequest(text="bad-rate", sample_rate=16000),
        TTSSynthesisRequest(text="bad-speed", speed=1.2),
    ):
        with pytest.raises(TTSProviderError) as request_error:
            await provider.synthesize(request)
        assert request_error.value.code == "invalid_audio"

    assert device_error.value.code == "unavailable"
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_rejects_loaded_non_cpu_model() -> None:
    FakePocketTTSModel.loaded_device = "cuda"
    provider = PocketTTSProvider(
        _pockettts_config(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.start()

    assert exc_info.value.code == "unavailable"
    assert str(exc_info.value) == "PocketTTS device is unavailable"
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_rejects_loaded_sample_rate_mismatch_before_voice_states() -> None:
    FakePocketTTSModel.loaded_sample_rate = 16000
    provider = PocketTTSProvider(
        _pockettts_config(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.start()

    assert exc_info.value.code == "invalid_audio"
    assert str(exc_info.value) == "PocketTTS sample rate is unavailable"
    assert FakePocketTTSModel.load_calls == [{"language": "english_2026-04", "quantize": False}]
    assert FakePocketTTSModel.generation_calls == []
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_unavailable_errors_are_sanitized() -> None:
    FakePocketTTSModel.fail_load = True
    provider = PocketTTSProvider(
        _pockettts_config(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.start()

    assert exc_info.value.code == "unavailable"
    assert str(exc_info.value) == "PocketTTS synthesis failed"
    assert "/secret/model/path" not in str(exc_info.value)
    await provider.stop()

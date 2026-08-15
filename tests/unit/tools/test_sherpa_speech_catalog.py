from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "tools" / "voice-runtime" / "catalog" / "generate_sherpa_speech_catalog.py"
CATALOG = (
    ROOT
    / "rust"
    / "crates"
    / "aurora-voice-engine"
    / "resources"
    / "sherpa_onnx_speech_catalog.json"
)


def _module():
    spec = importlib.util.spec_from_file_location("generate_sherpa_speech_catalog", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _asset(module, *, asset_id: int, name: str, size: int, tag: str) -> dict[str, object]:
    return {
        "id": asset_id,
        "name": name,
        "size": size,
        "updated_at": "2026-01-03T00:00:00Z",
        "browser_download_url": (
            f"https://github.com/{module.SHERPA_REPOSITORY}/releases/download/{tag}/{name}"
        ),
    }


def _fixture(module, monkeypatch):
    tokenizer = b'LANGUAGES = {"en": "english", "fr": "french"}\n'
    monkeypatch.setattr(module, "WHISPER_LANGUAGE_SHA256", hashlib.sha256(tokenizer).hexdigest())
    monkeypatch.setattr(module, "EXPECTED_WHISPER_LANGUAGE_COUNT", 2)
    monkeypatch.setattr(module, "EXPECTED_STT_COUNT", 2)
    monkeypatch.setattr(module, "EXPECTED_VAD_COUNT", 1)
    monkeypatch.setattr(module, "EXPECTED_KWS_COUNT", 1)

    asr_checksums = (
        b"sherpa-onnx-whisper-tiny.tar.bz2\t" + b"1" * 64 + b"\n"
        b"sherpa-onnx-whisper-tiny.en.tar.bz2\t" + b"2" * 64 + b"\n"
        b"silero_vad.int8.onnx\t" + b"3" * 64 + b"\n"
    )
    kws_checksums = (
        b"sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01-mobile.tar.bz2\t" + b"4" * 64 + b"\n"
    )
    asr_pins = module.ReleasePins(
        release_id=7,
        release_tag="asr-models",
        checksum_asset_id=8,
        checksum_sha256=hashlib.sha256(asr_checksums).hexdigest(),
    )
    kws_pins = module.ReleasePins(
        release_id=17,
        release_tag="kws-models",
        checksum_asset_id=18,
        checksum_sha256=hashlib.sha256(kws_checksums).hexdigest(),
    )
    asr_release = {
        "id": 7,
        "tag_name": "asr-models",
        "published_at": "2026-01-01T00:00:00Z",
        "assets": [
            _asset(module, asset_id=8, name="checksum.txt", size=1, tag="asr-models"),
            _asset(
                module,
                asset_id=9,
                name="sherpa-onnx-whisper-tiny.tar.bz2",
                size=123,
                tag="asr-models",
            ),
            _asset(
                module,
                asset_id=10,
                name="sherpa-onnx-whisper-tiny.en.tar.bz2",
                size=124,
                tag="asr-models",
            ),
            _asset(
                module,
                asset_id=11,
                name="silero_vad.int8.onnx",
                size=125,
                tag="asr-models",
            ),
        ],
    }
    kws_release = {
        "id": 17,
        "tag_name": "kws-models",
        "published_at": "2026-01-01T00:00:00Z",
        "assets": [
            _asset(module, asset_id=18, name="checksum.txt", size=1, tag="kws-models"),
            _asset(
                module,
                asset_id=19,
                name=("sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01-mobile.tar.bz2"),
                size=126,
                tag="kws-models",
            ),
        ],
    }
    return (
        json.dumps(asr_release).encode(),
        asr_checksums,
        json.dumps(kws_release).encode(),
        kws_checksums,
        tokenizer,
        asr_pins,
        kws_pins,
    )


def test_build_catalog_is_deterministic_and_exact_selection_only(monkeypatch) -> None:
    module = _module()
    fixture = _fixture(module, monkeypatch)

    catalog = module.build_catalog(*fixture[:5], asr_pins=fixture[5], kws_pins=fixture[6])

    assert catalog["languages"] == ["en", "fr"]
    assert [entry["model_id"] for entry in catalog["entries"]] == [
        "kws:zipformer:gigaspeech-mobile",
        "stt:whisper:tiny",
        "stt:whisper:tiny.en",
        "vad:silero:current-int8",
    ]
    multilingual = catalog["entries"][1]
    assert multilingual["languages"] == ["en", "fr"]
    assert multilingual["archive"]["sha256"] == "1" * 64
    assert multilingual["bindings"]["encoder"].endswith("tiny-encoder.int8.onnx")
    english = catalog["entries"][2]
    assert english["languages"] == ["en"]
    assert english["language_scope"] == "specific"
    assert all("bytes" not in entry and "payload" not in entry for entry in catalog["entries"])


def test_build_catalog_rejects_unpinned_or_untrusted_evidence(monkeypatch) -> None:
    module = _module()
    fixture = _fixture(module, monkeypatch)

    with pytest.raises(module.CatalogGenerationError, match="digest"):
        module.build_catalog(
            fixture[0],
            fixture[1] + b"x",
            *fixture[2:5],
            asr_pins=fixture[5],
            kws_pins=fixture[6],
        )

    release = json.loads(fixture[0])
    release["assets"][1]["browser_download_url"] = "https://example.com/model.tar.bz2"
    with pytest.raises(module.CatalogGenerationError, match="release metadata"):
        module.build_catalog(
            json.dumps(release).encode(),
            *fixture[1:5],
            asr_pins=fixture[5],
            kws_pins=fixture[6],
        )

    monkeypatch.setattr(module, "WHISPER_LANGUAGE_SHA256", "0" * 64)
    with pytest.raises(module.CatalogGenerationError, match="language source digest"):
        module.build_catalog(*fixture[:5], asr_pins=fixture[5], kws_pins=fixture[6])


def test_committed_catalog_covers_pinned_speech_models_without_weights() -> None:
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))

    assert catalog["schema_version"] == 1
    assert catalog["sources"]["asr"]["release_id"] == 130_628_817
    assert catalog["sources"]["kws"]["release_id"] == 145_831_594
    assert catalog["sources"]["whisper_languages"]["commit"] == (
        "5f86d1d86363843179951550570367b37c5d6f78"
    )
    assert len(catalog["languages"]) == 100
    assert len(catalog["entries"]) == 21
    assert sum(entry["task"] == "speech_to_text" for entry in catalog["entries"]) == 12
    assert sum(entry["task"] == "voice_activity_detection" for entry in catalog["entries"]) == 4
    assert sum(entry["task"] == "keyword_spotting" for entry in catalog["entries"]) == 5
    assert len({entry["model_id"] for entry in catalog["entries"]}) == 21
    assert all(entry["terms"]["download_initiated_by_user"] for entry in catalog["entries"])
    assert all(not entry["terms"]["redistributed_by_aurora"] for entry in catalog["entries"])
    assert CATALOG.stat().st_size < 250_000
    payload = CATALOG.read_text(encoding="utf-8").lower()
    assert "safetensors" not in payload
    assert "onnx_data" not in payload
    assert '"payload"' not in payload
    assert '"bytes"' not in payload

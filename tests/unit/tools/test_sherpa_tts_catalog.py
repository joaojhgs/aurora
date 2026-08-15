from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "tools" / "voice-runtime" / "catalog" / "generate_sherpa_tts_catalog.py"
CATALOG = (
    ROOT / "rust" / "crates" / "aurora-voice-engine" / "resources" / "sherpa_onnx_tts_catalog.json"
)


def _module():
    spec = importlib.util.spec_from_file_location("generate_sherpa_tts_catalog", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _fixture(module):
    checksum = (
        b"vits-piper-en_US-ljspeech-medium.tar.bz2\t"
        b"1111111111111111111111111111111111111111111111111111111111111111\n"
        b"vits-piper-fr_FR-siwis-low-int8.tar.bz2\t"
        b"2222222222222222222222222222222222222222222222222222222222222222\n"
    )
    release = {
        "id": 7,
        "tag_name": "tts-models",
        "published_at": "2026-01-01T00:00:00Z",
        "assets": [
            {
                "id": 8,
                "name": "checksum.txt",
                "size": len(checksum),
                "updated_at": "2026-01-02T00:00:00Z",
                "browser_download_url": module.CHECKSUM_URL,
            },
            {
                "id": 10,
                "name": "vits-piper-fr_FR-siwis-low-int8.tar.bz2",
                "size": 12_345,
                "updated_at": "2026-01-03T00:00:00Z",
                "browser_download_url": (
                    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
                    "vits-piper-fr_FR-siwis-low-int8.tar.bz2"
                ),
            },
            {
                "id": 9,
                "name": "vits-piper-en_US-ljspeech-medium.tar.bz2",
                "size": 23_456,
                "updated_at": "2026-01-03T00:00:00Z",
                "browser_download_url": (
                    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
                    "vits-piper-en_US-ljspeech-medium.tar.bz2"
                ),
            },
        ],
    }
    pins = module.CatalogPins(
        release_id=7,
        release_tag="tts-models",
        checksum_asset_id=8,
        checksum_sha256=hashlib.sha256(checksum).hexdigest(),
        expected_voice_count=2,
        expected_language_count=2,
        pockettts_asset_id=None,
        pockettts_archive_sha256=None,
    )
    return json.dumps(release).encode(), checksum, pins


def test_build_catalog_is_deterministic_and_selected_item_metadata_only() -> None:
    module = _module()
    release, checksum, pins = _fixture(module)

    catalog = module.build_catalog(release, checksum, pins=pins)

    assert catalog["languages"] == ["en-us", "fr-fr"]
    assert [entry["voice_id"] for entry in catalog["entries"]] == [
        "standard:piper:en_us-ljspeech-medium",
        "standard:piper:fr_fr-siwis-low-int8",
    ]
    french = catalog["entries"][1]
    assert french["quality"] == "low"
    assert french["precision"] == "int8"
    assert french["archive"]["sha256"] == "2" * 64
    assert french["bindings"]["model"].endswith("fr_FR-siwis-low-int8.onnx")
    assert "bytes" not in french and "payload" not in french


def test_build_catalog_includes_the_pinned_pockettts_metadata_entry() -> None:
    module = _module()
    release_payload, checksum, base_pins = _fixture(module)
    release = json.loads(release_payload)
    pockettts_sha256 = "3" * 64
    checksum += (
        b"sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2\t" + pockettts_sha256.encode() + b"\n"
    )
    release["assets"].append(
        {
            "id": 11,
            "name": "sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2",
            "size": 98_336_520,
            "updated_at": "2026-02-10T15:40:31Z",
            "browser_download_url": (
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
                "sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2"
            ),
        }
    )
    pins = module.CatalogPins(
        release_id=base_pins.release_id,
        release_tag=base_pins.release_tag,
        checksum_asset_id=base_pins.checksum_asset_id,
        checksum_sha256=hashlib.sha256(checksum).hexdigest(),
        expected_voice_count=base_pins.expected_voice_count,
        expected_language_count=base_pins.expected_language_count,
        pockettts_asset_id=11,
        pockettts_archive_sha256=pockettts_sha256,
    )

    catalog = module.build_catalog(json.dumps(release).encode(), checksum, pins=pins)

    pockettts = catalog["entries"][-1]
    assert len(catalog["entries"]) == 3
    assert pockettts["voice_id"] == ("standard:pockettts:sherpa-onnx-pocket-tts-int8-2026-01-26")
    assert pockettts["archive"]["asset_id"] == 11
    assert pockettts["archive"]["sha256"] == pockettts_sha256
    assert pockettts["bindings"]["decoder"].endswith("/decoder.int8.onnx")
    assert pockettts["terms"] == {
        "source": "upstream_model_card_restricted_non_commercial",
        "redistributed_by_aurora": False,
        "download_initiated_by_user": True,
    }


def test_build_catalog_rejects_unpinned_or_incomplete_evidence() -> None:
    module = _module()
    release, checksum, pins = _fixture(module)

    with pytest.raises(module.CatalogGenerationError, match="digest"):
        module.build_catalog(release, checksum + b"x", pins=pins)

    parsed = json.loads(release)
    parsed["assets"][1]["browser_download_url"] = "https://example.com/model.tar.bz2"
    with pytest.raises(module.CatalogGenerationError, match="download URL"):
        module.build_catalog(json.dumps(parsed).encode(), checksum, pins=pins)


def test_committed_catalog_covers_all_pinned_tts_voices_without_weights() -> None:
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    entries = catalog["entries"]
    piper_entries = [entry for entry in entries if entry["model_family"] == "vits_piper"]
    pockettts_entries = [entry for entry in entries if entry["model_family"] == "pockettts"]

    assert catalog["schema_version"] == 1
    assert catalog["source"]["release_id"] == 130_612_623
    assert catalog["source"]["checksum_asset_id"] == 424_712_825
    assert catalog["source"]["checksum_sha256"] == (
        "30d65b392bba8dfbdbc3479928d3f80adff2c71d4f518ce893d572b8aff021ee"
    )
    assert len(entries) == 537
    assert len(piper_entries) == 536
    assert len(pockettts_entries) == 1
    assert len(catalog["languages"]) == 50
    assert len({entry["voice_id"] for entry in entries}) == 537
    assert all(entry["archive"]["format"] == "tar_bzip2" for entry in entries)
    assert all(entry["terms"]["download_initiated_by_user"] for entry in entries)
    assert CATALOG.stat().st_size < 1_500_000
    payload = CATALOG.read_text(encoding="utf-8").lower()
    assert "safetensors" not in payload
    assert "onnx_data" not in payload

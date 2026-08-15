from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
SOURCES = REPO / "tools/voice-runtime/pockettts-packs/language_pack_sources.json"
CONVERT = REPO / "tools/voice-runtime/pockettts-packs/convert_language_pack.py"
PUBLISH = REPO / "tools/voice-runtime/pockettts-packs/publish_language_packs.py"
WORKFLOW = REPO / ".github/workflows/sherpa-pockettts-language-packs.yml"


def load_convert():
    spec = importlib.util.spec_from_file_location("convert_language_pack", CONVERT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_overlay_catalog_matches_source_pack_ids() -> None:
    overlay = json.loads(
        (REPO / "tools/voice-runtime/pockettts-packs/aurora_pockettts_language_pack_catalog.json")
        .read_text(encoding="utf-8")
    )
    sources = json.loads(SOURCES.read_text(encoding="utf-8"))
    voice_ids = {item["voice_id"] for item in overlay["entries"]}
    assert voice_ids == {item["voice_id"] for item in sources["packs"]}
    assert overlay["temporary_bootstrap"] is True
    assert "pull_request" not in overlay["removal_point"]
    for entry in overlay["entries"]:
        assert entry["terms"]["redistributed_by_aurora"] is True
        assert entry["archive"]["url"].startswith(overlay["download_base"])
        assert "pocket_protocol.json" not in entry["bindings"].values()


def test_language_pack_sources_pin_official_en_and_fr() -> None:
    sources = json.loads(SOURCES.read_text(encoding="utf-8"))
    packs = {item["pack_id"]: item for item in sources["packs"]}
    assert "aurora-pockettts-en-2026-04" in packs
    assert "aurora-pockettts-fr-24l" in packs
    assert packs["aurora-pockettts-en-2026-04"]["language"] == "en-us"
    assert packs["aurora-pockettts-fr-24l"]["language"] == "fr-fr"
    assert packs["aurora-pockettts-en-2026-04"]["protocol"]["insert_bos_before_voice"] is True
    assert packs["aurora-pockettts-fr-24l"]["protocol"]["frames_after_eos"] == 8
    assert packs["aurora-pockettts-fr-24l"]["protocol"]["empty_kv_seq_len"] == 0
    assert sources["temporary_bootstrap"] is True
    assert "stable archive URLs" in sources["removal_point"]


def test_convert_dry_run_does_not_download(tmp_path: Path) -> None:
    module = load_convert()
    report = module.convert_pack(
        "aurora-pockettts-en-2026-04",
        cache_root=tmp_path,
        dry_run=True,
    )
    assert report["dry_run"] is True
    assert report["kyutai_config"] == "english_2026-04"
    assert not any(tmp_path.rglob("*.onnx"))
    assert not any(tmp_path.rglob("*.safetensors"))


def test_release_workflow_is_manual_and_not_pr() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")
    assert "pull_request:" not in text
    assert "workflow_dispatch:" in text
    assert "name: Sherpa PocketTTS language packs" in text
    assert "sherpa-pockettts-language-packs" in text


def test_publish_script_validates_workflow_without_archives() -> None:
    spec = importlib.util.spec_from_file_location("publish_language_packs", PUBLISH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.validate_workflow(WORKFLOW)


def test_graph_optimizer_folds_identity_and_dedups_initializers(tmp_path: Path) -> None:
    onnx = pytest.importorskip("onnx")
    from onnx import TensorProto, helper, numpy_helper
    import numpy as np

    values = np.array([1.0, 2.0, 3.0], dtype=np.float32)
    init_a = numpy_helper.from_array(values, name="a")
    init_b = numpy_helper.from_array(values.copy(), name="b")
    graph = helper.make_graph(
        [
            helper.make_node("Identity", ["a"], ["a_id"]),
            helper.make_node("Add", ["a_id", "b"], ["out"]),
        ],
        "fold",
        [],
        [helper.make_tensor_value_info("out", TensorProto.FLOAT, [3])],
        [init_a, init_b],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    path = tmp_path / "fold.onnx"
    onnx.save(model, path)
    spec = importlib.util.spec_from_file_location(
        "optimize_onnx_graph",
        REPO / "tools/voice-runtime/pockettts-packs/optimize_onnx_graph.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    stats = module.optimize_file(path)
    assert stats["removed_identity"] == 1
    assert stats["deduplicated_initializers"] == 1


def test_protocol_sidecar_round_trip(tmp_path: Path) -> None:
    module = load_convert()
    bos = module.write_bos(tmp_path, [0.0] * 1024, [1, 1, 1024])
    module.write_protocol(
        tmp_path,
        {
            "protocol_version": 1,
            "insert_bos_before_voice": True,
            "frames_after_eos": 8,
            "eos_threshold": -4.0,
            "empty_kv_seq_len": 0,
            "latent_dim": 32,
        },
        bos,
    )
    payload = json.loads((tmp_path / "pocket_protocol.json").read_text(encoding="utf-8"))
    assert payload["insert_bos_before_voice"] is True
    assert payload["bos_before_voice"]["file"] == "bos_before_voice.bin"
    assert bos.stat().st_size == 1024 * 4

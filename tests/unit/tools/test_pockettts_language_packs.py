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
        (
            REPO / "tools/voice-runtime/pockettts-packs/aurora_pockettts_language_pack_catalog.json"
        ).read_text(encoding="utf-8")
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
    assert packs["aurora-pockettts-en-2026-04"]["protocol"]["decoder_kv_seq_len"] == 10000
    assert packs["aurora-pockettts-en-2026-04"]["protocol"]["mimi_steps_per_latent"] == 16
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
    import numpy as np
    from onnx import TensorProto, helper, numpy_helper

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


def test_disambiguate_onnx_io_names_renames_colliding_outputs() -> None:
    pytest.importorskip("onnx")
    spec = importlib.util.spec_from_file_location(
        "run_official_export",
        REPO / "tools/voice-runtime/pockettts-packs/run_official_export.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    class _Value:
        def __init__(self, name: str) -> None:
            self.name = name

    class _Node:
        def __init__(self, outputs: list[str]) -> None:
            self.output = outputs

    class _Graph:
        def __init__(self) -> None:
            self.input = [_Value("state_0"), _Value("state_1")]
            self.output = [_Value("audio_frame"), _Value("state_0"), _Value("out_state_1")]
            self.node = [_Node(["state_0"]), _Node(["out_state_1"])]

    class _Model:
        def __init__(self) -> None:
            self.graph = _Graph()

    model = _Model()
    assert module.disambiguate_onnx_io_names(model) == 1
    assert [item.name for item in model.graph.output] == [
        "audio_frame",
        "out_state_0",
        "out_state_1",
    ]
    assert model.graph.node[0].output == ["state_0"]
    assert model.graph.node[-1].output == ["out_state_0"]


def test_helper_export_patcher_is_idempotent_and_skips_old_attention() -> None:
    spec = importlib.util.spec_from_file_location(
        "run_official_export",
        REPO / "tools/voice-runtime/pockettts-packs/run_official_export.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    source = """
from pocket_tts.default_parameters import DEFAULT_VARIANT
from pocket_tts.modules.transformer import StreamingMultiheadAttention, complete_kv
from pocket_tts.modules.mimi_transformer import MimiStreamingMultiheadAttention, KVCacheResult
TTSModel.load_model(DEFAULT_VARIANT)
StreamingMultiheadAttention.forward = patched_sma_forward
MimiStreamingMultiheadAttention.increment_step = patched_mimi_increment_step
"""
    patched = module.patch_helper_export_script_text(source)
    assert module.SENTINEL in patched
    assert "POCKET_TTS_LANGUAGE" in patched
    assert "MimiStreamingMultiheadAttention = None" in patched
    assert "_aurora_complete_kv" in patched
    assert "_aurora_rope_offset" in patched
    assert 'hasattr(StreamingMultiheadAttention, "_apply_rope")' in patched
    assert patched == module.patch_helper_export_script_text(patched)
    compile(patched, "<helper>", "exec")
    mimi = "STATIC_SEQ_LEN = 1000\n" + source
    assert "STATIC_SEQ_LEN = 10000" in module.patch_mimi_static_seq_len(mimi)
    verify = "mimi_state = init_states(tts_model.mimi, batch_size=1, sequence_length=1000)\n"
    patched_verify = module.patch_mimi_static_seq_len(verify)
    assert patched_verify == (
        "mimi_state = init_states(tts_model.mimi, batch_size=1, sequence_length=10000)\n"
    )


def test_resize_static_kv_cache_dim_only_rewrites_rank5_cache() -> None:
    pytest.importorskip("onnx")
    from onnx import TensorProto, helper

    spec = importlib.util.spec_from_file_location(
        "run_official_export",
        REPO / "tools/voice-runtime/pockettts-packs/run_official_export.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    cache = helper.make_tensor_value_info("state_19", TensorProto.FLOAT, [2, 1, 1000, 8, 64])
    other = helper.make_tensor_value_info("state_1", TensorProto.FLOAT, [1, 512, 6])
    out_cache = helper.make_tensor_value_info(
        "out_state_19", TensorProto.FLOAT, [2, 1, 1000, 8, 64]
    )
    graph = helper.make_graph(
        [helper.make_node("Identity", ["state_19"], ["out_state_19"])],
        "kv",
        [cache, other],
        [out_cache],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    assert module.resize_static_kv_cache_dim(model) == 2
    assert [dim.dim_value for dim in model.graph.input[0].type.tensor_type.shape.dim][2] == 10000
    assert [dim.dim_value for dim in model.graph.input[1].type.tensor_type.shape.dim] == [
        1,
        512,
        6,
    ]


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
    assert payload["bos_before_voice"] == "bos_before_voice.bin"
    assert bos.stat().st_size == 1024 * 4

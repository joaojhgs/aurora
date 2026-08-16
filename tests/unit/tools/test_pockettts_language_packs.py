from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tarfile
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
        assert entry["terms"]["source"] == "upstream_model_card"
        assert entry["archive"]["url"].startswith(overlay["download_base"])
        assert entry["archive"]["byte_size"] > 1
        assert entry["archive"]["sha256"] != "0" * 64
        assert entry["capability"]["reference_audio_mode"] == "internal"
        assert entry["capability"]["voice_cloning"] is False
        assert entry["capability"]["source_repo"] == "kyutai/pocket-tts-without-voice-cloning"
        assert entry["capability"]["license"] == "CC-BY-4.0"
        assert entry["bindings"]["reference_audio"].endswith("/internal_reference.wav")
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
    assert packs["aurora-pockettts-en-2026-04"]["weights"]["repo_id"] == (
        "kyutai/pocket-tts-without-voice-cloning"
    )
    assert packs["aurora-pockettts-en-2026-04"]["weights"]["source_mode"] == "public-fixed-voice"
    assert packs["aurora-pockettts-en-2026-04"]["weights"]["voice_cloning"] is False
    assert "public_fallback_repo_id" not in packs["aurora-pockettts-en-2026-04"]["weights"]
    assert sources["temporary_bootstrap"] is True
    assert "stable archive URLs" in sources["removal_point"]
    assert sources["export_helper"]["repository"] == (
        "https://github.com/csukuangfj/pocket-tts-onnx-export"
    )
    assert sources["export_helper"]["commit"] == ("f075c00bf4bbfbb081a11fd99abbf39df3849e0c")


PINNED_HELPER_REPO = "https://github.com/csukuangfj/pocket-tts-onnx-export"
PINNED_HELPER_COMMIT = "f075c00bf4bbfbb081a11fd99abbf39df3849e0c"


def _init_helper_git(path: Path, *, origin: str, dirty: bool = False) -> str:
    path.mkdir(parents=True, exist_ok=True)
    (path / "export.py").write_text("PINNED = True\n", encoding="utf-8")
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "config", "user.email", "helper@example.test"],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "helper-test"],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "add", "export.py"], cwd=path, check=True, capture_output=True, text=True
    )
    subprocess.run(
        ["git", "commit", "-m", "pin"],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "remote", "add", "origin", origin],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    )
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=path, text=True).strip()
    if dirty:
        (path / "export.py").write_text("DIRTY = True\n", encoding="utf-8")
    return commit


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
    assert "release_tag:" in text
    assert "gh release upload" in text
    assert "--clobber" in text
    assert "HF_TOKEN" not in text
    assert "--weights-source public-fixed-voice" in text
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
    repaired = onnx.load(str(path))
    assert [item.name for item in repaired.graph.initializer] == ["a"]
    assert [list(node.input) for node in repaired.graph.node] == [["a", "a"]]


def test_graph_optimizer_keeps_output_alias_identities(tmp_path: Path) -> None:
    onnx = pytest.importorskip("onnx")
    from onnx import TensorProto, helper

    graph = helper.make_graph(
        [helper.make_node("Identity", ["state_0"], ["out_state_0"])],
        "alias",
        [helper.make_tensor_value_info("state_0", TensorProto.FLOAT, [2, 1, 8])],
        [helper.make_tensor_value_info("out_state_0", TensorProto.FLOAT, [2, 1, 8])],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    path = tmp_path / "alias.onnx"
    onnx.save(model, path)
    spec = importlib.util.spec_from_file_location(
        "optimize_onnx_graph",
        REPO / "tools/voice-runtime/pockettts-packs/optimize_onnx_graph.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    stats = module.optimize_file(path)
    assert stats["removed_identity"] == 0
    repaired = onnx.load(str(path))
    assert [item.name for item in repaired.graph.output] == ["out_state_0"]
    assert repaired.graph.node[0].op_type == "Identity"


def test_graph_optimizer_dedups_identical_tensors_with_different_names(tmp_path: Path) -> None:
    onnx = pytest.importorskip("onnx")
    import numpy as np
    from onnx import TensorProto, helper, numpy_helper

    values = np.array([4.0, 5.0], dtype=np.float32)
    left = numpy_helper.from_array(values, name="weights_left")
    right = numpy_helper.from_array(values.copy(), name="weights_right")
    right.doc_string = "same payload, different name"
    graph = helper.make_graph(
        [helper.make_node("Add", ["weights_left", "weights_right"], ["out"])],
        "dedup",
        [],
        [helper.make_tensor_value_info("out", TensorProto.FLOAT, [2])],
        [left, right],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    path = tmp_path / "dedup.onnx"
    onnx.save(model, path)
    spec = importlib.util.spec_from_file_location(
        "optimize_onnx_graph",
        REPO / "tools/voice-runtime/pockettts-packs/optimize_onnx_graph.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module._initializer_value_digest(left) == module._initializer_value_digest(right)
    stats = module.optimize_file(path)
    assert stats["deduplicated_initializers"] == 1
    repaired = onnx.load(str(path))
    assert [item.name for item in repaired.graph.initializer] == ["weights_left"]
    assert list(repaired.graph.node[0].input) == ["weights_left", "weights_left"]


def test_graph_optimizer_does_not_dedup_different_tensor_values(tmp_path: Path) -> None:
    onnx = pytest.importorskip("onnx")
    import numpy as np
    from onnx import TensorProto, helper, numpy_helper

    left = numpy_helper.from_array(np.array([1.0, 2.0], dtype=np.float32), name="a")
    right = numpy_helper.from_array(np.array([1.0, 2.5], dtype=np.float32), name="b")
    graph = helper.make_graph(
        [helper.make_node("Add", ["a", "b"], ["out"])],
        "keep",
        [],
        [helper.make_tensor_value_info("out", TensorProto.FLOAT, [2])],
        [left, right],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    path = tmp_path / "keep.onnx"
    onnx.save(model, path)
    spec = importlib.util.spec_from_file_location(
        "optimize_onnx_graph",
        REPO / "tools/voice-runtime/pockettts-packs/optimize_onnx_graph.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module._initializer_value_digest(left) != module._initializer_value_digest(right)
    stats = module.optimize_file(path)
    assert stats["deduplicated_initializers"] == 0
    repaired = onnx.load(str(path))
    assert [item.name for item in repaired.graph.initializer] == ["a", "b"]


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


def test_bos_extract_reads_safetensors_keys() -> None:
    text = (REPO / "tools/voice-runtime/pockettts-packs/run_official_export.py").read_text(
        encoding="utf-8"
    )
    assert "handle.keys()" in text
    assert 'if "flow_lm.bos_before_voice" not in handle:' not in text


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


def test_download_never_selects_gated_because_token_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    spec = importlib.util.spec_from_file_location(
        "run_official_export",
        REPO / "tools/voice-runtime/pockettts-packs/run_official_export.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    calls: list[tuple[str, str]] = []

    def fake_download(repo_id: str, revision: str, filename: str, dest_dir: Path) -> Path:
        calls.append((repo_id, revision))
        path = dest_dir / Path(filename).name
        dest_dir.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"ok")
        return path

    monkeypatch.setenv("HF_TOKEN", "should-not-select-gated")
    monkeypatch.setattr(module, "_download", fake_download)
    weights, tokenizer, repo = module.download_language_weights(
        "english_2026-04", tmp_path / "hf-cache", "public-fixed-voice"
    )
    assert repo == "kyutai/pocket-tts-without-voice-cloning"
    assert all(repo_id == "kyutai/pocket-tts-without-voice-cloning" for repo_id, _ in calls)
    assert weights.name == "model.safetensors"
    assert tokenizer.name == "tokenizer.model"


def test_gated_download_is_explicit_and_fail_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    spec = importlib.util.spec_from_file_location(
        "run_official_export",
        REPO / "tools/voice-runtime/pockettts-packs/run_official_export.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGING_FACE_HUB_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="explicit"):
        module.download_language_weights("english_2026-04", tmp_path / "gated", "gated")

    monkeypatch.setenv("HF_TOKEN", "token")

    def boom(*_args: object, **_kwargs: object) -> Path:
        raise RuntimeError("gated denied")

    monkeypatch.setattr(module, "_download", boom)
    with pytest.raises(RuntimeError, match="refusing public fallback"):
        module.download_language_weights("english_2026-04", tmp_path / "gated", "gated")


def test_graph_optimizer_fail_closed_before_archive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = load_convert()

    def fail(*_args: object, **_kwargs: object) -> dict:
        raise RuntimeError("optimizer exploded")

    monkeypatch.setattr(module, "_ensure_export_helper", lambda dest, *_args, **_kwargs: dest)
    monkeypatch.setattr(module, "_run_official_export", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(module, "_ensure_sherpa_tokenizer", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(module, "_inline_pack_onnx", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(module, "_extract_bos", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(module, "optimize_onnx_files", fail)
    with pytest.raises(module.ConversionError, match="graph optimization failed"):
        module.convert_pack("aurora-pockettts-en-2026-04", cache_root=tmp_path)
    assert not (tmp_path / "aurora-pockettts-en-2026-04.tar.bz2").exists()


def test_internal_reference_and_public_model_card(tmp_path: Path) -> None:
    module = load_convert()
    wav = module.write_internal_reference(tmp_path)
    assert wav.name == "internal_reference.wav"
    assert wav.stat().st_size > 44
    spec = {
        "display_name": "PocketTTS English",
        "kyutai_config": "english_2026-04",
        "weights": {
            "repo_id": "kyutai/pocket-tts-without-voice-cloning",
            "revision": "e041936c75475d350b405bc870bcf7c22da4e9e6",
            "license": "CC-BY-4.0",
            "encoder_status": "zeroed_by_remove_voice_cloning_and_push",
        },
        "tokenizer": {
            "repo_id": "kyutai/pocket-tts-without-voice-cloning",
            "revision": "e041936c75475d350b405bc870bcf7c22da4e9e6",
            "license": "CC-BY-4.0",
        },
    }
    capability = module.write_capability(tmp_path, spec, "public-fixed-voice")
    assert capability["reference_audio_mode"] == "internal"
    assert capability["voice_cloning"] is False
    sources = {
        "kyutai_source": {
            "repository": "https://github.com/kyutai-labs/pocket-tts",
            "tag": "v2.1.0",
        }
    }
    module._write_model_card(tmp_path, spec, sources, "public-fixed-voice")
    card = (tmp_path / "README.md").read_text(encoding="utf-8")
    assert "kyutai/pocket-tts-without-voice-cloning" in card
    assert "e041936c75475d350b405bc870bcf7c22da4e9e6" in card
    assert "CC-BY-4.0" in card
    assert ".artifacts" not in card
    assert "non-commercial" not in card.lower()


def _load_safe_tar():
    spec = importlib.util.spec_from_file_location(
        "safe_tar", REPO / "tools/voice-runtime/safe_tar.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_tar(path: Path, *members: tarfile.TarInfo, payload: bytes = b"") -> None:
    with tarfile.open(path, "w") as tar:
        for member in members:
            if member.isfile() and member.size:
                tar.addfile(member, fileobj=__import__("io").BytesIO(payload))
            else:
                tar.addfile(member)


def test_safe_tar_rejects_traversal_before_data_filter(tmp_path: Path) -> None:
    assert hasattr(tarfile, "data_filter")
    module = _load_safe_tar()
    archive = tmp_path / "escape.tar"
    info = tarfile.TarInfo(name="../escape.txt")
    info.size = 2
    _write_tar(archive, info, payload=b"no")
    with pytest.raises(module.UnsafeTarError, match="unsafe tar member path"):
        module.safe_extract_tar(archive, tmp_path / "out")
    assert not (tmp_path / "escape.txt").exists()


def test_safe_tar_rejects_absolute_path(tmp_path: Path) -> None:
    module = _load_safe_tar()
    archive = tmp_path / "abs.tar"
    info = tarfile.TarInfo(name="/tmp/aurora-safe-tar-abs.txt")
    info.size = 2
    _write_tar(archive, info, payload=b"no")
    with pytest.raises(module.UnsafeTarError, match="unsafe tar member path"):
        module.safe_extract_tar(archive, tmp_path / "out")


def test_safe_tar_rejects_nested_traversal(tmp_path: Path) -> None:
    module = _load_safe_tar()
    archive = tmp_path / "nested.tar"
    info = tarfile.TarInfo(name="ok/../../escape.txt")
    info.size = 2
    _write_tar(archive, info, payload=b"no")
    with pytest.raises(module.UnsafeTarError, match="unsafe tar member path"):
        module.safe_extract_tar(archive, tmp_path / "out")


def test_safe_tar_rejects_symlink(tmp_path: Path) -> None:
    module = _load_safe_tar()
    archive = tmp_path / "sym.tar"
    info = tarfile.TarInfo(name="link")
    info.type = tarfile.SYMTYPE
    info.linkname = "/etc/passwd"
    _write_tar(archive, info)
    with pytest.raises(module.UnsafeTarError, match="refusing link member"):
        module.safe_extract_tar(archive, tmp_path / "out")
    assert not (tmp_path / "out" / "link").exists()


def test_safe_tar_rejects_hardlink(tmp_path: Path) -> None:
    module = _load_safe_tar()
    archive = tmp_path / "hard.tar"
    info = tarfile.TarInfo(name="hard")
    info.type = tarfile.LNKTYPE
    info.linkname = "target"
    _write_tar(archive, info)
    with pytest.raises(module.UnsafeTarError, match="refusing link member"):
        module.safe_extract_tar(archive, tmp_path / "out")


def test_safe_tar_rejects_fifo(tmp_path: Path) -> None:
    module = _load_safe_tar()
    archive = tmp_path / "fifo.tar"
    info = tarfile.TarInfo(name="pipe")
    info.type = tarfile.FIFOTYPE
    _write_tar(archive, info)
    with pytest.raises(module.UnsafeTarError, match="refusing device member"):
        module.safe_extract_tar(archive, tmp_path / "out")


def test_safe_tar_rejects_character_and_block_devices(tmp_path: Path) -> None:
    module = _load_safe_tar()
    for name, kind in (("char", tarfile.CHRTYPE), ("block", tarfile.BLKTYPE)):
        archive = tmp_path / f"{name}.tar"
        info = tarfile.TarInfo(name=name)
        info.type = kind
        info.devmajor = 1
        info.devminor = 3
        _write_tar(archive, info)
        with pytest.raises(module.UnsafeTarError, match="refusing device member"):
            module.safe_extract_tar(archive, tmp_path / name)


def test_safe_tar_extracts_regular_file_after_member_scan(tmp_path: Path) -> None:
    module = _load_safe_tar()
    archive = tmp_path / "ok.tar"
    dest = tmp_path / "out"
    payload = b"safe"
    info = tarfile.TarInfo(name="hello.txt")
    info.size = len(payload)
    _write_tar(archive, info, payload=payload)
    module.safe_extract_tar(archive, dest)
    assert (dest / "hello.txt").read_bytes() == payload


def test_convert_helper_does_not_ls_remote_raw_sha() -> None:
    text = CONVERT.read_text(encoding="utf-8")
    assert "_verify_origin_advertises_commit" not in text
    assert "ls-remote" not in text


def _fake_fetch_git(
    module: object,
    calls: list[tuple[str, ...]],
    *,
    fetch_error: str | None = None,
    head: str = PINNED_HELPER_COMMIT,
    origin: str = PINNED_HELPER_REPO,
    status: str = "",
    remotes: str = "",
):
    def fake_git(*args: str, cwd: Path | None = None) -> str:
        calls.append(args)
        if args[:2] == ("ls-remote", "--exit-code") and args[-1] == PINNED_HELPER_COMMIT:
            raise module.ConversionError("")  # git ls-remote exits 2 with no output
        if args == ("init",):
            return ""
        if args == ("remote",):
            return remotes
        if args == ("remote", "add", "origin", PINNED_HELPER_REPO):
            return ""
        if args == ("remote", "set-url", "origin", PINNED_HELPER_REPO):
            return ""
        if args == ("remote", "get-url", "origin"):
            return origin
        if args == ("fetch", "--depth", "1", "origin", PINNED_HELPER_COMMIT):
            if fetch_error is not None:
                raise module.ConversionError(fetch_error)
            return ""
        if args == ("checkout", "--detach", "FETCH_HEAD"):
            return ""
        if args == ("rev-parse", "HEAD"):
            return head
        if args == ("status", "--porcelain"):
            return status
        raise module.ConversionError(f"unexpected git {args}")

    return fake_git


def test_fetch_pinned_helper_does_not_ls_remote_raw_sha(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = load_convert()
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(module, "_run_git", _fake_fetch_git(module, calls))
    module._fetch_pinned_helper_source(tmp_path / "src", PINNED_HELPER_REPO, PINNED_HELPER_COMMIT)
    fetch = ("fetch", "--depth", "1", "origin", PINNED_HELPER_COMMIT)
    checkout = ("checkout", "--detach", "FETCH_HEAD")
    assert fetch in calls
    assert checkout in calls
    assert ("ls-remote", "--exit-code", PINNED_HELPER_REPO, PINNED_HELPER_COMMIT) not in calls
    assert not any(args[:1] == ("ls-remote",) for args in calls)
    assert calls.index(("init",)) < calls.index(("remote", "add", "origin", PINNED_HELPER_REPO))
    assert calls.index(("remote", "add", "origin", PINNED_HELPER_REPO)) < calls.index(fetch)
    assert calls.index(fetch) < calls.index(checkout)
    assert calls.index(checkout) < calls.index(("rev-parse", "HEAD"))
    assert ("remote", "get-url", "origin") in calls
    assert ("status", "--porcelain") in calls


def test_fetch_pinned_helper_rewrites_existing_origin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = load_convert()
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(module, "_run_git", _fake_fetch_git(module, calls, remotes="origin"))
    module._fetch_pinned_helper_source(tmp_path / "src", PINNED_HELPER_REPO, PINNED_HELPER_COMMIT)
    assert ("remote", "set-url", "origin", PINNED_HELPER_REPO) in calls
    assert ("remote", "add", "origin", PINNED_HELPER_REPO) not in calls
    assert calls.index(("remote", "set-url", "origin", PINNED_HELPER_REPO)) < calls.index(
        ("fetch", "--depth", "1", "origin", PINNED_HELPER_COMMIT)
    )


def test_fetch_failure_is_authoritative_unavailable_pin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = load_convert()
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(
        module,
        "_run_git",
        _fake_fetch_git(module, calls, fetch_error="fatal: couldn't find remote ref"),
    )
    with pytest.raises(module.ConversionError, match="unavailable from origin") as caught:
        module._fetch_pinned_helper_source(
            tmp_path / "src", PINNED_HELPER_REPO, PINNED_HELPER_COMMIT
        )
    assert "couldn't find remote ref" in str(caught.value.__cause__)
    assert ("checkout", "--detach", "FETCH_HEAD") not in calls


def test_fetch_pinned_helper_rejects_wrong_head_or_dirty_checkout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = load_convert()
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(
        module,
        "_run_git",
        _fake_fetch_git(module, calls, head="0" * 40),
    )
    with pytest.raises(module.ConversionError, match="HEAD"):
        module._fetch_pinned_helper_source(
            tmp_path / "src", PINNED_HELPER_REPO, PINNED_HELPER_COMMIT
        )

    dirty_calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(
        module,
        "_run_git",
        _fake_fetch_git(module, dirty_calls, status=" M export.py"),
    )
    with pytest.raises(module.ConversionError, match="dirty"):
        module._fetch_pinned_helper_source(
            tmp_path / "src", PINNED_HELPER_REPO, PINNED_HELPER_COMMIT
        )


def test_helper_source_pin_rejects_wrong_dirty_or_foreign_origin(tmp_path: Path) -> None:
    module = load_convert()
    source = tmp_path / "export-helper-src"
    commit = _init_helper_git(source, origin=PINNED_HELPER_REPO)
    assert module._helper_source_matches_pin(source, PINNED_HELPER_REPO, commit) is True
    assert (
        module._helper_source_matches_pin(source, PINNED_HELPER_REPO, PINNED_HELPER_COMMIT) is False
    )

    (source / "export.py").write_text("DIRTY = True\n", encoding="utf-8")
    assert module._helper_source_matches_pin(source, PINNED_HELPER_REPO, commit) is False

    clean = tmp_path / "clean-origin"
    clean_commit = _init_helper_git(clean, origin="https://example.test/not-the-helper")
    assert module._helper_source_matches_pin(clean, PINNED_HELPER_REPO, clean_commit) is False


def test_ensure_export_helper_does_not_reuse_wrong_or_dirty_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = load_convert()
    dest = tmp_path / "export-helper"
    dest.mkdir()
    (dest / "export.py").write_text("DIRTY = True\n", encoding="utf-8")
    fetched: list[tuple[Path, str, str]] = []

    def fake_source(source: Path, repository: str, commit: str) -> None:
        fetched.append((source, repository, commit))
        source.mkdir(parents=True, exist_ok=True)
        (source / "export.py").write_text("PINNED = True\n", encoding="utf-8")
        (source / "scripts").mkdir()
        (source / "scripts" / "export_flow_lm.py").write_text("ok\n", encoding="utf-8")

    monkeypatch.setattr(module, "_ensure_pinned_helper_source", fake_source)
    staged = module._ensure_export_helper(
        dest,
        {
            "export_helper": {
                "repository": PINNED_HELPER_REPO,
                "commit": PINNED_HELPER_COMMIT,
            }
        },
    )
    assert staged == dest
    assert fetched == [(tmp_path / "export-helper-src", PINNED_HELPER_REPO, PINNED_HELPER_COMMIT)]
    assert (dest / "export.py").read_text(encoding="utf-8") == "PINNED = True\n"
    assert "DIRTY" not in (dest / "export.py").read_text(encoding="utf-8")
    assert not (dest / ".git").exists()


def test_pinned_helper_source_reuses_only_clean_matching_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = load_convert()
    source = tmp_path / "export-helper-src"
    commit = _init_helper_git(source, origin=PINNED_HELPER_REPO)

    def boom(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("must not refetch a clean pinned helper")

    monkeypatch.setattr(module, "_fetch_pinned_helper_source", boom)
    module._ensure_pinned_helper_source(source, PINNED_HELPER_REPO, commit)
    assert (source / "export.py").read_text(encoding="utf-8") == "PINNED = True\n"


def test_pinned_helper_source_refetches_wrong_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = load_convert()
    source = tmp_path / "export-helper-src"
    _init_helper_git(source, origin=PINNED_HELPER_REPO, dirty=True)
    fetches: list[tuple[Path, str, str]] = []

    def fake_match(path: Path, repository: str, commit: str) -> bool:
        export = path / "export.py"
        return (
            export.is_file()
            and export.read_text(encoding="utf-8") == "PINNED = True\n"
            and repository == PINNED_HELPER_REPO
            and commit == PINNED_HELPER_COMMIT
        )

    def fake_fetch(dest: Path, repository: str, commit: str) -> None:
        fetches.append((dest, repository, commit))
        dest.mkdir(parents=True, exist_ok=True)
        (dest / ".git").mkdir(exist_ok=True)
        (dest / "export.py").write_text("PINNED = True\n", encoding="utf-8")

    monkeypatch.setattr(module, "_helper_source_matches_pin", fake_match)
    monkeypatch.setattr(module, "_fetch_pinned_helper_source", fake_fetch)
    module._ensure_pinned_helper_source(source, PINNED_HELPER_REPO, PINNED_HELPER_COMMIT)
    assert fetches == [(source, PINNED_HELPER_REPO, PINNED_HELPER_COMMIT)]
    assert (source / "export.py").read_text(encoding="utf-8") == "PINNED = True\n"


def test_archive_pack_is_byte_identical_after_mtime_and_mode_changes(tmp_path: Path) -> None:
    module = load_convert()
    pack = tmp_path / "aurora-pockettts-en-2026-04"
    pack.mkdir()
    (pack / "b.txt").write_text("bravo\n", encoding="utf-8")
    (pack / "a.txt").write_text("alpha\n", encoding="utf-8")
    nested = pack / "nested"
    nested.mkdir()
    (nested / "c.txt").write_text("charlie\n", encoding="utf-8")
    os.utime(pack / "a.txt", (1, 1))
    first = module.archive_pack(pack, tmp_path / "one.tar.bz2")
    os.utime(pack / "a.txt", (1_700_000_000, 1_700_000_000))
    os.chmod(pack / "b.txt", 0o600)
    second = module.archive_pack(pack, tmp_path / "two.tar.bz2")
    assert first["sha256"] == second["sha256"]
    assert (tmp_path / "one.tar.bz2").read_bytes() == (tmp_path / "two.tar.bz2").read_bytes()
    with tarfile.open(tmp_path / "one.tar.bz2", "r:bz2") as tar:
        names = [member.name for member in tar.getmembers()]
        assert names == sorted(names)
        for member in tar.getmembers():
            assert member.uid == 0
            assert member.gid == 0
            assert member.uname == ""
            assert member.gname == ""
            assert member.mtime == 0
            if member.isdir():
                assert member.mode & 0o777 == 0o755
            else:
                assert member.isfile()
                assert member.mode & 0o777 == 0o644

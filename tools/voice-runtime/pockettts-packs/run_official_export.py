#!/usr/bin/env python3
"""Export one Kyutai language with the official ONNX helper.

Default source is the public CC-BY-4.0 repo
kyutai/pocket-tts-without-voice-cloning. Gated kyutai/pocket-tts is used only
when --weights-source gated is set explicitly. HF_TOKEN never selects a source.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

PUBLIC_REPO = "kyutai/pocket-tts-without-voice-cloning"
PUBLIC_REVISION = "e041936c75475d350b405bc870bcf7c22da4e9e6"
GATED_REPO = "kyutai/pocket-tts"
GATED_REVISION = "4c8ad48f8a003909bc4f1122cbe88a4252124621"


def _download(repo_id: str, revision: str, filename: str, dest_dir: Path) -> Path:
    from huggingface_hub import hf_hub_download

    return Path(
        hf_hub_download(
            repo_id=repo_id,
            revision=revision,
            filename=filename,
            local_dir=str(dest_dir),
        )
    )


def _restore_helper_scripts(helper: Path) -> None:
    if not (helper / ".git").is_dir():
        return
    subprocess.run(
        [
            "git",
            "checkout",
            "--",
            "scripts/export_mimi_and_conditioner.py",
            "scripts/export_flow_lm.py",
        ],
        cwd=helper,
        check=False,
    )


def _disable_beartype_claw(helper: Path) -> None:
    init = helper / "pocket_tts" / "__init__.py"
    if not init.is_file():
        return
    text = init.read_text(encoding="utf-8")
    if "AURORA_DISABLE_BEARTYPE" in text:
        return
    text = text.replace(
        "beartype_this_package(conf=BeartypeConf(is_color=False))",
        "# AURORA_DISABLE_BEARTYPE: ONNX tracing passes tensor shapes as ints\n"
        "# beartype_this_package(conf=BeartypeConf(is_color=False))",
    )
    init.write_text(text, encoding="utf-8")


def _ensure_current_pocket_tts(helper: Path) -> None:
    config = helper / "pocket_tts/config/french_24l.yaml"
    if config.is_file():
        return
    kyutai = helper.parent.parent / "kyutai-pocket-tts"
    if not (kyutai / "pocket_tts/config/french_24l.yaml").is_file():
        raise SystemExit("current Kyutai pocket-tts checkout is missing language configs")
    dest = helper / "pocket_tts"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(kyutai / "pocket_tts", dest)


SENTINEL = "# AURORA_POCKETTTS_EXPORT_PATCHED"
# Kyutai mimi runs 16 transformer steps per latent frame. Sherpa's default
# max_frames=500 therefore needs 8000 cache slots; 10000 matches Kyutai's
# own generate() allocation and leaves headroom.
MIMI_DECODER_KV_SEQ_LEN = 10000
MIMI_EXPORT_STATIC_SEQ_LEN = f"STATIC_SEQ_LEN = {MIMI_DECODER_KV_SEQ_LEN}"

# Current Kyutai attention uses offset+cache and has no _apply_rope. The helper
# was written for the older b6369a24 class; keep those patches only when that
# API is present, and make current KV updates ONNX-traceable otherwise.
CURRENT_KYUTAI_ONNX_PATCH = """
if not hasattr(StreamingMultiheadAttention, "_apply_rope"):
    import pocket_tts.modules.transformer as _aurora_tr

    def _aurora_complete_kv(cache, offset, k, v):
        current_step = offset.reshape(-1)[0]
        new_cache = cache.clone()
        new_cache[0, :, current_step : current_step + k.shape[1]] = k
        new_cache[1, :, current_step : current_step + v.shape[1]] = v
        valid = new_cache[:, :, : current_step + k.shape[1]]
        return valid[0], valid[1]

    _aurora_tr.complete_kv = _aurora_complete_kv

    def _aurora_sma_increment(self, state, increment=1):
        if state is None:
            return
        if "offset" in state:
            state["offset"] = state["offset"] + increment
        elif "step" in state:
            state["step"] = state["step"] + increment

    StreamingMultiheadAttention.increment_step = _aurora_sma_increment

    def _aurora_rope_offset(self, state, batch_size, device):
        if state is None:
            return torch.zeros((), dtype=torch.long, device=device)
        return state["offset"].reshape(-1)[0]

    _aurora_tr._LinearKVCacheBackend.rope_offset = _aurora_rope_offset
"""

OLD_SMA_ASSIGNMENTS = (
    "StreamingMultiheadAttention.init_state = patched_init_state",
    "StreamingMultiheadAttention.increment_step = patched_increment_step",
    "StreamingMultiheadAttention._streaming_offset = patched_streaming_offset",
    "StreamingMultiheadAttention._complete_kv = patched_sma_complete_kv",
    "StreamingMultiheadAttention._get_mask = patched_get_mask",
    "StreamingMultiheadAttention.forward = patched_sma_forward",
)

MIMI_IMPORT = (
    "from pocket_tts.modules.mimi_transformer import MimiStreamingMultiheadAttention, KVCacheResult"
)
MIMI_IMPORT_OPTIONAL = (
    "try:\n"
    "    from pocket_tts.modules.mimi_transformer import "
    "MimiStreamingMultiheadAttention, KVCacheResult\n"
    "except ImportError:\n"
    "    MimiStreamingMultiheadAttention = None\n"
    "    KVCacheResult = None\n"
)


def patch_helper_export_script_text(text: str) -> str:
    """Adapt the official helper scripts to current Kyutai pocket_tts. Idempotent."""
    if SENTINEL in text:
        return text
    if "from pocket_tts.default_parameters import DEFAULT_VARIANT" in text:
        text = text.replace(
            "from pocket_tts.default_parameters import DEFAULT_VARIANT",
            "import os\nfrom pocket_tts.default_parameters import DEFAULT_LANGUAGE",
        )
        text = text.replace(
            "TTSModel.load_model(DEFAULT_VARIANT)",
            "TTSModel.load_model(language=os.environ.get('POCKET_TTS_LANGUAGE', DEFAULT_LANGUAGE))",
        )
    if MIMI_IMPORT in text and "MimiStreamingMultiheadAttention = None" not in text:
        text = text.replace(MIMI_IMPORT, MIMI_IMPORT_OPTIONAL)
        text = text.replace(
            "MimiStreamingMultiheadAttention.increment_step = patched_mimi_increment_step",
            "if MimiStreamingMultiheadAttention is not None:\n"
            "    MimiStreamingMultiheadAttention.increment_step = patched_mimi_increment_step",
        )
        text = text.replace(
            "MimiStreamingMultiheadAttention._complete_kv = patched_mimi_complete_kv",
            "if MimiStreamingMultiheadAttention is not None:\n"
            "    MimiStreamingMultiheadAttention._complete_kv = patched_mimi_complete_kv",
        )
    sma_import_with_kv = (
        "from pocket_tts.modules.transformer import StreamingMultiheadAttention, complete_kv"
    )
    sma_import = "from pocket_tts.modules.transformer import StreamingMultiheadAttention"
    if sma_import_with_kv in text:
        text = text.replace(
            sma_import_with_kv,
            sma_import_with_kv + "\n" + CURRENT_KYUTAI_ONNX_PATCH,
            1,
        )
    elif sma_import in text:
        text = text.replace(sma_import, sma_import + "\n" + CURRENT_KYUTAI_ONNX_PATCH, 1)
    for assignment in OLD_SMA_ASSIGNMENTS:
        if (
            assignment in text
            and 'hasattr(StreamingMultiheadAttention, "_apply_rope")'
            not in text[text.find(assignment) - 80 : text.find(assignment)]
        ):
            text = text.replace(
                assignment,
                'if hasattr(StreamingMultiheadAttention, "_apply_rope"):\n    ' + assignment,
            )
    text = text.replace(
        "dummy_latent = torch.randn(1, 1, 32)",
        "dummy_latent = torch.randn(1, 15, 32)",
    )
    return SENTINEL + "\n" + text


def patch_mimi_static_seq_len(text: str) -> str:
    """Give the mimi decoder a linear KV cache that can finish max_frames."""
    text = text.replace("STATIC_SEQ_LEN = 1000", MIMI_EXPORT_STATIC_SEQ_LEN)
    return text.replace(
        "init_states(tts_model.mimi, batch_size=1, sequence_length=1000)",
        f"init_states(tts_model.mimi, batch_size=1, sequence_length={MIMI_DECODER_KV_SEQ_LEN})",
    )


def resize_static_kv_cache_dim(
    model: object,
    *,
    old_len: int = 1000,
    new_len: int = MIMI_DECODER_KV_SEQ_LEN,
) -> int:
    """Widen rank-5 KV cache I/O after a matching STATIC_SEQ_LEN export.

    Do not apply this to a graph traced at 1000 steps. Internal Reshape/Gather
    shapes stay specialized to 1000 and then fail at runtime. Re-export mimi
    with STATIC_SEQ_LEN=10000, then optionally rewrite leftover I/O metadata.
    """
    changed = 0
    for collection in (model.graph.input, model.graph.output):
        for item in collection:
            dims = item.type.tensor_type.shape.dim
            if len(dims) == 5 and dims[0].dim_value == 2 and dims[2].dim_value == old_len:
                dims[2].dim_value = new_len
                changed += 1
    return changed


def _patch_helper_export_scripts(helper: Path) -> None:
    for name in ("export_mimi_and_conditioner.py", "export_flow_lm.py"):
        path = helper / "scripts" / name
        text = patch_helper_export_script_text(path.read_text(encoding="utf-8"))
        if name == "export_mimi_and_conditioner.py":
            text = patch_mimi_static_seq_len(text)
        path.write_text(text, encoding="utf-8")


def disambiguate_onnx_io_names(model: object) -> int:
    """Expose colliding outputs under unique names.

    Official Sherpa packs use out_state_*. Torch export sometimes reuses
    state_* for both, and ORT then aliases View() buffers during Run.
    Internal node names stay intact; an Identity edge publishes the alias.
    """
    from onnx import helper

    input_names = {item.name for item in model.graph.input}
    output_names = {item.name for item in model.graph.output}
    renamed = 0
    for item in model.graph.output:
        if item.name not in input_names:
            continue
        candidate = f"out_{item.name}"
        suffix = 0
        while candidate in input_names or candidate in output_names:
            suffix += 1
            candidate = f"out_{item.name}_{suffix}"
        old = item.name
        model.graph.node.append(helper.make_node("Identity", [old], [candidate]))
        item.name = candidate
        output_names.discard(old)
        output_names.add(candidate)
        renamed += 1
    return renamed


def inline_onnx_file(src: Path, dest: Path) -> None:
    """Copy an ONNX graph and embed any external .data tensors."""
    import onnx
    from onnx.external_data_helper import convert_model_from_external_data

    dest.parent.mkdir(parents=True, exist_ok=True)
    model = onnx.load(str(src), load_external_data=True)
    convert_model_from_external_data(model)
    disambiguate_onnx_io_names(model)
    onnx.save(model, str(dest))


def _extract_bos_from_safetensors(weights: Path, output: Path) -> Path | None:
    from safetensors import safe_open

    candidates = (
        "flow_lm.bos_before_voice",
        "bos_before_voice",
        "flow_lm.bos_emb",
        "bos_emb",
    )
    with safe_open(str(weights), framework="pt") as handle:
        keys = set(handle.keys())
        name = next((candidate for candidate in candidates if candidate in keys), None)
        if name is None:
            return None
        tensor = handle.get_tensor(name)
    values = tensor.detach().cpu().float().reshape(-1).tolist()
    raw = __import__("array").array("f", values)
    path = output / "bos_before_voice.bin"
    path.write_bytes(raw.tobytes())
    return path


def download_language_weights(
    language: str, dest_dir: Path, source_mode: str
) -> tuple[Path, Path, str]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    filename = f"languages/{language}/model.safetensors"
    tokenizer = f"languages/{language}/tokenizer.model"
    if source_mode == "gated":
        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        if not token:
            raise RuntimeError(
                "gated PocketTTS weights require an explicit --weights-source gated "
                "and HF_TOKEN; refusing the public fixed-voice repo"
            )
        try:
            weights = _download(GATED_REPO, GATED_REVISION, filename, dest_dir / "gated")
            tok = _download(GATED_REPO, GATED_REVISION, tokenizer, dest_dir / "gated")
        except Exception as exc:
            raise RuntimeError(
                f"gated PocketTTS download failed; refusing public fallback: {exc}"
            ) from exc
        return weights, tok, GATED_REPO
    if source_mode != "public-fixed-voice":
        raise RuntimeError(f"unknown PocketTTS weights source {source_mode}")
    weights = _download(PUBLIC_REPO, PUBLIC_REVISION, filename, dest_dir / "public")
    tok = _download(PUBLIC_REPO, PUBLIC_REVISION, tokenizer, dest_dir / "public")
    return weights, tok, PUBLIC_REPO


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--language", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--weights-source",
        choices=("public-fixed-voice", "gated"),
        default="public-fixed-voice",
    )
    args = parser.parse_args()

    helper = args.helper.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    _ensure_current_pocket_tts(helper)
    _disable_beartype_claw(helper)
    _restore_helper_scripts(helper)
    _patch_helper_export_scripts(helper)
    os.chdir(helper)

    cache = output.parent / "hf-cache" / args.language
    weights, tokenizer, source_repo = download_language_weights(
        args.language, cache, args.weights_source
    )
    shutil.copy2(tokenizer, output / "tokenizer.model")

    env = os.environ.copy()
    env["PYTHONPATH"] = str(helper)
    env["POCKET_TTS_LANGUAGE"] = args.language
    env["POCKET_TTS_WEIGHTS"] = str(weights)
    onnx_dir = helper / "onnx"
    onnx_dir.mkdir(exist_ok=True)
    scripts = helper / "scripts"
    subprocess.run(
        [
            sys.executable,
            str(scripts / "export_mimi_and_conditioner.py"),
            "--output_dir",
            str(onnx_dir),
            "--weights_path",
            str(weights),
        ],
        check=True,
        env=env,
    )
    subprocess.run(
        [
            sys.executable,
            str(scripts / "export_flow_lm.py"),
            "--output_dir",
            str(onnx_dir),
            "--weights_path",
            str(weights),
        ],
        check=True,
        env=env,
    )
    subprocess.run(
        [
            sys.executable,
            str(scripts / "quantize.py"),
            "--input_dir",
            str(onnx_dir),
            "--output_dir",
            str(onnx_dir),
        ],
        check=True,
        env=env,
    )
    mapping = {
        "flow_lm_flow.onnx": "lm_flow.onnx",
        "flow_lm_flow_int8.onnx": "lm_flow.int8.onnx",
        "flow_lm_main.onnx": "lm_main.onnx",
        "flow_lm_main_int8.onnx": "lm_main.int8.onnx",
        "mimi_encoder.onnx": "encoder.onnx",
        "mimi_decoder.onnx": "decoder.onnx",
        "mimi_decoder_int8.onnx": "decoder.int8.onnx",
        "text_conditioner.onnx": "text_conditioner.onnx",
    }
    for src_name, dest_name in mapping.items():
        src = onnx_dir / src_name
        if src.is_file():
            inline_onnx_file(src, output / dest_name)
    _extract_bos_from_safetensors(weights, output)
    (output / "weight_source.json").write_text(
        json.dumps(
            {
                "repo": source_repo,
                "language": args.language,
                "weights": str(weights),
                "tokenizer": str(tokenizer),
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

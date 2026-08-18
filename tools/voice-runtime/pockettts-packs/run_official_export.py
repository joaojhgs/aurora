#!/usr/bin/env python3
"""Export one Kyutai language with the official ONNX helper.

Default source is the public CC-BY-4.0 repo
kyutai/pocket-tts-without-voice-cloning. Gated kyutai/pocket-tts is used only
when --weights-source gated is set explicitly. HF_TOKEN never selects a source.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

SOURCES_PATH = Path(__file__).with_name("language_pack_sources.json")


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


def _normalize_git_url(url: str) -> str:
    value = url.strip().rstrip("/")
    if value.endswith(".git"):
        value = value[: -len(".git")]
    if value.startswith("git@github.com:"):
        value = "https://github.com/" + value[len("git@github.com:") :]
    return value.lower()


def _git_output(source: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=source,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip() or "git verification failed"
        raise RuntimeError(detail)
    return result.stdout.strip()


def _verify_kyutai_source(source: Path, repository: str, commit: str) -> None:
    if not (source / ".git").is_dir():
        raise RuntimeError("pinned Kyutai source is not a git checkout")
    head = _git_output(source, "rev-parse", "HEAD").lower()
    if head != commit.lower():
        raise RuntimeError(f"Kyutai source HEAD {head} != pin {commit}")
    origin = _git_output(source, "remote", "get-url", "origin")
    if _normalize_git_url(origin) != _normalize_git_url(repository):
        raise RuntimeError(f"Kyutai source origin {origin} != {repository}")
    if _git_output(source, "status", "--porcelain"):
        raise RuntimeError("pinned Kyutai source checkout is dirty")
    if not (source / "pocket_tts/config/french_24l.yaml").is_file():
        raise RuntimeError("pinned Kyutai source is missing multilingual configs")


def _ensure_current_pocket_tts(
    helper: Path,
    kyutai_source: Path,
    repository: str,
    commit: str,
) -> None:
    _verify_kyutai_source(kyutai_source, repository, commit)
    dest = helper / "pocket_tts"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(
        kyutai_source / "pocket_tts",
        dest,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )


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
    import numpy as np
    from safetensors import safe_open

    candidates = (
        "flow_lm.bos_before_voice",
        "bos_before_voice",
        "flow_lm.bos_emb",
        "bos_emb",
    )
    with safe_open(str(weights), framework="numpy") as handle:
        keys = set(handle.keys())
        name = next((candidate for candidate in candidates if candidate in keys), None)
        if name is None:
            return None
        values = np.asarray(handle.get_tensor(name), dtype="<f4").reshape(-1)
    path = output / "bos_before_voice.bin"
    path.write_bytes(values.tobytes(order="C"))
    return path


def _artifact_source(
    spec: dict[str, Any], source_mode: str
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None]:
    tokenizer = spec["tokenizer"]
    if source_mode == "public-fixed-voice":
        fixed_voice = spec.get("fixed_voice")
        if not isinstance(fixed_voice, dict):
            raise RuntimeError("public fixed-voice pack is missing a fixed_voice source pin")
        return spec["weights"], tokenizer, fixed_voice
    if source_mode != "gated":
        raise RuntimeError(f"unknown PocketTTS weights source {source_mode}")
    weights = spec["weights"]
    return (
        {
            "repo_id": weights["gated_clone_repo_id"],
            "revision": weights["gated_clone_revision"],
            "filename": weights["filename"],
        },
        tokenizer,
        None,
    )


def download_language_artifacts(
    spec: dict[str, Any], dest_dir: Path, source_mode: str
) -> dict[str, Any]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    weights_spec, tokenizer_spec, fixed_voice_spec = _artifact_source(spec, source_mode)
    if source_mode == "gated":
        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        if not token:
            raise RuntimeError(
                "gated PocketTTS weights require an explicit --weights-source gated "
                "and HF_TOKEN; refusing the public fixed-voice repo"
            )
        try:
            weights = _download(
                weights_spec["repo_id"],
                weights_spec["revision"],
                weights_spec["filename"],
                dest_dir / "gated",
            )
        except Exception as exc:
            raise RuntimeError(
                f"gated PocketTTS download failed; refusing public fallback: {exc}"
            ) from exc
    else:
        weights = _download(
            weights_spec["repo_id"],
            weights_spec["revision"],
            weights_spec["filename"],
            dest_dir / "public",
        )
    tokenizer = _download(
        tokenizer_spec["repo_id"],
        tokenizer_spec["revision"],
        tokenizer_spec["filename"],
        dest_dir / "tokenizer",
    )
    fixed_voice = None
    if fixed_voice_spec is not None:
        fixed_voice = _download(
            fixed_voice_spec["repo_id"],
            fixed_voice_spec["revision"],
            fixed_voice_spec["filename"],
            dest_dir / "fixed-voice",
        )
    return {
        "weights": weights,
        "weights_source": weights_spec,
        "tokenizer": tokenizer,
        "tokenizer_source": tokenizer_spec,
        "fixed_voice": fixed_voice,
        "fixed_voice_source": fixed_voice_spec,
    }


def export_fixed_voice_state(source: Path, output: Path) -> dict[str, Any]:
    """Convert a pinned Kyutai fixed-voice cache to Aurora's compact raw state."""
    import numpy as np
    from safetensors import safe_open

    cache_pattern = re.compile(r"transformer\.layers\.(\d+)\.self_attn/cache")
    offset_pattern = re.compile(r"transformer\.layers\.(\d+)\.self_attn/offset")
    caches: dict[int, Any] = {}
    offsets: dict[int, int] = {}
    with safe_open(str(source), framework="numpy") as handle:
        # safetensors.safe_open exposes keys() but is not itself iterable.
        tensor_keys = handle.keys()
        for key in tensor_keys:
            cache_match = cache_pattern.fullmatch(key)
            offset_match = offset_pattern.fullmatch(key)
            if cache_match is not None:
                caches[int(cache_match.group(1))] = handle.get_tensor(key)
            elif offset_match is not None:
                value = np.asarray(handle.get_tensor(key)).reshape(-1)
                if value.size != 1:
                    raise RuntimeError(f"fixed voice offset {key} is not scalar")
                offsets[int(offset_match.group(1))] = int(value[0])
    if not caches or sorted(caches) != list(range(len(caches))) or set(caches) != set(offsets):
        raise RuntimeError("fixed voice state layers are incomplete")

    first_shape = tuple(int(dim) for dim in np.asarray(caches[0]).shape)
    if len(first_shape) != 5 or first_shape[0:2] != (2, 1):
        raise RuntimeError(f"unsupported fixed voice cache shape {first_shape}")
    frames, heads, head_dim = first_shape[2:]
    if frames <= 0 or heads <= 0 or head_dim <= 0:
        raise RuntimeError("fixed voice cache dimensions must be positive")

    output.mkdir(parents=True, exist_ok=True)
    target = output / "fixed_voice_state.bin"
    digest = hashlib.sha256()
    byte_size = 0
    with target.open("wb") as sink:
        for layer in range(len(caches)):
            cache = np.asarray(caches[layer])
            shape = tuple(int(dim) for dim in cache.shape)
            if shape != first_shape or offsets[layer] != frames or cache.dtype != np.float32:
                raise RuntimeError(f"fixed voice layer {layer} is incompatible")
            payload = cache.astype("<f4", copy=False).tobytes(order="C")
            sink.write(payload)
            digest.update(payload)
            byte_size += len(payload)
    metadata = {
        "schema_version": 1,
        "file": target.name,
        "dtype": "float32-le",
        "layers": len(caches),
        "frames": frames,
        "heads": heads,
        "head_dim": head_dim,
        "byte_size": byte_size,
        "sha256": digest.hexdigest(),
    }
    (output / "fixed_voice_state.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return metadata


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inline-source", type=Path)
    parser.add_argument("--inline-output", type=Path)
    parser.add_argument("--helper", type=Path)
    parser.add_argument("--sources", type=Path, default=SOURCES_PATH)
    parser.add_argument("--pack")
    parser.add_argument("--kyutai-source", type=Path)
    parser.add_argument("--cache-root", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--weights-source",
        choices=("public-fixed-voice", "gated"),
        default="public-fixed-voice",
    )
    args = parser.parse_args()

    if args.inline_source is not None or args.inline_output is not None:
        if args.inline_source is None or args.inline_output is None:
            parser.error("--inline-source and --inline-output must be provided together")
        inline_onnx_file(args.inline_source.resolve(), args.inline_output.resolve())
        return 0

    required = {
        "--helper": args.helper,
        "--pack": args.pack,
        "--kyutai-source": args.kyutai_source,
        "--cache-root": args.cache_root,
        "--output": args.output,
    }
    missing = [name for name, value in required.items() if value is None]
    if missing:
        parser.error(f"missing required arguments: {', '.join(missing)}")

    sources = json.loads(args.sources.read_text(encoding="utf-8"))
    spec = next(
        (item for item in sources.get("packs", []) if item.get("pack_id") == args.pack),
        None,
    )
    if spec is None:
        raise RuntimeError(f"unknown PocketTTS pack {args.pack}")
    kyutai_pin = sources["kyutai_source"]
    helper = args.helper.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    _ensure_current_pocket_tts(
        helper,
        args.kyutai_source.resolve(),
        kyutai_pin["repository"],
        kyutai_pin["commit"],
    )
    _disable_beartype_claw(helper)
    _restore_helper_scripts(helper)
    _patch_helper_export_scripts(helper)
    os.chdir(helper)

    artifacts = download_language_artifacts(
        spec,
        args.cache_root.resolve() / spec["kyutai_config"],
        args.weights_source,
    )
    weights = artifacts["weights"]
    shutil.copy2(artifacts["tokenizer"], output / "tokenizer.model")
    if artifacts["fixed_voice"] is not None:
        export_fixed_voice_state(artifacts["fixed_voice"], output)

    env = os.environ.copy()
    env["PYTHONPATH"] = str(helper)
    env["POCKET_TTS_LANGUAGE"] = spec["kyutai_config"]
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
        "flow_lm_flow_int8.onnx": "lm_flow.int8.onnx",
        "flow_lm_main_int8.onnx": "lm_main.int8.onnx",
        "mimi_encoder.onnx": "encoder.onnx",
        "mimi_decoder_int8.onnx": "decoder.int8.onnx",
        "text_conditioner.onnx": "text_conditioner.onnx",
    }
    for src_name, dest_name in mapping.items():
        src = onnx_dir / src_name
        if not src.is_file():
            raise RuntimeError(f"official export did not produce {src_name}")
        inline_onnx_file(src, output / dest_name)
    if _extract_bos_from_safetensors(weights, output) is None:
        raise RuntimeError("PocketTTS weights did not contain bos_before_voice")
    (output / "weight_source.json").write_text(
        json.dumps(
            {
                "source_mode": args.weights_source,
                "language": spec["kyutai_config"],
                "weights": artifacts["weights_source"],
                "tokenizer": artifacts["tokenizer_source"],
                "fixed_voice": artifacts["fixed_voice_source"],
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

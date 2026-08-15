#!/usr/bin/env python3
"""Export one Kyutai language with the official ONNX helper.

Prefers gated kyutai/pocket-tts when HF_TOKEN is present. Otherwise uses the
official public CC-BY-4.0 repo kyutai/pocket-tts-without-voice-cloning.
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


def _patch_helper_export_scripts(helper: Path) -> None:
    for name in ("export_mimi_and_conditioner.py", "export_flow_lm.py"):
        path = helper / "scripts" / name
        text = path.read_text(encoding="utf-8")
        if "POCKET_TTS_LANGUAGE" in text:
            continue
        text = text.replace(
            "from pocket_tts.default_parameters import DEFAULT_VARIANT",
            "import os\nfrom pocket_tts.default_parameters import DEFAULT_LANGUAGE",
        )
        text = text.replace(
            "TTSModel.load_model(DEFAULT_VARIANT)",
            "TTSModel.load_model(language=os.environ.get('POCKET_TTS_LANGUAGE', DEFAULT_LANGUAGE))",
        )
        path.write_text(text, encoding="utf-8")


def download_language_weights(language: str, dest_dir: Path) -> tuple[Path, Path, str]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    filename = f"languages/{language}/model.safetensors"
    tokenizer = f"languages/{language}/tokenizer.model"
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if token:
        try:
            weights = _download(GATED_REPO, GATED_REVISION, filename, dest_dir / "gated")
            tok = _download(GATED_REPO, GATED_REVISION, tokenizer, dest_dir / "gated")
            return weights, tok, GATED_REPO
        except Exception as exc:  # noqa: BLE001
            print(f"gated download failed, using public fallback: {exc}", file=sys.stderr)
    weights = _download(PUBLIC_REPO, PUBLIC_REVISION, filename, dest_dir / "public")
    tok = _download(PUBLIC_REPO, PUBLIC_REVISION, tokenizer, dest_dir / "public")
    return weights, tok, PUBLIC_REPO


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--language", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    helper = args.helper.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    _ensure_current_pocket_tts(helper)
    _patch_helper_export_scripts(helper)
    os.chdir(helper)

    cache = output.parent / "hf-cache" / args.language
    weights, tokenizer, source_repo = download_language_weights(args.language, cache)
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
            shutil.copy2(src, output / dest_name)
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

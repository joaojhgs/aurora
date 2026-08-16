#!/usr/bin/env python3
"""Convert official Kyutai PocketTTS language packs for Sherpa.

Downloads happen on demand into .artifacts/. Weights are never committed.
This path does not modify the Python PocketTTS provider.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tarfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
SOURCES_PATH = Path(__file__).resolve().parent / "language_pack_sources.json"
DEFAULT_CACHE = REPO_ROOT / ".artifacts/pockettts/language-packs"
EXPORT_HELPER_URL = "https://github.com/csukuangfj/pocket-tts-onnx-export.git"


class ConversionError(RuntimeError):
    """Raised when an official PocketTTS pack cannot be converted."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_sources(path: Path = SOURCES_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def pack_spec(sources: dict[str, Any], pack_id: str) -> dict[str, Any]:
    for pack in sources.get("packs", []):
        if pack.get("pack_id") == pack_id:
            return pack
    raise ConversionError(f"unknown pack {pack_id}")


def write_protocol(pack_dir: Path, protocol: dict[str, Any], bos_path: Path | None) -> None:
    payload = dict(protocol)
    if bos_path is not None:
        # String form is required: nlohmann json.value(..., std::string())
        # throws if this key is an object, which aborts the native Sherpa process.
        payload["bos_before_voice"] = bos_path.name
    (pack_dir / "pocket_protocol.json").write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def write_bos(pack_dir: Path, values: list[float], shape: list[int]) -> Path:
    import array

    path = pack_dir / "bos_before_voice.bin"
    raw = array.array("f", values)
    path.write_bytes(raw.tobytes())
    expected = 1
    for dim in shape:
        expected *= dim
    if expected != len(values):
        raise ConversionError("bos_before_voice shape does not match values")
    return path


def optimize_onnx_files(pack_dir: Path) -> dict[str, Any]:
    from importlib.util import module_from_spec, spec_from_file_location

    optimizer_path = Path(__file__).with_name("optimize_onnx_graph.py")
    spec = spec_from_file_location("pockettts_optimize_onnx_graph", optimizer_path)
    if spec is None or spec.loader is None:
        raise ConversionError("unable to load graph optimizer")
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    stats: dict[str, Any] = {}
    for path in sorted(pack_dir.glob("*.onnx")):
        stats[path.name] = module.optimize_file(path)
    return stats


def archive_pack(pack_dir: Path, archive: Path) -> dict[str, Any]:
    archive.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "w:bz2") as tar:
        tar.add(pack_dir, arcname=pack_dir.name)
    return {
        "filename": archive.name,
        "sha256": sha256_file(archive),
        "byte_size": archive.stat().st_size,
        "root": pack_dir.name,
    }


def convert_pack(
    pack_id: str,
    *,
    cache_root: Path = DEFAULT_CACHE,
    dry_run: bool = False,
) -> dict[str, Any]:
    sources = load_sources()
    spec = pack_spec(sources, pack_id)
    pack_dir = cache_root / spec["pack_id"]
    report = {
        "pack_id": spec["pack_id"],
        "voice_id": spec["voice_id"],
        "language": spec["language"],
        "kyutai_config": spec["kyutai_config"],
        "weights": spec["weights"],
        "tokenizer": spec["tokenizer"],
        "protocol": spec["protocol"],
        "cache_dir": str(pack_dir),
        "dry_run": dry_run,
    }
    if dry_run:
        return report
    pack_dir.mkdir(parents=True, exist_ok=True)
    helper = _ensure_export_helper(cache_root / "export-helper")
    report["export_helper"] = str(helper)
    _run_official_export(helper, spec, pack_dir)
    _ensure_sherpa_tokenizer(pack_dir)
    _inline_pack_onnx(pack_dir, helper / "onnx")
    bos = _extract_bos(spec["kyutai_config"], pack_dir)
    write_protocol(pack_dir, spec["protocol"], bos)
    _write_model_card(pack_dir, spec, sources)
    try:
        report["graph_opt"] = optimize_onnx_files(pack_dir)
    except Exception as exc:  # noqa: BLE001
        report["graph_opt_error"] = str(exc)
    archive = cache_root / f"{spec['pack_id']}.tar.bz2"
    report["archive"] = archive_pack(pack_dir, archive)
    (pack_dir / "conversion_manifest.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return report


def _ensure_export_helper(dest: Path) -> Path:
    if (dest / "export.py").is_file():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", "--depth", "1", EXPORT_HELPER_URL, str(dest)], check=True)
    return dest


def _export_python() -> str:
    venv = REPO_ROOT / ".artifacts/pockettts/export-venv/bin/python"
    return str(venv) if venv.is_file() else sys.executable


def _run_official_export(helper: Path, spec: dict[str, Any], pack_dir: Path) -> None:
    cmd = [
        _export_python(),
        str(Path(__file__).with_name("run_official_export.py")),
        "--helper",
        str(helper),
        "--language",
        spec["kyutai_config"],
        "--output",
        str(pack_dir),
    ]
    result = subprocess.run(cmd, check=False)
    if result.returncode != 0:
        raise ConversionError("official export failed")


def _ensure_sherpa_tokenizer(pack_dir: Path) -> None:
    vocab = pack_dir / "vocab.json"
    scores = pack_dir / "token_scores.json"
    if vocab.is_file() and scores.is_file():
        return
    model = pack_dir / "tokenizer.model"
    if not model.is_file():
        raise ConversionError("official export did not produce tokenizer.model or vocab.json")
    import sentencepiece as spm

    processor = spm.SentencePieceProcessor(model_file=str(model))
    token2id = {}
    token2score = {}
    for index in range(processor.get_piece_size()):
        token = processor.id_to_piece(index)
        token2id[token] = index
        token2score[token] = processor.get_score(index)
    vocab.write_text(json.dumps(token2id, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    scores.write_text(
        json.dumps(token2score, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _inline_pack_onnx(pack_dir: Path, helper_onnx: Path) -> None:
    from importlib.util import module_from_spec, spec_from_file_location

    export_path = Path(__file__).with_name("run_official_export.py")
    spec = spec_from_file_location("run_official_export", export_path)
    if spec is None or spec.loader is None:
        raise ConversionError("unable to load export helper")
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    pairs = (
        ("mimi_encoder.onnx", "encoder.onnx"),
        ("text_conditioner.onnx", "text_conditioner.onnx"),
    )
    for src_name, dest_name in pairs:
        dest = pack_dir / dest_name
        src = helper_onnx / src_name
        sidecar = Path(str(src) + ".data")
        needs_inline = src.is_file() and (
            sidecar.is_file() or not dest.is_file() or dest.stat().st_size < 1_000_000
        )
        if needs_inline:
            module.inline_onnx_file(src, dest)
        elif dest.is_file():
            module.inline_onnx_file(dest, dest)


def _extract_bos(language: str, pack_dir: Path) -> Path | None:
    existing = pack_dir / "bos_before_voice.bin"
    if existing.is_file() and existing.stat().st_size > 0:
        return existing
    source = pack_dir / "weight_source.json"
    if source.is_file():
        payload = json.loads(source.read_text(encoding="utf-8"))
        weights = Path(payload.get("weights", ""))
        if weights.is_file():
            from importlib.util import module_from_spec, spec_from_file_location

            export_path = Path(__file__).with_name("run_official_export.py")
            spec = spec_from_file_location("run_official_export", export_path)
            if spec is not None and spec.loader is not None:
                module = module_from_spec(spec)
                spec.loader.exec_module(module)
                bos = module._extract_bos_from_safetensors(weights, pack_dir)
                if bos is not None:
                    return bos
    try:
        from pocket_tts import TTSModel
    except ImportError:
        return None
    model = TTSModel.load_model(language=language)
    tensor = None
    for name in ("bos_before_voice", "bos_emb"):
        if hasattr(model, name):
            tensor = getattr(model, name)
            break
        flow = getattr(model, "flow_lm", None)
        if flow is not None and hasattr(flow, name):
            tensor = getattr(flow, name)
            break
    if tensor is None:
        return None
    values = tensor.detach().cpu().float().reshape(-1).tolist()
    shape = [int(dim) for dim in tensor.shape]
    if len(shape) == 2:
        shape = [1, *shape]
    return write_bos(pack_dir, values, shape)


def _write_model_card(pack_dir: Path, spec: dict[str, Any], sources: dict[str, Any]) -> None:
    card = (
        f"# {spec['display_name']}\n\n"
        f"Converted by Aurora from official Kyutai PocketTTS "
        f"`{spec['kyutai_config']}`.\n\n"
        f"- Weights: `{spec['weights']['repo_id']}` ({spec['weights']['license']})\n"
        f"- Tokenizer: `{spec['tokenizer']['repo_id']}` ({spec['tokenizer']['license']})\n"
        f"- Kyutai source: {sources['kyutai_source']['repository']} "
        f"{sources['kyutai_source']['tag']}\n"
        "- Do not commit this directory or its archive.\n"
    )
    (pack_dir / "README.md").write_text(card, encoding="utf-8")


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", required=True)
    parser.add_argument("--cache-root", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = _args()
    report = convert_pack(args.pack, cache_root=args.cache_root, dry_run=args.dry_run)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(report["pack_id"], report.get("archive", report["cache_dir"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

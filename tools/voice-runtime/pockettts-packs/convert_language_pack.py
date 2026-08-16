#!/usr/bin/env python3
"""Convert official Kyutai PocketTTS language packs for Sherpa.

Downloads happen on demand into .artifacts/. Weights are never committed.
This path does not modify the Python PocketTTS provider.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
SOURCES_PATH = Path(__file__).resolve().parent / "language_pack_sources.json"
DEFAULT_CACHE = REPO_ROOT / ".artifacts/pockettts/language-packs"
REPRODUCIBLE_TAR_MTIME = 0
REPRODUCIBLE_TAR_UID = 0
REPRODUCIBLE_TAR_GID = 0
REPRODUCIBLE_TAR_UNAME = ""
REPRODUCIBLE_TAR_GNAME = ""
REPRODUCIBLE_TAR_FILE_MODE = 0o644
REPRODUCIBLE_TAR_DIR_MODE = 0o755


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
    members = _sorted_archive_paths(pack_dir)
    with tarfile.open(
        archive,
        mode="w:bz2",
        format=tarfile.GNU_FORMAT,
        compresslevel=9,
    ) as tar:
        for path in members:
            arcname = path.relative_to(pack_dir.parent).as_posix()
            info = tar.gettarinfo(str(path), arcname=arcname)
            info.uid = REPRODUCIBLE_TAR_UID
            info.gid = REPRODUCIBLE_TAR_GID
            info.uname = REPRODUCIBLE_TAR_UNAME
            info.gname = REPRODUCIBLE_TAR_GNAME
            info.mtime = REPRODUCIBLE_TAR_MTIME
            info.pax_headers = {}
            if info.isdir():
                info.mode = REPRODUCIBLE_TAR_DIR_MODE
                tar.addfile(info)
                continue
            if not info.isfile():
                raise ConversionError(f"refusing non-regular pack member {arcname}")
            info.mode = REPRODUCIBLE_TAR_FILE_MODE
            with path.open("rb") as handle:
                tar.addfile(info, handle)
    return {
        "filename": archive.name,
        "sha256": sha256_file(archive),
        "byte_size": archive.stat().st_size,
        "root": pack_dir.name,
    }


def _sorted_archive_paths(pack_dir: Path) -> list[Path]:
    members = [pack_dir]
    for path in pack_dir.rglob("*"):
        if ".git" in path.parts:
            continue
        members.append(path)
    members.sort(key=lambda item: item.relative_to(pack_dir.parent).as_posix())
    return members


def write_internal_reference(
    pack_dir: Path, sample_rate: int = 24_000, seconds: float = 0.5
) -> Path:
    import math
    import struct
    import wave

    path = pack_dir / "internal_reference.wav"
    frames = int(sample_rate * seconds)
    with wave.open(str(path), "w") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        payload = bytearray()
        for index in range(frames):
            sample = int(8_000 * math.sin(2 * math.pi * 220 * index / sample_rate))
            payload.extend(struct.pack("<h", sample))
        wav.writeframes(payload)
    return path


def write_capability(pack_dir: Path, spec: dict[str, Any], source_mode: str) -> dict[str, Any]:
    weights = spec["weights"]
    if source_mode == "gated":
        payload = {
            "reference_audio_mode": "profile",
            "voice_cloning": True,
            "source_repo": weights.get("gated_clone_repo_id", "kyutai/pocket-tts"),
            "source_revision": weights.get("gated_clone_revision", ""),
            "license": weights.get("gated_clone_license", "cc-by-4.0-extra-gated"),
            "encoder_status": "intact",
            "source_mode": "gated",
        }
    else:
        payload = {
            "reference_audio_mode": "internal",
            "voice_cloning": False,
            "source_repo": weights["repo_id"],
            "source_revision": weights["revision"],
            "license": weights["license"],
            "encoder_status": weights.get(
                "encoder_status", "zeroed_by_remove_voice_cloning_and_push"
            ),
            "source_mode": "public-fixed-voice",
        }
    (pack_dir / "capability.json").write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return payload


def convert_pack(
    pack_id: str,
    *,
    cache_root: Path = DEFAULT_CACHE,
    dry_run: bool = False,
    allow_unoptimized: bool = False,
    weights_source: str | None = None,
) -> dict[str, Any]:
    sources = load_sources()
    spec = pack_spec(sources, pack_id)
    source_mode = weights_source or spec["weights"].get("source_mode", "public-fixed-voice")
    if source_mode not in {"public-fixed-voice", "gated"}:
        raise ConversionError(f"unknown weights source {source_mode}")
    pack_dir = cache_root / spec["pack_id"]
    report = {
        "pack_id": spec["pack_id"],
        "voice_id": spec["voice_id"],
        "language": spec["language"],
        "kyutai_config": spec["kyutai_config"],
        "weights": spec["weights"],
        "tokenizer": spec["tokenizer"],
        "protocol": spec["protocol"],
        "weights_source": source_mode,
        "cache_dir": str(pack_dir),
        "dry_run": dry_run,
    }
    if dry_run:
        return report
    pack_dir.mkdir(parents=True, exist_ok=True)
    helper_pin = export_helper_pin(sources)
    helper = _ensure_export_helper(cache_root / "export-helper", sources)
    report["export_helper"] = str(helper)
    report["export_helper_repository"] = helper_pin["repository"]
    report["export_helper_commit"] = helper_pin["commit"]
    _run_official_export(helper, spec, pack_dir, source_mode)
    _ensure_sherpa_tokenizer(pack_dir)
    _inline_pack_onnx(pack_dir, helper / "onnx")
    bos = _extract_bos(spec["kyutai_config"], pack_dir)
    write_protocol(pack_dir, spec["protocol"], bos)
    write_internal_reference(pack_dir)
    report["capability"] = write_capability(pack_dir, spec, source_mode)
    _write_model_card(pack_dir, spec, sources, source_mode)
    try:
        report["graph_opt"] = optimize_onnx_files(pack_dir)
    except Exception as exc:
        if not allow_unoptimized:
            raise ConversionError(f"graph optimization failed: {exc}") from exc
        report["graph_opt_error"] = str(exc)
        report["unoptimized"] = True
    archive = cache_root / f"{spec['pack_id']}.tar.bz2"
    report["archive"] = archive_pack(pack_dir, archive)
    (pack_dir / "conversion_manifest.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return report


def export_helper_pin(sources: dict[str, Any] | None = None) -> dict[str, str]:
    payload = sources if sources is not None else load_sources()
    helper = payload.get("export_helper") or {}
    repository = str(helper.get("repository") or "").strip()
    commit = str(helper.get("commit") or "").strip().lower()
    if not repository or len(commit) != 40 or any(ch not in "0123456789abcdef" for ch in commit):
        raise ConversionError("export helper repository and full commit pin are required")
    return {"repository": repository, "commit": commit}


def _normalize_git_url(url: str) -> str:
    value = url.strip().rstrip("/")
    if value.endswith(".git"):
        value = value[: -len(".git")]
    if value.startswith("git@github.com:"):
        value = "https://github.com/" + value[len("git@github.com:") :]
    return value.lower()


def _run_git(*args: str, cwd: Path | None = None) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip() or f"git {' '.join(args)} failed"
        raise ConversionError(detail)
    return result.stdout.strip()


def _helper_source_matches_pin(source: Path, repository: str, commit: str) -> bool:
    try:
        if not (source / ".git").is_dir() or not (source / "export.py").is_file():
            return False
        _verify_pinned_checkout(source, repository, commit)
        return True
    except ConversionError:
        return False


def _configure_origin(source: Path, repository: str) -> None:
    remotes = [line.strip() for line in _run_git("remote", cwd=source).splitlines() if line.strip()]
    if "origin" in remotes:
        _run_git("remote", "set-url", "origin", repository, cwd=source)
    else:
        _run_git("remote", "add", "origin", repository, cwd=source)


def _verify_pinned_checkout(source: Path, repository: str, commit: str) -> None:
    head = _run_git("rev-parse", "HEAD", cwd=source).lower()
    if head != commit.lower():
        raise ConversionError(f"export helper HEAD {head} != pin {commit}")
    origin = _run_git("remote", "get-url", "origin", cwd=source)
    if _normalize_git_url(origin) != _normalize_git_url(repository):
        raise ConversionError(f"export helper origin {origin} != {repository}")
    if _run_git("status", "--porcelain", cwd=source) != "":
        raise ConversionError("export helper checkout is dirty")


def _fetch_pinned_helper_source(source: Path, repository: str, commit: str) -> None:
    source.mkdir(parents=True, exist_ok=True)
    _run_git("init", cwd=source)
    _configure_origin(source, repository)
    try:
        _run_git("fetch", "--depth", "1", "origin", commit, cwd=source)
    except ConversionError as exc:
        raise ConversionError(f"pinned export helper {commit} is unavailable from origin") from exc
    _run_git("checkout", "--detach", "FETCH_HEAD", cwd=source)
    _verify_pinned_checkout(source, repository, commit)


def _ensure_pinned_helper_source(source: Path, repository: str, commit: str) -> None:
    if _helper_source_matches_pin(source, repository, commit):
        return
    if source.exists():
        shutil.rmtree(source)
    _fetch_pinned_helper_source(source, repository, commit)
    if not _helper_source_matches_pin(source, repository, commit):
        raise ConversionError("export helper source is not a clean checkout of the pinned commit")


def _stage_clean_helper(source: Path, dest: Path) -> Path:
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, dest, ignore=shutil.ignore_patterns(".git"))
    if not (dest / "export.py").is_file():
        raise ConversionError("staged export helper is missing export.py")
    return dest


def _ensure_export_helper(dest: Path, sources: dict[str, Any] | None = None) -> Path:
    pin = export_helper_pin(sources)
    source = dest.parent / "export-helper-src"
    _ensure_pinned_helper_source(source, pin["repository"], pin["commit"])
    return _stage_clean_helper(source, dest)


def _export_python() -> str:
    venv = REPO_ROOT / ".artifacts/pockettts/export-venv/bin/python"
    return str(venv) if venv.is_file() else sys.executable


def _run_official_export(
    helper: Path, spec: dict[str, Any], pack_dir: Path, source_mode: str
) -> None:
    cmd = [
        _export_python(),
        str(Path(__file__).with_name("run_official_export.py")),
        "--helper",
        str(helper),
        "--language",
        spec["kyutai_config"],
        "--output",
        str(pack_dir),
        "--weights-source",
        source_mode,
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


def _write_model_card(
    pack_dir: Path, spec: dict[str, Any], sources: dict[str, Any], source_mode: str
) -> None:
    weights = spec["weights"]
    if source_mode == "gated":
        repo = weights.get("gated_clone_repo_id", "kyutai/pocket-tts")
        revision = weights.get("gated_clone_revision", "")
        license_name = weights.get("gated_clone_license", "cc-by-4.0-extra-gated")
        mode = "profile"
    else:
        repo = weights["repo_id"]
        revision = weights["revision"]
        license_name = weights["license"]
        mode = "internal"
    card = (
        f"# {spec['display_name']}\n\n"
        f"Converted by Aurora from official Kyutai PocketTTS "
        f"`{spec['kyutai_config']}`.\n\n"
        f"- Weights: `{repo}` @ `{revision}` ({license_name})\n"
        f"- Tokenizer: `{spec['tokenizer']['repo_id']}` @ "
        f"`{spec['tokenizer']['revision']}` ({spec['tokenizer']['license']})\n"
        f"- Attribution: Kyutai PocketTTS, {license_name}.\n"
        f"- Reference audio mode: `{mode}`\n"
        f"- Kyutai source: {sources['kyutai_source']['repository']} "
        f"{sources['kyutai_source']['tag']}\n"
        "- Do not commit this directory or its archive.\n"
    )
    if ".artifacts" in card or "export-venv" in card or "HF_TOKEN" in card:
        raise ConversionError("model card leaked a local builder path")
    (pack_dir / "README.md").write_text(card, encoding="utf-8")


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", required=True)
    parser.add_argument("--cache-root", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--allow-unoptimized", action="store_true")
    parser.add_argument(
        "--weights-source",
        choices=("public-fixed-voice", "gated"),
        default=None,
    )
    return parser.parse_args()


def main() -> int:
    args = _args()
    report = convert_pack(
        args.pack,
        cache_root=args.cache_root,
        dry_run=args.dry_run,
        allow_unoptimized=args.allow_unoptimized,
        weights_source=args.weights_source,
    )
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(report["pack_id"], report.get("archive", report["cache_dir"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

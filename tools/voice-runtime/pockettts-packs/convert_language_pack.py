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
import tarfile
import tempfile
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
RUNTIME_ONNX_FILES = (
    "decoder.int8.onnx",
    "encoder.onnx",
    "lm_flow.int8.onnx",
    "lm_main.int8.onnx",
    "text_conditioner.onnx",
)
RUNTIME_COMMON_FILES = (
    *RUNTIME_ONNX_FILES,
    "vocab.json",
    "token_scores.json",
    "pocket_protocol.json",
    "bos_before_voice.bin",
    "README.md",
    "capability.json",
)


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


def write_protocol(
    pack_dir: Path,
    protocol: dict[str, Any],
    bos_path: Path,
    fixed_voice_state: dict[str, Any] | None,
) -> None:
    payload = dict(protocol)
    # String form is required: nlohmann json.value(..., std::string())
    # throws if this key is an object, which aborts the native Sherpa process.
    payload["bos_before_voice"] = bos_path.name
    if fixed_voice_state is not None:
        payload["fixed_voice_state"] = fixed_voice_state
    (pack_dir / "pocket_protocol.json").write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def write_bos(pack_dir: Path, values: list[float], shape: list[int]) -> Path:
    import struct

    path = pack_dir / "bos_before_voice.bin"
    path.write_bytes(struct.pack(f"<{len(values)}f", *values))
    expected = 1
    for dim in shape:
        expected *= dim
    if expected != len(values):
        raise ConversionError("bos_before_voice shape does not match values")
    return path


def optimize_onnx_files(pack_dir: Path) -> dict[str, Any]:
    optimizer_path = Path(__file__).with_name("optimize_onnx_graph.py")
    stats: dict[str, Any] = {}
    for name in RUNTIME_ONNX_FILES:
        path = pack_dir / name
        if not path.is_file():
            raise ConversionError(f"runtime graph {name} is missing before optimization")
        stats[path.name] = _run_optimize_onnx(optimizer_path, path)
    return stats


def _run_optimize_onnx(optimizer_path: Path, model: Path) -> dict[str, int]:
    result = subprocess.run(
        [_export_python(), str(optimizer_path), str(model)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        suffix = f": {detail[-2_000:]}" if detail else ""
        raise ConversionError(f"failed to optimize ONNX graph {model.name}{suffix}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ConversionError(
            f"optimizer returned invalid JSON for ONNX graph {model.name}"
        ) from exc
    expected = {"removed_identity", "deduplicated_initializers"}
    if (
        not isinstance(payload, dict)
        or set(payload) != expected
        or any(
            not isinstance(payload[key], int) or isinstance(payload[key], bool) or payload[key] < 0
            for key in expected
        )
    ):
        raise ConversionError(f"optimizer returned invalid stats for ONNX graph {model.name}")
    return payload


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


def _runtime_file_names(source_mode: str) -> tuple[str, ...]:
    if source_mode == "public-fixed-voice":
        return (*RUNTIME_COMMON_FILES, "fixed_voice_state.bin")
    if source_mode == "gated":
        return RUNTIME_COMMON_FILES
    raise ConversionError(f"unknown weights source {source_mode}")


def _stage_runtime_pack(source: Path, dest: Path, source_mode: str) -> tuple[str, ...]:
    expected = _runtime_file_names(source_mode)
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    for name in expected:
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise ConversionError(f"required runtime pack file {name} is missing")
        shutil.copy2(path, dest / name)
    actual = tuple(sorted(path.name for path in dest.iterdir()))
    if actual != tuple(sorted(expected)):
        raise ConversionError("runtime pack staging closure is not exact")
    return expected


def _load_fixed_voice_metadata(export_dir: Path) -> dict[str, Any]:
    metadata_path = export_dir / "fixed_voice_state.json"
    state_path = export_dir / "fixed_voice_state.bin"
    if not metadata_path.is_file() or not state_path.is_file():
        raise ConversionError("public pack export is missing fixed voice state")
    payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    expected_keys = {
        "schema_version",
        "file",
        "dtype",
        "layers",
        "frames",
        "heads",
        "head_dim",
        "byte_size",
        "sha256",
    }
    if set(payload) != expected_keys:
        raise ConversionError("fixed voice state metadata fields are invalid")
    if payload["schema_version"] != 1 or payload["file"] != state_path.name:
        raise ConversionError("fixed voice state metadata identity is invalid")
    if payload["dtype"] != "float32-le":
        raise ConversionError("fixed voice state dtype must be float32-le")
    dimensions = tuple(payload[name] for name in ("layers", "frames", "heads", "head_dim"))
    if any(
        not isinstance(value, int) or isinstance(value, bool) or value <= 0 for value in dimensions
    ):
        raise ConversionError("fixed voice state dimensions must be positive integers")
    layers, frames, heads, head_dim = dimensions
    expected_size = layers * 2 * frames * heads * head_dim * 4
    if payload["byte_size"] != expected_size or state_path.stat().st_size != expected_size:
        raise ConversionError("fixed voice state byte size is inconsistent")
    sha256 = payload["sha256"]
    if (
        not isinstance(sha256, str)
        or len(sha256) != 64
        or any(ch not in "0123456789abcdef" for ch in sha256)
        or sha256_file(state_path) != sha256
    ):
        raise ConversionError("fixed voice state checksum is invalid")
    return payload


def _require_exported_bos(export_dir: Path) -> Path:
    path = export_dir / "bos_before_voice.bin"
    if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
        raise ConversionError("official export did not produce bos_before_voice.bin")
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
    cache_root.mkdir(parents=True, exist_ok=True)
    helper_pin = export_helper_pin(sources)
    helper = _ensure_export_helper(cache_root / "export-helper", sources)
    kyutai_pin = kyutai_source_pin(sources)
    kyutai_source = _ensure_pinned_kyutai_source(
        cache_root / "kyutai-pocket-tts-src",
        kyutai_pin["repository"],
        kyutai_pin["commit"],
    )
    report["export_helper"] = str(helper)
    report["export_helper_repository"] = helper_pin["repository"]
    report["export_helper_commit"] = helper_pin["commit"]
    report["kyutai_source_repository"] = kyutai_pin["repository"]
    report["kyutai_source_commit"] = kyutai_pin["commit"]
    with tempfile.TemporaryDirectory(prefix=f".{spec['pack_id']}-", dir=cache_root) as temp:
        work_root = Path(temp)
        export_dir = work_root / "export"
        staged_pack = work_root / spec["pack_id"]
        export_dir.mkdir()
        _run_official_export(
            helper,
            spec,
            export_dir,
            source_mode,
            sources_path=SOURCES_PATH,
            kyutai_source=kyutai_source,
            cache_root=cache_root / "hf-cache",
        )
        _ensure_sherpa_tokenizer(export_dir)
        _inline_pack_onnx(export_dir, helper / "onnx")
        bos = _require_exported_bos(export_dir)
        fixed_voice_state = (
            _load_fixed_voice_metadata(export_dir) if source_mode == "public-fixed-voice" else None
        )
        write_protocol(export_dir, spec["protocol"], bos, fixed_voice_state)
        report["capability"] = write_capability(export_dir, spec, source_mode)
        _write_model_card(export_dir, spec, sources, source_mode)
        try:
            report["graph_opt"] = optimize_onnx_files(export_dir)
        except Exception as exc:
            raise ConversionError(f"graph optimization failed: {exc}") from exc
        report["runtime_files"] = list(_stage_runtime_pack(export_dir, staged_pack, source_mode))
        temp_archive = work_root / f"{spec['pack_id']}.tar.bz2"
        report["archive"] = archive_pack(staged_pack, temp_archive)
        final_archive = cache_root / temp_archive.name
        if pack_dir.exists():
            shutil.rmtree(pack_dir)
        shutil.move(str(staged_pack), str(pack_dir))
        temp_archive.replace(final_archive)
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


def kyutai_source_pin(sources: dict[str, Any] | None = None) -> dict[str, str]:
    payload = sources if sources is not None else load_sources()
    source = payload.get("kyutai_source") or {}
    repository = str(source.get("repository") or "").strip()
    commit = str(source.get("commit") or "").strip().lower()
    if not repository or len(commit) != 40 or any(ch not in "0123456789abcdef" for ch in commit):
        raise ConversionError("Kyutai source repository and full commit pin are required")
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


def _verify_pinned_kyutai_source(source: Path, repository: str, commit: str) -> None:
    if not (source / ".git").is_dir():
        raise ConversionError("pinned Kyutai source is not a git checkout")
    head = _run_git("rev-parse", "HEAD", cwd=source).lower()
    if head != commit.lower():
        raise ConversionError(f"Kyutai source HEAD {head} != pin {commit}")
    origin = _run_git("remote", "get-url", "origin", cwd=source)
    if _normalize_git_url(origin) != _normalize_git_url(repository):
        raise ConversionError(f"Kyutai source origin {origin} != {repository}")
    if _run_git("status", "--porcelain", cwd=source) != "":
        raise ConversionError("pinned Kyutai source checkout is dirty")
    if not (source / "pocket_tts/config/french_24l.yaml").is_file():
        raise ConversionError("pinned Kyutai source is missing multilingual configs")


def _kyutai_source_matches_pin(source: Path, repository: str, commit: str) -> bool:
    try:
        _verify_pinned_kyutai_source(source, repository, commit)
        return True
    except ConversionError:
        return False


def _fetch_pinned_kyutai_source(source: Path, repository: str, commit: str) -> None:
    source.mkdir(parents=True, exist_ok=True)
    _run_git("init", cwd=source)
    _configure_origin(source, repository)
    try:
        _run_git("fetch", "--depth", "1", "origin", commit, cwd=source)
    except ConversionError as exc:
        raise ConversionError(f"pinned Kyutai source {commit} is unavailable from origin") from exc
    _run_git("checkout", "--detach", "FETCH_HEAD", cwd=source)
    _verify_pinned_kyutai_source(source, repository, commit)


def _ensure_pinned_kyutai_source(source: Path, repository: str, commit: str) -> Path:
    if _kyutai_source_matches_pin(source, repository, commit):
        return source
    if source.exists():
        shutil.rmtree(source)
    _fetch_pinned_kyutai_source(source, repository, commit)
    if not _kyutai_source_matches_pin(source, repository, commit):
        raise ConversionError("Kyutai source is not a clean checkout of the pinned commit")
    return source


def _export_python() -> str:
    venv = REPO_ROOT / ".artifacts/pockettts/export-venv/bin/python"
    if not venv.is_file():
        raise ConversionError(
            "pinned PocketTTS export environment is missing; provision "
            ".artifacts/pockettts/export-venv before conversion"
        )
    return str(venv)


def _run_official_export(
    helper: Path,
    spec: dict[str, Any],
    pack_dir: Path,
    source_mode: str,
    *,
    sources_path: Path,
    kyutai_source: Path,
    cache_root: Path,
) -> None:
    cmd = [
        _export_python(),
        str(Path(__file__).with_name("run_official_export.py")),
        "--helper",
        str(helper),
        "--sources",
        str(sources_path),
        "--pack",
        spec["pack_id"],
        "--kyutai-source",
        str(kyutai_source),
        "--cache-root",
        str(cache_root),
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
    export_path = Path(__file__).with_name("run_official_export.py")
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
            _run_inline_onnx(export_path, src, dest)
        elif dest.is_file():
            _run_inline_onnx(export_path, dest, dest)


def _run_inline_onnx(export_path: Path, source: Path, output: Path) -> None:
    result = subprocess.run(
        [
            _export_python(),
            str(export_path),
            "--inline-source",
            str(source),
            "--inline-output",
            str(output),
        ],
        check=False,
    )
    if result.returncode != 0:
        raise ConversionError(f"failed to inline ONNX graph {source.name}")


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
        weights_source=args.weights_source,
    )
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(report["pack_id"], report.get("archive", report["cache_dir"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

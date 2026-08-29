#!/usr/bin/env python3
"""Stage a neutral Sherpa browser engine release without model payloads."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from collections.abc import Iterable
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
MANIFEST_PATH = REPO_ROOT / "tools/voice-runtime/phase4_manifest.json"
DEFAULT_OUTPUT_ROOT = REPO_ROOT / ".artifacts/voice-runtime/browser-engine-release"
SHERPA_SOURCE_ID = "sherpa-onnx-source-v1.13.5"

FORBIDDEN_SUFFIXES = {
    ".bin",
    ".bz2",
    ".data",
    ".emb",
    ".fst",
    ".model",
    ".npy",
    ".onnx",
    ".ort",
    ".pt",
    ".safetensors",
    ".tar",
    ".tgz",
    ".wav",
    ".zip",
}
FORBIDDEN_NAME_PARTS = (
    "bpe.model",
    "tokens.txt",
    "test_wavs",
    "model",
    "voice",
)


@dataclass(frozen=True)
class EngineAsset:
    task: str
    filename: str
    source_candidates: tuple[Path, ...]


ASSETS: tuple[EngineAsset, ...] = (
    EngineAsset(
        "vad-stt",
        "sherpa-onnx-wasm-main-vad-asr.js",
        (
            Path(
                "build-wasm-simd-vad-asr/install/bin/wasm/vad-asr/sherpa-onnx-wasm-main-vad-asr.js"
            ),
            Path("build-wasm-simd-vad-asr/bin/sherpa-onnx-wasm-main-vad-asr.js"),
        ),
    ),
    EngineAsset(
        "vad-stt",
        "sherpa-onnx-wasm-main-vad-asr.wasm",
        (
            Path(
                "build-wasm-simd-vad-asr/install/bin/wasm/vad-asr/sherpa-onnx-wasm-main-vad-asr.wasm"
            ),
            Path("build-wasm-simd-vad-asr/bin/sherpa-onnx-wasm-main-vad-asr.wasm"),
        ),
    ),
    EngineAsset(
        "vad-stt",
        "sherpa-onnx-vad.js",
        (
            Path("build-wasm-simd-vad-asr/install/bin/wasm/vad-asr/sherpa-onnx-vad.js"),
            Path("wasm/vad/sherpa-onnx-vad.js"),
        ),
    ),
    EngineAsset(
        "vad-stt",
        "sherpa-onnx-asr.js",
        (
            Path("build-wasm-simd-vad-asr/install/bin/wasm/vad-asr/sherpa-onnx-asr.js"),
            Path("wasm/asr/sherpa-onnx-asr.js"),
        ),
    ),
    EngineAsset(
        "kws",
        "sherpa-onnx-wasm-kws-main.js",
        (
            Path("build-wasm-simd-kws/install/bin/wasm/sherpa-onnx-wasm-kws-main.js"),
            Path("build-wasm-simd-kws/bin/sherpa-onnx-wasm-kws-main.js"),
        ),
    ),
    EngineAsset(
        "kws",
        "sherpa-onnx-wasm-kws-main.wasm",
        (
            Path("build-wasm-simd-kws/install/bin/wasm/sherpa-onnx-wasm-kws-main.wasm"),
            Path("build-wasm-simd-kws/bin/sherpa-onnx-wasm-kws-main.wasm"),
        ),
    ),
    EngineAsset(
        "kws",
        "sherpa-onnx-kws.js",
        (
            Path("build-wasm-simd-kws/install/bin/wasm/sherpa-onnx-kws.js"),
            Path("wasm/kws/sherpa-onnx-kws.js"),
        ),
    ),
    EngineAsset(
        "tts",
        "sherpa-onnx-wasm-main-tts.js",
        (Path("sherpa-onnx-wasm-main-tts.js"), Path("wasm/tts/sherpa-onnx-wasm-main-tts.js")),
    ),
    EngineAsset(
        "tts",
        "sherpa-onnx-wasm-main-tts.wasm",
        (Path("sherpa-onnx-wasm-main-tts.wasm"), Path("wasm/tts/sherpa-onnx-wasm-main-tts.wasm")),
    ),
    EngineAsset(
        "tts",
        "sherpa-onnx-tts.js",
        (Path("sherpa-onnx-tts.js"), Path("wasm/tts/sherpa-onnx-tts.js")),
    ),
    EngineAsset(
        "tts",
        "sherpa-onnx-tts.worker.js",
        (Path("sherpa-onnx-tts.worker.js"), Path("wasm/tts/sherpa-onnx-tts.worker.js")),
    ),
)


class ReleaseError(RuntimeError):
    """Raised for invalid release inputs or outputs."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=MANIFEST_PATH)
    parser.add_argument(
        "--artifact-root",
        type=Path,
        default=Path(os.environ["AURORA_VOICE_P4_ARTIFACT_ROOT"])
        if os.environ.get("AURORA_VOICE_P4_ARTIFACT_ROOT")
        else None,
        help="Phase 4 artifact root containing the pinned source archive.",
    )
    parser.add_argument(
        "--source-root",
        type=Path,
        help="Extracted sherpa-onnx v1.13.5 tree with neutral WASM build outputs.",
    )
    parser.add_argument(
        "--tts-artifact-root",
        type=Path,
        help="Optional neutral TTS WASM output root when TTS was built separately.",
    )
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument(
        "--download-source",
        action="store_true",
        help="Download the pinned Sherpa source archive if it is missing.",
    )
    parser.add_argument(
        "--build",
        action="store_true",
        help="Run upstream neutral WASM builds before staging when emcmake is available.",
    )
    parser.add_argument(
        "--skip-stage",
        action="store_true",
        help="Only verify source identity and optional build prerequisites.",
    )
    return parser


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def selected_artifact(manifest: dict[str, Any], artifact_id: str) -> dict[str, Any]:
    for artifact in manifest.get("artifacts", []):
        if artifact.get("id") == artifact_id and artifact.get("status") == "selected":
            return artifact
    raise ReleaseError(f"missing selected artifact {artifact_id}")


def archive_path(artifact_root: Path | None, artifact: dict[str, Any]) -> Path | None:
    if artifact_root is None:
        return None
    return artifact_root / str(artifact["archive_path"])


def ensure_source_archive(
    artifact_root: Path | None, artifact: dict[str, Any], download: bool
) -> Path | None:
    archive = archive_path(artifact_root, artifact)
    if archive is None:
        return None
    if not archive.exists() and download:
        archive.parent.mkdir(parents=True, exist_ok=True)
        with (
            urllib.request.urlopen(str(artifact["url"]), timeout=120) as response,
            archive.open("wb") as output,
        ):
            shutil.copyfileobj(response, output)
    if not archive.exists():
        return None
    actual_size = archive.stat().st_size
    expected_size = int(artifact["size_bytes"])
    if actual_size != expected_size:
        raise ReleaseError(f"{archive} has size {actual_size}, expected {expected_size}")
    actual_sha = sha256_file(archive)
    if actual_sha != artifact["sha256"]:
        raise ReleaseError(f"{archive} has sha256 {actual_sha}, expected {artifact['sha256']}")
    return archive


def _extract_pinned_source_tar(archive: Path, dest: Path, *, mode: str) -> None:
    from importlib.util import module_from_spec, spec_from_file_location

    helper = Path(__file__).resolve().parents[1] / "sherpa-patches" / "apply_sherpa_patches.py"
    spec = spec_from_file_location("aurora_apply_sherpa_patches", helper)
    if spec is None or spec.loader is None:
        raise ReleaseError("unable to load pinned source extractor")
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    # The archive digest/size were verified before this call. Omit the two
    # stale absolute symlinks in upstream's unused Go example; never extract
    # an entry whose target escapes the staging root.
    module.extract_pinned_source_tar(
        archive,
        dest,
        mode=mode,
        omit_escaping_symlinks=True,
    )


def extract_source_archive(archive: Path, staging_root: Path) -> Path:
    """Extract verified sources into a build-only root outside release output."""

    source_root = staging_root / "sherpa-onnx-1.13.5"
    if source_root.exists():
        return source_root
    with tempfile.TemporaryDirectory(prefix="aurora-sherpa-src-") as tmp_name:
        tmp = Path(tmp_name)
        _extract_pinned_source_tar(archive, tmp, mode="r:gz")
        extracted = tmp / "sherpa-onnx-1.13.5"
        if not extracted.is_dir():
            raise ReleaseError("source archive did not extract sherpa-onnx-1.13.5")
        source_root.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(extracted), source_root)
    return source_root


def run_build(source_root: Path) -> list[dict[str, Any]]:
    emcmake = shutil.which("emcmake")
    cmake = shutil.which("cmake")
    make = shutil.which("make")
    if not emcmake:
        return [{"status": "skipped", "reason": "emcmake not found on PATH"}]
    if not cmake or not make:
        return [{"status": "skipped", "reason": "cmake or make not found on PATH"}]

    build_steps = [
        {
            "task": "vad-stt",
            "build_dir": source_root / "build-wasm-simd-vad-asr",
            "cmake_args": [
                "-DSHERPA_ONNX_ENABLE_WASM=ON",
                "-DSHERPA_ONNX_ENABLE_WASM_VAD_ASR=ON",
                "-DSHERPA_ONNX_ENABLE_WASM_KWS=OFF",
                "-DSHERPA_ONNX_ENABLE_WASM_TTS=OFF",
                "-DSHERPA_ONNX_ENABLE_BINARY=OFF",
                "-DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF",
                "-DSHERPA_ONNX_ENABLE_PYTHON=OFF",
                "-DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=OFF",
                "-DSHERPA_ONNX_ENABLE_TESTS=OFF",
                "-DSHERPA_ONNX_ENABLE_TTS=OFF",
                "-DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF",
                "-DSHERPA_ONNX_ENABLE_CHECK=OFF",
                "-DCMAKE_BUILD_TYPE=Release",
            ],
        },
        {
            "task": "kws",
            "build_dir": source_root / "build-wasm-simd-kws",
            "cmake_args": [
                "-DSHERPA_ONNX_ENABLE_WASM=ON",
                "-DSHERPA_ONNX_ENABLE_WASM_KWS=ON",
                "-DSHERPA_ONNX_ENABLE_WASM_VAD_ASR=OFF",
                "-DSHERPA_ONNX_ENABLE_WASM_TTS=OFF",
                "-DSHERPA_ONNX_ENABLE_BINARY=OFF",
                "-DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF",
                "-DSHERPA_ONNX_ENABLE_PYTHON=OFF",
                "-DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=OFF",
                "-DSHERPA_ONNX_ENABLE_TESTS=OFF",
                "-DSHERPA_ONNX_ENABLE_TTS=OFF",
                "-DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF",
                "-DSHERPA_ONNX_ENABLE_CHECK=OFF",
                "-DCMAKE_BUILD_TYPE=Release",
            ],
        },
    ]
    reports: list[dict[str, Any]] = []
    build_env = os.environ.copy()
    build_env["AURORA_SHERPA_WASM_ENGINE_NEUTRAL"] = "1"
    for step in build_steps:
        build_dir = Path(step["build_dir"])
        build_dir.mkdir(parents=True, exist_ok=True)
        configure = [
            emcmake,
            cmake,
            "-S",
            str(source_root),
            "-B",
            str(build_dir),
            f"-DCMAKE_INSTALL_PREFIX={build_dir / 'install'}",
            *step["cmake_args"],
        ]
        build = [cmake, "--build", str(build_dir), "--target", "install", "--parallel"]
        for command in (configure, build):
            result = subprocess.run(
                command,
                cwd=source_root,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
                env=build_env,
            )
            reports.append(
                {
                    "task": step["task"],
                    "command": command,
                    "returncode": result.returncode,
                    "output_tail": result.stdout[-4000:],
                }
            )
            if result.returncode != 0:
                output_tail = result.stdout[-4000:].strip()
                raise ReleaseError(
                    f"build failed for {step['task']}: {' '.join(command)}\n{output_tail}"
                )
    return reports


def is_forbidden_release_path(path: Path) -> bool:
    lowered = path.name.lower()
    if path.suffix.lower() in FORBIDDEN_SUFFIXES:
        return True
    return any(part in lowered for part in FORBIDDEN_NAME_PARTS)


def resolve_asset(asset: EngineAsset, source_root: Path, tts_root: Path | None) -> Path:
    roots = [tts_root, source_root] if asset.task == "tts" and tts_root else [source_root]
    for root in roots:
        if root is None:
            continue
        for candidate in asset.source_candidates:
            path = root / candidate
            if path.is_file():
                return path
    searched = ", ".join(str(candidate) for candidate in asset.source_candidates)
    raise ReleaseError(f"missing {asset.task} asset {asset.filename}; searched {searched}")


def copy_assets(
    source_root: Path, tts_root: Path | None, output_root: Path
) -> list[dict[str, Any]]:
    asset_root = output_root / "assets"
    if asset_root.exists():
        shutil.rmtree(asset_root)
    copied: list[dict[str, Any]] = []
    for asset in ASSETS:
        if is_forbidden_release_path(Path(asset.filename)):
            raise ReleaseError(f"refusing forbidden release asset name {asset.filename}")
        src = resolve_asset(asset, source_root, tts_root)
        dest = asset_root / asset.task / asset.filename
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        copied.append(
            {
                "task": asset.task,
                "filename": asset.filename,
                "size_bytes": dest.stat().st_size,
                "sha256": sha256_file(dest),
                "source": str(src),
            }
        )
    return sorted(copied, key=lambda item: (item["task"], item["filename"]))


def validate_release_tree(output_root: Path) -> list[str]:
    failures: list[str] = []
    for path in output_root.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(output_root)
        if relative.parts and relative.parts[0] in {"reports"}:
            continue
        if is_forbidden_release_path(path):
            failures.append(str(relative))
    return failures


def write_provenance(
    output_root: Path,
    manifest: dict[str, Any],
    source_artifact: dict[str, Any],
    source_archive: Path | None,
    source_root: Path | None,
    copied: list[dict[str, Any]],
    build_reports: list[dict[str, Any]],
) -> Path:
    git_head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, text=True, stdout=subprocess.PIPE, check=False
    ).stdout.strip()
    report = {
        "schema_version": 1,
        "release_kind": "neutral-sherpa-browser-engine",
        "repo_head": git_head,
        "phase4_manifest": {
            "path": str(MANIFEST_PATH.relative_to(REPO_ROOT)),
            "name": manifest.get("name"),
            "plan_sha256": manifest.get("plan_sha256"),
        },
        "source": {
            "id": source_artifact["id"],
            "url": source_artifact["url"],
            "version": source_artifact["version"],
            "commit": source_artifact.get("commit"),
            "sha256": source_artifact["sha256"],
            "archive": str(source_archive) if source_archive else None,
            "archive_verified": bool(source_archive),
            "source_root": str(source_root) if source_root else None,
        },
        "policy": {
            "payload": "engine-code-only",
            "contains_model_weights": False,
            "forbidden_suffixes": sorted(FORBIDDEN_SUFFIXES),
            "forbidden_name_parts": sorted(FORBIDDEN_NAME_PARTS),
        },
        "assets": copied,
        "build": build_reports,
    }
    reports = output_root / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    path = reports / "browser-engine-release.provenance.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (reports / "SHA256SUMS").write_text(
        "".join(f"{item['sha256']}  assets/{item['task']}/{item['filename']}\n" for item in copied),
        encoding="utf-8",
    )
    return path


def summarize_tasks(copied: Iterable[dict[str, Any]]) -> dict[str, bool]:
    tasks = {item["task"] for item in copied}
    return {
        "vad": "vad-stt" in tasks,
        "stt": "vad-stt" in tasks,
        "kws": "kws" in tasks,
        "tts": "tts" in tasks,
    }


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    manifest = load_manifest(args.manifest)
    source_artifact = selected_artifact(manifest, SHERPA_SOURCE_ID)
    source_archive = ensure_source_archive(
        args.artifact_root, source_artifact, args.download_source
    )
    with ExitStack() as stack:
        source_root = args.source_root
        source_root_is_temporary = False
        if source_root is None and source_archive is not None:
            args.output_root.parent.mkdir(parents=True, exist_ok=True)
            staging_name = stack.enter_context(
                tempfile.TemporaryDirectory(
                    prefix=f".{args.output_root.name}-source-",
                    dir=args.output_root.parent,
                )
            )
            source_root = extract_source_archive(source_archive, Path(staging_name))
            source_root_is_temporary = True

        if source_root is not None and not source_root.is_dir():
            raise ReleaseError(f"source root does not exist: {source_root}")

        build_reports: list[dict[str, Any]] = []
        if args.build:
            if source_root is None:
                raise ReleaseError(
                    "--build requires --source-root or a verified/extractable source archive"
                )
            build_reports = run_build(source_root)

        copied: list[dict[str, Any]] = []
        if not args.skip_stage:
            if source_root is None:
                raise ReleaseError(
                    "staging requires --source-root or a verified/extractable source archive"
                )
            copied = copy_assets(source_root, args.tts_artifact_root, args.output_root)
            leaks = validate_release_tree(args.output_root)
            if leaks:
                raise ReleaseError("release tree contains forbidden payloads: " + ", ".join(leaks))

        report = write_provenance(
            args.output_root,
            manifest,
            source_artifact,
            source_archive,
            None if source_root_is_temporary else source_root,
            copied,
            build_reports,
        )
    print(
        json.dumps(
            {"ok": True, "report": str(report), "capabilities": summarize_tasks(copied)},
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReleaseError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from None

#!/usr/bin/env python3
"""Build the pinned, telemetry-disabled Cactus iOS static runtimes from a cached source archive."""

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
from pathlib import Path, PurePosixPath

SOURCE_COMMIT = "40a7123b0788f5b38c5fe0daa0d909b4286fe773"
SOURCE_URL = f"https://codeload.github.com/cactus-compute/cactus/tar.gz/{SOURCE_COMMIT}"
SOURCE_BYTES = 14_761_497
SOURCE_SHA256 = "978ad5302bf3e6abedf73286efd498e475cbe977f6a021c8293ffb9f61867eb1"
TELEMETRY_PATCH_SHA256 = "3fcb6c58269e6523d1dc042d6db3c82ab3a3860d56849bde2689bde161fe3963"
TELEMETRY_SOURCE_SHA256 = "1aa48d0f432d64bf014a3b58c6b5247e3a3fe2ac76836898e1a9fc34e78cb31a"
EXPECTED_CMAKE_BLOCK = "target_compile_definitions(cactus PRIVATE\n    PLATFORM_CPU_ONLY=1\n)"
EXPECTED_NEW_LAPACK_DEFINITION = "    ACCELERATE_NEW_LAPACK\n"
ARTIFACT_ROOT = Path(__file__).resolve().parents[2] / ".artifacts/local-inference/cactus/v1.14"
REPO_ROOT = Path(__file__).resolve().parents[2]


class BuildError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_source_archive(destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file():
        if destination.stat().st_size == SOURCE_BYTES and sha256_file(destination) == SOURCE_SHA256:
            return
        raise BuildError("Cached Cactus source archive does not match the approved pin")
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=destination.parent, prefix=f".{destination.name}.", delete=False
        ) as output:
            temporary = Path(output.name)
            request = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "Aurora-native-build/1"})
            with urllib.request.urlopen(request, timeout=60) as response:
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > SOURCE_BYTES:
                        raise BuildError("Pinned Cactus source archive exceeds its fixed size")
                    output.write(chunk)
        if temporary.stat().st_size != SOURCE_BYTES or sha256_file(temporary) != SOURCE_SHA256:
            raise BuildError("Downloaded Cactus source archive does not match the approved pin")
        os.replace(temporary, destination)
    except Exception:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        raise


def verify_runtime(path: Path, target: str) -> bool:
    metadata_path = path / "aurora-cactus-runtime.json"
    try:
        if metadata_path.is_symlink() or not metadata_path.is_file():
            return False
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if (
            metadata.get("format") != 1
            or metadata.get("link_kind") != "static"
            or metadata.get("target") != target
            or metadata.get("source") != {
                "commit": SOURCE_COMMIT,
                "version": "1.14.0",
                "archive_sha256": SOURCE_SHA256,
                "archive_bytes": SOURCE_BYTES,
            }
            or metadata.get("telemetry_disabled") is not True
            or metadata.get("telemetry_patch_sha256") != TELEMETRY_PATCH_SHA256
            or metadata.get("deployment_target") != "13.0"
            or metadata.get("accelerate_abi") != "legacy"
            or metadata.get("static_libraries") != ["libcactus.a", "libcurl.a"]
        ):
            return False
        hashes = metadata.get("file_sha256")
        if not isinstance(hashes, dict) or set(hashes) != {"libcactus.a", "libcurl.a"}:
            return False
        for name, digest in hashes.items():
            archive = path / name
            if archive.is_symlink() or not archive.is_file() or sha256_file(archive) != digest:
                return False
            with archive.open("rb") as source:
                if source.read(8) != b"!<arch>\n":
                    return False
        return True
    except (OSError, ValueError, TypeError):
        return False


def copy_runtime(source: Path, destination: Path, target: str) -> None:
    if verify_runtime(destination, target):
        return
    if destination.exists():
        raise BuildError("Existing Cactus runtime in llama output is not the pinned build")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = destination.parent / f".{destination.name}.staging"
    if staging.exists():
        shutil.rmtree(staging)
    shutil.copytree(source, staging)
    if not verify_runtime(staging, target):
        shutil.rmtree(staging)
        raise BuildError("Staged Cactus runtime failed its pinned metadata check")
    staging.rename(destination)

def safe_extract(archive: Path, destination: Path) -> Path:
    expected_root = f"cactus-{SOURCE_COMMIT}"
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        if not members or len(members) > 100_000:
            raise BuildError("Pinned source archive has an invalid file count")
        total = 0
        for member in members:
            relative = PurePosixPath(member.name)
            if relative.is_absolute() or not relative.parts or relative.parts[0] != expected_root:
                raise BuildError("Pinned source archive path is invalid")
            if any(part in ("", ".", "..") for part in relative.parts):
                raise BuildError("Pinned source archive path is invalid")
            if not (member.isdir() or member.isfile()):
                raise BuildError("Pinned source archive contains a non-regular entry")
            total += member.size
            if total > 1_000_000_000:
                raise BuildError("Pinned source archive expands beyond its limit")
        for member in members:
            target = destination.joinpath(*PurePosixPath(member.name).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            if member.isdir():
                target.mkdir(exist_ok=True)
                continue
            source = bundle.extractfile(member)
            if source is None:
                raise BuildError("Pinned source archive could not be read")
            with source, target.open("xb") as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
    return destination / expected_root


def prepare_source(archive: Path, work_root: Path, patch_path: Path) -> Path:
    if archive.stat().st_size != SOURCE_BYTES or sha256_file(archive) != SOURCE_SHA256:
        raise BuildError("Cactus source archive does not match the approved pin")
    if sha256_file(patch_path) != TELEMETRY_PATCH_SHA256:
        raise BuildError("Cactus telemetry patch does not match the reviewed pin")
    source = safe_extract(archive, work_root / "source")
    telemetry = source / "cactus/telemetry/telemetry.cpp"
    if sha256_file(telemetry) != TELEMETRY_SOURCE_SHA256:
        raise BuildError("Cactus telemetry source does not match the reviewed pin")
    subprocess.run(["patch", "--batch", "-p1", "-i", str(patch_path)], cwd=source, check=True)
    build_script = source / "apple/build.sh"
    script_text = build_script.read_text(encoding="utf-8")
    cpu_line = 'n_cpu=$(sysctl -n hw.logicalcpu 2>/dev/null || echo 4)'
    if script_text.count(cpu_line) != 1:
        raise BuildError("Pinned Cactus Apple builder changed")
    build_script.write_text(
        script_text.replace(cpu_line, 'n_cpu=${AURORA_BUILD_JOBS:-$(sysctl -n hw.logicalcpu 2>/dev/null || echo 4)}'),
        encoding="utf-8",
    )
    cmake = source / "apple/CmakeLists.txt"
    text = cmake.read_text(encoding="utf-8")
    if text.count(EXPECTED_CMAKE_BLOCK) != 1:
        raise BuildError("Pinned Cactus iOS target definition changed")
    text = text.replace(
        EXPECTED_CMAKE_BLOCK,
        "target_compile_definitions(cactus PRIVATE\n    PLATFORM_CPU_ONLY=1\n    AURORA_CACTUS_DISABLE_TELEMETRY=1\n)",
    )
    if text.count(EXPECTED_NEW_LAPACK_DEFINITION) != 1:
        raise BuildError("Pinned Cactus Accelerate ABI definition changed")
    cmake.write_text(
        text.replace(EXPECTED_NEW_LAPACK_DEFINITION, ""),
        encoding="utf-8",
    )
    return source


def stage_runtime(source: Path, output_root: Path, target: str) -> Path:
    if target not in ("ios-arm64", "ios-simulator-arm64"):
        raise BuildError("Unsupported Cactus target")
    apple = source / "apple"
    cactus_name = "libcactus-device.a" if target == "ios-arm64" else "libcactus-simulator.a"
    curl = source / "libs/curl/ios" / ("device" if target == "ios-arm64" else "simulator") / "libcurl.a"
    cactus = apple / cactus_name
    if not cactus.is_file() or not curl.is_file():
        raise BuildError("Cactus builder did not produce the required target archives")
    final = output_root / target
    if final.exists():
        raise BuildError("Refusing to replace an existing staged Cactus runtime")
    staging = output_root / f".{target}.staging"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    shutil.copyfile(cactus, staging / "libcactus.a")
    shutil.copyfile(curl, staging / "libcurl.a")
    hashes = {name: sha256_file(staging / name) for name in ("libcactus.a", "libcurl.a")}
    metadata = {
        "format": 1,
        "link_kind": "static",
        "target": target,
        "source": {
            "commit": SOURCE_COMMIT,
            "version": "1.14.0",
            "archive_sha256": SOURCE_SHA256,
            "archive_bytes": SOURCE_BYTES,
        },
        "telemetry_disabled": True,
        "telemetry_patch_sha256": TELEMETRY_PATCH_SHA256,
        "deployment_target": "13.0",
        "accelerate_abi": "legacy",
        "static_libraries": ["libcactus.a", "libcurl.a"],
        "file_sha256": hashes,
    }
    (staging / "aurora-cactus-runtime.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    staging.rename(final)
    return final


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-root", type=Path, default=ARTIFACT_ROOT)
    parser.add_argument("--source-archive", type=Path)
    parser.add_argument("--llama-runtime-root", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 1)
    args = parser.parse_args(argv)
    try:
        if args.jobs < 1:
            raise BuildError("--jobs must be positive")
        root = args.artifact_root.resolve()
        archive = (args.source_archive or root / "source.tar.gz").resolve()
        output = root / "runtime"
        output.mkdir(parents=True, exist_ok=True)
        targets = ("ios-arm64", "ios-simulator-arm64")
        if not all(verify_runtime(output / target, target) for target in targets):
            if any((output / target).exists() for target in targets):
                raise BuildError("Partial or invalid Cactus runtime cache cannot be replaced")
            ensure_source_archive(archive)
            work = root / "build-source"
            if work.exists():
                shutil.rmtree(work)
            source = prepare_source(archive, work, REPO_ROOT / "tools/local-inference/cactus-telemetry-no-cloud.patch")
            env = os.environ.copy()
            env.update({"BUILD_STATIC": "true", "BUILD_XCFRAMEWORK": "false", "CMAKE_BUILD_TYPE": "Release", "AURORA_BUILD_JOBS": str(args.jobs)})
            subprocess.run(["bash", str(source / "apple/build.sh")], cwd=source, env=env, check=True)
            for target in targets:
                stage_runtime(source, output, target)
        llama_root = args.llama_runtime_root.resolve()
        llama_root.mkdir(parents=True, exist_ok=True)
        for target in targets:
            runtime = output / target
            if not verify_runtime(runtime, target):
                raise BuildError("Cached Cactus runtime failed pinned metadata or archive verification")
            copy_runtime(runtime, llama_root / "cactus" / target, target)
            print(llama_root / "cactus" / target)
    except (BuildError, OSError, tarfile.TarError, subprocess.CalledProcessError) as exc:
        print(f"Pinned Cactus build failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

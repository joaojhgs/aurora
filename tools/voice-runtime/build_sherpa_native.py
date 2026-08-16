#!/usr/bin/env python3
"""Build Aurora's patched static Sherpa runtime for desktop and iOS targets."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent

SHERPA_VERSION = "1.13.5"
SHERPA_SOURCE_NAME = f"sherpa-onnx-{SHERPA_VERSION}"
SHERPA_SOURCE_PIN = (
    "https://github.com/k2-fsa/sherpa-onnx/archive/refs/tags/v1.13.5.tar.gz",
    "99f520db7364a06be0c174a385d03f9ccdbfe08f61146055229e4a990e285262",
    f"sherpa-onnx-v{SHERPA_VERSION}.tar.gz",
)

ORT_VERSION = "1.27.1"
ORT_RELEASE_ROOT = "https://github.com/csukuangfj/onnxruntime-libs/releases/download/v1.27.1"
IOS_ORT_PIN = (
    f"{ORT_RELEASE_ROOT}/onnxruntime-ios-static-xcframework-{ORT_VERSION}.zip",
    "9a0316f4335017a31edd91250881594876fe5fc0805f7490a304b163de6e0817",
    f"onnxruntime-ios-static-xcframework-{ORT_VERSION}.zip",
)

STATIC_LIBRARIES = (
    "sherpa-onnx-c-api",
    "sherpa-onnx-core",
    "kaldi-decoder-core",
    "sherpa-onnx-kaldifst-core",
    "sherpa-onnx-fstfar",
    "sherpa-onnx-fst",
    "kaldi-native-fbank-core",
    "kissfft-float",
    "piper_phonemize",
    "espeak-ng",
    "ucd",
    "onnxruntime",
    "ssentencepiece_core",
)


class NativeBuildError(RuntimeError):
    """Raised when a requested native runtime cannot be built safely."""


@dataclass(frozen=True)
class TargetPlan:
    target: str
    host_system: str
    host_machine: tuple[str, ...]
    ort_pin: tuple[str, str, str]
    cmake_args: tuple[str, ...] = ()
    build_config: str | None = None
    ios_platform: str | None = None
    ios_ort_slice: str | None = None

    @property
    def is_ios(self) -> bool:
        return self.ios_platform is not None


TARGETS = {
    "x86_64-unknown-linux-gnu": TargetPlan(
        target="x86_64-unknown-linux-gnu",
        host_system="Linux",
        host_machine=("x86_64", "amd64"),
        ort_pin=(
            f"{ORT_RELEASE_ROOT}/onnxruntime-linux-x64-static_lib-{ORT_VERSION}-glibc2_17.zip",
            "6b4df7fc46d3367b6be73fdea80dee323b9dc9eaa8dc50136a33d8524e7f06bb",
            f"onnxruntime-linux-x64-static_lib-{ORT_VERSION}-glibc2_17.zip",
        ),
    ),
    "aarch64-apple-darwin": TargetPlan(
        target="aarch64-apple-darwin",
        host_system="Darwin",
        host_machine=("arm64", "aarch64"),
        ort_pin=(
            f"{ORT_RELEASE_ROOT}/onnxruntime-osx-arm64-static_lib-{ORT_VERSION}.zip",
            "b9a84d5d1770818a8bb2a12d9adb45fc2cf5062b930176914cd4e7150ce3fcd2",
            f"onnxruntime-osx-arm64-static_lib-{ORT_VERSION}.zip",
        ),
        cmake_args=("-DCMAKE_OSX_ARCHITECTURES=arm64",),
    ),
    "x86_64-pc-windows-msvc": TargetPlan(
        target="x86_64-pc-windows-msvc",
        host_system="Windows",
        host_machine=("amd64", "x86_64"),
        ort_pin=(
            f"{ORT_RELEASE_ROOT}/onnxruntime-win-x64-static_lib-MD-Release-{ORT_VERSION}.tar.bz2",
            "de11b05b1f42476c612e13eb2ed8f6f30d8c486d56dfab29906a947e6b3abfcf",
            f"onnxruntime-win-x64-static_lib-MD-Release-{ORT_VERSION}.tar.bz2",
        ),
        cmake_args=("-A", "x64", "-DSHERPA_ONNX_USE_STATIC_CRT=OFF"),
        build_config="Release",
    ),
    "aarch64-apple-ios-sim": TargetPlan(
        target="aarch64-apple-ios-sim",
        host_system="Darwin",
        host_machine=("arm64", "aarch64"),
        ort_pin=IOS_ORT_PIN,
        ios_platform="SIMULATORARM64",
        ios_ort_slice="ios-arm64_x86_64-simulator",
    ),
    "aarch64-apple-ios": TargetPlan(
        target="aarch64-apple-ios",
        host_system="Darwin",
        host_machine=("arm64", "aarch64"),
        ort_pin=IOS_ORT_PIN,
        ios_platform="OS64",
        ios_ort_slice="ios-arm64",
    ),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_target(requested: str, host_system: str, host_machine: str) -> TargetPlan:
    normalized_machine = host_machine.lower()
    if requested == "host":
        host_targets = [
            plan
            for plan in TARGETS.values()
            if not plan.is_ios
            and plan.host_system == host_system
            and normalized_machine in plan.host_machine
        ]
        if len(host_targets) != 1:
            raise NativeBuildError(f"unsupported native Sherpa host: {host_system}/{host_machine}")
        return host_targets[0]
    try:
        plan = TARGETS[requested]
    except KeyError as exc:
        raise NativeBuildError(f"unsupported native Sherpa target: {requested}") from exc
    if plan.host_system != host_system or normalized_machine not in plan.host_machine:
        raise NativeBuildError(
            f"target {requested} requires {plan.host_system}/{plan.host_machine}, "
            f"got {host_system}/{host_machine}"
        )
    return plan


def ensure_bounded(path: Path, root: Path, label: str) -> Path:
    resolved = path.resolve()
    resolved_root = root.resolve()
    try:
        resolved.relative_to(resolved_root)
    except ValueError as exc:
        raise NativeBuildError(f"{label} must remain beneath {resolved_root}") from exc
    if resolved == resolved_root:
        raise NativeBuildError(f"{label} must not equal the artifact root")
    return resolved


def download_verified(pin: tuple[str, str, str], destination: Path) -> None:
    url, expected_sha, _ = pin
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and sha256_file(destination) == expected_sha:
        return
    destination.unlink(missing_ok=True)
    last_error: Exception | None = None
    for attempt in range(1, 4):
        partial: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                dir=destination.parent,
                prefix=f".{destination.name}.",
                delete=False,
            ) as output:
                partial = Path(output.name)
                request = urllib.request.Request(url, headers={"User-Agent": "Aurora-build/1"})
                with urllib.request.urlopen(request, timeout=60) as response:
                    shutil.copyfileobj(response, output, length=1024 * 1024)
            actual_sha = sha256_file(partial)
            if actual_sha != expected_sha:
                raise NativeBuildError(
                    f"SHA-256 mismatch for {url}: expected {expected_sha}, got {actual_sha}"
                )
            os.replace(partial, destination)
            return
        except Exception as exc:
            last_error = exc
            if partial is not None:
                partial.unlink(missing_ok=True)
            if attempt < 3:
                time.sleep(attempt)
    raise NativeBuildError(f"download failed after three attempts: {url}") from last_error


def safe_extract_zip(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            relative = PurePosixPath(entry.filename)
            if relative.is_absolute() or ".." in relative.parts:
                raise NativeBuildError(f"unsafe ZIP member: {entry.filename}")
            unix_mode = entry.external_attr >> 16
            if unix_mode & 0o170000 == 0o120000:
                raise NativeBuildError(f"symbolic links are not accepted in ZIPs: {entry.filename}")
        source.extractall(destination)


def prepare_ios_ort(archive: Path, artifact_root: Path, plan: TargetPlan) -> tuple[Path, Path]:
    if plan.ios_ort_slice is None:
        raise NativeBuildError("iOS ONNX Runtime requested for a non-iOS target")
    extraction_root = ensure_bounded(
        artifact_root / f"onnxruntime-ios-static-{ORT_VERSION}",
        artifact_root,
        "iOS ONNX Runtime extraction",
    )
    marker = extraction_root / ".aurora-archive-sha256"
    expected_sha = plan.ort_pin[1]
    if not marker.is_file() or marker.read_text(encoding="utf-8").strip() != expected_sha:
        if extraction_root.exists():
            shutil.rmtree(extraction_root)
        extraction_root.mkdir(parents=True)
        safe_extract_zip(archive, extraction_root)
        marker.write_text(f"{expected_sha}\n", encoding="utf-8")

    candidates = list(extraction_root.glob("**/onnxruntime.xcframework"))
    if len(candidates) != 1:
        raise NativeBuildError("iOS ONNX Runtime archive must contain one xcframework")
    framework = candidates[0] / plan.ios_ort_slice / "onnxruntime.framework"
    binary = framework / "onnxruntime"
    headers = framework / "Headers"
    if not binary.is_file() or not headers.is_dir():
        raise NativeBuildError(f"iOS ONNX Runtime archive is missing slice {plan.ios_ort_slice}")
    return framework.parent, binary


def common_cmake_args(source_root: Path, build_dir: Path, install_dir: Path) -> list[str]:
    return [
        "cmake",
        "-S",
        str(source_root),
        "-B",
        str(build_dir),
        "-DCMAKE_BUILD_TYPE=Release",
        f"-DCMAKE_INSTALL_PREFIX={install_dir}",
        "-DBUILD_SHARED_LIBS=OFF",
        "-DBUILD_PIPER_PHONMIZE_EXE=OFF",
        "-DBUILD_PIPER_PHONMIZE_TESTS=OFF",
        "-DBUILD_ESPEAK_NG_EXE=OFF",
        "-DBUILD_ESPEAK_NG_TESTS=OFF",
        "-DSHERPA_ONNX_ENABLE_BINARY=OFF",
        "-DSHERPA_ONNX_ENABLE_C_API=ON",
        "-DSHERPA_ONNX_ENABLE_CHECK=OFF",
        "-DSHERPA_ONNX_ENABLE_JNI=OFF",
        "-DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF",
        "-DSHERPA_ONNX_ENABLE_PYTHON=OFF",
        "-DSHERPA_ONNX_ENABLE_QNN=OFF",
        "-DSHERPA_ONNX_ENABLE_RKNN=OFF",
        "-DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=OFF",
        "-DSHERPA_ONNX_ENABLE_TESTS=OFF",
        "-DSHERPA_ONNX_ENABLE_TTS=ON",
        "-DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF",
    ]


def configure_command(
    plan: TargetPlan,
    artifact_root: Path,
    source_root: Path,
    build_dir: Path,
    install_dir: Path,
) -> list[str]:
    cmake = common_cmake_args(source_root, build_dir, install_dir)
    if plan.is_ios:
        cmake.extend(
            [
                f"-DCMAKE_TOOLCHAIN_FILE={source_root / 'toolchains/ios.toolchain.cmake'}",
                f"-DPLATFORM={plan.ios_platform}",
                "-DENABLE_BITCODE=0",
                "-DENABLE_ARC=1",
                "-DENABLE_VISIBILITY=0",
                "-DDEPLOYMENT_TARGET=13.0",
                "-DSHERPA_ONNX_USE_PRE_INSTALLED_ONNXRUNTIME_IF_AVAILABLE=ON",
            ]
        )
    else:
        cmake.append("-DSHERPA_ONNX_USE_PRE_INSTALLED_ONNXRUNTIME_IF_AVAILABLE=OFF")
        cmake.extend(plan.cmake_args)
    return [
        sys.executable,
        str(SCRIPT_DIR / "run_sherpa_cmake.py"),
        "--artifact-root",
        str(artifact_root),
        "--source-root",
        str(source_root),
        "--allow-aurora-pockettts-patches",
        "--",
        *cmake,
    ]


def static_library_filename(name: str, target: str) -> str:
    if target.endswith("windows-msvc"):
        return f"{name}.lib"
    return f"lib{name}.a"


def stage_runtime(
    plan: TargetPlan,
    artifact_root: Path,
    install_dir: Path,
    output_dir: Path,
    ios_ort_binary: Path | None,
) -> None:
    output_parent = output_dir.parent
    output_parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}.", dir=output_parent))
    try:
        for library in STATIC_LIBRARIES:
            filename = static_library_filename(library, plan.target)
            if library == "onnxruntime" and ios_ort_binary is not None:
                source = ios_ort_binary
            else:
                source = install_dir / "lib" / filename
            if not source.is_file():
                raise NativeBuildError(f"Sherpa install is missing {source}")
            shutil.copy2(source, staging / filename)

        primary = staging / static_library_filename("sherpa-onnx-c-api", plan.target)
        if b"TTS is not enabled. Please rebuild sherpa-onnx" in primary.read_bytes():
            raise NativeBuildError("Sherpa static runtime was built without TTS")
        metadata = {
            "format": 1,
            "link_kind": "static",
            "onnxruntime_version": ORT_VERSION,
            "patch_queue": "tools/voice-runtime/sherpa-patches/series",
            "sherpa_version": SHERPA_VERSION,
            "static_libraries": list(STATIC_LIBRARIES),
            "target": plan.target,
        }
        (staging / "aurora-sherpa-runtime.json").write_text(
            json.dumps(metadata, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        if output_dir.exists():
            shutil.rmtree(output_dir)
        staging.rename(output_dir)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def run_build(plan: TargetPlan, artifact_root: Path, output_root: Path, jobs: int) -> Path:
    artifact_root.mkdir(parents=True, exist_ok=True)
    source_dir = artifact_root / "sources"
    source_archive = source_dir / SHERPA_SOURCE_PIN[2]
    ort_archive = source_dir / plan.ort_pin[2]
    download_verified(SHERPA_SOURCE_PIN, source_archive)
    download_verified(plan.ort_pin, ort_archive)

    extracted_root = source_dir / "extracted"
    subprocess.run(
        [
            sys.executable,
            str(SCRIPT_DIR / "sherpa-patches/apply_sherpa_patches.py"),
            "--archive",
            str(source_archive),
            "--staging-root",
            str(extracted_root),
        ],
        cwd=REPO_ROOT,
        check=True,
    )
    source_root = extracted_root / SHERPA_SOURCE_NAME
    build_dir = ensure_bounded(
        artifact_root / "builds" / plan.target,
        artifact_root,
        "native build directory",
    )
    install_dir = build_dir / "install"
    if build_dir.exists():
        shutil.rmtree(build_dir)
    build_dir.mkdir(parents=True)

    ios_ort_binary: Path | None = None
    build_env = os.environ.copy()
    if plan.is_ios:
        ort_lib_dir, ios_ort_binary = prepare_ios_ort(ort_archive, artifact_root, plan)
        build_env["SHERPA_ONNXRUNTIME_LIB_DIR"] = str(ort_lib_dir)
        build_env["SHERPA_ONNXRUNTIME_INCLUDE_DIR"] = str(
            ort_lib_dir / "onnxruntime.framework/Headers"
        )
    else:
        shutil.copy2(ort_archive, build_dir / plan.ort_pin[2])

    subprocess.run(
        configure_command(plan, artifact_root, source_root, build_dir, install_dir),
        cwd=REPO_ROOT,
        env=build_env,
        check=True,
    )
    build_command = ["cmake", "--build", str(build_dir), "--target", "install"]
    if plan.build_config is not None:
        build_command.extend(["--config", plan.build_config])
    build_command.extend(["--parallel", str(jobs)])
    subprocess.run(build_command, cwd=REPO_ROOT, env=build_env, check=True)

    output_dir = ensure_bounded(
        output_root / plan.target,
        artifact_root,
        "native runtime output",
    )
    stage_runtime(plan, artifact_root, install_dir, output_dir, ios_ort_binary)
    return output_dir


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default="host", choices=("host", *TARGETS))
    parser.add_argument(
        "--artifact-root",
        type=Path,
        default=REPO_ROOT / ".artifacts/sherpa-onnx/native-runtime-build",
    )
    parser.add_argument("--output-root", type=Path)
    parser.add_argument(
        "--jobs",
        type=int,
        default=int(os.environ.get("AURORA_BUILD_JOBS", "2")),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.jobs < 1:
            raise NativeBuildError("--jobs must be a positive integer")
        artifact_root = args.artifact_root.resolve()
        if artifact_root == Path(artifact_root.anchor):
            raise NativeBuildError("artifact root must be a bounded directory")
        output_root = (args.output_root or artifact_root / "runtime").resolve()
        ensure_bounded(output_root, artifact_root, "native runtime output root")
        plan = resolve_target(args.target, platform.system(), platform.machine())
        output_dir = run_build(plan, artifact_root, output_root, args.jobs)
    except (NativeBuildError, OSError, subprocess.CalledProcessError, tarfile.TarError) as exc:
        print(f"Native Sherpa build failed: {exc}", file=sys.stderr)
        return 1
    print(f"Prepared patched static Sherpa runtime: {output_dir}")
    print(f"AURORA_SHERPA_ONNX_LIB_DIR={output_dir}")
    print("AURORA_SHERPA_ONNX_LINK_KIND=static")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

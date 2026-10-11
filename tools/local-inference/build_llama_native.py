#!/usr/bin/env python3
"""Build the pinned portable static llama.cpp runtime for Aurora native targets."""

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
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
ARTIFACT_ROOT = REPO_ROOT / ".artifacts/local-inference"
LOCK_PATH = SCRIPT_DIR / "llama.cpp.lock.json"
LOCK = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
SOURCE_LOCK = LOCK["source"]
LLAMA_COMMIT = SOURCE_LOCK["commit"]
LLAMA_VERSION = SOURCE_LOCK["version"]
SOURCE_ARCHIVE = (
    SOURCE_LOCK["archive_url"],
    SOURCE_LOCK["archive_sha256"],
    SOURCE_LOCK["archive_bytes"],
    SOURCE_LOCK["archive_file"],
)
SOURCE_DIRECTORY = f"llama.cpp-{LLAMA_COMMIT}"
MAX_SOURCE_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
MAX_SOURCE_MEMBERS = 50_000
STATIC_ARCHIVE_MAGIC = b"!<arch>\n"
BUILD_TREE_LIBRARIES = (
    "libllama-common.a",
    "libllama-common-base.a",
    "libcpp-httplib.a",
)
REQUIRED_LIBRARIES = {
    "libllama.a",
    "libllama-common.a",
    "libllama-common-base.a",
    "libggml.a",
    "libggml-base.a",
    "libggml-cpu.a",
    "libcpp-httplib.a",
}
LINK_ORDER = (
    "libllama-common.a",
    "libllama-common-base.a",
    "libllama.a",
    "libggml.a",
    "libggml-cpu.a",
    "libggml-base.a",
    "libcpp-httplib.a",
)


class NativeBuildError(RuntimeError):
    """Raised when a pinned native build cannot be prepared safely."""


@dataclass(frozen=True)
class TargetPlan:
    target: str
    system: str
    machines: tuple[str, ...]
    android_abi: str | None = None
    ios_sdk: str | None = None
    ios_arch: str | None = None


TARGETS = {
    "host": TargetPlan("host", "Linux", ("x86_64", "amd64", "aarch64", "arm64")),
    "android-x86_64": TargetPlan("android-x86_64", "Linux", (), android_abi="x86_64"),
    "android-arm64": TargetPlan("android-arm64", "Linux", (), android_abi="arm64-v8a"),
    "ios-simulator-arm64": TargetPlan(
        "ios-simulator-arm64", "Darwin", (), ios_sdk="iphonesimulator", ios_arch="arm64"
    ),
    "ios-arm64": TargetPlan("ios-arm64", "Darwin", (), ios_sdk="iphoneos", ios_arch="arm64"),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_archive_tool(build: Path) -> str:
    cache = build / "CMakeCache.txt"
    configured: list[str] = []
    if cache.is_file():
        try:
            cache_lines = cache.read_text(encoding="utf-8", errors="strict").splitlines()
        except (OSError, UnicodeError) as exc:
            raise NativeBuildError("configured archive tool could not be read") from exc
        for line in cache_lines:
            if line.startswith(("CMAKE_AR:FILEPATH=", "CMAKE_AR:STRING=")):
                configured.append(line.split("=", 1)[1])
    if len(configured) > 1:
        raise NativeBuildError("configured archive tool is ambiguous")
    if configured:
        candidate = Path(configured[0])
        if not candidate.is_file() or not os.access(candidate, os.X_OK):
            raise NativeBuildError("configured archive tool is unavailable")
        return str(candidate)
    candidate = shutil.which("llvm-ar") or shutil.which("ar")
    if candidate is None:
        raise NativeBuildError("platform archive tool is unavailable")
    return candidate


def static_archives_have_same_objects(left: Path, right: Path, archive_tool: str) -> bool:
    """Compare ordered archive members and member bytes without extracting either archive."""
    if any(path.is_symlink() or not path.is_file() for path in (left, right)):
        raise NativeBuildError("static archive comparison requires regular files")

    def list_members(archive: Path) -> list[str]:
        try:
            result = subprocess.run(
                [archive_tool, "t", str(archive)],
                check=True,
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
        except (OSError, UnicodeError, subprocess.CalledProcessError) as exc:
            raise NativeBuildError("platform archive member listing failed") from exc
        members = result.stdout.splitlines()
        if not members or any(not member or "\x00" in member for member in members):
            raise NativeBuildError("platform archive member listing was invalid")
        if len(members) != len(set(members)):
            raise NativeBuildError("static archive contains ambiguous duplicate member names")
        return members

    left_members = list_members(left)
    right_members = list_members(right)
    if left_members != right_members:
        return False

    # These names identify archive indexes rather than object payloads. Their
    # bytes may be rewritten by ranlib during installation; ordered membership
    # remains checked above.
    index_members = {"/", "/SYM64/", "__.SYMDEF", "__.SYMDEF SORTED"}
    for member in left_members:
        if member in index_members:
            continue
        try:
            left_data = subprocess.run(
                [archive_tool, "p", str(left), member], check=True, capture_output=True
            ).stdout
            right_data = subprocess.run(
                [archive_tool, "p", str(right), member], check=True, capture_output=True
            ).stdout
        except (OSError, subprocess.CalledProcessError) as exc:
            raise NativeBuildError("platform archive member extraction failed") from exc
        if hashlib.sha256(left_data).digest() != hashlib.sha256(right_data).digest():
            return False
    return True


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


def resolve_artifact_root(path: Path) -> Path:
    resolved = path.resolve()
    if resolved.name != "local-inference" or resolved.parent.name != ".artifacts":
        raise NativeBuildError(
            "artifact root must be the project's .artifacts/local-inference directory"
        )
    return resolved


def download_verified(destination: Path) -> None:
    url, expected_sha, expected_bytes, _ = SOURCE_ARCHIVE
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file():
        if (
            destination.stat().st_size == expected_bytes
            and sha256_file(destination) == expected_sha
        ):
            return
        destination.unlink()

    last_error: Exception | None = None
    for attempt in range(1, 4):
        partial: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                dir=destination.parent, prefix=f".{destination.name}.", delete=False
            ) as output:
                partial = Path(output.name)
                request = urllib.request.Request(
                    url, headers={"User-Agent": "Aurora-native-build/1"}
                )
                with urllib.request.urlopen(request, timeout=60) as response:
                    total = 0
                    while chunk := response.read(1024 * 1024):
                        total += len(chunk)
                        if total > expected_bytes:
                            raise NativeBuildError(
                                "pinned llama.cpp archive exceeds its fixed size"
                            )
                        output.write(chunk)
            actual_bytes = partial.stat().st_size
            actual_sha = sha256_file(partial)
            if actual_bytes != expected_bytes or actual_sha != expected_sha:
                raise NativeBuildError(
                    "pinned llama.cpp archive did not match its fixed size and SHA-256"
                )
            os.replace(partial, destination)
            return
        except Exception as exc:
            last_error = exc
            if partial is not None:
                partial.unlink(missing_ok=True)
            if attempt < 3:
                time.sleep(attempt)
    raise NativeBuildError("pinned llama.cpp source archive download failed") from last_error


def safe_extract_source(archive: Path, destination: Path) -> Path:
    expected_sha = SOURCE_ARCHIVE[1]
    marker = destination / ".aurora-source-sha256"
    source_root = destination / SOURCE_DIRECTORY
    if (
        marker.is_file()
        and marker.read_text(encoding="ascii").strip() == expected_sha
        and (source_root / "CMakeLists.txt").is_file()
        and (source_root / "ggml/CMakeLists.txt").is_file()
    ):
        return source_root

    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".llama-source-", dir=destination.parent))
    try:
        expanded = 0
        with tarfile.open(archive, mode="r:gz") as source:
            members = source.getmembers()
            if len(members) > MAX_SOURCE_MEMBERS:
                raise NativeBuildError("pinned source archive has too many entries")
            for member in members:
                relative = PurePosixPath(member.name)
                if relative.is_absolute() or ".." in relative.parts:
                    raise NativeBuildError("pinned source archive contains an unsafe path")
                if not (member.isdir() or member.isfile()):
                    raise NativeBuildError("pinned source archive contains a link or special file")
                if member.isfile():
                    expanded += member.size
                    if member.size < 0 or expanded > MAX_SOURCE_EXPANDED_BYTES:
                        raise NativeBuildError(
                            "pinned source archive expands beyond its fixed limit"
                        )
            roots = {PurePosixPath(member.name).parts[0] for member in members if member.name}
            if roots != {SOURCE_DIRECTORY}:
                raise NativeBuildError(
                    "pinned source archive root directory did not match its revision"
                )
            source.extractall(staging, members=members)

        extracted = staging / SOURCE_DIRECTORY
        if (
            not (extracted / "CMakeLists.txt").is_file()
            or not (extracted / "ggml/CMakeLists.txt").is_file()
        ):
            raise NativeBuildError("pinned source archive is missing llama.cpp or bundled ggml")
        (staging / ".aurora-source-sha256").write_text(f"{expected_sha}\n", encoding="ascii")
        if destination.exists():
            shutil.rmtree(destination)
        staging.rename(destination)
        return destination / SOURCE_DIRECTORY
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def resolve_target(name: str, host_system: str, host_machine: str) -> TargetPlan:
    plan = TARGETS[name]
    machine = host_machine.lower()
    if plan.android_abi is not None:
        if host_system not in ("Linux", "Darwin"):
            raise NativeBuildError("Android cross builds require a Linux or macOS host")
        return plan
    if plan.ios_sdk is not None:
        if host_system != "Darwin":
            raise NativeBuildError("iOS targets require the existing Xcode toolchain on macOS")
        return plan
    if host_system != plan.system or machine not in plan.machines:
        raise NativeBuildError(
            f"native smoke target requires Linux x86_64 or aarch64, got {host_system}/{host_machine}"
        )
    return TargetPlan(
        "linux-" + ("aarch64" if machine in ("aarch64", "arm64") else "x86_64"),
        plan.system,
        plan.machines,
    )


def cmake_arguments(
    source: Path,
    build: Path,
    install: Path,
    plan: TargetPlan,
    android_api: int,
    ndk: Path | None,
) -> list[str]:
    args = [
        "cmake",
        "-S",
        str(source),
        "-B",
        str(build),
        "-DCMAKE_BUILD_TYPE=Release",
        f"-DCMAKE_INSTALL_PREFIX={install}",
        "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
        "-DBUILD_SHARED_LIBS=OFF",
        "-DGGML_STATIC=OFF",
        "-DGGML_NATIVE=OFF",
        "-DGGML_OPENMP=OFF",
        "-DGGML_LLAMAFILE=OFF",
        "-DGGML_SSE42=OFF",
        "-DGGML_AVX=OFF",
        "-DGGML_AVX_VNNI=OFF",
        "-DGGML_AVX2=OFF",
        "-DGGML_BMI2=OFF",
        "-DGGML_AVX512=OFF",
        "-DGGML_AVX512_VBMI=OFF",
        "-DGGML_AVX512_VNNI=OFF",
        "-DGGML_AVX512_BF16=OFF",
        "-DGGML_FMA=OFF",
        "-DGGML_F16C=OFF",
        "-DGGML_METAL=OFF",
        "-DGGML_ACCELERATE=OFF",
        "-DGGML_BLAS=OFF",
        "-DLLAMA_BUILD_IS_DEV=OFF",
        "-DLLAMA_BUILD_COMMON=ON",
        "-DLLAMA_BUILD_TESTS=OFF",
        "-DLLAMA_BUILD_TOOLS=OFF",
        "-DLLAMA_BUILD_EXAMPLES=OFF",
        "-DLLAMA_BUILD_SERVER=OFF",
        "-DLLAMA_BUILD_APP=OFF",
        "-DLLAMA_BUILD_UI=OFF",
        "-DLLAMA_BUILD_MTMD=OFF",
        "-DLLAMA_TOOLS_INSTALL=OFF",
        "-DLLAMA_TESTS_INSTALL=OFF",
        "-DLLAMA_CURL=OFF",
        "-DLLAMA_OPENSSL=OFF",
        "-DLLAMA_SUBPROCESS=OFF",
        "-DLLAMA_LLGUIDANCE=OFF",
        "-DGGML_BACKEND_DL=OFF",
        "-DGGML_BUILD_TESTS=OFF",
        "-DGGML_BUILD_EXAMPLES=OFF",
        f"-DLLAMA_BUILD_COMMIT={LLAMA_COMMIT}",
    ]
    if plan.android_abi is not None:
        if ndk is None:
            raise NativeBuildError("Android target requires ANDROID_NDK_HOME or --android-ndk")
        toolchain = ndk / "build/cmake/android.toolchain.cmake"
        if not toolchain.is_file():
            raise NativeBuildError(
                "caller-provided Android NDK does not contain its CMake toolchain"
            )
        args.extend(
            [
                f"-DCMAKE_TOOLCHAIN_FILE={toolchain}",
                f"-DANDROID_ABI={plan.android_abi}",
                f"-DANDROID_PLATFORM=android-{android_api}",
                "-DANDROID_STL=c++_shared",
            ]
        )
    elif plan.ios_sdk is not None:
        args.extend(
            [
                "-DCMAKE_SYSTEM_NAME=iOS",
                f"-DCMAKE_OSX_SYSROOT={plan.ios_sdk}",
                f"-DCMAKE_OSX_ARCHITECTURES={plan.ios_arch}",
                "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0",
                "-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY",
            ]
        )
    return args


def copy_tree_contents(source: Path, destination: Path) -> None:
    if not source.is_dir():
        raise NativeBuildError(f"llama.cpp install is missing {source}")
    destination.mkdir(parents=True, exist_ok=True)
    for child in source.iterdir():
        target = destination / child.name
        if child.is_dir():
            shutil.copytree(child, target)
        elif child.is_file():
            shutil.copy2(child, target)


def copy_headers(source: Path, destination: Path) -> None:
    extensions = {".h", ".hh", ".hpp", ".hxx", ".inl", ".ipp"}
    if not source.is_dir():
        raise NativeBuildError(f"pinned source headers are missing {source}")
    for header in source.rglob("*"):
        if header.is_file() and header.suffix in extensions:
            target = destination / header.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(header, target)


def copy_notices(source: Path, destination: Path) -> None:
    prefixes = ("LICENSE", "COPYING", "NOTICE")
    for notice in source.rglob("*"):
        if not notice.is_file() or notice.is_symlink():
            continue
        if not notice.name.upper().startswith(prefixes):
            continue
        target = destination / notice.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(notice, target)


def find_build_library(build: Path, name: str) -> Path:
    matches = [
        path
        for path in build.rglob(name)
        if path.is_file() and not path.is_symlink() and not path.is_relative_to(build / "install")
    ]
    if len(matches) != 1:
        raise NativeBuildError(f"build tree must contain exactly one {name}")
    return matches[0]


def stage_runtime(
    install: Path,
    build: Path,
    source: Path,
    output: Path,
    target: str,
    cmake_flags: list[str],
) -> None:
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        installed_include = install / "include"
        copy_tree_contents(installed_include, staging / "include")
        required_public_headers = (
            "llama.h",
            "ggml.h",
            "ggml-cpu.h",
            "ggml-backend.h",
            "ggml-opt.h",
            "gguf.h",
        )
        if any(not (staging / "include" / name).is_file() for name in required_public_headers):
            raise NativeBuildError("llama.cpp install is missing required public C headers")
        common_headers = staging / "include/llama-common"
        copy_headers(source / "common", common_headers)
        vendor_headers = staging / "include/vendor"
        copy_headers(source / "vendor", vendor_headers)
        copy_notices(source, staging / "licenses/llama.cpp")
        required_common_headers = (
            "chat.h",
            "common.h",
            "json.h",
            "json-schema.h",
            "json-schema-to-grammar.h",
            "log.h",
            "peg-parser.h",
            "jinja/parser.h",
            "jinja/runtime.h",
            "jinja/caps.h",
        )
        required_vendor_headers = (
            "cpp-httplib/httplib.h",
            "nlohmann/json.hpp",
            "sheredom/subprocess.h",
        )
        if any(not (common_headers / name).is_file() for name in required_common_headers):
            raise NativeBuildError("pinned common header closure is incomplete")
        if any(not (vendor_headers / name).is_file() for name in required_vendor_headers):
            raise NativeBuildError("pinned vendored header closure is incomplete")

        installed_libraries = sorted((install / "lib").glob("*.a"))
        if not installed_libraries:
            raise NativeBuildError("llama.cpp install produced no static libraries")
        installed_by_name = {library.name: library for library in installed_libraries}
        if len(installed_by_name) != len(installed_libraries):
            raise NativeBuildError("llama.cpp install contains duplicate static library names")
        build_libraries = []
        for name in BUILD_TREE_LIBRARIES:
            build_library = find_build_library(build, name)
            installed_library = installed_by_name.get(name)
            if installed_library is not None:
                if sha256_file(installed_library) != sha256_file(build_library):
                    archive_tool = resolve_archive_tool(build)
                    if not static_archives_have_same_objects(
                        installed_library, build_library, archive_tool
                    ):
                        raise NativeBuildError(
                            f"installed and build-tree copies conflict for {name}"
                        )
                continue
            build_libraries.append(build_library)
        libraries_by_name = {
            library.name: library for library in installed_libraries + build_libraries
        }
        names = set(libraries_by_name)
        missing = REQUIRED_LIBRARIES - names
        if missing:
            raise NativeBuildError(
                "llama.cpp build is missing required static targets: " + ", ".join(sorted(missing))
            )
        libraries = [libraries_by_name[name] for name in LINK_ORDER]
        libraries.extend(libraries_by_name[name] for name in sorted(names - set(LINK_ORDER)))
        for library in libraries:
            if library.is_symlink() or not library.is_file():
                raise NativeBuildError("llama.cpp install contains a non-regular static library")
            with library.open("rb") as archive:
                if archive.read(len(STATIC_ARCHIVE_MAGIC)) != STATIC_ARCHIVE_MAGIC:
                    raise NativeBuildError(
                        f"installed library is not a static archive: {library.name}"
                    )
            shutil.copy2(library, staging / library.name)

        file_hashes = {
            path.relative_to(staging).as_posix(): sha256_file(path)
            for path in sorted(staging.rglob("*"))
            if path.is_file()
        }
        metadata = {
            "format": 1,
            "link_kind": "static",
            "source": {
                "archive_bytes": SOURCE_ARCHIVE[2],
                "archive_sha256": SOURCE_ARCHIVE[1],
                "commit": LLAMA_COMMIT,
                "version": LLAMA_VERSION,
            },
            "target": target,
            "include_dirs": ["include", "include/llama-common", "include/vendor"],
            "common_header_dir": "include/llama-common",
            "vendor_header_dir": "include/vendor",
            "primary_targets": ["llama", "llama-common"],
            "static_libraries": [library.name for library in libraries],
            "static_link_order": list(LINK_ORDER),
            "file_sha256": file_hashes,
            "cmake_options": cmake_flags,
        }
        (staging / "aurora-llama-runtime.json").write_text(
            json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        if output.exists():
            shutil.rmtree(output)
        staging.rename(output)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def build(args: argparse.Namespace) -> Path:
    artifact_root = resolve_artifact_root(args.artifact_root)
    artifact_root.mkdir(parents=True, exist_ok=True)
    output_root = ensure_bounded(
        (args.output_root or artifact_root / "runtime").resolve(), artifact_root, "output root"
    )
    plan = resolve_target(args.target, platform.system(), platform.machine())
    source_archive = artifact_root / "downloads" / SOURCE_ARCHIVE[3]
    download_verified(source_archive)
    source_root = safe_extract_source(source_archive, artifact_root / "sources" / SOURCE_DIRECTORY)

    ndk_value = (
        args.android_ndk or os.environ.get("ANDROID_NDK_HOME") or os.environ.get("ANDROID_NDK_ROOT")
    )
    ndk = Path(ndk_value).resolve() if ndk_value else None
    target = plan.target
    build_dir = ensure_bounded(artifact_root / "builds" / target, artifact_root, "build directory")
    install_dir = ensure_bounded(build_dir / "install", artifact_root, "install directory")
    cmake_args = cmake_arguments(source_root, build_dir, install_dir, plan, args.android_api, ndk)
    build_dir.mkdir(parents=True, exist_ok=True)
    configuration = {
        "source_commit": LLAMA_COMMIT,
        "target": target,
        "cmake_args": cmake_args,
        "compiler_env": {key: os.environ.get(key) for key in ("CC", "CXX", "CFLAGS", "CXXFLAGS")},
    }
    config_marker = build_dir / ".aurora-cmake-config.json"
    if config_marker.is_file():
        try:
            previous_configuration = json.loads(config_marker.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            previous_configuration = None
        if previous_configuration != configuration:
            shutil.rmtree(build_dir)
            build_dir.mkdir(parents=True)

    env = os.environ.copy()
    subprocess.run(cmake_args, cwd=REPO_ROOT, env=env, check=True)
    config_marker.write_text(
        json.dumps(configuration, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    subprocess.run(
        [
            "cmake",
            "--build",
            str(build_dir),
            "--target",
            "llama-common",
            "llama-common-base",
            "--parallel",
            str(args.jobs),
        ],
        cwd=REPO_ROOT,
        env=env,
        check=True,
    )
    command = [
        "cmake",
        "--build",
        str(build_dir),
        "--target",
        "install",
        "--parallel",
        str(args.jobs),
    ]
    subprocess.run(command, cwd=REPO_ROOT, env=env, check=True)

    output = ensure_bounded(output_root / target, artifact_root, "runtime output")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage_runtime(install_dir, build_dir, source_root, output, target, cmake_args[6:])
    if target == "android-arm64":
        subprocess.run(
            [
                sys.executable,
                str(REPO_ROOT / "tools/local-inference/fetch_needle_native.py"),
                "--lock-variant", "android-v2",
                "--target", "android-arm64",
                "--output-root", str(output / "needle2"),
            ],
            cwd=REPO_ROOT,
            check=True,
        )
    return output


def stage_existing_build(args: argparse.Namespace) -> Path:
    artifact_root = resolve_artifact_root(args.artifact_root)
    plan = resolve_target(args.target, platform.system(), platform.machine())
    target = plan.target
    build_dir = ensure_bounded(artifact_root / "builds" / target, artifact_root, "build directory")
    marker = build_dir / ".aurora-cmake-config.json"
    if not marker.is_file():
        raise NativeBuildError("stage-only requires a previously configured pinned build")
    try:
        configuration = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise NativeBuildError("configured build metadata is unavailable") from exc
    if configuration.get("source_commit") != LLAMA_COMMIT or configuration.get("target") != target:
        raise NativeBuildError(
            "configured build does not match the pinned source and requested target"
        )
    cmake_args = configuration.get("cmake_args")
    if (
        not isinstance(cmake_args, list)
        or len(cmake_args) < 5
        or cmake_args[0] != "cmake"
        or cmake_args[1] != "-S"
        or cmake_args[3] != "-B"
        or Path(cmake_args[4]).resolve() != build_dir
    ):
        raise NativeBuildError("configured build paths do not match the pinned build directory")
    if f"-DCMAKE_INSTALL_PREFIX={build_dir / 'install'}" not in cmake_args:
        raise NativeBuildError("configured install directory does not match the pinned build")
    required_flags = {
        "-DBUILD_SHARED_LIBS=OFF",
        "-DGGML_NATIVE=OFF",
        "-DGGML_OPENMP=OFF",
        "-DGGML_LLAMAFILE=OFF",
        "-DLLAMA_BUILD_COMMON=ON",
        "-DLLAMA_OPENSSL=OFF",
        "-DLLAMA_SUBPROCESS=OFF",
        f"-DLLAMA_BUILD_COMMIT={LLAMA_COMMIT}",
    }
    if not required_flags.issubset(cmake_args):
        raise NativeBuildError(
            "configured build does not contain the pinned portable static options"
        )
    source_root = ensure_bounded(Path(cmake_args[2]), artifact_root, "pinned source tree")
    if source_root.name != SOURCE_DIRECTORY or not (source_root / "CMakeLists.txt").is_file():
        raise NativeBuildError("configured source tree does not match the pinned archive layout")
    source_marker = source_root.parent / ".aurora-source-sha256"
    if (
        not source_marker.is_file()
        or source_marker.read_text(encoding="ascii").strip() != SOURCE_ARCHIVE[1]
    ):
        raise NativeBuildError(
            "configured source tree is not marked with the pinned archive digest"
        )
    archive = artifact_root / "downloads" / SOURCE_ARCHIVE[3]
    if (
        not archive.is_file()
        or archive.stat().st_size != SOURCE_ARCHIVE[2]
        or sha256_file(archive) != SOURCE_ARCHIVE[1]
    ):
        raise NativeBuildError("stage-only requires the cached source archive to match the pin")
    install = ensure_bounded(build_dir / "install", artifact_root, "install directory")
    output_root = ensure_bounded(
        (args.output_root or artifact_root / "runtime").resolve(), artifact_root, "output root"
    )
    output = ensure_bounded(output_root / target, artifact_root, "runtime output")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage_runtime(install, build_dir, source_root, output, target, cmake_args[6:])
    if target == "android-arm64":
        subprocess.run(
            [
                sys.executable,
                str(REPO_ROOT / "tools/local-inference/fetch_needle_native.py"),
                "--lock-variant", "android-v2",
                "--target", "android-arm64",
                "--output-root", str(output / "needle2"),
            ],
            cwd=REPO_ROOT,
            check=True,
        )
    return output


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=tuple(TARGETS), default="host")
    parser.add_argument("--artifact-root", type=Path, default=ARTIFACT_ROOT)
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--jobs", type=int, default=int(os.environ.get("AURORA_BUILD_JOBS", "1")))
    parser.add_argument("--android-ndk", type=Path)
    parser.add_argument("--android-api", type=int, default=24)
    parser.add_argument(
        "--stage-only",
        action="store_true",
        help="stage an existing matching build without configuring or compiling",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.jobs < 1:
            raise NativeBuildError("--jobs must be a positive integer")
        if args.android_api < 21:
            raise NativeBuildError("--android-api must be at least 21")
        output = stage_existing_build(args) if args.stage_only else build(args)
        if args.target in ("ios-arm64", "ios-simulator-arm64"):
            subprocess.run(
                [
                    sys.executable,
                    str(REPO_ROOT / "tools/local-inference/build_cactus_native.py"),
                    "--artifact-root",
                    str(args.artifact_root.resolve() / "cactus" / "v1.14"),
                    "--llama-runtime-root",
                    str(output),
                    "--jobs",
                    str(args.jobs),
                ],
                cwd=REPO_ROOT,
                check=True,
            )
    except (NativeBuildError, OSError, subprocess.CalledProcessError, tarfile.TarError) as exc:
        print(f"Pinned llama.cpp build failed: {exc}", file=sys.stderr)
        return 1
    print(f"Prepared pinned llama.cpp static runtime: {output}")
    print(f"AURORA_LLAMA_CPP_LIB_DIR={output}")
    print(f"AURORA_LLAMA_CPP_INCLUDE_DIR={output / 'include'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

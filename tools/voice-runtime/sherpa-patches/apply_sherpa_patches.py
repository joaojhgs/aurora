#!/usr/bin/env python3
"""Stage official sherpa-onnx and apply Aurora's pinned downstream patch queue."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
PATCH_DIR = Path(__file__).resolve().parent
SERIES_PATH = PATCH_DIR / "series"
MANIFEST_PATH = REPO_ROOT / "tools/voice-runtime/phase4_manifest.json"
SHERPA_SOURCE_ID = "sherpa-onnx-source-v1.13.5"
PATCH_SHA256 = {
    "0001-pockettts-multilingual-protocol.patch": (
        "e4e745b1568b790e0625f5fd3da3cc131159f1cb73b6dee94fa85e301e60287d"
    ),
    "0002-wasm-tts-neutral-no-preload.patch": (
        "d92ad64c4c00c29ec85df0ec2f1a406eaa605090bed73fb4979f38ead54597f0"
    ),
    "0003-pockettts-fixed-voice-state.patch": (
        "640e64ba79fa038370310ed5bb5530f4c8d801ddc92c82d2feb56333828eb12a"
    ),
    "0004-macos-onnxruntime-release-hash.patch": (
        "92fcf20803338a77bfd43330fa3b438fdfef57c9ededb47dc6def9892be65c52"
    ),
    "0005-wasm-neutral-vad-asr-kws-no-preload.patch": (
        "c5c38c0fd873cd5164300730456c432fc144f21c661e132aa24ee9798172eac4"
    ),
}


class PatchQueueError(RuntimeError):
    """Raised when the staged Sherpa tree cannot be verified or patched."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_source_pin(manifest_path: Path = MANIFEST_PATH) -> dict[str, Any]:
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    for artifact in data.get("artifacts", []):
        if isinstance(artifact, dict) and artifact.get("id") == SHERPA_SOURCE_ID:
            return artifact
    raise PatchQueueError(f"manifest is missing {SHERPA_SOURCE_ID}")


def series_patches() -> list[str]:
    names: list[str] = []
    for raw in SERIES_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        names.append(line)
    if names != list(PATCH_SHA256):
        raise PatchQueueError("series does not match the pinned patch digest map")
    return names


def verify_patches() -> list[dict[str, str]]:
    records = []
    for name in series_patches():
        path = PATCH_DIR / name
        if not path.is_file():
            raise PatchQueueError(f"missing patch {name}")
        digest = sha256_file(path)
        expected = PATCH_SHA256[name]
        if digest != expected:
            raise PatchQueueError(f"patch digest mismatch for {name}: {digest}")
        records.append({"name": name, "sha256": digest})
    return records


def verify_archive(archive: Path, pin: dict[str, Any]) -> None:
    if not archive.is_file():
        raise PatchQueueError(f"missing sherpa archive: {archive}")
    size = archive.stat().st_size
    if size != int(pin["size_bytes"]):
        raise PatchQueueError(f"sherpa archive size mismatch: {size}")
    digest = sha256_file(archive)
    if digest != pin["sha256"]:
        raise PatchQueueError(f"sherpa archive digest mismatch: {digest}")


def extract_archive(archive: Path, staging_root: Path, extraction_name: str) -> Path:
    if staging_root.exists():
        shutil.rmtree(staging_root)
    staging_root.mkdir(parents=True)
    # The SHA-pinned v1.13.5 archive contains two stale absolute symlinks in an
    # unused Go example. Never materialize them, but do not make the verified
    # C++/WASM source archive unusable because of those unrelated entries.
    extract_pinned_source_tar(
        archive,
        staging_root,
        mode="r:gz",
        omit_escaping_symlinks=True,
    )
    extracted = staging_root / extraction_name
    if not extracted.is_dir():
        raise PatchQueueError(f"archive did not extract {extraction_name}")
    return extracted


def extract_pinned_source_tar(
    archive: Path,
    dest: Path,
    *,
    mode: str = "r:*",
    omit_escaping_symlinks: bool = False,
) -> None:
    """Extract a SHA-pinned upstream source tree.

    Language-pack `safe_tar` rejects every link. Official sherpa-onnx ships
    in-tree relative symlinks (Kotlin/Swift API copies). After the archive
    digest is verified, keep those links only when they stay inside dest.
    Traversal, absolute member paths, hardlinks, devices, and FIFOs are always
    rejected. Callers staging the verified official archive may explicitly
    omit escaping symlinks from unused examples instead of materializing them.
    """
    import tarfile

    dest.mkdir(parents=True, exist_ok=True)
    dest_resolved = dest.resolve()
    with tarfile.open(archive, mode) as tar:
        members = [
            member
            for member in tar.getmembers()
            if _pinned_member_is_safe(
                member,
                dest_resolved,
                omit_escaping_symlinks=omit_escaping_symlinks,
            )
        ]
        if hasattr(tarfile, "data_filter"):
            tar.extractall(dest, members=members, filter="data")
            return
        tar.extractall(dest, members=members)


def _pinned_member_is_safe(
    member: Any,
    dest_resolved: Path,
    *,
    omit_escaping_symlinks: bool,
) -> bool:
    name = Path(member.name)
    if name.is_absolute() or ".." in name.parts:
        raise PatchQueueError(f"unsafe tar member path: {member.name}")
    if member.isdev() or member.isfifo() or member.ischr() or member.isblk():
        raise PatchQueueError(f"refusing device member: {member.name}")
    if member.islnk():
        raise PatchQueueError(f"refusing hardlink member: {member.name}")
    target = (dest_resolved / member.name).resolve()
    if dest_resolved not in target.parents and target != dest_resolved:
        raise PatchQueueError(f"unsafe tar member path: {member.name}")
    if member.issym():
        link = Path(member.linkname)
        if link.is_absolute():
            if omit_escaping_symlinks:
                return False
            raise PatchQueueError(f"refusing escaping symlink: {member.name}")
        link_target = (target.parent / link).resolve()
        if dest_resolved not in link_target.parents and link_target != dest_resolved:
            if omit_escaping_symlinks:
                return False
            raise PatchQueueError(f"refusing escaping symlink: {member.name}")
    return True


def apply_patches(source_root: Path) -> None:
    for record in verify_patches():
        patch = PATCH_DIR / record["name"]
        result = subprocess.run(
            [
                "git",
                "-c",
                "core.autocrlf=false",
                "-c",
                "core.eol=lf",
                "apply",
                "--unidiff-zero",
                "--whitespace=error",
                str(patch),
            ],
            cwd=source_root,
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise PatchQueueError(f"failed to apply {record['name']}: {result.stderr.strip()}")


def patched_tree_identity(source_root: Path) -> dict[str, Any]:
    files = [
        "sherpa-onnx/csrc/offline-tts-pocket-model.h",
        "sherpa-onnx/csrc/offline-tts-pocket-model.cc",
        "sherpa-onnx/csrc/offline-tts-pocket-impl.h",
        "wasm/tts/CMakeLists.txt",
        "wasm/vad-asr/CMakeLists.txt",
        "wasm/kws/CMakeLists.txt",
        "cmake/onnxruntime-osx-arm64-static.cmake",
    ]
    records = []
    digest = hashlib.sha256()
    for relative in files:
        path = source_root / relative
        if not path.is_file():
            raise PatchQueueError(f"patched file missing: {relative}")
        file_digest = sha256_file(path)
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(bytes.fromhex(file_digest))
        records.append({"path": relative, "sha256": file_digest})
    return {"sha256": digest.hexdigest(), "files": records}


def stage(
    *,
    archive: Path,
    staging_root: Path,
    manifest_path: Path = MANIFEST_PATH,
) -> dict[str, Any]:
    pin = load_source_pin(manifest_path)
    verify_archive(archive, pin)
    extraction_name = Path(str(pin["extraction_path"])).name
    source_root = extract_archive(archive, staging_root, extraction_name)
    apply_patches(source_root)
    identity = patched_tree_identity(source_root)
    return {
        "upstream": {
            "id": pin["id"],
            "version": pin["version"],
            "commit": pin.get("commit"),
            "url": pin["url"],
            "sha256": pin["sha256"],
        },
        "patches": verify_patches(),
        "source_root": str(source_root),
        "patched_tree": identity,
    }


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--staging-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=MANIFEST_PATH)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = _args()
    report = stage(
        archive=args.archive,
        staging_root=args.staging_root,
        manifest_path=args.manifest,
    )
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(f"patched {report['upstream']['version']} -> {report['source_root']}")
        print(f"patched-tree sha256 {report['patched_tree']['sha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

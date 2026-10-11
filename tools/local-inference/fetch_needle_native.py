"""Stage immutable publisher Needle2 assets; this does not prove target execution."""

from __future__ import annotations

import argparse
import hashlib
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCK_DIR = Path(__file__).parent
LOCK_FILES = {
    "original": LOCK_DIR / "needle2.lock.json",
    "android-v2": LOCK_DIR / "needle2-android.lock.json",
}


def fetch_verified(url: str, destination: Path, size: int, expected_sha256: str) -> None:
    """Reuse a verified file or fetch the exact pinned asset with a bounded size."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        verify_file(destination, size, expected_sha256)
        return
    temporary = destination.with_suffix(destination.suffix + ".partial")
    try:
        digest = hashlib.sha256()
        count = 0
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as output:
            while block := response.read(1024 * 1024):
                count += len(block)
                if count > size:
                    raise ValueError("Publisher asset exceeds its pinned size")
                digest.update(block)
                output.write(block)
        if count != size or digest.hexdigest() != expected_sha256:
            raise ValueError("Publisher asset does not match its immutable pin")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def verify_file(path: Path, size: int, expected_sha256: str) -> None:
    """Require a regular file with the expected publisher size and digest."""
    if path.is_symlink() or not path.is_file() or path.stat().st_size != size:
        raise ValueError(f"Invalid cached asset: {path.name}")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    if digest.hexdigest() != expected_sha256:
        raise ValueError(f"Cached asset checksum differs: {path.name}")


def main() -> None:
    """Fetch one target's library/header and the shared model into the local cache."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock-variant", choices=tuple(LOCK_FILES), default="original")
    parser.add_argument("--target", required=True)
    parser.add_argument("--output-root", type=Path)
    args = parser.parse_args()
    lock = json.loads(LOCK_FILES[args.lock_variant].read_text())
    if args.target not in lock["targets"]:
        parser.error(f"target is not pinned for {args.lock_variant}")
    if args.lock_variant == "android-v2" and args.target != "android-arm64":
        parser.error("android-v2 is pinned only for android-arm64")
    target = lock["targets"][args.target]
    if args.output_root is not None:
        if args.lock_variant != "android-v2" or args.target != "android-arm64":
            parser.error("--output-root is reserved for the pinned Android ARM64 cache")
        artifact_root = (ROOT / ".artifacts/local-inference").resolve()
        cache = args.output_root.resolve()
        try:
            cache.relative_to(artifact_root)
        except ValueError:
            parser.error("--output-root must remain within the local inference artifact cache")
    else:
        cache = ROOT / ".artifacts/local-inference/needle2" / lock["revision"]
    library_root = cache / target["directory"]
    origin = f"https://huggingface.co/{lock['publisher']}/resolve/{lock['revision']}/"
    model = lock["model"]
    fetch_verified(origin + model["path"], cache / model["path"], model["bytes"], model["sha256"])
    fetch_verified(
        origin + target["directory"] + "/libneedle.a",
        library_root / "libneedle.a",
        target["libraryBytes"],
        target["librarySha256"],
    )
    header = lock["header"]
    fetch_verified(
        origin + target["directory"] + "/" + header["name"],
        library_root / header["name"],
        header["bytes"],
        header["sha256"],
    )
    with (library_root / "libneedle.a").open("rb") as archive:
        if archive.read(8) != b"!<arch>\n":
            raise ValueError("Publisher library is not a static archive")
    metadata = {
        "format": 1,
        "link_kind": "static",
        "target": args.target,
        "source": {
            "publisher": lock["publisher"],
            "commit": lock["revision"],
            "archive_sha256": model["sha256"],
            "archive_bytes": model["bytes"],
        },
        "static_libraries": ["libneedle.a"],
        "file_sha256": {"libneedle.a": target["librarySha256"], header["name"]: header["sha256"]},
    }
    (library_root / "aurora-needle-runtime.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Verified pinned assets for {args.target}: {library_root}")
    print("Target link dependencies and runtime execution still require their own main-flow check.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Validate and emit checksum manifests for Sherpa PocketTTS language packs."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
SOURCES_PATH = Path(__file__).resolve().parent / "language_pack_sources.json"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_checksum_manifest(artifact_dir: Path) -> dict[str, Any]:
    sources = json.loads(SOURCES_PATH.read_text(encoding="utf-8"))
    artifacts = []
    for pack in sources["packs"]:
        archive = artifact_dir / f"{pack['pack_id']}.tar.bz2"
        if not archive.is_file():
            raise FileNotFoundError(archive)
        artifacts.append(
            {
                "pack_id": pack["pack_id"],
                "voice_id": pack["voice_id"],
                "language": pack["language"],
                "filename": archive.name,
                "sha256": sha256_file(archive),
                "byte_size": archive.stat().st_size,
            }
        )
    return {
        "schema_version": 1,
        "workflow": "sherpa-pockettts-language-packs",
        "temporary_bootstrap": True,
        "removal_point": sources["removal_point"],
        "artifacts": artifacts,
        "artifact_names": [
            "sherpa-pockettts-language-packs",
            "checksum-manifest.json",
            "SHA256SUMS",
        ],
    }


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--check-workflow", action="store_true")
    return parser.parse_args()


def validate_workflow(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if "pull_request" in text:
        raise ValueError("language-pack workflow must not run on ordinary pull requests")
    if "workflow_dispatch" not in text:
        raise ValueError("language-pack workflow must be explicitly dispatchable")
    if "release_tag" not in text:
        raise ValueError("language-pack workflow must require an existing release tag")
    if "sherpa-pockettts-language-packs" not in text:
        raise ValueError("language-pack workflow name is missing")
    if "gh release upload" not in text or "--clobber" not in text:
        raise ValueError("language-pack workflow must attach durable release assets")
    if "contents: write" not in text:
        raise ValueError("release upload job must have contents write permission")
    if "HF_TOKEN" in text:
        raise ValueError("CI must not select gated weights from HF_TOKEN")
    if "--weights-source public-fixed-voice" not in text:
        raise ValueError("CI convert must pin the public fixed-voice source")


def main() -> int:
    args = _args()
    if args.check_workflow:
        validate_workflow(
            REPO_ROOT / ".github/workflows/sherpa-pockettts-language-packs.yml"
        )
    manifest = build_checksum_manifest(args.artifact_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    checksums = args.output.with_name("SHA256SUMS")
    lines = [f"{item['sha256']}  {item['filename']}\n" for item in manifest["artifacts"]]
    checksums.write_text("".join(lines), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

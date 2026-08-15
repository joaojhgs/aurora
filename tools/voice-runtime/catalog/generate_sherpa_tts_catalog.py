#!/usr/bin/env python3
"""Generate Aurora's metadata-only sherpa-onnx TTS voice catalog."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPOSITORY = "k2-fsa/sherpa-onnx"
RELEASE_API_URL = f"https://api.github.com/repos/{REPOSITORY}/releases/tags/tts-models"
CHECKSUM_URL = f"https://github.com/{REPOSITORY}/releases/download/tts-models/checksum.txt"
EXPECTED_RELEASE_ID = 130_612_623
EXPECTED_RELEASE_TAG = "tts-models"
EXPECTED_CHECKSUM_ASSET_ID = 424_712_825
EXPECTED_CHECKSUM_SHA256 = "30d65b392bba8dfbdbc3479928d3f80adff2c71d4f518ce893d572b8aff021ee"
EXPECTED_PIPER_VOICE_COUNT = 536
EXPECTED_POCKETTTS_ASSET_ID = 353_678_269
EXPECTED_POCKETTTS_ARCHIVE_SHA256 = (
    "2f3b88823cbbb9bf0b2477ec8ae7b3fec417b3a87b6bb5f256dba66f2ad967cb"
)
EXPECTED_LANGUAGE_COUNT = 50
MAX_SOURCE_BYTES = 5 * 1024 * 1024
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

_ARCHIVE_RE = re.compile(r"^vits-piper-([A-Za-z0-9_]+)-(.+)\.tar\.bz2$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_SAFE_SLUG_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_QUALITY_TOKENS = {"x_low", "low", "medium", "high"}
_PRECISION_TOKENS = {"fp16", "fp32", "int8"}
_POCKETTTS_ARCHIVE = "sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2"


class CatalogGenerationError(ValueError):
    """Raised when upstream catalog evidence does not match the pinned release."""


@dataclass(frozen=True)
class CatalogPins:
    """Immutable upstream identities required before catalog generation."""

    release_id: int = EXPECTED_RELEASE_ID
    release_tag: str = EXPECTED_RELEASE_TAG
    checksum_asset_id: int = EXPECTED_CHECKSUM_ASSET_ID
    checksum_sha256: str = EXPECTED_CHECKSUM_SHA256
    expected_voice_count: int = EXPECTED_PIPER_VOICE_COUNT
    expected_language_count: int = EXPECTED_LANGUAGE_COUNT
    pockettts_asset_id: int | None = EXPECTED_POCKETTTS_ASSET_ID
    pockettts_archive_sha256: str | None = EXPECTED_POCKETTTS_ARCHIVE_SHA256


DEFAULT_PINS = CatalogPins()


def _read_url(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "AuroraVoiceCatalogGenerator/1",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
        payload = response.read(MAX_SOURCE_BYTES + 1)
    if len(payload) > MAX_SOURCE_BYTES:
        raise CatalogGenerationError("upstream catalog evidence exceeds the size limit")
    return payload


def _read_source(path: Path | None, url: str) -> bytes:
    payload = path.read_bytes() if path is not None else _read_url(url)
    if len(payload) > MAX_SOURCE_BYTES:
        raise CatalogGenerationError("upstream catalog evidence exceeds the size limit")
    return payload


def _parse_checksums(payload: bytes, pins: CatalogPins) -> dict[str, str]:
    digest = hashlib.sha256(payload).hexdigest()
    if digest != pins.checksum_sha256:
        raise CatalogGenerationError("checksum index digest does not match the pinned release")
    try:
        lines = payload.decode("utf-8").splitlines()
    except UnicodeDecodeError as exc:
        raise CatalogGenerationError("checksum index is not UTF-8") from exc
    checksums: dict[str, str] = {}
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        fields = line.split()
        if len(fields) != 2:
            raise CatalogGenerationError(f"invalid checksum row {line_number}")
        name, sha256 = fields
        if not _SAFE_SLUG_RE.fullmatch(name) or not _SHA256_RE.fullmatch(sha256):
            raise CatalogGenerationError(f"invalid checksum row {line_number}")
        if name in checksums:
            raise CatalogGenerationError(f"duplicate checksum entry: {name}")
        checksums[name] = sha256
    return checksums


def _release_object(payload: bytes) -> dict[str, Any]:
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CatalogGenerationError("release metadata is invalid JSON") from exc
    if not isinstance(value, dict):
        raise CatalogGenerationError("release metadata must be an object")
    return value


def _parse_voice_name(filename: str) -> tuple[str, str, str | None, str | None]:
    match = _ARCHIVE_RE.fullmatch(filename)
    if match is None:
        raise CatalogGenerationError(f"unsafe Piper archive name: {filename}")
    locale_token, voice_token = match.groups()
    language = locale_token.lower().replace("_", "-")
    if not re.fullmatch(r"[a-z]{2,8}(?:-[a-z0-9]{1,8})*", language):
        raise CatalogGenerationError(f"invalid Piper language tag: {locale_token}")
    parts = voice_token.split("-")
    precision = parts[-1].lower() if parts[-1].lower() in _PRECISION_TOKENS else None
    quality_index = -2 if precision is not None else -1
    quality = (
        parts[quality_index].lower() if parts[quality_index].lower() in _QUALITY_TOKENS else None
    )
    return language, voice_token, quality, precision


def _validated_archive(asset: dict[str, Any], checksum: str) -> dict[str, Any]:
    name = asset.get("name")
    size = asset.get("size")
    url = asset.get("browser_download_url")
    updated_at = asset.get("updated_at")
    asset_id = asset.get("id")
    if not isinstance(name, str):
        raise CatalogGenerationError("release asset name is missing")
    expected_url = f"https://github.com/{REPOSITORY}/releases/download/tts-models/{name}"
    if url != expected_url:
        raise CatalogGenerationError(f"unexpected download URL for {name}")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= MAX_ARCHIVE_BYTES:
        raise CatalogGenerationError(f"invalid archive size for {name}")
    if not isinstance(asset_id, int) or isinstance(asset_id, bool) or asset_id <= 0:
        raise CatalogGenerationError(f"invalid asset id for {name}")
    if not isinstance(updated_at, str) or not updated_at:
        raise CatalogGenerationError(f"missing update time for {name}")
    if not _SHA256_RE.fullmatch(checksum):
        raise CatalogGenerationError(f"invalid archive checksum for {name}")
    archive_root = name.removesuffix(".tar.bz2")
    return {
        "asset_id": asset_id,
        "filename": name,
        "url": url,
        "byte_size": size,
        "sha256": checksum,
        "format": "tar_bzip2",
        "root": archive_root,
        "updated_at": updated_at,
    }


def _catalog_entry(asset: dict[str, Any], checksum: str) -> dict[str, Any]:
    archive = _validated_archive(asset, checksum)
    name = archive["filename"]
    archive_root = archive["root"]
    language, voice_token, quality, precision = _parse_voice_name(name)
    model_stem = archive_root.removeprefix("vits-piper-")
    voice_slug = model_stem.lower()
    if len(voice_slug) > 64 or not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", voice_slug):
        raise CatalogGenerationError(f"invalid Aurora voice id component for {name}")
    display_voice = " ".join(part for part in voice_token.replace("_", " ").split("-") if part)
    return {
        "voice_id": f"standard:piper:{voice_slug}",
        "display_name": display_voice,
        "language": language,
        "quality": quality,
        "precision": precision,
        "engine": "sherpa_onnx",
        "model_family": "vits_piper",
        "archive": archive,
        "bindings": {
            "model": f"{archive_root}/{model_stem}.onnx",
            "config": f"{archive_root}/{model_stem}.onnx.json",
            "tokens": f"{archive_root}/tokens.txt",
            "data_dir": f"{archive_root}/espeak-ng-data",
            "model_card": f"{archive_root}/MODEL_CARD",
        },
        "terms": {
            "source": "upstream_model_card",
            "redistributed_by_aurora": False,
            "download_initiated_by_user": True,
        },
    }


def _pockettts_catalog_entry(
    asset: dict[str, Any],
    checksum: str,
    *,
    expected_asset_id: int,
    expected_sha256: str,
) -> dict[str, Any]:
    archive = _validated_archive(asset, checksum)
    if archive["filename"] != _POCKETTTS_ARCHIVE:
        raise CatalogGenerationError("PocketTTS archive name does not match the pin")
    if archive["asset_id"] != expected_asset_id:
        raise CatalogGenerationError("PocketTTS asset identity does not match the pin")
    if archive["sha256"] != expected_sha256:
        raise CatalogGenerationError("PocketTTS archive digest does not match the pin")
    archive_root = archive["root"]
    return {
        "voice_id": "standard:pockettts:sherpa-onnx-pocket-tts-int8-2026-01-26",
        "display_name": "PocketTTS English int8",
        "language": "en-us",
        "quality": None,
        "precision": "int8",
        "engine": "sherpa_onnx",
        "model_family": "pockettts",
        "sample_rate_hz": 24_000,
        "archive": archive,
        "bindings": {
            "decoder": f"{archive_root}/decoder.int8.onnx",
            "encoder": f"{archive_root}/encoder.onnx",
            "lm_flow": f"{archive_root}/lm_flow.int8.onnx",
            "lm_main": f"{archive_root}/lm_main.int8.onnx",
            "model_card": f"{archive_root}/README.md",
            "text_conditioner": f"{archive_root}/text_conditioner.onnx",
            "token_scores_json": f"{archive_root}/token_scores.json",
            "vocab_json": f"{archive_root}/vocab.json",
        },
        "terms": {
            "source": "upstream_model_card_restricted_non_commercial",
            "redistributed_by_aurora": False,
            "download_initiated_by_user": True,
        },
    }


def build_catalog(
    release_payload: bytes,
    checksum_payload: bytes,
    *,
    pins: CatalogPins = DEFAULT_PINS,
) -> dict[str, Any]:
    """Build a deterministic metadata-only catalog from pinned GitHub evidence."""

    release = _release_object(release_payload)
    if release.get("id") != pins.release_id or release.get("tag_name") != pins.release_tag:
        raise CatalogGenerationError("release identity does not match the pinned release")
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise CatalogGenerationError("release assets are missing")
    checksum_assets = [asset for asset in assets if asset.get("name") == "checksum.txt"]
    if len(checksum_assets) != 1 or checksum_assets[0].get("id") != pins.checksum_asset_id:
        raise CatalogGenerationError("checksum asset identity does not match the pinned release")
    checksums = _parse_checksums(checksum_payload, pins)
    entries: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    seen_voice_ids: set[str] = set()
    for raw_asset in assets:
        if not isinstance(raw_asset, dict):
            raise CatalogGenerationError("release asset must be an object")
        name = raw_asset.get("name")
        if not isinstance(name, str) or not name.startswith("vits-piper-"):
            continue
        if not name.endswith(".tar.bz2"):
            raise CatalogGenerationError(f"unsupported Piper archive format: {name}")
        if name in seen_names:
            raise CatalogGenerationError(f"duplicate release asset: {name}")
        seen_names.add(name)
        checksum = checksums.get(name)
        if checksum is None:
            raise CatalogGenerationError(f"Piper archive is missing a checksum: {name}")
        entry = _catalog_entry(raw_asset, checksum)
        if entry["voice_id"] in seen_voice_ids:
            raise CatalogGenerationError(f"duplicate Aurora voice id: {entry['voice_id']}")
        seen_voice_ids.add(entry["voice_id"])
        entries.append(entry)
    if len(entries) != pins.expected_voice_count:
        raise CatalogGenerationError(
            f"expected {pins.expected_voice_count} Piper voices, found {len(entries)}"
        )
    pockettts_pins = (pins.pockettts_asset_id, pins.pockettts_archive_sha256)
    if (pockettts_pins[0] is None) != (pockettts_pins[1] is None):
        raise CatalogGenerationError("PocketTTS asset and digest pins must be configured together")
    if pins.pockettts_asset_id is not None and pins.pockettts_archive_sha256 is not None:
        pockettts_assets = [asset for asset in assets if asset.get("name") == _POCKETTTS_ARCHIVE]
        if len(pockettts_assets) != 1:
            raise CatalogGenerationError("pinned PocketTTS release asset is missing or duplicated")
        pockettts_checksum = checksums.get(_POCKETTTS_ARCHIVE)
        if pockettts_checksum is None:
            raise CatalogGenerationError("PocketTTS archive is missing a checksum")
        pockettts_entry = _pockettts_catalog_entry(
            pockettts_assets[0],
            pockettts_checksum,
            expected_asset_id=pins.pockettts_asset_id,
            expected_sha256=pins.pockettts_archive_sha256,
        )
        if pockettts_entry["voice_id"] in seen_voice_ids:
            raise CatalogGenerationError(
                f"duplicate Aurora voice id: {pockettts_entry['voice_id']}"
            )
        entries.append(pockettts_entry)
    entries.sort(key=lambda entry: entry["voice_id"])
    languages = sorted({entry["language"] for entry in entries})
    if len(languages) != pins.expected_language_count:
        raise CatalogGenerationError(
            f"expected {pins.expected_language_count} languages, found {len(languages)}"
        )
    entries_payload = json.dumps(entries, separators=(",", ":"), sort_keys=True).encode()
    checksum_asset = checksum_assets[0]
    return {
        "schema_version": 1,
        "catalog_id": "sherpa-onnx-tts-models-v1",
        "revision": f"github-release-{pins.release_id}-{pins.checksum_sha256[:16]}",
        "source": {
            "repository": REPOSITORY,
            "release_id": pins.release_id,
            "tag": pins.release_tag,
            "published_at": release.get("published_at"),
            "checksum_asset_id": pins.checksum_asset_id,
            "checksum_asset_updated_at": checksum_asset.get("updated_at"),
            "checksum_sha256": pins.checksum_sha256,
        },
        "entries_sha256": hashlib.sha256(entries_payload).hexdigest(),
        "languages": languages,
        "entries": entries,
    }


def _render(catalog: dict[str, Any]) -> bytes:
    return (json.dumps(catalog, indent=2, sort_keys=True) + "\n").encode()


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-json", type=Path)
    parser.add_argument("--checksum-file", type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("rust/crates/aurora-voice-engine/resources/sherpa_onnx_tts_catalog.json"),
    )
    parser.add_argument("--check", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = _args()
    release_payload = _read_source(args.release_json, RELEASE_API_URL)
    checksum_payload = _read_source(args.checksum_file, CHECKSUM_URL)
    rendered = _render(build_catalog(release_payload, checksum_payload))
    if args.check:
        if not args.output.is_file() or args.output.read_bytes() != rendered:
            print(f"generated catalog is stale: {args.output}", file=sys.stderr)
            return 1
        return 0
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

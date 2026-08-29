#!/usr/bin/env python3
"""Generate Aurora's metadata-only sherpa-onnx STT, VAD, and KWS catalog."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SHERPA_REPOSITORY = "k2-fsa/sherpa-onnx"
ASR_RELEASE_API_URL = f"https://api.github.com/repos/{SHERPA_REPOSITORY}/releases/tags/asr-models"
ASR_CHECKSUM_URL = (
    f"https://github.com/{SHERPA_REPOSITORY}/releases/download/asr-models/checksum.txt"
)
KWS_RELEASE_API_URL = f"https://api.github.com/repos/{SHERPA_REPOSITORY}/releases/tags/kws-models"
KWS_CHECKSUM_URL = (
    f"https://github.com/{SHERPA_REPOSITORY}/releases/download/kws-models/checksum.txt"
)
WHISPER_REPOSITORY = "openai/whisper"
WHISPER_LANGUAGE_COMMIT = "5f86d1d86363843179951550570367b37c5d6f78"
WHISPER_LANGUAGE_PATH = "whisper/tokenizer.py"
WHISPER_LANGUAGE_URL = (
    "https://raw.githubusercontent.com/"
    f"{WHISPER_REPOSITORY}/{WHISPER_LANGUAGE_COMMIT}/{WHISPER_LANGUAGE_PATH}"
)
WHISPER_LANGUAGE_SHA256 = "3b48e361a7e95b4ec0356ca6d72bba635778aa10269153136ee7bc34cae30b85"

MAX_SOURCE_BYTES = 5 * 1024 * 1024
MAX_ARCHIVE_BYTES = 3 * 1024 * 1024 * 1024
MAX_DIRECT_MODEL_BYTES = 16 * 1024 * 1024
EXPECTED_STT_COUNT = 12
EXPECTED_VAD_COUNT = 4
EXPECTED_KWS_COUNT = 3
EXPECTED_WHISPER_LANGUAGE_COUNT = 100

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_LANGUAGE_RE = re.compile(r"^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$")
_WHISPER_ARCHIVE_RE = re.compile(
    r"^sherpa-onnx-whisper-"
    r"(tiny(?:\.en)?|base(?:\.en)?|small(?:\.en)?|medium(?:\.en)?|"
    r"large-v1|large-v2|large-v3|turbo)\.tar\.bz2$"
)
_VAD_MODELS = {
    "silero_vad.int8.onnx": ("vad:silero:current-int8", "Silero VAD (compact)"),
    "silero_vad.onnx": ("vad:silero:current", "Silero VAD"),
    "silero_vad_v4.onnx": ("vad:silero:v4", "Silero VAD v4"),
    "silero_vad_v5.onnx": ("vad:silero:v5", "Silero VAD v5"),
}
_KWS_MODELS = {
    # The upstream `-mobile` KWS archives are batch-one graph conversions.
    # Aurora's streaming keyword decoder does not preserve that constraint:
    # sherpa-onnx 1.13.5 reaches a two-hypothesis decode and the compact graph
    # aborts in `/downsample/Reshape_1`. Keep the canonical full archives in
    # the runtime catalog until the exact quantized native smoke passes.
    "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2": (
        "kws:zipformer:gigaspeech",
        "English wake words",
        ["en"],
        False,
        12,
    ),
    "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2": (
        "kws:zipformer:wenetspeech",
        "Chinese wake words",
        ["zh"],
        False,
        12,
    ),
    "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2": (
        "kws:zipformer:zh-en-2025",
        "Chinese and English wake words",
        ["en", "zh"],
        False,
        13,
    ),
}


class CatalogGenerationError(ValueError):
    """Raised when upstream catalog evidence does not match compiled pins."""


@dataclass(frozen=True)
class ReleasePins:
    """Immutable upstream identities required before catalog generation."""

    release_id: int
    release_tag: str
    checksum_asset_id: int
    checksum_sha256: str


ASR_PINS = ReleasePins(
    release_id=130_628_817,
    release_tag="asr-models",
    checksum_asset_id=424_735_889,
    checksum_sha256=("4e34edcb64434bcf533afaee9dcc14b5b2f9c277ed3a745f263e79a4464b28d0"),
)
KWS_PINS = ReleasePins(
    release_id=145_831_594,
    release_tag="kws-models",
    checksum_asset_id=424_703_304,
    checksum_sha256=("284637b2b9fec1287aca10315dcc960710c6ec14224fb1dfa9fe427e77eb6c18"),
)


def _read_url(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "AuroraSpeechCatalogGenerator/1",
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


def _parse_checksums(payload: bytes, pins: ReleasePins) -> dict[str, str]:
    if hashlib.sha256(payload).hexdigest() != pins.checksum_sha256:
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
        filename, sha256 = fields
        if (
            not _SAFE_FILENAME_RE.fullmatch(filename)
            or not _SHA256_RE.fullmatch(sha256)
            or filename in checksums
        ):
            raise CatalogGenerationError(f"invalid checksum row {line_number}")
        checksums[filename] = sha256
    return checksums


def _parse_release(payload: bytes, pins: ReleasePins) -> tuple[dict[str, Any], list[Any]]:
    try:
        release = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CatalogGenerationError("release metadata is invalid JSON") from exc
    if not isinstance(release, dict):
        raise CatalogGenerationError("release metadata must be an object")
    if release.get("id") != pins.release_id or release.get("tag_name") != pins.release_tag:
        raise CatalogGenerationError("release identity does not match the pinned release")
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise CatalogGenerationError("release assets are missing")
    checksum_assets = [asset for asset in assets if asset.get("name") == "checksum.txt"]
    if len(checksum_assets) != 1 or checksum_assets[0].get("id") != pins.checksum_asset_id:
        raise CatalogGenerationError("checksum asset identity does not match the pinned release")
    return release, assets


def _parse_whisper_languages(payload: bytes) -> list[str]:
    if hashlib.sha256(payload).hexdigest() != WHISPER_LANGUAGE_SHA256:
        raise CatalogGenerationError("Whisper language source digest does not match its pin")
    try:
        tree = ast.parse(payload.decode("utf-8"), filename=WHISPER_LANGUAGE_PATH)
    except (UnicodeDecodeError, SyntaxError) as exc:
        raise CatalogGenerationError("Whisper language source is invalid") from exc
    dictionaries = [
        node.value
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name) and target.id == "LANGUAGES" for target in node.targets
        )
    ]
    if len(dictionaries) != 1:
        raise CatalogGenerationError("Whisper language table is missing")
    try:
        value = ast.literal_eval(dictionaries[0])
    except (ValueError, TypeError) as exc:
        raise CatalogGenerationError("Whisper language table is not literal data") from exc
    if not isinstance(value, dict) or any(
        not isinstance(code, str)
        or not isinstance(name, str)
        or not _LANGUAGE_RE.fullmatch(code)
        or not name.strip()
        for code, name in value.items()
    ):
        raise CatalogGenerationError("Whisper language table is invalid")
    languages = sorted(value)
    if len(languages) != EXPECTED_WHISPER_LANGUAGE_COUNT:
        raise CatalogGenerationError("Whisper language count does not match its pin")
    return languages


def _asset_metadata(
    asset: dict[str, Any],
    checksums: dict[str, str],
    *,
    release_tag: str,
    archive: bool,
) -> dict[str, Any]:
    filename = asset.get("name")
    asset_id = asset.get("id")
    byte_size = asset.get("size")
    url = asset.get("browser_download_url")
    updated_at = asset.get("updated_at")
    if not isinstance(filename, str) or not _SAFE_FILENAME_RE.fullmatch(filename):
        raise CatalogGenerationError("release asset name is unsafe")
    expected_url = (
        f"https://github.com/{SHERPA_REPOSITORY}/releases/download/{release_tag}/{filename}"
    )
    byte_limit = MAX_ARCHIVE_BYTES if archive else MAX_DIRECT_MODEL_BYTES
    sha256 = checksums.get(filename)
    if (
        not isinstance(asset_id, int)
        or isinstance(asset_id, bool)
        or asset_id <= 0
        or not isinstance(byte_size, int)
        or isinstance(byte_size, bool)
        or not 0 < byte_size <= byte_limit
        or url != expected_url
        or not isinstance(updated_at, str)
        or not updated_at
        or sha256 is None
    ):
        raise CatalogGenerationError(f"invalid release metadata for {filename}")
    root = filename.removesuffix(".tar.bz2") if archive else None
    return {
        "asset_id": asset_id,
        "filename": filename,
        "url": url,
        "byte_size": byte_size,
        "sha256": sha256,
        "format": "tar_bzip2" if archive else "file",
        "root": root,
        "updated_at": updated_at,
    }


def _terms() -> dict[str, Any]:
    return {
        "source": "upstream_release_checksums",
        "redistributed_by_aurora": False,
        "download_initiated_by_user": True,
    }


def _stt_entries(
    assets: list[Any], checksums: dict[str, str], languages: list[str]
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for raw_asset in assets:
        if not isinstance(raw_asset, dict):
            raise CatalogGenerationError("release asset must be an object")
        filename = raw_asset.get("name")
        if not isinstance(filename, str):
            raise CatalogGenerationError("release asset name is missing")
        match = _WHISPER_ARCHIVE_RE.fullmatch(filename)
        if match is None:
            continue
        model = match.group(1)
        root = filename.removesuffix(".tar.bz2")
        model_languages = ["en"] if model.endswith(".en") else languages
        entries.append(
            {
                "model_id": f"stt:whisper:{model}",
                "display_name": f"Whisper {model}",
                "task": "speech_to_text",
                "languages": model_languages,
                "language_scope": "specific" if model.endswith(".en") else "multilingual",
                "engine": "sherpa_onnx",
                "model_family": "whisper",
                "archive": _asset_metadata(
                    raw_asset, checksums, release_tag="asr-models", archive=True
                ),
                "bindings": {
                    "encoder": f"{root}/{model}-encoder.int8.onnx",
                    "decoder": f"{root}/{model}-decoder.int8.onnx",
                    "tokens": f"{root}/{model}-tokens.txt",
                },
                "terms": _terms(),
            }
        )
    if len(entries) != EXPECTED_STT_COUNT:
        raise CatalogGenerationError(
            f"expected {EXPECTED_STT_COUNT} Whisper models, found {len(entries)}"
        )
    return entries


def _vad_entries(assets: list[Any], checksums: dict[str, str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for raw_asset in assets:
        if not isinstance(raw_asset, dict):
            raise CatalogGenerationError("release asset must be an object")
        filename = raw_asset.get("name")
        if not isinstance(filename, str):
            raise CatalogGenerationError("release asset name is missing")
        model = _VAD_MODELS.get(filename)
        if model is None:
            continue
        model_id, display_name = model
        entries.append(
            {
                "model_id": model_id,
                "display_name": display_name,
                "task": "voice_activity_detection",
                "languages": [],
                "language_scope": "language_independent",
                "engine": "sherpa_onnx",
                "model_family": "silero_vad",
                "archive": _asset_metadata(
                    raw_asset, checksums, release_tag="asr-models", archive=False
                ),
                "bindings": {"model": filename},
                "terms": _terms(),
            }
        )
    if len(entries) != EXPECTED_VAD_COUNT:
        raise CatalogGenerationError(
            f"expected {EXPECTED_VAD_COUNT} VAD models, found {len(entries)}"
        )
    return entries


def _kws_entries(assets: list[Any], checksums: dict[str, str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for raw_asset in assets:
        if not isinstance(raw_asset, dict):
            raise CatalogGenerationError("release asset must be an object")
        filename = raw_asset.get("name")
        if not isinstance(filename, str):
            raise CatalogGenerationError("release asset name is missing")
        model = _KWS_MODELS.get(filename)
        if model is None:
            continue
        model_id, display_name, languages, mobile, epoch = model
        root = filename.removesuffix(".tar.bz2")
        model_stem = f"epoch-{epoch}-avg-2-chunk-16-left-64"
        bindings = {
            "encoder": f"{root}/encoder-{model_stem}.int8.onnx",
            "decoder": f"{root}/decoder-{model_stem}.onnx",
            "joiner": f"{root}/joiner-{model_stem}.int8.onnx",
            "tokens": f"{root}/tokens.txt",
        }
        if model_id.startswith("kws:zipformer:gigaspeech"):
            bindings["tokenizer"] = f"{root}/bpe.model"
        if model_id == "kws:zipformer:zh-en-2025":
            bindings["lexicon"] = f"{root}/en.phone"
        entries.append(
            {
                "model_id": model_id,
                "display_name": display_name,
                "task": "keyword_spotting",
                "languages": languages,
                "language_scope": "specific",
                "engine": "sherpa_onnx",
                "model_family": "zipformer",
                "mobile_optimized": mobile,
                "archive": _asset_metadata(
                    raw_asset, checksums, release_tag="kws-models", archive=True
                ),
                "bindings": bindings,
                "terms": _terms(),
            }
        )
    if len(entries) != EXPECTED_KWS_COUNT:
        raise CatalogGenerationError(
            f"expected {EXPECTED_KWS_COUNT} KWS models, found {len(entries)}"
        )
    return entries


def _source(release: dict[str, Any], assets: list[Any], pins: ReleasePins) -> dict[str, Any]:
    checksum_asset = next(asset for asset in assets if asset.get("name") == "checksum.txt")
    return {
        "repository": SHERPA_REPOSITORY,
        "release_id": pins.release_id,
        "tag": pins.release_tag,
        "published_at": release.get("published_at"),
        "checksum_asset_id": pins.checksum_asset_id,
        "checksum_asset_updated_at": checksum_asset.get("updated_at"),
        "checksum_sha256": pins.checksum_sha256,
    }


def build_catalog(
    asr_release_payload: bytes,
    asr_checksum_payload: bytes,
    kws_release_payload: bytes,
    kws_checksum_payload: bytes,
    whisper_language_payload: bytes,
    *,
    asr_pins: ReleasePins = ASR_PINS,
    kws_pins: ReleasePins = KWS_PINS,
) -> dict[str, Any]:
    """Build deterministic metadata for exact, user-selected speech model downloads."""

    asr_release, asr_assets = _parse_release(asr_release_payload, asr_pins)
    kws_release, kws_assets = _parse_release(kws_release_payload, kws_pins)
    asr_checksums = _parse_checksums(asr_checksum_payload, asr_pins)
    kws_checksums = _parse_checksums(kws_checksum_payload, kws_pins)
    languages = _parse_whisper_languages(whisper_language_payload)
    entries = [
        *_stt_entries(asr_assets, asr_checksums, languages),
        *_vad_entries(asr_assets, asr_checksums),
        *_kws_entries(kws_assets, kws_checksums),
    ]
    entries.sort(key=lambda entry: entry["model_id"])
    model_ids = [entry["model_id"] for entry in entries]
    if len(model_ids) != len(set(model_ids)):
        raise CatalogGenerationError("speech catalog contains duplicate model ids")
    entries_payload = json.dumps(entries, separators=(",", ":"), sort_keys=True).encode()
    return {
        "schema_version": 1,
        "catalog_id": "sherpa-onnx-speech-models-v1",
        "revision": (
            f"github-releases-{asr_pins.release_id}-{kws_pins.release_id}-"
            f"{asr_pins.checksum_sha256[:8]}-{kws_pins.checksum_sha256[:8]}"
        ),
        "sources": {
            "asr": _source(asr_release, asr_assets, asr_pins),
            "kws": _source(kws_release, kws_assets, kws_pins),
            "whisper_languages": {
                "repository": WHISPER_REPOSITORY,
                "commit": WHISPER_LANGUAGE_COMMIT,
                "path": WHISPER_LANGUAGE_PATH,
                "sha256": WHISPER_LANGUAGE_SHA256,
            },
        },
        "entries_sha256": hashlib.sha256(entries_payload).hexdigest(),
        "languages": languages,
        "entries": entries,
    }


def _render(catalog: dict[str, Any]) -> bytes:
    return (json.dumps(catalog, indent=2, sort_keys=True) + "\n").encode()


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asr-release-json", type=Path)
    parser.add_argument("--asr-checksum-file", type=Path)
    parser.add_argument("--kws-release-json", type=Path)
    parser.add_argument("--kws-checksum-file", type=Path)
    parser.add_argument("--whisper-tokenizer", type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("rust/crates/aurora-voice-engine/resources/sherpa_onnx_speech_catalog.json"),
    )
    parser.add_argument("--check", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = _args()
    rendered = _render(
        build_catalog(
            _read_source(args.asr_release_json, ASR_RELEASE_API_URL),
            _read_source(args.asr_checksum_file, ASR_CHECKSUM_URL),
            _read_source(args.kws_release_json, KWS_RELEASE_API_URL),
            _read_source(args.kws_checksum_file, KWS_CHECKSUM_URL),
            _read_source(args.whisper_tokenizer, WHISPER_LANGUAGE_URL),
        )
    )
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

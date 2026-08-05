#!/usr/bin/env python3
"""W0 PocketTTS-Raven provenance, conversion, and benchmark gates."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

RAVEN_UPSTREAM_COMMIT = "abd26158ab50f954616eaf42296b09c4856489d7"
KYUTAI_POCKET_TTS_V2_1_0_COMMIT = "058886528d0b6f2f2d4022de2e244a5260729e6e"
COMMUNITY_ONNX_MAIN_COMMIT = "58a6d00cf13d239b6748cb0769f35c580a8f606c"
SIBLING_HEAD = "7342bb0fbe2af04b66b6e54c17b4ac8f765eb989"
REPO_ROOT = Path(__file__).resolve().parents[2]

REQUIRED_PACKS = {
    "english_2026-04": {"language": "en", "layers": 6, "state_slots": 18, "tier": "compact"},
    "portuguese": {"language": "pt", "layers": 6, "state_slots": 18, "tier": "compact"},
    "french_24l": {"language": "fr", "layers": 24, "state_slots": 72, "tier": "quality"},
}

REQUIRED_ASSETS = (
    "tokenizer.model",
    "spm_vocab.json",
    "text_conditioner.onnx",
    "flow_lm_main_int8.onnx",
    "flow_lm_flow_int8.onnx",
    "mimi_decoder_int8.onnx",
    "bos_before_voice.npy",
)

SIBLING_FILES = (
    "public/assistant/pocket-tts/UPSTREAM.md",
    "public/assistant/pocket-tts/LICENSE",
    "public/assistant/pocket-tts/THIRD_PARTY_NOTICES.md",
    "public/assistant/pocket-tts/src/tts-worker-native.js",
    "public/assistant/pocket-tts/src/playback-worklet.js",
    "public/assistant/pocket-tts/src/engine/tokenizer.js",
    "public/assistant/pocket-tts/src/engine/silence.js",
    "public/assistant/pocket-tts/models/spm_vocab.json",
    "public/assistant/pocket-tts/models/bos_before_voice.npy",
    "public/assistant/pocket-tts/presets/joao.emb",
    "src/features/assistant/audio/pocket-tts.ts",
    "src/features/assistant/audio/pocket-tts-playback.ts",
)


class GateError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path | None, payload: dict[str, Any]) -> None:
    payload = sanitize_report(payload)
    if path is None:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def sanitize_report(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: sanitize_report(item) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize_report(item) for item in value]
    if isinstance(value, str):
        repo = str(REPO_ROOT)
        home = str(Path.home())
        if value.startswith(repo) or value.startswith(home):
            return public_path(value)
    return value


def public_path(path: Path | str | None) -> str | None:
    if path is None:
        return None
    raw = Path(path)
    try:
        resolved = raw.resolve(strict=False)
    except OSError:
        resolved = raw
    try:
        return resolved.relative_to(REPO_ROOT).as_posix() or "."
    except ValueError:
        pass
    home = Path.home().resolve()
    try:
        return f"~/{resolved.relative_to(home).as_posix()}"
    except ValueError:
        return str(raw) if not raw.is_absolute() else "<outside-repo>"


def load_manifest(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    validate_manifest_data(data)
    return data


def validate_manifest_data(data: dict[str, Any]) -> None:
    errors: list[str] = []
    if data.get("schema_version") != 1:
        errors.append("schema_version must be 1")

    expected_sources = {
        "pocket_tts_raven": RAVEN_UPSTREAM_COMMIT,
        "kyutai_pocket_tts_v2_1_0": KYUTAI_POCKET_TTS_V2_1_0_COMMIT,
        "community_onnx_mirror": COMMUNITY_ONNX_MAIN_COMMIT,
        "sibling_sperandiodev": SIBLING_HEAD,
    }
    sources = data.get("sources", {})
    for key, commit in expected_sources.items():
        got = sources.get(key, {}).get("commit")
        if got != commit:
            errors.append(f"sources.{key}.commit expected {commit}, got {got!r}")

    packs = data.get("packs", {})
    for pack_id, expected in REQUIRED_PACKS.items():
        pack = packs.get(pack_id)
        if not isinstance(pack, dict):
            errors.append(f"missing pack {pack_id}")
            continue
        for key, value in expected.items():
            if pack.get(key) != value:
                errors.append(f"{pack_id}.{key} expected {value!r}, got {pack.get(key)!r}")
        if pack.get("state_slots") != pack.get("layers", 0) * 3:
            errors.append(f"{pack_id}.state_slots must equal layers * 3")
        if pack_id == "french_24l" and pack.get("claims_compact") is not False:
            errors.append("french_24l must not claim compact support")
        assets = pack.get("assets", {})
        for asset_name in REQUIRED_ASSETS:
            asset = assets.get(asset_name)
            if not isinstance(asset, dict):
                errors.append(f"{pack_id}.assets.{asset_name} missing")
                continue
            digest = asset.get("sha256")
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}|TBD:[a-z0-9_.-]+", digest):
                errors.append(f"{pack_id}.assets.{asset_name}.sha256 must be sha256 or TBD marker")
            if "size_bytes" not in asset:
                errors.append(f"{pack_id}.assets.{asset_name}.size_bytes missing")

    if errors:
        raise GateError("; ".join(errors))


def command_manifest(args: argparse.Namespace) -> int:
    data = load_manifest(args.manifest)
    readiness = manifest_readiness(data)
    status = "ready" if readiness["unpinned_asset_count"] == 0 else "incomplete"
    write_json(
        args.output,
        {
            "status": status,
            "checked_at_unix": int(time.time()),
            "manifest": public_path(args.manifest),
            "pack_count": len(data["packs"]),
            "required_packs": sorted(REQUIRED_PACKS),
            "readiness": readiness,
        },
    )
    return 0 if status == "ready" else 2


def manifest_readiness(data: dict[str, Any]) -> dict[str, Any]:
    unpinned: list[dict[str, str]] = []
    pinned = 0
    for pack_id, pack in data.get("packs", {}).items():
        for asset_name, asset in pack.get("assets", {}).items():
            digest = asset.get("sha256", "")
            if isinstance(digest, str) and digest.startswith("TBD:"):
                unpinned.append({"pack": pack_id, "asset": asset_name, "marker": digest})
            else:
                pinned += 1
    return {
        "pinned_asset_count": pinned,
        "unpinned_asset_count": len(unpinned),
        "unpinned_assets": unpinned,
        "release_ready": len(unpinned) == 0,
    }


ASSUMPTION_PATTERNS: tuple[tuple[str, re.Pattern[str], str], ...] = (
    ("english_only", re.compile(r"english_2026-04|spm_vocab\.json|MODEL_BASE|BUNDLE_URL"), "replace with manifest-selected language pack"),
    ("six_layer_or_state_count", re.compile(r"\blsdSteps\b|state_17|18 state|layers 6|--layers 6|range\(6\)"), "derive layer/state count from graph/config"),
    ("graph_identity", re.compile(r"flow_lm_main_delta_attn_flow|flow_lm_main_delta_attn_int8|mimi_decoder_delta_int8|mimi_decoder_delta_convtr"), "drive graph set from pack tier/runtime target"),
    ("cache_or_memory", re.compile(r"SharedArrayBuffer|growth|768MB|1\.5GB|cache|prewarm|pool"), "preserve useful memory/cache pattern after resource gates"),
    ("cancellation", re.compile(r"stop|stream_stop|AbortError|activeSpeechId|session"), "preserve cancellation/session isolation"),
    ("clone_boundary", re.compile(r"encode-worker\.js|ptt_encode_voice|restoreVoice|cloneInner|joao\.emb"), "Aurora must own clone encoder/import lifecycle"),
)


def run_git(args: list[str], cwd: Path) -> str:
    proc = subprocess.run(["git", *args], cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    return proc.stdout.strip() if proc.returncode == 0 else f"git failed: {proc.stdout.strip()}"


def scan_file(path: Path, root: Path) -> list[dict[str, Any]]:
    if not path.exists() or path.stat().st_size > 2_000_000:
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError:
        return []
    result: list[dict[str, Any]] = []
    for line_no, line in enumerate(lines, start=1):
        for category, pattern, disposition in ASSUMPTION_PATTERNS:
            if pattern.search(line):
                result.append(
                    {
                        "category": category,
                        "path": str(path.relative_to(root)),
                        "line": line_no,
                        "evidence": line.strip()[:220],
                        "disposition": disposition,
                    }
                )
    return result


def file_hashes(root: Path) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for rel in SIBLING_FILES:
        path = root / rel
        result[rel] = {
            "exists": path.exists(),
            "size_bytes": path.stat().st_size if path.exists() else None,
            "sha256": sha256_file(path) if path.exists() and path.is_file() else None,
        }
    return result


def command_provenance(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.manifest)
    sibling = args.sibling
    upstream = args.upstream
    sibling_head = run_git(["rev-parse", "HEAD"], sibling) if sibling.exists() else "missing"
    sibling_status = run_git(["status", "--short", "--branch"], sibling) if sibling.exists() else "missing"
    upstream_head = run_git(["rev-parse", "HEAD"], upstream) if upstream.exists() else "missing"
    assumptions: list[dict[str, Any]] = []
    for root in (upstream, sibling / "public/assistant/pocket-tts", sibling / "src/features/assistant/audio"):
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if path.is_file() and path.suffix.lower() in {".js", ".ts", ".py", ".cpp", ".hpp", ".md", ".json", ".sh"}:
                assumptions.extend(scan_file(path, root))
    missing_encoder = not (sibling / "public/assistant/pocket-tts/src/encode-worker.js").exists()
    status = "pass" if upstream_head == RAVEN_UPSTREAM_COMMIT and sibling_head == SIBLING_HEAD else "review"
    write_json(
        args.output,
        {
            "status": status,
            "checked_at_unix": int(time.time()),
            "manifest_sha256": sha256_file(args.manifest),
            "plan_sha256": manifest.get("plan_sha256"),
            "sources": manifest["sources"],
            "observed": {"sibling_head": sibling_head, "sibling_status": sibling_status, "upstream_head": upstream_head},
            "sibling_hashes": file_hashes(sibling) if sibling.exists() else {},
            "clone_boundary": {
                "disposable_encoder_present_in_sibling": not missing_encoder,
                "conclusion": "synthesis and preset restore are reusable evidence; clone creation is incomplete because encode-worker.js is absent from the sibling runtime"
                if missing_encoder
                else "sibling has an encoder worker; still requires Aurora-owned import/consent tests before reuse",
                "reusable_patches": [
                    "growable-memory WASM selection",
                    "serialized worker calls",
                    "mobile one-step and desktop two-step model-set split",
                    "24 kHz AudioWorklet playback with prebuffering",
                    "session cancellation and bounded worker restart",
                    "preset voice-state restore/export shape",
                ],
                "rejected_patches": [
                    "hard-coded English model URLs and static spm_vocab.json",
                    "hard-coded Joao preset as product voice",
                    "ad hoc cache ownership",
                    "fused ConvTranspose decoder path without new proof",
                    "clone creation relying on missing disposable encoder",
                    "one-language worker API and cache identity",
                ],
            },
            "assumptions": assumptions,
        },
    )
    return 0 if status == "pass" else 2


def command_conversion(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.manifest)
    pack = manifest["packs"][args.pack]
    failures: list[dict[str, Any]] = []
    verified: dict[str, Any] = {}
    for name, asset in pack["assets"].items():
        path = asset_path(args.source_root, args.pack, name)
        if not path.exists():
            failures.append({"asset": name, "reason": "missing", "expected_path": public_path(path)})
            continue
        got = sha256_file(path)
        if asset["sha256"].startswith("TBD:"):
            failures.append({"asset": name, "reason": "manifest_hash_not_pinned", "actual_sha256": got, "path": public_path(path)})
            continue
        if got != asset["sha256"]:
            failures.append({"asset": name, "reason": "sha256_mismatch", "expected": asset["sha256"], "actual": got, "path": public_path(path)})
            continue
        verified[name] = {"path": public_path(path), "sha256": got, "size_bytes": path.stat().st_size}
    graph_check = {
        "expected_layers": pack["layers"],
        "expected_state_slots": pack["state_slots"],
        "state_slots_formula": "layers * 3",
        "accepted": pack["state_slots"] == pack["layers"] * 3,
    }
    status = "dry-run-pass" if args.dry_run and not failures and graph_check["accepted"] else "blocked"
    if not args.dry_run and not failures and graph_check["accepted"]:
        status = "ready-for-real-conversion"
    claim = f"{args.pack} conversion not reproduced"
    if status == "dry-run-pass":
        claim = f"{args.pack} manifest structure is valid; real conversion was intentionally not run"
    elif status == "ready-for-real-conversion":
        claim = f"{args.pack} inputs are present and hash-pinned; run the pinned Raven conversion script next"
    write_json(
        args.output,
        {
            "status": status,
            "checked_at_unix": int(time.time()),
            "pack_id": args.pack,
            "dry_run": bool(args.dry_run),
            "source_root": public_path(args.source_root),
            "environment": environment_record(),
            "verified_assets": verified,
            "graph_check": graph_check,
            "first_failure": failures[0] if failures else None,
            "failures": failures,
            "next_command": pack.get("conversion", {}).get("command"),
            "claim": claim,
        },
    )
    return 0 if status in {"dry-run-pass", "ready-for-real-conversion"} else 2


def asset_path(source_root: Path, pack_id: str, name: str) -> Path:
    candidates = (
        source_root / pack_id / name,
        source_root / name,
        source_root / "models" / name,
        source_root / "webdemo" / "models" / name,
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def command_benchmark(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.manifest)
    pack = manifest["packs"][args.pack]
    if not args.input:
        write_json(
            args.output,
            {
                "status": "blocked",
                "checked_at_unix": int(time.time()),
                "pack_id": args.pack,
                "environment": environment_record(),
                "first_failure": {"reason": "missing_runtime_report", "required": benchmark_required_fields()},
                "thermal_claim": "not measured",
                "mobile_claim": "not measured",
                "pack_layers": pack["layers"],
            },
        )
        return 2
    data = json.loads(args.input.read_text(encoding="utf-8"))
    required = benchmark_required_fields()
    missing = [key for key in required if key not in data]
    rtf = data["generation_ms"] / data["audio_duration_ms"] if not missing and data["audio_duration_ms"] else None
    provenance_failures = benchmark_provenance_failures(data) if not missing else []
    evidence_kind = data.get("evidence_kind")
    metrics_pass = not missing and rtf is not None and rtf <= args.max_rtf and data["cancelled_stale_audio"] is False
    if evidence_kind == "measured":
        status = "pass" if metrics_pass and not provenance_failures else "blocked"
        exit_code = 0 if status == "pass" else 2
    elif evidence_kind in {"fixture", "synthetic"}:
        status = "schema-only"
        exit_code = 2
    else:
        status = "blocked"
        exit_code = 2
    payload = {
        "status": status,
        "checked_at_unix": int(time.time()),
        "pack_id": args.pack,
        "pack_layers": pack["layers"],
        "evidence_kind": evidence_kind,
        "metrics": data,
        "rtf": rtf,
        "limits": {"max_rtf": args.max_rtf},
        "missing": missing,
        "provenance_failures": provenance_failures,
        "release_evidence": status == "pass",
        "first_failure": first_benchmark_failure(missing, provenance_failures, evidence_kind, metrics_pass),
    }
    write_json(args.output, payload)
    return exit_code


def benchmark_required_fields() -> tuple[str, ...]:
    return (
        "evidence_kind",
        "first_audio_ms",
        "audio_duration_ms",
        "generation_ms",
        "peak_memory_mb",
        "download_bytes",
        "cancelled_stale_audio",
        "device",
        "browser_or_runtime",
        "thermal",
        "source_commit",
        "artifact_sha256",
    )


def benchmark_provenance_failures(data: dict[str, Any]) -> list[dict[str, str]]:
    failures: list[dict[str, str]] = []
    forbidden = {"", "fixture", "synthetic", "test", "unknown", "not-measured", "not measured", "n/a"}
    for key in ("device", "browser_or_runtime", "thermal", "source_commit", "artifact_sha256"):
        value = str(data.get(key, "")).strip()
        if value.lower() in forbidden:
            failures.append({"field": key, "reason": "not_measured", "value": value})
    commit = str(data.get("source_commit", "")).strip()
    if commit and not re.fullmatch(r"[0-9a-f]{7,64}", commit):
        failures.append({"field": "source_commit", "reason": "not_a_git_sha", "value": commit})
    digest = str(data.get("artifact_sha256", "")).strip()
    if digest and not re.fullmatch(r"[0-9a-f]{64}", digest):
        failures.append({"field": "artifact_sha256", "reason": "not_a_sha256", "value": digest})
    return failures


def first_benchmark_failure(
    missing: list[str], provenance_failures: list[dict[str, str]], evidence_kind: Any, metrics_pass: bool
) -> dict[str, Any] | None:
    if missing:
        return {"reason": "missing_fields", "fields": missing}
    if evidence_kind in {"fixture", "synthetic"}:
        return {"reason": "non_release_evidence_kind", "evidence_kind": evidence_kind}
    if evidence_kind != "measured":
        return {"reason": "invalid_evidence_kind", "evidence_kind": evidence_kind, "allowed": ["measured", "fixture", "synthetic"]}
    if provenance_failures:
        return {"reason": "invalid_measurement_provenance", "failure": provenance_failures[0]}
    if not metrics_pass:
        return {"reason": "metric_threshold_or_cancellation_failed"}
    return None


def environment_record() -> dict[str, Any]:
    return {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "cwd": public_path(os.getcwd()),
        "tools": {name: public_path(found) if found else None for name in ("git", "uv", "curl", "cmake", "node") for found in [shutil.which(name)]},
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    manifest = sub.add_parser("manifest")
    manifest.add_argument("manifest", type=Path)
    manifest.add_argument("--output", type=Path)
    manifest.set_defaults(func=command_manifest)
    provenance = sub.add_parser("provenance")
    provenance.add_argument("--manifest", type=Path, required=True)
    provenance.add_argument("--sibling", type=Path, required=True)
    provenance.add_argument("--upstream", type=Path, required=True)
    provenance.add_argument("--output", type=Path)
    provenance.set_defaults(func=command_provenance)
    conversion = sub.add_parser("conversion")
    conversion.add_argument("--manifest", type=Path, required=True)
    conversion.add_argument("--pack", choices=sorted(REQUIRED_PACKS), required=True)
    conversion.add_argument("--source-root", type=Path, default=Path(".artifacts/pockettts/w0-raven/source-assets"))
    conversion.add_argument("--dry-run", action="store_true")
    conversion.add_argument("--output", type=Path)
    conversion.set_defaults(func=command_conversion)
    benchmark = sub.add_parser("benchmark")
    benchmark.add_argument("--manifest", type=Path, required=True)
    benchmark.add_argument("--pack", choices=sorted(REQUIRED_PACKS), required=True)
    benchmark.add_argument("--input", type=Path)
    benchmark.add_argument("--max-rtf", type=float, default=1.25)
    benchmark.add_argument("--output", type=Path)
    benchmark.set_defaults(func=command_benchmark)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except GateError as exc:
        print(f"raven gate failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

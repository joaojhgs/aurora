from __future__ import annotations

from scripts.check_tracked_artifacts import artifact_reason, find_forbidden_tracked_paths


def test_artifact_policy_allows_source_contracts_and_preserved_plans():
    allowed = [
        ".omx/plans/full-voice-release.md",
        "docker/services/Dockerfile.db",
        "docs/archive/HANDOFF_2026-05-01.md",
        "rust/crates/aurora-voice-engine/resources/sherpa_onnx_speech_catalog.json",
        "scripts/build.py",
        "apps/aurora-tauri/src-tauri/gen/schemas/android-schema.json",
        "packages/aurora-voice-web/src/wasm/aurora_voice_wasm.d.ts",
    ]

    assert find_forbidden_tracked_paths(allowed) == []


def test_artifact_policy_rejects_reports_caches_packages_models_and_runtime_state():
    forbidden = {
        ".omx/project-memory.json",
        ".omx/state/current-goal.md",
        "apps/aurora-web/.next.stalled-20260812/server/chunk.js",
        "apps/aurora-web/reports/playwright/run.json",
        "docs/current-release-report.md",
        "modules/release-bundle.zip",
        "modules/release-symbols.7z",
        "modules/release.exe",
        "reports/native-voice/result.json",
        "rust/target/debug/libaurora.so",
        "test_cuda.py",
        "tests/test_scheduler.db",
        "tests/unit/app/config/test_config_manager_new.py",
        "voice_models/jarvis.onnx",
    }

    violations = find_forbidden_tracked_paths(sorted(forbidden))

    assert {path for path, _reason in violations} == forbidden
    assert all(artifact_reason(path) for path in forbidden)

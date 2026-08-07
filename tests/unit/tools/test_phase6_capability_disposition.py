from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CANDIDATES = ROOT / "tools" / "voice-runtime" / "model-packs" / "candidates"
DISPOSITION_PATH = CANDIDATES / "phase6-capability-disposition.json"

MANIFEST_FILES = {
    "vad": "silero-vad-v4.candidate.manifest.json",
    "kws": "sherpa-gigaspeech-kws-en.candidate.manifest.json",
    "stt": "moonshine-tiny-en-stt.candidate.manifest.json",
}
PACK_BY_TASK = {
    "vad": "aurora-candidate-silero-vad-v4",
    "kws": "aurora-candidate-sherpa-gigaspeech-kws-en",
    "stt": "aurora-candidate-moonshine-tiny-en-stt",
}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def disposition() -> dict:
    return load_json(DISPOSITION_PATH)


def test_phase6_disposition_is_fail_closed_for_release_capabilities():
    data = disposition()

    assert data["schema_version"] == "aurora.voice.phase6.capability_disposition.v1"
    assert data["overall_status"] == "withheld"
    assert data["production_capabilities"] == {
        "vad": False,
        "kws": False,
        "stt": False,
        "tts": False,
    }
    assert data["allowed_behavior"] == {
        "vad": "candidate_validation_only",
        "kws": "withhold_release_capability",
        "stt": "withhold_release_capability",
        "tts": "task_unavailable",
    }

    for entry in data["candidate_validations"].values():
        assert entry["release_capability"] is False
        assert entry["release_index_eligible"] is False
        assert entry["advertised_languages"] == []
        assert entry["unsatisfied_gates"]

    assert data["candidate_validations"]["kws"]["supported_wake_phrases"] == []
    assert data["candidate_validations"]["tts"]["selectable_model_pack"] is False


def test_disposition_cross_checks_current_candidate_manifests_and_trust():
    data = disposition()
    trust = load_json(CANDIDATES / "signed-candidate-trust.json")
    provenance = load_json(CANDIDATES / "phase6-candidate-provenance.json")

    assert trust["trust_label"] == "non-production signed-candidate trust only"
    assert "not production trust" in provenance["trust_boundary"]

    for task, manifest_name in MANIFEST_FILES.items():
        manifest = load_json(CANDIDATES / manifest_name)
        entry = data["candidate_validations"][task]

        assert (
            entry["candidate_manifest"]
            == f"tools/voice-runtime/model-packs/candidates/{manifest_name}"
        )
        assert entry["candidate_pack_id"] == manifest["pack_id"] == PACK_BY_TASK[task]
        assert manifest_name in trust["valid_for"]
        assert manifest["signature"]["key_id"] == trust["key_id"]
        assert manifest["tasks"] == [task]

        assert len(manifest["variants"]) == 1
        variant = manifest["variants"][0]
        assert variant["target"] == "desktop"
        assert variant["os"] == "linux"
        assert variant["arch"] == "x86_64"
        assert variant["compatibility"]["interoperable"] is False
        assert "candidate" in variant["abi"]["build_flags"]
        assert "interoperable-false" in variant["abi"]["build_flags"]
        assert data["release_index_eligible"][manifest["pack_id"]] is False

    vad_language = load_json(CANDIDATES / MANIFEST_FILES["vad"])["languages"][0]
    assert vad_language["language"] == "und"
    assert vad_language["fixed_language"] is True

    for speech_task in ("kws", "stt"):
        language = load_json(CANDIDATES / MANIFEST_FILES[speech_task])["languages"][0]
        assert language["language"] == "en"
        assert language["fixed_language"] is True
        assert language["auto_detect"] is False


def test_tts_disposition_references_all_blocked_candidates():
    data = disposition()
    tts = data["candidate_validations"]["tts"]
    blocked = load_json(CANDIDATES / "blocked-tts-disposition.json")

    assert tts["blocked_disposition"] == (
        "tools/voice-runtime/model-packs/candidates/blocked-tts-disposition.json"
    )
    assert blocked["status"] == "blocked"
    assert blocked["selectable_model_pack"] is False
    assert {item["id"] for item in blocked["dispositions"]} == {
        "pockettts-standard-voice-packs",
        "piper-espeak-sherpa-tts-chain",
        "sherpa-onnx-supertonic-3-tts-int8-2026-05-11",
    }
    assert tts["candidate_manifest"] is None
    assert tts["candidate_pack_id"] is None


def test_disposition_does_not_promote_emulator_browser_or_ios_evidence():
    boundaries = disposition()["evidence_boundaries"]

    assert boundaries["native_linux"] == {
        "candidate_engine_validation": True,
        "release_claim": False,
    }
    assert boundaries["android"] == {
        "emulator_compile_and_integration": True,
        "physical_device_quality_or_resource_evidence": False,
        "release_claim": False,
    }
    assert boundaries["browser"]["physical_device_claim"] is False
    assert boundaries["browser"]["release_claim"] is False
    assert boundaries["ios"] == {
        "evidence_present": False,
        "release_claim": False,
    }


def test_disposition_references_are_repo_relative_and_checked_in():
    data = disposition()
    referenced_paths = set(data["source_references"])
    referenced_paths.add(data["evidence_boundaries"]["browser"]["vad_parity_reference"])
    for entry in data["candidate_validations"].values():
        for key in ("candidate_manifest", "blocked_disposition"):
            value = entry.get(key)
            if value:
                referenced_paths.add(value)

    for reference in referenced_paths:
        assert not reference.startswith("/")
        assert ".." not in Path(reference).parts
        if reference.startswith(".artifacts/"):
            continue
        assert (ROOT / reference).is_file(), reference


def test_disposition_does_not_leak_host_paths_secrets_transcripts_or_audio_names():
    rendered = json.dumps(disposition(), sort_keys=True)
    forbidden = (
        r"/home/",
        r"/tmp/",
        r"[A-Za-z]:\\",
        r"secret",
        r"token",
        r"private",
        r"Ask not what",
        r"LIGHT UP",
        r"test_wavs",
        r"\b0\.wav\b",
        r"\.pcm\b",
        r"\.wav\b",
    )
    for pattern in forbidden:
        assert re.search(pattern, rendered, flags=re.IGNORECASE) is None, pattern

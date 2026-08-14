from __future__ import annotations

import json
import re
import subprocess
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
PHASE4_DOC_PATH = ROOT / "docs" / "NATIVE_VOICE_RUNTIME_PHASE4.md"


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def disposition() -> dict:
    return load_json(DISPOSITION_PATH)


def candidate_manifest_references(data: dict) -> set[str]:
    references = {
        reference
        for reference in data["source_references"]
        if reference.endswith(".candidate.manifest.json")
    }
    references.update(
        entry["candidate_manifest"]
        for entry in data["candidate_validations"].values()
        if entry.get("candidate_manifest")
    )
    return references


def test_phase6_disposition_enables_on_demand_capabilities_without_bundling_weights():
    data = disposition()

    assert data["schema_version"] == "aurora.voice.phase6.capability_disposition.v2"
    assert data["overall_status"] == "production_runtime_enabled_on_demand"
    assert data["production_capabilities"] == {
        "vad": True,
        "kws": True,
        "stt": True,
        "tts": True,
    }
    assert data["allowed_behavior"] == {
        "vad": "explicit_user_download_cache_and_activate",
        "kws": "explicit_user_download_cache_and_activate",
        "stt": "explicit_user_download_cache_and_activate",
        "tts": "explicit_user_download_cache_and_activate",
    }

    activation = data["activation_policy"]
    assert activation["bundled_model_weights"] is False
    assert activation["automatic_download"] is False
    assert activation["redistributed_by_aurora"] is False
    assert activation["download_initiated_by_user"] is True
    assert activation["terms_presented_from_catalog"] is True

    for entry in data["candidate_validations"].values():
        assert entry["release_capability"] is True
        assert entry["release_index_eligible"] is False
        assert entry["embedded_catalog_eligible"] is True
        assert entry["remaining_evidence_gaps"]

    assert data["candidate_validations"]["kws"]["wake_phrase_policy"]
    assert data["candidate_validations"]["tts"]["selectable_model_pack"] is True


def test_embedded_catalogs_list_all_pinned_entries_for_explicit_user_download():
    data = disposition()

    for catalog_name, expected_count in (("speech", 21), ("tts", 537)):
        catalog_policy = data["metadata_catalogs"][catalog_name]
        catalog = load_json(ROOT / catalog_policy["path"])
        assert len(catalog["entries"]) == catalog_policy["entry_count"] == expected_count
        assert len(catalog["languages"]) == catalog_policy["language_count"]
        for entry in catalog["entries"]:
            assert entry["archive"]["url"].startswith("https://")
            assert re.fullmatch(r"[0-9a-f]{64}", entry["archive"]["sha256"])
            assert entry["terms"]["download_initiated_by_user"] is True
            assert entry["terms"]["redistributed_by_aurora"] is False


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


def test_every_disposition_candidate_manifest_is_release_ineligible():
    data = disposition()
    manifest_references = candidate_manifest_references(data)

    assert manifest_references

    validation_by_manifest = {
        entry["candidate_manifest"]: entry
        for entry in data["candidate_validations"].values()
        if entry.get("candidate_manifest")
    }

    for reference in sorted(manifest_references):
        manifest = load_json(ROOT / reference)
        pack_id = manifest["pack_id"]
        entry = validation_by_manifest[reference]

        assert entry["candidate_pack_id"] == pack_id
        assert entry["release_capability"] is True
        assert entry["embedded_catalog_eligible"] is True
        assert entry["release_index_eligible"] is False
        assert data["release_index_eligible"][pack_id] is False
        assert manifest["variants"]
        assert all(
            variant["compatibility"]["interoperable"] is False for variant in manifest["variants"]
        )


def test_phase4_docs_describe_phase6_candidates_as_validation_only():
    data = disposition()
    doc = PHASE4_DOC_PATH.read_text(encoding="utf-8")
    manifest_references = candidate_manifest_references(data)

    assert "phase6-capability-disposition.json" in doc
    assert "validation inputs only" in doc
    assert "excluded from release eligibility" in doc
    assert re.search(r"explicit user\s+choice", doc)
    assert "does not bundle or redistribute" in doc

    forbidden_release_selection_language = (
        r"\bselected\s+model\s+candidates\b",
        r"\bselected\s+English(?:-only)?\b",
        r"\bselected\s+full\s+GigaSpeech\b",
        r"\bselected\s+upstream\s+Silero\b",
        r"\brelease[- ]selected\b",
        r"\bshippable\b",
        r"\bproduction\s+speech\s+pack\s+is\s+selected\b",
    )
    for pattern in forbidden_release_selection_language:
        assert re.search(pattern, doc, flags=re.IGNORECASE) is None, pattern

    for reference in manifest_references:
        manifest = load_json(ROOT / reference)
        assert manifest["pack_id"] in data["release_index_eligible"]
        assert data["release_index_eligible"][manifest["pack_id"]] is False


def test_tts_disposition_separates_on_demand_selection_from_redistribution():
    data = disposition()
    tts = data["candidate_validations"]["tts"]
    blocked = load_json(CANDIDATES / "blocked-tts-disposition.json")

    assert tts["distribution_disposition"] == (
        "tools/voice-runtime/model-packs/candidates/blocked-tts-disposition.json"
    )
    assert blocked["status"] == "user_download_enabled"
    assert blocked["selectable_model_pack"] is True
    assert blocked["bundled_model_weights"] is False
    assert blocked["automatic_download"] is False
    assert {item["id"] for item in blocked["dispositions"]} == {
        "pockettts-standard-voice-packs",
        "piper-espeak-sherpa-tts-chain",
        "sherpa-onnx-supertonic-3-tts-int8-2026-05-11",
    }
    selectable = [item for item in blocked["dispositions"] if item["catalog_selectable"]]
    assert {item["id"] for item in selectable} == {
        "pockettts-standard-voice-packs",
        "piper-espeak-sherpa-tts-chain",
    }
    for item in selectable:
        assert item["download_initiated_by_user"] is True
        assert item["status"] == "user_download_only"
        assert item["aurora_redistribution"] in {"prohibited", "not_bundled"}

    supertonic = next(
        item
        for item in blocked["dispositions"]
        if item["id"] == "sherpa-onnx-supertonic-3-tts-int8-2026-05-11"
    )
    assert supertonic["catalog_selectable"] is False
    assert supertonic["status"] == "unsupported_model_family"
    assert "not in Aurora's current runtime catalog" in supertonic["reason"]


def test_disposition_keeps_runtime_implementation_separate_from_external_evidence():
    boundaries = disposition()["evidence_boundaries"]

    assert boundaries["native_linux"] == {
        "candidate_engine_validation": True,
        "runtime_implementation": True,
        "unsigned_package_allowed": True,
    }
    assert boundaries["android"] == {
        "physical_device_quality_or_resource_evidence": False,
        "runtime_implementation": True,
        "unsigned_package_allowed": True,
    }
    assert boundaries["browser"] == {
        "physical_device_claim": False,
        "runtime_implementation": True,
        "unsigned_package_allowed": True,
    }
    assert boundaries["ios"] == {
        "apple_runtime_evidence_present": False,
        "runtime_implementation": True,
        "unsigned_frontend_and_project_allowed": True,
    }


def test_disposition_references_are_repo_relative_and_checked_in():
    data = disposition()
    referenced_paths = set(data["source_references"])
    for entry in data["candidate_validations"].values():
        for key in ("candidate_manifest", "distribution_disposition", "catalog_source"):
            value = entry.get(key)
            if value:
                referenced_paths.add(value)

    for reference in referenced_paths:
        assert not reference.startswith("/")
        assert ".." not in Path(reference).parts
        assert (ROOT / reference).is_file(), reference
        tracked = subprocess.run(
            ["git", "ls-files", "--error-unmatch", "--", reference],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        assert tracked.returncode == 0, reference


def test_disposition_does_not_leak_host_paths_secrets_transcripts_or_audio_names():
    rendered = json.dumps(disposition(), sort_keys=True)
    forbidden = (
        r"/home/",
        r"/tmp/",
        r"[A-Za-z]:\\",
        r"secret",
        r"token",
        r"private[_ -]key",
        r"Ask not what",
        r"LIGHT UP",
        r"test_wavs",
        r"\b0\.wav\b",
        r"\.pcm\b",
        r"\.wav\b",
    )
    for pattern in forbidden:
        assert re.search(pattern, rendered, flags=re.IGNORECASE) is None, pattern

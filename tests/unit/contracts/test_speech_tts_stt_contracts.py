"""Contract tests for provider-neutral speech/TTS/STT DTOs."""

from __future__ import annotations

import base64
import hashlib

import pytest
from pydantic import ValidationError

from app.shared.contracts.models.speech import (
    SPEECH_LANGUAGE_TABLE_REVISION,
    SpeechLanguageRequirement,
    SpeechLocaleFallback,
    SpeechMethodConstraints,
    SpeechRouteBinding,
)
from app.shared.contracts.models.stt import (
    STTCapturePrepareRequest,
    STTCaptureStatusResponse,
    STTMethods,
    TranscribeAudioRequest,
)
from app.shared.contracts.models.tts import (
    VOICE_IMPORT_MAX_BASE64_CHARS,
    VOICE_IMPORT_MAX_CHUNK_BYTES,
    VOICE_IMPORT_MAX_DURATION_MS,
    VOICE_IMPORT_MAX_TOTAL_BYTES,
    TTSCapabilities,
    TTSCloneVoiceStateBundle,
    TTSCreateVoiceProfileRequest,
    TTSCreateVoiceProfileResponse,
    TTSDeleteVoiceProfileRequest,
    TTSDeleteVoiceProfileResponse,
    TTSExportVoiceProfileRequest,
    TTSExportVoiceProfileResponse,
    TTSGetVoiceProfileResponse,
    TTSImportVoiceProfileRequest,
    TTSImportVoiceProfileResponse,
    TTSInstallVoiceProfileRequest,
    TTSInstallVoiceProfileResponse,
    TTSLanguagePackDescriptor,
    TTSLanguagePackVoice,
    TTSListLanguagePacksRequest,
    TTSListLanguagePacksResponse,
    TTSListVoiceProfilesRequest,
    TTSListVoicesRequest,
    TTSListVoicesResponse,
    TTSMethods,
    TTSRemoveVoiceProfileRequest,
    TTSRemoveVoiceProfileResponse,
    TTSRequest,
    TTSResidentLanguagePack,
    TTSSetDefaultVoiceRequest,
    TTSSetDefaultVoiceResponse,
    TTSStreamStartRequest,
    TTSSynthesizeRequest,
    TTSUpdateVoiceProfileRequest,
    TTSUpdateVoiceProfileResponse,
    TTSVoiceDescriptor,
    TTSVoiceImportAbortRequest,
    TTSVoiceImportAbortResponse,
    TTSVoiceImportChunkRequest,
    TTSVoiceImportChunkResponse,
    TTSVoiceImportEndRequest,
    TTSVoiceImportEndResponse,
    TTSVoiceImportStartRequest,
    TTSVoiceImportStartResponse,
    TTSVoiceProfileDescriptor,
)

SHA = "0" * 64
CLONE_ID = "clone:123e4567-e89b-12d3-a456-426614174000"
STANDARD_ID = "standard:english_2026-04:default"


def test_language_requirement_normalizes_and_digests_exact() -> None:
    requirement = SpeechLanguageRequirement.model_validate(
        {"mode": "exact", "language": "ZH_hant_TW"}
    )

    assert requirement.language == "zh-hant-tw"
    assert requirement.table_revision == SPEECH_LANGUAGE_TABLE_REVISION
    assert requirement.digest == requirement.compute_digest()

    same = SpeechLanguageRequirement(mode="exact", language="zh-hant-tw", digest=requirement.digest)
    assert same.digest == requirement.digest


def test_create_voice_profile_rejected_response_does_not_need_reserved_voice_id() -> None:
    response = TTSCreateVoiceProfileResponse(status="unavailable")

    assert response.voice_id is None
    assert response.revision is None


def test_create_voice_profile_requires_opaque_sealed_reference() -> None:
    with pytest.raises(ValidationError, match="opaque voice import reference"):
        TTSCreateVoiceProfileRequest(
            operation_id="clone-a",
            display_name="Clone",
            sealed_audio_ref="../voice.wav",
            consent=True,
        )


def test_language_requirement_normalizes_auto_candidates() -> None:
    requirement = SpeechLanguageRequirement.model_validate(
        {
            "mode": "auto",
            "auto_language_candidates": ["PT_br", "es-419", "pt-BR", "zh-Hant"],
        }
    )

    assert requirement.language is None
    assert requirement.auto_language_candidates == ["es-419", "pt-br", "zh-hant"]


@pytest.mark.parametrize("tag", ["", "-en", "en--US", "en US", "x"])
def test_language_requirement_rejects_malformed_and_blank_exact_tags(tag: str) -> None:
    with pytest.raises(ValidationError):
        SpeechLanguageRequirement.model_validate({"mode": "exact", "language": tag})


@pytest.mark.parametrize(
    ("tag", "expected"),
    [
        ("pt-BR", "pt-br"),
        ("zh-Hant-TW", "zh-hant-tw"),
        ("sr_Latn_RS", "sr-latn-rs"),
        ("x-Aurora-Custom", "x-aurora-custom"),
        ("und", "und"),
    ],
)
def test_language_requirement_accepts_open_bcp47_tags(tag: str, expected: str) -> None:
    requirement = SpeechLanguageRequirement.model_validate({"mode": "exact", "language": tag})

    assert requirement.language == expected


def test_language_requirement_rejects_wrong_digest() -> None:
    with pytest.raises(ValidationError, match="digest mismatch"):
        SpeechLanguageRequirement(mode="exact", language="en", digest="1" * 64)


def test_language_requirement_rejects_exact_with_candidates() -> None:
    with pytest.raises(ValidationError, match="cannot include auto candidates"):
        SpeechLanguageRequirement(
            mode="exact", language="en", auto_language_candidates=["en", "fr"]
        )


def test_speech_constraints_validate_auto_coverage_and_fallbacks() -> None:
    constraints = SpeechMethodConstraints(
        exact_languages=["fr", "en", "fr"],
        supports_auto_detect=True,
        auto_detect_languages=["en", "fr"],
        ready_voice_ids=[STANDARD_ID, CLONE_ID],
        resident_model_identity_digest=SHA,
        speech_capability_revision=7,
    )

    assert constraints.exact_languages == ["en", "fr"]
    assert constraints.ready_voice_ids == [CLONE_ID, STANDARD_ID]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"exact_languages": ["en"], "supports_auto_detect": True, "auto_detect_languages": ["en"]},
        {
            "exact_languages": ["en"],
            "supports_auto_detect": False,
            "auto_detect_languages": ["en", "fr"],
        },
        {
            "exact_languages": ["en"],
            "supports_auto_detect": True,
            "auto_detect_languages": ["en", "fr"],
        },
        {
            "exact_languages": ["en"],
            "locale_fallbacks": [{"requested_language": "fr", "served_language": "fr"}],
        },
    ],
)
def test_speech_constraints_reject_invalid_auto_and_fallback_shapes(
    kwargs: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        SpeechMethodConstraints.model_validate(
            {
                "resident_model_identity_digest": SHA,
                "speech_capability_revision": 1,
                **kwargs,
            }
        )


def test_speech_constraints_require_resident_identity_for_ready_state() -> None:
    with pytest.raises(ValidationError, match="resident model identity"):
        SpeechMethodConstraints(exact_languages=["en"], speech_capability_revision=1)


def test_locale_fallbacks_are_explicit_pack_declarations() -> None:
    fallback = SpeechLocaleFallback.model_validate(
        {"requested_language": "pt-BR", "served_language": "pt"}
    )
    assert fallback.requested_language == "pt-br"
    assert fallback.served_language == "pt"

    with pytest.raises(ValidationError, match="must differ"):
        SpeechLocaleFallback(requested_language="fr", served_language="fr")


def test_route_binding_is_internal_metadata_not_request_field() -> None:
    requirement = SpeechLanguageRequirement(mode="exact", language="en")
    assert requirement.digest is not None
    binding = SpeechRouteBinding(
        service_instance_id="svc-1",
        projection_digest=SHA,
        projection_revision="projection-1",
        provider_lease_epoch="lease-1",
        provider_lease_revision=2,
        speech_capability_revision=3,
        requirement_digest=requirement.digest,
    )

    assert binding.requirement_digest == requirement.digest
    assert "route_binding" not in TTSRequest.model_fields
    assert "route_binding" not in TTSSynthesizeRequest.model_fields
    assert "route_binding" not in TTSStreamStartRequest.model_fields
    assert "route_binding" not in TranscribeAudioRequest.model_fields


def test_tts_method_constants_cover_voice_lifecycle_surface() -> None:
    assert TTSMethods.GET_CAPABILITIES == "TTS.GetCapabilities"
    assert TTSMethods.LIST_VOICES == "TTS.ListVoices"
    assert TTSMethods.LIST_LANGUAGE_PACKS == "TTS.ListLanguagePacks"
    assert TTSMethods.LIST_VOICE_PROFILES == "TTS.ListVoiceProfiles"
    assert TTSMethods.GET_VOICE_PROFILE == "TTS.GetVoiceProfile"
    assert TTSMethods.UPDATE_VOICE_PROFILE == "TTS.UpdateVoiceProfile"
    assert TTSMethods.INSTALL_VOICE_PROFILE == "TTS.InstallVoiceProfile"
    assert TTSMethods.REMOVE_VOICE_PROFILE == "TTS.RemoveVoiceProfile"
    assert TTSMethods.SET_DEFAULT_VOICE == "TTS.SetDefaultVoice"
    assert TTSMethods.VOICE_IMPORT_START == "TTS.VoiceImportStart"
    assert TTSMethods.VOICE_IMPORT_CHUNK == "TTS.VoiceImportChunk"
    assert TTSMethods.VOICE_IMPORT_END == "TTS.VoiceImportEnd"
    assert TTSMethods.VOICE_IMPORT_ABORT == "TTS.VoiceImportAbort"
    assert TTSMethods.CREATE_VOICE_PROFILE == "TTS.CreateVoiceProfile"
    assert TTSMethods.DELETE_VOICE_PROFILE == "TTS.DeleteVoiceProfile"
    assert TTSMethods.EXPORT_VOICE_PROFILE == "TTS.ExportVoiceProfile"
    assert TTSMethods.IMPORT_VOICE_PROFILE == "TTS.ImportVoiceProfile"


def test_clone_voice_state_transfer_is_integrity_bound_and_repr_redacted() -> None:
    payload = b"derived-clone-state"
    encoded = base64.b64encode(payload).decode("ascii")
    bundle = TTSCloneVoiceStateBundle(
        voice_id=CLONE_ID,
        display_name="Private voice",
        runtime_target="pockettts-python",
        language_bundle="english_2026-04",
        compatibility_group="pockettts-base",
        artifact_revision="clone-rev-a",
        artifact_sha256=hashlib.sha256(payload).hexdigest(),
        artifact_size_bytes=len(payload),
        artifact_data_base64=encoded,
    )

    request = TTSImportVoiceProfileRequest(operation_id="import-a", bundle=bundle)
    exported = TTSExportVoiceProfileResponse(
        voice_id=CLONE_ID,
        status="exported",
        revision="voice-rev-a",
        bundle=bundle,
    )

    assert request.bundle.voice_id == CLONE_ID
    assert exported.bundle == bundle
    assert encoded not in repr(bundle)
    assert "artifact_data_base64" not in repr(bundle)
    assert encoded in bundle.model_dump_json()

    with pytest.raises(ValidationError, match="artifact SHA-256 mismatch"):
        TTSCloneVoiceStateBundle.model_validate(
            {**bundle.model_dump(), "artifact_sha256": "0" * 64}
        )
    with pytest.raises(ValidationError):
        TTSCloneVoiceStateBundle.model_validate(
            {**bundle.model_dump(), "source_audio": encoded}
        )
    with pytest.raises(ValidationError, match="only cloned voice profiles"):
        TTSExportVoiceProfileRequest(
            operation_id="export-standard",
            voice_id=STANDARD_ID,
        )
    with pytest.raises(ValidationError, match="needs revision"):
        TTSImportVoiceProfileResponse(
            voice_id=CLONE_ID,
            status="imported",
        )


def test_stt_capture_handoff_contracts_keep_lease_tokens_off_status() -> None:
    assert STTMethods.CAPTURE_PREPARE == "STTCoordinator.CapturePrepare"
    assert STTMethods.CAPTURE_RELEASE == "STTCoordinator.CaptureRelease"
    assert STTMethods.CAPTURE_STATUS == "STTCoordinator.CaptureStatus"

    request = STTCapturePrepareRequest(owner_id="tauri-local")
    assert request.owner == "native"
    assert request.lease_id is None

    status = STTCaptureStatusResponse(
        owner="native",
        generation=2,
        native_lease_active=True,
        lease_expires_at="2026-08-07T16:00:00",
        python_capture_active=False,
        service_running=True,
        audio_input_available=True,
        can_restart_python_capture=False,
    )
    serialized = status.model_dump_json()
    assert "lease_id" not in serialized
    assert "owner_id" not in serialized
    assert status.redacted is True


def test_tts_language_is_backward_compatible_and_exact_only() -> None:
    assert TTSRequest(text="hello").language is None
    assert TTSRequest.model_validate({"text": "hello", "language": ""}).language is None
    assert TTSRequest.model_validate({"text": "hello", "language": "EN"}).language == "en"
    assert TTSSynthesizeRequest(text="hello", language="fr").language == "fr"
    assert TTSStreamStartRequest(stream_id="s1", language="de").language == "de"
    assert TTSRequest(text="olá", language="pt-BR").language == "pt-br"
    assert TTSSynthesizeRequest(text="你好", language="zh-Hant").language == "zh-hant"
    assert TTSRequest(text="hello", voice=STANDARD_ID).voice == STANDARD_ID

    with pytest.raises(ValidationError, match="exact, not auto"):
        TTSRequest.model_validate({"text": "hello", "language": "auto"})
    with pytest.raises(ValidationError):
        TTSSynthesizeRequest.model_validate({"text": "hello", "language": "en--US"})
    with pytest.raises(ValidationError):
        TTSStreamStartRequest(stream_id="s1", voice="raw-provider-id")


def test_tts_descriptors_are_use_safe_and_forbid_internal_extras() -> None:
    assert TTSListVoicesRequest.model_validate({"language": "EN"}).language == "en"
    with pytest.raises(ValidationError):
        TTSListVoicesRequest.model_validate({"language": "auto"})

    descriptor = TTSVoiceDescriptor(
        voice_id=STANDARD_ID,
        display_name="Default",
        kind="standard",
        compatible_language_pack_ids=["pockettts:english_2026-04"],
        ready=True,
        revision="rev-1",
    )
    response = TTSListVoicesResponse(voices=[descriptor])

    assert response.voices[0].voice_id == STANDARD_ID
    assert TTSGetVoiceProfileResponse(found=False).profile is None
    assert TTSListVoiceProfilesRequest(include_unavailable=True).include_unavailable is True
    with pytest.raises(ValidationError):
        TTSGetVoiceProfileResponse(found=True)
    with pytest.raises(ValidationError):
        TTSVoiceDescriptor(
            voice_id="standard:English:default",
            display_name="Default",
            kind="standard",
            compatible_language_pack_ids=["pockettts:english_2026-04"],
            ready=True,
            revision="rev-1",
        )
    with pytest.raises(ValidationError, match="kind"):
        TTSVoiceDescriptor(
            voice_id=STANDARD_ID,
            display_name="Wrong kind",
            kind="cloned",
            compatible_language_pack_ids=["pockettts:english_2026-04"],
            ready=True,
            revision="rev-1",
        )
    with pytest.raises(ValidationError):
        TTSVoiceDescriptor(
            voice_id="clone:123E4567-E89B-12D3-A456-426614174000",
            display_name="Uppercase clone",
            kind="cloned",
            compatible_language_pack_ids=["pockettts:english_2026-04"],
            ready=True,
            revision="rev-1",
        )
    with pytest.raises(ValidationError):
        TTSVoiceDescriptor.model_validate(
            {
                "voice_id": "standard:leaky:default",
                "display_name": "Leak",
                "kind": "standard",
                "compatible_language_pack_ids": ["pockettts:english_2026-04"],
                "ready": True,
                "revision": "rev-1",
                "filesystem_path": "/tmp/model.onnx",
            }
        )
    with pytest.raises(ValidationError):
        TTSVoiceProfileDescriptor.model_validate(
            {
                "voice_id": CLONE_ID,
                "display_name": "Private",
                "kind": "cloned",
                "revision": "rev-1",
                "embedding_tensor": [1, 2, 3],
            }
        )


def test_tts_language_pack_contracts_are_redacted_and_exact() -> None:
    voice = TTSLanguagePackVoice(
        voice_id=STANDARD_ID,
        display_name="Default",
        installed=True,
        ready=True,
        default=True,
        active=False,
        revision="voice-rev-1",
    )
    pack = TTSLanguagePackDescriptor(
        pack_id="en",
        language="EN",
        display_name="English",
        installed=True,
        ready=True,
        default=True,
        voice_count=1,
        installed_voice_count=1,
        ready_voice_count=1,
        voices=[voice],
        revision="pack-rev-1",
    )
    response = TTSListLanguagePacksResponse(
        packs=[pack],
        catalog_status="available",
        default_voice_id=STANDARD_ID,
    )

    assert TTSListLanguagePacksRequest.model_validate({"language": "PT_br"}).language == "pt-br"
    assert response.packs[0].language == "en"
    assert response.packs[0].voices[0].default is True
    assert response.packs[0].voices[0].active is False
    assert "filesystem_path" not in response.model_dump_json()
    with pytest.raises(ValidationError):
        TTSListLanguagePacksRequest.model_validate({"language": "auto"})
    with pytest.raises(ValidationError, match="voice count"):
        TTSLanguagePackDescriptor(
            pack_id="en",
            language="en",
            display_name="English",
            installed=True,
            ready=True,
            voice_count=2,
            installed_voice_count=1,
            ready_voice_count=1,
            voices=[voice],
            revision="pack-rev-1",
        )
    with pytest.raises(ValidationError, match="ready language pack voice"):
        TTSLanguagePackVoice(
            voice_id=STANDARD_ID,
            display_name="Default",
            installed=False,
            ready=True,
            revision="voice-rev-1",
        )
    with pytest.raises(ValidationError, match="default or active language pack voice"):
        TTSLanguagePackVoice(
            voice_id=STANDARD_ID,
            display_name="Default",
            installed=True,
            ready=False,
            default=True,
            revision="voice-rev-1",
        )
    with pytest.raises(ValidationError, match="default or active language pack voice"):
        TTSLanguagePackVoice(
            voice_id=STANDARD_ID,
            display_name="Default",
            installed=True,
            ready=False,
            active=True,
            revision="voice-rev-1",
        )
    with pytest.raises(ValidationError):
        TTSLanguagePackDescriptor.model_validate(
            {
                "pack_id": "en",
                "language": "en",
                "display_name": "English",
                "installed": False,
                "ready": False,
                "voice_count": 0,
                "revision": "pack-rev-1",
                "source_url": "https://example.invalid/pack.json",
            }
        )
    stale = TTSListLanguagePacksResponse(
        packs=[],
        catalog_status="unavailable",
        catalog_error_code="catalog_unavailable",
        default_voice_id=STANDARD_ID,
        stale_default_voice_id=STANDARD_ID,
    )
    assert stale.stale_default_voice_id == STANDARD_ID
    stale_unready_voice = TTSLanguagePackVoice(
        voice_id=STANDARD_ID,
        display_name="Default",
        installed=True,
        ready=False,
        default=False,
        active=False,
        revision="voice-rev-2",
    )
    stale_unready_pack = TTSLanguagePackDescriptor(
        pack_id="en",
        language="en",
        display_name="English",
        installed=True,
        ready=False,
        default=False,
        voice_count=1,
        installed_voice_count=1,
        ready_voice_count=0,
        voices=[stale_unready_voice],
        revision="pack-rev-2",
    )
    listed_stale = TTSListLanguagePacksResponse(
        packs=[stale_unready_pack],
        catalog_status="available",
        default_voice_id=STANDARD_ID,
        stale_default_voice_id=STANDARD_ID,
    )
    assert listed_stale.packs[0].voices[0].ready is False
    listed_catalog_voice = TTSLanguagePackVoice(
        voice_id=STANDARD_ID,
        display_name="Default",
        installed=False,
        ready=False,
        default=False,
        revision="voice-rev-1",
    )
    listed_catalog_pack = TTSLanguagePackDescriptor(
        pack_id="en",
        language="en",
        display_name="English",
        installed=False,
        ready=False,
        default=False,
        voice_count=1,
        installed_voice_count=0,
        ready_voice_count=0,
        voices=[listed_catalog_voice],
        revision="pack-rev-1",
    )
    listed_catalog_stale = TTSListLanguagePacksResponse(
        packs=[listed_catalog_pack],
        default_voice_id=STANDARD_ID,
        stale_default_voice_id=STANDARD_ID,
    )
    assert listed_catalog_stale.packs[0].voices[0].installed is False
    with pytest.raises(ValidationError, match="stale default voice"):
        TTSListLanguagePacksResponse(
            packs=[pack],
            catalog_status="available",
            default_voice_id=STANDARD_ID,
            stale_default_voice_id=STANDARD_ID,
        )
    with pytest.raises(ValidationError, match="requires an error code"):
        TTSListLanguagePacksResponse(catalog_status="unavailable")


def test_tts_capabilities_keep_readiness_separate_from_method_constraints() -> None:
    capabilities = TTSCapabilities(
        ready=True,
        model_status="ready",
        supported_language_pack_ids=["pockettts:english_2026-04", "pockettts:french_24l"],
        installed_language_pack_ids=["pockettts:english_2026-04"],
        resident_language_pack_ids=["pockettts:english_2026-04"],
        resident_language_packs=[
            TTSResidentLanguagePack(pack_id="pockettts:english_2026-04", ready_languages=["en"])
        ],
        ready_languages=["en"],
        sample_rates=[24000],
        resident_base_model_count=1,
        capability_revision=4,
    )
    assert capabilities.ready_languages == ["en"]
    assert "constraints" not in TTSCapabilities.model_fields

    with pytest.raises(ValidationError, match="ready languages"):
        TTSCapabilities(
            ready=False,
            ready_languages=["en", "fr"],
            capability_revision=4,
        )
    with pytest.raises(ValidationError, match="ids and bindings must match"):
        TTSCapabilities(
            ready=True,
            model_status="ready",
            supported_language_pack_ids=["pockettts:english_2026-04"],
            installed_language_pack_ids=["pockettts:english_2026-04"],
            resident_language_pack_ids=["pockettts:english_2026-04"],
            ready_languages=["en"],
            sample_rates=[24000],
            resident_base_model_count=1,
        )
    with pytest.raises(ValidationError, match="ready languages must match"):
        TTSCapabilities(
            ready=True,
            model_status="ready",
            supported_language_pack_ids=["pack:en"],
            installed_language_pack_ids=["pack:en"],
            resident_language_pack_ids=["pack:en"],
            resident_language_packs=[
                TTSResidentLanguagePack(pack_id="pack:en", ready_languages=["en"])
            ],
            ready_languages=["fr"],
            sample_rates=[24000],
            resident_base_model_count=1,
        )


def test_voice_mutation_requests_require_operation_ids_and_revisions() -> None:
    request = TTSUpdateVoiceProfileRequest(
        voice_id=CLONE_ID,
        display_name="Mine",
        visibility="allowed_peers",
        allowed_peer_ids=["peer-b", "peer-a", "peer-b"],
        operation_id="op-1",
        expected_revision="rev-1",
    )
    assert request.allowed_peer_ids == ["peer-a", "peer-b"]
    assert (
        TTSUpdateVoiceProfileRequest(
            voice_id=CLONE_ID,
            enabled=True,
            operation_id="op-no-revision",
        ).expected_revision
        is None
    )

    with pytest.raises(ValidationError):
        TTSSetDefaultVoiceRequest.model_validate({"voice_id": CLONE_ID, "operation_id": "op-1"})

    for model in (TTSInstallVoiceProfileRequest, TTSDeleteVoiceProfileRequest):
        with pytest.raises(ValidationError):
            model(voice_id=CLONE_ID, operation_id=" ")
    with pytest.raises(ValidationError):
        TTSInstallVoiceProfileRequest(voice_id="raw-provider-id", operation_id="op-1")
    with pytest.raises(ValidationError, match="only cloned"):
        TTSDeleteVoiceProfileRequest(voice_id=STANDARD_ID, operation_id="op-1")
    with pytest.raises(ValidationError):
        TTSInstallVoiceProfileRequest.model_validate(
            {
                "voice_id": STANDARD_ID,
                "operation_id": "op-1",
                "source_url": "https://example.invalid/voice.bin",
            }
        )
    with pytest.raises(ValidationError, match="must include a change"):
        TTSUpdateVoiceProfileRequest(voice_id=CLONE_ID, operation_id="op-1")


def test_every_voice_mutation_has_idempotency_revision_and_route_fields() -> None:
    mutation_models = (
        TTSUpdateVoiceProfileRequest,
        TTSInstallVoiceProfileRequest,
        TTSRemoveVoiceProfileRequest,
        TTSSetDefaultVoiceRequest,
        TTSVoiceImportStartRequest,
        TTSVoiceImportChunkRequest,
        TTSVoiceImportEndRequest,
        TTSVoiceImportAbortRequest,
        TTSCreateVoiceProfileRequest,
        TTSDeleteVoiceProfileRequest,
    )

    for model in mutation_models:
        assert {"operation_id", "expected_revision", "mesh_selector", "correlation_id"}.issubset(
            model.model_fields
        )
        assert model.model_fields["operation_id"].is_required()
        assert model.model_fields["expected_revision"].is_required() is (
            model is TTSSetDefaultVoiceRequest
        )


def test_voice_import_start_enforces_total_hash_and_operation_limits() -> None:
    request = TTSVoiceImportStartRequest(
        expected_total_bytes=VOICE_IMPORT_MAX_TOTAL_BYTES,
        sha256=SHA,
        format="wav",
        sample_rate=24000,
        channels=1,
        sample_width_bytes=2,
        operation_id="upload-1",
    )
    assert request.expected_total_bytes == VOICE_IMPORT_MAX_TOTAL_BYTES
    response = TTSVoiceImportStartResponse(
        upload_id="upload-1",
        expires_at="2026-08-06T00:00:00Z",
        accepted_total_bytes=VOICE_IMPORT_MAX_TOTAL_BYTES,
    )
    assert response.accepted_total_bytes == VOICE_IMPORT_MAX_TOTAL_BYTES

    with pytest.raises(ValidationError):
        TTSVoiceImportStartRequest(
            expected_total_bytes=VOICE_IMPORT_MAX_TOTAL_BYTES + 1,
            sha256=SHA,
            format="wav",
            sample_rate=24000,
            operation_id="upload-1",
        )
    with pytest.raises(ValidationError):
        TTSVoiceImportStartRequest(
            expected_total_bytes=1,
            sha256=SHA,
            format="wav",
            sample_rate=24000,
            duration_ms=VOICE_IMPORT_MAX_DURATION_MS + 1,
            operation_id="upload-1",
        )
    with pytest.raises(ValidationError):
        TTSVoiceImportStartRequest.model_validate(
            {
                "expected_total_bytes": 1,
                "accepted_total_bytes": 1,
                "sha256": SHA,
                "format": "wav",
                "sample_rate": 24000,
                "operation_id": "upload-1",
            }
        )
    with pytest.raises(ValidationError):
        TTSVoiceImportStartRequest.model_validate(
            {
                "expected_total_bytes": 1,
                "sha256": SHA,
                "format": "wav",
                "sample_rate": 24000,
                "operation_id": "upload-1",
                "source_audio": "AA==",
            }
        )
    with pytest.raises(ValidationError):
        TTSVoiceImportStartRequest(
            expected_total_bytes=1,
            sha256="A" * 64,
            format="wav",
            sample_rate=24000,
            operation_id="upload-1",
        )
    with pytest.raises(ValidationError):
        TTSVoiceImportStartRequest.model_validate(
            {
                "expected_total_bytes": 1,
                "sha256": SHA,
                "format": "mp4",
                "sample_rate": 24000,
                "operation_id": "upload-1",
            }
        )


def test_voice_import_chunk_enforces_base64_size_sequence_and_hash() -> None:
    payload = b"a" * VOICE_IMPORT_MAX_CHUNK_BYTES
    encoded = base64.b64encode(payload).decode("ascii")
    request = TTSVoiceImportChunkRequest(
        upload_id="upload-1",
        sequence=42,
        chunk_data=encoded,
        chunk_sha256=hashlib.sha256(payload).hexdigest(),
        operation_id="chunk-42",
    )
    assert request.sequence == 42
    assert len(encoded) <= VOICE_IMPORT_MAX_BASE64_CHARS

    with pytest.raises(ValidationError):
        TTSVoiceImportChunkRequest(
            upload_id="upload-1", sequence=43, chunk_data=encoded, operation_id="chunk-43"
        )
    with pytest.raises(ValidationError, match="valid base64"):
        TTSVoiceImportChunkRequest(
            upload_id="upload-1", sequence=0, chunk_data="****", operation_id="chunk-0"
        )
    with pytest.raises(ValidationError):
        TTSVoiceImportChunkRequest(
            upload_id="upload-1",
            sequence=0,
            chunk_data=base64.b64encode(payload + b"x").decode("ascii"),
            operation_id="chunk-0",
        )
    with pytest.raises(ValidationError, match="mismatch"):
        TTSVoiceImportChunkRequest(
            upload_id="upload-1",
            sequence=0,
            chunk_data=encoded,
            chunk_sha256="1" * 64,
            operation_id="chunk-0",
        )
    with pytest.raises(ValidationError):
        TTSVoiceImportChunkRequest.model_validate(
            {"upload_id": "upload-1", "sequence": 0, "chunk_data": encoded}
        )
    with pytest.raises(ValidationError, match="must not be empty"):
        TTSVoiceImportChunkRequest(
            upload_id="upload-1", sequence=0, chunk_data="", operation_id="chunk-0"
        )
    assert len(request.model_dump_json().encode("utf-8")) < 128 * 1024
    with pytest.raises(ValidationError, match="at most 256"):
        TTSVoiceImportChunkRequest(
            upload_id="upload-1",
            sequence=0,
            chunk_data="YQ==",
            operation_id="chunk-0",
            correlation_id="x" * 257,
        )
    chunk_response = TTSVoiceImportChunkResponse(
        upload_id="upload-1",
        sequence=42,
        status="duplicate",
        received_bytes=VOICE_IMPORT_MAX_CHUNK_BYTES,
        next_sequence=43,
        idempotent=True,
    )
    assert chunk_response.status == "duplicate"
    with pytest.raises(ValidationError, match="idempotent"):
        TTSVoiceImportChunkResponse(
            upload_id="upload-1",
            sequence=0,
            status="duplicate",
            received_bytes=1,
            next_sequence=1,
        )


def test_voice_import_end_and_create_require_hash_operation_and_consent() -> None:
    end = TTSVoiceImportEndRequest(
        upload_id="upload-1",
        final_sequence=42,
        final_sha256=SHA,
        operation_id="seal-1",
    )
    assert end.final_sequence == 42

    with pytest.raises(ValidationError):
        TTSVoiceImportEndRequest(
            upload_id="upload-1", final_sequence=43, final_sha256=SHA, operation_id="seal-1"
        )
    with pytest.raises(ValidationError):
        TTSCreateVoiceProfileRequest.model_validate(
            {
                "display_name": "Mine",
                "sealed_audio_ref": "voice-import:ref-1",
                "consent": False,
                "operation_id": "create-1",
            }
        )
    created = TTSCreateVoiceProfileRequest.model_validate(
        {
            "display_name": "Mine",
            "sealed_audio_ref": "voice-import:ref-1",
            "language": "IT",
            "consent": True,
            "operation_id": "create-1",
            "expected_revision": "rev-1",
        }
    )
    assert created.language == "it"
    assert (
        TTSCreateVoiceProfileResponse(
            voice_id=CLONE_ID,
            status="created",
            accepted_duration_ms=6_000,
            revision="rev-1",
        ).voice_id
        == CLONE_ID
    )
    with pytest.raises(ValidationError):
        TTSCreateVoiceProfileRequest.model_validate(
            {
                "display_name": "Mine",
                "sealed_audio_ref": "ref-1",
                "consent": True,
                "operation_id": "create-1",
                "prompt_audio": "AA==",
            }
        )
    assert (
        TTSVoiceImportAbortRequest(
            upload_id="upload-1",
            operation_id="abort-1",
            expected_revision="rev-1",
        ).expected_revision
        == "rev-1"
    )
    end_response = TTSVoiceImportEndResponse(
        sealed_audio_ref="ref-1",
        status="sealed",
        accepted_total_bytes=VOICE_IMPORT_MAX_TOTAL_BYTES,
        final_sha256=SHA,
        expires_at="2026-08-06T00:00:00Z",
    )
    assert end_response.sealed_audio_ref == "ref-1"
    abort_response = TTSVoiceImportAbortResponse(
        upload_id="upload-1",
        status="expired",
        deleted_bytes=VOICE_IMPORT_MAX_CHUNK_BYTES,
        idempotent=True,
    )
    assert abort_response.status == "expired"


def test_tts_management_methods_have_explicit_response_dtos() -> None:
    assert (
        TTSUpdateVoiceProfileResponse(
            voice_id=CLONE_ID, status="revision_conflict", revision="rev-2", idempotent=True
        ).status
        == "revision_conflict"
    )
    assert (
        TTSInstallVoiceProfileResponse(
            voice_id=STANDARD_ID,
            status="unchanged",
            revision="rev-1",
            idempotent=True,
        ).status
        == "unchanged"
    )
    assert (
        TTSRemoveVoiceProfileResponse(voice_id=STANDARD_ID, status="not_found").status
        == "not_found"
    )
    assert (
        TTSSetDefaultVoiceResponse(
            voice_id=STANDARD_ID, status="activated", revision="rev-2", idempotent=True
        ).status
        == "activated"
    )
    assert (
        TTSDeleteVoiceProfileResponse(voice_id=CLONE_ID, status="not_found").status == "not_found"
    )


def test_stt_language_auto_and_exact_candidate_rules() -> None:
    assert TranscribeAudioRequest(audio_data="AA==").language is None
    assert (
        TranscribeAudioRequest.model_validate({"audio_data": "AA==", "language": ""}).language
        is None
    )
    assert (
        TranscribeAudioRequest.model_validate(
            {
                "audio_data": "AA==",
                "language": "auto",
                "auto_language_candidates": ["fr", "en"],
            }
        ).language
        is None
    )
    assert TranscribeAudioRequest.model_validate(
        {"audio_data": "AA==", "auto_language_candidates": ["FR", "en", "fr"]}
    ).auto_language_candidates == [
        "en",
        "fr",
    ]
    assert (
        TranscribeAudioRequest.model_validate({"audio_data": "AA==", "language": "KO"}).language
        == "ko"
    )

    with pytest.raises(ValidationError, match="exact STT language"):
        TranscribeAudioRequest(
            audio_data="AA==", language="en", auto_language_candidates=["en", "fr"]
        )
    with pytest.raises(ValidationError):
        TranscribeAudioRequest.model_validate({"audio_data": "AA==", "language": "en--US"})
    with pytest.raises(ValidationError):
        TranscribeAudioRequest(
            audio_data="AA==",
            auto_language_candidates=["en", "fr", "de", "es", "it", "ja", "ko", "pt", "zh"],
        )

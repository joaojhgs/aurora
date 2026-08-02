from __future__ import annotations

from copy import deepcopy

import pytest

from app.services.gateway.mesh.models import (
    ManifestGrantEvidence,
    PeerManifest,
    PeerServiceInfo,
)
from app.services.gateway.mesh.negotiation import (
    finalize_recipient_projection_evidence,
    manifest_projection_digest,
    manifest_to_dict,
    parse_manifest,
    parse_manifest_with_evidence,
)
from app.services.gateway.mesh.provider_export import (
    LEGACY_MANIFEST_PROTOCOL,
    SUPPORTED_PROTOCOLS,
    SUPPORTED_SHADOW_PROTOCOL,
    GrantEvidence,
    RecipientEvidence,
)
from app.shared.contracts.models.gateway import MethodInfo


def _service() -> PeerServiceInfo:
    service = PeerServiceInfo(
        module="TTS",
        version="1.0.0",
        capabilities=["audio"],
        available_feature_ids=[],
        methods=[
            MethodInfo(
                name="Speak",
                bus_topic="TTS.Speak",
                exposure="both",
                required_perms=["TTS.Speak"],
                method_type="use",
                input_model="Input",
                output_model="Output",
                input_schema={"title": "Input", "type": "object"},
                output_schema={"title": "Output", "type": "object"},
            )
        ],
        max_concurrent=3,
    )
    from app.services.gateway.mesh.negotiation import _compute_service_digest

    service.digest = _compute_service_digest(service)
    return service


def _legacy_manifest(**overrides):
    payload = {
        "type": "manifest",
        "peer_id": "provider-peer",
        "node_name": "provider",
        "shared_services": [_service().model_dump(mode="json")],
        "active_protocol": LEGACY_MANIFEST_PROTOCOL,
        "active_version": "v0",
        "active_tier": "legacy",
        "supported_protocols": list(SUPPORTED_PROTOCOLS),
        "projection_supported": True,
        "projection_active": False,
        "recipient_projection_evidence": None,
        "granted_permissions": None,
        "timestamp": "",
    }
    payload.update(overrides)
    if overrides.get("active_protocol", object()) is None:
        for companion in (
            "active_version",
            "active_tier",
            "supported_protocols",
            "projection_supported",
            "projection_active",
            "recipient_projection_evidence",
            "granted_permissions",
        ):
            if companion not in overrides:
                payload[companion] = None
    return payload


def _projection_manifest(**overrides):
    manifest = PeerManifest(
        peer_id="provider-peer",
        shared_services=[_service()],
        active_protocol=SUPPORTED_SHADOW_PROTOCOL,
        active_version="v1",
        active_tier="projection",
        supported_protocols=list(SUPPORTED_PROTOCOLS),
        projection_supported=True,
        projection_active=True,
    )
    evidence = finalize_recipient_projection_evidence(
        {
            "provider_peer_id": "provider-peer",
            "recipient_peer_id": "recipient-peer",
            "registry_revision": "1",
            "registry_digest": "registry-digest",
            "policy_revision": "1",
            "policy_digest": "policy-digest",
            "auth_grant_revision": 1,
            "auth_grant_state": "active",
            "auth_grant_digest": "authority-digest",
            "grants_digest": "",
            "projection_digest": manifest_projection_digest(manifest),
            "evidence_digest": "",
            "grants": [ManifestGrantEvidence(permission="TTS.Speak").model_dump(mode="json")],
        }
    )
    payload = manifest_to_dict(manifest)
    payload["recipient_projection_evidence"] = evidence.model_dump(mode="json")
    payload.update(overrides)
    return payload


def _refinalize_projection_payload(payload: dict) -> dict:
    from app.services.gateway.mesh.negotiation import _compute_service_digest

    for index, raw_service in enumerate(payload["shared_services"]):
        service = PeerServiceInfo.model_validate(raw_service)
        service.digest = _compute_service_digest(service)
        payload["shared_services"][index] = service.model_dump(mode="json")
    manifest = PeerManifest.model_validate(
        {
            key: value
            for key, value in payload.items()
            if key not in {"type", "recipient_projection_evidence"}
        }
    )
    evidence = dict(payload["recipient_projection_evidence"])
    evidence["projection_digest"] = manifest_projection_digest(manifest)
    payload["recipient_projection_evidence"] = finalize_recipient_projection_evidence(
        evidence
    ).model_dump(mode="json")
    return payload


def _canonical_projection_payload() -> dict:
    payload = _projection_manifest()
    tts_service = payload["shared_services"][0]
    demo_service = deepcopy(tts_service)
    demo_service.update(
        module="Demo",
        capabilities=["alpha", "omega"],
        available_feature_ids=[],
        callable_features=[],
    )
    demo_service["methods"][0].update(
        name="Alpha",
        bus_topic="Demo.Alpha",
        required_perms=["Demo.Alpha"],
    )
    second_method = deepcopy(demo_service["methods"][0])
    second_method.update(name="Omega", bus_topic="Demo.Omega", required_perms=["Demo.Omega"])
    demo_service["methods"].append(second_method)
    payload["shared_services"] = [demo_service, tts_service]
    return _refinalize_projection_payload(payload)


def test_missing_legacy_manifest_is_accepted_as_unverifiable() -> None:
    payload = _legacy_manifest()
    for key in (
        "active_protocol",
        "active_version",
        "active_tier",
        "supported_protocols",
        "projection_supported",
        "projection_active",
        "recipient_projection_evidence",
        "granted_permissions",
    ):
        payload.pop(key, None)

    result = parse_manifest_with_evidence(payload)

    assert result.status == "legacy_unverifiable"
    assert result.usable is True
    assert parse_manifest(payload) is not None


def test_null_only_legacy_protocol_metadata_is_accepted_as_unverifiable() -> None:
    payload = _legacy_manifest(active_protocol=None)

    result = parse_manifest_with_evidence(payload)

    assert result.status == "legacy_unverifiable"
    assert result.usable is True


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("active_version", "v0"),
        ("active_tier", "legacy"),
        ("supported_protocols", list(SUPPORTED_PROTOCOLS)),
        ("projection_supported", True),
        ("projection_active", False),
        ("recipient_projection_evidence", {}),
        ("granted_permissions", []),
    ],
)
def test_missing_protocol_rejects_non_null_companion_metadata(field: str, value: object) -> None:
    payload = _legacy_manifest(active_protocol=None)
    payload[field] = value

    result = parse_manifest_with_evidence(payload)

    assert result.status == "invalid"
    assert result.reason_code == "protocol_metadata_without_protocol"
    assert parse_manifest(payload) is None


def test_explicit_legacy_manifest_declares_no_projection_evidence() -> None:
    result = parse_manifest_with_evidence(_legacy_manifest())

    assert result.status == "legacy_unverifiable"
    assert result.usable is True
    assert result.manifest is not None
    assert result.manifest.granted_permissions is None
    assert result.manifest.recipient_projection_evidence is None


def test_legacy_manifest_with_recipient_evidence_is_rejected() -> None:
    payload = _legacy_manifest(granted_permissions=["TTS.Speak"])

    result = parse_manifest_with_evidence(payload)

    assert result.status == "invalid"
    assert result.reason_code == "legacy_smuggled_evidence"
    assert parse_manifest(payload) is None


def test_unknown_future_protocol_is_unsupported_not_downgraded() -> None:
    payload = _legacy_manifest(active_protocol="future-v9")
    payload["future_extension"] = {"recipient_projection": {"version": 9}}
    payload["shared_services"][0]["future_service_extension"] = True
    payload["recipient_projection_evidence"] = {"future_authority_format": {"revision": 99}}
    payload["granted_permissions"] = ["future-grant-format"]

    result = parse_manifest_with_evidence(payload)

    assert result.status == "unsupported"
    assert result.usable is False
    assert result.reason_code == "unsupported_protocol"
    assert parse_manifest(payload) is None


def test_complete_projection_v1_evidence_is_verified() -> None:
    payload = _projection_manifest()

    result = parse_manifest_with_evidence(
        payload,
        expected_provider_peer_id="provider-peer",
        expected_recipient_peer_id="recipient-peer",
    )

    assert result.status == "verified"
    assert result.usable is True
    assert parse_manifest(payload) is not None


def test_projection_missing_evidence_is_permissions_unknown_and_unusable() -> None:
    payload = _projection_manifest(recipient_projection_evidence=None)

    result = parse_manifest_with_evidence(payload)

    assert result.status == "permissions_unknown"
    assert result.usable is False
    assert parse_manifest(payload) is None


@pytest.mark.parametrize(
    "field",
    [
        "recipient_peer_id",
        "auth_grant_revision",
        "auth_grant_state",
        "auth_grant_digest",
        "grants_digest",
        "grants",
    ],
)
@pytest.mark.parametrize("mutation", ["missing", "null"])
def test_projection_missing_raw_authority_is_permissions_unknown(
    field: str,
    mutation: str,
) -> None:
    payload = _projection_manifest()
    evidence = payload["recipient_projection_evidence"]
    if mutation == "missing":
        evidence.pop(field)
    else:
        evidence[field] = None

    result = parse_manifest_with_evidence(payload)

    assert result.status == "permissions_unknown"
    assert result.usable is False
    assert result.reason_code == "authority_evidence_missing"
    assert parse_manifest(payload) is None


def test_projection_authority_revision_zero_is_permissions_unknown() -> None:
    payload = _projection_manifest()
    evidence = payload["recipient_projection_evidence"]
    evidence["auth_grant_revision"] = 0
    payload["recipient_projection_evidence"] = finalize_recipient_projection_evidence(
        evidence
    ).model_dump(mode="json")

    result = parse_manifest_with_evidence(payload)

    assert result.status == "permissions_unknown"
    assert result.reason_code == "authority_revision_unknown"
    assert parse_manifest(payload) is None


def test_projection_authority_digest_matches_phase1_semantics_and_rejects_tampering() -> None:
    payload = _projection_manifest()
    evidence = payload["recipient_projection_evidence"]
    expected = RecipientEvidence(
        peer_id="recipient-peer",
        revision=1,
        grants=(GrantEvidence("TTS.Speak"),),
        state="active",
    )

    assert evidence["auth_grant_digest"] == expected.digest

    evidence["auth_grant_digest"] = "tampered-authority-digest"
    result = parse_manifest_with_evidence(payload)

    assert result.status == "invalid"
    assert result.reason_code == "authority_digest_mismatch"
    assert parse_manifest(payload) is None


def test_projection_provider_or_recipient_mismatch_is_invalid() -> None:
    provider = parse_manifest_with_evidence(
        _projection_manifest(),
        expected_provider_peer_id="other-provider",
        expected_recipient_peer_id="recipient-peer",
    )
    recipient = parse_manifest_with_evidence(
        _projection_manifest(),
        expected_provider_peer_id="provider-peer",
        expected_recipient_peer_id="other-recipient",
    )

    assert provider.status == "invalid"
    assert provider.reason_code == "provider_peer_id_mismatch"
    assert recipient.status == "invalid"
    assert recipient.reason_code == "recipient_peer_id_mismatch"


def test_projection_digest_mutation_is_invalid() -> None:
    payload = _projection_manifest()
    payload["shared_services"][0]["methods"][0]["input_schema"]["title"] = "Mutated"

    result = parse_manifest_with_evidence(payload)

    assert result.status == "invalid"
    assert parse_manifest(payload) is None


def test_projection_wire_normalizes_integral_floats_for_browser_digest() -> None:
    payload = _projection_manifest()
    input_schema = payload["shared_services"][0]["methods"][0]["input_schema"]
    input_schema["properties"] = {
        "offset": {"type": "number", "default": 0.0},
        "ratio": {"type": "number", "default": 1.5},
    }
    payload = _refinalize_projection_payload(payload)
    manifest = PeerManifest.model_validate(
        {key: value for key, value in payload.items() if key != "type"}
    )

    wire = manifest_to_dict(manifest)
    wire_schema = wire["shared_services"][0]["methods"][0]["input_schema"]

    assert type(wire_schema["properties"]["offset"]["default"]) is int
    assert wire_schema["properties"]["offset"]["default"] == 0
    assert wire_schema["properties"]["ratio"]["default"] == 1.5
    result = parse_manifest_with_evidence(wire)
    assert result.status == "verified"
    assert result.usable is True


def test_legacy_opaque_service_digest_remains_accepted() -> None:
    payload = _legacy_manifest()
    payload["shared_services"][0]["digest"] = "opaque-legacy-v0-digest"

    result = parse_manifest_with_evidence(payload)

    assert result.status == "legacy_unverifiable"
    assert result.usable is True
    assert parse_manifest(payload) is not None


def test_legacy_noncanonical_arrays_remain_accepted() -> None:
    payload = _legacy_manifest()
    tts_service = payload["shared_services"][0]
    tts_service["capabilities"] = ["zeta", "alpha"]
    tts_service["available_feature_ids"] = ["zeta", "alpha"]
    tts_service["methods"][0]["required_perms"] = ["zeta", "alpha"]
    second_method = deepcopy(tts_service["methods"][0])
    second_method.update(name="Alpha", bus_topic="TTS.Alpha")
    tts_service["methods"].append(second_method)
    payload["shared_services"].append(
        {
            **deepcopy(tts_service),
            "module": "AAA",
            "methods": [
                {
                    **deepcopy(tts_service["methods"][0]),
                    "bus_topic": "AAA.Speak",
                }
            ],
        }
    )

    result = parse_manifest_with_evidence(payload)

    assert result.status == "legacy_unverifiable"
    assert result.usable is True
    assert parse_manifest(payload) is not None


@pytest.mark.parametrize(
    "mutation",
    [
        "services",
        "methods",
        "capabilities",
        "available_features",
        "required_permissions",
        "method_feature_ids",
        "service_feature_objects",
        "service_feature_method_ids",
        "method_feature_objects",
        "method_feature_method_ids",
        "missing_method_topic",
    ],
)
def test_projection_arrays_must_be_canonical(mutation: str) -> None:
    payload = _canonical_projection_payload()
    demo_service = payload["shared_services"][0]
    demo_method = demo_service["methods"][0]
    if mutation == "services":
        payload["shared_services"].reverse()
    elif mutation == "methods":
        demo_service["methods"].reverse()
    elif mutation == "capabilities":
        demo_service["capabilities"] = ["z", "a"]
    elif mutation == "available_features":
        demo_service["available_feature_ids"] = ["z", "a"]
    elif mutation == "required_permissions":
        demo_method["required_perms"] = ["z", "a"]
    elif mutation == "method_feature_ids":
        demo_method["callable_feature_ids"] = ["z", "a"]
    elif mutation == "service_feature_objects":
        demo_service["callable_features"] = [
            {"feature_id": "z", "module": "Demo", "method_ids": []},
            {"feature_id": "a", "module": "Demo", "method_ids": []},
        ]
    elif mutation == "service_feature_method_ids":
        demo_service["callable_features"] = [
            {
                "feature_id": "a",
                "module": "Demo",
                "method_ids": ["Demo.Z", "Demo.A"],
            }
        ]
    elif mutation == "method_feature_objects":
        demo_method["callable_features"] = [
            {"feature_id": "z", "module": "Demo", "method_ids": []},
            {"feature_id": "a", "module": "Demo", "method_ids": []},
        ]
    elif mutation == "method_feature_method_ids":
        demo_method["callable_features"] = [
            {
                "feature_id": "a",
                "module": "Demo",
                "method_ids": ["Demo.Z", "Demo.A"],
            }
        ]
    elif mutation == "missing_method_topic":
        demo_method["bus_topic"] = None
    _refinalize_projection_payload(payload)
    result = parse_manifest_with_evidence(payload)

    assert result.status == "invalid"
    assert result.reason_code == "projection_not_canonical"
    assert parse_manifest(payload) is None


def test_projection_rejects_ignored_nested_extension_fields() -> None:
    payload = _projection_manifest()
    payload["shared_services"][0]["methods"][0]["projection_extension"] = "smuggled"

    result = parse_manifest_with_evidence(payload)

    assert result.status == "invalid"
    assert result.reason_code == "projection_unknown_nested_field"
    assert parse_manifest(payload) is None


def test_noncanonical_protocols_duplicates_and_unknown_fields_are_invalid() -> None:
    noncanonical = parse_manifest_with_evidence(
        _projection_manifest(supported_protocols=list(reversed(SUPPORTED_PROTOCOLS)))
    )
    duplicate_services = _projection_manifest()
    duplicate_services["shared_services"].append(deepcopy(duplicate_services["shared_services"][0]))
    duplicate_result = parse_manifest_with_evidence(duplicate_services)
    smuggled = parse_manifest_with_evidence({**_legacy_manifest(), "projection_digest": "smuggled"})

    assert noncanonical.status == "invalid"
    assert duplicate_result.status == "invalid"
    assert smuggled.status == "invalid"


def test_projection_duplicate_grants_are_invalid() -> None:
    payload = _projection_manifest()
    grants = payload["recipient_projection_evidence"]["grants"]
    grants.append(dict(grants[0]))

    result = parse_manifest_with_evidence(payload)

    assert result.status == "invalid"
    assert parse_manifest(payload) is None


def test_finalize_projection_evidence_requires_explicit_grants() -> None:
    evidence = _projection_manifest()["recipient_projection_evidence"]
    evidence.pop("grants")

    with pytest.raises(ValueError, match="grants"):
        finalize_recipient_projection_evidence(evidence)

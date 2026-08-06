"""Focused tests for the pure shadow-only mesh provider export core."""

from __future__ import annotations

import json
from dataclasses import FrozenInstanceError, replace

import pytest

from app.services.gateway.mesh.negotiation import (
    manifest_from_projection,
    manifest_to_dict,
    parse_manifest_with_evidence,
)
from app.services.gateway.mesh.provider_export import (
    ACTIVE_MANIFEST_PROTOCOL,
    SUPPORTED_SHADOW_PROTOCOL,
    ConflictingAuthorityRevisionError,
    GrantEvidence,
    NormalizedMethodSnapshot,
    NormalizedServiceSnapshot,
    PeerProviderExportCache,
    PolicySnapshot,
    ProtocolEvidence,
    ProviderExportError,
    RecipientEvidence,
    RegistrySnapshot,
    ServiceExportPolicy,
    StaleAuthorityRevisionError,
    build_cache_key,
    canonical_bytes,
    canonical_digest,
    project_provider_export,
)
from app.shared.contracts.mesh_surface import (
    PUBLIC_INFRASTRUCTURE_TOPICS,
    feature_contracts_for_module,
)
from app.shared.contracts.models.speech import SpeechMethodConstraints

DEFAULT_PERMS = object()
DEFAULT_CAPACITY = object()


def method(
    topic: str,
    *,
    exposure: str = "external",
    method_type: str = "use",
    perms=DEFAULT_PERMS,
    features: tuple[str, ...] = (),
    public_infrastructure: bool = False,
    input_model: str | None = "Input",
    output_model: str | None = "Output",
    input_schema: dict | None = None,
    output_schema: dict | None = None,
    input_schema_hash: str | None = None,
    output_schema_hash: str | None = None,
    speech_constraints: dict | SpeechMethodConstraints | None = None,
) -> NormalizedMethodSnapshot:
    required_permissions = (topic,) if perms is DEFAULT_PERMS else perms
    return NormalizedMethodSnapshot(
        topic=topic,
        exposure=exposure,
        method_type=method_type,
        required_permissions=required_permissions,
        input_model=input_model,
        output_model=output_model,
        input_schema=input_schema or {"type": "object", "title": f"{topic}Input"},
        output_schema=output_schema or {"type": "object", "title": f"{topic}Output"},
        input_schema_hash=input_schema_hash,
        output_schema_hash=output_schema_hash,
        feature_ids=features,
        public_infrastructure=public_infrastructure,
        speech_constraints=speech_constraints,
    )


def service(
    service_id: str = "TTS",
    *,
    methods: tuple[NormalizedMethodSnapshot, ...] | None = None,
    version: str = "1.0.0",
    tags: tuple[str, ...] = ("audio",),
    capacity=DEFAULT_CAPACITY,
    feature_members: dict[str, tuple[str, ...]] | None = None,
) -> NormalizedServiceSnapshot:
    return NormalizedServiceSnapshot(
        service_id=service_id,
        version=version,
        methods=methods or (method(f"{service_id}.Speak"),),
        tags=tags,
        capacity={"max_concurrent": 2} if capacity is DEFAULT_CAPACITY else capacity,
        feature_members=feature_members or {},
    )


def registry(
    *services: NormalizedServiceSnapshot,
    revision: str = "registry-1",
    digest: str | None = None,
) -> RegistrySnapshot:
    return RegistrySnapshot(revision=revision, services=services or (service(),), digest=digest)


def policy(
    *policies: ServiceExportPolicy,
    revision: str = "policy-1",
    digest: str | None = None,
) -> PolicySnapshot:
    return PolicySnapshot(
        revision=revision,
        services=policies or (ServiceExportPolicy(service_id="TTS", share=True),),
        digest=digest,
    )


def recipient(
    *grants: str,
    peer_id: str = "recipient-a",
    revision: int = 1,
    digest: str | None = None,
    state: str = "active",
    grants_unknown: bool = False,
) -> RecipientEvidence:
    return RecipientEvidence(
        peer_id=peer_id,
        revision=revision,
        grants=None if grants_unknown else tuple(GrantEvidence(grant) for grant in grants),
        digest=digest,
        state=state,
    )


def project(
    *,
    reg: RegistrySnapshot | None = None,
    pol: PolicySnapshot | None = None,
    rec: RecipientEvidence | None = None,
    provider_peer_id: str = "provider-a",
    proto: ProtocolEvidence | None = None,
):
    return project_provider_export(
        provider_peer_id=provider_peer_id,
        registry=reg or registry(),
        policy=pol or policy(),
        recipient=rec or recipient("TTS.Speak"),
        protocol=proto,
    )


def topics(result) -> list[str]:
    return [method.topic for service in result.services for method in service.methods]


def reason_counts(result) -> dict[str, int]:
    return {entry.reason: entry.count for entry in result.diff.reason_counts}


def encoded(value) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return json.dumps(value, sort_keys=True, default=repr)


def test_provider_and_recipient_ids_are_required_and_keyed_independently() -> None:
    base = project(rec=recipient("TTS.Speak", peer_id="recipient-a"))
    changed_provider = project(provider_peer_id="provider-b", rec=recipient("TTS.Speak"))
    changed_recipient = project(rec=recipient("TTS.Speak", peer_id="recipient-b"))

    assert base.cache_key.provider_peer_id == "provider-a"
    assert base.cache_key.recipient_peer_id == "recipient-a"
    assert base.cache_key.digest != changed_provider.cache_key.digest
    assert base.cache_key.digest != changed_recipient.cache_key.digest
    assert changed_provider.cache_key.digest != changed_recipient.cache_key.digest
    with pytest.raises(ProviderExportError):
        project(provider_peer_id=" ")
    with pytest.raises(ProviderExportError):
        recipient("TTS.Speak", peer_id="")


def test_none_grants_unknown_differs_from_empty_known_deny_all_and_never_calls_check_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def fail_if_called(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise AssertionError("check_access must not receive unknown grants")

    monkeypatch.setattr("app.services.gateway.mesh.provider_export.check_access", fail_if_called)
    unknown = project(rec=recipient(revision=1, grants_unknown=True, state="unknown"))
    empty = project(rec=recipient(revision=2))

    assert calls == 0
    assert unknown.readiness == "unknown"
    assert empty.readiness == "ready"
    assert reason_counts(unknown) == {"authority_unknown": 1}
    assert reason_counts(empty) == {"permissions_denied": 1}
    assert unknown.cache_key.grants_digest != empty.cache_key.grants_digest
    assert unknown.cache_key.digest != empty.cache_key.digest


def test_method_permissions_none_and_empty_are_distinct_fail_closed_states() -> None:
    unknown_contract = method("TTS.Unknown", perms=None)
    empty_contract = NormalizedMethodSnapshot(
        topic="TTS.Empty",
        exposure="external",
        method_type="use",
        required_permissions=(),
    )
    reg = registry(service(methods=(unknown_contract, empty_contract)))

    result = project(reg=reg, rec=recipient("*", revision=3))

    assert result.services == ()
    assert reason_counts(result) == {"permissions_empty": 1, "permissions_unknown": 1}


def test_duplicate_and_empty_grants_are_rejected_not_normalized() -> None:
    with pytest.raises(ProviderExportError, match="duplicate grant"):
        RecipientEvidence(
            peer_id="recipient-a",
            revision=1,
            grants=(GrantEvidence("TTS.Speak"), GrantEvidence("TTS.Speak")),
        )
    with pytest.raises(ProviderExportError, match="grant permission"):
        GrantEvidence("")


def test_public_diff_redacts_removed_ids_permissions_grants_schemas_and_payloads() -> None:
    secret_topic = "TTS.SecretPayloadTopic"
    secret_perm = "TTS.SecretGrant"
    secret_schema = {
        "title": "RawSecretSchema",
        "properties": {"token": {"const": "secret-payload-value"}},
    }
    hidden = method(secret_topic, perms=(secret_perm,), input_schema=secret_schema)
    reg = registry(
        service(
            service_id="TTS",
            methods=(hidden,),
            tags=("secret-service-tag",),
            capacity={"secret_capacity": "secret-capacity-value"},
        )
    )

    result = project(reg=reg, rec=recipient("Config.Read", "TTS.SecretGrantForOther"))
    diagnostic_text = repr(result.diff) + encoded(result.diff.to_canonical())

    assert result.diff.excluded_count == 1
    assert reason_counts(result) == {"permissions_denied": 1}
    for forbidden in (
        "SecretPayloadTopic",
        "TTS.SecretPayloadTopic",
        secret_perm,
        "TTS.SecretGrantForOther",
        "RawSecretSchema",
        "secret-payload-value",
        "secret-service-tag",
        "secret-capacity-value",
    ):
        assert forbidden not in diagnostic_text
    assert set(result.diff.to_canonical()) == {
        "excluded_count",
        "excluded_digest",
        "included_digest",
        "included_method_count",
        "included_service_count",
        "reason_counts",
    }


@pytest.mark.parametrize("topic", PUBLIC_INFRASTRUCTURE_TOPICS)
def test_exact_public_infrastructure_topics_are_excluded_only_when_correctly_marked(
    topic: str,
) -> None:
    infra = NormalizedMethodSnapshot(
        topic=topic,
        exposure="both",
        method_type="use",
        required_permissions=(),
        public_infrastructure=True,
    )
    reg = registry(service("Auth", methods=(infra,)))
    pol = policy(ServiceExportPolicy(service_id="Auth", share=True))

    result = project(reg=reg, pol=pol, rec=recipient("*"))

    assert result.services == ()
    assert reason_counts(result) == {"public_infrastructure_excluded": 1}


def test_public_infrastructure_spoof_missing_marker_and_feature_membership_reject() -> None:
    with pytest.raises(ProviderExportError, match="missing public_infrastructure marker"):
        service(
            "Auth",
            methods=(
                NormalizedMethodSnapshot(
                    topic="Auth.Login",
                    exposure="both",
                    method_type="use",
                    required_permissions=(),
                ),
            ),
        )
    with pytest.raises(ProviderExportError, match="not an allowed public infrastructure"):
        service(
            "Auth",
            methods=(
                NormalizedMethodSnapshot(
                    topic="Auth.WhoAmI",
                    exposure="both",
                    method_type="use",
                    required_permissions=(),
                    public_infrastructure=True,
                ),
            ),
        )
    with pytest.raises(ProviderExportError, match="does not belong to service"):
        service(
            "TTS",
            methods=(
                NormalizedMethodSnapshot(
                    topic="Auth.Login",
                    exposure="both",
                    method_type="use",
                    required_permissions=(),
                    public_infrastructure=True,
                ),
            ),
        )
    with pytest.raises(ProviderExportError, match="must not declare callable features"):
        service(
            "Auth",
            methods=(
                NormalizedMethodSnapshot(
                    topic="Auth.Login",
                    exposure="both",
                    method_type="use",
                    required_permissions=(),
                    feature_ids=("speech",),
                    public_infrastructure=True,
                ),
            ),
            feature_members={"speech": ("Auth.Login",)},
        )


def test_non_bootstrap_auth_methods_are_ordinary_rbac_methods() -> None:
    methods = (
        method("Auth.PairingApprove", perms=("Auth.PairingApprove",), method_type="manage"),
        method("Auth.ValidateToken", perms=("Auth.ValidateToken",)),
        method("Auth.RefreshToken", perms=("Auth.RefreshToken",)),
        method("Auth.Ordinary", perms=("Auth.Ordinary",)),
    )
    reg = registry(service("Auth", methods=methods))
    pol = policy(ServiceExportPolicy(service_id="Auth", share=True))

    result = project(reg=reg, pol=pol, rec=recipient("Auth.*"))

    assert topics(result) == [
        "Auth.Ordinary",
        "Auth.PairingApprove",
        "Auth.RefreshToken",
        "Auth.ValidateToken",
    ]
    assert reason_counts(result) == {}


@pytest.mark.parametrize(
    "factory",
    [
        lambda: registry(service(), service()),
        lambda: registry(
            service("TTS", methods=(method("TTS.Speak"),)),
            service("Audio", methods=(method("TTS.Speak"),)),
        ),
        lambda: service(" ", methods=(method("TTS.Speak"),)),
        lambda: method("TTS.Speak", features=("a", "a")),
        lambda: method("TTS.Speak", features=("",)),
        lambda: method("TTS.Speak", perms=("TTS.Speak", "TTS.Speak")),
        lambda: method("TTS.Speak", perms=("",)),
        lambda: NormalizedMethodSnapshot("TTS.Speak", "public", "use", ("TTS.Speak",)),
        lambda: NormalizedMethodSnapshot("TTS.Speak", "external", "admin", ("TTS.Speak",)),
        lambda: policy(ServiceExportPolicy("TTS", True), ServiceExportPolicy("TTS", False)),
        lambda: registry(revision=" "),
        lambda: policy(revision=" "),
        lambda: RegistrySnapshot(revision="r", services=(service(),), digest=" "),
        lambda: PolicySnapshot(
            revision="p", services=(ServiceExportPolicy("TTS", True),), digest=" "
        ),
        lambda: recipient("TTS.Speak", revision=-1),
        lambda: recipient("TTS.Speak", revision=True),
        lambda: recipient("TTS.Speak", peer_id=" recipient-a"),
        lambda: GrantEvidence(" TTS.Speak"),
        lambda: method("TTS.Speak ", perms=("TTS.Speak",)),
        lambda: service("TTS ", methods=(method("TTS.Speak"),)),
        lambda: ServiceExportPolicy(" TTS", True),
        lambda: ServiceExportPolicy("TTS", True, max_concurrent=-1),
        lambda: ServiceExportPolicy("TTS", True, max_concurrent=True),
        lambda: ServiceExportPolicy("TTS", True, max_concurrent="2"),
    ],
)
def test_invalid_normalized_inputs_are_rejected(factory) -> None:
    with pytest.raises(ProviderExportError):
        factory()


@pytest.mark.parametrize(
    "feature_members",
    [
        {"speech": ()},
        {"speech": ("",)},
        {"speech": ("TTS.Missing",)},
        {"speech": ("DB.Query",)},
    ],
)
def test_invalid_feature_member_sets_are_rejected(
    feature_members: dict[str, tuple[str, ...]],
) -> None:
    with pytest.raises(ProviderExportError):
        service(
            methods=(method("TTS.Speak", features=("speech",)),),
            feature_members=feature_members,
        )


def test_method_feature_membership_must_match_canonical_feature_members() -> None:
    with pytest.raises(ProviderExportError, match="does not declare canonical feature"):
        service(
            methods=(method("TTS.Speak"),),
            feature_members={"speech": ("TTS.Speak",)},
        )
    with pytest.raises(ProviderExportError, match="declares unknown feature"):
        service(methods=(method("TTS.Speak", features=("speech",)),))
    with pytest.raises(ProviderExportError, match="inconsistent"):
        service(
            methods=(
                method("TTS.Speak", features=("speech",)),
                method("TTS.Play", features=("speech",)),
            ),
            feature_members={"speech": ("TTS.Play",)},
        )


def test_schema_hash_must_match_supplied_raw_schema() -> None:
    schema = {"type": "object", "properties": {"a": {"type": "string"}}}
    good_hash = canonical_digest(schema)
    assert method("TTS.Speak", input_schema=schema, input_schema_hash=good_hash).input_schema_hash
    with pytest.raises(ProviderExportError, match="schema hash"):
        method("TTS.Speak", input_schema=schema, input_schema_hash="spoofed")


def test_empty_schema_and_capacity_presence_are_authority_significant() -> None:
    no_schema = NormalizedMethodSnapshot(
        topic="TTS.Speak",
        exposure="external",
        method_type="use",
        required_permissions=("TTS.Speak",),
        input_schema=None,
        output_schema=None,
    )
    empty_schema = NormalizedMethodSnapshot(
        topic="TTS.Speak",
        exposure="external",
        method_type="use",
        required_permissions=("TTS.Speak",),
        input_schema={},
        output_schema={},
        input_schema_hash=canonical_digest({}),
        output_schema_hash=canonical_digest({}),
    )
    no_capacity = service(methods=(no_schema,), capacity=None)
    empty_capacity = service(methods=(no_schema,), capacity={})

    no_schema_result = project(reg=registry(service(methods=(no_schema,))))
    empty_schema_result = project(reg=registry(service(methods=(empty_schema,))))
    no_capacity_result = project(reg=registry(no_capacity))
    empty_capacity_result = project(reg=registry(empty_capacity))

    assert empty_schema.input_schema_hash == canonical_digest({})
    assert no_schema.to_canonical()["input_schema_present"] is False
    assert empty_schema.to_canonical()["input_schema_present"] is True
    assert no_capacity.to_canonical()["capacity_present"] is False
    assert empty_capacity.to_canonical()["capacity_present"] is True
    assert no_schema_result.cache_key.digest != empty_schema_result.cache_key.digest
    assert no_capacity_result.cache_key.digest != empty_capacity_result.cache_key.digest
    with pytest.raises(ProviderExportError, match="schema hash"):
        NormalizedMethodSnapshot(
            topic="TTS.Speak",
            exposure="external",
            method_type="use",
            required_permissions=("TTS.Speak",),
            input_schema={},
            input_schema_hash="wrong-empty-hash",
        )


def test_speech_constraints_are_canonical_and_change_projection_identity() -> None:
    constraints_v1 = SpeechMethodConstraints(
        exact_languages=["en", "de"],
        ready_voice_ids=["standard:test:voice-a"],
        resident_model_identity_digest="c" * 64,
        speech_capability_revision=1,
    )
    constraints_v2 = constraints_v1.model_copy(update={"speech_capability_revision": 2})
    constrained = method("TTS.Synthesize", speech_constraints=constraints_v1)
    changed = method("TTS.Synthesize", speech_constraints=constraints_v2)
    unconstrained = method("TTS.Synthesize")

    synthesize_recipient = recipient("TTS.Synthesize")
    constrained_result = project(
        reg=registry(service(methods=(constrained,))), rec=synthesize_recipient
    )
    changed_result = project(reg=registry(service(methods=(changed,))), rec=synthesize_recipient)
    unconstrained_result = project(
        reg=registry(service(methods=(unconstrained,))), rec=synthesize_recipient
    )

    exported = constrained_result.services[0].methods[0]
    assert exported.speech_constraints is not None
    assert exported.speech_constraints["exact_languages"] == ("de", "en")
    assert exported.to_canonical()["speech_constraints"]["speech_capability_revision"] == 1
    assert (
        constrained.to_canonical()["speech_constraints"]
        == exported.to_canonical()["speech_constraints"]
    )
    assert constrained_result.cache_key.digest != changed_result.cache_key.digest
    assert constrained_result.digest != changed_result.digest
    assert constrained_result.canonical != changed_result.canonical
    assert constrained_result.cache_key.digest != unconstrained_result.cache_key.digest
    assert unconstrained_result.services[0].methods[0].speech_constraints is None


def test_malformed_speech_constraints_are_rejected_by_normalized_snapshot() -> None:
    with pytest.raises(ProviderExportError):
        method(
            "TTS.Synthesize",
            speech_constraints={
                "exact_languages": ["pt-BR"],
                "resident_model_identity_digest": "d" * 64,
                "speech_capability_revision": 1,
            },
        )


def test_policy_max_concurrent_overlays_registry_capacity_and_changes_canonical_output() -> None:
    base_service = service(
        capacity={"max_concurrent": 9, "burst": {"window": "1s", "limit": 4}},
    )
    no_policy_capacity = project(
        reg=registry(base_service),
        pol=policy(ServiceExportPolicy("TTS", True)),
        rec=recipient("TTS.Speak"),
    )
    capped = project(
        reg=registry(base_service),
        pol=policy(ServiceExportPolicy("TTS", True, max_concurrent=0)),
        rec=recipient("TTS.Speak"),
    )
    changed = project(
        reg=registry(base_service),
        pol=policy(ServiceExportPolicy("TTS", True, max_concurrent=3)),
        rec=recipient("TTS.Speak"),
    )

    assert no_policy_capacity.services[0].capacity["max_concurrent"] == 9
    assert capped.services[0].capacity == {
        "burst": {"limit": 4, "window": "1s"},
        "max_concurrent": 0,
    }
    assert changed.services[0].capacity["max_concurrent"] == 3
    assert (
        capped.cache_key.policy_content_digest != no_policy_capacity.cache_key.policy_content_digest
    )
    assert capped.cache_key.digest != no_policy_capacity.cache_key.digest
    assert capped.digest != no_policy_capacity.digest
    assert capped.canonical != no_policy_capacity.canonical
    assert changed.digest != capped.digest


def test_policy_zero_max_concurrent_is_represented_when_registry_capacity_is_absent() -> None:
    absent_capacity = service(capacity=None)
    result = project(
        reg=registry(absent_capacity),
        pol=policy(ServiceExportPolicy("TTS", True, max_concurrent=0)),
        rec=recipient("TTS.Speak"),
    )

    assert result.services[0].capacity == {"max_concurrent": 0}
    assert json.loads(result.canonical)["services"][0]["capacity"] == {"max_concurrent": 0}


@pytest.mark.parametrize(
    ("grant", "topic", "method_type", "perms", "expected"),
    [
        ("TTS.Speak", "TTS.Speak", "use", ("TTS.Speak",), ["TTS.Speak"]),
        ("TTS.*", "TTS.Speak", "use", ("TTS.Speak",), ["TTS.Speak"]),
        ("TTS.use", "TTS.Speak", "use", ("TTS.Speak",), ["TTS.Speak"]),
        ("TTS.manage", "TTS.Configure", "manage", ("TTS.Configure",), ["TTS.Configure"]),
        ("*", "TTS.Speak", "use", ("TTS.Speak",), ["TTS.Speak"]),
        ("TTS.manage", "TTS.Speak", "use", ("TTS.Speak",), []),
    ],
)
def test_rbac_matching_uses_shared_check_access(
    grant: str,
    topic: str,
    method_type: str,
    perms: tuple[str, ...],
    expected: list[str],
) -> None:
    item = method(topic, method_type=method_type, perms=perms)

    result = project(reg=registry(service(methods=(item,))), rec=recipient(grant))

    assert topics(result) == expected


def test_multi_permission_requires_all_permissions() -> None:
    item = method("TTS.Combo", perms=("Config.Read", "TTS.Speak"))

    partial = project(reg=registry(service(methods=(item,))), rec=recipient("TTS.Speak"))
    complete = project(
        reg=registry(service(methods=(item,))),
        rec=recipient("TTS.Speak", "Config.Read"),
    )

    assert topics(partial) == []
    assert reason_counts(partial) == {"permissions_denied": 1}
    assert topics(complete) == ["TTS.Combo"]


def test_gate_order_is_locked_through_public_infra() -> None:
    infra = NormalizedMethodSnapshot(
        topic="Auth.Login",
        exposure="internal",
        method_type="use",
        required_permissions=(),
        public_infrastructure=True,
    )
    with pytest.raises(ProviderExportError, match="externally exposed"):
        service("Auth", methods=(infra,))

    blocked = method("TTS.Blocked", exposure="internal", features=("speech",))
    reg = registry(
        service(
            methods=(blocked,),
            feature_members={"speech": ("TTS.Blocked",)},
        )
    )
    pol = policy(
        ServiceExportPolicy(
            service_id="TTS",
            share=False,
            unshared_feature_ids=("speech",),
            unshared_method_ids=("TTS.Blocked",),
        )
    )

    result = project(reg=reg, pol=pol, rec=recipient("TTS.Blocked"))

    assert reason_counts(result) == {"service_not_shared": 1}


def test_exposure_feature_method_then_rbac_gate_order() -> None:
    methods = (
        method("TTS.Internal", exposure="internal", features=("internal_feature",)),
        method("TTS.Feature", features=("hidden",)),
        method("TTS.Method", perms=("TTS.Method",)),
        method("TTS.Rbac", perms=("TTS.Rbac",)),
    )
    reg = registry(
        service(
            methods=methods,
            feature_members={
                "hidden": ("TTS.Feature",),
                "internal_feature": ("TTS.Internal",),
            },
        )
    )
    pol = policy(
        ServiceExportPolicy(
            service_id="TTS",
            share=True,
            unshared_feature_ids=("hidden",),
            unshared_method_ids=("TTS.Method",),
        )
    )

    result = project(reg=reg, pol=pol, rec=recipient("Config.Read"))

    assert reason_counts(result) == {
        "exposure_not_exportable": 1,
        "feature_unshared": 1,
        "method_unshared": 1,
        "permissions_denied": 1,
    }


def test_partial_feature_keeps_method_but_not_feature_and_zero_method_service_omitted() -> None:
    synth = method("TTS.Synthesize", features=("speech",))
    request = method("TTS.Request", features=("speech",))
    reg = registry(
        service(
            methods=(synth, request),
            feature_members={"speech": ("TTS.Synthesize", "TTS.Request")},
        )
    )

    full = project(reg=reg, rec=recipient("TTS.Synthesize", "TTS.Request"))
    partial = project(
        reg=reg,
        pol=policy(
            ServiceExportPolicy(
                service_id="TTS",
                share=True,
                unshared_method_ids=("TTS.Request",),
            )
        ),
        rec=recipient("TTS.Synthesize", "TTS.Request"),
    )
    zero = project(
        reg=registry(service(methods=(method("TTS.Denied"),))), rec=recipient("Config.Read")
    )

    assert full.services[0].feature_ids == ("speech",)
    assert topics(partial) == ["TTS.Synthesize"]
    assert partial.services[0].methods[0].feature_ids == ("speech",)
    assert partial.services[0].methods[0].speech_constraints is None
    assert partial.services[0].feature_ids == ()
    assert zero.services == ()


def test_deterministic_reordering_for_legitimate_set_like_inputs() -> None:
    speak = method("TTS.Speak", features=("a",), perms=("Config.Read", "TTS.Speak"))
    play = method("TTS.Play", features=("b",), perms=("TTS.Play",))
    reg_a = registry(
        service(
            methods=(speak, play),
            tags=("z", "a"),
            feature_members={"a": ("TTS.Speak",), "b": ("TTS.Play",)},
        )
    )
    reg_b = registry(
        service(
            methods=(play, speak),
            tags=("a", "z"),
            feature_members={"b": ("TTS.Play",), "a": ("TTS.Speak",)},
        )
    )
    rec_a = recipient("TTS.Play", "Config.Read", "TTS.Speak")
    rec_b = recipient("TTS.Speak", "TTS.Play", "Config.Read")

    result_a = project(reg=reg_a, rec=rec_a)
    result_b = project(reg=reg_b, rec=rec_b)

    assert canonical_bytes(reg_a) == canonical_bytes(reg_b)
    assert result_a.canonical == result_b.canonical
    assert result_a.cache_key.digest == result_b.cache_key.digest
    assert result_a.digest == result_b.digest


def test_complete_cache_key_changes_for_each_semantic_input_one_at_a_time() -> None:
    base_method = method("TTS.Speak")
    base_service = service(methods=(base_method,))
    base_registry = registry(base_service)
    base_policy = policy()
    base_recipient = recipient("TTS.Speak")
    base_protocol = ProtocolEvidence()
    base = project(
        reg=base_registry,
        pol=base_policy,
        rec=base_recipient,
        provider_peer_id="provider-a",
        proto=base_protocol,
    ).cache_key.digest

    changed_inputs = [
        ("provider", "provider-b", base_registry, base_policy, base_recipient, base_protocol),
        (
            "recipient",
            "provider-a",
            base_registry,
            base_policy,
            recipient("TTS.Speak", peer_id="recipient-b"),
            base_protocol,
        ),
        (
            "registry_revision",
            "provider-a",
            registry(base_service, revision="registry-2"),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "registry_digest",
            "provider-a",
            registry(base_service, digest="registry-digest-2"),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "service_version",
            "provider-a",
            registry(replace(base_service, version="2.0.0")),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "service_tags",
            "provider-a",
            registry(replace(base_service, tags=("new",))),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "service_capacity",
            "provider-a",
            registry(replace(base_service, capacity={"max_concurrent": 9})),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "method_topic",
            "provider-a",
            registry(service(methods=(method("TTS.Other"),))),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "method_exposure",
            "provider-a",
            registry(service(methods=(replace(base_method, exposure="both"),))),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "method_type",
            "provider-a",
            registry(service(methods=(replace(base_method, method_type="manage"),))),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "method_permissions",
            "provider-a",
            registry(service(methods=(replace(base_method, required_permissions=("TTS.*",)),))),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "input_model",
            "provider-a",
            registry(service(methods=(replace(base_method, input_model="OtherInput"),))),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "output_model",
            "provider-a",
            registry(service(methods=(replace(base_method, output_model="OtherOutput"),))),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "input_schema",
            "provider-a",
            registry(service(methods=(method("TTS.Speak", input_schema={"changed": True}),))),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "output_schema",
            "provider-a",
            registry(service(methods=(method("TTS.Speak", output_schema={"changed": True}),))),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "schema_hash",
            "provider-a",
            registry(
                service(
                    methods=(
                        NormalizedMethodSnapshot(
                            topic="TTS.Speak",
                            exposure="external",
                            method_type="use",
                            required_permissions=("TTS.Speak",),
                            input_schema_hash="external-schema-hash",
                        ),
                    )
                )
            ),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "method_features",
            "provider-a",
            registry(
                service(
                    methods=(method("TTS.Speak", features=("speech",)),),
                    feature_members={"speech": ("TTS.Speak",)},
                )
            ),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "feature_members",
            "provider-a",
            registry(
                service(
                    methods=(method("TTS.Speak", features=("voice",)),),
                    feature_members={"voice": ("TTS.Speak",)},
                )
            ),
            base_policy,
            base_recipient,
            base_protocol,
        ),
        (
            "policy_revision",
            "provider-a",
            base_registry,
            policy(revision="policy-2"),
            base_recipient,
            base_protocol,
        ),
        (
            "policy_digest",
            "provider-a",
            base_registry,
            policy(digest="policy-digest-2"),
            base_recipient,
            base_protocol,
        ),
        (
            "policy_share",
            "provider-a",
            base_registry,
            policy(ServiceExportPolicy("TTS", False)),
            base_recipient,
            base_protocol,
        ),
        (
            "policy_unshared_feature",
            "provider-a",
            base_registry,
            policy(ServiceExportPolicy("TTS", True, unshared_feature_ids=("speech",))),
            base_recipient,
            base_protocol,
        ),
        (
            "policy_unshared_method",
            "provider-a",
            base_registry,
            policy(ServiceExportPolicy("TTS", True, unshared_method_ids=("TTS.Speak",))),
            base_recipient,
            base_protocol,
        ),
        (
            "authority_revision",
            "provider-a",
            base_registry,
            base_policy,
            recipient("TTS.Speak", revision=2),
            base_protocol,
        ),
        (
            "authority_digest",
            "provider-a",
            base_registry,
            base_policy,
            recipient("TTS.Speak", digest="auth-digest-2"),
            base_protocol,
        ),
        (
            "authority_state",
            "provider-a",
            base_registry,
            base_policy,
            recipient("TTS.Speak", state="pending"),
            base_protocol,
        ),
        (
            "authority_grants_none",
            "provider-a",
            base_registry,
            base_policy,
            recipient(grants_unknown=True),
            base_protocol,
        ),
        (
            "authority_grants_empty",
            "provider-a",
            base_registry,
            base_policy,
            recipient(),
            base_protocol,
        ),
        (
            "authority_grants_changed",
            "provider-a",
            base_registry,
            base_policy,
            recipient("TTS.Speak", "Config.Read"),
            base_protocol,
        ),
        (
            "protocol_state",
            "provider-a",
            base_registry,
            base_policy,
            base_recipient,
            ProtocolEvidence(evidence_state="refreshed"),
        ),
        (
            "protocol_revision",
            "provider-a",
            base_registry,
            base_policy,
            base_recipient,
            ProtocolEvidence(evidence_revision=1),
        ),
    ]

    digests = {
        name: project(
            reg=reg, pol=pol, rec=rec, provider_peer_id=provider_id, proto=proto
        ).cache_key.digest
        for name, provider_id, reg, pol, rec, proto in changed_inputs
    }

    assert len(set(digests.values())) == len(changed_inputs)
    assert base not in set(digests.values())


def test_projection_export_carries_authorized_method_requirements_and_key_binds_grants() -> None:
    item = method("TTS.Speak", perms=("TTS.Speak",), input_schema={"secret_schema": "hidden"})

    result = project(
        reg=registry(service(methods=(item,))), rec=recipient("TTS.Speak", "Secret.Grant")
    )
    export_text = encoded(result.canonical)
    key_text = encoded(result.cache_key.to_canonical())

    assert "secret_schema" in export_text
    assert "TTS.Speak" in export_text
    assert "Secret.Grant" in export_text
    assert "required_permissions" in export_text
    assert result.cache_key.grants_digest in key_text
    assert result.cache_key.registry_content_digest in key_text


def test_project_provider_export_rejects_mismatched_supplied_cache_key() -> None:
    reg = registry()
    pol = policy()
    rec = recipient("TTS.Speak")
    proto = ProtocolEvidence()
    valid = build_cache_key(
        provider_peer_id="provider-a",
        registry=reg,
        policy=pol,
        recipient=rec,
        protocol=proto,
    )

    for kwargs in (
        {"provider_peer_id": "provider-b"},
        {"recipient": recipient("TTS.Speak", peer_id="recipient-b")},
        {"registry": registry(service(version="9.0.0"))},
    ):
        with pytest.raises(ProviderExportError, match="cache key"):
            project_provider_export(
                provider_peer_id=kwargs.get("provider_peer_id", "provider-a"),
                registry=kwargs.get("registry", reg),
                policy=pol,
                recipient=kwargs.get("recipient", rec),
                protocol=proto,
                cache_key=valid,
            )


def test_cache_lifecycle_peer_isolation_targeted_invalidation_and_clear_all() -> None:
    cache = PeerProviderExportCache()
    reg = registry()
    pol = policy()

    first = cache.project(
        provider_peer_id="provider-a",
        registry=reg,
        policy=pol,
        recipient=recipient("TTS.Speak", peer_id="a"),
    )
    second = cache.project(
        provider_peer_id="provider-a",
        registry=reg,
        policy=pol,
        recipient=recipient("TTS.Speak", peer_id="b"),
    )
    third = cache.project(
        provider_peer_id="provider-b",
        registry=reg,
        policy=pol,
        recipient=recipient("TTS.Speak", peer_id="a"),
    )
    first_again = cache.project(
        provider_peer_id="provider-a",
        registry=reg,
        policy=pol,
        recipient=recipient("TTS.Speak", peer_id="a"),
    )

    assert first is first_again
    assert {
        first.cache_key.provider_peer_id,
        second.cache_key.provider_peer_id,
        third.cache_key.provider_peer_id,
    } == {"provider-a", "provider-b"}
    assert cache.total_entry_count() == 3
    assert cache.invalidate_peer("a", provider_peer_id="provider-a") == 1
    assert cache.peer_entry_count("a", provider_peer_id="provider-a") == 0
    assert cache.peer_entry_count("a", provider_peer_id="provider-b") == 1
    assert cache.invalidate_all() == 2
    assert cache.total_entry_count() == 0
    assert cache.trusted_reset_authority_peer("a", provider_peer_id="provider-a") == 1
    rebuilt = cache.project(
        provider_peer_id="provider-a",
        registry=reg,
        policy=pol,
        recipient=recipient("TTS.Speak", peer_id="a", revision=0),
    )
    assert rebuilt.readiness == "ready"


def test_projection_invalidation_retains_authority_watermark_until_trusted_reset() -> None:
    cache = PeerProviderExportCache()
    reg = registry()
    pol = policy()

    cache.project(
        provider_peer_id="provider-a",
        registry=reg,
        policy=pol,
        recipient=recipient("TTS.Speak", revision=5),
    )
    assert cache.invalidate_peer("recipient-a", provider_peer_id="provider-a") == 1
    with pytest.raises(StaleAuthorityRevisionError):
        cache.project(
            provider_peer_id="provider-a",
            registry=reg,
            policy=pol,
            recipient=recipient("TTS.Speak", revision=4),
        )
    rev6 = cache.project(
        provider_peer_id="provider-a",
        registry=reg,
        policy=pol,
        recipient=recipient("TTS.Speak", revision=6),
    )
    assert rev6.cache_key.authority_revision == 6


def test_invalidate_all_retains_watermark_and_trusted_all_reset_allows_lower_revision() -> None:
    cache = PeerProviderExportCache()
    reg = registry()
    pol = policy()

    cache.project(
        provider_peer_id="provider-a",
        registry=reg,
        policy=pol,
        recipient=recipient("TTS.Speak", revision=5),
    )
    assert cache.invalidate_all() == 1
    with pytest.raises(StaleAuthorityRevisionError):
        cache.project(
            provider_peer_id="provider-a",
            registry=reg,
            policy=pol,
            recipient=recipient("TTS.Speak", revision=4),
        )
    assert cache.trusted_reset_all_authority() == 1
    lower = cache.project(
        provider_peer_id="provider-a",
        registry=reg,
        policy=pol,
        recipient=recipient("TTS.Speak", revision=4),
    )
    assert lower.cache_key.authority_revision == 4


def test_cache_monotonic_authority_revisions_and_same_revision_policy_changes() -> None:
    cache = PeerProviderExportCache()
    reg = registry()
    pol = policy()
    rec = recipient("TTS.Speak", revision=4)
    first = cache.project(provider_peer_id="provider-a", registry=reg, policy=pol, recipient=rec)
    same = cache.project(provider_peer_id="provider-a", registry=reg, policy=pol, recipient=rec)
    changed_policy_same_auth = cache.project(
        provider_peer_id="provider-a",
        registry=reg,
        policy=policy(revision="policy-2"),
        recipient=rec,
    )

    assert first is same
    assert (
        changed_policy_same_auth.cache_key.authority_revision == first.cache_key.authority_revision
    )
    assert changed_policy_same_auth.cache_key.digest != first.cache_key.digest
    with pytest.raises(ConflictingAuthorityRevisionError):
        cache.project(
            provider_peer_id="provider-a",
            registry=reg,
            policy=pol,
            recipient=recipient("Config.Read", revision=4),
        )
    with pytest.raises(StaleAuthorityRevisionError):
        cache.project(
            provider_peer_id="provider-a",
            registry=reg,
            policy=pol,
            recipient=recipient("TTS.Speak", revision=3),
        )
    higher = cache.project(
        provider_peer_id="provider-a",
        registry=reg,
        policy=pol,
        recipient=recipient("TTS.Speak", revision=5),
    )
    assert higher.cache_key.authority_revision == 5
    assert cache.peer_entry_count("recipient-a", provider_peer_id="provider-a") == 1


def test_pending_unknown_revoked_and_empty_active_states_are_non_routable() -> None:
    cases = [
        (recipient("TTS.Speak", state="pending"), "pending", "authority_pending"),
        (
            recipient(grants_unknown=True, state="pending"),
            "pending",
            "authority_pending",
        ),
        (recipient(grants_unknown=True, state="unknown"), "unknown", "authority_unknown"),
        (recipient("TTS.Speak", state="revoked"), "revoked", "authority_revoked"),
        (
            recipient(grants_unknown=True, state="revoked"),
            "revoked",
            "authority_revoked",
        ),
        (recipient(), "ready", "permissions_denied"),
    ]

    for rec, readiness, reason in cases:
        result = project(rec=rec)
        assert result.routable is (readiness == "ready")
        assert result.readiness == readiness
        assert reason_counts(result) == {reason: 1}


def test_protocol_contract_activates_projection_v1() -> None:
    protocol = ProtocolEvidence()

    assert protocol.active_protocol == ACTIVE_MANIFEST_PROTOCOL
    assert protocol.shadow_protocol == SUPPORTED_SHADOW_PROTOCOL
    assert protocol.projection_supported is True
    assert protocol.projection_active is True
    for kwargs in (
        {"active_protocol": "legacy-unfiltered-v0"},
        {"active_version": "v0"},
        {"active_tier": "shadow"},
        {"shadow_protocol": "other"},
        {"supported_protocols": (SUPPORTED_SHADOW_PROTOCOL,)},
        {"projection_supported": False},
        {"projection_active": False},
        {"evidence_state": "wire"},
        {"evidence_revision": -1},
    ):
        with pytest.raises(ProviderExportError):
            ProtocolEvidence(**kwargs)


def test_authority_bound_result_digest_changes_for_grant_revoke_restore() -> None:
    reg = registry()
    pol = policy()
    granted = project(reg=reg, pol=pol, rec=recipient("TTS.Speak", revision=1))
    revoked = project(reg=reg, pol=pol, rec=recipient(state="revoked", revision=2))
    restored = project(reg=reg, pol=pol, rec=recipient("TTS.Speak", revision=3))

    assert topics(granted) == ["TTS.Speak"]
    assert topics(revoked) == []
    assert topics(restored) == ["TTS.Speak"]
    assert len({granted.cache_key.digest, revoked.cache_key.digest, restored.cache_key.digest}) == 3
    assert len({granted.digest, revoked.digest, restored.digest}) == 3
    assert granted.canonical == restored.canonical
    assert granted.digest != restored.digest


def test_immutability_and_no_side_effects() -> None:
    reg = registry()
    pol = policy()
    rec = recipient("TTS.Speak")
    before = (canonical_bytes(reg), canonical_bytes(pol), canonical_bytes(rec))

    result = project(reg=reg, pol=pol, rec=rec)
    again = project(reg=reg, pol=pol, rec=rec)

    with pytest.raises(FrozenInstanceError):
        reg.services[0].methods[0].topic = "TTS.Other"  # type: ignore[misc]
    with pytest.raises(TypeError):
        reg.services[0].capacity["max_concurrent"] = 99  # type: ignore[index]
    assert (canonical_bytes(reg), canonical_bytes(pol), canonical_bytes(rec)) == before
    assert result == again


def test_effective_manifest_protocol_is_projection_v1_and_ready_is_routable() -> None:
    result = project()
    payload = json.loads(result.canonical.decode("utf-8"))

    assert result.effective_manifest_protocol == "projection-v1"
    assert result.shadow_protocol == "projection-v1"
    assert result.routable is True
    assert payload["effective_manifest_protocol"] == "projection-v1"
    assert payload["shadow_protocol"] == "projection-v1"
    assert payload["routable"] is True


def test_projection_manifest_wire_features_match_recipient_filtered_projection() -> None:
    reg = registry(
        service(
            methods=(
                method("TTS.StreamStart", features=("speech_streaming",)),
                method("TTS.StreamChunk", features=("speech_streaming",)),
            ),
            feature_members={"speech_streaming": ("TTS.StreamStart", "TTS.StreamChunk")},
        )
    )
    projection = project(
        reg=reg,
        pol=policy(
            ServiceExportPolicy(
                service_id="TTS",
                share=True,
                unshared_method_ids=("TTS.StreamChunk",),
            )
        ),
        rec=recipient("TTS.StreamStart", "TTS.StreamChunk"),
    )

    manifest = manifest_from_projection(
        projection=projection,
        node_name="provider",
        aurora_version="1.0.0",
        timestamp="2026-07-13T00:00:00Z",
    )

    projected_service = projection.services[0]
    wire_service = manifest.shared_services[0]
    assert [method.bus_topic for method in wire_service.methods] == [
        method.topic for method in projected_service.methods
    ]
    assert wire_service.available_feature_ids == list(projected_service.feature_ids)
    taxonomy_feature = next(
        feature
        for feature in feature_contracts_for_module("TTS")
        if feature.feature_id == "speech_streaming"
    )
    expected_feature = taxonomy_feature.model_copy(
        update={"method_ids": tuple(sorted(taxonomy_feature.method_ids))}
    )
    assert wire_service.available_feature_ids == []
    assert wire_service.callable_features == [expected_feature]
    assert wire_service.methods[0].callable_feature_ids == ["speech_streaming"]
    assert wire_service.methods[0].callable_features == [expected_feature]

    parsed = parse_manifest_with_evidence(
        manifest_to_dict(manifest),
        expected_provider_peer_id="provider-a",
        expected_recipient_peer_id="recipient-a",
    )
    assert parsed.status == "verified"
    assert parsed.manifest is not None
    parsed_topics = [
        method.bus_topic
        for service in parsed.manifest.shared_services
        for method in service.methods
    ]
    assert parsed_topics == [method.topic for method in projected_service.methods]
    assert "TTS.StreamChunk" not in parsed_topics

    full_projection = project(reg=reg, rec=recipient("TTS.StreamStart", "TTS.StreamChunk"))
    full_manifest = manifest_from_projection(
        projection=full_projection,
        node_name="provider",
        aurora_version="1.0.0",
        timestamp="2026-07-13T00:00:00Z",
    )
    assert full_manifest.shared_services[0].available_feature_ids == ["speech_streaming"]
    assert full_manifest.shared_services[0].callable_features == [expected_feature]

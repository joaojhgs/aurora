from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.negotiation import (
    generate_manifest,
    manifest_from_projection,
    manifest_to_dict,
    parse_manifest_with_evidence,
)
from app.services.gateway.mesh.provider_export import (
    GrantEvidence,
    NormalizedMethodSnapshot,
    NormalizedServiceSnapshot,
    PolicySnapshot,
    ProviderExportError,
    RecipientEvidence,
    RegistrySnapshot,
    ServiceExportPolicy,
    canonical_bytes,
    canonical_digest,
    project_provider_export,
)
from app.services.gateway.registry_aggregator import RegistryAggregator
from app.shared.contracts.models.gateway import ServiceAnnouncement
from app.shared.contracts.models.speech_runtime import (
    SpeechStageCapabilityExportV1,
    SpeechStageCapabilityV1,
)
from app.shared.contracts.models.tts import TTSMethods
from app.shared.contracts.registry import ModuleContract
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


def _capability_export(
    *,
    revision: int = 1,
    voice_ids: tuple[str, ...] = ("standard:test:voice-a",),
    peer_id: str = "provider-a",
    readiness: str = "ready",
    method_ids: tuple[str, ...] = (TTSMethods.SYNTHESIZE,),
    modes: tuple[str, ...] = ("finite",),
    required_permissions: tuple[str, ...] = (TTSMethods.SYNTHESIZE,),
) -> SpeechStageCapabilityExportV1:
    capability = SpeechStageCapabilityV1(
        stage="tts",
        method_ids=list(method_ids),
        modes=list(modes),
        implementation="python",
        peer_id=peer_id,
        capability_revision=revision,
        lifecycle=["foreground"],
        readiness=readiness,
        required_permissions=list(required_permissions),
        exported=readiness == "ready",
    )
    return SpeechStageCapabilityExportV1(capability=capability, voice_ids=voice_ids)


def _method(
    topic: str,
    required_permissions: tuple[str, ...] | None,
) -> NormalizedMethodSnapshot:
    return NormalizedMethodSnapshot(
        topic=topic,
        exposure="both",
        method_type="use",
        required_permissions=required_permissions,
    )


def _service_snapshot(
    *,
    speech_exports: tuple[SpeechStageCapabilityExportV1, ...]
    | list[SpeechStageCapabilityExportV1 | dict[str, object]] = (),
    methods: tuple[NormalizedMethodSnapshot, ...] | None = None,
) -> NormalizedServiceSnapshot:
    assert "speech_stage_capabilities" in NormalizedServiceSnapshot.__dataclass_fields__
    return NormalizedServiceSnapshot(
        service_id="TTS",
        version="1.0.0",
        methods=methods or (_method(TTSMethods.SYNTHESIZE, (TTSMethods.SYNTHESIZE,)),),
        speech_stage_capabilities=speech_exports,
    )


def _registry(snapshot: NormalizedServiceSnapshot) -> RegistrySnapshot:
    return RegistrySnapshot(revision="registry-1", services=(snapshot,))


def _speech_group_snapshot() -> NormalizedServiceSnapshot:
    return NormalizedServiceSnapshot(
        service_id="TTS",
        version="1.0.0",
        methods=(
            NormalizedMethodSnapshot(
                topic=TTSMethods.SYNTHESIZE,
                exposure="both",
                method_type="use",
                required_permissions=(TTSMethods.SYNTHESIZE,),
                feature_ids=("speech_synthesis",),
            ),
            NormalizedMethodSnapshot(
                topic=TTSMethods.STREAM_START,
                exposure="both",
                method_type="use",
                required_permissions=(TTSMethods.STREAM_START,),
                feature_ids=("speech_streaming",),
            ),
        ),
        feature_members={
            "speech_synthesis": (TTSMethods.SYNTHESIZE,),
            "speech_streaming": (TTSMethods.STREAM_START,),
        },
        speech_stage_capabilities=(
            _capability_export(
                method_ids=(TTSMethods.SYNTHESIZE, TTSMethods.STREAM_START),
                modes=("finite", "streaming"),
                required_permissions=(TTSMethods.SYNTHESIZE, TTSMethods.STREAM_START),
            ),
        ),
    )


def _two_wrapper_snapshot() -> NormalizedServiceSnapshot:
    return NormalizedServiceSnapshot(
        service_id="TTS",
        version="1.0.0",
        methods=(
            NormalizedMethodSnapshot(
                topic=TTSMethods.SYNTHESIZE,
                exposure="both",
                method_type="use",
                required_permissions=(TTSMethods.SYNTHESIZE,),
                feature_ids=("speech_synthesis",),
            ),
            NormalizedMethodSnapshot(
                topic=TTSMethods.STREAM_START,
                exposure="both",
                method_type="use",
                required_permissions=(TTSMethods.STREAM_START,),
                feature_ids=("speech_streaming",),
            ),
        ),
        feature_members={
            "speech_synthesis": (TTSMethods.SYNTHESIZE,),
            "speech_streaming": (TTSMethods.STREAM_START,),
        },
        speech_stage_capabilities=(
            _capability_export(),
            _capability_export(
                method_ids=(TTSMethods.STREAM_START,),
                modes=("streaming",),
                required_permissions=(TTSMethods.STREAM_START,),
            ),
        ),
    )


def _projection_manifest_wire(
    snapshot: NormalizedServiceSnapshot,
    *,
    grants: tuple[str, ...] = (TTSMethods.SYNTHESIZE,),
) -> dict[str, object]:
    return manifest_to_dict(
        manifest_from_projection(
            projection=_project(snapshot, grants=grants),
            node_name="Provider",
            aurora_version="1.0.0",
            timestamp="2026-10-07T00:00:00Z",
        )
    )


def _refresh_projection_wire_digests(payload: dict[str, object]) -> dict[str, object]:
    from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo
    from app.services.gateway.mesh.negotiation import (
        _compute_service_digest,
        finalize_recipient_projection_evidence,
        manifest_projection_digest,
    )

    service_payload = payload["shared_services"][0]
    service = PeerServiceInfo.model_validate(service_payload)
    service.digest = _compute_service_digest(service)
    payload["shared_services"][0] = service.model_dump(mode="json")

    manifest_payload = {key: value for key, value in payload.items() if key != "type"}
    manifest = PeerManifest.model_validate(manifest_payload)
    evidence = dict(payload["recipient_projection_evidence"])
    evidence["projection_digest"] = manifest_projection_digest(manifest)
    payload["recipient_projection_evidence"] = finalize_recipient_projection_evidence(
        evidence
    ).model_dump(mode="json")
    return payload


def _project(
    snapshot: NormalizedServiceSnapshot,
    *,
    grants: tuple[str, ...] = (TTSMethods.SYNTHESIZE,),
    policy: ServiceExportPolicy | None = None,
):
    return project_provider_export(
        provider_peer_id="provider-a",
        registry=_registry(snapshot),
        policy=PolicySnapshot(
            revision="policy-1",
            services=(policy or ServiceExportPolicy(service_id="TTS", share=True),),
        ),
        recipient=RecipientEvidence(
            peer_id="recipient-a",
            revision=1,
            grants=tuple(GrantEvidence(permission) for permission in grants),
        ),
    )


def _manifest_service(projection) -> dict[str, object]:
    manifest = manifest_from_projection(
        projection=projection,
        node_name="Provider",
        aurora_version="1.0.0",
        timestamp="2026-10-07T00:00:00Z",
    )
    return manifest_to_dict(manifest)["shared_services"][0]


def test_normalized_snapshot_detaches_and_canonicalizes_speech_projection_order() -> None:
    raw_export = _capability_export().model_dump(mode="json")
    exports = [
        raw_export,
        _capability_export(
            method_ids=(TTSMethods.STREAM_START,),
            modes=("streaming",),
            required_permissions=(TTSMethods.STREAM_START,),
        ),
    ]
    first = _service_snapshot(speech_exports=exports)
    reversed_snapshot = _service_snapshot(speech_exports=list(reversed(exports)))
    original_canonical = canonical_bytes(first)
    original_digest = canonical_digest(first)

    raw_export["voice_ids"].append("standard:test:mutated-after-publication")
    raw_export["capability"]["model_ids"].append("private-local-path")
    raw_export["capability"]["method_ids"].append(TTSMethods.STOP)
    source_method_ids = next(
        item.capability
        for item in first.speech_stage_capabilities
        if TTSMethods.SYNTHESIZE in item.capability.method_ids
    )
    source_method_ids.method_ids.append(TTSMethods.STOP)

    assert len(first.speech_stage_capabilities) == 2
    assert all(
        isinstance(item, SpeechStageCapabilityExportV1) for item in first.speech_stage_capabilities
    )
    assert first.speech_stage_capabilities == reversed_snapshot.speech_stage_capabilities
    assert canonical_bytes(reversed_snapshot) == original_canonical
    assert canonical_bytes(first) == original_canonical
    assert canonical_digest(first) == original_digest == canonical_digest(reversed_snapshot)


def test_invalid_raw_speech_wrapper_is_rejected_at_provider_export_boundary() -> None:
    invalid_export = _capability_export().model_dump(mode="json")
    invalid_export["voice_ids"] = ["/private/model/voice.bin"]

    with pytest.raises(ProviderExportError):
        _service_snapshot(speech_exports=[invalid_export])


def test_capability_revision_and_voice_changes_change_registry_and_recipient_digests() -> None:
    base = _service_snapshot(speech_exports=(_capability_export(),))
    revised = _service_snapshot(speech_exports=(_capability_export(revision=2),))
    changed_voice = _service_snapshot(
        speech_exports=(_capability_export(voice_ids=("standard:test:voice-b",)),)
    )

    base_registry = _registry(base)
    revision_registry = _registry(revised)
    voice_registry = _registry(changed_voice)
    base_projection = _project(base)
    revision_projection = _project(revised)
    voice_projection = _project(changed_voice)

    assert len({base_registry.digest, revision_registry.digest, voice_registry.digest}) == 3
    assert len({base_projection.digest, revision_projection.digest, voice_projection.digest}) == 3


def test_ready_matching_capability_appears_in_manifest_with_exact_wrapper_fields() -> None:
    projection = _project(_service_snapshot(speech_exports=(_capability_export(),)))

    wire_service = _manifest_service(projection)
    exported = wire_service["speech_stage_capabilities"]

    assert len(exported) == 1
    assert set(exported[0]) == {"capability", "voice_ids", "requires_remote_audio_egress"}
    assert exported[0]["requires_remote_audio_egress"] is False
    assert exported[0]["capability"]["peer_id"] == "provider-a"
    assert exported[0]["capability"]["required_permissions"] == [TTSMethods.SYNTHESIZE]
    assert exported[0]["capability"]["resource_id"] == "remote:provider-a:TTS"


def test_verified_manifest_round_trips_the_projected_speech_wrapper() -> None:
    wire = _projection_manifest_wire(
        _speech_group_snapshot(),
        grants=(TTSMethods.SYNTHESIZE, TTSMethods.STREAM_START),
    )

    parsed = parse_manifest_with_evidence(
        wire,
        expected_provider_peer_id="provider-a",
        expected_recipient_peer_id="recipient-a",
    )

    assert parsed.status == "verified"
    assert parsed.usable is True
    assert parsed.manifest is not None
    wrapper = parsed.manifest.shared_services[0].speech_stage_capabilities[0]
    assert wrapper.capability.peer_id == "provider-a"
    assert wrapper.capability.resource_id == "remote:provider-a:TTS"
    assert wrapper.capability.required_permissions == sorted(
        [
            TTSMethods.SYNTHESIZE,
            TTSMethods.STREAM_START,
        ]
    )


@pytest.mark.parametrize(
    "permission_variants",
    (
        (None, None),
        ((), (TTSMethods.SYNTHESIZE,)),
    ),
    ids=("identical-wrappers", "normalized-permissions"),
)
def test_projection_deduplicates_wrappers_that_normalize_identically(
    permission_variants: tuple[tuple[str, ...] | None, tuple[str, ...] | None],
) -> None:
    source = _capability_export().model_dump(mode="json")
    raw_wrappers: list[dict[str, object]] = []
    for permissions in permission_variants:
        wrapper = {
            **source,
            "capability": dict(source["capability"]),
        }
        if permissions is not None:
            wrapper["capability"]["required_permissions"] = list(permissions)
        raw_wrappers.append(wrapper)

    projection = _project(_service_snapshot(speech_exports=raw_wrappers))
    assert len(projection.services) == 1
    assert len(projection.services[0].speech_stage_capabilities) == 1

    wire = _projection_manifest_wire(
        _service_snapshot(speech_exports=raw_wrappers),
    )
    exported = wire["shared_services"][0]["speech_stage_capabilities"]
    assert len(exported) == 1
    assert exported[0]["capability"]["required_permissions"] == [TTSMethods.SYNTHESIZE]

    parsed = parse_manifest_with_evidence(
        wire,
        expected_provider_peer_id="provider-a",
        expected_recipient_peer_id="recipient-a",
    )
    assert parsed.status == "verified"
    assert parsed.usable is True


@pytest.mark.parametrize(
    "tamper_case",
    ("provider_id", "resource_id", "missing_method", "permission_union", "outer_order"),
)
def test_projection_parser_rejects_semantic_speech_wrapper_tampering(
    tamper_case: str,
) -> None:
    snapshot = _two_wrapper_snapshot() if tamper_case == "outer_order" else _speech_group_snapshot()
    grants = (TTSMethods.SYNTHESIZE, TTSMethods.STREAM_START)
    payload = _projection_manifest_wire(snapshot, grants=grants)
    wrappers = payload["shared_services"][0]["speech_stage_capabilities"]

    if tamper_case == "provider_id":
        wrappers[0]["capability"]["peer_id"] = "other-provider"
    elif tamper_case == "resource_id":
        wrappers[0]["capability"]["resource_id"] = "remote:other-provider:TTS"
    elif tamper_case == "missing_method":
        wrappers[0]["capability"]["method_ids"] = ["TTS.NotDeclared"]
        wrappers[0]["capability"]["required_permissions"] = ["TTS.NotDeclared"]
    elif tamper_case == "permission_union":
        wrappers[0]["capability"]["required_permissions"] = [TTSMethods.SYNTHESIZE]
    else:
        wrappers.reverse()

    wire = _refresh_projection_wire_digests(payload)
    parsed = parse_manifest_with_evidence(
        wire,
        expected_provider_peer_id="provider-a",
        expected_recipient_peer_id="recipient-a",
    )

    assert parsed.status == "invalid"
    assert parsed.usable is False
    assert parsed.reason_code not in {
        "service_digest_mismatch",
        "projection_digest_mismatch",
        "evidence_digest_mismatch",
    }


def test_legacy_manifest_omits_stage_metadata_without_recipient_projection() -> None:
    snapshot = _speech_group_snapshot()
    active_projection = _project(snapshot, grants=(TTSMethods.SYNTHESIZE,))
    assert [method.topic for method in active_projection.services[0].methods] == [
        TTSMethods.SYNTHESIZE
    ]
    assert active_projection.services[0].speech_stage_capabilities == ()

    registry = SimpleNamespace(snapshot_registry=lambda: _registry(snapshot))
    mesh_config = MeshConfig(
        enabled=True,
        node_name="Provider",
        services={"TTS": mesh_policy(share=True)},
    )
    manifest = generate_manifest("provider-a", mesh_config, registry=registry)
    wire = manifest_to_dict(manifest)

    assert manifest.recipient_projection_evidence is None
    assert [method.bus_topic for method in manifest.shared_services[0].methods] == sorted(
        [
            TTSMethods.STREAM_START,
            TTSMethods.SYNTHESIZE,
        ]
    )
    assert "speech_stage_capabilities" not in wire["shared_services"][0]


def test_absent_unready_and_wrong_provider_exports_keep_legacy_wire_shape() -> None:
    cases = (
        _service_snapshot(),
        _service_snapshot(speech_exports=(_capability_export(readiness="loading"),)),
        _service_snapshot(speech_exports=(_capability_export(peer_id="other-provider"),)),
    )

    wire_services = [_manifest_service(_project(snapshot)) for snapshot in cases]

    assert wire_services[0] == wire_services[1] == wire_services[2]
    assert "speech_stage_capabilities" not in wire_services[0]
    assert set(wire_services[0]) == {
        "module",
        "version",
        "capabilities",
        "callable_features",
        "available_feature_ids",
        "methods",
        "max_concurrent",
        "digest",
    }
    assert "speech_stage_capabilities" not in _service_snapshot().to_canonical()


def test_recipient_denial_and_unshared_methods_do_not_export_speech_capabilities() -> None:
    snapshot = _service_snapshot(speech_exports=(_capability_export(),))
    denied = _project(snapshot, grants=())
    unshared = _project(
        snapshot,
        policy=ServiceExportPolicy(
            service_id="TTS",
            share=True,
            unshared_method_ids=(TTSMethods.SYNTHESIZE,),
        ),
    )
    service_disabled = _project(
        snapshot,
        policy=ServiceExportPolicy(service_id="TTS", share=False),
    )

    assert denied.services == ()
    assert unshared.services == ()
    assert service_disabled.services == ()


def test_partial_method_group_and_permission_mismatch_omit_capability() -> None:
    partial_group = _service_snapshot(
        speech_exports=(
            _capability_export(
                method_ids=(TTSMethods.SYNTHESIZE, TTSMethods.STREAM_START),
                modes=("finite", "streaming"),
                required_permissions=(TTSMethods.SYNTHESIZE, TTSMethods.STREAM_START),
            ),
        ),
        methods=(
            _method(TTSMethods.SYNTHESIZE, (TTSMethods.SYNTHESIZE,)),
            _method(TTSMethods.STREAM_START, (TTSMethods.STREAM_START,)),
        ),
    )
    overdeclared_permissions = _service_snapshot(
        speech_exports=(
            _capability_export(
                required_permissions=(TTSMethods.SYNTHESIZE, TTSMethods.STOP),
            ),
        )
    )
    unknown_permissions = _service_snapshot(
        speech_exports=(_capability_export(),),
        methods=(_method(TTSMethods.SYNTHESIZE, None),),
    )
    empty_permissions = _service_snapshot(
        speech_exports=(_capability_export(),),
        methods=(_method(TTSMethods.SYNTHESIZE, ()),),
    )

    partial_projection = _project(partial_group)
    overdeclared_projection = _project(overdeclared_permissions)
    unknown_projection = _project(unknown_permissions)
    empty_projection = _project(empty_permissions)

    assert [method.topic for method in partial_projection.services[0].methods] == [
        TTSMethods.SYNTHESIZE
    ]
    assert partial_projection.services[0].speech_stage_capabilities == ()
    assert overdeclared_projection.services[0].speech_stage_capabilities == ()
    assert unknown_projection.services == ()
    assert empty_projection.services == ()


@pytest.mark.asyncio
async def test_registry_announcement_projection_is_normalized_across_modes_and_updates_digest(
    monkeypatch,
) -> None:
    import app.shared.contracts.registry as contract_registry

    module = ModuleContract(
        module="SpeechProjectionFixture",
        version="1.0.0",
        summary="Speech projection fixture",
        methods=[],
    )
    monkeypatch.setattr(contract_registry, "list_modules", lambda: {module.module: module})
    thread_registry = RegistryAggregator(bus=object(), mode="threads")
    process_registry = RegistryAggregator(bus=object(), mode="processes")
    await thread_registry._load_from_local_registry()

    async def announce(
        registry: RegistryAggregator,
        *,
        revision: int | None = None,
        voice_ids: tuple[str, ...] = ("standard:test:voice-a",),
    ) -> None:
        stage_exports = (
            (_capability_export(revision=revision, voice_ids=voice_ids),)
            if revision is not None
            else ()
        )
        announcement = ServiceAnnouncement(
            module=module.module,
            version=module.version,
            summary=module.summary,
            speech_stage_capabilities=list(stage_exports),
        )
        await registry._on_service_announce(
            SimpleNamespace(payload=announcement.model_dump(mode="json"))
        )

    async def announce_both(**kwargs: object) -> None:
        await announce(thread_registry, **kwargs)
        await announce(process_registry, **kwargs)

    thread_before = thread_registry.snapshot_registry()
    process_before = process_registry.snapshot_registry()
    await announce_both(revision=2)
    await thread_registry._load_from_local_registry()

    thread_snapshot = thread_registry.snapshot_registry()
    process_snapshot = process_registry.snapshot_registry()
    assert "speech_stage_capabilities" in NormalizedServiceSnapshot.__dataclass_fields__
    thread_service = thread_snapshot.services[0]
    process_service = process_snapshot.services[0]
    assert thread_service.speech_stage_capabilities[0].capability.capability_revision == 2
    assert thread_service.speech_stage_capabilities[0].voice_ids == ("standard:test:voice-a",)
    assert thread_service.speech_stage_capabilities == process_service.speech_stage_capabilities
    assert canonical_digest(thread_snapshot.services) == canonical_digest(process_snapshot.services)
    assert int(thread_snapshot.revision) > int(thread_before.revision)
    assert int(process_snapshot.revision) > int(process_before.revision)

    async def assert_change_is_stable_after_duplicate(**kwargs: object) -> None:
        prior = {
            "threads": thread_registry.snapshot_registry(),
            "processes": process_registry.snapshot_registry(),
        }
        await announce_both(**kwargs)
        changed = {
            "threads": thread_registry.snapshot_registry(),
            "processes": process_registry.snapshot_registry(),
        }
        for mode, snapshot in changed.items():
            assert int(snapshot.revision) == int(prior[mode].revision) + 1
            assert snapshot.digest != prior[mode].digest

        await announce_both(**kwargs)
        for mode, snapshot in (
            ("threads", thread_registry.snapshot_registry()),
            ("processes", process_registry.snapshot_registry()),
        ):
            assert snapshot.revision == changed[mode].revision
            assert snapshot.digest == changed[mode].digest

    await assert_change_is_stable_after_duplicate(revision=3)
    await assert_change_is_stable_after_duplicate(
        revision=3,
        voice_ids=("standard:test:voice-b",),
    )

    before_clear = {
        "threads": thread_registry.snapshot_registry(),
        "processes": process_registry.snapshot_registry(),
    }
    await announce_both()
    for mode, registry in (
        ("threads", thread_registry),
        ("processes", process_registry),
    ):
        cleared = registry.snapshot_registry()
        assert cleared.services[0].speech_stage_capabilities == ()
        assert int(cleared.revision) == int(before_clear[mode].revision) + 1
        assert cleared.digest != before_clear[mode].digest

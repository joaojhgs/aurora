"""Canonical callable feature taxonomy for the mesh service surface."""

from __future__ import annotations

import re
from typing import Any

from app.shared.contracts.registry import CallableFeatureContract

MESH_CAPABLE_MODULES: tuple[str, ...] = (
    "STTCoordinator",
    "WakeWord",
    "Transcription",
    "DB",
    "TTS",
    "Tooling",
    "Scheduler",
    "Orchestrator",
)

PUBLIC_INFRASTRUCTURE_TOPICS: tuple[str, ...] = (
    "Auth.Login",
    "Auth.PairingStart",
    "Auth.PairingConnect",
    "Auth.PairingExchange",
)

CALLABLE_FEATURES: tuple[CallableFeatureContract, ...] = (
    CallableFeatureContract(
        feature_id="listening_session_control",
        module="STTCoordinator",
        label="Listening Session Control",
        summary="Control listening sessions and exclusive native microphone ownership.",
        method_ids=(
            "STTCoordinator.Listen",
            "STTCoordinator.StopListening",
            "STTCoordinator.CapturePrepare",
            "STTCoordinator.CaptureRelease",
            "STTCoordinator.CaptureStatus",
        ),
    ),
    CallableFeatureContract(
        feature_id="wake_word_detection",
        module="WakeWord",
        label="Wake Word Detection",
        summary="Detect wake words in submitted or streamed audio.",
        method_ids=("WakeWord.ProcessAudio", "WakeWord.Detect"),
    ),
    CallableFeatureContract(
        feature_id="audio_transcription",
        module="Transcription",
        label="Audio Transcription",
        summary="Transcribe submitted or streamed audio.",
        method_ids=("Transcription.ProcessAudio", "Transcription.Transcribe"),
    ),
    CallableFeatureContract(
        feature_id="session_management",
        module="DB",
        label="Session Management",
        summary="Create, list, load, and activate local chat sessions.",
        method_ids=("DB.CreateSession", "DB.ListSessions", "DB.GetSession", "DB.SetActiveSession"),
    ),
    CallableFeatureContract(
        feature_id="message_history_read",
        module="DB",
        label="Message History Read",
        summary="Read local chat message history.",
        method_ids=("DB.GetMessages", "DB.GetMessagesForDate"),
    ),
    CallableFeatureContract(
        feature_id="rag_discovery",
        module="DB",
        label="RAG Discovery",
        summary="Discover and search policy-aware RAG data.",
        method_ids=("DB.RAGListNamespaces", "DB.RAGSearchRemote", "DB.RAGGetProvenance"),
    ),
    CallableFeatureContract(
        feature_id="rag_transfer",
        module="DB",
        label="RAG Transfer",
        summary="Export and import bounded RAG namespace snapshots.",
        method_ids=("DB.RAGExportNamespace", "DB.RAGImportNamespace"),
    ),
    CallableFeatureContract(
        feature_id="speech_playback",
        module="TTS",
        label="Speech Playback",
        summary="Play synthesized speech on the provider.",
        method_ids=("TTS.Request",),
    ),
    CallableFeatureContract(
        feature_id="speech_streaming",
        module="TTS",
        label="Speech Streaming",
        summary="Start, stream, and end ordered text-to-speech audio streams.",
        method_ids=("TTS.StreamStart", "TTS.StreamChunk", "TTS.StreamEnd"),
    ),
    CallableFeatureContract(
        feature_id="speech_synthesis",
        module="TTS",
        label="Speech Synthesis",
        summary="Return synthesized audio data without provider playback.",
        method_ids=("TTS.Synthesize",),
    ),
    CallableFeatureContract(
        feature_id="speech_voice_discovery",
        module="TTS",
        label="Voice Discovery",
        summary="Read TTS capabilities and use-safe voice choices.",
        method_ids=("TTS.GetCapabilities", "TTS.ListVoices"),
    ),
    CallableFeatureContract(
        feature_id="speech_voice_management",
        module="TTS",
        label="Voice Profile Management",
        summary="Administer local TTS voice profiles and bounded voice imports.",
        method_ids=(
            "TTS.ListVoiceProfiles",
            "TTS.GetVoiceProfile",
            "TTS.UpdateVoiceProfile",
            "TTS.InstallVoiceProfile",
            "TTS.RemoveVoiceProfile",
            "TTS.SetDefaultVoice",
            "TTS.VoiceImportStart",
            "TTS.VoiceImportChunk",
            "TTS.VoiceImportEnd",
            "TTS.VoiceImportAbort",
            "TTS.CreateVoiceProfile",
            "TTS.DeleteVoiceProfile",
        ),
    ),
    CallableFeatureContract(
        feature_id="catalog_discovery",
        module="Tooling",
        label="Catalog Discovery",
        summary="Read local and aggregate Tooling catalogs and status.",
        method_ids=(
            "Tooling.GetTools",
            "Tooling.GetToolCatalog",
            "Tooling.GetExportCatalog",
            "Tooling.GetToolByName",
            "Tooling.GetStats",
            "Tooling.GetMCPStatus",
        ),
    ),
    CallableFeatureContract(
        feature_id="legacy_sharing_policy",
        module="Tooling",
        label="Legacy Sharing Policy",
        summary="Read, write, and test legacy Tooling sharing policy.",
        method_ids=(
            "Tooling.GetSharingPolicy",
            "Tooling.SetSharingPolicy",
            "Tooling.TestSharingPolicy",
        ),
    ),
    CallableFeatureContract(
        feature_id="export_policy_administration",
        module="Tooling",
        label="Export Policy Administration",
        summary="Read, preview, and administer recipient-specific Tooling export policy.",
        method_ids=(
            "Tooling.GetToolExportPolicy",
            "Tooling.SetToolExportDefault",
            "Tooling.UpsertToolGroupExportPolicy",
            "Tooling.UpsertToolExportOverride",
            "Tooling.ClearToolExportOverride",
            "Tooling.PreviewToolExportDecision",
        ),
    ),
    CallableFeatureContract(
        feature_id="execution",
        module="Tooling",
        label="Execution",
        summary="Prepare, approve, evaluate, and execute Tooling calls.",
        method_ids=(
            "Tooling.PrepareExecution",
            "Tooling.RequestApproval",
            "Tooling.EvaluateApprovalGrant",
            "Tooling.ExecuteTool",
        ),
    ),
    CallableFeatureContract(
        feature_id="approval_administration",
        module="Tooling",
        label="Approval Administration",
        summary="Administer Tooling execution approvals and durable grants.",
        method_ids=(
            "Tooling.ConfirmExecution",
            "Tooling.ListApprovalGrants",
            "Tooling.CreateApprovalGrant",
            "Tooling.RevokeApprovalGrant",
        ),
    ),
    CallableFeatureContract(
        feature_id="policy_administration",
        module="Tooling",
        label="Policy Administration",
        summary="Administer Tooling policy, audit, source, and override records.",
        method_ids=(
            "Tooling.GetPolicySummary",
            "Tooling.ListToolSources",
            "Tooling.ListPendingApprovals",
            "Tooling.GetToolSourceDetail",
            "Tooling.AcceptRemoteToolSchema",
            "Tooling.SetPolicyMode",
            "Tooling.UpsertSourcePolicy",
            "Tooling.ClearSourcePolicy",
            "Tooling.UpsertToolPolicyOverride",
            "Tooling.ClearToolPolicyOverride",
            "Tooling.ListPolicyAuditEvents",
        ),
    ),
    CallableFeatureContract(
        feature_id="source_onboarding",
        module="Tooling",
        label="Source Onboarding",
        summary="Validate, create, and inspect Tooling source onboarding.",
        method_ids=(
            "Tooling.TestMCPSource",
            "Tooling.TestPluginSource",
            "Tooling.CreateMCPSource",
            "Tooling.CreatePluginSource",
            "Tooling.GetOnboardingStatus",
        ),
    ),
    CallableFeatureContract(
        feature_id="job_scheduling",
        module="Scheduler",
        label="Job Scheduling",
        summary="Schedule legacy and typed jobs.",
        method_ids=("Scheduler.ScheduleAction", "Scheduler.Schedule"),
    ),
    CallableFeatureContract(
        feature_id="job_lifecycle",
        module="Scheduler",
        label="Job Lifecycle",
        summary="Cancel, pause, and resume scheduled jobs.",
        method_ids=("Scheduler.Cancel", "Scheduler.Pause", "Scheduler.Resume"),
    ),
    CallableFeatureContract(
        feature_id="job_discovery",
        module="Scheduler",
        label="Job Discovery",
        summary="List scheduled jobs.",
        method_ids=("Scheduler.ListJobs",),
    ),
    CallableFeatureContract(
        feature_id="assistant_conversation",
        module="Orchestrator",
        label="Assistant Conversation",
        summary="Submit assistant user input and attachment context.",
        method_ids=("Orchestrator.ExternalUserInput", "Orchestrator.IngestContext"),
    ),
    CallableFeatureContract(
        feature_id="inference",
        module="Orchestrator",
        label="Inference",
        summary="Run non-tool chat inference locally or as a stream.",
        method_ids=("Orchestrator.InferChat", "Orchestrator.StreamInferChat"),
    ),
    CallableFeatureContract(
        feature_id="tool_approval",
        module="Orchestrator",
        label="Tool Approval",
        summary="List and resume assistant tool approval pauses.",
        method_ids=(
            "Orchestrator.ListPendingToolApprovals",
            "Orchestrator.ResumeToolApproval",
        ),
    ),
    CallableFeatureContract(
        feature_id="assistant_control",
        module="Orchestrator",
        label="Assistant Control",
        summary="Interrupt active assistant work.",
        method_ids=("Orchestrator.Interrupt",),
    ),
    CallableFeatureContract(
        feature_id="model_observability",
        module="Orchestrator",
        label="Model Observability",
        summary="Read model runtime, catalog, and operation status.",
        method_ids=(
            "Orchestrator.GetModelRuntime",
            "Orchestrator.GetModelCatalog",
            "Orchestrator.GetModelOperation",
        ),
    ),
    CallableFeatureContract(
        feature_id="model_management",
        module="Orchestrator",
        label="Model Management",
        summary="Request model import, download, and benchmark operations.",
        method_ids=(
            "Orchestrator.ImportModel",
            "Orchestrator.DownloadModel",
            "Orchestrator.BenchmarkModel",
        ),
    ),
)

_FEATURES_BY_MODULE: dict[str, tuple[CallableFeatureContract, ...]] = {
    module: tuple(feature for feature in CALLABLE_FEATURES if feature.module == module)
    for module in MESH_CAPABLE_MODULES
}

_FEATURES_BY_TOPIC: dict[str, tuple[CallableFeatureContract, ...]] = {
    topic: tuple(feature for feature in CALLABLE_FEATURES if topic in feature.method_ids)
    for feature in CALLABLE_FEATURES
    for topic in feature.method_ids
}

_FEATURE_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_EXPECTED_MODULE_COUNT = 8
_EXPECTED_FEATURE_GROUP_COUNT = 28
_EXPECTED_CALLABLE_METHOD_COUNT = 97


def feature_contracts_for_module(module: str) -> tuple[CallableFeatureContract, ...]:
    """Return canonical feature contracts for one mesh-capable module."""

    return _FEATURES_BY_MODULE.get(module, ())


def feature_contracts_for_topic(topic: str) -> tuple[CallableFeatureContract, ...]:
    """Return canonical feature contracts that include an exact bus topic."""

    return _FEATURES_BY_TOPIC.get(topic, ())


def feature_ids_for_topic(topic: str) -> tuple[str, ...]:
    """Return stable callable feature IDs for an exact bus topic."""

    return tuple(feature.feature_id for feature in feature_contracts_for_topic(topic))


def duplicate_feature_keys(
    features: tuple[CallableFeatureContract, ...] = CALLABLE_FEATURES,
) -> list[tuple[str, str]]:
    """Return duplicate module-scoped feature keys without enforcing taxonomy counts."""

    well_formed = [feature for feature in features if isinstance(feature, CallableFeatureContract)]
    keys = [(feature.module, feature.feature_id) for feature in well_formed]
    seen: set[tuple[str, str]] = set()
    duplicates: list[tuple[str, str]] = []
    for key in keys:
        if key in seen and key not in duplicates:
            duplicates.append(key)
        seen.add(key)
    return duplicates


def all_callable_method_topics() -> tuple[str, ...]:
    """Return every ordinary mesh-callable bus topic in the taxonomy."""

    return tuple(sorted(_FEATURES_BY_TOPIC))


def validate_taxonomy() -> list[str]:
    """Validate taxonomy invariants without reading service code."""

    violations: list[str] = []
    if len(MESH_CAPABLE_MODULES) != _EXPECTED_MODULE_COUNT:
        violations.append(
            "taxonomy module count mismatch: "
            f"expected={_EXPECTED_MODULE_COUNT} actual={len(MESH_CAPABLE_MODULES)}"
        )
    if len(CALLABLE_FEATURES) != _EXPECTED_FEATURE_GROUP_COUNT:
        violations.append(
            "taxonomy feature group count mismatch: "
            f"expected={_EXPECTED_FEATURE_GROUP_COUNT} actual={len(CALLABLE_FEATURES)}"
        )
    well_formed_features = [
        feature for feature in CALLABLE_FEATURES if isinstance(feature, CallableFeatureContract)
    ]
    for feature in CALLABLE_FEATURES:
        if not isinstance(feature, CallableFeatureContract):
            violations.append(f"malformed callable feature entry: {feature!r}")
    duplicated_keys = duplicate_feature_keys(tuple(well_formed_features))
    if duplicated_keys:
        violations.append(f"duplicate module-scoped feature_id: {duplicated_keys}")
    topics = [topic for feature in well_formed_features for topic in feature.method_ids]
    if len(topics) != len(set(topics)):
        violations.append("duplicate method topic")
    if len(topics) != _EXPECTED_CALLABLE_METHOD_COUNT:
        violations.append(
            "taxonomy callable method count mismatch: "
            f"expected={_EXPECTED_CALLABLE_METHOD_COUNT} actual={len(topics)}"
        )
    modules = {feature.module for feature in well_formed_features}
    if modules != set(MESH_CAPABLE_MODULES):
        violations.append(
            "taxonomy modules mismatch: "
            f"expected={sorted(MESH_CAPABLE_MODULES)} actual={sorted(modules)}"
        )
    for feature in well_formed_features:
        if not feature.feature_id.strip():
            violations.append(f"{feature.module} has an empty feature_id")
        elif not _FEATURE_ID_RE.fullmatch(feature.feature_id):
            violations.append(f"{feature.module}.{feature.feature_id} has an invalid feature_id")
        if not feature.label.strip():
            violations.append(f"{feature.module}.{feature.feature_id} missing label")
        if not feature.summary.strip():
            violations.append(f"{feature.module}.{feature.feature_id} missing summary")
        if not feature.method_ids:
            violations.append(f"{feature.module}.{feature.feature_id} has no methods")
        for topic in feature.method_ids:
            if not topic.strip() or "." not in topic:
                violations.append(
                    f"{feature.module}.{feature.feature_id} has invalid topic {topic!r}"
                )
                continue
            if not topic.startswith(f"{feature.module}."):
                violations.append(f"{topic} does not belong to module {feature.module}")
    return violations


def validate_callable_method_surface(method: Any, module: str | None = None) -> list[str]:
    """Validate one registry or wire method against the canonical mesh taxonomy."""

    module_name = module or str(getattr(method, "module", "") or "")
    name = str(getattr(method, "name", "") or "")
    topic = str(getattr(method, "bus_topic", "") or "")
    if not topic and module_name and name:
        topic = f"{module_name}.{name}"
    if not module_name and "." in topic:
        module_name = topic.split(".", 1)[0]

    exposure = str(getattr(method, "exposure", "internal") or "internal")
    required_perms = list(getattr(method, "required_perms", None) or [])
    feature_ids = list(getattr(method, "callable_feature_ids", None) or [])
    wire_features = list(getattr(method, "callable_features", None) or [])
    public_infrastructure = bool(getattr(method, "public_infrastructure", False))

    violations: list[str] = []
    if public_infrastructure:
        if topic not in PUBLIC_INFRASTRUCTURE_TOPICS:
            violations.append(f"{topic} is not an allowed public infrastructure method")
        if module_name != "Auth":
            violations.append(f"{topic} public infrastructure must be in Auth")
        if not topic.startswith("Auth."):
            violations.append(f"{topic} public infrastructure topic must use Auth prefix")
        if module_name and not topic.startswith(f"{module_name}."):
            violations.append(
                f"{topic} public infrastructure module/topic mismatch: module={module_name}"
            )
        if exposure not in {"external", "both"}:
            violations.append(f"{topic} public infrastructure must be externally exposed")
        if required_perms:
            violations.append(f"{topic} public infrastructure must not require permissions")
        if feature_ids or wire_features:
            violations.append(f"{topic} public infrastructure must not declare callable features")
        return violations

    if (
        topic in PUBLIC_INFRASTRUCTURE_TOPICS
        and exposure in {"external", "both"}
        and not required_perms
    ):
        violations.append(f"{topic} missing public_infrastructure marker")
        return violations

    if module_name not in MESH_CAPABLE_MODULES:
        return violations

    canonical_features = feature_contracts_for_topic(topic)
    canonical_ids = [feature.feature_id for feature in canonical_features]

    if exposure == "internal" and (feature_ids or wire_features):
        violations.append(f"{topic} internal methods must not declare callable features")

    if feature_ids:
        unknown = sorted(set(feature_ids) - set(canonical_ids))
        if unknown:
            violations.append(f"{topic} declares invalid callable feature IDs: {unknown}")
        if canonical_features and feature_ids != canonical_ids:
            violations.append(
                f"{topic} callable feature IDs mismatch: "
                f"expected={canonical_ids} actual={feature_ids}"
            )
        for feature in canonical_features:
            if feature.module != module_name:
                violations.append(f"{topic} feature belongs to {feature.module}, not {module_name}")
    elif exposure in {"external", "both"}:
        violations.append(f"{topic} missing callable feature membership")

    if exposure in {"external", "both"} and canonical_features:
        canonical_objects = [feature.model_dump(mode="json") for feature in canonical_features]
        wire_objects = [
            feature.model_dump(mode="json") if hasattr(feature, "model_dump") else feature
            for feature in wire_features
        ]
        if wire_objects != canonical_objects:
            violations.append(
                f"{topic} callable feature objects mismatch: "
                f"expected={canonical_objects} actual={wire_objects}"
            )

    if exposure in {"external", "both"} and not required_perms:
        violations.append(f"{topic} missing required_perms")

    if exposure in {"external", "both"} and not canonical_features:
        violations.append(f"{topic} is not in the canonical callable mesh taxonomy")

    return violations


def callable_method_advertisable(method: Any, module: str | None = None) -> bool:
    """Return whether a method may be externally advertised."""

    return not validate_callable_method_surface(method, module=module)

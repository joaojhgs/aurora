#!/usr/bin/env python3
"""One bounded K3 condition: remote Gateway STT, Assistant and TTS.

Source-only campaign runner. Root owns configuration, launch, resource caps and
all execution; this file is not a benchmark result or product telemetry hook.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sys
import time
import uuid
import wave
from pathlib import Path
from typing import Any

os.umask(0o077)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from stage_adapter import AdmittedEndpoint
from k3_composition import K3CaseError, run_k3_case

WARMUP_COUNT = 15
MEASURED_COUNT = 387
PRIOR_MEASURED_COUNT = 513
CONDITION_TARGET = 900
REQUEST_CAP_SECONDS = 180.0
CONDITION_CAP_SECONDS = 57_600.0
PRIVATE_ROOT = Path(__file__).resolve().parents[1]


class CampaignFailure(RuntimeError):
    def __init__(self, stage: str, code: str, *, stop: bool = False):
        super().__init__(code)
        self.stage = stage
        self.code = code
        self.stop_campaign = stop


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _normal_words(value: str) -> str:
    return " ".join(re.findall(r"[^\W_]+", value.casefold(), flags=re.UNICODE))


def _write_once(path: Path, data: bytes, mode: int = 0o600) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def _atomic_progress(path: Path, row: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    _write_once(temporary, (json.dumps(row, sort_keys=True) + "\n").encode())
    os.replace(temporary, path)


def _load_frozen_manifest() -> tuple[dict[str, Any], str, Path]:
    raw = os.environ.get("AURORA_CANDIDATE_MANIFEST")
    expected_file_hash = os.environ.get("AURORA_CANDIDATE_MANIFEST_SHA256", "")
    if not raw or not re.fullmatch(r"[0-9a-f]{64}", expected_file_hash):
        raise CampaignFailure("preflight", "missing_frozen_manifest_reference", stop=True)
    path = Path(raw).resolve(strict=True)
    data = path.read_bytes()
    actual_file_hash = _sha256(data)
    if actual_file_hash != expected_file_hash:
        raise CampaignFailure("preflight", "frozen_manifest_hash_mismatch", stop=True)
    try:
        value = json.loads(data)
    except Exception:
        raise CampaignFailure("preflight", "manifest_json_invalid", stop=True) from None
    if not isinstance(value, dict) or set(value) != {
        "wavSHA256", "referenceTranscript", "expectedReplyWords"
    }:
        raise CampaignFailure("preflight", "manifest_schema_invalid", stop=True)
    wav_hash = value["wavSHA256"]
    reference = value["referenceTranscript"]
    reply_words = value["expectedReplyWords"]
    if (
        not isinstance(wav_hash, str)
        or not re.fullmatch(r"[0-9a-f]{64}", wav_hash)
        or not isinstance(reference, str)
        or not _normal_words(reference)
        or not isinstance(reply_words, list)
        or not reply_words
        or any(not isinstance(word, str) or len(_normal_words(word).split()) != 1 for word in reply_words)
    ):
        raise CampaignFailure("preflight", "manifest_values_invalid", stop=True)
    normalized = {
        "wav_sha256": wav_hash,
        "reference_transcript": reference,
        "expected_reply_words": [_normal_words(word) for word in reply_words],
    }
    return normalized, actual_file_hash, path


def _bindings(supervisor: Any, config: dict[str, Any]) -> dict[str, Any]:
    llm = config["services"]["orchestrator"]["llm"]
    opts = llm.get("local", {}).get("llama_cpp", {}).get("options", {})
    result: dict[str, Any] = {
        "configured_llm": {
            "provider": llm.get("provider"),
            "model_file": Path(str(opts.get("model_path", ""))).name or None,
            "settings": {key: opts.get(key) for key in (
                "temperature", "max_tokens", "n_ctx", "n_gpu_layers", "n_batch",
                "seed", "n_threads", "top_p", "top_k", "repeat_penalty", "min_p", "chat_format",
            ) if key in opts},
        },
        "transcription": None,
        "tts": None,
    }
    for service in getattr(supervisor, "services", []):
        name = type(service).__name__
        if name == "TranscriptionService":
            model = getattr(service, "_accurate_model", None)
            stt_cfg = config["services"]["stt"]["transcription"]["accurate_model"]
            result["transcription"] = {
                "service": name,
                "enabled": getattr(service, "_accurate_enabled", None),
                "model_type": None if model is None else {
                    "module": type(model).__module__, "class": type(model).__qualname__
                },
                "model_ready": model is not None,
                "configured_model": Path(str(stt_cfg.get("model_size_or_path") or stt_cfg.get("model_size") or "")).name or None,
                "configured_device": stt_cfg.get("device"),
                "configured_compute_type": stt_cfg.get("compute_type"),
            }
        elif name == "TTSService":
            provider = getattr(service, "_provider", None)
            voice = getattr(provider, "_voice", None) if provider is not None else None
            model_file = getattr(voice, "model_file", None) if voice is not None else None
            config_file = getattr(voice, "config_file", None) if voice is not None else None
            result["tts"] = {
                "service": name,
                "provider_id": getattr(provider, "provider_id", None),
                "provider_type": None if provider is None else {
                    "module": type(provider).__module__, "class": type(provider).__qualname__
                },
                "model_file": Path(model_file).name if isinstance(model_file, str) else None,
                "model_config_file": Path(config_file).name if isinstance(config_file, str) else None,
                "executable_file": Path(str(getattr(provider, "_piper_path", ""))).name or None,
                "expected_sample_rate": getattr(provider, "_expected_sample_rate", None),
            }
    return result


async def _remote_k3_warmup_gate(attempts_dir: Path, stage_output: Path,
                                 cohort_manifest: dict[str, Any], candidate_hash: str,
                                 cohort_hash: str, condition_deadline: float) -> dict[str, Any]:
    """Require actual remote native STT, Assistant and TTS evidence for all warmups."""
    expected = cohort_manifest.get("remoteReceivers")
    proof_raw = os.environ.get("AURORA_K3_REMOTE_WARMUP_PROOF", "")
    stage_names = ("stt", "assistant", "tts")
    if not isinstance(expected, dict) or set(expected) != set(stage_names) or not proof_raw:
        raise CampaignFailure("warmup_gate", "remote_stage_receiver_binding_missing", stop=True)
    identity_keys = {"receiver_id", "source_sha256", "provider_class", "model_sha256", "config_sha256"}
    for stage in stage_names:
        identity = expected.get(stage)
        stage_identity_keys = identity_keys | ({"constructor_directory", "tokenizer_sha256", "vocabulary_sha256"}
                                                if stage == "stt" else set())
        if (not isinstance(identity, dict) or set(identity) != stage_identity_keys
                or not isinstance(identity.get("receiver_id"), str)
                or not re.fullmatch(r"[A-Za-z0-9._:-]{1,96}", identity["receiver_id"])
                or not isinstance(identity.get("provider_class"), str) or not identity["provider_class"]
                or any(not isinstance(identity.get(k), str) or not re.fullmatch(r"[0-9a-f]{64}", identity[k])
                       for k in ("source_sha256", "model_sha256", "config_sha256",
                                 *( ("tokenizer_sha256", "vocabulary_sha256") if stage == "stt" else () )))
                or (stage == "stt" and (
                    not isinstance(identity.get("constructor_directory"), str)
                    or not Path(identity["constructor_directory"]).is_absolute()
                    or str(Path(identity["constructor_directory"])) != identity["constructor_directory"]
                ))):
            raise CampaignFailure("warmup_gate", "remote_stage_receiver_manifest_invalid", stop=True)
    config_binding = cohort_manifest.get("remoteAssistantConfigBinding")
    if (not isinstance(config_binding, dict)
            or set(config_binding) != {"config_sha256", "automatic_tts_readback"}
            or config_binding.get("automatic_tts_readback") is not False
            or config_binding.get("config_sha256") != expected["assistant"]["config_sha256"]):
        raise CampaignFailure("warmup_gate", "remote_automatic_tts_not_frozen_disabled", stop=True)
    path = Path(proof_raw)
    if path.is_symlink():
        raise CampaignFailure("warmup_gate", "remote_stage_proof_symlink_rejected", stop=True)
    output = Path(os.environ.get("AURORA_OUTPUT_DIR", "")).resolve(strict=True)
    path = path.resolve(strict=False)
    if output not in path.parents:
        raise CampaignFailure("warmup_gate", "remote_stage_proof_outside_private_output", stop=True)
    proof_deadline = min(condition_deadline, time.monotonic() + REQUEST_CAP_SECONDS)
    while not path.is_file():
        if time.monotonic() >= proof_deadline:
            raise CampaignFailure("warmup_gate", "remote_stage_proof_deadline", stop=True)
        await asyncio.sleep(0.25)
    if path.is_symlink():
        raise CampaignFailure("warmup_gate", "remote_stage_proof_symlink_rejected", stop=True)
    try:
        if path.stat().st_size > 786_432:
            raise CampaignFailure("warmup_gate", "remote_stage_proof_too_large", stop=True)
        proof_bytes = path.read_bytes(); proof = json.loads(proof_bytes)
    except CampaignFailure:
        raise
    except Exception:
        raise CampaignFailure("warmup_gate", "remote_stage_proof_invalid", stop=True) from None
    if (not isinstance(proof, dict)
            or proof.get("schema") != "aurora.distributed_k3_remote_stages_warmup.v1"
            or proof.get("candidate_manifest_sha256") != candidate_hash
            or proof.get("cohort_manifest_sha256") != cohort_hash
            or proof.get("receivers") != expected):
        raise CampaignFailure("warmup_gate", "remote_stage_proof_binding_mismatch", stop=True)
    calls = proof.get("calls")
    if not isinstance(calls, list) or len(calls) != WARMUP_COUNT * len(stage_names):
        raise CampaignFailure("warmup_gate", "remote_stage_proof_call_count_mismatch", stop=True)
    expected_calls: dict[tuple[str, str], dict[str, str]] = {}
    for ordinal in range(1, WARMUP_COUNT + 1):
        case_id=f"audio-campaign-v1513-{ordinal:04d}"
        try: attempt=json.loads((attempts_dir/f"attempt-{ordinal:04d}-warmup.jsonl").read_text())
        except Exception: raise CampaignFailure("warmup_gate", "warmup_attempt_unreadable", stop=True) from None
        if (attempt.get("ordinal") != ordinal or attempt.get("phase") != "warmup"
                or attempt.get("harness_case_id") != case_id
                or attempt.get("candidate_manifest_sha256") != candidate_hash
                or attempt.get("status") != "completed_correct"
                or attempt.get("correctness", {}).get("all_expected") is not True):
            raise CampaignFailure("warmup_gate", "fifteen_correct_k3_flows_required", stop=True)
        local_id=attempt.get("correlation", {}).get("correlation_id")
        if not isinstance(local_id, str):
            raise CampaignFailure("warmup_gate", "warmup_local_correlation_missing", stop=True)
        for stage in stage_names:
            row=attempt.get("stages", {}).get(stage,{})
            server=row.get("server_correlation_id"); request_sha=row.get("request_payload_sha256")
            if (row.get("status") != "completed" or not isinstance(server,str)
                    or not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}",server)
                    or not isinstance(request_sha,str) or not re.fullmatch(r"[0-9a-f]{64}",request_sha)):
                raise CampaignFailure("warmup_gate", "warmup_remote_stage_binding_missing", stop=True)
            expected_calls[(stage,case_id)]={"local":local_id,"server":server,"request":request_sha}
    seen:set[tuple[str,str]]=set(); seen_servers:set[tuple[str,str]]=set(); pids:dict[str,int]={}
    for call in calls:
        if not isinstance(call,dict): raise CampaignFailure("warmup_gate", "remote_stage_native_span_invalid", stop=True)
        stage=call.get("stage"); case_id=call.get("harness_case_id")
        if stage not in stage_names or not isinstance(case_id,str):
            raise CampaignFailure("warmup_gate", "remote_stage_native_span_invalid", stop=True)
        joined=expected_calls.get((stage,case_id)); receiver=expected[stage]
        handler={"stt":"stt.model_invoke","assistant":"resolved_chat_model.astream","tts":"tts.model_invoke"}[stage]
        server_key=(stage,joined["server"]) if joined else None
        bad=(joined is None or (stage,case_id) in seen or server_key in seen_servers
            or call.get("local_correlation_id") != joined["local"]
            or call.get("server_correlation_id") != joined["server"]
            or call.get("native_correlation_id") != joined["server"]
            or call.get("request_payload_sha256") != joined["request"]
            or call.get("handler") != handler or call.get("outcome") != "completed"
            or type(call.get("receiver_pid")) is not int or call["receiver_pid"] <= 0
            or (stage in pids and pids[stage] != call["receiver_pid"])
            or call.get("receiver_id") != receiver["receiver_id"]
            or call.get("provider_identity") != receiver
            or not isinstance(call.get("native_span_id"),str)
            or not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}",call["native_span_id"]))
        if stage == "assistant":
            bad = bad or call.get("operation_id") is not None or call.get("attempt_id") is not None
            bad = bad or call.get("native_id_absence_reason") != "v430_async_span_exposes_span_id_only"
        else:
            bad = bad or not isinstance(call.get("operation_id"),str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}",str(call.get("operation_id")))
            bad = bad or not isinstance(call.get("attempt_id"),str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}",str(call.get("attempt_id")))
        if bad: raise CampaignFailure("warmup_gate", "remote_stage_native_span_join_invalid", stop=True)
        seen.add((stage,case_id)); seen_servers.add(server_key); pids[stage]=call["receiver_pid"]
    if seen != set(expected_calls):
        raise CampaignFailure("warmup_gate", "remote_stage_native_span_join_incomplete", stop=True)
    return {"status":"passed", "planned_and_correct_warmups":WARMUP_COUNT,
            "remote_stt_assistant_tts_receiver_gate":True,
            "remote_stage_proof_sha256":_sha256(proof_bytes),
            "remote_server_correlations_joined_per_stage":WARMUP_COUNT}


def _config_value(config: dict[str, Any], dotted_path: str) -> dict[str, Any]:
    value: Any = config
    for part in dotted_path.split("."):
        if not isinstance(value, dict) or part not in value:
            return {"present": False}
        value = value[part]
    return {"present": True, "value": value}


def _enabled_flags(value: Any, prefix: str = "services") -> dict[str, Any]:
    flags: dict[str, Any] = {}
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}"
            if key == "enabled":
                flags[path] = child
            elif isinstance(child, (dict, list)):
                flags.update(_enabled_flags(child, path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            flags.update(_enabled_flags(child, f"{prefix}[{index}]"))
    return flags


def _active_config_semantics(config: dict[str, Any]) -> dict[str, Any]:
    languages = {}
    for path in (
        "services.stt.language", "system.primary_language", "system.voice_language",
    ):
        field = _config_value(config, path)
        if field.get("present") and field.get("value") == "en-US":
            field["value"] = "en-us"
        languages[path] = field
    return {
        "llm_provider": _config_value(config, "services.orchestrator.llm.provider"),
        "llama_cpp_options": _config_value(
            config, "services.orchestrator.llm.local.llama_cpp.options"
        ),
        "stt_transcription": _config_value(config, "services.stt.transcription"),
        "tts": _config_value(config, "services.tts"),
        "service_enabled_flags": _enabled_flags(config.get("services", {})),
        "stt_coordinator_enabled": _config_value(config, "services.stt.coordinator.enabled"),
        "stt_wakeword_enabled": _config_value(config, "services.stt.wakeword.enabled"),
        "automatic_tts_readback": config.get("ui", {}).get("assistant", {}).get(
            "automatic_tts_readback", False
        ),
        "global_languages": languages,
    }


def _changed_config_paths(before: Any, after: Any, prefix: str = "") -> list[str]:
    if isinstance(before, dict) and isinstance(after, dict):
        paths: list[str] = []
        for key in sorted(set(before) | set(after)):
            child_path = f"{prefix}.{key}" if prefix else str(key)
            if key not in before or key not in after:
                paths.append(child_path)
            else:
                paths.extend(_changed_config_paths(before[key], after[key], child_path))
        return paths
    if isinstance(before, list) and isinstance(after, list):
        paths = []
        for index in range(max(len(before), len(after))):
            child_path = f"{prefix}[{index}]"
            if index >= len(before) or index >= len(after):
                paths.append(child_path)
            else:
                paths.extend(_changed_config_paths(before[index], after[index], child_path))
        return paths
    return [] if before == after else [prefix]


def _r7(values: list[float], percentile: int) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile / 100
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def _store_audio(audio_dir: Path, data: bytes) -> tuple[str, str]:
    digest = _sha256(data)
    name = f"{digest}.wav"
    path = audio_dir / name
    try:
        _write_once(path, data)
    except FileExistsError:
        if _sha256(path.read_bytes()) != digest:
            raise CampaignFailure("artifact", "content_address_collision", stop=True) from None
    return name, digest


async def _run() -> int:
    raw_output = os.environ.get("AURORA_OUTPUT_DIR")
    if not raw_output:
        raise CampaignFailure("preflight", "missing_output_directory", stop=True)
    output = Path(raw_output).resolve()
    if output == PRIVATE_ROOT or PRIVATE_ROOT not in output.parents:
        raise CampaignFailure("preflight", "output_outside_private_handoff", stop=True)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    output.chmod(0o700)
    attempts_dir = output / "attempts"
    audio_dir = output / "audio"
    attempts_dir.mkdir(mode=0o700)
    audio_dir.mkdir(mode=0o700)

    candidate, manifest_hash, manifest_path = _load_frozen_manifest()
    cohort_manifest_raw = os.environ.get("AURORA_FROZEN_MANIFEST")
    cohort_manifest_expected_hash = os.environ.get("AURORA_FROZEN_MANIFEST_SHA256", "")
    if not cohort_manifest_raw or not re.fullmatch(r"[0-9a-f]{64}", cohort_manifest_expected_hash):
        raise CampaignFailure("preflight", "missing_frozen_cohort_manifest_reference", stop=True)
    cohort_manifest_path = Path(cohort_manifest_raw).resolve(strict=True)
    cohort_manifest_bytes = cohort_manifest_path.read_bytes()
    cohort_manifest_hash = _sha256(cohort_manifest_bytes)
    if cohort_manifest_hash != cohort_manifest_expected_hash:
        raise CampaignFailure("preflight", "frozen_cohort_manifest_hash_mismatch", stop=True)
    try:
        cohort_manifest = json.loads(cohort_manifest_bytes)
    except Exception:
        raise CampaignFailure("preflight", "frozen_cohort_manifest_json_invalid", stop=True) from None
    if (
        not isinstance(cohort_manifest, dict)
        or not isinstance(cohort_manifest.get("measurementPlan"), dict)
        or cohort_manifest["measurementPlan"].get("conditionOverallCapSeconds")
        != CONDITION_CAP_SECONDS
    ):
        raise CampaignFailure("preflight", "frozen_condition_cap_mismatch", stop=True)
    epoch = cohort_manifest.get("epochLineage", {})
    if (epoch.get("epochId") != "V1513"
            or epoch.get("parentManifestSha256") != "54d51acdf8219b4e69f21cabb9d9fb1b402acf9826196dbdcea4fcfd15bddb25"
            or epoch.get("priorAttemptedMeasured") != PRIOR_MEASURED_COUNT
            or epoch.get("plannedEpochMeasured") != MEASURED_COUNT
            or epoch.get("conditionTargetMeasured") != CONDITION_TARGET
            or PRIOR_MEASURED_COUNT + MEASURED_COUNT != CONDITION_TARGET
            or epoch.get("firstConditionMeasuredIndex") != PRIOR_MEASURED_COUNT + 1
            or epoch.get("lastConditionMeasuredIndex") != CONDITION_TARGET
            or epoch.get("priorCorrect") != 512 or epoch.get("priorFailed") != 1
            or epoch.get("preserveParentFailure") is not True
            or cohort_manifest["measurementPlan"].get("plannedMeasuredPerCondition") != CONDITION_TARGET
            or cohort_manifest["measurementPlan"].get("plannedEpochMeasured") != MEASURED_COUNT):
        raise CampaignFailure("preflight", "remaining_epoch_lineage_invalid", stop=True)
    stt_url = os.environ.get("AURORA_K3_REMOTE_STT_ENDPOINT", "")
    assistant_url = os.environ.get("AURORA_K3_REMOTE_ASSISTANT_ENDPOINT", "")
    tts_url = os.environ.get("AURORA_K3_REMOTE_TTS_ENDPOINT", "")
    stt_endpoint = AdmittedEndpoint(stt_url, _sha256(stt_url.encode("utf-8")))
    assistant_endpoint = AdmittedEndpoint(assistant_url, _sha256(assistant_url.encode("utf-8")))
    tts_endpoint = AdmittedEndpoint(tts_url, _sha256(tts_url.encode("utf-8")))
    response_identity = cohort_manifest.get("remoteAssistantResponseIdentity")
    remote_receivers = cohort_manifest.get("remoteReceivers")
    remote_config_binding = cohort_manifest.get("remoteAssistantConfigBinding")
    if (not stt_url or not assistant_url or not tts_url or not os.environ.get("AURORA_HOSTED_PEER_GATEWAY_API_KEY")
            or cohort_manifest.get("remoteSttEndpointSha256") != stt_endpoint.sha256
            or cohort_manifest.get("remoteAssistantEndpointSha256") != assistant_endpoint.sha256
            or cohort_manifest.get("remoteTtsEndpointSha256") != tts_endpoint.sha256
            or cohort_manifest.get("remoteAuthBinding") != "existing_gateway_api_key"
            or not isinstance(remote_receivers, dict)
            or set(remote_receivers) != {"stt", "assistant", "tts"}
            or not isinstance(remote_config_binding, dict)
            or set(remote_config_binding) != {"config_sha256", "automatic_tts_readback"}
            or remote_config_binding.get("automatic_tts_readback") is not False
            or remote_config_binding.get("config_sha256") != remote_receivers["assistant"].get("config_sha256")
            or not isinstance(response_identity, dict)
            or set(response_identity) != {"provider", "model"}
            or not all(isinstance(v, str) and v for v in response_identity.values())):
        raise CampaignFailure("preflight", "remote_routes_auth_or_tts_policy_not_frozen", stop=True)
    runner_hash = _sha256(Path(__file__).read_bytes())
    composition_path = Path(__file__).resolve().with_name("k3_composition.py")
    if (cohort_manifest.get("implementation", {}).get("runnerSha256") != runner_hash
            or cohort_manifest.get("implementation", {}).get("k3CompositionSha256")
            != _sha256(composition_path.read_bytes())):
        raise CampaignFailure("preflight", "frozen_runner_hash_mismatch", stop=True)
    controller_path = Path(__file__).resolve().with_name("controller.py")
    expected_controller_hash = os.environ.get("AURORA_K3_CONTROLLER_SHA256", "")
    if (not re.fullmatch(r"[0-9a-f]{64}", expected_controller_hash)
            or _sha256(controller_path.read_bytes()) != expected_controller_hash
            or cohort_manifest.get("implementation", {}).get("controllerSha256") != expected_controller_hash):
        raise CampaignFailure("preflight", "frozen_controller_hash_mismatch", stop=True)
    source_closure = cohort_manifest.get("sourceClosure", {})
    source_inventory = Path(__file__).resolve().parent / "source-inventory.json"
    try:
        source_inventory_hash = _sha256(source_inventory.read_bytes())
    except OSError:
        raise CampaignFailure("preflight", "cpu_source_inventory_unavailable", stop=True) from None
    if (source_closure.get("equivalenceVerified") is not True
            or source_inventory_hash != source_closure.get("cpuSourceInventorySha256")):
        raise CampaignFailure("preflight", "full_source_equivalence_not_frozen", stop=True)
    wav_path = Path(os.environ.get("AURORA_VOICE_FIXTURE_WAV", "")).resolve(strict=True)
    wav_data = wav_path.read_bytes()
    if _sha256(wav_data) != candidate["wav_sha256"]:
        raise CampaignFailure("preflight", "candidate_wav_hash_mismatch", stop=True)
    with wave.open(str(wav_path), "rb") as source:
        wav_facts = {
            "sha256": _sha256(wav_data), "bytes": len(wav_data),
            "sample_rate": source.getframerate(), "channels": source.getnchannels(),
            "sample_width_bytes": source.getsampwidth(), "frames": source.getnframes(),
        }
    if (wav_facts["sample_rate"], wav_facts["channels"], wav_facts["sample_width_bytes"]) != (22050, 1, 2) or wav_facts["frames"] <= 0:
        raise CampaignFailure("preflight", "candidate_wav_profile_mismatch", stop=True)
    config_path = Path(os.environ["AURORA_CONFIG_FILE"]).resolve(strict=True)
    config_before_bytes = config_path.read_bytes()
    config_before_hash = _sha256(config_before_bytes)
    config_before = json.loads(config_before_bytes)
    config = config_before
    if config.get("ui", {}).get("assistant", {}).get("automatic_tts_readback", False):
        raise CampaignFailure("preflight", "automatic_server_tts_must_be_disabled", stop=True)
    stt_settings = config.get("services", {}).get("stt", {}).get("transcription", {}).get("accurate_model", {})

    # Root's existing bootstrap installs the opt-in bindings/observer before
    # runpy enters this file; do not install a second copy here.
    import main as aurora_main  # Load standard config/dotenv behavior; do not enter its blocking loop.
    if not callable(getattr(aurora_main, "main_async", None)):
        raise CampaignFailure("preflight", "normal_main_entrypoint_missing", stop=True)
    from app.services.supervisor import Supervisor
    supervisor = Supervisor()
    setup_started_ns = time.monotonic_ns()
    condition_deadline = 0.0
    condition_started_ns: int | None = None
    bindings_before: dict[str, Any] | None = None
    bindings_last_after: dict[str, Any] | None = None
    attempts_summary: list[dict[str, Any]] = []
    status = "starting"
    stop_reason: str | None = None
    summary_path = output / "summary.json"
    progress_path = output / "progress.json"
    summary: dict[str, Any] = {
        "schema_version": "aurora.full_audio_campaign.v1",
        "status": status,
        "condition": "gateway_http_stt_assistant_tts",
        "planned_warmups": WARMUP_COUNT,
        "planned_measured": MEASURED_COUNT,
        "epoch_lineage": epoch,
        "condition_target_measured": CONDITION_TARGET,
        "request_cap_seconds": REQUEST_CAP_SECONDS,
        "condition_cap_seconds": CONDITION_CAP_SECONDS,
        "input": wav_facts,
        "candidate_manifest_sha256": manifest_hash,
        "candidate_manifest_role": "exact_three_key_pilot_input_manifest",
        "frozen_cohort_manifest_sha256": cohort_manifest_hash,
        "frozen_cohort_manifest_name": cohort_manifest_path.name,
        "remote_stt_endpoint_sha256": stt_endpoint.sha256,
        "remote_assistant_endpoint_sha256": assistant_endpoint.sha256,
        "remote_tts_endpoint_sha256": tts_endpoint.sha256,
        "remote_auth_binding": "existing_gateway_api_key",
        "remote_assistant_automatic_tts_readback_disabled_by_frozen_manifest": True,
        "candidate_manifest_reference_sha256": _sha256(candidate["reference_transcript"].encode()),
        "expected_reply_words": candidate["expected_reply_words"],
        "config_sha256": config_before_hash,
        "config_raw_sha256_before_startup": config_before_hash,
        "config_raw_sha256_after_startup": None,
        "config_startup_changed_key_paths": [],
        "config_startup_changed_values_redacted": True,
        "config_startup_semantics_verified": None,
        "physical_microphone": False,
        "physical_playback_or_audibility": False,
        "measured_requests": 0,
        "warmup_requests": 0,
        "attempted": 0,
        "correct": 0,
        "failed": 0,
        "partial_quality_incorrect": 0,
        "timeouts": 0,
        "unattempted_measured": MEASURED_COUNT,
        "successful_correct_latency_ms_r7": {"p50": None, "p90": None, "p95": None, "p99": None},
        "completed_flow_latency_ms_r7_including_incorrect": {"p50": None, "p90": None, "p95": None},
        "missing_metrics": {
            "first_token": "not exposed by this caller boundary",
            "first_audio": "no playback path in this pilot",
            "playback_start": "no playback path in this pilot",
            "playback_end": "no playback path in this pilot",
        },
    }
    correct_latency: list[float] = []
    completed_latency: list[float] = []
    observed_measured_latency: list[float] = []
    shutdown_ok = False
    try:
        await supervisor.initialize()
        await supervisor._subscribe_registered_contracts()
        await supervisor.start_services()
        await supervisor._subscribe_to_config_changes()
        config_after_bytes = config_path.read_bytes()
        config_after_hash = _sha256(config_after_bytes)
        config_after = json.loads(config_after_bytes)
        changed_config_paths = _changed_config_paths(config_before, config_after)
        semantics_match = (
            _active_config_semantics(config_before) == _active_config_semantics(config_after)
        )
        summary["config_raw_sha256_after_startup"] = config_after_hash
        summary["config_startup_changed_key_paths"] = changed_config_paths
        summary["config_startup_semantics_verified"] = semantics_match
        if not semantics_match:
            raise CampaignFailure("startup", "active_config_semantics_changed", stop=True)
        config = config_after
        config_hash = config_after_hash
        summary["config_sha256"] = config_hash
        summary["setup_duration_ms"] = (time.monotonic_ns() - setup_started_ns) / 1_000_000
        bindings_before = _bindings(supervisor, config)
        summary["provider_bindings_before"] = bindings_before
        condition_started = time.monotonic()
        condition_started_ns = time.monotonic_ns()
        condition_deadline = condition_started + CONDITION_CAP_SECONDS
        summary["condition_started_monotonic_ns"] = condition_started_ns
        status = "running"
        total = WARMUP_COUNT + MEASURED_COUNT

        for ordinal in range(1, total + 1):
            if time.monotonic() >= condition_deadline:
                stop_reason = "condition_deadline"
                break
            if _sha256(manifest_path.read_bytes()) != manifest_hash:
                stop_reason = "candidate_manifest_changed"
                status = "stopped_system_failure"
                break
            if _sha256(cohort_manifest_path.read_bytes()) != cohort_manifest_hash:
                stop_reason = "frozen_cohort_manifest_changed"
                status = "stopped_system_failure"
                break
            if _sha256(config_path.read_bytes()) != config_hash:
                stop_reason = "runtime_config_changed"
                status = "stopped_system_failure"
                break
            phase = "warmup" if ordinal <= WARMUP_COUNT else "measured"
            attempt_index = ordinal if phase == "warmup" else ordinal - WARMUP_COUNT
            attempt_started_ns = time.monotonic_ns()
            attempt_deadline = min(time.monotonic() + REQUEST_CAP_SECONDS, condition_deadline)
            correlation_id = f"audio-campaign-{uuid.uuid4().hex}"
            session_id = f"audio-session-{uuid.uuid4().hex}"
            request_id = f"audio-request-{uuid.uuid4().hex}"
            harness_case_id = f"audio-campaign-v1513-{ordinal:04d}"
            row: dict[str, Any] = {
                "schema_version": "aurora.full_audio_attempt.v1",
                "ordinal": ordinal, "phase": phase, "phase_index": attempt_index,
                "harness_case_id": harness_case_id,
                "epoch_id": epoch["epochId"],
                "frozen_cohort_manifest_sha256": cohort_manifest_hash,
                "condition_measured_index": PRIOR_MEASURED_COUNT + attempt_index if phase == "measured" else None,
                "status": "starting", "flow_started_monotonic_ns": attempt_started_ns,
                "correlation": {"correlation_id": correlation_id, "session_id": session_id, "request_id": request_id},
                "input_wav_sha256": wav_facts["sha256"], "stages": {}, "correctness": {},
                "output_audio": None,
            }
            summary["attempted"] += 1
            if phase == "warmup":
                summary["warmup_requests"] += 1
            else:
                summary["measured_requests"] += 1

            abort_after_row = False
            try:
                try:
                    k3_record, audio_data = await run_k3_case(
                        supervisor, wav_data, wav_sha256=wav_facts["sha256"],
                        session_id=session_id, request_id=request_id,
                        correlation_id=correlation_id,
                        reference_transcript=candidate["reference_transcript"],
                        expected_reply_words=candidate["expected_reply_words"],
                        expected_remote_provider=response_identity["provider"],
                        expected_remote_model=response_identity["model"],
                        stt_endpoint=stt_endpoint, assistant_endpoint=assistant_endpoint, tts_endpoint=tts_endpoint,
                        deadline_monotonic=attempt_deadline,
                        remote_auto_tts_readback_disabled=(
                            remote_config_binding.get("automatic_tts_readback") is False
                        ),
                    )
                except K3CaseError as exc:
                    partial = exc.partial_record or {}
                    row["stages"] = partial.get("stages", {})
                    row["correctness"] = partial.get("correctness", {})
                    row["partial_quality_incorrect"] = any(
                        partial.get("correctness", {}).get(key) is False
                        for key in ("transcript_matches_reference_words", "assistant_reply_matches_expected_words")
                    )
                    if row["partial_quality_incorrect"]:
                        row["partial_failure_class"] = "quality_predicate_failed_before_full_flow_completion"
                    raise CampaignFailure(
                        exc.stage, exc.category, stop=exc.stop_campaign
                    ) from None
                row["stages"] = k3_record["stages"]
                row["correctness"] = k3_record["correctness"]
                row["flow_ended_monotonic_ns"] = time.monotonic_ns()
                row["flow_duration_ms"] = (
                    row["flow_ended_monotonic_ns"] - attempt_started_ns
                ) / 1_000_000
                row["flow_end_point"] = "valid_non_silent_pcm16_tts_wav_received_decoded_and_checked"
                artifact_store_started_ns = time.monotonic_ns()
                try:
                    audio_name, audio_hash = _store_audio(audio_dir, audio_data)
                finally:
                    row["artifact_store_duration_ms"] = (
                        time.monotonic_ns() - artifact_store_started_ns
                    ) / 1_000_000
                row["stages"]["tts"].update({
                    "audio_file": f"audio/{audio_name}", "audio_sha256": audio_hash,
                    "audio_bytes": len(audio_data),
                })
                row["output_audio"] = {"sha256": audio_hash, "file": f"audio/{audio_name}"}
                row["status"] = "completed_correct" if row["correctness"].get("all_expected") is True else "completed_incorrect"
                if row["flow_duration_ms"] > REQUEST_CAP_SECONDS * 1000:
                    row["status"] = "failed"
                    row["failure"] = {"stage": "flow", "code": "request_deadline_exhausted"}
                    row["timeout"] = True
            except CampaignFailure as exc:
                row["status"] = "failed"
                row["failure"] = {"stage": exc.stage, "code": exc.code}
                row["timeout"] = "timeout" in exc.code.lower() or "deadline" in exc.code.lower()
                abort_after_row = exc.stop_campaign
                row.setdefault("flow_ended_monotonic_ns", time.monotonic_ns())
                row.setdefault("flow_duration_ms", (row["flow_ended_monotonic_ns"] - attempt_started_ns) / 1_000_000)
                row.setdefault("flow_end_point", "failure_observed")
            except (KeyboardInterrupt, asyncio.CancelledError) as exc:
                row["status"] = "interrupted"
                row["failure"] = {"stage": "controller", "code": type(exc).__name__}
                abort_after_row = True
                row.setdefault("flow_ended_monotonic_ns", time.monotonic_ns())
                row.setdefault("flow_duration_ms", (row["flow_ended_monotonic_ns"] - attempt_started_ns) / 1_000_000)
                row.setdefault("flow_end_point", "failure_observed")
            except BaseException as exc:
                row["status"] = "system_failure"
                row["failure"] = {"stage": "controller", "code": type(exc).__name__}
                abort_after_row = True
                row.setdefault("flow_ended_monotonic_ns", time.monotonic_ns())
                row.setdefault("flow_duration_ms", (row["flow_ended_monotonic_ns"] - attempt_started_ns) / 1_000_000)
                row.setdefault("flow_end_point", "failure_observed")

            row.setdefault("flow_ended_monotonic_ns", time.monotonic_ns())
            row.setdefault("flow_duration_ms", (row["flow_ended_monotonic_ns"] - attempt_started_ns) / 1_000_000)
            row["within_request_deadline"] = row["flow_duration_ms"] <= REQUEST_CAP_SECONDS * 1000
            row.setdefault("timeout", False)
            if not row["within_request_deadline"]:
                row["timeout"] = True
                if row["status"] in ("completed_correct", "completed_incorrect"):
                    row["status"] = "failed"
                    row["failure"] = {"stage": "flow", "code": "request_deadline_exceeded"}
            row["source_wav_sha256"] = candidate["wav_sha256"]
            row["candidate_manifest_sha256"] = manifest_hash
            row["config_sha256"] = config_hash
            row["provider_bindings_before"] = bindings_before
            try:
                row["provider_bindings_after"] = _bindings(supervisor, config)
                bindings_last_after = row["provider_bindings_after"]
            except BaseException as exc:
                row["provider_bindings_after_error_class"] = type(exc).__name__
                row["status"] = "system_failure"
                row["failure"] = {"stage": "provider_bindings", "code": "snapshot_failed"}
                abort_after_row = True
            if (
                row.get("provider_bindings_after") is not None
                and row["provider_bindings_after"] != bindings_before
            ):
                row["status"] = "system_failure"
                row["failure"] = {"stage": "provider_bindings", "code": "effective_bindings_changed"}
                abort_after_row = True
            row_name = f"attempt-{ordinal:04d}-{phase}.jsonl"
            _write_once(attempts_dir / row_name, (json.dumps(row, sort_keys=True, ensure_ascii=False) + "\n").encode())
            if row["status"] in ("completed_correct", "completed_incorrect"):
                if phase == "measured":
                    completed_latency.append(row["flow_duration_ms"])
                if phase == "measured" and row["status"] == "completed_correct":
                    correct_latency.append(row["flow_duration_ms"])
                    summary["correct"] += 1
            else:
                summary["failed"] += 1
                failure_code = str(row.get("failure", {}).get("code", "")).lower()
                if "timeout" in failure_code or "deadline" in failure_code:
                    summary["timeouts"] += 1
            if phase == "measured":
                observed_measured_latency.append(row["flow_duration_ms"])
                summary["unattempted_measured"] -= 1
            attempts_summary.append({
                "ordinal": ordinal, "phase": phase, "file": f"attempts/{row_name}",
                "status": row["status"], "timeout": row["timeout"],
                "partial_quality_incorrect": bool(row.get("partial_quality_incorrect", False)),
            })
            if _sha256(manifest_path.read_bytes()) != manifest_hash:
                stop_reason = "candidate_manifest_changed"
                status = "stopped_system_failure"
                abort_after_row = True
            if _sha256(cohort_manifest_path.read_bytes()) != cohort_manifest_hash:
                stop_reason = "frozen_cohort_manifest_changed"
                status = "stopped_system_failure"
                abort_after_row = True
            if _sha256(config_path.read_bytes()) != config_hash:
                stop_reason = "runtime_config_changed"
                status = "stopped_system_failure"
                abort_after_row = True
            _atomic_progress(progress_path, {
                "status": "running", "attempted": ordinal,
                "warmups_attempted": min(ordinal, WARMUP_COUNT),
                "measured_attempted": max(0, ordinal - WARMUP_COUNT),
                "planned_warmups": WARMUP_COUNT, "planned_measured": MEASURED_COUNT,
                "unattempted_measured": summary["unattempted_measured"],
                "last_attempt_file": f"attempts/{row_name}",
                "last_attempt_status": row["status"],
            })
            if abort_after_row:
                stop_reason = stop_reason or row.get("failure", {}).get("code", "system_failure")
                status = "stopped_system_failure"
                break
            if ordinal == WARMUP_COUNT:
                try:
                    summary["warmup_instrumentation_gate"] = await _remote_k3_warmup_gate(
                        attempts_dir, Path(os.environ["AURORA_VOICE_STAGE_OUTPUT"]).resolve(),
                        cohort_manifest, manifest_hash, cohort_manifest_hash,
                        condition_deadline,
                    )
                except CampaignFailure as exc:
                    summary["warmup_instrumentation_gate"] = {"status": "failed", "code": exc.code}
                    stop_reason = exc.code
                    status = "stopped_system_failure"
                    _atomic_progress(progress_path, {
                        "status": status, "attempted": ordinal,
                        "warmups_attempted": WARMUP_COUNT, "measured_attempted": 0,
                        "planned_warmups": WARMUP_COUNT, "planned_measured": MEASURED_COUNT,
                        "unattempted_measured": MEASURED_COUNT,
                        "last_attempt_file": f"attempts/{row_name}",
                        "last_attempt_status": row["status"], "stop_reason": stop_reason,
                    })
                    break
            if time.monotonic() >= condition_deadline:
                stop_reason = "condition_deadline"
                status = "incomplete_deadline"
                break
        else:
            status = (
                "completed_all_correct"
                if summary["correct"] == MEASURED_COUNT and summary["failed"] == 0
                else "completed_with_failures_or_incorrect"
            )
        if status == "running":
            status = "incomplete"
    except (KeyboardInterrupt, asyncio.CancelledError) as exc:
        status = "interrupted"
        stop_reason = type(exc).__name__
    except BaseException as exc:
        status = "failed_setup_or_system"
        stop_reason = type(exc).__name__
    finally:
        summary["condition_ended_monotonic_ns"] = time.monotonic_ns()
        summary["condition_elapsed_ms_excluding_setup_and_shutdown"] = (
            (summary["condition_ended_monotonic_ns"] - condition_started_ns) / 1_000_000
            if condition_started_ns is not None else None
        )
        shutdown_started_ns = time.monotonic_ns()
        try:
            await supervisor.shutdown()
            shutdown_ok = True
        except BaseException as exc:
            shutdown_ok = False
            summary["shutdown_error_class"] = type(exc).__name__
        summary["shutdown_duration_ms"] = (time.monotonic_ns() - shutdown_started_ns) / 1_000_000
        summary["shutdown_completed"] = shutdown_ok
        summary["status"] = status if shutdown_ok else "shutdown_failed"
        summary["stop_reason"] = stop_reason
        summary["flow_end_point"] = "valid_non_silent_pcm16_tts_wav_received_decoded_and_checked_before_artifact_write"
        summary["attempts"] = attempts_summary
        summary["attempted"] = len(attempts_summary)
        summary["unattempted_measured"] = max(0, MEASURED_COUNT - sum(1 for item in attempts_summary if item["phase"] == "measured"))
        summary["failed"] = sum(1 for item in attempts_summary if item["status"] not in ("completed_correct", "completed_incorrect"))
        summary["timeouts"] = sum(1 for row in attempts_summary if row.get("timeout", False))
        summary["partial_quality_incorrect"] = sum(
            1 for row in attempts_summary if row.get("partial_quality_incorrect", False)
        )
        summary["execution_failed_or_interrupted"] = sum(
            1 for row in attempts_summary
            if row["status"] not in ("completed_correct", "completed_incorrect")
            and not row.get("partial_quality_incorrect", False)
        )
        summary["provider_bindings_before"] = bindings_before
        summary["provider_bindings_after"] = bindings_last_after
        summary["successful_correct_count"] = len(correct_latency)
        summary["completed_flow_count_including_incorrect"] = len(completed_latency)
        summary["successful_correct_latency_ms_r7"] = {
            f"p{p}": _r7(correct_latency, p) for p in (50, 90, 95, 99)
        }
        summary["completed_flow_latency_ms_r7_including_incorrect"] = {
            f"p{p}": _r7(completed_latency, p) for p in (50, 90, 95)
        }
        summary["observed_measured_attempt_latency_ms_r7_including_failures"] = {
            f"p{p}": _r7(observed_measured_latency, p) for p in (50, 90, 95)
        }
        summary["correctness_denominator"] = {
            "measured_planned": MEASURED_COUNT,
            "measured_attempted": sum(1 for item in attempts_summary if item["phase"] == "measured"),
            "measured_correct": len(correct_latency),
            "warmup_planned_excluded": WARMUP_COUNT,
            "warmup_attempted_excluded": sum(1 for item in attempts_summary if item["phase"] == "warmup"),
            "measured_incorrect_completed": sum(
                1 for item in attempts_summary
                if item["phase"] == "measured" and item["status"] == "completed_incorrect"
            ),
            "measured_failed_or_interrupted": sum(
                1 for item in attempts_summary
                if item["phase"] == "measured" and item["status"] not in ("completed_correct", "completed_incorrect")
            ),
            "measured_partial_quality_incorrect_before_full_flow": sum(
                1 for item in attempts_summary if item["phase"] == "measured"
                and item.get("partial_quality_incorrect", False)
            ),
            "measured_execution_failed_or_interrupted": sum(
                1 for item in attempts_summary if item["phase"] == "measured"
                and item["status"] not in ("completed_correct", "completed_incorrect")
                and not item.get("partial_quality_incorrect", False)
            ),
            "warmup_failed_or_interrupted_excluded": sum(
                1 for item in attempts_summary
                if item["phase"] == "warmup" and item["status"] not in ("completed_correct", "completed_incorrect")
            ),
            "warmup_partial_quality_incorrect_excluded": sum(
                1 for item in attempts_summary if item["phase"] == "warmup"
                and item.get("partial_quality_incorrect", False)
            ),
            "unattempted_measured": max(0, MEASURED_COUNT - sum(1 for item in attempts_summary if item["phase"] == "measured")),
        }
        def phase_denominator(phase: str, planned: int) -> dict[str, int]:
            rows = [item for item in attempts_summary if item["phase"] == phase]
            return {
                "planned": planned,
                "attempted": len(rows),
                "completed_correct": sum(1 for item in rows if item["status"] == "completed_correct"),
                "completed_incorrect": sum(1 for item in rows if item["status"] == "completed_incorrect"),
                "failed_or_interrupted": sum(
                    1 for item in rows if item["status"] not in ("completed_correct", "completed_incorrect")
                ),
                "timeouts": sum(1 for item in rows if item.get("timeout", False)),
                "unattempted": max(0, planned - len(rows)),
            }
        summary["phase_denominators"] = {
            "warmup_excluded": phase_denominator("warmup", WARMUP_COUNT),
            "measured": phase_denominator("measured", MEASURED_COUNT),
            "all": {},
        }
        all_rows = attempts_summary
        summary["phase_denominators"]["all"] = {
            "planned": WARMUP_COUNT + MEASURED_COUNT,
            "attempted": len(all_rows),
            "completed_correct": sum(1 for item in all_rows if item["status"] == "completed_correct"),
            "completed_incorrect": sum(1 for item in all_rows if item["status"] == "completed_incorrect"),
            "failed_or_interrupted": sum(
                1 for item in all_rows if item["status"] not in ("completed_correct", "completed_incorrect")
            ),
            "timeouts": sum(1 for item in all_rows if item.get("timeout", False)),
            "unattempted": max(0, WARMUP_COUNT + MEASURED_COUNT - len(all_rows)),
        }
        summary["finished_monotonic_ns"] = time.monotonic_ns()
        _atomic_progress(progress_path, {
            "status": summary["status"],
            "attempted": summary["attempted"],
            "warmups_attempted": sum(1 for item in attempts_summary if item["phase"] == "warmup"),
            "measured_attempted": sum(1 for item in attempts_summary if item["phase"] == "measured"),
            "planned_warmups": WARMUP_COUNT,
            "planned_measured": MEASURED_COUNT,
            "unattempted_measured": summary["unattempted_measured"],
            "stop_reason": summary["stop_reason"],
        })
        if not summary_path.exists():
            try:
                _write_once(summary_path, (json.dumps(summary, sort_keys=True, indent=2) + "\n").encode())
            except FileExistsError:
                pass
    return 0 if status == "completed_all_correct" and shutdown_ok else 1


async def _entry() -> int:
    try:
        return await _run()
    except BaseException as exc:
        raw_output = os.environ.get("AURORA_OUTPUT_DIR")
        if raw_output:
            output = Path(raw_output).resolve()
            summary_path = output / "summary.json"
            if output != PRIVATE_ROOT and PRIVATE_ROOT in output.parents and output.is_dir() and not summary_path.exists():
                summary = {
                    "schema_version": "aurora.full_audio_campaign.v1",
                    "status": "failed_preflight_or_setup",
                    "stop_reason": type(exc).__name__,
                    "planned_warmups": WARMUP_COUNT,
                    "planned_measured": MEASURED_COUNT,
                    "attempted": 0,
                    "correct": 0,
                    "failed": 0,
                    "timeouts": 0,
                    "unattempted_measured": MEASURED_COUNT,
                    "phase_denominators": {
                        "warmup_excluded": {
                            "planned": WARMUP_COUNT, "attempted": 0,
                            "completed_correct": 0, "completed_incorrect": 0,
                            "failed_or_interrupted": 0, "timeouts": 0,
                            "unattempted": WARMUP_COUNT,
                        },
                        "measured": {
                            "planned": MEASURED_COUNT, "attempted": 0,
                            "completed_correct": 0, "completed_incorrect": 0,
                            "failed_or_interrupted": 0, "timeouts": 0,
                            "unattempted": MEASURED_COUNT,
                        },
                        "all": {
                            "planned": WARMUP_COUNT + MEASURED_COUNT, "attempted": 0,
                            "completed_correct": 0, "completed_incorrect": 0,
                            "failed_or_interrupted": 0, "timeouts": 0,
                            "unattempted": WARMUP_COUNT + MEASURED_COUNT,
                        },
                    },
                    "physical_microphone": False,
                    "physical_playback_or_audibility": False,
                }
                try:
                    _write_once(summary_path, (json.dumps(summary, sort_keys=True, indent=2) + "\n").encode())
                except FileExistsError:
                    pass
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_entry()))

#!/usr/bin/env python3
"""One bounded, retained-Supervisor full-audio LocalBus condition.

Source-only campaign runner. Root owns configuration, launch, resource caps and
all execution; this file is not a benchmark result or product telemetry hook.
"""
from __future__ import annotations

import asyncio
import base64
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
WARMUP_COUNT = 15
MEASURED_COUNT = 900
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


def _cpu_warmup_gate(attempts_dir: Path, stage_output: Path, wav_hash: str,
                     candidate_hash: str, config: dict[str, Any], *,
                     require_local_tts: bool = True,
                     case_prefix: str = "audio-campaign-v861") -> dict[str, Any]:
    """Require 15 correct local flows and actual local STT/LLM provider bindings."""
    ended: dict[str, dict[str, list[dict[str, Any]]]] = {}
    try:
        for line in stage_output.read_text().splitlines():
            record = json.loads(line)
            correlation = record.get("correlation_id")
            stage = record.get("stage")
            if (record.get("record_kind") == "invocation_span_boundary"
                    and record.get("event") == "span_end"
                    and isinstance(correlation, str) and stage in {"stt", "llm", "tts"}):
                ended.setdefault(correlation, {}).setdefault(stage, []).append(record)
    except Exception:
        raise CampaignFailure("warmup_gate", "native_stage_records_unreadable", stop=True) from None

    cases: list[dict[str, Any]] = []
    seen_correlations: set[str] = set()
    for ordinal in range(1, WARMUP_COUNT + 1):
        case_id = f"{case_prefix}-{ordinal:04d}"
        path = attempts_dir / f"attempt-{ordinal:04d}-warmup.jsonl"
        try:
            attempt = json.loads(path.read_text())
        except Exception:
            raise CampaignFailure("warmup_gate", "warmup_attempt_unreadable", stop=True) from None
        correlation_record = attempt.get("correlation")
        correlation = correlation_record.get("correlation_id") if isinstance(correlation_record, dict) else None
        bus_complete = all(
            attempt.get("stages", {}).get(stage, {}).get("status") == "completed"
            for stage in ("stt", "assistant", "tts")
        )
        correctness = attempt.get("correctness", {})
        correct = (
            attempt.get("status") == "completed_correct"
            and correctness.get("all_expected") is True
            and correctness.get("transcript_matches_reference_words") is True
            and correctness.get("assistant_reply_matches_expected_words") is True
        )
        span_stages = ended.get(correlation, {}) if isinstance(correlation, str) else {}
        stt_spans = span_stages.get("stt", [])
        llm_spans = span_stages.get("llm", [])
        tts_spans = span_stages.get("tts", [])
        native_complete = (
            any(r.get("handler") == "stt.model_invoke" and r.get("outcome") == "completed"
                and isinstance(r.get("operation_id"), str) and isinstance(r.get("attempt_id"), str) for r in stt_spans)
            and any(r.get("handler") == "resolved_chat_model.astream" and r.get("outcome") == "completed"
                    and r.get("selected_provider") == "app.services.orchestrator.chat_llama_cpp.ChatLlamaCpp" for r in llm_spans)
            and (not require_local_tts or any(r.get("handler") == "tts.model_invoke" and r.get("outcome") == "completed"
                    and isinstance(r.get("operation_id"), str) and isinstance(r.get("attempt_id"), str) for r in tts_spans))
        )
        if (attempt.get("ordinal") != ordinal or attempt.get("phase") != "warmup"
                or attempt.get("harness_case_id") != case_id
                or attempt.get("input_wav_sha256") != wav_hash
                or attempt.get("candidate_manifest_sha256") != candidate_hash
                or not isinstance(correlation, str) or correlation in seen_correlations
                or not bus_complete or not correct or not native_complete):
            raise CampaignFailure("warmup_gate", "fifteen_correct_native_flows_required", stop=True)
        seen_correlations.add(correlation)
        cases.append({"harness_case_id": case_id, "correlation_id": correlation,
                      "local_bus_stages_complete": True, "native_spans_complete": True,
                      "correctness_complete": True})

    binding_path = stage_output.with_name("actual-provider-bindings.jsonl")
    try:
        bindings = [json.loads(line) for line in binding_path.read_text().splitlines()]
    except Exception:
        raise CampaignFailure("warmup_gate", "actual_provider_records_unreadable", stop=True) from None
    stt = [r for r in bindings if r.get("event") == "stt_constructor_return"]
    llm = [r for r in bindings if r.get("event") == "llm_constructor_return"]
    piper_start = [r for r in bindings if r.get("event") == "piper_cli_call_start"]
    piper_end = [r for r in bindings if r.get("event") == "piper_cli_call_return"]
    stt_config = config["services"]["stt"]["transcription"]["accurate_model"]
    llm_config = config["services"]["orchestrator"]["llm"]["local"]["llama_cpp"]["options"]
    tts_config = config["services"]["tts"]
    stt_object_ids = {r.get("returned", {}).get("objectId") for r in stt}
    stt_engine_ids = {r.get("engine", {}).get("objectId") for r in stt}
    actual_stt = (bool(stt)
        and len(stt_object_ids) == 1 and None not in stt_object_ids
        and len(stt_engine_ids) == 1 and None not in stt_engine_ids and all(
        r.get("returned", {}).get("class") == "faster_whisper.transcribe.WhisperModel"
        and r.get("engine", {}).get("class") == "ctranslate2._ext.Whisper"
        and r.get("actualDevice") == "cpu" and r.get("actualComputeType") == "int8_float32"
        and r.get("actualArguments", {}).get("model") == stt_config.get("model_size_or_path")
        and r.get("actualArguments", {}).get("device") == stt_config.get("device") == "cpu"
        and r.get("actualArguments", {}).get("compute_type") == stt_config.get("compute_type") == "int8" for r in stt
    ))
    llm_object_ids = {r.get("returned", {}).get("objectId") for r in llm}
    llm_client_ids = {r.get("actualClient", {}).get("objectId") for r in llm}
    actual_llm = (bool(llm) and len(llm_object_ids) == 1 and None not in llm_object_ids
        and len(llm_client_ids) == 1 and None not in llm_client_ids and all(
        r.get("returned", {}).get("class") == "app.services.orchestrator.chat_llama_cpp.ChatLlamaCpp"
        and r.get("actualClient", {}).get("class") == "llama_cpp.llama.AuroraOwnedLlama"
        and isinstance(r.get("actualArguments"), dict)
        and r["actualArguments"].get("model_path") == llm_config.get("model_path")
        and r["actualArguments"].get("n_gpu_layers") == 0 and r["actualArguments"].get("n_threads") == 2
        and r["actualArguments"].get("n_ctx") == 4096 and r["actualArguments"].get("max_tokens") == 128
        and r["actualArguments"].get("seed") == 42 and r["actualArguments"].get("temperature") == 0.0
        and r["actualArguments"].get("top_p") == 1.0 and r["actualArguments"].get("top_k") == 1
        and r["actualArguments"].get("repeat_penalty") == 1.0 and r["actualArguments"].get("min_p") == 0.0
        and r["actualArguments"].get("chat_format") == "chatml-function-calling"
        and r.get("effectiveWrapperSettings", {}).get("n_gpu_layers") == 0
        and r.get("effectiveWrapperSettings", {}).get("n_threads") == 2
        and r.get("effectiveWrapperSettings", {}).get("n_ctx") == 4096
        and r.get("effectiveWrapperSettings", {}).get("n_batch") == 64
        and r.get("effectiveWrapperSettings", {}).get("seed") == 42 for r in llm
    ))
    actual_tts = (not require_local_tts) or (
        len(piper_start) == len(piper_end) and len(piper_end) >= WARMUP_COUNT
        and all(r.get("actualArguments", {}).get("useCuda") is False
                and r.get("actualArguments", {}).get("piperExecutable") == tts_config.get("piper_path")
                and isinstance(r.get("actualArguments", {}).get("voice", {}).get("model_file"), str)
                and Path(r["actualArguments"]["voice"]["model_file"]).resolve(strict=True)
                    == Path(tts_config.get("model_file_path", "")).resolve(strict=True)
                and isinstance(r.get("actualArguments", {}).get("voice", {}).get("config_file"), str)
                and Path(r["actualArguments"]["voice"]["config_file"]).resolve(strict=True)
                    == Path(tts_config.get("model_config_file_path", "")).resolve(strict=True)
                for r in piper_start)
        and all(r.get("audioBytes", 0) > 0 and r.get("sampleRate") == 22050
                for r in piper_end[:WARMUP_COUNT])
    )
    if not (actual_stt and actual_llm and actual_tts):
        raise CampaignFailure("warmup_gate", "actual_cpu_provider_identity_incomplete", stop=True)
    return {
        "status": "passed", "planned_and_correct_warmups": WARMUP_COUNT,
        "all_expected_predicates": True, "native_stt_llm_spans": True,
        "actual_stt_cpu_binding": True, "actual_llm_cpu_binding": True,
        "actual_piper_cpu_binding": require_local_tts,
        "actual_provider_record_sha256": _sha256(binding_path.read_bytes()),
        "warmup_cases": cases,
    }


async def _remote_tts_warmup_gate(attempts_dir: Path, stage_output: Path,
                                  cohort_manifest: dict[str, Any], candidate_hash: str,
                                  config: dict[str, Any], condition_deadline: float) -> dict[str, Any]:
    """Wait for Root's receiver spans and actual exact-peer call evidence."""
    expected = cohort_manifest.get("remoteMeshTtsReceiver")
    proof_path_raw = os.environ.get("AURORA_K1_RECEIVER_WARMUP_PROOF", "")
    if not isinstance(expected, dict) or not proof_path_raw:
        raise CampaignFailure("warmup_gate", "remote_tts_receiver_binding_missing", stop=True)
    required = {"receiver_id", "peer_id_sha256", "source_sha256", "provider_class", "model_sha256",
                "config_sha256", "hardware_fingerprint_sha256", "use_cuda", "sample_rate"}
    if set(expected) != required or expected.get("use_cuda") is not False or expected.get("sample_rate") != 22050:
        raise CampaignFailure("warmup_gate", "remote_tts_receiver_manifest_invalid", stop=True)
    for key in ("peer_id_sha256", "source_sha256", "model_sha256", "config_sha256", "hardware_fingerprint_sha256"):
        if not isinstance(expected.get(key), str) or not re.fullmatch(r"[0-9a-f]{64}", expected[key]):
            raise CampaignFailure("warmup_gate", "remote_tts_receiver_manifest_invalid", stop=True)
    if (not isinstance(expected.get("receiver_id"), str)
            or not re.fullmatch(r"[A-Za-z0-9._:-]{1,96}", expected["receiver_id"])
            or not isinstance(expected.get("provider_class"), str) or not expected["provider_class"]):
        raise CampaignFailure("warmup_gate", "remote_tts_receiver_manifest_invalid", stop=True)
    unresolved_proof_path = Path(proof_path_raw)
    if unresolved_proof_path.is_symlink():
        raise CampaignFailure("warmup_gate", "remote_tts_proof_symlink_rejected", stop=True)
    proof_path = unresolved_proof_path.resolve(strict=False)
    output = Path(os.environ.get("AURORA_OUTPUT_DIR", "")).resolve(strict=True)
    if output not in proof_path.parents:
        raise CampaignFailure("warmup_gate", "remote_tts_proof_outside_private_output", stop=True)
    local_gate = _cpu_warmup_gate(
        attempts_dir, stage_output, _load_frozen_manifest()[0]["wav_sha256"],
        candidate_hash, config, require_local_tts=False, case_prefix="audio-campaign-v861",
    )
    proof_deadline = min(condition_deadline, time.monotonic() + REQUEST_CAP_SECONDS)
    while not proof_path.is_file():
        if time.monotonic() >= proof_deadline:
            raise CampaignFailure("warmup_gate", "remote_tts_receiver_proof_deadline", stop=True)
        await asyncio.sleep(0.25)
    if proof_path.is_symlink():
        raise CampaignFailure("warmup_gate", "remote_tts_proof_symlink_rejected", stop=True)
    try:
        if proof_path.stat().st_size > 262_144:
            raise CampaignFailure("warmup_gate", "remote_tts_proof_too_large", stop=True)
    except OSError:
        raise CampaignFailure("warmup_gate", "remote_tts_proof_unavailable", stop=True) from None
    try:
        proof_bytes = proof_path.read_bytes()
        proof = json.loads(proof_bytes)
    except Exception:
        raise CampaignFailure("warmup_gate", "remote_tts_receiver_proof_invalid", stop=True) from None
    if (not isinstance(proof, dict) or proof.get("schema") != "aurora.distributed_k1_mesh_tts_warmup.v1"
            or proof.get("candidate_manifest_sha256") != candidate_hash
            or proof.get("proof_generator_sha256")
                != cohort_manifest.get("implementation", {}).get("receiverProofSha256")
            or proof.get("provider") != expected
            or type(proof.get("receiver_pid")) is not int or proof["receiver_pid"] <= 0):
        raise CampaignFailure("warmup_gate", "remote_tts_receiver_binding_mismatch", stop=True)
    calls = proof.get("calls")
    if not isinstance(calls, list) or len(calls) != WARMUP_COUNT:
        raise CampaignFailure("warmup_gate", "remote_tts_receiver_warmup_count_mismatch", stop=True)
    expected_by_case: dict[str, dict[str, Any]] = {}
    for ordinal in range(1, WARMUP_COUNT + 1):
        case_id = f"audio-campaign-v861-{ordinal:04d}"
        try:
            attempt = json.loads((attempts_dir / f"attempt-{ordinal:04d}-warmup.jsonl").read_text())
        except Exception:
            raise CampaignFailure("warmup_gate", "warmup_attempt_unreadable", stop=True) from None
        tts = attempt.get("stages", {}).get("tts", {})
        mesh_correlation = tts.get("mesh_correlation_id")
        local_id = attempt.get("correlation", {}).get("correlation_id")
        if (attempt.get("ordinal") != ordinal or attempt.get("phase") != "warmup"
                or attempt.get("harness_case_id") != case_id
                or attempt.get("candidate_manifest_sha256") != candidate_hash
                or attempt.get("status") != "completed_correct"
                or attempt.get("correctness", {}).get("all_expected") is not True
                or not isinstance(local_id, str) or mesh_correlation != local_id
                or not isinstance(tts.get("request_text_sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", tts["request_text_sha256"])):
            raise CampaignFailure("warmup_gate", "fifteen_correct_remote_tts_flows_required", stop=True)
        expected_by_case[case_id] = {
            "local": local_id, "mesh": mesh_correlation,
            "request_text_sha256": tts.get("request_text_sha256"),
        }
    seen_mesh_ids: set[str] = set()
    for call in calls:
        case_id = call.get("harness_case_id") if isinstance(call, dict) else None
        joined = expected_by_case.get(case_id)
        if (joined is None or call.get("local_correlation_id") != joined["local"]
                or call.get("mesh_correlation_id") != joined["mesh"]
                or call.get("native_correlation_id") != joined["mesh"]
                or call.get("selected_peer_id_sha256") != expected.get("peer_id_sha256")
                or call.get("request_text_sha256") != joined["request_text_sha256"]
                or call.get("handler") != "tts.model_invoke" or call.get("outcome") != "completed"
                or not isinstance(call.get("operation_id"), str)
                or not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", call["operation_id"])
                or not isinstance(call.get("attempt_id"), str)
                or not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", call["attempt_id"])
                or call.get("receiver_pid") != proof["receiver_pid"]
                or call.get("provider") != expected or joined["mesh"] in seen_mesh_ids):
            raise CampaignFailure("warmup_gate", "remote_tts_native_span_join_invalid", stop=True)
        seen_mesh_ids.add(joined["mesh"])
    if len(seen_mesh_ids) != WARMUP_COUNT:
        raise CampaignFailure("warmup_gate", "remote_tts_native_span_join_incomplete", stop=True)
    return {"status": "passed", "planned_and_correct_warmups": WARMUP_COUNT,
            "local_stt_llm_gate": local_gate, "remote_tts_receiver_gate": True,
            "remote_tts_proof_sha256": _sha256(proof_bytes),
            "remote_mesh_correlations_joined": WARMUP_COUNT,
            "receiver_id": expected["receiver_id"]}


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
    selected_peer_id = os.environ.get("AURORA_K1_MESH_TTS_PEER_ID", "")
    selected_peer_sha = _sha256(selected_peer_id.encode("utf-8")) if selected_peer_id else None
    if (not isinstance(selected_peer_id, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", selected_peer_id)
            or cohort_manifest.get("meshTtsPeerIdSha256") != selected_peer_sha
            or cohort_manifest.get("meshTtsAuthorityBinding") != "existing_authorized_peer_session"):
        raise CampaignFailure("preflight", "exact_mesh_peer_or_authority_not_frozen", stop=True)
    runner_hash = _sha256(Path(__file__).read_bytes())
    if cohort_manifest.get("implementation", {}).get("runnerSha256") != runner_hash:
        raise CampaignFailure("preflight", "frozen_runner_hash_mismatch", stop=True)
    controller_path = Path(__file__).resolve().with_name("controller.py")
    expected_controller_hash = os.environ.get("AURORA_V861_CONTROLLER_SHA256", "")
    if (not re.fullmatch(r"[0-9a-f]{64}", expected_controller_hash)
            or _sha256(controller_path.read_bytes()) != expected_controller_hash
            or cohort_manifest.get("implementation", {}).get("controllerSha256") != expected_controller_hash):
        raise CampaignFailure("preflight", "frozen_controller_hash_mismatch", stop=True)
    source_closure = cohort_manifest.get("sourceClosure", {})
    source_inventory = Path(os.environ.get("AURORA_K1_SOURCE_INVENTORY", ""))
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

    # Root's existing bootstrap installs the opt-in bindings/observer before
    # runpy enters this file; do not install a second copy here.
    import main as aurora_main  # Load standard config/dotenv behavior; do not enter its blocking loop.
    if not callable(getattr(aurora_main, "main_async", None)):
        raise CampaignFailure("preflight", "normal_main_entrypoint_missing", stop=True)
    from app.services.supervisor import Supervisor
    from app.shared.contracts.models.orchestrator import (
        OrchestratorMethods, OrchestratorProcessRequest, OrchestratorResponse,
    )
    from app.shared.contracts.models.stt import (
        TranscribeAudioRequest, TranscribeAudioResponse, TranscriptionMethods,
    )
    from app.shared.contracts.models.tts import (
        TTSSynthesizeResponse,
    )

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
        "condition": "localbus_accurate_stt_assistant_remote_typed_mesh_tts",
        "planned_warmups": WARMUP_COUNT,
        "planned_measured": MEASURED_COUNT,
        "request_cap_seconds": REQUEST_CAP_SECONDS,
        "condition_cap_seconds": CONDITION_CAP_SECONDS,
        "input": wav_facts,
        "candidate_manifest_sha256": manifest_hash,
        "candidate_manifest_role": "exact_three_key_pilot_input_manifest",
        "frozen_cohort_manifest_sha256": cohort_manifest_hash,
        "frozen_cohort_manifest_name": cohort_manifest_path.name,
        "mesh_tts_peer_id_sha256": selected_peer_sha,
        "mesh_authority_binding": "existing_authorized_peer_session",
        "mesh_route_observation": "actual_peerbridge_call_target_and_receiver_native_span_join",
        "selected_ice_pair": {"value": None, "reason": "not_exposed_by_typed_requester_call_boundary"},
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
            harness_case_id = f"audio-campaign-v861-{ordinal:04d}"
            row: dict[str, Any] = {
                "schema_version": "aurora.full_audio_attempt.v1",
                "ordinal": ordinal, "phase": phase, "phase_index": attempt_index,
                "harness_case_id": harness_case_id,
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

            async def bus_request(stage: str, topic: str, request: Any, response_type: type) -> Any:
                remaining = min(attempt_deadline - time.monotonic(), condition_deadline - time.monotonic())
                if remaining <= 0:
                    raise CampaignFailure(stage, "request_deadline_exhausted")
                began = time.monotonic_ns()
                try:
                    result = await asyncio.wait_for(
                        supervisor.bus.request(
                            topic, request, origin="internal", principal_id="system",
                            correlation_id=correlation_id, timeout=remaining,
                        ), timeout=remaining,
                    )
                except Exception as exc:
                    ended = time.monotonic_ns()
                    row["stages"][stage] = {
                        "status": "failed", "start_monotonic_ns": began, "end_monotonic_ns": ended,
                        "duration_ms": (ended - began) / 1_000_000, "error_class": type(exc).__name__,
                    }
                    raise CampaignFailure(stage, f"bus_call_{type(exc).__name__}") from None
                ended = time.monotonic_ns()
                if not getattr(result, "ok", False):
                    err = getattr(result, "error", None)
                    row["stages"][stage] = {
                        "status": "failed", "start_monotonic_ns": began, "end_monotonic_ns": ended,
                        "duration_ms": (ended - began) / 1_000_000,
                        "error_class": type(err).__name__ if err is not None else "query_failed",
                    }
                    raise CampaignFailure(stage, "bus_query_failed")
                try:
                    response = response_type.model_validate(result.data)
                except Exception as exc:
                    row["stages"][stage] = {
                        "status": "failed", "start_monotonic_ns": began, "end_monotonic_ns": ended,
                        "duration_ms": (ended - began) / 1_000_000, "error_class": type(exc).__name__,
                    }
                    raise CampaignFailure(stage, "response_contract_invalid") from None
                row["stages"][stage] = {
                    "status": "completed", "start_monotonic_ns": began, "end_monotonic_ns": ended,
                    "duration_ms": (ended - began) / 1_000_000,
                }
                return response

            abort_after_row = False
            try:
                stt = await bus_request(
                    "stt", TranscriptionMethods.TRANSCRIBE,
                    TranscribeAudioRequest(
                        audio_data=base64.b64encode(wav_data).decode("ascii"), format="wav",
                        sample_rate=22050, channels=1, language=None, model="accurate",
                    ), TranscribeAudioResponse,
                )
                row["stages"]["stt"].update({
                    "model_used": stt.model_used, "language": stt.language,
                    "duration_ms_reported_by_service": stt.duration_ms, "transcript": stt.text,
                })
                if not stt.text.strip():
                    raise CampaignFailure("stt", "empty_transcript")
                row["correctness"]["transcript_matches_reference_words"] = (
                    _normal_words(stt.text) == _normal_words(candidate["reference_transcript"])
                )
                assistant = await bus_request(
                    "assistant", OrchestratorMethods.EXTERNAL_USER_INPUT,
                    OrchestratorProcessRequest(
                        text=stt.text, source="external", session_id=session_id,
                        request_id=request_id, correlation_id=correlation_id,
                        stream=False, client_tts_playback=True,
                    ), OrchestratorResponse,
                )
                row["stages"]["assistant"].update({
                    "response": assistant.text,
                    "session_id_matches": assistant.session_id == session_id,
                    "request_id_matches": assistant.request_id == request_id,
                    "correlation_id_matches": assistant.correlation_id == correlation_id,
                    "metadata_error": assistant.metadata.get("error") is True,
                })
                if not assistant.text.strip() or assistant.metadata.get("error") is True:
                    raise CampaignFailure("assistant", "empty_or_error_response")
                row["correctness"]["assistant_reply_matches_expected_words"] = (
                    _normal_words(assistant.text).split() == candidate["expected_reply_words"]
                )
                tts_started_ns = time.monotonic_ns()
                remaining = min(attempt_deadline - time.monotonic(), condition_deadline - time.monotonic())
                if remaining <= 0:
                    raise CampaignFailure("tts", "request_deadline_exhausted", stop=True)
                try:
                    from tts_mesh_adapter import RemoteMeshTtsCallError, synthesize_mesh_tts
                    raw_tts, remote_meta = await asyncio.wait_for(
                        synthesize_mesh_tts(
                            supervisor.bus, assistant.text, attempt_deadline,
                            correlation_id=correlation_id, selected_peer_id=selected_peer_id,
                        ),
                        timeout=remaining,
                    )
                except asyncio.TimeoutError:
                    raise CampaignFailure("tts", "remote_mesh_tts_timeout_ambiguous", stop=True) from None
                except RemoteMeshTtsCallError as exc:
                    row["stages"]["tts"] = {
                        "status": "failed", "start_monotonic_ns": tts_started_ns,
                        "end_monotonic_ns": time.monotonic_ns(),
                        "duration_ms": (time.monotonic_ns() - tts_started_ns) / 1_000_000,
                        "error_category": exc.category,
                    }
                    raise CampaignFailure("tts", f"remote_mesh_{exc.category}", stop=True) from None
                tts_ended_ns = time.monotonic_ns()
                if tts_ended_ns > int(attempt_deadline * 1_000_000_000):
                    raise CampaignFailure("tts", "remote_mesh_tts_deadline_ambiguous", stop=True)
                try:
                    tts = TTSSynthesizeResponse.model_validate(raw_tts)
                except Exception:
                    raise CampaignFailure("tts", "remote_response_contract_invalid", stop=True) from None
                row["stages"]["tts"] = {
                    "status": "completed", "start_monotonic_ns": tts_started_ns,
                    "end_monotonic_ns": tts_ended_ns,
                    "duration_ms": (tts_ended_ns - tts_started_ns) / 1_000_000,
                    "transport": remote_meta["transport"],
                    "selected_peer_id_sha256": remote_meta["selected_peer_id_sha256"],
                    "requester_duration_ms": remote_meta["requester_duration_ms"],
                    "response_fields": remote_meta["response_fields"],
                    "mesh_correlation_id": remote_meta["mesh_correlation_id"],
                    "request_text_sha256": _sha256(assistant.text.encode("utf-8")),
                    "text_matches_assistant": tts.text == assistant.text,
                }
                if (row["stages"]["tts"]["selected_peer_id_sha256"] != selected_peer_sha
                        or row["stages"]["tts"]["mesh_correlation_id"] != correlation_id
                        or not row["stages"]["tts"]["text_matches_assistant"]):
                    raise CampaignFailure("tts", "remote_mesh_route_correlation_or_text_mismatch", stop=True)
                if tts.format != "wav" or not tts.audio_data:
                    raise CampaignFailure("tts", "synthesis_response_not_wav")
                try:
                    import io
                    audio_data = base64.b64decode(tts.audio_data, validate=True)
                    with wave.open(io.BytesIO(audio_data), "rb") as synthesized:
                        frames = synthesized.getnframes()
                        pcm = synthesized.readframes(frames)
                        valid = (
                            synthesized.getcomptype() == "NONE"
                            and synthesized.getsampwidth() == 2
                            and synthesized.getnchannels() == tts.channels == 1
                            and synthesized.getframerate() == tts.sample_rate
                            and frames > 0 and len(pcm) == frames * 2 * tts.channels and any(pcm)
                        )
                except Exception as exc:
                    raise CampaignFailure("tts", f"synthesized_wav_{type(exc).__name__}") from None
                if not valid:
                    raise CampaignFailure("tts", "synthesized_wav_profile_invalid")
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
                    "format": tts.format, "sample_rate": tts.sample_rate, "channels": tts.channels,
                    "output_audio_duration_ms": tts.duration_ms, "frames": frames,
                    "pcm_samples": len(pcm) // 2, "audio_bytes": len(audio_data),
                    "audio_sha256": audio_hash, "audio_file": f"audio/{audio_name}",
                })
                row["output_audio"] = {"sha256": audio_hash, "file": f"audio/{audio_name}"}
                row["correctness"]["all_expected"] = (
                    row["correctness"]["transcript_matches_reference_words"]
                    and row["correctness"]["assistant_reply_matches_expected_words"]
                    and row["stages"]["assistant"]["session_id_matches"]
                    and row["stages"]["assistant"]["request_id_matches"]
                    and row["stages"]["assistant"]["correlation_id_matches"]
                )
                row["status"] = "completed_correct" if row["correctness"]["all_expected"] else "completed_incorrect"
                if row["flow_duration_ms"] > REQUEST_CAP_SECONDS * 1000:
                    row["status"] = "failed"
                    row["failure"] = {"stage": "flow", "code": "request_deadline_exceeded"}
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
                    summary["warmup_instrumentation_gate"] = await _remote_tts_warmup_gate(
                        attempts_dir, Path(os.environ["AURORA_VOICE_STAGE_OUTPUT"]).resolve(),
                        cohort_manifest, manifest_hash, config, condition_deadline,
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
            "warmup_failed_or_interrupted_excluded": sum(
                1 for item in attempts_summary
                if item["phase"] == "warmup" and item["status"] not in ("completed_correct", "completed_incorrect")
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

"""One strict full-audio case for the declared C12 pair; no retries."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path
import time
import uuid


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def publish(path, value):
    path = Path(path)
    with path.open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


async def run_case(manifest, stream_name, bus=None, *, ordinal, parent_stt_correlation_id=None):
    """Use production typed bus locally, authenticated production HTTP remotely."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import stage_adapter

    spec = importlib.util.spec_from_file_location(
        "c12_strict_composition",
        Path(__file__).with_name(
            "local_composition.py" if bus is not None else "k3_composition.py"
        ),
    )
    composition = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(composition)
    correlation = "c12-v2421-" + uuid.uuid4().hex
    if bus is not None:
        from app.shared.contracts.models.orchestrator import OrchestratorMethods
        from app.shared.contracts.models.stt import TranscriptionMethods
        from app.shared.contracts.models.tts import TTSMethods
        from app.messaging.priority_helpers import get_interactive_priority

        topics = {
            "stt": TranscriptionMethods.TRANSCRIBE,
            "assistant": OrchestratorMethods.USER_INPUT,
            "tts": TTSMethods.SYNTHESIZE,
        }

        async def local_stage(stage, request, response_type, endpoint, *, deadline_monotonic, **_):
            begin = time.monotonic_ns()
            response_future = asyncio.get_running_loop().create_future()

            async def receive_response(envelope):
                payload = envelope.payload
                meta = getattr(payload, "metadata", {})
                if (
                    meta.get("request_id") == getattr(request, "request_id", None)
                    and meta.get("correlation_id") == correlation
                    and not response_future.done()
                ):
                    response_future.set_result(payload)

            if stage == "assistant":
                await bus.subscribe_event(OrchestratorMethods.RESPONSE, receive_response)
            try:
                reply = await bus.request(
                    topics[stage],
                    request,
                    priority=get_interactive_priority(),
                    timeout=max(0.01, deadline_monotonic - time.monotonic()),
                    max_attempts=1,
                    correlation_id=correlation,
                )
                if getattr(reply, "ok", True) is False:
                    raise stage_adapter.GatewayStageError(
                        stage, "local_typed_bus_failed", stop_campaign=True
                    )
                if stage == "assistant":
                    event = await asyncio.wait_for(
                        response_future, timeout=max(0.01, deadline_monotonic - time.monotonic())
                    )
                    typed = response_type(
                        text=event.text,
                        session_id=event.session_id,
                        request_id=event.metadata.get("request_id"),
                        correlation_id=event.metadata.get("correlation_id"),
                        metadata=event.metadata,
                    )
                else:
                    typed = response_type.model_validate(getattr(reply, "data", reply))
            finally:
                if stage == "assistant":
                    bus.unsubscribe(OrchestratorMethods.RESPONSE, receive_response)
            return typed, {
                "route_class": "production_local_bus",
                "bus_correlation_id": correlation,
                "adapter_duration_ms": (time.monotonic_ns() - begin) / 1e6,
            }

        composition.request_gateway_stage = local_stage
    endpoint = lambda stage: stage_adapter.AdmittedEndpoint(
        manifest["endpoints"][stage],
        hashlib.sha256(manifest["endpoints"][stage].encode()).hexdigest(),
    )
    out = Path(manifest["output"]) / "cases" / f"{ordinal:04d}"
    out.mkdir(parents=True, exist_ok=False)
    phase = "warmup" if ordinal <= manifest["warmupPairs"] else "measured"
    index = ordinal if phase == "warmup" else ordinal - manifest["warmupPairs"]
    started = time.monotonic_ns()
    raw = Path(manifest["audioPath"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == manifest["audioSha256"]
    row = {
        "schema": "aurora.c12.paired_case.v1",
        "at": datetime.now(timezone.utc).isoformat(),
        "stream": stream_name,
        "phase": phase,
        "phase_index": index,
        "ordinal": ordinal,
        "parent_remote_stt_correlation_id": parent_stt_correlation_id,
        "eligible_measured": phase == "measured",
        "correlation_id": correlation,
        "condition": "C12-mixed-local-plus-Orca-relayed-HTTP-K3-concurrency2",
        "manifest_sha256": manifest["campaignManifestSha256"],
        "start_monotonic_ns": started,
        "request_cap_seconds": manifest["requestCapSeconds"],
    }
    publish(out / "STARTED.json", row)
    try:
        record, audio = await asyncio.wait_for(
            composition.run_k3_case(
                None,
                raw,
                wav_sha256=manifest["audioSha256"],
                session_id="c12-session-" + uuid.uuid4().hex,
                request_id="c12-request-" + uuid.uuid4().hex,
                correlation_id=correlation,
                reference_transcript=manifest["referenceTranscript"],
                expected_reply_words=manifest["expectedReplyWords"],
                expected_remote_provider="llama_cpp",
                expected_remote_model="Qwen3.5-0.8B-Q4_0.gguf",
                stt_endpoint=endpoint("stt"),
                assistant_endpoint=endpoint("assistant"),
                tts_endpoint=endpoint("tts"),
                deadline_monotonic=time.monotonic() + manifest["requestCapSeconds"],
                remote_auto_tts_readback_disabled=True,
            ),
            timeout=manifest["requestCapSeconds"],
        )
        audio_path = out / ("AUDIO-" + stream_name + ".wav")
        with audio_path.open("xb") as f:
            f.write(audio)
            f.flush()
            os.fsync(f.fileno())
        row.update(
            status="completed_correct",
            case=record,
            audio={
                "path": str(audio_path),
                "bytes": len(audio),
                "sha256": hashlib.sha256(audio).hexdigest(),
            },
        )
    except composition.K3CaseError as exc:
        row.update(
            status="failed",
            failure={"stage": exc.stage, "category": exc.category},
            case=exc.partial_record,
            timeout="timeout" in exc.category,
            ambiguous_operation_may_remain=exc.stop_campaign,
        )
    except asyncio.TimeoutError:
        row.update(
            status="failed",
            failure={"category": "request_cap_timeout"},
            timeout=True,
            ambiguous_operation_may_remain=True,
        )
    except Exception as exc:
        row.update(
            status="harness_error",
            failure={"exceptionType": type(exc).__name__},
            modelQualityInference=False,
        )
    row.update(
        end_monotonic_ns=time.monotonic_ns(), duration_ms=(time.monotonic_ns() - started) / 1e6
    )
    publish(out / "CASE.json", row)
    return row

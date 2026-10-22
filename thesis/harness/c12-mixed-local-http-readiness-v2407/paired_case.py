"""One excluded C12 readiness flow; retained strict full-audio correctness."""

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


async def run_case(manifest, stream_name, bus=None):
    """Use production typed bus locally, authenticated production HTTP remotely."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import stage_adapter

    spec = importlib.util.spec_from_file_location(
        "c12_strict_composition", Path(__file__).with_name("k3_composition.py")
    )
    composition = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(composition)
    correlation = "c12-v2407-" + uuid.uuid4().hex
    if bus is not None:
        from app.shared.contracts.models.orchestrator import OrchestratorMethods
        from app.shared.contracts.models.stt import TranscriptionMethods
        from app.shared.contracts.models.tts import TTSMethods
        from app.messaging.priority_helpers import get_interactive_priority

        topics = {
            "stt": TranscriptionMethods.TRANSCRIBE,
            "assistant": OrchestratorMethods.EXTERNAL_USER_INPUT,
            "tts": TTSMethods.SYNTHESIZE,
        }

        async def local_stage(stage, request, response_type, endpoint, *, deadline_monotonic, **_):
            begin = time.monotonic_ns()
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
            typed = response_type.model_validate(getattr(reply, "data", reply))
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
    out = Path(manifest["output"])
    started = time.monotonic_ns()
    raw = Path(manifest["audioPath"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == manifest["audioSha256"]
    row = {
        "schema": "aurora.c12.excluded_readiness.v1",
        "at": datetime.now(timezone.utc).isoformat(),
        "stream": stream_name,
        "phase": "excluded_readiness",
        "eligible_measured": False,
        "correlation_id": correlation,
        "condition": "C12-mixed-local-plus-Orca-relayed-HTTP-K3-concurrency2",
        "manifest_sha256": manifest["readinessManifestSha256"],
        "start_monotonic_ns": started,
        "request_cap_seconds": manifest["requestCapSeconds"],
    }
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
    publish(out / ("RESULT-" + stream_name + ".json"), row)
    return row


async def local_driver(supervisor, manifest):
    out = Path(manifest["output"])
    publish(
        out / "LOCAL-DRIVER-ARMED.json",
        {
            "at": datetime.now(timezone.utc).isoformat(),
            "pid": os.getpid(),
            "maximumNewLocalFlows": 1,
            "measured": 0,
        },
    )
    end = time.monotonic() + manifest["triggerWaitCapSeconds"]
    trigger = out / "PILOT-TRIGGER.json"
    while not trigger.exists():
        if time.monotonic() >= end:
            publish(
                out / "LOCAL-TRIGGER-EXPIRED.json", {"at": datetime.now(timezone.utc).isoformat()}
            )
            return
        await asyncio.sleep(0.25)
    data = json.loads(trigger.read_bytes())
    assert data["readinessManifestSha256"] == manifest["readinessManifestSha256"]
    delay = datetime.fromisoformat(data["releaseAtUtc"]).timestamp() - time.time()
    assert -5 <= delay <= 120, "Reconcile expired trigger; no replacement/retry"
    await asyncio.sleep(max(0, delay))
    await run_case(manifest, "desktop-local", supervisor.bus)

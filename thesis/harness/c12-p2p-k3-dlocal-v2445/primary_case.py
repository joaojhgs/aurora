"""One strict actual-P2P primary; caller supplies an ordinarily admitted Supervisor.

No runtime, endpoint, credential, grant or lease is created here. Transport and
composition reuse the exact qualified K3 implementation in this directory.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import uuid

from admission_boundary import require_predecessor_release


def publish(path, value):
    temporary = path.with_name("." + path.name + ".partial")
    assert not path.exists()
    with temporary.open("x") as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    assert not path.exists()
    os.replace(temporary, path)


def actual_remote_stt_correlation(row):
    return row.get("case", {}).get("stages", {}).get("stt", {}).get("mesh_correlation_id")


async def run_case(manifest, supervisor, *, ordinal):
    require_predecessor_release()
    assert supervisor is not None and manifest["conditionId"] == "C12-P2P-K3-DLOCAL"
    assert manifest["warmupPairs"] == 15 and manifest["measuredPairs"] == 900
    assert manifest["remoteAutomaticTtsReadbackDisabled"] is True
    assert 1 <= ordinal <= 915
    stage = Path(__file__).resolve().parent
    sys.path.insert(0, str(stage))
    import mesh_stage_adapter

    assert Path(mesh_stage_adapter.__file__).resolve() == stage / "mesh_stage_adapter.py"
    bindings = manifest["admittedPeers"]
    assert set(bindings) == {"stt", "assistant", "tts"}
    peers = {
        name: mesh_stage_adapter.AdmittedMeshPeer(value["peer_id"], value["sha256"])
        for name, value in bindings.items()
    }
    assert len({p.peer_id for p in peers.values()}) == 1
    spec = importlib.util.spec_from_file_location("c12_p2p_strict_composition", stage / "k3_composition.py")
    composition = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(composition)
    correlation = "c12p2p-primary-v2445-" + uuid.uuid4().hex
    output = Path(manifest["requesterOutput"]) / "cases" / f"{ordinal:04d}"
    output.mkdir(parents=True, exist_ok=False)
    warmup = ordinal <= 15
    started = time.monotonic_ns()
    row = {
        "schema": "aurora.c12.paired_case.v1",
        "at": datetime.now(timezone.utc).isoformat(),
        "condition": "C12-P2P-K3-DLOCAL",
        "stream": "worker-p2p",
        "ordinal": ordinal,
        "phase": "warmup" if warmup else "measured",
        "phase_index": ordinal if warmup else ordinal - 15,
        "eligible_measured": not warmup,
        "correlation_id": correlation,
        "manifest_sha256": manifest["campaignManifestSha256"],
        "start_monotonic_ns": started,
        "request_cap_seconds": manifest["requestCapSeconds"],
        "declared_stage_provider_map": {"stt": "D", "assistant": "D", "tts": "D"},
    }
    publish(output / "STARTED.json", row)
    try:
        audio = Path(manifest["requesterAudioPath"]).read_bytes()
        assert hashlib.sha256(audio).hexdigest() == manifest["audioSha256"]
        record, result_audio = await asyncio.wait_for(
            composition.run_k3_case(
                supervisor,
                audio,
                wav_sha256=manifest["audioSha256"],
                session_id="c12p2p-session-" + uuid.uuid4().hex,
                request_id="c12p2p-request-" + uuid.uuid4().hex,
                correlation_id=correlation,
                reference_transcript=manifest["referenceTranscript"],
                expected_reply_words=manifest["expectedReplyWords"],
                expected_remote_stt_model="accurate",
                expected_remote_provider="llama_cpp",
                expected_remote_model="Qwen3.5-0.8B-Q4_0.gguf",
                stt_peer=peers["stt"],
                assistant_peer=peers["assistant"],
                tts_peer=peers["tts"],
                deadline_monotonic=time.monotonic() + manifest["requestCapSeconds"],
                remote_auto_tts_readback_disabled=manifest["remoteAutomaticTtsReadbackDisabled"],
            ),
            timeout=manifest["requestCapSeconds"],
        )
        path = output / "AUDIO-worker-p2p.wav"
        with path.open("xb") as stream:
            stream.write(result_audio)
            stream.flush()
            os.fsync(stream.fileno())
        row.update(status="completed_correct", case=record, audio={"path": str(path), "bytes": len(result_audio), "sha256": hashlib.sha256(result_audio).hexdigest()})
    except composition.K3CaseError as exc:
        row.update(status="failed", failure={"stage": exc.stage, "category": exc.category}, case=exc.partial_record, timeout="timeout" in exc.category, ambiguous_operation_may_remain=exc.stop_campaign)
    except asyncio.TimeoutError:
        row.update(status="failed", failure={"category": "request_cap_timeout"}, timeout=True, ambiguous_operation_may_remain=True)
    except Exception as exc:
        row.update(status="harness_error", failure={"exceptionType": type(exc).__name__}, modelQualityInference=False)
    row.update(end_monotonic_ns=time.monotonic_ns(), duration_ms=(time.monotonic_ns() - started) / 1e6)
    publish(output / "CASE.json", row)
    return row

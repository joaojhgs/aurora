"""Read the new condition's fifteen excluded pairs; no reference replay or inference."""

import hashlib
import json
from pathlib import Path
import tarfile

from campaign import WARMUP_PAIRS, sha


def _jsonl(path):
    return [json.loads(line) for line in path.read_bytes().splitlines() if line.strip()]


def verify(root, provider_manifest_sha, native_acceleration):
    from app.shared.contracts.models.orchestrator import OrchestratorMethods
    from app.shared.contracts.models.stt import TranscriptionMethods
    from app.shared.contracts.models.tts import TTSMethods

    root = Path(root)
    manifest = json.loads((root / "CAMPAIGN-MANIFEST.json").read_bytes())
    assert manifest["conditionId"] == "C12-P2P-K3-DLOCAL"
    assert WARMUP_PAIRS == manifest["warmupPairs"] == 15
    assert manifest["providerManifestSha256"] == provider_manifest_sha
    routes = _jsonl(root / "requester/mesh-route-observations.jsonl")
    contexts = _jsonl(root / "requester/dispatch-context-observations.jsonl")
    admission = json.loads((root / "requester/MESH-ROUTE-ADMISSION.json").read_bytes())
    assert admission["status"] == "admitted" and admission["modelRequests"] == 0
    native, queues, pairs = [], [], []
    seen = set()
    for ordinal in range(1, 16):
        primary = json.loads((root / "requester/cases" / f"{ordinal:04d}" / "CASE.json").read_bytes())
        custody = json.loads((root / "provider-custody" / f"{ordinal:04d}" / "CUSTODY.json").read_bytes())
        local = custody["receipt"]["localCase"]
        for row in (primary, local):
            assert row["phase"] == "warmup" and row["phase_index"] == ordinal
            assert row["status"] == "completed_correct" and row["case"]["correctness"]["all_expected"] is True
            assert row["correlation_id"] not in seen
            seen.add(row["correlation_id"])
            assert all(row["case"]["stages"][stage]["status"] == "completed" for stage in ("stt", "assistant", "tts"))
        assert primary["correlation_id"].startswith("c12p2p-primary-v2445-")
        assert local["correlation_id"].startswith("c12p2p-local-v2445-")
        assert local["parent_remote_stt_correlation_id"] == primary["case"]["stages"]["stt"]["mesh_correlation_id"]
        assert sha(primary["audio"]["path"]) == primary["audio"]["sha256"]
        assert sha(custody["archive"]) == custody["receipt"]["sha256"]
        with tarfile.open(custody["archive"]) as tar:
            for member in tar:
                data = tar.extractfile(member).read()
                expected = custody["receipt"]["members"][member.name]
                assert len(data) == expected["bytes"] and hashlib.sha256(data).hexdigest() == expected["sha256"]
                if member.name == "queue-observer-binding.json":
                    binding = json.loads(data)
                    assert binding["targetClass"] == "LocalBus" and binding["actualQueueDepthObservable"] is True
                elif member.name == "local/AUDIO.wav":
                    assert hashlib.sha256(data).hexdigest() == local["audio"]["sha256"]
                elif member.name in ("raw/voice-stages.jsonl", "raw/bus-queue-observations.jsonl"):
                    target = native if member.name.endswith("voice-stages.jsonl") else queues
                    target.extend(json.loads(line) for line in data.splitlines() if line.strip())
        pairs.append((primary, local))

    joins, ice, authority, overlaps = 0, [], [], []
    stage_map = (
        ("stt", "stt.model_invoke", TranscriptionMethods.TRANSCRIBE, TranscriptionMethods.TRANSCRIBE),
        ("assistant", "resolved_chat_model.astream", OrchestratorMethods.EXTERNAL_USER_INPUT, OrchestratorMethods.USER_INPUT),
        ("tts", "tts.model_invoke", TTSMethods.SYNTHESIZE, TTSMethods.SYNTHESIZE),
    )
    for primary, local in pairs:
        remote_bounds = {}
        for stage, handler, primary_topic, local_topic in stage_map:
            for stream, row, topic in (("primary", primary, primary_topic), ("local", local, local_topic)):
                corr = row["correlation_id"]
                records = [n for n in native if n.get("handler") == handler and n.get("correlation_id") == corr]
                starts = [n for n in records if n.get("event") == "span_start"]
                ends = [n for n in records if n.get("event") == "span_end"]
                assert len(starts) == len(ends) == 1
                assert starts[0]["span_id"] == ends[0]["span_id"]
                assert int(ends[0]["monotonic_ns"]) >= int(starts[0]["monotonic_ns"])
                queued = [q for q in queues if q.get("correlation_id") == corr and q.get("topic") == topic]
                assert queued and all(type(q["queue_depth_after_enqueue"]) is int for q in queued)
                joins += 1
                if stream == "primary":
                    remote_bounds[stage] = (int(starts[0]["monotonic_ns"]), int(ends[0]["monotonic_ns"]))
            corr = primary["correlation_id"]
            peer = manifest["admittedPeers"][stage]["sha256"]
            route_rows = [r for r in routes if r.get("correlation_id") == corr and r.get("topic") == primary_topic]
            assert len(route_rows) == 1 and route_rows[0]["request_outcome"] == "ok"
            snapshots = [route_rows[0][name] for name in ("before", "after")]
            selected = [s for s in snapshots if s.get("status") == "selected_nominated_pair_observed" and s.get("peer_id_sha256") == peer and s.get("selected_pairs")]
            assert selected, "Actual selected ICE path was not observed; never substitute HTTP or invent it"
            ice.append({"correlation_id": corr, "stage": stage, "snapshots": selected})
            context_rows = [a for a in contexts if a.get("correlation_id") == corr and a.get("topic") == primary_topic]
            assert len(context_rows) == 1
            context = context_rows[0]
            assert context["request_outcome"] == "ok" and context["context_status"] == "observed_supplied_context"
            assert context["provider_peer_id_sha256"] == peer
            assert type(context["auth_grant_revision"]) is int and type(context["manifest_revision"]) is int
            if stage in ("stt", "tts"):
                binding = context["speech_route_binding"]
                assert binding and binding["provider_lease_epoch"] and binding["projection_digest"] and binding["requirement_digest"]
                assert type(binding["provider_lease_revision"]) is int and type(binding["speech_capability_revision"]) is int
            authority.append(context)
        # Only D's clock is used: primary native spans and the local D case.
        local_start, local_end = local["start_monotonic_ns"], local["end_monotonic_ns"]
        overlap = min(remote_bounds["tts"][1], local_end) - max(remote_bounds["stt"][0], local_start)
        assert overlap > 0, "Declared offered two-flow overlap was not observed"
        overlaps.append({"ordinal": primary["ordinal"], "offeredFlowOverlapDClockMs": overlap / 1e6})

    assert joins == 90
    tts = sum(n.get("handler") == "tts.model_invoke" and n.get("event") == "span_start" for n in native)
    assert tts == 30, "Unexpected automatic/extra or missing TTS invocation"
    worker_native = root / "requester/voice-stages.jsonl"
    if worker_native.exists():
        assert not any(n.get("handler") in {"stt.model_invoke", "resolved_chat_model.astream", "tts.model_invoke"} for n in _jsonl(worker_native))
    assert any(x.get("actualOffloadedLayers") == 25 and x.get("totalLayers") == 25 for x in native_acceleration)
    return {
        "status": "ADMITTED_FIFTEEN_NEW_PAIRED_P2P_NATIVE_QUEUE_ICE_WARMUPS",
        "correctP2P": 15, "correctLocal": 15, "excludedPairs": 15,
        "nativeInvocationPairs": joins, "nativeTtsInvocations": tts,
        "extraAutomaticTts": 0, "actualEnqueueObservations": len(queues),
        "actualIceStageObservations": ice, "actualDispatchContexts": authority,
        "offeredOverlapDClock": overlaps, "sameStageParallelismClaim": False,
        "providerManifestSha256": provider_manifest_sha, "nativeAcceleration": native_acceleration,
        "measuredConsumed": 0, "warmupPooledIntoMeasured": False,
        "oldHTTPOrP2PMeasuredOrWarmupReplayed": False,
    }

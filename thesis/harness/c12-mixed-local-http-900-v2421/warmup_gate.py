"""One saved-data admission after exactly 15 correct paired full-audio warmups."""

import json
import tarfile
from pathlib import Path
from campaign import WARMUP_PAIRS, sha


def verify(root, provider_manifest_sha, native_acceleration):
    root = Path(root)
    native = []
    queues = []
    seen_cases = set()
    rows = []
    for ordinal in range(1, WARMUP_PAIRS + 1):
        primary = json.loads(
            (root / "requester/cases" / f"{ordinal:04d}" / "CASE.json").read_bytes()
        )
        custody = json.loads(
            (root / "provider-custody" / f"{ordinal:04d}" / "CUSTODY.json").read_bytes()
        )
        local = custody["receipt"]["localCase"]
        rows.append((primary, local))
        for row in (primary, local):
            assert row["phase"] == "warmup" and row["phase_index"] == ordinal
            assert (
                row["status"] == "completed_correct"
                and row["case"]["correctness"]["all_expected"] is True
            )
            assert row["correlation_id"] not in seen_cases
            seen_cases.add(row["correlation_id"])
            assert all(
                row["case"]["stages"][stage]["status"] == "completed"
                for stage in ["stt", "assistant", "tts"]
            )
        assert (
            local["parent_remote_stt_correlation_id"]
            == primary["case"]["stages"]["stt"]["server_correlation_id"]
        )
        assert sha(custody["archive"]) == custody["receipt"]["sha256"]
        with tarfile.open(custody["archive"]) as tar:
            for member in tar.getmembers():
                if member.name in ["raw/voice-stages.jsonl", "raw/bus-queue-observations.jsonl"]:
                    data = tar.extractfile(member).read()
                    (native if member.name.endswith("voice-stages.jsonl") else queues).extend(
                        json.loads(x) for x in data.splitlines() if x
                    )
    native_pairs = 0
    for primary, local in rows:
        for stage, handler in [
            ("stt", "stt.model_invoke"),
            ("assistant", "resolved_chat_model.astream"),
            ("tts", "tts.model_invoke"),
        ]:
            for stream, row in [("local", local), ("HTTP", primary)]:
                correlation = (
                    row["correlation_id"]
                    if stream == "local"
                    else row["case"]["stages"][stage]["server_correlation_id"]
                )
                spans = [
                    x
                    for x in native
                    if x.get("handler") == handler and x.get("correlation_id") == correlation
                ]
                assert sum(x.get("event") == "span_start" for x in spans) == 1
                assert sum(x.get("event") == "span_end" for x in spans) == 1
                native_pairs += 1
                assert any(x.get("correlation_id") == correlation for x in queues), (
                    "missing actual enqueue",
                    stage,
                    stream,
                )
    assert native_pairs == 90
    assert (
        sum(
            x.get("handler") == "tts.model_invoke" and x.get("event") == "span_start"
            for x in native
        )
        == 30
    )
    assert any(
        x.get("actualOffloadedLayers") == 25 and x.get("totalLayers") == 25
        for x in native_acceleration
    )
    return {
        "status": "ADMITTED_EXACT15_PAIRED_AUDIO_NATIVE_QUEUE_WARMUPS",
        "correctHTTP": 15,
        "correctLocal": 15,
        "excludedFlows": 30,
        "nativeInvocationPairs": native_pairs,
        "nativeTtsInvocations": 30,
        "extraAutomaticTts": 0,
        "actualEnqueueObservations": len(queues),
        "providerManifestSha256": provider_manifest_sha,
        "nativeAcceleration": native_acceleration,
        "measuredConsumed": 0,
        "sameStageParallelismClaim": False,
        "warmupPooledIntoMeasured": False,
    }

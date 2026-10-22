"""Record Root's observed wait on the existing frozen K1; no SUT calls."""
from datetime import datetime, timezone
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import shutil


ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "thesis/campaigns/worker-desktop-k1-p2p-tts-remaining880-v1719"
HANDOFF = ROOT / ".git/aurora-handoff-import-20261006"
ACTORS = [(2360747, 124937766), (2360768, 124937952), (2361201, 124942780)]
MANIFEST = "120dd99a4de0a242c30ebe4bb46d854ca77313c482a0c74f024edb624829a6e8"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def save_new(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def main(version, previous, observation_session):
    assert re.fullmatch(r"v[0-9]+", version) and re.fullmatch(r"v[0-9]+", previous)
    native = json.loads((BASE / f"NATIVE-GOAL-CHECKPOINT-{version}.json").read_bytes())
    assert native["goal"]["threadId"] == "01a112a5-d6bb-74e2-bf7c-ace73cb513b5"
    assert native["goal"]["status"] == "active"
    prior = json.loads((BASE / f"ROOT-RUNNING-CHECKPOINT-{previous}.json").read_bytes())
    assert sha((BASE / "condition-frozen.json").read_bytes()) == MANIFEST
    wait_path = BASE / f"ROOT-VERIFIED-WAIT-{version}.jsonl"
    wait_bytes = wait_path.read_bytes()
    observed = [json.loads(line) for line in wait_bytes.splitlines() if line]
    assert len(observed) >= 2
    for sample in observed:
        assert [(a["pid"], a["startTicks"]) for a in sample["actors"]] == ACTORS
        assert all(a["sameStart"] and a["state"] not in ["Z", "X", "x"] for a in sample["actors"])
    duration = (datetime.fromisoformat(observed[-1]["at"]) - datetime.fromisoformat(observed[0]["at"])).total_seconds()
    assert duration > 0
    actors = []
    for pid, start in ACTORS:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        assert int(fields[19]) == start and fields[0] not in ["Z", "X", "x"]
        actors.append({"pid": pid, "startTicks": start, "state": fields[0]})
    raw = (BASE / "CURRENT.json").read_bytes()
    index = json.loads(raw)
    progress = index["progressObservation"]
    assert progress["status"] == "running", "Actual terminal requires sealing, not a running checkpoint"
    rows = [r for r in index["completedCases"].values() if r["phase"] == "measured"]
    counts = Counter(r["status"] for r in rows)
    assert len(rows) == progress["measured_attempted"]
    custody = json.loads((ROOT / index["lastReceipt"]).read_bytes())
    assert not custody["errors"], custody["errors"]
    attempted = 20 + len(rows)
    correct = 19 + counts["completed_correct"]
    failed = 1 + sum(n for status, n in counts.items() if status != "completed_correct")
    assert attempted == correct + failed and attempted < 900
    failure_records = []
    for row in rows:
        if row["status"] == "completed_correct":
            continue
        case_bytes = (ROOT / row["case"]).read_bytes()
        assert sha(case_bytes) == row["caseSha256"]
        case = json.loads(case_bytes)
        failure_records.append({
            "globalIndex": case["condition_measured_index"],
            "failure": case.get("failure"),
            "consecutivePreacceptRejections": case.get("consecutive_preaccept_rejections"),
            "case": row["case"], "sha256": row["caseSha256"],
        })
    assert len(failure_records) == failed - 1
    at = datetime.now(timezone.utc).isoformat()
    free = shutil.disk_usage(BASE).free
    assert free > 2 * 1024**3
    failure_counts = sorted({s["failed"] for s in observed})
    whole = {"attempted": attempted, "correct": correct, "failed": failed, "planned": 900,
             "unattempted": 900 - attempted, "excludedWarmupsAcrossEpochs": 30}
    record = {
        **prior, "at": at, "status": "RUNNING", "actors": actors,
        "conditionManifestSha256": MANIFEST, "indexAt": index["updatedAt"],
        "indexSha256": sha(raw), "continuation": {"attempted": len(rows),
            "correct": counts["completed_correct"], "failed": failed - 1, "planned": 880},
        "wholeCondition": whole, "freeDiskBytes": free, "latestProgress": progress,
        "continuationFailures": sorted(failure_records, key=lambda r: r["globalIndex"]),
        "previousGoalTurnClassification": prior["thisGoalTurnClassification"],
        "thisGoalTurnClassification": "VERIFIED_WAIT",
        "thisTurnProgress": f"{len(observed)} actual original PID/start polls across {duration:.1f}s confirmed retained attempts {observed[0]['attempted']}→{observed[-1]['attempted']}; observed failure counts {failure_counts}. Fresh original actors live, copier0errors and case/progress equality. No extra workload/test/review/model/worker/resume.",
        "verifiedWait": {"localObservationSession": observation_session, "observationExitCode": 0,
            "observations": len(observed), "observedDurationSeconds": duration,
            "firstAt": observed[0]["at"], "lastAt": observed[-1]["at"],
            "firstAttempted": observed[0]["attempted"], "lastAttempted": observed[-1]["attempted"],
            "observedFailureCounts": failure_counts,
            "physicalLog": str(wait_path.relative_to(ROOT)), "bytes": len(wait_bytes),
            "sha256": sha(wait_bytes), "sameOriginalThreePidStartIdentitiesEveryObservation": True,
            "experimentStillLiveAtFinalCheckpoint": True},
        "lastCopierReceipt": {"path": index["lastReceipt"], "sha256": index["lastReceiptSha256"],
            "errors": custody["errors"], "measuredCasesMatchReportedProgress": True},
        "nativeGoalSnapshot": str((BASE / f"NATIVE-GOAL-CHECKPOINT-{version}.json").relative_to(ROOT)),
        "checkpointRecorder": {"path": str(Path(__file__).resolve().relative_to(ROOT)),
            "sha256": sha(Path(__file__).read_bytes()), "sutCalls": 0},
    }
    # Remove the older single-window summary when replacing it with observed counts.
    record["verifiedWait"].pop("failuresThroughout", None)
    checkpoint = BASE / f"ROOT-RUNNING-CHECKPOINT-{version}.json"
    save_new(checkpoint, record)
    text = (f"**{at} — original K1 P2P RUNNING:** {attempted}/900 attempts: {correct} correct, "
            f"{failed} failed, {900-attempted} unattempted;30 excluded warmups across retained epochs. "
            f"Original3 PID/start identities live; frozen120dd99a unchanged. LINK "
            f"{len(observed)} live-handle observations over{duration:.1f}s confirm saved cases"
            f"{observed[0]['attempted']}→{observed[-1]['attempted']}; observed failure counts{failure_counts}. "
            "Latest copier0errors and cases equal progress. Original Root native goal ACTIVE; original monitor unchanged, "
            "no further resume needed. All K2 source/custody scopes CLOSED. K2 next serial after actual K1 natural "
            "terminal/raw sealing/resource release; finite N acquisition cannot hold K2. No repeated tests/reviews/probes, "
            "new workers or active-source changes.")
    for target, prefix in [(ROOT / "docs/experiments/tcc-20261013-submission-20261030/root/CURRENT.md", "../../../../"),
                           (ROOT / ".omx/ultragoal/ORCA-COORDINATION.md", "../../")]:
        original = target.read_text()
        start, end = "<!-- AURORA:ROOT:LIVE:START -->", "<!-- AURORA:ROOT:LIVE:END -->"
        assert original.count(start) == original.count(end) == 1
        head, tail = original.split(start)
        _, rest = tail.split(end)
        link = prefix + str(checkpoint.relative_to(ROOT))
        temporary = target.with_name(target.name + f".root-{version}.tmp")
        with temporary.open("x") as stream:
            stream.write(head + start + "\n\n" + text.replace("LINK", f"[Actual checkpoint]({link}).") + "\n\n" + end + rest)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    pointer = HANDOFF / "EXISTING-SESSION-CURRENT-V491.json"
    data = json.loads(pointer.read_bytes())
    data["latestRootPhase"] = version.upper() + "_VERIFIED_WAIT_ORIGINAL_K1_LIVE"
    data["latestRootPath"] = str(checkpoint.relative_to(ROOT))
    temporary = pointer.with_name(pointer.name + f".{version}.tmp")
    save_new(temporary, data)
    os.replace(temporary, pointer)
    print(json.dumps({"at": at, "wholeCondition": whole, "actors": actors, "copierErrors": custody["errors"],
        "freeDiskBytes": free, "verifiedWaitSeconds": duration, "checkpoint": str(checkpoint.relative_to(ROOT))}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("previous")
    parser.add_argument("--observation-session", type=int, required=True)
    args = parser.parse_args()
    main(args.version, args.previous, args.observation_session)

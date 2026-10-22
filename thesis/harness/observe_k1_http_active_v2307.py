"""Read the existing V2296 run; never launch, signal, infer, or change its inputs."""

from datetime import datetime, timezone
import collections
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
HANDOFF = ROOT / ".git/aurora-handoff-import-20261006"
CELL = HANDOFF / "distributed-k1-orca-relayed-http-cell-v2296"
DATA = ROOT / "thesis/campaigns/worker-desktop-k1-orca-relayed-http-remaining450-v2296"
ACTORS = [(3965950, 139740362), (3965978, 139740616), (3965951, 139740363)]


def observe():
    manifest_sha = hashlib.sha256((DATA / "condition-frozen.json").read_bytes()).hexdigest()
    assert manifest_sha == "9adbf9ba3a7ec0948a087edad3655cf94ee344b3a2371a78d15f188f44150d42"
    rows = [
        json.loads(path.read_bytes())
        for path in sorted((CELL / "campaign/attempts").glob("*measured.jsonl"))
    ]
    counts = collections.Counter(row["status"] for row in rows)
    state = json.loads((DATA / "CURRENT.json").read_bytes())
    receipt_raw = (ROOT / state["lastReceipt"]).read_bytes()
    assert hashlib.sha256(receipt_raw).hexdigest() == state["lastReceiptSha256"]
    receipt = json.loads(receipt_raw)
    actors = []
    for pid, start in ACTORS:
        stat = Path("/proc", str(pid), "stat")
        actor = {"pid": pid, "expectedStartTicks": start, "state": "ABSENT"}
        if stat.exists():
            fields = stat.read_text().rsplit(")", 1)[1].split()
            actor.update(
                state=fields[0],
                startTicks=int(fields[19]),
                matches=int(fields[19]) == start,
            )
        actors.append(actor)
    live = all(actor.get("matches") and actor["state"] not in ["Z", "X", "x"] for actor in actors)
    return {
        "at": datetime.now(timezone.utc).isoformat(),
        "classification": "VERIFIED_WAIT" if live else "RECONCILE_SAME_RUN",
        "manifestSha256": manifest_sha,
        "actors": actors,
        "epochMeasured": {
            "attempted": len(rows),
            "correct": counts["completed_correct"],
            "failed": counts["failed"],
            "incorrect": counts["completed_incorrect"],
            "timeouts": sum(row.get("timeout") is True for row in rows),
            "planned": 450,
        },
        "conditionCountsOnly": {
            "attempted": 450 + len(rows),
            "correct": 449 + counts["completed_correct"],
            "failed": 1 + counts["failed"],
            "incorrect": counts["completed_incorrect"],
            "unattempted": 450 - len(rows),
            "planned": 900,
        },
        "copier": {
            "receipt": state["lastReceipt"],
            "sha256": state["lastReceiptSha256"],
            "cases": len(state["completedCases"]),
            "WAV": sum(bool(item.get("audio")) for item in state["completedCases"].values()),
            "errors": receipt["errors"],
            "freeBytes": receipt["diskAfter"]["free"],
        },
        "terminalSummaryPresent": (CELL / "campaign/summary.json").exists(),
        "observationOnly": True,
        "newSutCalls": 0,
        "processSignals": 0,
        "measurementInputsNotModifiedByThisObserver": True,
    }


if __name__ == "__main__":
    print(json.dumps(observe()), flush=True)

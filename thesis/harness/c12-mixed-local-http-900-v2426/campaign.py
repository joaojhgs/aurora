"""Fixed C12 populations and case failure policy; importing runs no I/O."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from datetime import datetime, timezone

WARMUP_PAIRS = 1
MEASURED_PAIRS = 900
TOTAL_PAIRS = WARMUP_PAIRS + MEASURED_PAIRS
QUALITY_FAILURES = frozenset(
    {
        "transcript_predicate_failed",
        "assistant_reply_predicate_failed",
        "no_speakable_assistant_answer",
    }
)


def phase(ordinal):
    if not 1 <= ordinal <= TOTAL_PAIRS:
        raise ValueError("ordinal_outside_frozen_population")
    return ("warmup", ordinal) if ordinal <= WARMUP_PAIRS else ("measured", ordinal - WARMUP_PAIRS)


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for b in iter(lambda: stream.read(1048576), b""):
            h.update(b)
    return h.hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def write_once(path, value):
    with Path(path).open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def atomic(path, value):
    path = Path(path)
    tmp = path.with_name(path.name + ".new")
    with tmp.open("w") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


def acceptable(row, phase_name):
    if row["status"] == "completed_correct":
        return True
    return (
        phase_name == "measured"
        and row["status"] == "failed"
        and not row.get("ambiguous_operation_may_remain")
        and not row.get("timeout", False)
        and row.get("failure", {}).get("category") in QUALITY_FAILURES
    )


def population(rows, phase_name):
    selected = [x for x in rows if x["phase"] == phase_name]
    return {
        "planned": WARMUP_PAIRS if phase_name == "warmup" else MEASURED_PAIRS,
        "offered": len(selected),
        "attempted": len(selected),
        "correct": sum(x["status"] == "completed_correct" for x in selected),
        "failed": sum(x["status"] != "completed_correct" for x in selected),
        "incorrectIncludedInFailed": sum(
            x.get("failure", {}).get("category") in QUALITY_FAILURES for x in selected
        ),
        "harnessErrorsIncludedInFailed": sum(x["status"] == "harness_error" for x in selected),
        "timeouts": sum(bool(x.get("timeout")) for x in selected),
        "unstarted": (WARMUP_PAIRS if phase_name == "warmup" else MEASURED_PAIRS) - len(selected),
    }

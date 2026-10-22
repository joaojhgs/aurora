"""Finite first15-correct/at-most30 policy; only distinct structured preaccept failures may continue."""
from pathlib import Path
from typing import Any
import hashlib,json,re
def _sha(raw):return hashlib.sha256(raw).hexdigest()
def _read(path,cap):
 if path.is_symlink()or not path.is_file()or path.stat().st_size>cap:raise ValueError('warmup_input_missing_symlinked_or_oversized')
 return path.read_bytes()

WARMUP_POLICY = {
    "qualification": "first_15_completed_correct_full_audio_flows",
    "target_correct": 15,
    "maximum_distinct_attempts": 30,
    "maximum_consecutive_preaccept_rejections": 3,
    "continuable_failure": "remote_mesh_preaccept_capability_changed",
    "failed_attempt_retry": False,
    "measured_attempts": 900,
    "measured_retry": False,
    "all_warmup_attempts_and_failures_retained": True,
}


def known_preaccept_failure(row: dict[str, Any]) -> bool:
    """Recognize an explicit non-executed rejection, never a quality failure."""
    failure = row.get("failure", {})
    stage = failure.get("stage")
    response = row.get("stages", {}).get(stage, {}).get("preaccept_response", {})
    return bool(
        row.get("status") == "failed"
        and failure.get("code") == "remote_mesh_preaccept_capability_changed"
        and stage == "tts"
        and row.get("timeout") is not True
        and row.get("partial_quality_incorrect") is not True
        and response.get("accepted") is False
        and response.get("reason_code") == "capability_changed"
        and response.get("correlation_id") == row.get("correlation", {}).get("correlation_id")
    )


def qualified_warmup_records(attempts_dir: Path, *, require_complete: bool = True) -> dict[str, Any]:
    """Select the prefrozen first 15 successes and retain every failed attempt.

    Physical ordinals, case IDs, correlations and source bytes are never changed.
    The only continuable failure is a structured preaccept rejection. The next
    iteration is a distinct request; no failed request is resubmitted.
    """
    records: list[dict[str, Any]] = []
    selected: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    consecutive = 0
    for path in sorted(attempts_dir.glob("attempt-*-warmup.jsonl")):
        match = re.fullmatch(r"attempt-([0-9]{4})-warmup\.jsonl", path.name)
        if match is None:
            raise ValueError("warmup_filename_invalid")
        raw = _read(path, 2 * 1024 * 1024)
        row = json.loads(raw)
        ordinal = int(match.group(1))
        if (ordinal != len(records) + 1 or row.get("ordinal") != ordinal
                or row.get("phase_index") != ordinal or row.get("phase") != "warmup"
                or row.get("harness_case_id") != f"audio-campaign-v2142-{ordinal:04d}"
                or len(records) >= 30 or len(selected) >= 15):
            raise ValueError("warmup_order_or_frozen_budget_invalid")
        item = {"ordinal": ordinal, "path": path, "row": row, "sha256": _sha(raw)}
        records.append(item)
        if row.get("status") == "completed_correct":
            if (row.get("correctness", {}).get("all_expected") is not True
                    or any(row.get("stages", {}).get(stage, {}).get("status") != "completed"
                           for stage in ("stt", "assistant", "tts"))
                    or not isinstance(row.get("output_audio"), dict)):
                raise ValueError("warmup_correctness_or_audio_missing")
            selected.append(item)
            consecutive = 0
        elif known_preaccept_failure(row):
            rejected.append(item)
            consecutive += 1
            if consecutive >= 3:
                raise ValueError("three_consecutive_preaccept_capability_rejections")
        else:
            raise ValueError("non_preaccept_warmup_failure_preserved_hard_stop")
    if require_complete and len(selected) != 15:
        raise ValueError("fifteen_correct_remote_audio_flows_required")
    return {"all": records, "selected": selected, "rejected": rejected,
            "attempted": len(records), "correct": len(selected), "failed": len(rejected),
            "qualified_ordinals": [item["ordinal"] for item in selected]}


def warmup_qualification_receipt(selection: dict[str, Any]) -> dict[str, Any]:
    return {"policy": WARMUP_POLICY,
            "attempted_excluded": selection["attempted"],
            "completed_correct_excluded": selection["correct"],
            "failed_preaccept_excluded": selection["failed"],
            "qualified_ordinals": selection["qualified_ordinals"],
            "failed_ordinals": [item["ordinal"] for item in selection["rejected"]],
            "all_raw_case_sha256": {item["path"].name: item["sha256"] for item in selection["all"]}}


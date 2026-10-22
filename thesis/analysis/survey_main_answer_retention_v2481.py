"""Survey saved Main answer fields without reclassifying or running requests."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys


ROOT = Path("/home/developer/projects/aurora")
CAMPAIGN = ROOT / "thesis/campaigns/c12-mixed-local-http-remaining640-v2453"
CORE = ROOT / "thesis/results/worker-desktop-closed-core-v2463-final/inventory.json"
ANSWER_FIELDS = {
    "response", "response_text", "reply", "text", "answer", "content",
    "assistant_reply", "response_content",
}


def survey(output: Path) -> dict:
    output = output.resolve()
    assert output.is_relative_to(ROOT / "thesis/results") and not output.exists()
    inputs = hashlib.sha256()
    input_files = 0

    def load(path: Path) -> dict:
        nonlocal input_files
        raw = path.read_bytes()
        identity = {
            "path": str(path.relative_to(ROOT)),
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        }
        inputs.update((json.dumps(identity, sort_keys=True) + "\n").encode())
        input_files += 1
        return json.loads(raw)

    release = load(CAMPAIGN / "RESOURCE-RELEASE.json")
    assert release["pairedCapsules"] == 304
    assert release["currentEpochMeasuredCorrectPerStream"] == 289
    assert release["conditionMeasuredTargetComplete"] is False
    counts = {"HTTP": Counter(), "local": Counter()}
    fields = {"HTTP": Counter(), "local": Counter()}
    for ordinal in range(1, 305):
        primary = load(CAMPAIGN / "requester/cases" / f"{ordinal:04d}" / "CASE.json")
        custody = load(CAMPAIGN / "provider-custody" / f"{ordinal:04d}" / "CUSTODY.json")
        local = custody["receipt"]["localCase"]
        for name, row in (("HTTP", primary), ("local", local)):
            assert row["ordinal"] == ordinal
            assistant = row["case"]["stages"]["assistant"]
            counts[name]["caseRows"] += 1
            counts[name][row["phase"] + "Rows"] += 1
            counts[name]["originalStrictCorrectRows"] += row["status"] == "completed_correct"
            counts[name]["answerSha256Present"] += "response_sha256" in assistant
            counts[name]["plaintextAnswerFieldPresent"] += any(
                isinstance(assistant.get(key), str) and bool(assistant[key])
                for key in ANSWER_FIELDS
            )
            fields[name].update(assistant.keys())
    core = load(CORE)
    historical = []
    for condition in core["conditions"]:
        report = load(ROOT / condition["source"])
        historical.append({
            "condition": condition["condition"],
            "attemptedAuthorReported": condition["measuredAttempted"],
            "correctFullAudioAuthorReported": condition["correctFullAudio"],
            "failedAuthorReported": condition["failedIncludingQualityAndTransport"],
            "source": condition["source"],
            "failureCodesAuthorReported": report.get("failureCodes", report.get("failureKinds")),
            "plaintextAnswerCoverage": "NOT_SURVEYED: closure summaries are not raw replies",
            "newPredicateScoresComputed": False,
        })
    value = {
        "at": datetime.now(timezone.utc).isoformat(),
        "status": "RETENTION_SURVEY_ONLY_NO_NEW_SEMANTIC_OR_LIFECYCLE_SCORES",
        "scope": "Current C12 epoch case headers plus six closed Main condition summaries only",
        "method": "Read304 requester CASE.json and304 provider CUSTODY.json headers; inspect named string fields of case.stages.assistant; no archive extraction or backend-log search",
        "source": str(Path(__file__).resolve().relative_to(ROOT)),
        "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "pythonVersion": sys.version,
        "orderedInputIdentityMethod": "SHA256 of newline-delimited sort_keys JSON objects with path,bytes,sha256 in source loop order",
        "orderedInputIdentitySha256": inputs.hexdigest(),
        "inputFiles": input_files,
        "answerFieldNamesChecked": sorted(ANSWER_FIELDS),
        "currentEpoch": {name: dict(count) for name, count in counts.items()},
        "currentEpochAssistantFieldNames": {name: sorted(count) for name, count in fields.items()},
        "currentConditionRetainedCorrectPerStream": 549,
        "currentConditionUnstartedPerStream": 351,
        "historicalAuthorReportedClosureSummaries": historical,
        "scoringMethodology": "Pending exact authoritative original-monitor owner-amendment receipt; phone relay msg_c32f412538a3 alone is not used to rewrite Main scores",
        "limitations": [
            "Missing plaintext in selected headers is not proof that all copies or backend logs lack it.",
            "Hashes and lengths do not reconstruct arbitrary historical answers; no dictionary guessing.",
            "Original strict correctness and verified complete audio remain original evidence, not recomputed semantic scores.",
            "An answer predicate cannot create an uninvoked TTS stage, WAV, lifecycle completion or measurement.",
            "No old label, denominator, request ID, percentile, manifest or frozen source is changed.",
        ],
        "newInference": 0,
        "newApplicationNetworkRequests": 0,
    }
    report = "\n".join([
        "# Main saved-answer retention survey", "",
        "This is a field-coverage survey, not a new correctness analysis or experiment.", "",
        "The current epoch has304 saved case headers per stream (289 measured plus15 excluded warmups). All608 retain an assistant answer hash; none of the inspected assistant headers retain a plaintext answer field.", "",
        "That limited finding does not establish all-copy loss. Exact semantic rescoring needs an authoritative predicate and recoverable actual answers. Hashes alone cannot recreate them. Original strict-correct labels, verified stage/audio evidence and the549/900 retained condition counts remain unchanged.", "",
        "The six historical Main closure summaries are indexed with their existing reported outcomes. Their raw answer coverage is not inferred from summary metadata. Previously skipped TTS or missing audio cannot become a completed full-audio request merely because an answer contains a city name.", "",
        "Reproduce with the existing Python3.11 environment and this script's --output option pointing to a new directory under thesis/results. No model, service, archive extraction, network test or old request replay occurs. SUMMARY.json records source and ordered input hashes.", "",
    ])
    payloads = {"SUMMARY.json": (json.dumps(value, indent=2, sort_keys=True) + "\n").encode(), "REPORT.md": report.encode()}
    assert sum(map(len, payloads.values())) <= 65536
    assert shutil.disk_usage(ROOT).free > 2 * 1024**3 + 1024**2 + 2 * sum(map(len, payloads.values()))
    output.mkdir()
    for name, data in payloads.items():
        temporary = output / ("." + name + ".partial")
        with temporary.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        destination = output / name
        os.replace(temporary, destination)
        assert destination.read_bytes() == data
    return {"output": str(output.relative_to(ROOT)), "inputFiles": input_files, "currentEpoch": value["currentEpoch"], "newScores": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(survey(args.output), indent=2))

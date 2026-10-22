"""Finalize the existing V2296 epoch once after retirement; never start inference."""

import argparse
import base64
import collections
import fcntl
import hashlib
import json
import os
import runpy
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
H = ROOT / ".git/aurora-handoff-import-20261006"
OP = H / "distributed-k1-orca-relayed-http-launch-v2296"
CELL = H / "distributed-k1-orca-relayed-http-cell-v2296"
DATA = ROOT / "thesis/campaigns/worker-desktop-k1-orca-relayed-http-remaining450-v2296"
OUTPUT = DATA / "terminal-v2300"
SHA = "9adbf9ba3a7ec0948a087edad3655cf94ee344b3a2371a78d15f188f44150d42"
PYTHON = H / "cpu-audio-campaign-v491/env/bin/python"
ACTORS = [(3965950, 139740362), (3965978, 139740616), (3965951, 139740363)]


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def retirement():
    result = []
    for pid, ticks in ACTORS:
        path = Path("/proc", str(pid), "stat")
        if path.exists():
            fields = path.read_text().rsplit(")", 1)[1].split()
            result.append(
                {
                    "pid": pid,
                    "startTicks": int(fields[19]),
                    "state": fields[0],
                    "matches": int(fields[19]) == ticks,
                }
            )
        else:
            result.append({"pid": pid, "expectedStartTicks": ticks, "state": "ABSENT"})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--preflight", action="store_true", help="Read-only admission check; no files or RPCs"
    )
    args = parser.parse_args()
    assert digest((OP / "condition-frozen-v2296.json").read_bytes()) == SHA
    actors = retirement()
    retired = all(item["state"] == "ABSENT" for item in actors)
    terminal_present = (CELL / "campaign/summary.json").is_file()
    if args.preflight:
        print(
            json.dumps(
                {
                    "status": "ADMISSION_READY"
                    if retired and terminal_present
                    else "WAIT_FOR_SAME_REQUESTER_NATURAL_RETIREMENT",
                    "actors": actors,
                    "terminalSummaryPresent": terminal_present,
                    "newInference": 0,
                    "newRPC": 0,
                    "newFiles": 0,
                }
            )
        )
        return
    assert retired and terminal_present, (
        "Current measured requester/copier still live; no finalization started"
    )
    assert not OUTPUT.exists(), (
        "Reconcile the existing finalization and accepted operation; never duplicate it"
    )
    with (
        Path("/tmp/aurora-global-build.lock").open("a") as lock,
        (DATA / "copier.lock").open("a") as copier_lock,
    ):
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(copier_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        control = json.loads((CELL / "control-launch.json").read_bytes())
        summary = json.loads((CELL / "campaign/summary.json").read_bytes())
        assert control.get("finished_at") and control.get("child_present_after_wait") is False
        assert control["child_pid"] == 3965978 and summary["shutdown_completed"] is True
        helper = runpy.run_path(str(ROOT / "thesis/harness/custody_k1_http_requester_v2296.py"))
        helper["checkpoint"](SHA)
        state_raw = (DATA / "CURRENT.json").read_bytes()
        state = json.loads(state_raw)
        checkpoint_raw = (ROOT / state["lastReceipt"]).read_bytes()
        assert digest(checkpoint_raw) == state["lastReceiptSha256"]
        checkpoint = json.loads(checkpoint_raw)
        assert not checkpoint["errors"]
        prefix_eof = []
        for name in ["voice-stages.jsonl", "actual-provider-bindings.jsonl", "resources.jsonl"]:
            source = CELL / name
            assert state["prefixes"][name]["endByte"] == source.stat().st_size
            prefix_eof.append(
                {"name": name, "bytes": source.stat().st_size, "sourceEOFVerified": True}
            )
        records = []
        for item in state["files"].values():
            path = ROOT / item["destination"]
            raw = path.read_bytes()
            assert len(raw) == item["bytes"] and digest(raw) == item["sha256"]
            records.append(
                {"path": item["destination"], "bytes": len(raw), "sha256": item["sha256"]}
            )
        cases = []
        for item in state["completedCases"].values():
            raw = (ROOT / item["case"]).read_bytes()
            assert digest(raw) == item["caseSha256"]
            row = json.loads(raw)
            cases.append(row)
            if row["status"] == "completed_correct":
                assert row["correctness"]["all_expected"] is True and item["audio"]
            if item.get("audio"):
                assert digest((ROOT / item["audio"]).read_bytes()) == item["audioSha256"]
        measured = sorted(
            (x for x in cases if x["phase"] == "measured"), key=lambda x: x["phase_index"]
        )
        warmups = [x for x in cases if x["phase"] == "warmup"]
        assert (
            len(measured) == summary["measured_requests"]
            and len(warmups) == summary["warmup_requests"]
        )
        assert [x["condition_measured_index"] for x in measured] == list(
            range(451, 451 + len(measured))
        )
        assert len({x["harness_case_id"] for x in cases}) == len(cases)
        correct = sum(x["status"] == "completed_correct" for x in measured)
        failed = sum(x["status"] == "failed" for x in measured)
        incorrect = sum(x["status"] == "completed_incorrect" for x in measured)
        assert correct + failed + incorrect == len(measured)
        receipt = {
            "at": now(),
            "status": "REQUESTER_TERMINAL_AND_PHYSICAL_CUSTODY_SEALED",
            "manifestSha256": SHA,
            "requesterActorsAbsent": True,
            "requesterActors": actors,
            "epochMeasured": {
                "attempted": len(measured),
                "correct": correct,
                "failed": failed,
                "incorrect": incorrect,
                "timeouts": sum(x.get("timeout") is True for x in measured),
                "planned": 450,
                "unattempted": 450 - len(measured),
            },
            "conditionCountsOnly": {
                "attempted": 450 + len(measured),
                "correct": 449 + correct,
                "failed": 1 + failed,
                "incorrect": incorrect,
                "unattempted": 450 - len(measured),
                "target": 900,
            },
            "failureCodes": dict(
                collections.Counter(
                    (x.get("failure") or {}).get("code")
                    for x in measured
                    if x["status"] == "failed"
                )
            ),
            "excludedWarmups": len(warmups),
            "caseRecords": len(cases),
            "actualWAV": sum(bool(x.get("audio")) for x in state["completedCases"].values()),
            "verifiedFiles": len(records),
            "verifiedBytes": sum(x["bytes"] for x in records),
            "snapshotSha256": digest(state_raw),
            "sourceCheckpointSha256": state["lastReceiptSha256"],
            "requesterNativeResourcePrefixEOF": prefix_eof,
            "controllerExitCode": control["exit_code"],
            "terminalStatus": summary["status"],
            "terminalStopReason": summary.get("stop_reason"),
            "newInference": 0,
            "nativeGoalMutations": 0,
            "noLatencyPooling": True,
        }
        OUTPUT.mkdir()
        (OUTPUT / "REQUESTER-CURRENT.snapshot.json").write_bytes(state_raw)
        write(OUTPUT / "REQUESTER-SEAL.json", receipt)
        write(OUTPUT / "FILES.json", records)
        journal = {
            "at": now(),
            "phase": "REQUESTER_SEALED",
            "receipt": receipt,
            "onFailure": "Reconcile this exact accepted command/output and preserve all partial files; no blind retry",
        }

        def phase(name, **fields):
            nonlocal journal
            journal = {**journal, "at": now(), "phase": name, **fields}
            tmp = OUTPUT / "PHASE.json.partial"
            with tmp.open("x") as stream:
                json.dump(journal, stream, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, OUTPUT / "PHASE.json")

        try:
            source = ROOT / "thesis/harness/provider_export_k1_http_prefix_v2301.py"
            code = (
                'import base64,json\nnamespace={"__name__":"aurora_postterminal_export"}\n'
                "exec(compile(base64.b64decode("
                + repr(base64.b64encode(source.read_bytes()).decode())
                + '),"<frozen-postterminal-provider-export>","exec"),namespace)\n'
                'v=namespace["capture"](' + repr(receipt) + ")\n"
                'raw=base64.b64encode(json.dumps(v,separators=(",",":")).encode()).decode()\n'
                "parts=[raw[i:i+800]for i in range(0,len(raw),800)]\n"
                'for i,x in enumerate(parts):print("AURORA_K1_HTTP_PROVIDER_PREFIX_V2301 "+json.dumps({"seq":i,"total":len(parts),"data":x}),flush=True)\n'
            )
            command = OUTPUT / "provider-capture.command.txt"
            with command.open("x") as stream:
                stream.write("python3 -c " + shlex.quote(code) + "\n")
            phase(
                "REMOTE_EXPORT_SEND_INTENT",
                operation="k1-http-provider-prefix-v2301",
                maximumSends=1,
                exportSourceSha256=digest(source.read_bytes()),
            )
            with (OUTPUT / "provider-capture.private.log").open("xb") as log:
                result = subprocess.run(
                    [
                        str(PYTHON),
                        str(ROOT / "thesis/harness/orca_copy_control_raw_read_v1652.py"),
                        "k1-http-provider-prefix-v2301",
                        str(command),
                        "AURORA_K1_HTTP_PROVIDER_PREFIX_V2301",
                    ],
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    timeout=175,
                )
            assert result.returncode == 0, "Reconcile same accepted export request; never resend it"
            meta = json.loads((H / "k1-http-provider-prefix-v2301-RESULT.json").read_bytes())
            assert (
                meta["epochMeasuredAttempted"] == len(measured)
                and meta["epochManifestSha256"] == SHA
            )
            write(OUTPUT / "PROVIDER-EXPORT-RECEIPT.json", meta)
            phase("PROVIDER_ARCHIVE_CAPTURED_TRANSFER_STARTING", export=meta)
            with (OUTPUT / "provider-transfer.private.log").open("xb") as log:
                result = subprocess.run(
                    [
                        str(PYTHON),
                        str(ROOT / "thesis/harness/transfer_k1_http_provider_prefix_v2302.py"),
                    ],
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    timeout=660,
                )
            assert result.returncode == 0, (
                "Reconcile saved transfer pages; never rerun this pipeline"
            )
            transfer = DATA / "provider-prefix-transfer-v2302"
            custody = json.loads((transfer / "CUSTODY.json").read_bytes())
            assert custody["status"] == "complete_verified_provider_prefix_archive"
            phase(
                "PROVIDER_RAW_PHYSICALLY_VERIFIED_ANALYSIS_STARTING",
                custody=str((transfer / "CUSTODY.json").relative_to(ROOT)),
            )
            with (OUTPUT / "analysis.private.log").open("xb") as log:
                result = subprocess.run(
                    [
                        str(PYTHON),
                        str(ROOT / "thesis/analysis/analyze_k1_http_epoch_saved_v2242.py"),
                        "--requester-custody",
                        str(DATA),
                        "--requester-snapshot",
                        str(OUTPUT / "REQUESTER-CURRENT.snapshot.json"),
                        "--requester-pid",
                        "3965978",
                        "--requester-start-ticks",
                        "139740616",
                        "--manifest-sha256",
                        SHA,
                        "--provider-dir",
                        str(transfer / "extracted/raw"),
                        "--output-dir",
                        str(DATA / "analysis-v2303"),
                    ],
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    timeout=180,
                )
            assert result.returncode == 0, "Preserve saved inputs/errors; no inference rerun"
            analysis = json.loads((DATA / "analysis-v2303/SUMMARY.json").read_bytes())
            assert analysis["measured"]["attempted"] == len(measured)
            phase(
                "POSTTERMINAL_SAVED_ANALYSIS_WRITTEN",
                analysis=str((DATA / "analysis-v2303/SUMMARY.json").relative_to(ROOT)),
                positiveNativeGaps=analysis["positiveFlowNativeGaps"],
                sourceAndAllFailuresPreserved=True,
                nativeGoalUnchanged=True,
                remainingFullGoalAndMatrixOpen=True,
            )
            print(
                json.dumps(
                    {
                        "status": journal["phase"],
                        "epochMeasured": receipt["epochMeasured"],
                        "conditionCountsOnly": receipt["conditionCountsOnly"],
                        "positiveNativeGaps": analysis["positiveFlowNativeGaps"],
                        "newInference": 0,
                    }
                )
            )
        except BaseException as error:
            phase("INCOMPLETE_RECONCILE_SAME_ACCEPTED_OPERATION", errorClass=type(error).__name__)
            raise


if __name__ == "__main__":
    os.umask(0o077)
    main()

"""Copy only a future admitted K1 cohort; never call the system under test."""

import argparse
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import time
from datetime import datetime, timezone
import wave
import runpy


ROOT = Path(__file__).resolve().parents[2]
IMPORT = ROOT / ".git/aurora-handoff-import-20261006"
CELL = IMPORT / "distributed-k1-mesh-cell-v2143"
OP = IMPORT / "distributed-k1-mesh-launch-v2143"
STAGE = IMPORT / "distributed-k1-mesh-requester-v2143"
DEST = ROOT / "thesis/campaigns/worker-desktop-k1-p2p-tts-remaining191-v2143"
RESERVE = 2 * 1024**3
CHUNK_CAP = 4 * 1024**2


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(ROOT).free - len(data) < RESERVE:
        raise RuntimeError("copy would cross reserved 2GiB free-space floor")
    temp = path.with_name(path.name + ".partial-" + str(os.getpid()))
    with temp.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    if digest(temp.read_bytes()) != digest(data):
        raise RuntimeError("destination checksum mismatch")
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def private_values():
    values = []
    def gather(value):
        if isinstance(value, str) and len(value) >= 8:
            values.append(value.encode())
        elif isinstance(value, dict):
            for item in value.values():gather(item)
        elif isinstance(value, list):
            for item in value:gather(item)
    def walk(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if re.search(r"secret|password|api.?keys?|access_token|refresh_token|^room$|^app_id$|turn_username", key, re.I):gather(item)
                else:walk(item)
        elif isinstance(value, list):
            for item in value:walk(item)
    walk(json.loads((OP / "runtime-config.json").read_bytes()))
    return values


def checkpoint(expected_condition_sha256):
    condition_path = OP / "condition-frozen-v2143.json"
    if not re.fullmatch(r"[0-9a-f]{64}", expected_condition_sha256):
        raise ValueError("Root must provide the actual newly frozen K1 manifest SHA256")
    if digest(condition_path.read_bytes()) != expected_condition_sha256:
        raise RuntimeError("K1 condition manifest differs; no data copied")
    started = now()
    before = shutil.disk_usage(ROOT)._asdict()
    state_path = DEST / "CURRENT.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {
        "schema": "aurora.physical-custody.v1", "files": {}, "prefixes": {},
        "completedCases": {}, "sequence": 0,
    }
    secrets = private_values()
    additions = []
    errors = []
    pending_static = []

    def retain(source, relative, data=None, **metadata):
        key = str(relative)
        if key in state["files"]:
            return state["files"][key]
        if data is None:
            with source.open("rb") as stream:
                old = os.fstat(stream.fileno())
                data = stream.read()
                new = os.fstat(stream.fileno())
            if (old.st_ino, old.st_size, old.st_mtime_ns) != (
                new.st_ino, new.st_size, new.st_mtime_ns
            ):
                raise RuntimeError("immutable source changed while copied")
        if any(secret in data for secret in secrets):
            raise RuntimeError("private value detected; file withheld")
        target = DEST / relative
        if target.exists():
            if target.is_symlink() or digest(target.read_bytes()) != digest(data):
                raise RuntimeError("existing destination differs")
        else:
            atomic(target, data)
        record = {"source": str(source), "destination": str(target.relative_to(ROOT)),
                  "bytes": len(data), "sha256": digest(data), "copiedAt": now(), **metadata}
        state["files"][key] = record
        additions.append(record)
        return record

    static = [(OP / "condition-frozen-v2143.json", "frozen/condition.json"),
              (OP / "warmup-finalizer-result.json", "admission/warmup-finalizer-result.json"),
              (CELL / "campaign/receiver-warmup-proof.json", "admission/receiver-warmup-proof.json")]
    for name in ["candidate-input.wav", "candidate-manifest.json", "source-inventory.json",
                 "controller.py", "runner.py", "bootstrap.py", "bindings.py", "observer.py",
                 "resource_sample.py", "aurora_voice_telemetry_v430.py", "tts_mesh_adapter.py", "mesh_route_observer.py", "route_observation_sink.py", "route_runtime_pins.json",
                 "receiver_proof.py", "warmup_policy.py"]:
        static.append((STAGE / name, "harness/" + name))
    for source in sorted((OP / "receiver-warmup-custody").glob("*.json*")):
        static.append((source, "provider-warmups/" + source.name))
    for name in ["requester-launch.json", "operator-launch.json", "requesterCopier-launch.json",
                 "warmupFinalizer-launch.json", "LAUNCH-INTENT.json", "proof-collection-request.json"]:
        static.append((OP / name, "operator/" + name))
    for name in ["runtime-versions.json", "voice-stages.installed.json", "voice-stages.status.json", "requester-mesh-route-runtime-pins.json"]:
        static.append((CELL / name, "runtime/" + name))
    for source, relative in static:
        if not source.exists():
            pending_static.append(str(source))
            continue
        try:
            retain(source, relative)
        except Exception as exc:
            errors.append({"source": str(source), "error": str(exc)})

    for source in sorted((CELL / "campaign/attempts").glob("*.jsonl")):
        if source.name in state["completedCases"]:
            continue
        try:
            with source.open("rb") as stream:
                before_case = os.fstat(stream.fileno())
                raw = stream.read()
                after_case = os.fstat(stream.fileno())
            if (before_case.st_size, before_case.st_mtime_ns) != (after_case.st_size, after_case.st_mtime_ns):
                raise RuntimeError("case writer still active; defer until next checkpoint")
            rows = [json.loads(line) for line in raw.splitlines() if line]
            if len(rows) != 1 or not raw.endswith(b"\n"):
                raise RuntimeError("case is not one complete newline-terminated row")
            row = rows[0]
            audio = row.get("output_audio") or {}
            audio_receipt = None
            if audio.get("file"):
                relative = Path(audio["file"])
                if relative.is_absolute() or ".." in relative.parts:
                    raise RuntimeError("unexpected audio reference")
                wav = (CELL / "campaign" / relative).read_bytes()
                if digest(wav) != audio["sha256"]:
                    raise RuntimeError("case audio checksum mismatch")
                with wave.open(io.BytesIO(wav), "rb") as stream:
                    audio_info = {"channels": stream.getnchannels(), "sampleWidth": stream.getsampwidth(),
                                  "sampleRate": stream.getframerate(), "frames": stream.getnframes()}
                    if not audio_info["frames"]:
                        raise RuntimeError("empty WAV")
                audio_receipt = retain(CELL / "campaign" / relative, str(relative), wav,
                                       wav=audio_info)
            case = retain(source, "attempts/" + source.name, raw)
            state["completedCases"][source.name] = {
                "phase": row["phase"], "status": row["status"], "case": case["destination"],
                "caseSha256": case["sha256"],
                "audio": audio_receipt["destination"] if audio_receipt else None,
                "audioSha256": audio_receipt["sha256"] if audio_receipt else None,
            }
        except Exception as exc:
            errors.append({"source": str(source), "error": str(exc)})

    # These files are atomically rewritten. Retain each changed stable version,
    # rather than treating the first launch/progress snapshot as final.
    for source, name in [(CELL / "control-launch.json", "control-launch.json"),
                         (CELL / "campaign/summary.json", "summary.json"),
                         (CELL / "campaign/progress.json", "progress.json"),
                         (CELL / "campaign/mesh-route-admission.json", "mesh-route-admission.json"),
                         (CELL / "requester-mesh-route-sink-status.json", "mesh-route-sink-status.json")]:
        if not source.exists():
            continue
        try:
            with source.open("rb") as stream:
                before_snapshot = os.fstat(stream.fileno())
                raw = stream.read()
                after_snapshot = os.fstat(stream.fileno())
            if (before_snapshot.st_size, before_snapshot.st_mtime_ns) != (after_snapshot.st_size, after_snapshot.st_mtime_ns):
                raise RuntimeError("snapshot still being written; defer")
            json.loads(raw)
            checksum = digest(raw)
            snapshots = state.setdefault("snapshots", {})
            if snapshots.get(name, {}).get("sha256") != checksum:
                record = retain(source, f"snapshots/{name}/{checksum}.json", raw)
                snapshots[name] = {"sha256": checksum, "destination": record["destination"], "observedAt": now()}
        except Exception as exc:
            errors.append({"source": str(source), "error": str(exc)})

    # Immutable contiguous chunks retain the raw prefix without quadratic full-log copies.
    sources = [(name, CELL / name) for name in ["voice-stages.jsonl", "actual-provider-bindings.jsonl", "resources.jsonl", "requester-mesh-calls.jsonl", "requester-mesh-route-observations.jsonl"]]
    sources.extend((name, source) for name, source in [
        ("backend.private.log", CELL / "backend.private.log"),
        ("controller.private.log", OP / "requester-controller.private.log"),
        ("requesterCopier.private.log", OP / "requesterCopier.private.log"),
        ("warmupFinalizer.private.log", OP / "warmupFinalizer.private.log"),
        ("proof-collection.private.log", OP / "proof-collection.private.log"),
    ] if source.exists())
    for name, source in sources:
        if (not source.exists()
                and not state["prefixes"].get(name, {}).get("endByte", 0)):
            pending_static.append(str(source))  # Not generated yet; native admission still requires real bindings.
            continue
        try:
            prefix = state["prefixes"].setdefault(name, {"endByte": 0, "chunks": []})
            with source.open("rb") as stream:
                stat = os.fstat(stream.fileno())
                if prefix.get("inode", stat.st_ino) != stat.st_ino or stat.st_size < prefix["endByte"]:
                    raise RuntimeError("append source identity or length regressed")
                start = prefix["endByte"]
                stream.seek(start)
                data = stream.read(CHUNK_CAP)
                end = data.rfind(b"\n") + 1
                data = data[:end]
                if data:
                    raw_checksum = digest(data)
                    removed = 0
                    if name.endswith(".log"):
                        for secret in secrets:
                            removed += data.count(secret)
                            data = data.replace(secret, b"[REDACTED_CREDENTIAL]")
                    record = retain(source, f"prefixes/{name}/{start:012d}-{start + end:012d}.chunk",
                                    data, startByte=start, endByte=start + end, incomplete=True,
                                    sourceObservedBytes=stat.st_size, sourceInode=stat.st_ino,
                                    sourceRawSha256=raw_checksum, credentialsRedacted=removed)
                    prefix["chunks"].append(record["destination"])
                    prefix["endByte"] += end
                prefix.update({"inode": stat.st_ino, "sourceObservedBytes": stat.st_size,
                               "observedAt": now(), "incomplete": True})
        except Exception as exc:
            errors.append({"source": str(source), "error": str(exc)})

    progress_path = CELL / "campaign/progress.json"
    progress = json.loads(progress_path.read_text()) if progress_path.exists() else {
        "status": "awaiting_progress", "note": "Copier observation only; no request denominator inferred"}
    summary_path = CELL / "campaign/summary.json"
    if not progress_path.exists() and summary_path.exists():
        terminal = json.loads(summary_path.read_text())
        if terminal.get("status") == "failed_preflight_or_setup":
            progress = {"status": terminal["status"], "attempted": terminal["attempted"],
                        "measured_attempted": terminal["phase_denominators"]["measured"]["attempted"],
                        "warmups_attempted": terminal["phase_denominators"]["warmup_excluded"]["attempted"],
                        "source": "actual terminal summary; no progress file was produced"}

    control_path = CELL / "control-launch.json"
    if not progress_path.exists() and control_path.exists():
        control = json.loads(control_path.read_bytes())
        if control.get("finished_at") and control.get("child_present_after_wait") is False:
            progress = {"status": "controller_terminal_without_progress", "source": "actual control-launch.json",
                        "exitCode": control.get("exit_code"), "noSampleDenominatorInferred": True}

    state["sequence"] += 1
    receipt = {"schema": "aurora.physical-custody-checkpoint.v1", "sequence": state["sequence"],
               "startedAt": started, "finishedAt": now(), "diskBefore": before,
               "diskAfter": shutil.disk_usage(ROOT)._asdict(), "reservedFreeBytes": RESERVE,
               "progressObservation": progress, "newFiles": additions, "errors": errors, "pendingStatic": pending_static,
               "retainedCases": len(state["completedCases"]),
               "retainedAudioBlobs": sum(key.startswith("audio/") for key in state["files"]),
               "physicalPayloadBytes": sum(item["bytes"] for item in state["files"].values()),
               "previousReceipt": state.get("lastReceipt"), "sutCalls": 0,
               "possibleConfound": "Concurrent custody reads/writes; keep all affected measurements.",
               "providerCoverage": "Separate P2P TTS provider custody; actual per-host prefix coverage must be joined explicitly.",
               "expectedConditionSha256": expected_condition_sha256,
               "prefixes": state["prefixes"]}
    receipt_path = DEST / f"receipts/{state['sequence']:06d}.json"
    atomic(receipt_path, encoded(receipt))
    state.update({"lastReceipt": str(receipt_path.relative_to(ROOT)), "lastReceiptSha256": digest(encoded(receipt)),
                  "updatedAt": now(), "progressObservation": progress})
    atomic(state_path, encoded(state))
    print(json.dumps({key: receipt[key] for key in ["sequence", "retainedCases", "retainedAudioBlobs",
                     "physicalPayloadBytes", "progressObservation", "errors", "diskAfter"]}), flush=True)
    return progress


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--follow", action="store_true")
    parser.add_argument("--condition-sha256", required=True)
    args = parser.parse_args()
    condition_path = OP / "condition-frozen-v2143.json"
    if not re.fullmatch(r"[0-9a-f]{64}", args.condition_sha256) or digest(condition_path.read_bytes()) != args.condition_sha256:
        raise RuntimeError("Future K1 manifest admission required before creating custody output")
    DEST.mkdir(parents=True, exist_ok=True)
    lock = (DEST / "copier.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    end = time.monotonic() + 15600
    while True:
        result = checkpoint(args.condition_sha256)
        if not args.follow or result["status"] not in {"running", "awaiting_progress"} or time.monotonic() >= end:
            if args.follow and result["status"] not in {"running", "awaiting_progress"}:
                # Allow the already-owned controller to finish its final JSON/log
                # writes, then drain once. This never signals or restarts it.
                launch = json.loads((OP / "requester-launch.json").read_text())
                grace = time.monotonic() + 60
                while time.monotonic() < grace:
                    try:
                        fields = Path("/proc", str(launch["controllerPid"]), "stat").read_text().rsplit(")", 1)[1].split()
                    except FileNotFoundError:
                        break
                    if int(fields[19]) != launch["controllerStartTicks"] or fields[0] == "Z":
                        break
                    time.sleep(1)
                checkpoint(args.condition_sha256)
            break
        time.sleep(60)

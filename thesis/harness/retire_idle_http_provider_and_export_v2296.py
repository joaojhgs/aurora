"""Gracefully retire the exact idle old SUT and preserve only its EOF delta."""

from pathlib import Path
from datetime import datetime, timezone
import hashlib
import io
import json
import os
import shutil
import signal
import socket
import tarfile
import time

ROOT = Path("/home/developer/projects/aurora")
SOURCE = ROOT / "thesis/campaigns/worker-desktop-k1-http-provider-v2220/provider"
BASE = SOURCE.parent / "provider-checkpoint-v2252"
DEST = SOURCE.parent / "terminal-v2296"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def write(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def actor(pid, ticks):
    p = Path("/proc", str(pid), "stat")
    if not p.exists():
        return {"pid": pid, "state": "absent", "sameStart": False}
    fields = p.read_text().rsplit(")", 1)[1].split()
    return {
        "pid": pid,
        "state": fields[0],
        "startTicks": int(fields[19]),
        "sameStart": int(fields[19]) == ticks,
    }


def run(allocation):
    os.umask(0o077)
    os.nice(10)
    assert socket.gethostname() == "personal.skyron-server"
    start = datetime.fromisoformat(allocation["startedAtUtc"])
    end = datetime.fromisoformat(allocation["absoluteDeadlineUtc"])
    assert (end - start).total_seconds() == 43200 and start <= datetime.now(timezone.utc) < end
    assert allocation["state"] == "CLOCK_FROZEN_BEFORE_ANY_LIFECYCLE_ACTION"
    assert (
        allocation["globalFirst"] == 451
        and allocation["globalLast"] == 900
        and allocation["newMeasured"] == 450
    )
    assert allocation["nativeGoalThread"] == "01a112a5-d6bb-74e2-bf7c-ace73cb513b5"
    assert not DEST.exists(), "Reconcile the original requested retirement; do not resend"
    assert (
        sha((SOURCE / "provider-manifest.json").read_bytes())
        == "950d449e3c337764a654ae4dd08c66623f50f96617615328be0cd8c54a4eaea2"
    )
    manifest = json.loads((SOURCE / "provider-manifest.json").read_bytes())
    assert (
        sha(Path(manifest["config"]).read_bytes())
        == "1b2e464a9dd2a191954504161862d3aa19a991126eb2b08c4de55a40778fd002"
    )
    identities = [actor(1440195, 35427348), actor(1440196, 35427408)]
    assert all(v["sameStart"] and v["state"] not in ["Z", "X", "x"] for v in identities)
    raw = (SOURCE / "voice-stages.jsonl").read_bytes()
    assert len(raw) < 32 * 1024**2 and raw.endswith(bytes([10]))
    groups = {}
    latest = 0
    for line in raw.splitlines():
        row = json.loads(line)
        if row.get("record_kind") == "invocation_span_boundary" and row.get("handler") in [
            "stt.model_invoke",
            "resolved_chat_model.astream",
            "tts.model_invoke",
        ]:
            groups.setdefault(row["span_id"], set()).add(row["event"])
            latest = max(latest, int(row["monotonic_ns"]))
    assert all(v == {"span_start", "span_end"} for v in groups.values())
    assert time.monotonic_ns() - latest > 5_000_000_000
    DEST.mkdir()
    began = time.monotonic()
    write(
        DEST / "RETIREMENT-INTENT.json",
        {
            "at": datetime.now(timezone.utc).isoformat(),
            "allocation": allocation,
            "actors": identities,
            "nativeOpenSpans": 0,
            "lastNativeIdleMs": (time.monotonic_ns() - latest) / 1e6,
            "signalTarget": {"pid": 1440196, "startTicks": 35427408, "signal": "SIGTERM"},
            "maximumSignals": 1,
            "scope": "Only exact idle Aurora SUT receiver after current270 HTTP requester terminal/custody closure; no Orca/SSH/agent/service signal",
        },
    )
    os.kill(1440196, signal.SIGTERM)
    while time.monotonic() - began < 90:
        values = [actor(1440195, 35427348), actor(1440196, 35427408)]
        if all(v["state"] == "absent" for v in values):
            break
        time.sleep(1)
    values = [actor(1440195, 35427348), actor(1440196, 35427408)]
    if any(v["state"] != "absent" for v in values):
        value = {
            "at": datetime.now(timezone.utc).isoformat(),
            "status": "SAME_RETIREMENT_PENDING_DO_NOT_RESEND",
            "actors": values,
            "signalsSent": 1,
            "newWorker": False,
            "newInference": 0,
        }
        write(DEST / "RETIREMENT-PENDING.json", value)
        return value
    terminal = json.loads((SOURCE / "terminal.json").read_bytes())
    status = json.loads((SOURCE / "STATUS.json").read_bytes())
    assert terminal["receiverAbsent"] is True and status["ownRuntimeRetired"] is True
    assert (
        sha((SOURCE / "provider-manifest.json").read_bytes())
        == "950d449e3c337764a654ae4dd08c66623f50f96617615328be0cd8c54a4eaea2"
    )
    assert sha(Path(manifest["config"]).read_bytes()) == manifest["configSha256"]
    old = json.loads((BASE / "PROVIDER-PREFIX-SEAL.json").read_bytes())
    assert (
        sha((BASE / "PROVIDER-PREFIX-SEAL.json").read_bytes())
        == "fc9c3eb627f2e02a84ed993288084b0b2f89df13e7fe943b14673d2a58b4a058"
    )
    prior = {Path(v["name"]).name: v for v in old["files"]}
    records = []
    payloads = []
    for name, record in prior.items():
        assert time.monotonic() - began < 135
        p = SOURCE / name
        st = p.stat()
        assert p.is_file() and not p.is_symlink()
        if name.endswith(".jsonl"):
            assert st.st_ino == record["sourceInode"] and st.st_size >= record["bytes"]
            prefix = hashlib.sha256()
            whole = hashlib.sha256()
            remaining = record["bytes"]
            with p.open("rb") as stream:
                while remaining:
                    block = stream.read(min(1024 * 1024, remaining))
                    assert block
                    prefix.update(block)
                    whole.update(block)
                    remaining -= len(block)
                assert prefix.hexdigest() == record["sha256"]
                tail = stream.read(64 * 1024**2 + 1)
                assert len(tail) <= 64 * 1024**2
                whole.update(tail)
            if tail:
                assert tail.endswith(bytes([10]))
                member = "delta/" + name + ".tail"
                payloads.append((member, tail))
                records.append(
                    {
                        "name": member,
                        "source": str(p),
                        "startByte": record["bytes"],
                        "endByte": st.st_size,
                        "bytes": len(tail),
                        "sha256": sha(tail),
                        "terminalEOF": True,
                        "fullSourceSha256": whole.hexdigest(),
                    }
                )
        else:
            data = p.read_bytes()
            json.loads(data)
            if sha(data) != record["sha256"]:
                member = "snapshots/" + name
                payloads.append((member, data))
                records.append(
                    {
                        "name": member,
                        "source": str(p),
                        "bytes": len(data),
                        "sha256": sha(data),
                        "terminalEOF": True,
                    }
                )
    data = (SOURCE / "terminal.json").read_bytes()
    payloads.append(("snapshots/terminal.json", data))
    records.append(
        {
            "name": "snapshots/terminal.json",
            "source": str(SOURCE / "terminal.json"),
            "bytes": len(data),
            "sha256": sha(data),
            "terminalEOF": True,
        }
    )
    assert (
        sum(len(v) for _, v in payloads) < 96 * 1024**2
        and shutil.disk_usage(ROOT).free > 2 * 1024**3 + 128 * 1024**2
    )
    seal = {
        "at": datetime.now(timezone.utc).isoformat(),
        "status": "original_provider_eof_delta_sealed",
        "actors": values,
        "providerRetired": True,
        "reservationPreserved": True,
        "rootPhysicalReservationHeldForNextCondition": True,
        "oldFixedPrefixSealSha256": "fc9c3eb627f2e02a84ed993288084b0b2f89df13e7fe943b14673d2a58b4a058",
        "oldFixedPrefixArchiveSha256": "098989357310ddc2c844cfa59045395bdc841da5de8eb15b90a52bc86bd9bcd3",
        "oldPrefixPlusDeltaReconstructsEof": True,
        "files": records,
        "rawPayloadBytes": sum(v["bytes"] for v in records),
        "originalFilesPreserved": True,
        "K1MeasuredAttempted": 450,
        "K1Correct": 449,
        "K1Failed": 1,
        "K1Remaining": 450,
        "signalsSent": 1,
        "newInference": 0,
        "newOrcaWorkers": 0,
        "oldEffectiveDeadlineUnchanged": "2026-10-21T22:45:52.468654+00:00",
    }
    encoded = (json.dumps(seal, indent=2) + "\n").encode()
    (DEST / "PROVIDER-PREFIX-SEAL.json").write_bytes(encoded)
    archive = DEST / "provider-eof-delta-v2296.tar.gz"
    with archive.open("xb") as stream:
        with tarfile.open(fileobj=stream, mode="w:gz", compresslevel=1) as tar:
            for name, data in [*payloads, ("PROVIDER-PREFIX-SEAL.json", encoded)]:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o600
                tar.addfile(info, io.BytesIO(data))
        stream.flush()
        os.fsync(stream.fileno())
    value = {k: v for k, v in seal.items() if k != "files"}
    value.update(
        host=socket.gethostname(),
        status="original_provider_eof_delta_archive",
        archive=str(archive),
        bytes=archive.stat().st_size,
        sha256=sha(archive.read_bytes()),
        sealSha256=sha(encoded),
        files=len(records),
        elapsedSeconds=time.monotonic() - began,
        controllerTerminal=terminal,
    )
    write(DEST / "EXPORT-RECEIPT.json", value)
    return value

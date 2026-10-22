"""Capture this provider only after Root seals the requester; no inference or signals."""

import hashlib
import io
import json
import os
import shutil
import socket
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/home/developer/projects/aurora")
SOURCE = ROOT / "thesis/campaigns/worker-desktop-k1-http-provider-v2220/provider"
DEST = SOURCE.parent / "provider-checkpoint-v2252"
MANIFEST_SHA = "950d449e3c337764a654ae4dd08c66623f50f96617615328be0cd8c54a4eaea2"
EPOCH_SHA = "11bbea3fc1e45e65da1ecb7b501aee77739870cb087d792e5bc5197f9b1027be"


def capture(terminal):
    os.umask(0o077)
    os.nice(10)
    assert socket.gethostname() == "personal.skyron-server"
    assert terminal["status"] == "REQUESTER_TERMINAL_AND_PHYSICAL_CUSTODY_SEALED"
    assert terminal["manifestSha256"] == EPOCH_SHA and terminal["requesterActorsAbsent"]
    attempted = terminal["epochMeasured"]["attempted"]
    assert 0 <= attempted <= 270 and terminal["conditionCountsOnly"]["attempted"] == 180 + attempted
    assert not DEST.exists(), "Reconcile the existing accepted export; never duplicate it"
    manifest_raw = (SOURCE / "provider-manifest.json").read_bytes()
    assert hashlib.sha256(manifest_raw).hexdigest() == MANIFEST_SHA
    manifest = json.loads(manifest_raw)
    config_raw = Path(manifest["config"]).read_bytes()
    assert hashlib.sha256(config_raw).hexdigest() == manifest["configSha256"]
    actors = []
    for pid, ticks in [(1440195, 35427348), (1440196, 35427408)]:
        path = Path("/proc", str(pid), "stat")
        if path.exists():
            fields = path.read_text().rsplit(")", 1)[1].split()
            assert int(fields[19]) == ticks and fields[0] not in ["Z", "X", "x"]
            actors.append({"pid": pid, "startTicks": ticks, "state": fields[0]})
        else:
            status = json.loads((SOURCE / "STATUS.json").read_bytes())
            assert status.get("ownRuntimeRetired") is True
            actors.append({"pid": pid, "startTicks": ticks, "state": "ABSENT_RETIRED"})
    native = (SOURCE / "voice-stages.jsonl").read_bytes()
    assert len(native) < 32 * 1024**2 and native.endswith(b"\n")
    groups = {}
    for row in map(json.loads, native.splitlines()):
        if row.get("record_kind") == "invocation_span_boundary":
            groups.setdefault(row["span_id"], set()).add(row["event"])
    assert all(events == {"span_start", "span_end"} for events in groups.values())
    assert time.time_ns() - (SOURCE / "voice-stages.jsonl").stat().st_mtime_ns > 5_000_000_000
    secrets = []

    def collect(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if any(
                    word in key.lower()
                    for word in ["secret", "password", "api_key", "access_token", "refresh_token"]
                ):
                    if isinstance(item, str) and len(item) >= 8:
                        secrets.append(item.encode())
                else:
                    collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)

    collect(json.loads(config_raw))
    names = [
        "provider-manifest.json",
        "controller-launch.json",
        "receiver-identity.json",
        "assistant-identity.json",
        "stt-identity.json",
        "runtime-versions.json",
        "ACTUAL-FILES-v2220.json",
        "PREPARATION-v2220.json",
        "ROOT-ADMISSION-v2220.json",
        "ROOT-LAUNCH-v2220.json",
        "ROOT-LAUNCH-INTENT-v2220.json",
        "STATUS.json",
        "voice-stages.jsonl",
        "actual-provider-bindings.jsonl",
        "resources.jsonl",
    ]
    optional = ["binding-guard-diagnostic.jsonl", "terminal.json"]
    names += [name for name in optional if (SOURCE / name).is_file()]
    assert sum((SOURCE / name).stat().st_size for name in names) < 256 * 1024**2
    assert shutil.disk_usage(ROOT).free > 2 * 1024**3 + 288 * 1024**2
    DEST.mkdir()
    records = []
    archive = DEST / "provider-prefix-v2252.tar.gz"
    partial = archive.with_name(archive.name + ".partial")
    started = time.monotonic()
    with partial.open("xb") as output:
        with tarfile.open(fileobj=output, mode="w:gz", compresslevel=1) as tar:
            for name in names:
                assert time.monotonic() - started < 120
                path = SOURCE / name
                assert path.is_file() and not path.is_symlink()
                with path.open("rb") as stream:
                    before = os.fstat(stream.fileno())
                    data = stream.read(before.st_size)
                assert len(data) == before.st_size
                if name.endswith(".jsonl"):
                    data = data[: data.rfind(b"\n") + 1]
                else:
                    json.loads(data)
                assert not any(secret in data for secret in secrets), (
                    "Private value detected; original source retained, export withheld"
                )
                item = {
                    "name": "raw/" + name,
                    "source": str(path),
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "sourceInode": before.st_ino,
                    "observedSourceBytes": before.st_size,
                    "terminalEOF": False,
                    "completeLinePrefix": name.endswith(".jsonl"),
                }
                info = tarfile.TarInfo(item["name"])
                info.size = len(data)
                info.mode = 0o600
                tar.addfile(info, io.BytesIO(data))
                records.append(item)
            retired = all(item["state"] == "ABSENT_RETIRED" for item in actors)
            seal = {
                "at": datetime.now(timezone.utc).isoformat(),
                "status": "k1_http_provider_after_requester_terminal_fixed_prefix",
                "providerManifestSha256": MANIFEST_SHA,
                "epochManifestSha256": EPOCH_SHA,
                "actors": actors,
                "providerRetired": retired,
                "reservationPreserved": True,
                "nativeSpansAtBoundary": len(groups),
                "openNativeSpansAtBoundary": 0,
                "files": records,
                "rawPayloadBytes": sum(x["bytes"] for x in records),
                "requesterTerminal": terminal,
                "originalFilesPreserved": True,
                "archiveContainsPhysicalCopies": True,
                "sutCalls": 0,
                "epochMeasuredAttempted": attempted,
                "conditionMeasuredAttempted": 180 + attempted,
                "conditionRemaining": 720 - attempted,
                "providerDeadlineNotExtendedUtc": "2026-10-21T22:45:52.468654+00:00",
                "rootDeadlineNotResetUtc": "2026-10-21T23:36:07.231887+00:00",
                "nativeCoverageScope": "Current V2234 correlations only; prefix also contains previous readiness calls. No cross-host clock subtraction.",
            }
            seal_raw = (json.dumps(seal, indent=2) + "\n").encode()
            with (DEST / "PROVIDER-PREFIX-SEAL.json").open("xb") as stream:
                stream.write(seal_raw)
                stream.flush()
                os.fsync(stream.fileno())
            info = tarfile.TarInfo("PROVIDER-PREFIX-SEAL.json")
            info.size = len(seal_raw)
            info.mode = 0o600
            tar.addfile(info, io.BytesIO(seal_raw))
        output.flush()
        os.fsync(output.fileno())
    os.replace(partial, archive)
    result = {key: value for key, value in seal.items() if key != "files"}
    result.update(
        host=socket.gethostname(),
        archive=str(archive),
        bytes=archive.stat().st_size,
        sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
        sealSha256=hashlib.sha256(seal_raw).hexdigest(),
        files=len(records),
        elapsedSeconds=time.monotonic() - started,
    )
    with (DEST / "EXPORT-RECEIPT.json").open("x") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    return result

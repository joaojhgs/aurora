"""Complete the existing immutable provider archive; never replay inference/export."""

import base64
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / ".git/aurora-handoff-import-20261006"
DEST = (
    ROOT
    / "thesis/campaigns/worker-desktop-k1-orca-relayed-http-remaining450-v2296/provider-prefix-transfer-v2302"
)
RECOVERY = DEST / "recovery-v2397"
PAGE = 49152
CAP = 1200
ARCHIVE_SHA = "3a22bd10761d9fa54755d319b4ef86fb8c7319da906b4716fb2bb1f67f7e19dc"


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2) + "\n").encode()


def atomic(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".recovery-writing")
    with tmp.open("wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def preserve(path, raw):
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def main():
    os.umask(0o077)
    with (
        Path("/tmp/aurora-global-build.lock").open("a") as root_lock,
        (DEST / "transfer.lock").open("a") as transfer_lock,
    ):
        fcntl.flock(root_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(transfer_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert not (RECOVERY / "RECOVERY_STATE.json").exists(), (
            "Reconcile this saved recovery and accepted operation; do not relaunch it"
        )
        original_raw = (DEST / "STATE.json").read_bytes()
        original = json.loads(original_raw)
        meta = original["export"]
        assert original["status"] == "incomplete_preserved"
        assert meta["sha256"] == ARCHIVE_SHA and meta["bytes"] == 6871434
        assert (
            meta["epochManifestSha256"]
            == "9adbf9ba3a7ec0948a087edad3655cf94ee344b3a2371a78d15f188f44150d42"
        )
        assert meta["openNativeSpansAtBoundary"] == 0
        assert all(not Path("/proc", str(pid)).exists() for pid in (3965950, 3965978, 3965951))
        assert (
            shutil.disk_usage(ROOT).free
            - meta["rawPayloadBytes"]
            - 2 * meta["bytes"]
            - 32 * 1024**2
            > 2 * 1024**3
        )
        prefix = (DEST / "provider-prefix-v2301.tar.gz.partial").read_bytes()
        assert len(prefix) == original["copiedBytes"] == 884736
        for page in original["pages"]:
            raw = prefix[page["offset"] : page["offset"] + page["bytes"]]
            assert len(raw) == page["bytes"] and digest(raw) == page["sha256"]
        page9 = (RECOVERY / "reconciled-page-0009.bin").read_bytes()
        proof = json.loads((RECOVERY / "RECOVERED-PAGE9-RECEIPT.json").read_bytes())
        assert proof["offset"] == len(prefix) and len(page9) == proof["bytes"] == 98304
        assert digest(page9) == proof["sha256"] and proof["originalAcceptedCommandResent"] is False
        preserve(RECOVERY / "ORIGINAL-INCOMPLETE-STATE.json", original_raw)
        pages = list(original["pages"])
        pages.append(
            {
                "offset": len(prefix),
                "bytes": len(page9),
                "sha256": digest(page9),
                "receipt": str((RECOVERY / "RECOVERED-PAGE9-RECEIPT.json").relative_to(ROOT)),
                "recoveredAcceptedOutput": True,
            }
        )
        state = {
            "startedAt": now(),
            "status": "recovering_existing_immutable_archive",
            "export": meta,
            "copiedBytes": len(prefix) + len(page9),
            "operation": None,
            "pages": pages,
            "outerSeconds": CAP,
            "pageBytes": PAGE,
            "originalTransportState": {
                "path": str((RECOVERY / "ORIGINAL-INCOMPLETE-STATE.json").relative_to(ROOT)),
                "sha256": digest(original_raw),
                "partialSha256": digest(prefix),
                "originalOuterSeconds": original["outerSeconds"],
                "errorClass": original["errorClass"],
                "error": original["error"],
            },
            "recoveryReason": "One missing terminal frame; recovered exact page9 fragment, then smaller read-only copy pages",
            "sutCalls": 0,
            "newAgents": 0,
            "newProviderExport": 0,
            "noMeasurementInputsOrClocksChanged": True,
            "clockMetadataClarification": {
                "legacyExporterDeadlineLabelsAreHistorical": True,
                "actualProviderDeadlineUtc": "2026-10-22T08:31:16.563152+00:00",
                "actualRootDeadlineUtc": "2026-10-22T09:39:28.033312+00:00",
                "allocationReceipt": "thesis/evidence/k1-http-remaining450-admission-v2294/SESSION-ALLOCATION-v2296.json",
                "allocationSha256": "e0bf68319b9ba7355a33cbde67ed57acf174b277c34fdb08f7e103d81cefb311",
                "oldExportAndAllRawPreserved": True,
            },
        }
        statepath = RECOVERY / "RECOVERY_STATE.json"

        def save():
            state["updatedAt"] = now()
            atomic(statepath, encoded(state))

        save()
        started = time.monotonic()
        partial = RECOVERY / "provider-prefix-v2301.tar.gz.recovery-partial"
        try:
            with partial.open("xb") as output:
                output.write(prefix)
                output.write(page9)
                output.flush()
                os.fsync(output.fileno())
                for offset in range(output.tell(), meta["bytes"], PAGE):
                    assert time.monotonic() - started < CAP - 215, (
                        "Finite recovery cap; keep the same saved operation/partial"
                    )
                    length = min(PAGE, meta["bytes"] - offset)
                    name = f"k1-prefix-v2397-provider-offset-{offset:09d}"
                    marker = f"K1_PREFIX_V2397_PROVIDER_OFFSET_{offset:09d}"
                    assert not (BASE / f"{name}-SEND-INTENT.json").exists(), (
                        "An accepted read may already exist; reconcile it before any send"
                    )
                    code = f"""from pathlib import Path
import json,hashlib,base64
p=Path({meta["archive"]!r});assert p.stat().st_size=={meta["bytes"]}
with p.open('rb') as stream:stream.seek({offset});data=stream.read({length})
v={{'source':str(p),'offset':{offset},'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'data':base64.b64encode(data).decode()}}
raw=base64.b64encode(json.dumps(v,separators=(',',':')).encode()).decode();parts=[raw[i:i+800] for i in range(0,len(raw),800)]
for i,s in enumerate(parts):print({marker!r}+' '+json.dumps({{'seq':i,'total':len(parts),'data':s}}),flush=True)
"""
                    compile(code, name, "exec")
                    command = (
                        "python3 -c \"import base64;exec(base64.b64decode('"
                        + base64.b64encode(code.encode()).decode()
                        + "'))\"\n"
                    )
                    commandpath = RECOVERY / "commands" / (name + ".txt")
                    commandpath.parent.mkdir(exist_ok=True)
                    preserve(commandpath, command.encode())
                    state["operation"] = {
                        "name": name,
                        "marker": marker,
                        "offset": offset,
                        "bytes": length,
                        "maximumSends": 1,
                        "onFailure": "Preserve saved output/intent; never blindly resend",
                    }
                    save()
                    result = subprocess.run(
                        [
                            sys.executable,
                            str(ROOT / "thesis/harness/orca_copy_control_raw_read_v1652.py"),
                            name,
                            str(commandpath),
                            marker,
                        ],
                        capture_output=True,
                        text=True,
                        timeout=210,
                    )
                    receipts = RECOVERY / "receipts"
                    receipts.mkdir(exist_ok=True)
                    preserve(receipts / (name + ".stdout"), result.stdout.encode())
                    preserve(receipts / (name + ".stderr"), result.stderr.encode())
                    assert result.returncode == 0, (
                        "Reconcile the same accepted smaller page; no pipeline replay"
                    )
                    transport = json.loads(result.stdout.strip().splitlines()[-1])
                    response_raw = (BASE / transport["resultFile"]).read_bytes()
                    response = json.loads(response_raw)
                    data = base64.b64decode(response["data"], validate=True)
                    assert response["source"] == meta["archive"] and response["offset"] == offset
                    assert response["bytes"] == len(data) == length
                    assert digest(data) == response["sha256"] and output.tell() == offset
                    result_copy = receipts / transport["resultFile"]
                    preserve(result_copy, response_raw)
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                    state["copiedBytes"] = output.tell()
                    state["pages"].append(
                        {
                            "offset": offset,
                            "bytes": length,
                            "sha256": digest(data),
                            "nextCursor": transport["nextCursor"],
                            "receipt": str(result_copy.relative_to(ROOT)),
                        }
                    )
                    state["operation"] = None
                    save()
                    print(
                        json.dumps(
                            {
                                "status": "recovering",
                                "copiedBytes": output.tell(),
                                "totalBytes": meta["bytes"],
                            }
                        ),
                        flush=True,
                    )
            assert (
                partial.stat().st_size == meta["bytes"]
                and digest(partial.read_bytes()) == ARCHIVE_SHA
            )
            archive = DEST / Path(meta["archive"]).name
            assert not archive.exists(), "Reconcile an already published archive"
            os.link(partial, archive)
            state["archiveVerified"] = {
                "path": str(archive.relative_to(ROOT)),
                "bytes": meta["bytes"],
                "sha256": ARCHIVE_SHA,
            }
            state["status"] = "archive_verified_extracting_exact_raw"
            save()
            with tarfile.open(archive, "r:gz") as source:
                sealraw = source.extractfile("PROVIDER-PREFIX-SEAL.json").read()
                assert digest(sealraw) == meta["sealSha256"]
                export = json.loads(sealraw)
                expected = {item["name"]: item for item in export["files"]}
                expected["PROVIDER-PREFIX-SEAL.json"] = None
                files = []
                for member in source.getmembers():
                    path = Path(member.name)
                    assert member.isfile() and member.name in expected
                    assert not path.is_absolute() and ".." not in path.parts
                    checksum, size = hashlib.sha256(), 0
                    with source.extractfile(member) as stream:
                        for chunk in iter(lambda: stream.read(1048576), b""):
                            checksum.update(chunk)
                            size += len(chunk)
                    record = expected[member.name]
                    if record:
                        assert size == record["bytes"] and checksum.hexdigest() == record["sha256"]
                    files.append(
                        {
                            "member": member.name,
                            "bytes": size,
                            "sha256": checksum.hexdigest(),
                            "custody": "verified member of physical retained archive",
                        }
                    )
                assert len(files) == len(expected)
                preserve(DEST / "PROVIDER-PREFIX-SEAL.json", sealraw)
                extracted = []
                for name in (
                    "raw/voice-stages.jsonl",
                    "raw/actual-provider-bindings.jsonl",
                    "raw/resources.jsonl",
                    "raw/receiver-identity.json",
                ):
                    item = expected[name]
                    target = DEST / "extracted" / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    checksum, size = hashlib.sha256(), 0
                    with source.extractfile(name) as incoming, target.open("xb") as outgoing:
                        for chunk in iter(lambda: incoming.read(1048576), b""):
                            assert shutil.disk_usage(ROOT).free - len(chunk) > 2 * 1024**3
                            outgoing.write(chunk)
                            checksum.update(chunk)
                            size += len(chunk)
                        outgoing.flush()
                        os.fsync(outgoing.fileno())
                    assert size == item["bytes"] and checksum.hexdigest() == item["sha256"]
                    extracted.append(
                        {
                            "path": str(target.relative_to(ROOT)),
                            "bytes": size,
                            "sha256": checksum.hexdigest(),
                        }
                    )
            state.update(
                status="complete_verified_provider_prefix_archive",
                files=files,
                finishedAt=now(),
                rawFiles=len(export["files"]),
                rawPayloadBytes=export["rawPayloadBytes"],
                originalRawPreserved=True,
                duplicateUncompressedBytes=sum(x["bytes"] for x in extracted),
                analysisExtraction=extracted,
                analysisExtractionPurpose="Only four saved-data analyzer inputs; no models/config/env/DB/credentials copied",
                requesterActorsAbsent=True,
                providerRetired=meta["providerRetired"],
                reservationPreserved=True,
                epochMeasured=export["epochMeasuredAttempted"],
                conditionMeasured=export["conditionMeasuredAttempted"],
                conditionRemaining=export["conditionRemaining"],
                diskAfter=shutil.disk_usage(ROOT)._asdict(),
            )
            save()
            assert digest((DEST / "STATE.json").read_bytes()) == digest(original_raw)
            atomic(DEST / "STATE.json", encoded(state))
            preserve(DEST / "CUSTODY.json", encoded(state))
            print(
                json.dumps(
                    {
                        "status": state["status"],
                        "rawFiles": state["rawFiles"],
                        "rawPayloadBytes": state["rawPayloadBytes"],
                        "archiveBytes": meta["bytes"],
                        "sha256": ARCHIVE_SHA,
                    }
                ),
                flush=True,
            )
        except BaseException as error:
            state.update(
                status="incomplete_preserved", errorClass=type(error).__name__, error=str(error)
            )
            save()
            raise


if __name__ == "__main__":
    main()

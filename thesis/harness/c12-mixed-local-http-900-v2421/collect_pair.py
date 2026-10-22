"""Copy-only fixed per-pair provider capsule; no model calls or permission edits."""

from pathlib import Path
import base64
import gzip
import hashlib
import io
import json
import os
import tarfile
import time

from campaign import atomic, now, sha, write_once


def collect(output, ordinal, expected_parent, expected_manifest):
    output = Path(output)
    manifest_path = output / "CAMPAIGN-MANIFEST.json"
    assert sha(manifest_path) == expected_manifest
    phase = "warmup" if ordinal <= 15 else "measured"
    assert phase == "warmup" or (output / "MEASURED-ADMITTED.json").exists()
    capsule = output / "capsules" / f"{ordinal:04d}"
    if (capsule / "RECEIPT.json").exists():
        receipt = json.loads((capsule / "RECEIPT.json").read_bytes())
        assert receipt["expectedParentStt"] == expected_parent
        assert sha(receipt["archive"]) == receipt["sha256"]
        return receipt
    case_dir = output / "cases" / f"{ordinal:04d}"
    deadline = time.monotonic() + 120
    while not (case_dir / "CASE.json").exists() and time.monotonic() < deadline:
        if (output / "LOCAL-DRIVER-ERROR.json").exists() or (
            output / "LOCAL-PRODUCER-STOP.json"
        ).exists():
            break
        time.sleep(0.25)
    assert (case_dir / "CASE.json").exists(), (
        "Counterpart pending/unknown; preserve reservation and reconcile, never rerun primary"
    )
    case = json.loads((case_dir / "CASE.json").read_bytes())
    assert (
        case["ordinal"] == ordinal and case["parent_remote_stt_correlation_id"] == expected_parent
    )
    names = [
        "voice-stages.jsonl",
        "resources.jsonl",
        "bus-queue-observations.jsonl",
        "actual-provider-bindings.jsonl",
    ]
    previous = {}
    if ordinal > 1:
        prior = json.loads(
            (output / "capsules" / f"{ordinal - 1:04d}" / "RECEIPT.json").read_bytes()
        )
        previous = prior["offsets"]
    payloads = {}
    offsets = {}
    members = {}
    for name in names:
        path = output / name
        begin = int(previous.get(name, {}).get("end", 0))
        end = path.stat().st_size if path.exists() else 0
        assert end >= begin
        if end > begin:
            with path.open("rb") as stream:
                stream.seek(begin)
                raw = stream.read(end - begin)
            # Append-only JSON writers flush whole lines; defer an incomplete final line.
            cut = raw.rfind(b"\n") + 1
            raw = raw[:cut]
            end = begin + cut
        else:
            raw = b""
        offsets[name] = {
            "begin": begin,
            "end": end,
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        }
        if raw:
            payloads["raw/" + name] = raw
    for name in ["CASE.json", "STARTED.json"]:
        payloads["local/" + name] = (case_dir / name).read_bytes()
    audio = case.get("audio")
    if audio:
        path = Path(audio["path"])
        assert sha(path) == audio["sha256"] and path.stat().st_size == audio["bytes"]
        payloads["local/AUDIO.wav"] = path.read_bytes()
    payloads["pair-metadata.json"] = (
        json.dumps(
            {
                "at": now(),
                "ordinal": ordinal,
                "parentStt": expected_parent,
                "phase": phase,
                "manifestSha256": expected_manifest,
                "localCaseStatus": case["status"],
            },
            indent=2,
        )
        + "\n"
    ).encode()
    for name, data in payloads.items():
        members[name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    capsule.mkdir(parents=True)
    archive = capsule / "provider-pair.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        for name, data in payloads.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mtime = 0
            tar.addfile(info, io.BytesIO(data))
    assert archive.stat().st_size < 512 * 1024, (
        "Unexpected capsule volume; no bulk stream on measured path"
    )
    receipt = {
        "at": now(),
        "ordinal": ordinal,
        "phase": phase,
        "expectedParentStt": expected_parent,
        "manifestSha256": expected_manifest,
        "archive": str(archive),
        "bytes": archive.stat().st_size,
        "sha256": sha(archive),
        "offsets": offsets,
        "members": members,
        "localCase": case,
        "inferenceByCollector": 0,
        "timingScope": "Copy/control occurs after the measured HTTP flow; its time is retained separately in offered/completed rate history",
    }
    write_once(capsule / "RECEIPT.json", receipt)
    return receipt


def emit(receipt, page, marker):
    archive = Path(receipt["archive"])
    assert sha(archive) == receipt["sha256"]
    with archive.open("rb") as stream:
        stream.seek(page * 32768)
        raw = stream.read(32768)
    assert raw, "Page outside exact sealed archive"
    payload = {
        "host": "personal.skyron-server",
        "receipt": receipt if page == 0 else None,
        "page": page,
        "offset": page * 32768,
        "totalBytes": receipt["bytes"],
        "pageBytes": len(raw),
        "pageSha256": hashlib.sha256(raw).hexdigest(),
        "data": base64.b64encode(raw).decode(),
    }
    encoded = base64.b64encode(json.dumps(payload).encode()).decode()
    for i in range(0, len(encoded), 600):
        print(
            marker
            + " "
            + json.dumps(
                {
                    "seq": i // 600,
                    "total": (len(encoded) + 599) // 600,
                    "data": encoded[i : i + 600],
                }
            ),
            flush=True,
        )

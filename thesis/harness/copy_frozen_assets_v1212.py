"""Retain known frozen weight bytes in this repository; no model execution."""

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import time

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / "thesis/models/retained-v1212"
LOCK = json.loads((ROOT / "thesis/models/weight-lock-v1.json").read_text())["files"]
SNAPSHOT = Path("/home/developer/.cache/huggingface/hub/models--Systran--faster-whisper-base/snapshots/ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66")
FROZEN = json.loads((ROOT / ".git/aurora-handoff-import-20261006/distributed-k1-orca-relayed-launch-v1197/condition-frozen-v1197.json").read_text())["canonicalModelFiles"]
RESERVE = 2 * 1024**3
RATE = 4 * 1024**2


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024**2), b""):
            value.update(block)
    return value.hexdigest()


if __name__ == "__main__":
    DEST.mkdir(parents=True, exist_ok=True)
    receipt_path = DEST / "CUSTODY.json"
    if receipt_path.exists():
        raise SystemExit("Existing receipt preserved; inspect it rather than repeat this copy")
    receipt = {"startedAt": now(), "diskBefore": shutil.disk_usage(ROOT)._asdict(),
               "freeSpaceFloorBytes": RESERVE, "copyRateBytesPerSecond": RATE,
               "records": [], "sutCalls": 0, "modelsChanged": False,
               "possibleConfound": "Concurrent disk copying/checksums; all measured cases retained."}
    try:
        for item in LOCK:
            role, name = item["role"], item["name"]
            if role == "stt":
                source = SNAPSHOT / name
            elif role == "llm":
                source = Path(FROZEN["llm"]["path"])
            else:
                source = Path(FROZEN["tts_config" if name.endswith("json") else "tts"]["path"])
            if source.stat().st_size != item["bytes"]:
                raise RuntimeError("source byte count differs: " + str(source))
            if role == "llm":
                target = source.resolve(strict=True)
                if not target.is_relative_to(ROOT) or ".git" in target.relative_to(ROOT).parts:
                    raise RuntimeError("expected LLM bytes are not a regular repository object")
                state = "VERIFIED_EXISTING_REPO_OBJECT"
            else:
                target = DEST / role / name
                target.parent.mkdir(parents=True, exist_ok=True)
                if shutil.disk_usage(ROOT).free - item["bytes"] < RESERVE:
                    raise RuntimeError("asset copy would cross free-space floor")
                if target.exists():
                    if target.is_symlink() or sha(target) != item["sha256"]:
                        raise RuntimeError("existing destination differs")
                else:
                    temporary = target.with_name(target.name + ".partial-" + str(os.getpid()))
                    start = time.monotonic()
                    count = 0
                    with source.open("rb") as src, temporary.open("xb") as out:
                        before = os.fstat(src.fileno())
                        while block := src.read(1024**2):
                            out.write(block)
                            count += len(block)
                            time.sleep(max(0, count / RATE - (time.monotonic() - start)))
                        out.flush()
                        os.fsync(out.fileno())
                        after = os.fstat(src.fileno())
                    if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
                        raise RuntimeError("frozen source changed during copy")
                    if sha(temporary) != item["sha256"]:
                        raise RuntimeError("copied asset checksum mismatch")
                    os.replace(temporary, target)
                    fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
                    os.fsync(fd)
                    os.close(fd)
                state = "VERIFIED_REPO_COPY"
            actual = sha(target)
            if actual != item["sha256"]:
                raise RuntimeError("repository asset checksum mismatch")
            receipt["records"].append({**item, "source": str(source), "destination": str(target.relative_to(ROOT)),
                                       "verifiedSha256": actual, "state": state, "at": now()})
        receipt["status"] = "all_seven_frozen_assets_physically_verified"
    except Exception as exc:
        receipt.update({"status": "incomplete", "error": str(exc)})
        raise
    finally:
        receipt.update({"finishedAt": now(), "diskAfter": shutil.disk_usage(ROOT)._asdict()})
        temporary = receipt_path.with_suffix(".partial")
        with temporary.open("x") as out:
            json.dump(receipt, out, indent=2)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, receipt_path)
        print(json.dumps(receipt), flush=True)

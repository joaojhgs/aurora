"""Join already verified provider copies without recopying or rehashing old raw data."""

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[2]
PRIOR = ROOT / "thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1513/provider-transfer-v1556/COVERAGE-CHAIN.json"
DEST = ROOT / "thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1620/provider-transfer-v1654"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_once(path, value):
    data = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    assert not path.exists()
    temp = path.with_name(path.name + ".partial")
    with temp.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)
    return {"path": str(path.relative_to(ROOT)), "bytes": len(data), "sha256": sha(data)}


def main():
    custody = json.loads((DEST / "CUSTODY.json").read_bytes())
    assert custody["status"] == "complete_checkpoint_copy"
    assert custody["rawFiles"] == 489 and custody["rawPayloadBytes"] == 117658016
    assert custody["archiveVerified"]["sha256"] == "76b6f2b3e2fad8d2c32630e52ad17cfeafb649713a557532d0d656585e9bf67f"
    previous = json.loads(PRIOR.read_bytes())
    resolved = dict(previous["resolvedFiles"])
    assert len(resolved) == 1305
    state_bytes = (DEST / "extracted/PROVIDER-CURRENT.snapshot.json").read_bytes()
    state = json.loads(state_bytes)
    original_bytes = (DEST / "extracted/PROVIDER-CURRENT.original-956.json").read_bytes()
    assert sha(original_bytes) == "8570dba2265eba4669b04a0d2d53de1ac87303b3a08116eb999caac7acaa1ca2"
    inventory = json.loads((DEST / "extracted/PROVIDER-EXPORT.json").read_bytes())
    assert inventory["snapshotSha256"] == sha(state_bytes)
    assert inventory["originalCurrentSha256"] == sha(original_bytes)
    assert len(inventory["files"]) == 489
    for item in custody["files"]:
        if not item["member"].startswith("provider-raw/"):
            continue
        name = item["member"].removeprefix("provider-raw/")
        assert name not in resolved
        resolved[name] = {"path": item["destination"], "bytes": item["bytes"], "sha256": item["sha256"]}
    assert set(resolved) == set(state["files"])
    for name, record in state["files"].items():
        saved = resolved[name]
        assert (saved["bytes"], saved["sha256"]) == (record["bytes"], record["sha256"])
        relative = Path(saved["path"])
        assert not relative.is_absolute() and ".." not in relative.parts
        physical = ROOT / relative
        assert physical.is_relative_to(ROOT / "thesis")
        assert physical.resolve(strict=True) == physical and physical.is_file()
        assert physical.stat().st_size == saved["bytes"]
    prefixes = {}
    for name, prefix in state["prefixes"].items():
        end = 0
        for member in prefix["chunks"]:
            record = state["files"][member]
            assert record["startByte"] == end
            assert record["bytes"] == record["endByte"] - record["startByte"]
            end = record["endByte"]
        assert end == prefix["endByte"] == prefix["sourceObservedBytes"]
        assert prefix["incomplete"] is False
        prefixes[name] = {"contiguousBytes": end, "chunks": len(prefix["chunks"]), "terminalEOF": True}
    assert len(resolved) == 1794
    chain = {"schema": "aurora.provider.coverage-chain.v1", "checkpointSequence": state["sequence"],
             "snapshotAt": state["updatedAt"], "derivedAt": datetime.now(timezone.utc).isoformat(),
             "snapshotSha256": sha(state_bytes), "originalCurrentSha256": sha(original_bytes),
             "priorCoverageChain": str(PRIOR.relative_to(ROOT)), "priorRawRecopiedBytes": 0,
             "priorRawRehashedBytes": 0, "deltaRawFiles": 489, "resolvedFiles": resolved,
             "terminalDerivation": state["terminalDerivation"]}
    chain_receipt = write_once(DEST / "COVERAGE-CHAIN.json", chain)
    result = {"at": datetime.now(timezone.utc).isoformat(), "status": "ORIGINAL_PROVIDER_RAW_CUSTODY_RECONCILED",
              "coverageChain": chain_receipt, "resolvedFiles": len(resolved),
              "resolvedBytes": sum(item["bytes"] for item in resolved.values()),
              "newFiles": 489, "newRawBytes": 117658016, "priorFilesReused": 1305,
              "priorRawRecopiedOrRehashedBytes": 0, "newFileHashesVerifiedByTransfer": True,
              "physicalExistenceAndLengthsReconciled": True, "prefixes": prefixes,
              "originalCurrent956Preserved": True, "terminalSnapshotIsExplicitDerivative": True,
              "diskAfter": shutil.disk_usage(ROOT)._asdict(), "reservedFreeFloorBytes": 2 * 1024**3,
              "newInferenceOrTests": 0, "goalResumePerformed": False,
              "scientificAcceptance": "Custody recovery only; K3 remains740attempted/160unattempted, not900 acceptance."}
    assert result["diskAfter"]["free"] > result["reservedFreeFloorBytes"]
    final = write_once(DEST / "FINAL-CUSTODY-RECONCILIATION-v1655.json", result)
    print(json.dumps({"receipt": final, "resolvedFiles": result["resolvedFiles"],
                      "resolvedBytes": result["resolvedBytes"], "prefixes": prefixes,
                      "freeBytes": result["diskAfter"]["free"]}), flush=True)


if __name__ == "__main__":
    main()

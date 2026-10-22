"""Local operational guard, not a permission/ownership grant or live admission."""

from datetime import datetime, timezone
import json
from pathlib import Path

ROOT = Path("/home/developer/projects/aurora")
PREDECESSOR = ROOT / "thesis/campaigns/c12-mixed-local-http-900-v2426"
PREDECESSOR_SHA = "316d4cc09adc44d0104dca8ac1f2a966347588ffef37bc2fa809ec14fd5efff8"


def predecessor_state():
    process = Path("/proc/281887/stat")
    present = False
    if process.exists():
        fields = process.read_text().rsplit(")", 1)[1].split()
        present = int(fields[19]) == 143363140
    release_path = PREDECESSOR / "RESOURCE-RELEASE.json"
    release = json.loads(release_path.read_bytes()) if release_path.exists() else {}
    complete = (
        not present
        and (PREDECESSOR / "REQUESTER-TERMINAL.json").exists()
        and release.get("campaignManifestSha256") == PREDECESSOR_SHA
        and all(
            release.get(key) is True
            for key in (
                "cohortAllocationReleased",
                "originalRequesterAbsent",
                "originalProviderActorsAbsent",
                "rawAndAudioCustodyVerified",
            )
        )
    )
    # The interrupted260 epoch is sealed, but its remaining640 recovery is
    # still the current HTTP condition and must also be released first.
    successor = ROOT / "thesis/campaigns/c12-mixed-local-http-remaining640-v2453"
    successor_release_path = successor / "RESOURCE-RELEASE.json"
    successor_release = json.loads(successor_release_path.read_bytes()) if successor_release_path.exists() else {}
    successor_released = (
        successor_release.get("campaignManifestSha256") == "3bfca19d2dd0a9eec3981eae256168a5badd9ac2bb58a270ff8a55df1d986cce"
        and successor_release.get("conditionMeasuredTargetComplete") is True
        and all(successor_release.get(key) is True for key in (
            "cohortAllocationReleased", "originalRequesterAbsent",
            "originalProviderActorsAbsent", "rawAndAudioCustodyVerified",
        ))
    )
    interrupted_epoch_released = complete
    complete = complete and successor_released
    return {
        "at": datetime.now(timezone.utc).isoformat(),
        "predecessorOriginalRequesterPresent": present,
        "predecessorReleaseReceiptPresent": release_path.exists(),
        "predecessorReleased": complete,
        "interrupted260EpochReleased": interrupted_epoch_released,
        "remaining640EpochReleaseReceiptPresent": successor_release_path.exists(),
        "remaining640EpochReleased": successor_released,
        "currentConditionOperationalAdmission": False,
        "newRuntimeNetworkOrInference": 0,
    }


def require_predecessor_release():
    state = predecessor_state()
    if not state["predecessorReleased"]:
        raise RuntimeError("current_HTTP_condition_not_retired_sealed_and_released")


if __name__ == "__main__":
    print(json.dumps(predecessor_state(), indent=2))

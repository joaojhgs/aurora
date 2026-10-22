"""Prepare one linked 387-attempt epoch; no app import, launch or network call."""

import ast
from datetime import datetime, timezone
import difflib
import hashlib
import json
from pathlib import Path
import shutil


R = Path(__file__).resolve().parents[2]
H = R / '.git/aurora-handoff-import-20261006'
OLD = H / 'distributed-k3-requester-prep-v1413'
DEST = R / 'thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1513'
CANONICAL = R / 'thesis/harness/distributed-k3-http-remaining-v1513'
STAGE = H / 'distributed-k3-requester-prep-v1513'
PARENT = R / 'thesis/campaigns/worker-desktop-k3-orca-relayed-http-v1481'
PARENT_SHA = '54d51acdf8219b4e69f21cabb9d9fb1b402acf9826196dbdcea4fcfd15bddb25'
FILES = [
    'runner.py', 'controller.py', 'receiver_proof.py', 'stage_adapter.py',
    'k3_composition.py', 'bootstrap.py', 'bindings.py', 'observer.py',
    'aurora_voice_telemetry_v430.py', 'resource_sample.py',
    'candidate-manifest.json', 'candidate-input.wav', 'source-inventory.json',
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write('\n')


def replace_once(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new, 1)


def main():
    frozen = PARENT / 'condition-frozen.json'
    assert sha(frozen.read_bytes()) == PARENT_SHA
    receipt_path = PARENT / 'terminal-v1506/VALIDATION-v1511.json'
    receipt = json.loads(receipt_path.read_bytes())
    rows_path = PARENT / 'terminal-v1506/requester-analysis-v1506/MEASURED-REQUESTS.jsonl'
    rows = [json.loads(line) for line in rows_path.read_bytes().splitlines()]
    assert len(rows) == receipt['measuredAttempted'] == 513
    assert [row['measuredIndex'] for row in rows] == list(range(1, 514))
    assert len({row['requestId'] for row in rows}) == 513
    assert sum(row['status'] == 'completed_correct' for row in rows) == 512
    assert sum(row['status'] == 'failed' for row in rows) == 1
    assert receipt['unattempted'] == 387 and 513 + 387 == 900
    assert not any(path.exists() for path in (DEST, CANONICAL, STAGE))
    assert shutil.disk_usage(R).free > 2 * 1024**3 + 10 * 1024**2
    for path in (DEST, CANONICAL, STAGE):
        path.mkdir(mode=0o700)

    binding = {
        'epochId': 'V1513',
        'parentCohortId': json.loads(frozen.read_bytes())['cohortId'],
        'parentManifestSha256': PARENT_SHA,
        'parentValidationPath': str(receipt_path.relative_to(R)),
        'parentValidationSha256': sha(receipt_path.read_bytes()),
        'parentMeasuredRowsPath': str(rows_path.relative_to(R)),
        'parentMeasuredRowsSha256': sha(rows_path.read_bytes()),
        'conditionTargetMeasured': 900,
        'priorAttemptedMeasured': 513,
        'priorCorrect': 512,
        'priorFailed': 1,
        'plannedEpochMeasured': 387,
        'firstConditionMeasuredIndex': 514,
        'lastConditionMeasuredIndex': 900,
        'plannedFreshExcludedWarmups': 15,
        'preserveParentFailure': True,
        'sameProcessResume': False,
        'poolEpochPercentilesAutomatically': False,
        'analysisPolicy': 'Report each epoch separately. Any condition-level saved-row analysis must explicitly establish comparability, retain the original failure and expose the interruption; never average or pool percentile summaries.',
        'reason': 'Natural transport termination left 387 declared attempts unstarted. No measured request is retried or replaced; no full900 replay.',
    }
    write(DEST / 'EPOCH-LINEAGE.json', binding)
    changes, files = [], []
    for name in FILES:
        before = (OLD / name).read_bytes()
        after = before
        if name == 'runner.py':
            text = before.decode()
            text = replace_once(text, 'MEASURED_COUNT = 900', 'MEASURED_COUNT = 387\nPRIOR_MEASURED_COUNT = 513\nCONDITION_TARGET = 900')
            assert text.count('audio-campaign-v851-') == 2
            text = text.replace('audio-campaign-v851-', 'audio-campaign-v1513-')
            old = '    stt_url = os.environ.get("AURORA_K3_REMOTE_STT_ENDPOINT", "")'
            new = '''    epoch = cohort_manifest.get("epochLineage", {})
    if (epoch.get("epochId") != "V1513"
            or epoch.get("parentManifestSha256") != "PARENT_SHA_PLACEHOLDER"
            or epoch.get("priorAttemptedMeasured") != PRIOR_MEASURED_COUNT
            or epoch.get("plannedEpochMeasured") != MEASURED_COUNT
            or epoch.get("conditionTargetMeasured") != CONDITION_TARGET
            or PRIOR_MEASURED_COUNT + MEASURED_COUNT != CONDITION_TARGET
            or epoch.get("firstConditionMeasuredIndex") != PRIOR_MEASURED_COUNT + 1
            or epoch.get("lastConditionMeasuredIndex") != CONDITION_TARGET
            or epoch.get("priorCorrect") != 512 or epoch.get("priorFailed") != 1
            or epoch.get("preserveParentFailure") is not True
            or cohort_manifest["measurementPlan"].get("plannedMeasuredPerCondition") != CONDITION_TARGET
            or cohort_manifest["measurementPlan"].get("plannedEpochMeasured") != MEASURED_COUNT):
        raise CampaignFailure("preflight", "remaining_epoch_lineage_invalid", stop=True)
    stt_url = os.environ.get("AURORA_K3_REMOTE_STT_ENDPOINT", "")'''.replace('PARENT_SHA_PLACEHOLDER', PARENT_SHA)
            text = replace_once(text, old, new)
            text = replace_once(text, '\n        "planned_measured": MEASURED_COUNT,', '\n        "planned_measured": MEASURED_COUNT,\n        "epoch_lineage": epoch,\n        "condition_target_measured": CONDITION_TARGET,')
            text = replace_once(text, '                "harness_case_id": harness_case_id,', '''                "harness_case_id": harness_case_id,
                "epoch_id": epoch["epochId"],
                "frozen_cohort_manifest_sha256": cohort_manifest_hash,
                "condition_measured_index": PRIOR_MEASURED_COUNT + attempt_index if phase == "measured" else None,''')
            after = text.encode()
        elif name == 'controller.py':
            text = before.decode()
            text = replace_once(text, '            or cohort.get("measurementPlan", {}).get("conditionOverallCapSeconds") != 57_600', '''            or cohort.get("measurementPlan", {}).get("conditionOverallCapSeconds") != 57_600
            or cohort.get("measurementPlan", {}).get("plannedMeasuredPerCondition") != 900
            or cohort.get("measurementPlan", {}).get("plannedEpochMeasured") != 387
            or cohort.get("epochLineage", {}).get("epochId") != "V1513"
            or cohort.get("epochLineage", {}).get("priorAttemptedMeasured") != 513
            or cohort.get("epochLineage", {}).get("plannedEpochMeasured") != 387
            or cohort.get("epochLineage", {}).get("parentManifestSha256") != "PARENT_SHA_PLACEHOLDER"'''.replace('PARENT_SHA_PLACEHOLDER', PARENT_SHA))
            text = replace_once(text, '        "planned_measured": 900,', '        "planned_measured": 387,\n        "condition_target_measured": 900,\n        "epoch_lineage": cohort["epochLineage"],')
            after = text.encode()
        elif name == 'receiver_proof.py':
            text = before.decode()
            assert text.count('audio-campaign-v851-') == 1
            after = text.replace('audio-campaign-v851-', 'audio-campaign-v1513-').encode()
        if name.endswith('.py'):
            ast.parse(after, filename=name)
        for directory in (CANONICAL, STAGE):
            with (directory / name).open('xb') as stream:
                stream.write(after)
        files.append({'name': name, 'priorSha256': sha(before), 'sha256': sha(after), 'bytes': len(after)})
        if after != before:
            changes.extend(difflib.unified_diff(before.decode().splitlines(True), after.decode().splitlines(True), fromfile='v1413/'+name, tofile='v1513/'+name))
    (DEST / 'SOURCE-DELTA.diff').write_text(''.join(changes))
    # Main-flow count proof, without executing any app or model path.
    planned = [(n, 'warmup' if n <= 15 else 'measured', None if n <= 15 else 513 + n - 15) for n in range(1, 15 + 387 + 1)]
    new_indices = [index for _, phase, index in planned if phase == 'measured']
    assert new_indices == list(range(514, 901))
    assert set(new_indices).isdisjoint(row['measuredIndex'] for row in rows)
    checks = {'freshWarmups': sum(phase == 'warmup' for _, phase, _ in planned), 'epochMeasured': len(new_indices), 'firstGlobalMeasured': min(new_indices), 'lastGlobalMeasured': max(new_indices), 'priorFailuresRetained': 1, 'wholeConditionAttemptTarget': len(rows) + len(new_indices), 'newRuntimeRequests': 0}
    write(DEST / 'PREPARATION.json', {'at': datetime.now(timezone.utc).isoformat(), 'status': 'SOURCE_PREPARED_NOT_LAUNCHED', 'sourceFiles': files, 'lineageSha256': sha((DEST / 'EPOCH-LINEAGE.json').read_bytes()), 'checks': checks, 'newConditionOrChangedEffectiveSetup': False, 'parentUnchanged': sha(frozen.read_bytes()) == PARENT_SHA})
    (DEST / 'README.md').write_text('''# K3 HTTP remaining387 epoch V1513

This prepared epoch covers condition indices514–900 only, after V1481 naturally stopped at513. It preserves512correct plus1transport failure and all original raw evidence. It is not a same-process resume or a new900 replay. No model/audio/predicate/backend/settings/endpoint/load/timing-boundary change is intended. Fresh15excluded warmups and45strict native joins precede measurement.

Source preparation is not a launch or measurement admission. EPOCH-LINEAGE.json records the closed parent hashes/counts; SOURCE-DELTA.diff shows the count, globally disjoint identity and provenance changes. The same request cap, stop-on-system-failure behavior and full-flow end boundary remain. Each epoch is reported separately; any later condition-level analysis must explicitly establish comparability and expose interruption, not pool percentile summaries or erase the failed attempt.
''')
    print(json.dumps({'status': 'SOURCE_PREPARED_NOT_LAUNCHED', 'directory': str(DEST.relative_to(R)), 'changedFiles': [f['name'] for f in files if f['sha256'] != f['priorSha256']], 'checks': checks}))


if __name__ == '__main__':
    main()

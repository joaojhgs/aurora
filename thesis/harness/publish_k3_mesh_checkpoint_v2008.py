"""Publish one explicitly named fresh Root observation; no SUT operation."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import json
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
HANDOFF = ROOT / '.git/aurora-handoff-import-20261006'
DEST = ROOT / 'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v1988'


def main(name, message_name):
    receipt = DEST / name
    assert receipt.parent == DEST and receipt.is_file() and not receipt.is_symlink()
    value = json.loads(receipt.read_bytes())
    age = (datetime.now(timezone.utc)-datetime.fromisoformat(value['at'])).total_seconds()
    assert 0 <= age < 300 and value['classification'] == 'verified_wait'
    assert value['source'].startswith('fresh primary case files')
    measured, custody = value['measured'], value['custody']
    attempted, correct, failed = (measured[k] for k in ['attempted', 'correct', 'failed'])
    assert attempted == correct + measured['incorrect'] + failed
    rejected = sum(x.get('failure', {}).get('code') == 'preaccept_capability_changed'
                   for x in value['measuredNonCorrect'])
    correction = value.get('reportingCorrection')
    correction_text = ''
    if correction:
        correction_text = ('Reporting correction: `ROOT-LIVE-CHECKPOINT-v2004.json` reused an older 30-attempt receipt. '
                           'It is preserved and superseded by this fresh observation. The actual earlier 54-attempt '
                           'snapshot remains at `ROOT-LIVE-20261020T230436Z.json`. The experiment, frozen source and '
                           'raw cases were unaffected; no requests were rerun. Future checkpoints read primary files directly.\n\n')
    body = f'''

**{value['at']} — K3 P2P measurement is running: {attempted}/900 attempted, {correct} correct, {measured['incorrect']} incorrect and {failed} failed; {measured['remaining']} remain.** There are {rejected} explicit preaccept capability rejections and {measured['timeouts']} timeouts. Every outcome stays in the measured denominator, without retries.

The original controller `3154212`/start `131502232`, backend `3154248`/start `131502574`, and copier `3154213`/start `131502236` are live with matching identities. Frozen manifest `46003ef84b71fade94e1d9e3cbac0dcee8bb524680ca613a9f02df5878e4cd6b` and the reserved Personal provider `251472`/receiver `251473` are unchanged. The provider deadline remains **2026-10-21 12:41:24 UTC**. Custody contains **{custody['cases']} cases, {custody['audio']} audio files and {custody['files']} indexed files** at sequence {custody['sequence']}; the copier continues, with **{value['freeBytes']} bytes free**. [Fresh primary-state checkpoint](CHECKPOINT_LINK).

{correction_text}Live admission passed at 22:53:51 UTC: **15 correct flows from 17 excluded warmup attempts**, with 2 failed warmups retained separately; 45 native stage joins; actual Vulkan RX 7600 acceleration with 25/25 GPU layers; no requester model calls; exact mesh route and capacity checks. The first measured case and valid WAV were physically copied into repo `thesis/` with matching hashes. The original monitor independently verified that admission and first measured result. Old V1975 raw data and frozen source remain preserved; its collector repair was verified on saved data before this run.

Root retains the same ACTIVE native aggregate goal and sole main SUT, reservation and integration ownership. The original monitor remains the sole methodology writer. Phone/notebook setup stays with its existing retained session; its later START permission applies only to that phone campaign. Local source SHA `ebde3a8a` was handed off; the single push was rejected for workflow scope, with no authentication changes. K2 P2P 900 is closed; the remaining matrix and full aggregate objective are open. V799 archive remains UNLOCATED and C06 final raw remains UNKNOWN.

Next routine main-run check: **by {value['nextRoutineCheckUtc']}**, or immediately on an actual terminal/error event. Continue the same frozen run and custody, preserving every outcome.

'''
    for relative in ['docs/experiments/tcc-20261013-submission-20261030/root/CURRENT.md', '.omx/ultragoal/ORCA-COORDINATION.md']:
        path = ROOT / relative
        text = path.read_text()
        left, right = '<!-- AURORA:ROOT:LIVE:START -->', '<!-- AURORA:ROOT:LIVE:END -->'
        start = text.index(left)+len(left); end = text.index(right, start)
        content = body.replace('CHECKPOINT_LINK', os.path.relpath(receipt, path.parent))
        path.write_text(text[:start]+content+text[end:])
    path = HANDOFF / 'EXISTING-SESSION-CURRENT-V491.json'
    current = json.loads(path.read_bytes())
    current.update(currentPhase=f'K3 P2P V1988 running:{attempted}/900 attempted,{correct}correct,{failed}failed;{measured["remaining"]}remain',
                   activeValidation=str(DEST.relative_to(ROOT)), currentExecution=value)
    path.write_text(json.dumps(current, indent=2)+'\n')
    message = (f'Fresh primary-state K3 checkpoint at {value["at"]}: {attempted}/900 measured = {correct} correct, '
               f'{measured["incorrect"]} incorrect, {failed} failed ({rejected} preaccept rejections), '
               f'{measured["timeouts"]} timeouts; {measured["remaining"]} remain. All three original requester actors are exact/live. '
               f'Custody sequence {custody["sequence"]}: {custody["cases"]} cases/{custody["audio"]} audio/{custody["files"]} files; '
               f'{value["freeBytes"]} bytes free. Same frozen46003ef8/provider reservation/deadline12:41:24 UTC. '
               f'Physical receipt {receipt.relative_to(ROOT)}. CURRENT and ORCA markers now derive counters/time from this exact named fresh observation. '
               f'Next check by {value["nextRoutineCheckUtc"]} or actual terminal/error; no extra SUT traffic. Root main priority and separate phone assignment preserved.')
    if correction:
        message += (' Reporting correction CLOSED: old v2004 receipt preserved with SHA in new receipt; its stale30 counters were a broad-glob selection bug. '
                    'Actual historical54 snapshot is independently preserved/hashed. New observer reads primary cases, custody and /proc directly; '
                    'no old receipt used as input, no experiment replay or raw/source change.')
    result = subprocess.run([sys.executable, '/tmp/aurora-orca-bounded-v43.py', message_name, 'orchestration', 'send',
        '--to', 'dispatch:ctx_37b4d0a3c14f', '--run', 'run_e6054e76e9fc', '--from', 'term_6a00d9ee-792a-4daf-8578-236290e33108',
        '--subject', f'Fresh K3 {attempted}/900; {correct} correct/{failed} failed; primary-state receipt', '--body', message,
        '--type', 'status', '--json'], capture_output=True, text=True, timeout=45)
    print(result.stdout, end=''); assert result.returncode == 0
    print(json.dumps({'receipt': str(receipt), 'measured': measured, 'nextCheck': value['nextRoutineCheckUtc'], 'sutCalls': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--receipt-name', required=True)
    parser.add_argument('--message-name', required=True)
    args = parser.parse_args()
    main(args.receipt_name, args.message_name)

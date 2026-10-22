"""Fresh observation and durable reporting only; never call or signal the SUT."""
from pathlib import Path
from datetime import datetime, timezone, timedelta
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
H = ROOT / '.git/aurora-handoff-import-20261006'
D = ROOT / 'thesis/campaigns/worker-desktop-k1-p2p-tts-remaining191-v2153'
C = H / 'distributed-k1-mesh-cell-v2153'
ACTORS = [(3332811, 132995693), (3332919, 132996503), (3333678, 133003703)]


def main(name, message_name):
    assert Path(name).name == name and name.endswith('.json')
    actors = {}
    for pid, ticks in ACTORS:
        p = Path('/proc', str(pid), 'stat')
        try:
            fields = p.read_text().rsplit(')', 1)[1].split()
            actors[str(pid)] = {'state': fields[0], 'startTicks': int(fields[19]),
                                'sameStart': int(fields[19]) == ticks}
        except FileNotFoundError:
            actors[str(pid)] = {'state': 'absent', 'sameStart': False}
    warm = [json.loads(p.read_bytes()) for p in sorted((C/'campaign/attempts').glob('*warmup.jsonl'))]
    rows = [json.loads(p.read_bytes()) for p in sorted((C/'campaign/attempts').glob('*measured.jsonl'))]
    assert [r['global_measured_index'] for r in rows] == list(range(710, 710+len(rows)))
    assert hashlib.sha256((D/'condition-frozen.json').read_bytes()).hexdigest() == 'd753203e4a53f12ed983a98d776a811d241d0d6bc6061b28e3c1480a077a17d3'
    state = json.loads((D/'CURRENT.json').read_bytes())
    receipt = json.loads((ROOT/state['lastReceipt']).read_bytes())
    summary = C/'campaign/summary.json'
    terminal = json.loads(summary.read_bytes()) if summary.exists() else None
    live = all(a['sameStart'] and a['state'] not in ['Z', 'X', 'x'] for a in actors.values())
    at = datetime.now(timezone.utc)
    epoch = {'attempted': len(rows), 'correct': sum(r['status']=='completed_correct' for r in rows),
             'incorrect': sum(r['status']=='completed_incorrect' for r in rows),
             'failed': sum(r['status'] not in ['completed_correct','completed_incorrect'] for r in rows),
             'timeouts': sum(r.get('timeout') is True for r in rows), 'planned': 191, 'remaining': 191-len(rows)}
    value = {'at': at.isoformat(), 'source': 'fresh primary case files and kernel PID/start identities',
        'classification': 'verified_wait' if live and terminal is None else 'requires_same_actor_reconciliation',
        'phase': 'MEASURED_RUNNING' if live and terminal is None else 'RECONCILE_ACTUAL_TERMINAL',
        'epochMeasured': epoch, 'combinedK1': {'attempted':709+epoch['attempted'],
            'correct':697+epoch['correct'], 'incorrect':epoch['incorrect'], 'failed':12+epoch['failed'],
            'timeouts':1+epoch['timeouts'], 'planned':900,'remaining':epoch['remaining']},
        'actors':actors, 'warmups':{'attempted':len(warm),'correct':sum(r['status']=='completed_correct' for r in warm),
            'failed':sum(r['status']!='completed_correct' for r in warm)},
        'custody':{'sequence':state['sequence'],'cases':len(state['completedCases']),
            'wavFiles':len(list((D/'audio').glob('*.wav'))), 'files':len(state['files']),'errors':receipt['errors']},
        'terminal':{k:terminal.get(k) for k in ['status','stop_reason','shutdown_completed']} if terminal else None,
        'originalAuxiliaryError':'preserved and resolved from same saved15native warmups; not an active blocker',
        'sameHardDeadlineUtc':'2026-10-21T06:59:42.981693+00:00',
        'nextRoutineCheckUtc':(at+timedelta(minutes=5)).isoformat(), 'freeBytes':shutil.disk_usage(ROOT).free,
        'nextOfflineHandoff':'thesis/evidence/k1-http-remaining720-offline-prep-v2173/HANDOFF.json',
        'sutCallsByObserver':0,'phoneSeparate':True,'nativeAggregateGoal':'ACTIVE original full scope'}
    path = D/name
    with path.open('x') as f:
        json.dump(value,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
    if message_name:
        assert value['classification']=='verified_wait', 'Actual terminal/error needs reconciliation, not a live publisher'
        block = f'''

**{value['at']} — K1 actualP2P remaining191 MEASURED RUNNING.** This epoch **{epoch['attempted']}/191attempted: {epoch['correct']}correct, {epoch['incorrect']}incorrect, {epoch['failed']}failed/{epoch['timeouts']}timeouts; {epoch['remaining']}remain**. Combined K1 **{value['combinedK1']['attempted']}/900: {value['combinedK1']['correct']}correct, {value['combinedK1']['failed']}failed** plus explicitincorrect{epoch['incorrect']}. Parent709/697correct/12failed/1timeout preserved; onlyglobal710–900,no retry709/success topup/closed900replay. [Fresh primary-state receipt](@@RECEIPT@@).

Same exact live actors: controller3332811/start132995693, backend3332919/start132996503, copier3333678/start133003703. Frozenmanifestd753203e4a53f12ed983a98d776a811d241d0d6bc6061b28e3c1480a077a17d3. LocalWCPU STT+LLM → actual sameD251473/start29038457 PiperCPU over normal Mesh/PeerBridge. No new inference/control traffic, source edits or providerrestart. Before/afterICEobservations are not continuousdirect/relaypurity. Native15correctexcludedwarmups/0failed and firstglobal710+WAV independentlycorroboratedonce. Proofa2571287...; firstcase40978.925272ms/4980B9e132148.../31788BWAVe3303371.... [Firstglobal710](FIRST_LINK).

Originalauxiliaryfinalizer3333679 retired afterlocalwarmup_policy importerror; recovered fromSAMEalready-collected15nativeprefixes bylocalassembly searchpath,0extraSUTcalls/0remote-resend/0frozenchanges. Original211Bfailure4d71fc86... preserved; [savedrecovery](RECOVERY_LINK). Do not poll/restart retiredfinalizer or resendcollectedcommand. Personalcontrolreleased; originalDproviderandphysicalresource reservationcontinue. Currentphysicalcustodyseq{state['sequence']}: {value['custody']['cases']}cases/{value['custody']['wavFiles']}actualWAV/{len(state['files'])}files, errors{len(receipt['errors'])}; free{value['freeBytes']}B.

Only existing current speech_runtime.py language-listbound changed in explicit immutableWsnapshot000202cddd...; other399appfiles/allmodel-decodercode byteidentical. OldV2143zero-request legacy_unverifiable startup/f14afrozeninputs/raw preserved. Same06:59:42.981693UTCharddeadline fromoriginal02:45session15240sincludingfailed/recoverytime; newouter14307/condition14067, no old72000clockreset/revival. Nativewarmupp9550287.369399ms→declared191forecast11825.865s(20%+300)<13231.783sremaining atadmission; not guaranteed ETA. CurrentDoriginalconservative12:41:24deadlineunchanged; idleSTT+LLM residency/contextdifference disclosed.

K3closed900=773correct127failed(71preaccept55answerpredicate1oldtimeout), correctn773Type7p9013.919s/p9514.666s,935cases/2530nativepairs/0gaps,2940filehashes/803WAV and72.756MBproviderprefix raw verifiedphysicalbothhosts. [K3results](K3_LINK). Its55answerfailures sharea1b7...hash; optionalboundedlocal source lookupstopped without verifiedPersonal source/no causalclaim/no furtherprobe orrerun.

Requested [nextHTTPofflinehandoff](HTTP_LINK) ready: parent180=179correct1failed/15excludedwarmups/195rawcases reconciled; remainingONLY720/global181–900. Existingv1600source coversONLY360/global181–540 and leaves360/global541–900; NOT a ready720executable orlaunch. Sourceforecast27617.408s/outer28620s means providerwindow mustbe admitted aftercurrentnaturalterminal, notsilentlyextended. No modelscan/copy, SUT/network/device/build/test/review/newworker orphonework added byprep.

OriginalnativeaggregateACTIVE/full13+fullmatrixOPEN. RootsolemainSUT/reservation/integration; originalmonitorsolemethodologywriter, full§30.72plan780151B/aba3306d mirrored. Phone/notebooksetupexclusivelyretainedterm_1f27be31...; phoneSTARTnevermain gate. V799archiveUNLOCATED/C06finalrawUNKNOWN unchanged. Nextmaincheck **by{value['nextRoutineCheckUtc']}** oractualterminal/error; continue same frozen191epoch.

'''
        for relative in ['docs/experiments/tcc-20261013-submission-20261030/root/CURRENT.md','.omx/ultragoal/ORCA-COORDINATION.md']:
            target=ROOT/relative;text=target.read_text();left='<!-- AURORA:ROOT:LIVE:START -->';right='<!-- AURORA:ROOT:LIVE:END -->';i=text.index(left)+len(left);j=text.index(right,i)
            links={'@@RECEIPT@@':path,'FIRST_LINK':D/'ROOT-FIRST-GLOBAL710-v2162.json',
                'RECOVERY_LINK':D/'SAVED-PROOF-RECOVERY-v2161.json',
                'K3_LINK':ROOT/'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v2043/analysis-v2130/results.md',
                'HTTP_LINK':ROOT/'thesis/evidence/k1-http-remaining720-offline-prep-v2173/README.md'}
            part=block
            for token, dest in links.items():part=part.replace(token,os.path.relpath(dest,target.parent))
            target.write_text(text[:i]+part+text[j:])
        target=H/'EXISTING-SESSION-CURRENT-V491.json';current=json.loads(target.read_bytes())
        current.update(currentPhase=f"K1P2Prunningnew{epoch['attempted']}/191={epoch['correct']}correct+{epoch['failed']}failed; fullgoalACTIVE",activeValidation=str(D.relative_to(ROOT)),currentExecution=value)
        target.write_text(json.dumps(current,indent=2)+'\n')
        body=(f"Fresh{value['at']} exact3actorsLIVE, K1V2153 new{epoch['attempted']}/191={epoch['correct']}correct+{epoch['incorrect']}incorrect+{epoch['failed']}failed/{epoch['timeouts']}timeouts;{epoch['remaining']}remain. "
              f"Combined{value['combinedK1']['attempted']}/900;parent709/12fails preserved. Samefrozen d753/proof a257/hard06:59; no newSUT/source/model/network/worker/review/phone actions. "
              f"Custodyseq{state['sequence']}/{value['custody']['cases']}cases/{value['custody']['wavFiles']}WAV/errors{len(receipt['errors'])};{value['freeBytes']}Bfree. "
              f"{path.relative_to(ROOT)} CURRENT/ORCAupdated. NextHTTP720offlinehandoff v2173 retained/notadmitted; no repeatprep or newgate. Nextcheckby{value['nextRoutineCheckUtc']} oractualterminal/error.")
        cp=subprocess.run([sys.executable,'/tmp/aurora-orca-bounded-v43.py',message_name,'orchestration','send','--to','dispatch:ctx_37b4d0a3c14f','--run','run_e6054e76e9fc','--from','term_6a00d9ee-792a-4daf-8578-236290e33108','--subject',f"K1 live{epoch['attempted']}/191; sameactors/deadline/custody",'--body',body,'--type','status','--json'],capture_output=True,text=True,timeout=45)
        print(cp.stdout,end='');assert cp.returncode==0
    print(json.dumps(value))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--receipt-name',required=True);p.add_argument('--message-name');a=p.parse_args();main(a.receipt_name,a.message_name)

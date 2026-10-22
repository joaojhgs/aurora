"""Publish a fresh remaining624 observation; no model, SUT or lifecycle action."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import json
import os
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]
HANDOFF=ROOT/'.git/aurora-handoff-import-20261006'
DEST=ROOT/'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v2043'


def main(name,message_name):
    path=DEST/name
    assert path.parent==DEST and path.is_file() and not path.is_symlink()
    value=json.loads(path.read_bytes())
    age=(datetime.now(timezone.utc)-datetime.fromisoformat(value['at'])).total_seconds()
    assert 0<=age<300 and value['classification']=='verified_wait'
    assert value['source'].startswith('fresh primary case files')
    combined=value['measured'];epoch=value['epochMeasured'];warm=value['warmupsThisEpoch'];custody=value['custody'];admission=value.get('admission')
    assert combined['attempted']==276+epoch['attempted'] and combined['correct']==256+epoch['correct']
    assert combined['failed']==20+epoch['failed'] and combined['remaining']==624-epoch['attempted']
    label='MEASUREMENT RESUMED' if epoch['attempted'] else 'WARMUP ADMISSION; no new measured requests yet'
    proof=(f"Actual native admission at {admission['at']}: {admission['remoteModelJoins']} native joins, "
           f"Vulkan {admission['actualGpuLayers']}/{admission['actualTotalGpuLayers']} GPU layers, proof `{admission['proofSha256']}`."
           if admission else 'Fresh native/return-boundary/GPU/capacity admission remains pending.')
    actors='; '.join(f"`{pid}`/start`{data['startTicks']}`" for pid,data in value['actors'].items())
    finalizer_live=Path('/proc/3207539').exists()
    control='RESERVED for the automatic finalizer' if finalizer_live else 'RELEASED by the completed finalizer; provider reservation continues'
    block=f'''

**{value['at']} — K3 V2043 {label}.** Combined same-setup condition: **{combined['attempted']}/900 attempted, {combined['correct']} correct, {combined['incorrect']} incorrect, {combined['failed']} failed, {combined['timeouts']} timeouts; {combined['remaining']} unattempted remain**. This epoch alone has **{epoch['attempted']}/624 attempted, {epoch['correct']} correct, {epoch['failed']} failed**, mapped only to global277–900. Parent V1988 remains sealed at276attempts=256correct+20failed (19preaccept+1timeout); failed276 is never retried. Every outcome remains in its denominator.

Current excluded warmups: **{warm['attempted']} attempted, {warm['correct']} correct and {warm['failed']} failed**, separate from the parent's17excludedwarmups (15correct+2failed). {proof} The original strict correctness,15correct≤30distinctwarmup bound,3consecutiveknownpreaccept/anyothererror hardstop and900condition target remain. Only count/global-index/parent-seal/reporting code changed;11execution modules, actualaudio/models/settings/authority and provider source remain unchanged under frozen `ac92f9ba1455c3778e378c6548f0e518fcf0115c6ea9ebf7624f8c30df14d2c5`.

All new original requester actors are live with exact identities: {actors}. Same Personal provider `251472`/receiver`251473`, manifest716b8934/config1b2e464a, deadline **2026-10-21T12:41:24.961804+00:00**, without restart or extension. Personal control is **{control}**. This epoch's physical repo custody at sequence{custody['sequence']} contains **{custody['cases']} cases, {custody['audio']} actual WAV files and {custody['files']} indexed files**;{value['freeBytes']}bytesfree. Parent custody retains293cases/271WAV and the physical terminalsummarySHAe64b0500.../partialsealSHA957240ab... . [Fresh primary-state receipt](CHECKPOINT_LINK).

The prior timeout's nativeSTT completed3406.206201ms; requesterPCinstance changed between before/after snapshots, but exactreply failurecause isUNKNOWN. No model-quality/runtime-failure claim or continuous-route claim follows from that timeout. Oldraw and frozen source remain preserved. Full§30.71 ownerplan765720B/SHA95ef8abe... is physically mirrored in thesis/methodology; monitor verified parent summary, seal and mirror and requested no further review.

OriginalRoot nativeaggregate goalACTIVE; RootsolemainSUT/reservation/integration, originalmonitorsolemethodologywriter. Phone/notebook remains separately assigned to its existing retained session; its laterSTARTpermission nevergates K3. LocalcodeSHAebde3a8a handedoff/singlepushworkflow-scoperejected/noauthchanges. No CPU/local/HTTP/closed900replay. K2P2P900closed; fullmatrix/full13remain open. V799 archiveUNLOCATED/C06finalrawUNKNOWN unchanged.

Next main check: **by {value['nextRoutineCheckUtc']}**, or immediately on actual terminal/error. Continue this same finite624epoch, preserving every request, failure and raw artifact.

'''
    for relative in ['docs/experiments/tcc-20261013-submission-20261030/root/CURRENT.md','.omx/ultragoal/ORCA-COORDINATION.md']:
        target=ROOT/relative;text=target.read_text();left='<!-- AURORA:ROOT:LIVE:START -->';right='<!-- AURORA:ROOT:LIVE:END -->';i=text.index(left)+len(left);j=text.index(right,i)
        target.write_text(text[:i]+block.replace('CHECKPOINT_LINK',os.path.relpath(path,target.parent))+text[j:])
    target=HANDOFF/'EXISTING-SESSION-CURRENT-V491.json';current=json.loads(target.read_bytes())
    current.update(currentPhase=f"K3 remaining624 {label};combined{combined['attempted']}/900={combined['correct']}correct+{combined['failed']}failed;{combined['remaining']}remain",activeValidation=str(DEST.relative_to(ROOT)),currentExecution=value)
    current['desktopControlCurrent']['reservedFor']='V2043 automatic finalizer' if finalizer_live else None
    reads=[p for p in HANDOFF.glob('k3-ordinary-warmup-proof-v2043-READ-*.json')if p.stem.rsplit('-',1)[1].isdigit()]
    if reads:
        last=max(reads,key=lambda p:int(p.stem.rsplit('-',1)[1]));current['desktopControlCurrent']['lastCursor']=json.loads(last.read_bytes())['result']['terminal']['nextCursor']
    target.write_text(json.dumps(current,indent=2)+'\n')
    message=(f"Fresh V2043 {label} at {value['at']}: newepoch{epoch['attempted']}/624={epoch['correct']}correct+{epoch['failed']}failed; "
             f"combined{combined['attempted']}/900={combined['correct']}correct+{combined['failed']}failed/{combined['timeouts']}timeouts, {combined['remaining']}remain. "
             f"Global277–900 only; parent276/20failures preserved, no retry276. Warmups{warm['attempted']}={warm['correct']}correct+{warm['failed']}failed, excluded. "
             f"{proof} All three original newWactors exact/live. Custodyseq{custody['sequence']}={custody['cases']}cases/{custody['audio']}WAV/{custody['files']}files, "
             f"{value['freeBytes']}bytesfree. Sameprovider251472/251473/deadline12:41:24UTC unchanged; control{control}. "
             f"Receipt {path.relative_to(ROOT)}; CURRENT+ORCA+samegoalrouting metadata updated from this explicit fresh receipt. "
             f"Nextcheck by{value['nextRoutineCheckUtc']} oractualterminal/error. RootMAINonly/phone separate; no newreview/test/worker/oldcohortreplay.")
    result=subprocess.run([sys.executable,'/tmp/aurora-orca-bounded-v43.py',message_name,'orchestration','send','--to','dispatch:ctx_37b4d0a3c14f','--run','run_e6054e76e9fc','--from','term_6a00d9ee-792a-4daf-8578-236290e33108','--subject',f"K3 {label}:combined{combined['attempted']}/900;remaining{combined['remaining']}",'--body',message,'--type','status','--json'],capture_output=True,text=True,timeout=45)
    print(result.stdout,end='');assert result.returncode==0
    print(json.dumps({'receipt':str(path),'combined':combined,'epoch':epoch,'nextCheck':value['nextRoutineCheckUtc'],'sutCalls':0}))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--receipt-name',required=True);parser.add_argument('--message-name',required=True);a=parser.parse_args();main(a.receipt_name,a.message_name)

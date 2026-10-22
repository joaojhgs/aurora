"""Root-only one-pass linking of newly completed control receipts.

The frozen requester owns all desktop writes. This utility reads only saved
worker files, preserves originals and links exact bytes into physical thesis
custody. Existing verified files are skipped without rehashing. No network,
model, device, build, cleanup, worker or source mutation is performed.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time

ROOT=Path('/home/developer/projects/aurora')
HANDOFF=ROOT/'.git/aurora-handoff-import-20261006'
CAMPAIGN=ROOT/'thesis/campaigns/c12-mixed-local-http-remaining640-v2453'
DEST=CAMPAIGN/'control/cli-custody'
PATTERN=re.compile(r'c12-v2453-pair-(\d{4})-page-\d{2}-.+')
MAX_READ_BYTES=8*1024**2


def main():
    started=time.monotonic_ns()
    current=json.loads((CAMPAIGN/'CURRENT.json').read_bytes())
    cutoff=current['lastOrdinal']
    assert current['manifestSha256']=='3bfca19d2dd0a9eec3981eae256168a5badd9ac2bb58a270ff8a55df1d986cce'
    assert DEST.is_dir()
    candidates=[];skipped=0
    with os.scandir(HANDOFF) as scan:
        for item in scan:
            match=PATTERN.fullmatch(item.name)
            if not match or int(match[1])>cutoff or not item.is_file(follow_symlinks=False):
                continue
            target=DEST/item.name
            if target.exists():
                skipped+=1
                continue
            candidates.append((int(match[1]),item.name,Path(item.path),target))
    if not candidates:
        return {'status':'NO_NEW_COMPLETED_CONTROLS','eligiblePairedCutoff':cutoff,
                'previousVerifiedFilesSkipped':skipped,'oldFilesRehashed':0,'newPayloadAllocations':0}
    assert shutil.disk_usage(ROOT).free>2*1024**3+2*1024**2
    linked=[];read_bytes=0;verified_pairs=set()
    for ordinal,name,source,target in sorted(candidates):
        if ordinal not in verified_pairs:
            assert (CAMPAIGN/'provider-custody'/f'{ordinal:04d}'/'CUSTODY.json').exists()
            verified_pairs.add(ordinal)
        before=source.stat()
        if read_bytes+before.st_size>MAX_READ_BYTES:
            break
        raw=source.read_bytes();after=source.stat()
        assert len(raw)==before.st_size==after.st_size and before.st_mtime_ns==after.st_mtime_ns
        os.link(source,target)
        copied=target.stat();assert copied.st_dev==after.st_dev and copied.st_ino==after.st_ino
        read_bytes+=len(raw)
        linked.append({'source':str(source.relative_to(ROOT)),'destination':str(target.relative_to(ROOT)),
                       'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'onePhysicalCopy':True})
    now=datetime.now(timezone.utc)
    receipt={'at':now.isoformat(),'status':'NEW_COMPLETED_CONTROLS_PHYSICALLY_LINKED',
             'currentSnapshotAt':current['at'],'eligiblePairedCutoff':cutoff,
             'previousVerifiedFilesSkipped':skipped,'oldFilesRehashed':0,
             'newFilesLinked':len(linked),'eligibleNewFiles':len(candidates),
             'allEligibleNewFilesLinked':len(linked)==len(candidates),
             'newBytesHashed':read_bytes,'maximumReadBytes':MAX_READ_BYTES,
             'newPayloadAllocations':0,'originalsDeletedOrModified':False,
             'remoteRuntimeModelOrDeviceCalls':0,'elapsedMs':(time.monotonic_ns()-started)/1e6,'files':linked}
    directory=CAMPAIGN/'control-link-receipts';directory.mkdir(exist_ok=True)
    target=directory/(now.strftime('%Y%m%dT%H%M%S.%fZ')+'.json')
    partial=target.with_suffix('.partial')
    with partial.open('x') as stream:
        json.dump(receipt,stream,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    os.replace(partial,target)
    return {**{k:v for k,v in receipt.items() if k!='files'},'receipt':str(target)}


if __name__=='__main__':
    print(json.dumps(main(),indent=2))

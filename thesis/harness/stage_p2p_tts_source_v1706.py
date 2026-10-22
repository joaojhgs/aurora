"""Copy a declared prior frozen inventory and only the reviewed route fix.

No live source/config is changed. No credentials, model assets or Git checkout
are copied. The output is a new repository-local scientific source snapshot.
"""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import os
import shutil


def sha(data):
    return hashlib.sha256(data).hexdigest()


def stage(source, inventory, destination, replacements):
    source, inventory, destination=map(Path,(source,inventory,destination))
    assert not destination.exists(), 'existing_snapshot_requires_reconciliation'
    assert shutil.disk_usage(destination.parent).free > 2*1024**3+20*1024**2
    expected={
        'app/shared/services/base_service.py':'580c691214761fcd6edef1c199731065151466c29be4aeccd7c096ac397778d6',
        'app/services/tts/service.py':'6e4386aaf219ca5f5488ed007c03519be64f8de56aa2cc17956b5140218f234e',
        'app/services/gateway/registry_aggregator.py':'306f731721f9f0daf309cc4c3ee1bc60dd4ad3f747b7e604523258e81ddab1de',
    }
    assert set(replacements)==set(expected)
    rows=json.loads(inventory.read_bytes())
    for name, digest in expected.items():
        assert sha((source/name).read_bytes())==digest, 'original_overlay_source_differs'
    destination.mkdir()
    output=destination/'source';output.mkdir()
    newrows=[];changes=[]
    for item in rows:
        name=item['path'];relative=Path(name)
        assert not relative.is_absolute() and '..'not in relative.parts
        original=source/relative
        assert original.is_file() and not original.is_symlink()
        raw=original.read_bytes()
        assert len(raw)==item['bytes'] and sha(raw)==item['sha256'], 'declared_source_drift'
        if name in replacements:
            raw=replacements[name]
            changes.append({'path':name,'oldSha256':item['sha256'],'newSha256':sha(raw),'bytes':len(raw)})
        p=output/relative;p.parent.mkdir(parents=True,exist_ok=True)
        with p.open('xb')as f:f.write(raw);f.flush();os.fsync(f.fileno())
        assert sha(p.read_bytes())==sha(raw)
        newrows.append({'path':name,'bytes':len(raw),'sha256':sha(raw)})
    newrows.sort(key=lambda x:x['path'])
    p=destination/'source-inventory.json';p.write_text(json.dumps(newrows,indent=2,sort_keys=True)+'\n')
    record={'at':datetime.now(timezone.utc).isoformat(),'sourceRoot':str(output.resolve()),
            'inventoryPath':str(p.resolve()),'inventorySha256':sha(p.read_bytes()),
            'files':len(newrows),'bytes':sum(x['bytes']for x in newrows),'changes':changes,
            'priorSource':str(source),'priorInventorySha256':sha(inventory.read_bytes()),
            'onlyDeclaredThreeFilesChanged':len(changes)==3,
            'historicalCpuHttpByteIdentity':False,
            'scope':'Runtime TTS route metadata only; model/audio/decoding/e2e correctness unchanged; old source/results retained',
            'activeSourceModified':False,'newModelCalls':0}
    (destination/'SOURCE-DELTA-RECEIPT.json').write_text(json.dumps(record,indent=2)+'\n')
    return record

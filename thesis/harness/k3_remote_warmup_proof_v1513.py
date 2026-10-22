"""Collect only the same15saved K3 warmups and45 exact model-handler joins."""
import base64
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import zlib

R=Path('/home/developer/projects/aurora')
H=R/'.git/aurora-handoff-import-20261006'
P=H/'distributed-k3-http-provider-v1476'
OUT=H/'distributed-k3-ordinary-proof-v1513'


def sha(data):return hashlib.sha256(data).hexdigest()


def main():
    payload=json.loads(zlib.decompress(base64.b64decode(sys.argv[1])))
    m=payload['manifest']
    assert sha((P/'input/provider-manifest.json').read_bytes())==m['providerManifestSha256']
    provider=json.loads((P/'input/provider-manifest.json').read_text())
    pid=m['providerReceiver']['pid']
    fields=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
    assert int(fields[19])==m['providerReceiver']['startTicks'] and fields[0]!='Z'
    config=Path(provider['launch_config']['path'])
    assert sha(config.read_bytes())==m['remoteAssistantConfigBinding']['config_sha256']
    assert not OUT.exists(),'Reconcile same saved-proof attempt; never repeat model requests'
    OUT.mkdir(mode=0o700);attempts=OUT/'attempts';attempts.mkdir(mode=0o700)
    correlations=set()
    for row in payload['attempts']:
        assert row['phase']=='warmup' and row['status']=='completed_correct'
        for stage in ['stt','assistant','tts']:correlations.add(row['stages'][stage]['server_correlation_id'])
        (attempts/f"attempt-{row['ordinal']:04d}-warmup.jsonl").write_text(json.dumps(row)+'\n')
    assert len(correlations)==45
    all_rows={};sources=[]
    for name,cap in [('voice-stages.jsonl',16*1024**2),('actual-provider-bindings.jsonl',4*1024**2)]:
        path=P/'runtime'/name
        with path.open('rb') as f:raw=f.read(cap+1)
        assert len(raw)<=cap
        raw=raw[:raw.rfind(b'\n')+1];all_rows[name]=[json.loads(line) for line in raw.splitlines() if line]
        sources.append({'path':str(path),'prefixBytes':len(raw),'sha256':sha(raw)})
    selected=[row for row in all_rows['voice-stages.jsonl'] if row.get('correlation_id') in correlations]
    (OUT/'all-selected-service-and-model-spans.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in selected))
    handlers={'stt.model_invoke','resolved_chat_model.astream','tts.model_invoke'}
    model_rows=[row for row in selected if row.get('handler') in handlers]
    (OUT/'voice-stages.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in model_rows))
    bindings=all_rows['actual-provider-bindings.jsonl']
    (OUT/'actual-provider-bindings.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in bindings))
    tts_spans={}
    for row in model_rows:
        if row.get('handler')=='tts.model_invoke':tts_spans.setdefault(row['span_id'],[]).append(int(row['monotonic_ns']))
    assert len(tts_spans)==15 and all(len(v)==2 for v in tts_spans.values())
    tts_windows=[(min(v),max(v)) for v in tts_spans.values()]
    model_bindings=[row for row in bindings if row.get('event') in ['stt_constructor_start','stt_constructor_return','llm_constructor_start','llm_constructor_return'] or row.get('event') in ['piper_cli_call_start','piper_cli_call_return'] and any(lo<=int(row.get('monotonicNs',0))<=hi for lo,hi in tts_windows)]
    assert sum(row.get('event')=='piper_cli_call_start' for row in model_bindings)==15
    assert sum(row.get('event')=='piper_cli_call_return' for row in model_bindings)==15
    (OUT/'model-window-bindings.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in model_bindings))
    stt=[v for v in bindings if v.get('event')=='stt_constructor_return' and v.get('pid')==pid]
    assert stt and all(v['actualDevice']=='cpu' and v['actualComputeType']=='int8_float32' and v['actualArguments']['model']==m['remoteReceivers']['stt']['constructor_directory'] and v['actualArguments']['device']=='cpu' and v['actualArguments']['compute_type']=='int8' for v in stt)
    llm=[v for v in bindings if v.get('event')=='llm_constructor_return' and v.get('pid')==pid]
    assert llm
    for v in llm:
        for key in ['model_path','n_gpu_layers','n_ctx','n_batch','n_threads','temperature','max_tokens','seed','top_p','top_k','repeat_penalty','min_p','chat_format','verbose']:
            assert v['actualArguments'][key]==m['remoteConfiguredLlm'][key],f'Actual LLM setting differs:{key}'
    with (P/'runtime/backend.private.log').open('rb') as f:raw=f.read(16*1024**2+1)
    assert len(raw)<=16*1024**2
    lines=raw.decode(errors='replace').splitlines()
    off=[re.search(r'offloaded (\d+)/(\d+) layers to GPU',line) for line in lines];off=[v for v in off if v]
    assert off and all(tuple(map(int,v.groups()))==(25,25) for v in off)
    gpu=[line for line in lines if 'Vulkan' in line and any(word in line for word in ['RX 7600','model buffer','device'])]
    assert gpu
    identities={}
    directory=Path(m['remoteReceivers']['stt']['constructor_directory'])
    for stage in ['stt','assistant','tts']:
        expected=m['remoteReceivers'][stage]
        if stage=='stt':
            files={'model':directory/'model.bin','config':directory/'config.json','tokenizer':directory/'tokenizer.json','vocabulary':directory/'vocabulary.txt'}
        elif stage=='assistant':files={'model':Path(m['remoteConfiguredLlm']['model_path']),'config':config}
        else:
            actual=json.loads(Path(provider['actual_provider_file_receipt']['path']).read_text())['actual_provider_files']
            files={k:Path(actual[k]['canonical_path']) for k in ['model','config']}
        actual_files={k:{'canonical_path':str(v),'sha256':expected[{'model':'model_sha256','config':'config_sha256','tokenizer':'tokenizer_sha256','vocabulary':'vocabulary_sha256'}[k]]} for k,v in files.items()}
        actual_files['source_receipt_sha256']=provider['actual_provider_file_receipt']['sha256']
        if stage=='stt':actual_files['model_directory']={'canonical_path':str(directory)}
        path=OUT/(stage+'-identity.json');path.write_text(json.dumps({'receiver_pid':pid,'provider':expected,'actual_provider_files':actual_files})+'\n');identities[stage]=path
    source=payload['proofSource'];assert sha(source.encode())=='40ac64685ffb078b9d9aa983916d20df9c218badc40ae46b29c7398e4a0d259f'
    (OUT/'receiver_proof.py').write_text(source)
    namespace={'__name__':'saved_k3_proof'};exec(compile(source,str(OUT/'receiver_proof.py'),'exec'),namespace)
    proof=namespace['build_proof'](attempts_dir=attempts,stage_path=OUT/'voice-stages.jsonl',bindings_path=OUT/'model-window-bindings.jsonl',identity_paths=identities,candidate_sha=m['candidateManifestSha256'],cohort_sha=payload['cohortSha256'],expected_receivers=m['remoteReceivers'])
    assert len(proof['calls'])==45
    result={'at':datetime.now(timezone.utc).isoformat(),'status':'K3_15_ORDINARY_WARMUPS_45_NATIVE_MODEL_JOINS_READY','proof':proof,'sourcePrefixes':sources,'actualSttConstructor':stt,'actualLlmConstructor':llm,'actualOffloadedLayers':25,'actualTotalLayers':25,'gpuEvidenceLines':gpu,'offloadEvidenceLine':off[0].group(),'modelCallsByCollector':0,'predicateModelSettingsOrSourceChanged':False}
    (OUT/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n')
    raw=base64.b64encode(json.dumps(result).encode()).decode();parts=[raw[i:i+1800] for i in range(0,len(raw),1800)]
    for i,part in enumerate(parts):print('AURORA_K3_PROOF_V1513 '+json.dumps({'seq':i,'total':len(parts),'data':part}),flush=True)


if __name__=='__main__':main()

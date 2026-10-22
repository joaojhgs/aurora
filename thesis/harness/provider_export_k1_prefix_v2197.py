from pathlib import Path
from datetime import datetime,timezone
import base64,hashlib,io,json,os,shutil,socket,tarfile,time
r=Path('/home/developer/projects/aurora');s=r/'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v1965/provider';d=s.parent/'provider-checkpoint-v2197'
assert socket.gethostname()=='personal.skyron-server';os.umask(0o077);os.nice(10)
assert not d.exists(),'Existing accepted checkpoint requires reconciliation, never duplicate'
mr=(s/'provider-manifest.json').read_bytes();assert hashlib.sha256(mr).hexdigest()=='716b893424f28ef19a1820820000c8a30fb6adbf87252c9f65e1bca30e717bb9'
m=json.loads(mr);cr=Path(m['config']).read_bytes();assert hashlib.sha256(cr).hexdigest()=='1b2e464a9dd2a191954504161862d3aa19a991126eb2b08c4de55a40778fd002'
actors=[]
for pid,ticks in [(251472,29038396),(251473,29038457)]:
 f=Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split();assert int(f[19])==ticks and f[0]not in ['Z','X','x'];actors.append({'pid':pid,'startTicks':ticks,'state':f[0]})
vr=(s/'voice-stages.jsonl').read_bytes();assert len(vr)<32*1024**2 and vr.endswith(b'\n');groups={}
for x in map(json.loads,vr.splitlines()):
 if x.get('record_kind')=='invocation_span_boundary':groups.setdefault(x['span_id'],set()).add(x['event'])
assert all(v=={'span_start','span_end'}for v in groups.values());assert time.time_ns()-(s/'voice-stages.jsonl').stat().st_mtime_ns>5_000_000_000
secrets=[]
def collect(x):
 if isinstance(x,dict):
  for k,v in x.items():
   if any(t in k.lower()for t in ['secret','password','api_key','access_token','refresh_token']):
    if isinstance(v,str)and len(v)>=8:secrets.append(v.encode())
   else:collect(v)
 elif isinstance(x,list):
  for v in x:collect(v)
collect(json.loads(cr));names=['provider-manifest.json','controller-launch.json','receiver-identity.json','assistant-identity.json','stt-identity.json','runtime-versions.json','ACTUAL-FILES-v1965.json','PREPARATION-v1965.json','ROOT-ADMISSION-v1966.json','ROOT-LAUNCH-v1966.json','STATUS.json','voice-stages.jsonl','actual-provider-bindings.jsonl','binding-guard-diagnostic.jsonl','resources.jsonl']
assert sum((s/n).stat().st_size for n in names)<256*1024**2;assert shutil.disk_usage(r).free>2*1024**3+288*1024**2
d.mkdir();records=[];archive=d/'provider-prefix-v2197.tar.gz';t0=time.monotonic()
with archive.open('xb')as output:
 with tarfile.open(fileobj=output,mode='w:gz',compresslevel=1)as tar:
  for name in names:
   assert time.monotonic()-t0<120;p=s/name;assert p.is_file()and not p.is_symlink()
   with p.open('rb')as f:st=os.fstat(f.fileno());data=f.read(st.st_size)
   assert len(data)==st.st_size
   if name.endswith('.jsonl'):data=data[:data.rfind(b'\n')+1]
   else:json.loads(data)
   assert not any(v in data for v in secrets),'Private value detected; source preserved/export withheld'
   item={'name':'raw/'+name,'source':str(p),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'sourceInode':st.st_ino,'observedSourceBytes':st.st_size,'terminalEOF':False,'completeLinePrefix':name.endswith('.jsonl')}
   info=tarfile.TarInfo(item['name']);info.size=len(data);info.mode=0o600;tar.addfile(info,io.BytesIO(data));records.append(item)
  seal={'at':datetime.now(timezone.utc).isoformat(),'status':'original_live_provider_fixed_prefix_snapshot','actors':actors,'providerRetired':False,'reservationPreserved':True,'nativeSpansAtBoundary':len(groups),'openNativeSpansAtBoundary':0,'files':records,'rawPayloadBytes':sum(x['bytes']for x in records),'originalFilesPreserved':True,'archiveContainsPhysicalCopies':True,'sutCalls':0,'K1MeasuredAttempted':900,'K1Correct':885,'K1Failed':15,'K1Remaining':0,'inheritedConditionEffectiveDeadlineUtc':'2026-10-21T12:41:24.961804+00:00','manifestOriginalProviderDeadlineUtc':m['originalProviderAbsoluteDeadlineUtc'],'deadlinePolicy':'Use earlier inherited effective condition bound; no extension or setting change','nativeCoverageScope':'K1 current global710-900 TTS-only remote; archive includes prior K3 and readiness rows. Join only exact current correlations; local STT/LLM traces use worker clock, no cross-host subtraction.'}
  sr=(json.dumps(seal,indent=2)+'\n').encode()
  with (d/'PROVIDER-PREFIX-SEAL.json').open('xb')as f:f.write(sr);f.flush();os.fsync(f.fileno())
  info=tarfile.TarInfo('PROVIDER-PREFIX-SEAL.json');info.size=len(sr);info.mode=0o600;tar.addfile(info,io.BytesIO(sr))
 output.flush();os.fsync(output.fileno())
v={k:v for k,v in seal.items()if k!='files'};v.update(host=socket.gethostname(),archive=str(archive),bytes=archive.stat().st_size,sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),sealSha256=hashlib.sha256(sr).hexdigest(),files=len(records),elapsedSeconds=time.monotonic()-t0)
with (d/'EXPORT-RECEIPT.json').open('x')as f:json.dump(v,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
out=base64.b64encode(json.dumps(v).encode()).decode();parts=[out[i:i+800]for i in range(0,len(out),800)]
for i,x in enumerate(parts):print('AURORA_K1_PROVIDER_PREFIX_V2197 '+json.dumps({'seq':i,'total':len(parts),'data':x}),flush=True)

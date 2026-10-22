"""Prepare one bounded read of the original Personal K3 provider; no SUT call."""
from pathlib import Path
import ast
import shlex

ROOT=Path('/home/developer/projects/aurora')
HANDOFF=ROOT/'.git/aurora-handoff-import-20261006'
code='''from pathlib import Path
from datetime import datetime,timezone
import base64,hashlib,json,shutil,socket,time
r=Path('/home/developer/projects/aurora');d=r/'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v1965/provider';pvt=r/'.git/aurora-handoff-import-20261006/k3-mesh-provider-v1965';corr='audio-campaign-0da10fbd23d148a18e86a15ece270e83'
assert socket.gethostname()=='personal.skyron-server'
v={'at':datetime.now(timezone.utc).isoformat(),'host':socket.gethostname(),'sutCalls':0,'correlation':corr,'actors':{},'files':{}}
for key,pid,ticks in [('controller',251472,29038396),('receiver',251473,29038457)]:
 p=Path('/proc',str(pid),'stat')
 if p.exists():
  f=p.read_text().rsplit(')',1)[1].split();v['actors'][key]={'pid':pid,'state':f[0],'startTicks':int(f[19]),'sameStart':int(f[19])==ticks}
 else:v['actors'][key]={'pid':pid,'state':'absent'}
for name in ['STATUS.json','controller-launch.json','ROOT-ADMISSION-v1966.json']:
 p=d/name
 if p.exists():
  raw=p.read_bytes();assert len(raw)<256*1024;x=json.loads(raw);v['files'][name]={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
  v[name]={k:x[k]for k in ['at','pid','host','phase','ownRuntimeRetired','error','errorCategory','errorClass','stopReason','stop_reason','controllerPid','controllerStartTicks','receiverPid','receiverStartTicks','finishedAt','exitCode','receiverExitCode','returnCode','providerDeadlineUtc']if k in x}
manifest=d/'provider-manifest.json';raw=manifest.read_bytes();v['manifestSha256']=hashlib.sha256(raw).hexdigest();m=json.loads(raw);cfg=Path(m['config']);v['configSha256']=hashlib.sha256(cfg.read_bytes()).hexdigest();v['originalDeadlineUtc']=m['originalProviderAbsoluteDeadlineUtc']
for name,cap in [('voice-stages.jsonl',16*1024**2),('binding-guard-diagnostic.jsonl',1024**2),('resources.jsonl',32*1024**2)]:
 p=d/name
 if not p.exists():v['files'][name]={'exists':False};continue
 with p.open('rb')as f:raw=f.read(cap+1)
 assert len(raw)<=cap,'bounded_provider_file_read_cap'
 raw=raw[:raw.rfind(b'\\n')+1];rows=[json.loads(x)for x in raw.splitlines()if x];selected=[x for x in rows if x.get('correlation_id')==corr or x.get('correlationId')==corr]
 v['files'][name]={'exists':True,'prefixBytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'rows':len(rows),'completeLinePrefix':True}
 v[name]={'matchedCorrelationRows':selected[-12:],'lastRows':rows[-2:]if name!='binding-guard-diagnostic.jsonl'else[]}
v['memAvailableBytes']=next(int(x.split()[1])*1024 for x in Path('/proc/meminfo').read_text().splitlines()if x.startswith('MemAvailable:'));v['freeBytes']=shutil.disk_usage(r).free
raw=base64.b64encode(json.dumps(v).encode()).decode();parts=[raw[i:i+800]for i in range(0,len(raw),800)]
for i,x in enumerate(parts):print('AURORA_K3_PROVIDER_RECONCILE_V2039 '+json.dumps({'seq':i,'total':len(parts),'data':x}),flush=True);time.sleep(.005)
'''
ast.parse(code)
assert any(isinstance(n,ast.Constant)and n.value==b'\n'for n in ast.walk(ast.parse(code)))
p=HANDOFF/'read-k3-provider-reconcile-v2039.command.txt';assert not p.exists();p.write_text('python3 -c '+shlex.quote(code)+'\n')

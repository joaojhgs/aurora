"""One normal STT feature-consent update after exact zero-audio provider retirement.

No new credentials, broad grants, direct permission SQL, listener or model calls.
"""
from pathlib import Path
from datetime import datetime,timezone
import asyncio,base64,fcntl,hashlib,json,os,socket,sys,time,traceback,tarfile
R=Path('/home/developer/projects/aurora');H=R/'.git/aurora-handoff-import-20261006'
SIDE=sys.argv[1]
assert SIDE in ['worker','personal']
OUT=R/'thesis/evidence/k3-stt-task-consent-v1934'/SIDE
PRIVATE=H/('k3-stt-task-consent-v1934-'+SIDE)
def now():return datetime.now(timezone.utc).isoformat()
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def write(p,v):
 with Path(p).open('x') as f:json.dump(v,f,indent=2,sort_keys=True);f.write('\n');f.flush();os.fsync(f.fileno())
def absent(pid):return not Path('/proc',str(pid)).exists()
async def consent(m):
    from app.helpers.aurora_logger import logger as aurora_logger
    aurora_logger.logger.addFilter(lambda record: False)
    from app.messaging.local_bus import LocalBus
    from app.messaging.bus_runtime import set_bus as set_runtime_bus
    from app.shared.messaging.bus_init import set_bus
    from app.services.config.service import ConfigService
    from app.services.db.service import DBService
    from app.services.auth.service import AuthService
    from app.shared.contracts.models.auth import AuthMethods
    from app.shared.contracts.models.mesh import (
        MeshIdentityLoadRequest, MeshPeerListRequest, MeshPeerListResponse, MeshPeerUpdatePermissionsRequest,
    )
    from app.shared.contracts.models.stt import TranscriptionMethods

    def unwrap(result):
        assert result.ok, 'normal_typed_API_failed_no_direct_DB_fallback'
        return result.data

    bus = LocalBus(); set_bus(bus); set_runtime_bus(bus); await bus.start()
    try:
        config = ConfigService(); await config._subscribe_registered_contracts()
        db = DBService(str(Path(m['existingDataDir']) / 'aurora.db'))
        await db._subscribe_registered_contracts()
        await db.db_manager.initialize(); await db.scheduler_db.initialize()
        auth = AuthService(); await auth._subscribe_registered_contracts()
        await auth.on_start(); await config.on_start()
        identity = unwrap(await bus.request(AuthMethods.LOAD_MESH_IDENTITY, MeshIdentityLoadRequest(), timeout=10))
        if hasattr(identity, 'model_dump'):
            identity = identity.model_dump(mode='json')
        assert identity['peer_id'] == m['expectedStablePeerId'], 'existing_identity_changed'
        before = MeshPeerListResponse.model_validate(unwrap(await bus.request(
            AuthMethods.MESH_LIST_PEERS, MeshPeerListRequest(), timeout=10)))
        target = next(p for p in before.peers if p.peer_id == m['expectedRequesterPeerId'])
        old = list(target.outbound_permissions)
        assert target.outbound_status == 'approved'
        assert set(old) == {'Gateway.GetRegistry', 'Gateway.GetMeshStatus', 'TTS.Synthesize', 'Orchestrator.use'}
        import ast
        contract_path = Path(m['sourceRoot']) / 'app/services/stt_transcription/service.py'
        tree = ast.parse(contract_path.read_bytes())
        requirements = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
                for decorator in node.decorator_list:
                    if not isinstance(decorator, ast.Call): continue
                    fields = {k.arg: k.value for k in decorator.keywords}
                    method = fields.get('method_id')
                    if isinstance(method, ast.Attribute) and method.attr == 'TRANSCRIBE':
                        req = fields.get('required_perms')
                        assert isinstance(req, ast.List) and len(req.elts) == 1
                        item = req.elts[0]
                        assert isinstance(item, ast.Attribute) and isinstance(item.value, ast.Name)
                        assert item.value.id == 'TranscriptionMethods' and item.attr == 'TRANSCRIBE'
                        requirements.append([TranscriptionMethods.TRANSCRIBE])
        assert requirements == [['Transcription.Transcribe']]
        required = requirements[0]
        requested = old + required
        contract_receipt = {'method': TranscriptionMethods.TRANSCRIBE, 'requiredPermissions': required,
                            'source': str(contract_path), 'sourceSha256': sha(contract_path),
                            'priorPermissionsPreserved': old}
        write(OUT / 'ACTUAL-REGISTERED-CONTRACT.json', contract_receipt)
        write(OUT / 'AUTH-MUTATION-INTENT.json', {'at': now(), 'method': AuthMethods.MESH_UPDATE_PEER_PERMISSIONS,
            'peerId': target.peer_id, 'oldPermissions': old, 'newPermissions': requested,
            'maximumMutationCalls': 1, 'authority': 'owner30.56.1/RootACKmsg_142e2c492f54/monitorb067fb2256da'})
        response = unwrap(await bus.request(AuthMethods.MESH_UPDATE_PEER_PERMISSIONS,
            MeshPeerUpdatePermissionsRequest(peer_id=target.peer_id, permissions=requested),
            origin='internal', principal_id='system', timeout=20))
        if hasattr(response, 'model_dump'):
            response = response.model_dump(mode='json')
        assert response['success'] is True, 'normal_consent_update_not_successful_reconcile_never_repeat'
        after = MeshPeerListResponse.model_validate(unwrap(await bus.request(
            AuthMethods.MESH_LIST_PEERS, MeshPeerListRequest(), timeout=10)))
        peer = next(p for p in after.peers if p.peer_id == target.peer_id)
        assert set(peer.outbound_permissions) == set(requested)
        assert peer.inbound_permissions == target.inbound_permissions
        assert peer.outbound_status == peer.inbound_status == 'approved'
        return {'status': 'NORMAL_EXISTING_TEST_PAIR_TASK_CONSENT_APPLIED_VERIFIED',
                'peerId': peer.peer_id, 'localStablePeerId': identity['peer_id'],
                'beforePermissions': old, 'afterPermissions': list(peer.outbound_permissions),
                'reversePermissionsUnchanged': list(peer.inbound_permissions),
                'scope': 'Only deployed required Transcription.Transcribe added to same approved test pair; prior/reverse grants preserved',
                'contract': contract_receipt,
                'mutationMethod': AuthMethods.MESH_UPDATE_PEER_PERMISSIONS, 'mutationCalls': 1,
                'newIdentity': False, 'newCredential': False, 'modelServicesStarted': [],
                'modelCalls': 0, 'networkListenerStarted': False, 'directPermissionDBEdits': False}
    finally:
        await bus.stop()


def main():
 os.umask(0o077)
 assert socket.gethostname()==('code-worker' if SIDE=='worker' else 'personal.skyron-server')
 assert not OUT.exists() and not PRIVATE.exists(),'Reconcile exact existing operation; never repeat a mutation'
 lock=Path('/tmp/aurora-global-build.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 if SIDE=='personal':
  B=R/'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v1912/provider'
  assert all(absent(p) for p in [161159,161160])
  assert sha(B/'provider-manifest.json')=='ff1d2edc13fe65e646dccad691f4c0a3f83f31b224b796ef5f752402ce298e69'
  m=json.loads((B/'provider-manifest.json').read_text());assert sha(m['config'])==m['configSha256']
  terminal=json.loads((B/'terminal.json').read_text());assert terminal['receiverAbsent'] and terminal['exitCode']==0
  assert json.loads((B/'STATUS.json').read_text())['ownRuntimeRetired'] is True
  config=json.loads(Path(m['config']).read_text())
 else:
  assert all(absent(p) for p in [3061666,3061871,3061668])
  profile=H/'mesh-pair-control-v1535/worker-node-v1538'
  m={'sourceRoot':str(R/'thesis/sources/k3-stt-runtime-v1907/worker/source'),'existingDataDir':str(profile/'data'),'existingEnvFile':str(profile/'.env'),'expectedStablePeerId':'aurora-03a910366bf721d72a9ef481d2e08fbd','expectedRequesterPeerId':'aurora-276bb04e1276201922851f6a222110de'}
  config=json.loads((H/'distributed-k3-mesh-launch-v1924/runtime-config.frozen.json').read_text())
 OUT.mkdir(parents=True);PRIVATE.mkdir(mode=0o700)
 if SIDE=='personal':
  rows=[]
  for p in sorted(B.iterdir()):
   if p.is_file() and not p.is_symlink() and p.suffix in ['.json','.jsonl']:
    a=p.stat();h=sha(p);b=p.stat();assert(a.st_ino,a.st_size,a.st_mtime_ns)==(b.st_ino,b.st_size,b.st_mtime_ns)
    rows.append({'name':p.name,'bytes':b.st_size,'sha256':h,'terminalEOF':True})
  seal={'at':now(),'terminal':terminal,'actorsAbsent':[161159,161160],'files':rows,'rawPayloadBytes':sum(x['bytes']for x in rows),'requesterWarmups':0,'requesterMeasured':0,'originalsPreserved':True}
  write(OUT/'PROVIDER-EOF-SEAL.json',seal)
  archive=OUT/'original-zero-audio-provider.tar.gz'
  with tarfile.open(archive,'w:gz',compresslevel=3) as t:
   t.add(OUT/'PROVIDER-EOF-SEAL.json',arcname='PROVIDER-EOF-SEAL.json')
   for z in rows:t.add(B/z['name'],arcname=z['name'],recursive=False)
  write(OUT/'PROVIDER-ARCHIVE.json',{'archive':str(archive),'bytes':archive.stat().st_size,'sha256':sha(archive),'rawPayloadBytes':seal['rawPayloadBytes'],'files':len(rows),'zeroAudio':True,'originalsPreserved':True})
 config['services']['gateway']['enabled']=False
 config['services']['gateway']['webrtc']['enabled']=False
 config['services']['gateway']['mesh_network']['enabled']=False
 write(PRIVATE/'config.json',config)
 assert(Path(m['existingDataDir'])/'aurora.db').is_file()
 os.environ.update(AURORA_CONFIG_FILE=str(PRIVATE/'config.json'),AURORA_ENV_FILE=m['existingEnvFile'],AURORA_DATA_DIR=m['existingDataDir'],AURORA_BACKUP_DIR=str(PRIVATE/'backups'),AURORA_ARCHITECTURE_MODE='threads',PYTHONDONTWRITEBYTECODE='1')
 from dotenv import load_dotenv
 load_dotenv(m['existingEnvFile'],override=False)
 sys.path.insert(0,m['sourceRoot']);os.chdir(PRIVATE)
 value=asyncio.run(asyncio.wait_for(consent(m),timeout=90));value.update(at=now(),host=socket.gethostname(),side=SIDE,priorFrozenConfigUnchanged=True)
 if SIDE=='personal':
  assert sha(m['config'])==m['configSha256'];value['providerArchive']=json.loads((OUT/'PROVIDER-ARCHIVE.json').read_text())
 write(OUT/'RESULT.json',value);return value
if __name__=='__main__':
 try:v=main()
 except Exception as e:
  v={'at':now(),'status':'SAME_CONTROL_RECONCILIATION_REQUIRED','errorCategory':type(e).__name__,'error':str(e),'location':[{'function':f.name,'line':f.lineno}for f in traceback.extract_tb(e.__traceback__)[-4:]],'automaticRetry':False}
  if OUT.exists() and not(OUT/'FAILURE.json').exists():write(OUT/'FAILURE.json',v)
 if SIDE=='personal':
  s=base64.b64encode(json.dumps(v).encode()).decode();parts=[s[i:i+800]for i in range(0,len(s),800)]
  for i,z in enumerate(parts):print('AURORA_K3_STT_CONSENT_V1934 '+json.dumps({'seq':i,'total':len(parts),'data':z}),flush=True)
 else:print(json.dumps(v),flush=True)

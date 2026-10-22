"""Existing worker's normal task consent and one model-free route admission."""
from pathlib import Path
from datetime import datetime,timezone
import asyncio,fcntl,hashlib,json,os,socket,sys,time,traceback
R=Path('/home/developer/projects/aurora')
H=R/'.git/aurora-handoff-import-20261006'
PRIVATE=H/'k2-worker-task-consent-v1816'
OUT=R/'thesis/evidence/k2-peer-consent-20261020/worker-control-v1816'
def now():return datetime.now(timezone.utc).isoformat()
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def write(p,v):
 with p.open('x')as f:json.dump(v,f,indent=2,sort_keys=True);f.write('\n');f.flush();os.fsync(f.fileno())

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
    from app.shared.contracts.models.orchestrator import OrchestratorMethods

    def unwrap(result):
        assert result.ok, 'normal_typed_API_failed_no_direct_DB_fallback'
        return result.data

    gateway = None
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
        assert set(old) == {'Gateway.GetRegistry', 'Gateway.GetMeshStatus', 'TTS.Synthesize'}
        import ast
        contract_path = Path(m['sourceRoot']) / 'app/services/orchestrator/service.py'
        tree = ast.parse(contract_path.read_bytes())
        requirements = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
                for decorator in node.decorator_list:
                    if not isinstance(decorator, ast.Call):
                        continue
                    fields = {k.arg: k.value for k in decorator.keywords}
                    method = fields.get('method_id')
                    if isinstance(method, ast.Attribute) and method.attr == 'EXTERNAL_USER_INPUT':
                        requirements.append(ast.literal_eval(fields['required_perms']))
        assert requirements == [['Orchestrator.use']], 'Actual deployed contract permissions must be exact'
        required = requirements[0]
        requested = [p for p in old if p != OrchestratorMethods.EXTERNAL_USER_INPUT] + required
        contract_receipt = {'method': OrchestratorMethods.EXTERNAL_USER_INPUT, 'requiredPermissions': required,
                            'source': str(contract_path), 'sourceSha256': sha(contract_path),
                            'unusedMethodNamePermissionRemoved': OrchestratorMethods.EXTERNAL_USER_INPUT}
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
        from app.services.gateway.service import GatewayService
        from app.shared.contracts.models.gateway import (
            GatewayMethods, CapabilityCatalogRequest, CapabilityCatalogResponse,
            RouteExplainRequest, RouteExplainResponse, RouteExplainSpeechConstraints,
        )
        from app.shared.contracts.models.mesh import MeshAddressSelector, MeshPeerAuthoritySnapshotRequest
        from app.shared.contracts.models.tts import TTSMethods
        snapshot = unwrap(await bus.request(AuthMethods.MESH_GET_AUTHORITY_SNAPSHOT,
            MeshPeerAuthoritySnapshotRequest(peer_id=peer.peer_id), timeout=10))
        if hasattr(snapshot, 'model_dump'):
            snapshot = snapshot.model_dump(mode='json')
        write(OUT / 'LOCAL-AUTHORITY-SNAPSHOT.json', snapshot)
        gateway = GatewayService(); await gateway._subscribe_registered_contracts()
        await asyncio.wait_for(gateway.on_start(), timeout=120)
        deadline = time.monotonic() + 120
        admitted = False; routes = {}; providers = []
        while time.monotonic() < deadline:
            catalog = CapabilityCatalogResponse.model_validate(unwrap(await bus.request(
                GatewayMethods.GET_CAPABILITY_CATALOG,
                CapabilityCatalogRequest(modules=['Orchestrator','TTS'], include_schemas=False), timeout=10)))
            assert catalog.local_peer_id == m['expectedStablePeerId']
            routes = {}; admitted = True
            for name, topic, speech in [('assistant',OrchestratorMethods.EXTERNAL_USER_INPUT,None),
                                        ('tts',TTSMethods.SYNTHESIZE,RouteExplainSpeechConstraints())]:
                value = RouteExplainResponse.model_validate(unwrap(await bus.request(
                    GatewayMethods.EXPLAIN_ROUTE, RouteExplainRequest(topic=topic, speech=speech,
                        selector=MeshAddressSelector(peer_id=peer.peer_id)), timeout=10)))
                routes[name] = value.model_dump(mode='json')
                admitted = admitted and value.selector_valid and value.selected_peer_id == peer.peer_id and not value.blockers and not value.security_privacy_blockers
            providers = [{k:p.model_dump(mode='json').get(k) for k in ['provider_id','module','peer_id','eligible','status']}
                         for p in catalog.providers if p.peer_id == peer.peer_id]
            if admitted: break
            await asyncio.sleep(2)
        write(OUT / 'NORMAL-MODEL-FREE-ROUTE-ADMISSION.json', {'at':now(),
            'admitted':admitted,'routes':routes,'providers':providers,'modelRequests':0,
            'modelServicesStarted':[],'normalGatewayControlPlane':True})
        assert admitted, 'exact_both_routes_not_admitted_no_model_launch'
        return {'status': 'NORMAL_EXISTING_TEST_PAIR_TASK_CONSENT_APPLIED_VERIFIED',
                'peerId': peer.peer_id, 'localStablePeerId': identity['peer_id'],
                'beforePermissions': old, 'afterPermissions': list(peer.outbound_permissions),
                'reversePermissionsUnchanged': list(peer.inbound_permissions),
                'scope': 'Only deployed required Orchestrator.use replaces unused method-name scope on same approved test pair',
                'contract': contract_receipt,
                'mutationMethod': AuthMethods.MESH_UPDATE_PEER_PERMISSIONS, 'mutationCalls': 1,
                'newIdentity': False, 'newCredential': False, 'modelServicesStarted': [],
                'modelCalls': 0, 'networkListenerStarted': False, 'directPermissionDBEdits': False,
                'normalModelFreeBothRoutesAdmitted': True, 'routeProof': str(OUT/'NORMAL-MODEL-FREE-ROUTE-ADMISSION.json')}
    finally:
        if gateway is not None:
            await asyncio.wait_for(gateway.on_stop(), timeout=20)
        await bus.stop()


def main():
 os.umask(0o077);assert socket.gethostname()=='code-worker'
 assert not PRIVATE.exists()and not OUT.exists(),'existing control requires reconciliation'
 assert not any(Path('/proc',str(p)).exists()for p in [2803675,2803694,2803867,2803868])
 lock=Path('/tmp/aurora-global-build.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 PRIVATE.mkdir(mode=0o700);OUT.mkdir(parents=True)
 config=json.loads((H/'distributed-k2-mesh-launch-v1813/runtime-config.frozen.json').read_bytes())
 config['services']['gateway']['enabled']=False
 write(PRIVATE/'config.json',config)
 profile=H/'mesh-pair-control-v1535/worker-node-v1538'
 assert(profile/'data/aurora.db').is_file()
 os.environ.update(AURORA_CONFIG_FILE=str(PRIVATE/'config.json'),AURORA_ENV_FILE=str(profile/'.env'),AURORA_DATA_DIR=str(profile/'data'),AURORA_BACKUP_DIR=str(PRIVATE/'backups'),AURORA_ARCHITECTURE_MODE='threads',PYTHONDONTWRITEBYTECODE='1')
 from dotenv import load_dotenv
 load_dotenv(profile/'.env',override=False)
 source=R/'thesis/sources/python-audio-p2p-tts-wiring-v1706/source';sys.path.insert(0,str(source));os.chdir(PRIVATE)
 m={'sourceRoot':str(source),'existingDataDir':str(profile/'data'),'expectedStablePeerId':'aurora-03a910366bf721d72a9ef481d2e08fbd','expectedRequesterPeerId':'aurora-276bb04e1276201922851f6a222110de'}
 result=asyncio.run(asyncio.wait_for(consent(m),timeout=300));result.update(at=now(),host=socket.gethostname(),scopeSide='worker local authority for existing Personal peer')
 write(OUT/'RESULT.json',result);return result
if __name__=='__main__':
 try:value=main()
 except Exception as e:
  value={'at':now(),'status':'WORKER_CONTROL_REQUIRES_SAME_STATE_RECONCILIATION','errorCategory':type(e).__name__,'error':str(e),'location':[{'function':f.name,'line':f.lineno}for f in traceback.extract_tb(e.__traceback__)[-4:]],'automaticRetry':False}
  if OUT.exists()and not(OUT/'FAILURE.json').exists():write(OUT/'FAILURE.json',value)
 print(json.dumps(value),flush=True)

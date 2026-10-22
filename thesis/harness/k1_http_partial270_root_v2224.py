"""Original Root's single missing720 HTTP requester launch; all admission is real."""
from pathlib import Path
from datetime import datetime, timezone, timedelta
import ast
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

ROOT=Path(__file__).resolve().parents[2]
H=ROOT/'.git/aurora-handoff-import-20261006'
OP=H/'distributed-k1-orca-relayed-http-launch-v2224'
CELL=H/'distributed-k1-orca-relayed-http-cell-v2224'
STAGE=H/'distributed-k1-http-requester-v2224'
DEST=ROOT/'thesis/campaigns/worker-desktop-k1-orca-relayed-http-first270-v2224'
PYTHON=H/'cpu-audio-campaign-v491/env/bin/python'
SOURCE=ROOT/'thesis/sources/k1-speech-contract-compat-v2151/worker/source'
CONFIG=H/'distributed-k1-orca-relayed-launch-v1197/runtime-config.json'
ENDPOINT='http://127.0.0.1:18000/api/TTS/Synthesize'


def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
    return h.hexdigest()


def write(path,value):
    with path.open('x') as stream:
        json.dump(value,stream,indent=2,sort_keys=True);stream.write('\n');stream.flush();os.fsync(stream.fileno())


def actor(pid):
    fields=Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split()
    return {'pid':pid,'state':fields[0],'startTicks':int(fields[19])}


def existing_key():
    import runpy
    helper=ROOT/'thesis/harness/existing_worker_desktop_http_bearer_v2223.py'
    return runpy.run_path(str(helper))['existing_bearer']()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None


def launch():
    os.umask(0o077)
    assert os.uname().nodename=='code-worker'
    assert not CELL.exists() and not DEST.exists() and not (OP/'LAUNCH-INTENT.json').exists()
    assert all(not Path('/proc',str(pid)).exists() for pid in [3332811,3332919,3333678])
    with Path('/tmp/aurora-global-build.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    allocation=json.loads((OP/'SESSION-ALLOCATION.json').read_bytes())
    assert (datetime.fromisoformat(allocation['absoluteDeadlineUtc'])-datetime.fromisoformat(allocation['startedAtUtc'])).total_seconds()==60000
    ready=json.loads((OP/'provider-admission.json').read_bytes())
    assert ready['status']=='K1_HTTP_PROVIDER_LIVE_METADATA_ADMITTED_NATIVE_WARMUPS_PENDING'
    auth=json.loads((ROOT/'thesis/evidence/k1-http-remaining720-admission-v2204/PROTECTED-HTTP-AUTH-v2223.json').read_bytes())
    assert auth['httpStatus']==200 and auth['status']=='EXISTING_PEER_BEARER_PROTECTED_HTTP_READ_PASSED'
    assert (datetime.now(timezone.utc)-datetime.fromisoformat(auth['at'])).total_seconds()<900
    assert all(not Path('/proc',str(pid)).exists()for pid in [3728513,3728572,3728514,3728515])
    assert datetime.fromisoformat(ready['providerDeadlineUtc'])<=datetime.fromisoformat(allocation['absoluteDeadlineUtc'])-timedelta(seconds=2400)
    preparation=json.loads((ROOT/'thesis/harness/distributed-k1-http-first270-v2224/PREPARATION.json').read_bytes())
    for item in preparation['sourceFiles']:
        p=STAGE/item['path'];assert p.is_file() and not p.is_symlink() and p.stat().st_size==item['bytes'] and sha(p)==item['sha256']
    assert sha(STAGE/'source-inventory.json')=='000202cdddb9803d503fc44f8aaf58eb469475890751a310193418330aa79937'
    assert sha(CONFIG)=='2b8cc043fc75c8978e2528379badb9fff7cd2ad2bc82729e61c560d35bbd1cc1'
    cfg=json.loads(CONFIG.read_bytes());assert cfg['ui']['assistant']['automatic_tts_readback'] is False
    memory=next(int(v.split()[1])*1024 for v in Path('/proc/meminfo').read_text().splitlines() if v.startswith('MemAvailable:'))
    assert memory>2_500_000_000 and shutil.disk_usage(ROOT).free>2*1024**3+128*1024**2
    key=existing_key();health=auth

    write(OP/'existing-route-health-new-provider.json',health)
    parent=ROOT/'thesis/evidence/k1-http-remaining720-offline-prep-v2173/PARENT-FROZEN-CONDITION.json'
    assert sha(parent)=='6bc65cf5cc3c4eddb90b80b0764a01e6a9fc4afbed66f33c731e3ab58528e101'
    m=json.loads(parent.read_bytes())
    for name in ['actualSourceModelRuntimeOrResourceAdmissionPerformed','freshResources','remainingActualAdmission','originalProviderRevalidationSha256','existingProviderOuterDeadlineUTC','precedingPrestartFailure','replacementFor']:
        m.pop(name,None)
    impl={'runnerSha256':'runner.py','controllerSha256':'controller.py','adapterSha256':'tts_http_adapter.py','bootstrapSha256':'bootstrap.py',
          'bindingsSha256':'bindings.py','observerSha256':'observer.py','telemetrySha256':'aurora_voice_telemetry_v430.py',
          'resourceSamplerSha256':'resource_sample.py','receiverProofSha256':'receiver_proof.py'}
    witness=ROOT/'thesis/evidence/k1-http-remaining720-admission-v2204/SOURCE-WITNESS-v2220.json'
    m.update(schema='aurora.k1.http_remaining_condition.v2224',cohortId='aurora-worker-desktop-k1-orca-relayed-http-first270-v2224',
        freezeAt=datetime.now(timezone.utc).isoformat(),status='FROZEN_ONLY181_450_REAL15_NATIVE_WARMUPS_PENDING',
        implementation={k:sha(STAGE/v) for k,v in impl.items()},runtimeConfigSha256=sha(CONFIG),
        immutableRuntimeConfigInput={'path':str(CONFIG),'bytes':CONFIG.stat().st_size,'sha256':sha(CONFIG),'referenceOnlyNoCredentialCopy':True},
        runtimeConfigCopyPolicy='Existing private operational configuration referenced; parentfrozeninput untouched; no config/env/credential copy',
        sourceClosure={'cpuSourceRoot':str(SOURCE),'cpuSourceInventorySha256':sha(STAGE/'source-inventory.json'),
            'equivalenceVerified':True,'equivalenceScope':'Exact latestK1P2P400file snapshot, matching localSTT/LLM configurations; oldHTTP4file source delta and separate latency strata retained',
            'witness':str(witness.relative_to(ROOT)),'witnessSha256':sha(witness)},
        measurementPlan={'plannedMeasuredPerCondition':900,'plannedWarmups':15,'plannedEpochMeasured':270,'requestCapSeconds':180,
                         'conditionOverallCapSeconds':24000,'controllerOuterCapSeconds':24300,'sessionAllInclusiveCapSeconds':60000},
        prospectiveSessionAllocation=allocation,
        cumulativeConditionBudget={'conditionCapSeconds':72000,'priorUsedSeconds':10027.780472366,'historicalParentOperationalCapSeconds':57600,
            'policy':'Explicit prospective allocation per solemonitor30.73; parent900target/57600cap and all10027.780472366charges preserved; not a nativegoalbudget or hidden oldclock extension'},
        epochLineage={'epochId':'V2224','parentManifestSha256':'6bc65cf5cc3c4eddb90b80b0764a01e6a9fc4afbed66f33c731e3ab58528e101',
            'parentSealSha256':'613158562e914f5d952f009b87c3d6438b350d4809d6a97f9bf82ed301918829',
            'priorAttemptedMeasured':180,'priorCorrect':179,'priorFailed':1,'plannedEpochMeasured':270,
            'firstConditionMeasuredIndex':181,'lastConditionMeasuredIndex':450,'conditionTargetMeasured':900,'failed180Retried':False},
        remoteTtsReceiver=ready['manifest']['remoteMeshTtsReceiver'],providerManifestSha256=ready['manifestSha256'],
        providerDeadlineUtc=ready['providerDeadlineUtc'],providerReceiver=ready['receiver'],
        providerRuntimeConfigSha256=ready['configSha256'],providerOutput=ready['manifest']['output'],
        remoteTtsEndpointSha256=hashlib.sha256(ENDPOINT.encode()).hexdigest(),remoteTtsAuthBinding='existing_authorized_peer_bearer',
        stagePlacement={'stt':'workerCPU','llm':'workerCPU','tts':'Personal PiperCPU'},
        transportClassification='ORCA_RELAYED_HTTP_EXISTING_INTERMEDIARY_NOT_DIRECT_HTTP_OR_MESH',
        authAdmission=auth,precedingStartupFailure={'epoch':'V2220','warmupsAttempted':1,'warmupsFailed':1,'measuredAttempted':0,'cause':'historicalAPIkeyNotConfiguredForCurrentProvider','retained':True},
        comparisonPolicy='Existing approved peerBearer HTTP identity differs from historical APIkey; stratify auth/source/residency. LatestP2P app source/configuration matched; parentHTTP history retained, epoch/source/residency latency stratified; no pure-protocol-overhead claim',
        freshWorkerResources={'at':datetime.now(timezone.utc).isoformat(),'memAvailableBytes':memory,'freeBytes':shutil.disk_usage(ROOT).free},
        remainingActualAdmission=['15correct ordinaryfullaudio excludedwarmups','actual localSTT/LLM and newreceiverTTS native joins','postwarmup conservative270capacity','firstnew181case+validWAV'])
    m['effectiveSetup']['tts']['provider']=m['remoteTtsReceiver']
    DEST.mkdir(parents=True,exist_ok=False)
    write(OP/'config-reference.json',m['immutableRuntimeConfigInput'])
    frozen=OP/'condition-frozen-v2224.json';write(frozen,m);write(DEST/'condition-frozen.json',m)
    write(DEST/'EXISTING-ROUTE-HEALTH.json',health)
    write(OP/'LAUNCH-INTENT.json',{'at':datetime.now(timezone.utc).isoformat(),'maximumControllerPopen':1,
        'maximumCopierPopen':1,'maximumProofFinalizerPopen':1,'frozenManifestSha256':sha(frozen),'newOrcaWorkers':0})
    env=os.environ.copy();env.update(m['effectiveEnvironment'])
    env.update(VIRTUAL_ENV=str(PYTHON.parent.parent),PATH=str(PYTHON.parent)+os.pathsep+env.get('PATH',''),
        AURORA_TOKEN_SECRET=cfg['services']['gateway']['api']['token_secret'],AURORA_CONFIG_FILE=str(CONFIG),
        AURORA_OUTPUT_DIR=str(CELL/'campaign'),AURORA_FROZEN_MANIFEST=str(frozen),AURORA_FROZEN_MANIFEST_SHA256=sha(frozen),
        AURORA_K1_SOURCE_ROOT=str(SOURCE),AURORA_K1_PYTHON=str(PYTHON),AURORA_K1_REMOTE_TTS_ENDPOINT=ENDPOINT,
        AURORA_K1_HTTP_BEARER=key,HF_HOME=str(CELL/'hf-cache'),UV_CACHE_DIR=str(CELL/'uv-cache'))
    for name,field in [('CONTROLLER','controllerSha256'),('RUNNER','runnerSha256'),('ADAPTER','adapterSha256')]:
        env['AURORA_K1_'+name+'_SHA256']=m['implementation'][field]
    for name,item in m['canonicalModelFiles'].items():
        env['AURORA_K1_'+('TTS_CONFIG_PATH' if name=='tts_config' else name.upper()+'_MODEL_PATH')]=item['path']
    with (OP/'requester-controller.private.log').open('xb') as log:
        controller=subprocess.Popen([str(PYTHON),str(STAGE/'controller.py')],cwd=SOURCE,env=env,
                                    stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    identity=actor(controller.pid)
    launch={'at':datetime.now(timezone.utc).isoformat(),'status':'HTTP_FIRST270_REQUESTER_CONTROLLER_STARTED_NATIVE_ADMISSION_PENDING',
            'controllerPid':controller.pid,'controllerStartTicks':identity['startTicks'],'frozenManifestSha256':sha(frozen),
            'plannedMeasured':270,'firstGlobalIndex':181,'lastGlobalIndex':450,'excludedWarmups':15,
            'warmupsObserved':0,'measuredObserved':0,'providerReceiver':ready['receiver'],'sourceInventorySha256':sha(STAGE/'source-inventory.json'),
            'newWorker':False,'sourceReadyIsNotMeasurement':True}
    write(OP/'requester-launch.json',launch);write(DEST/'REQUESTER-LAUNCH.json',launch)
    children={}
    for label,script,args in [('requesterCopier','custody_k1_http_requester_v2224.py',['--follow','--condition-sha256',sha(frozen)]),
                              ('warmupFinalizer','k1_http_warmup_finalize_v2224.py',[])]:
        with (OP/(label+'.private.log')).open('xb') as log:
            child=subprocess.Popen([str(PYTHON),str(ROOT/'thesis/harness'/script),*args],cwd=ROOT,
                                   stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        children[label]=actor(child.pid);write(OP/(label+'-launch.json'),{'at':datetime.now(timezone.utc).isoformat(),**children[label]})
    write(OP/'operator-launch.json',{'requester':launch,'auxiliary':children})
    print(json.dumps({'requester':launch,'auxiliary':children}),flush=True)


if __name__=='__main__':launch()

"""Root-only V745 recovery segment retirement/export/ONE raw outcome audit, after natural terminal.

Prepared on coding-worker. Do not stage/run while either frozen owner is alive.
Original raw files are retained. A project publication gap never deletes raw.
"""
from __future__ import annotations
import collections
import base64
import datetime
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import wave
import zipfile

ROOT = Path('/tmp/aurora-root-padded-local900-v745')
PROJECT = Path('/home/developer/projects/aurora')
EXPORT = ROOT / 'export-v751'
PIDS = [3312910, 3312941]
FROZEN_SHA = '31dea74bf4587e7bef60c44ef28c2b3f7a2da73a69891df27bc318b9819d505d'
DB_SHA = '911f10f5808a312ad7712daefab7b47a404966ae58a14c7e95090408fc40d52e'
QUESTION = 'What is the capital of France? Answer with only the city name.'
DEST = PROJECT / 'docs/experiments/tcc-20261013-submission-20261030/root/desktop-gpu-padded-local900-v745'


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def binding(path):
    raw = path.read_bytes()
    return {'path': str(path), 'bytes': len(raw), 'sha256': digest(raw)}


def write_once(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def r7(values):
    ordered = sorted(values)
    assert all(math.isfinite(value) and value >= 0 for value in ordered)
    result = {'denominator': len(ordered), 'method': 'Hyndman-Fan Type7; h=(n-1)*p; linear interpolation'}
    for name, probability in [('p50', .5), ('p90', .9), ('p95', .95)]:
        if not ordered:
            result[name] = None
            continue
        h = (len(ordered) - 1) * probability
        lo = math.floor(h)
        result[name] = ordered[lo] + (h-lo) * (ordered[min(lo+1,len(ordered)-1)]-ordered[lo])
    return result


def phase_counts(rows, planned):
    statuses = collections.Counter(row['status'] for row in rows)
    return {'planned': planned, 'attempted': len(rows),
            'completed_correct': statuses['completed_correct'],
            'completed_incorrect': statuses['completed_incorrect'],
            'failed_or_interrupted': sum(n for status,n in statuses.items() if not status.startswith('completed_')),
            'timeouts': sum(row.get('timeout') is True for row in rows),
            'unattempted': planned-len(rows)}


def normal_words(text):
    return re.sub(r'[^a-z0-9]+', ' ', text.casefold()).strip().split()


def native_stages(raw, measured):
    # Match only one process/clock/case/span identity; never subtract different
    # clock domains or silently add nested/duplicate invocations into one stage.
    starts, pairs = {}, collections.defaultdict(list)
    for line in raw.splitlines():
        row = json.loads(line)
        if row.get('record_kind') != 'invocation_span_boundary':
            continue
        key = tuple(row.get(name) for name in ('receiver_pid','recorder_process_id','clock_domain','harness_case_id','stage','span_id'))
        if row.get('event') == 'span_start':
            assert key not in starts, 'duplicate_native_span_start'
            starts[key] = row
        elif row.get('event') == 'span_end' and row.get('outcome') == 'completed':
            begin = starts.get(key)
            assert begin is not None, 'completed_native_span_without_start'
            duration = (int(row['monotonic_ns'])-int(begin['monotonic_ns'])) / 1_000_000
            assert duration >= 0
            pairs[(row.get('harness_case_id'),row.get('stage'))].append({
                'durationMs': duration, 'spanId': row.get('span_id'),
                'nativeOperationId': row.get('operation_id'), 'nativeAttemptId': row.get('attempt_id'),
                'requestId': row.get('request_id'), 'sessionId': row.get('session_id'),
                'correlationId': row.get('correlation_id'), 'handler': row.get('handler'),
                'clockDomain': row.get('clock_domain'), 'receiverPid': row.get('receiver_pid')})
    history = {row['harness_case_id']: {stage: pairs.get((row['harness_case_id'],stage),[])
                                    for stage in ('stt','llm','tts')} for row in measured}
    stats = {}
    for stage in ('stt','llm','tts'):
        singles = [stages[stage][0]['durationMs'] for stages in history.values() if len(stages[stage]) == 1]
        stats[stage] = {**r7(singles), 'attemptedCaseDenominator': len(measured),
                       'casesWithNoCompletedSpan': sum(not stages[stage] for stages in history.values()),
                       'casesWithMultipleCompletedSpans': sum(len(stages[stage]) > 1 for stages in history.values()),
                       'scope': 'one actual completed invocation per case; missing/multiple spans excluded explicitly, no sums'}
    return history, stats


def audit_archive(archive, manifest):
    with zipfile.ZipFile(archive) as saved:
        assert saved.testzip() is None, 'saved_zip_crc_failure'
        for entry in manifest['files']:
            assert digest(saved.read(entry['path'])) == entry['exportSHA256'], 'saved_member_hash_mismatch'
        attempts = [json.loads(saved.read(name)) for name in sorted(saved.namelist())
                    if name.startswith('runtime/campaign/attempts/attempt-')]
        assert len({row['ordinal'] for row in attempts}) == len(attempts)
        assert all(row['harness_case_id'] == f"padded-audio-v745-{row['ordinal']:04d}" for row in attempts)
        assert all(row['phase'] == ('warmup' if row['ordinal'] <= 15 else 'measured') for row in attempts)
        measured = [row for row in attempts if row['phase'] == 'measured']
        warmups = [row for row in attempts if row['phase'] == 'warmup']
        assert len(measured) <= 626 and len(warmups) <= 15
        summary = json.loads(saved.read('runtime/campaign/summary.json'))
        denominators = {'measured': phase_counts(measured,626), 'warmup_excluded': phase_counts(warmups,15)}
        for phase, counts in denominators.items():
            assert counts == summary['phase_denominators'][phase], 'raw_summary_phase_denominator_mismatch'
        completed = [row for row in measured if row['status'] in ('completed_correct','completed_incorrect')]
        correct = [row for row in measured if row['status'] == 'completed_correct']
        quantiles = {'completedIncludingIncorrect': r7([row['flow_duration_ms'] for row in completed]),
                     'correctOnly': r7([row['flow_duration_ms'] for row in correct]),
                     'observedAllAttemptsIncludingFailures': r7([row['flow_duration_ms'] for row in measured])}
        for group,key in [('completedIncludingIncorrect','completed_flow_latency_ms_r7_including_incorrect'),
                          ('correctOnly','successful_correct_latency_ms_r7'),
                          ('observedAllAttemptsIncludingFailures','observed_measured_attempt_latency_ms_r7_including_failures')]:
            for percentile in ('p90','p95'):
                actual,reported = quantiles[group][percentile], summary[key][percentile]
                assert actual is reported is None or actual is not None and reported is not None and abs(actual-reported) < .00001
        wav_count = 0
        for row in attempts:
            if row['status'] in ('completed_correct','completed_incorrect'):
                stage = row['stages']['assistant']
                predicate = (normal_words(row['stages']['stt']['transcript']) == normal_words(QUESTION)
                             and normal_words(stage['response']) == ['paris']
                             and all(stage[name] is True for name in ('session_id_matches','request_id_matches','correlation_id_matches')))
                assert predicate == (row['status'] == 'completed_correct'), 'raw_transcript_reply_outcome_mismatch'
            audio = row.get('output_audio')
            if audio:
                data = saved.read('runtime/campaign/' + audio['file'])
                assert digest(data) == audio['sha256'], 'saved_audio_hash_mismatch'
                with wave.open(io.BytesIO(data),'rb') as sound:
                    pcm = sound.readframes(sound.getnframes())
                    assert sound.getcomptype() == 'NONE' and sound.getsampwidth() == 2 and sound.getnchannels() == 1
                    assert sound.getframerate() == 22050 and sound.getnframes() > 0 and len(pcm) == sound.getnframes()*2 and any(pcm)
                wav_count += 1
        history, stages = native_stages(saved.read('runtime/voice-stages.jsonl'),measured)
        return {'phaseDenominators': denominators, 'rawOutcomeCounts': dict(collections.Counter(row['status'] for row in measured)),
                'flowLatencyType7Ms': quantiles, 'nativeStageLatencyType7Ms': stages,
                'nativeStageCaseHistory': history, 'checkedOutputAudioFiles': wav_count,
                'fullSegmentMeasuredCountReached': len(measured) == 626, 'previousMeasuredAttemptsRetained': 274, 'conditionTotalPlanned': 900,
                'warmupGate': summary.get('warmup_instrumentation_gate'),
                'summaryStatus': summary.get('status'), 'summaryStopReason': summary.get('stop_reason'),
                'unknownMetrics': {'queueWait': None, 'TTFT': None, 'streamedFirstAudio': None, 'playback': None},
                'unknownReason': 'finite headless adapters expose no queue/token/streamed audio or playback boundary; no fake zero'}


def main():
    os.umask(0o077)
    assert os.uname().nodename == 'personal.skyron-server'
    assert all(not Path(f'/proc/{pid}').exists() for pid in PIDS), 'original_owner_still_live_do_not_finalize'
    terminal_path = ROOT/'runtime/terminal.json'
    terminal = json.loads(terminal_path.read_text())
    assert terminal.get('finishedAt') and terminal.get('processPresentAfterWait') is False
    frozen = ROOT/'input/frozen-local-manifest.json'
    assert binding(frozen)['sha256'] == FROZEN_SHA
    db = PROJECT/'.git/aurora-real-ui-audio-v474/runtime/data/aurora.db'
    assert binding(db)['sha256'] == DB_SHA
    locks=[]
    try:
        for name in ('/tmp/aurora-global-build.lock','/tmp/aurora-desktop-gpu-baseline.lock'):
            handle = open(name,'a');fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB);locks.append(handle)
        assert not EXPORT.exists(), 'existing_export_attempt_reconcile_receipt_do_not_repeat'
        assert shutil.disk_usage(ROOT).free >= 1_512_000_000, 'temporary_archive_resource_admission_failed'
        EXPORT.mkdir(mode=0o700)
        retirement_path = ROOT/'runtime/retirement.json'
        retired = {'at':now(), 'host':os.uname().nodename, 'pidsAbsent':PIDS,
                   'locksObservedFreeThenHeldForExport': True, 'retainedDBSHA256Now':DB_SHA,
                   'noProcessesTerminatedByRetirement':True, 'terminal':binding(terminal_path),
                   'frozenManifestSHA256':FROZEN_SHA}
        write_once(retirement_path,retired)
        secrets=set()
        def find(value,key=''):
            if isinstance(value,dict):
                for name,item in value.items():find(item,name)
            elif isinstance(value,list):
                for item in value:find(item,key)
            elif isinstance(value,str) and value and any(word in key.lower() for word in ('secret','api_key','password','access_token','refresh_token')):
                secrets.add(value.encode())
        for config in (ROOT/'runtime/config.json',ROOT/'input/launch-config.json'):
            find(json.loads(config.read_text()))
        assert secrets, 'existing_private_config_credential_redaction_required'
        selected=[]
        for sub in ('input','hook','runtime/campaign'):
            selected.extend(path for path in (ROOT/sub).rglob('*') if path.is_file()
                            and '__pycache__' not in path.parts and path.suffix != '.pyc' and path.name != 'launch-config.json')
        for name in ('controller.py','runner.py','bootstrap.py','spawn.json','controller.private.log','post_terminal_v751.py'):
            if (ROOT/name).is_file():selected.append(ROOT/name)
        selected.extend(path for path in (ROOT/'runtime').iterdir()
                        if path.is_file() and path.name != 'config.json' and (path.suffix in ('.json','.jsonl','.log')))
        files=[]
        archive=EXPORT/'aurora-desktop-gpu-padded-local900-v745.zip'
        with zipfile.ZipFile(archive,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as saved:
            for path in sorted(set(selected)):
                assert not path.is_symlink()
                raw=path.read_bytes();data=raw
                if path.suffix.lower() not in ('.wav','.pcm'):
                    for secret in sorted(secrets,key=len,reverse=True):data=data.replace(secret,b'[REDACTED_CREDENTIAL]')
                assert all(secret not in data for secret in secrets)
                relative=path.relative_to(ROOT).as_posix()
                saved.writestr(relative,data)
                files.append({'path':relative,'sourceBytes':len(raw),'sourceSHA256':digest(raw),
                              'exportBytes':len(data),'exportSHA256':digest(data),'credentialRedacted':data!=raw})
            omissions=[]
            for name in ('input/launch-config.json','runtime/config.json','runtime/data/aurora.db'):
                path=ROOT/name
                if path.is_file():omissions.append({**binding(path),'reason':'private configuration/credential/database; original retained'})
            manifest={'schema':'aurora.raw-cohort-custody.v1','createdAt':now(),'host':os.uname().nodename,
                      'rawOriginalRoot':str(ROOT),'originalsPreserved':True,'cohort':'aurora-padded-local900-segmented-v735-v745-segment2',
                      'frozenManifestSHA256':FROZEN_SHA,'files':files,'omissions':omissions,
                      'sourceAndWeights':'exact hashes and retained original paths in frozen manifest; not duplicated',
                      'scope':'outcomes and missing denominators retained; no full900 claim before audit'}
            saved.writestr('ARCHIVE-MANIFEST.json',json.dumps(manifest,indent=2)+'\n')
        # ONE saved-archive audit. Its result is retained even when incomplete or
        # a real data inconsistency prevents acceptance; no product cases replay.
        try:
            audit=audit_archive(archive,manifest)
            history=audit.pop('nativeStageCaseHistory')
            write_once(EXPORT/'NATIVE-STAGE-CASE-HISTORY.json',history)
            audit_result={'savedZipIntegrityHashesAndOutcomeAuditPassed':True,**audit}
        except Exception as exc:
            audit_result={'savedZipIntegrityHashesAndOutcomeAuditPassed':False,
                          'auditErrorClass':type(exc).__name__,'auditErrorCode':str(exc)[:160]}
        archive_binding=binding(archive)
        receipt={'host':os.uname().nodename,'at':now(),'archive':archive_binding,
                 'archiveMembers':len(files)+1,'frozenManifestSHA256':FROZEN_SHA,
                 'retirement':binding(retirement_path),'rawOriginalsPreserved':True,**audit_result,
                 'temporaryCustody':str(EXPORT),'publication':{'status':'not_published'}}
        write_once(EXPORT/'ARCHIVE-MANIFEST.json',manifest)
        # Preserve the one audit before any independently fallible publication.
        # A failed copy is reconciled from this receipt, never by redoing audit.
        write_once(EXPORT/'audit-verification.json',receipt)
        metadata_bytes=sum((EXPORT/name).stat().st_size for name in ('ARCHIVE-MANIFEST.json','NATIVE-STAGE-CASE-HISTORY.json') if (EXPORT/name).is_file())
        publication_bytes=archive.stat().st_size+metadata_bytes+1_000_000
        if archive.stat().st_size<=40_000_000 and shutil.disk_usage(PROJECT).free>=publication_bytes+80_000_000:
            DEST.mkdir(mode=0o700,parents=True,exist_ok=False)
            with archive.open('rb') as source, (DEST/archive.name).open('xb') as target:
                shutil.copyfileobj(source,target)
                target.flush();os.fsync(target.fileno())
            assert binding(DEST/archive.name)['sha256']==archive_binding['sha256']
            receipt['publication']={'status':'published','archivePath':str(DEST/archive.name),
                                    'archiveAndMetadataSizeAnd80MBReserveAdmissionPassed':True}
            for name in ('ARCHIVE-MANIFEST.json','NATIVE-STAGE-CASE-HISTORY.json'):
                if (EXPORT/name).is_file():shutil.copyfile(EXPORT/name,DEST/name)
            write_once(DEST/'verification.json',receipt)
        else:
            receipt['publication']={'status':'project_storage_admission_unmet',
                                    'projectFreeBytes':shutil.disk_usage(PROJECT).free,
                                    'archiveBytes':archive.stat().st_size,'archiveCapBytes':40_000_000,
                                    'publicationBytesIncludingMetadataAndReceiptBudget':publication_bytes,
                                    'projectReserveBytes':80_000_000,
                                    'action':'preserve all temporary raw/archive; existing Orca chunk route can transfer to worker project docs; no cleanup/threshold reduction'}
        write_once(EXPORT/'verification.json',receipt)
        encoded=base64.b64encode(json.dumps(receipt,sort_keys=True).encode()).decode()
        parts=[encoded[i:i+800] for i in range(0,len(encoded),800)]
        for i,data in enumerate(parts):
            print('AURORA_FINALIZE_V751 '+json.dumps({'seq':i,'total':len(parts),'data':data}),flush=True)
    finally:
        for handle in reversed(locks):
            fcntl.flock(handle,fcntl.LOCK_UN);handle.close()


if __name__=='__main__':
    main()

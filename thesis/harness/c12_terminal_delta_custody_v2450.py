"""Seal/copy only C12 EOF tails after the original actors retire.

Default is a local eligibility check. --collect is deliberately separate from
the active campaign, sends no signal, and never launches a model or service.
"""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tarfile

ROOT = Path("/home/developer/projects/aurora")
CAMPAIGN = ROOT / "thesis/campaigns/c12-mixed-local-http-900-v2426"
HANDOFF = ROOT / ".git/aurora-handoff-import-20261006"
DEST = CAMPAIGN / "terminal-v2450"
HELPER = ROOT / "thesis/harness/orca_copy_control_enter_v2449.py"
MANIFEST_SHA = "316d4cc09adc44d0104dca8ac1f2a966347588ffef37bc2fa809ec14fd5efff8"
ACTORS = {2555838: 41063526, 2555839: 41063588}
PAGE = 49152
FLOOR = 2 * 1024**3
RAW_STREAMS = ("voice-stages.jsonl", "resources.jsonl", "bus-queue-observations.jsonl", "actual-provider-bindings.jsonl")
END = datetime.fromisoformat("2026-10-22T21:14:51.316179+00:00")
MARKER = "AURORA_C12_EOF_RECOVERY_V2450"


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024**2), b""):
            h.update(block)
    return h.hexdigest()


def write_bytes_new(path, data):
    path = Path(path)
    assert not path.exists()
    temporary = path.with_name("." + path.name + ".partial")
    with temporary.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    assert not path.exists()
    os.replace(temporary, path)


def write_new(path, value):
    write_bytes_new(path, (json.dumps(value, indent=2, sort_keys=True) + "\n").encode())


def actor(pid, start):
    try:
        fields = Path("/proc", str(pid), "stat").read_text().rsplit(")", 1)[1].split()
    except FileNotFoundError:
        return {"originalPresent": False, "pid": pid}
    return {
        "originalPresent": int(fields[19]) == start,
        "pid": pid,
        "observedStartTicks": int(fields[19]),
        "state": fields[0],
    }


def eligibility():
    assert digest(CAMPAIGN / "CAMPAIGN-MANIFEST.json") == MANIFEST_SHA
    worker = actor(281887, 143363140)
    terminal = CAMPAIGN / "REQUESTER-TERMINAL.json"
    return {
        "at": datetime.now(timezone.utc).isoformat(),
        "worker": worker,
        "requesterTerminalPresent": terminal.exists(),
        "eligibleForOneProviderObservation": not worker["originalPresent"]
        and terminal.exists(),
        "remoteOperations": 0,
        "inference": 0,
    }


def control(name, source):
    """One send per stable name; saved results are reusable, ambiguity is not."""
    if datetime.now(timezone.utc).timestamp() + 210 >= END.timestamp():
        raise RuntimeError("original_finalization_deadline_reserve_reached")
    command = HANDOFF / (name + "-command.txt")
    result = HANDOFF / (name + "-RESULT.json")
    text = "python3 -c " + shlex.quote(source) + "\n"
    if command.exists():
        assert command.read_text() == text, "Changed operation requires reconciliation"
        if not result.exists():
            raise RuntimeError("existing_operation_requires_SEND_READ_reconciliation")
    else:
        with command.open("x") as stream:
            stream.write(text)
        completed = subprocess.run(
            [sys.executable, str(HELPER), name, str(command), MARKER],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=210,
        )
        if completed.returncode or not result.exists():
            raise RuntimeError("observation_failed_preserve_accepted_operation_no_retry")
    value = json.loads(result.read_bytes())
    target = DEST / (name + "-RESULT.json")
    if target.exists():
        assert target.read_bytes() == result.read_bytes()
    else:
        write_bytes_new(target, result.read_bytes())
    return value


def emit_source(expression):
    return f"""
v={expression}
b=base64.b64encode(json.dumps(v).encode()).decode()
for i in range(0,len(b),600):
 print({MARKER!r}+' '+json.dumps({{'seq':i//600,'total':(len(b)+599)//600,'data':b[i:i+600]}}),flush=True)
"""


def seal_source(output, cutoff):
    # Only pre-existing campaign outputs are read. Private configuration,
    # credentials, arbitrary logs, model weights and frozen source are excluded.
    return f"""
import base64,collections,datetime,hashlib,io,json,os,shutil,socket,tarfile
from pathlib import Path
assert socket.gethostname()=='personal.skyron-server'
os.umask(0o077)
o=Path({output!r}); end=o/'terminal-v2450'
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
def identity(pid,start):
 p=Path('/proc',str(pid),'stat')
 if not p.exists():return {{'pid':pid,'originalPresent':False}}
 s=p.read_text().rsplit(')',1)[1].split()
 return {{'pid':pid,'originalPresent':int(s[19])==start,'observedStartTicks':int(s[19]),'state':s[0]}}
import time
stop_wait=time.monotonic()+90
actors=[identity(p,s) for p,s in {ACTORS!r}.items()]
while any(x["originalPresent"] for x in actors) and time.monotonic()<stop_wait:
 time.sleep(1)
 actors=[identity(p,s) for p,s in {ACTORS!r}.items()]
assert not any(x['originalPresent'] for x in actors),'Original provider still live; no signal or restart'
assert sha(o/'CAMPAIGN-MANIFEST.json')=={MANIFEST_SHA!r}
assert json.loads((o/'terminal.json').read_bytes())['receiverAbsent'] is True
assert json.loads((o/'STATUS.json').read_bytes())['ownRuntimeRetired'] is True
assert shutil.disk_usage(o).free>{FLOOR}+64*1024**2
assert not end.exists(),'Existing seal requires reconciliation, never regenerate'
names={{'terminal.json','runtime-versions.json','assistant-identity.json','STATUS.json','receiver-identity.json','stt-identity.json','provider-manifest.json','controller-launch.json','voice-stages.jsonl','LOCAL-PRODUCER-TERMINAL.json','LOCAL-PRODUCER-ARMED.json','voice-stages.status.json','LOCAL-CURRENT.json','binding-guard-diagnostic.jsonl','actual-provider-bindings.jsonl','ROOT-LAUNCH-INTENT.json','ROOT-LAUNCH.json','STOP-REQUESTED.json','resources.jsonl','CAMPAIGN-MANIFEST.json','ACTUAL-FILES.json','bus-queue-observations.jsonl','QUEUE-OBSERVER-BINDING.json','MEASURED-ADMITTED.json','LOCAL-DRIVER-ERROR.json','LOCAL-PRODUCER-STOP.json'}}
files={{p.name:p for p in o.iterdir() if p.is_file() and p.name in names}}
assert all(not p.is_symlink() for p in files.values())
prior=json.loads((o/'capsules'/f'{{{cutoff}:04d}}'/'RECEIPT.json').read_bytes())
assert prior['ordinal']=={cutoff} and prior['manifestSha256']=={MANIFEST_SHA!r}
extra={{}};raw_eof={{}}
for n in {RAW_STREAMS!r}:
 p=files.pop(n);begin=prior['offsets'][n]['end'];total=p.stat().st_size
 assert 0<=begin<=total and total-begin<=4*1024**2
 with p.open('rb') as f:f.seek(begin);tail=f.read()
 assert len(tail)==total-begin
 extra['raw-eof/'+n]=tail
 raw_eof[n]={{'totalBytes':total,'fullSha256':sha(p),'copiedPrefixBytes':begin,'tailBytes':len(tail),'tailSha256':hashlib.sha256(tail).hexdigest()}}
extra['RAW-EOF-MANIFEST.json']=(json.dumps(raw_eof,sort_keys=True,indent=2)+'\\n').encode()
cases=[]
for d in sorted((o/'cases').iterdir()):
 if not d.is_dir() or not d.name.isdigit():continue
 ordinal=int(d.name);assert 1<=ordinal<=901
 row={{'ordinal':ordinal,'alreadyPairedCopied':ordinal<={cutoff},'files':{{}}}}
 for p in sorted(d.iterdir()):
  if p.name not in {{'CASE.json','STARTED.json','AUDIO-desktop-local.wav'}}:continue
  assert p.is_file() and not p.is_symlink()
  row['files'][p.name]={{'bytes':p.stat().st_size,'sha256':sha(p)}}
  if ordinal>{cutoff}:files['uncopied-cases/'+d.name+'/'+p.name]=p
 cases.append(row)
assert sum(p.stat().st_size for p in files.values())<=512*1024**2
balance=collections.Counter()
with (o/'voice-stages.jsonl').open() as f:
 for line in f:
  if not line.strip():continue
  x=json.loads(line)
  if x.get('event') in ['span_start','span_end']:balance[x.get('span_id')]+=1 if x['event']=='span_start' else -1
end.mkdir();archive=end/'provider-eof-v2426.tar.gz'
members={{n:{{'bytes':p.stat().st_size,'sha256':sha(p)}} for n,p in files.items()}}
casebytes=(json.dumps(cases,sort_keys=True,indent=2)+'\\n').encode()
members['PROVIDER-CASE-INVENTORY.json']={{'bytes':len(casebytes),'sha256':hashlib.sha256(casebytes).hexdigest()}}
for n,data in extra.items():members[n]={{'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}}
with tarfile.open(archive,'w:gz') as t:
 for n,p in sorted(files.items()):t.add(p,arcname=n,recursive=False)
 info=tarfile.TarInfo('PROVIDER-CASE-INVENTORY.json');info.size=len(casebytes);info.mtime=0;t.addfile(info,io.BytesIO(casebytes))
 for n,data in sorted(extra.items()):
  info=tarfile.TarInfo(n);info.size=len(data);info.mtime=0;t.addfile(info,io.BytesIO(data))
assert archive.stat().st_size<=1024**2,'Archive remains preserved; bounded transfer admission needs reconciliation'
assert all(p.stat().st_size==members[n]['bytes'] and sha(p)==members[n]['sha256'] for n,p in files.items()),'EOF changed after retirement'
r={{'host':socket.gethostname(),'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'actors':actors,'receiverAbsent':True,'ownRuntimeRetired':True,'archive':str(archive),'bytes':archive.stat().st_size,'sha256':sha(archive),'members':members,'lastWorkerPairedOrdinal':{cutoff},'caseDirectories':len(cases),'unbalancedHistoricalSpans':{{str(k):v for k,v in balance.items() if v}},'archiveMode':'metadata_plus_uncopied_tails_requires_saved_prefixes','signalsSent':0,'inference':0,'originalFinalizationDeadline':{END.isoformat()!r}}}
with (end/'.SEAL.json.partial').open('x') as f:json.dump(r,f,indent=2);f.write('\\n');f.flush();os.fsync(f.fileno())
assert not (end/'SEAL.json').exists();os.replace(end/'.SEAL.json.partial',end/'SEAL.json')
""" + emit_source("r")


def collect():
    proof = eligibility()
    if not proof["eligibleForOneProviderObservation"]:
        return {**proof, "status": "DEFERRED_ACTIVE_CAMPAIGN_NO_REMOTE_OPERATION"}
    assert __import__("socket").gethostname() == "code-worker"
    lock = Path("/tmp/aurora-global-build.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    assert eligibility()["eligibleForOneProviderObservation"]
    DEST.mkdir(exist_ok=True)
    if not (DEST / "LOCAL-ELIGIBILITY.json").exists():
        write_new(DEST / "LOCAL-ELIGIBILITY.json", proof)
    manifest = json.loads((CAMPAIGN / "CAMPAIGN-MANIFEST.json").read_bytes())
    recovered = json.loads((CAMPAIGN / "ROOT-PAIR-0261-RECOVERED-v2448.json").read_bytes())
    assert recovered["localMeasuredCorrect"] == recovered["httpMeasuredCorrect"] == 260
    assert recovered["caseOrdinalsIncludingOneCurrentWarmup"] == 261
    current = {"lastOrdinal": 261}  # Last saved pair recovered; original CURRENT remains untouched.
    seal = control(
        "c12-terminal-seal-v2450",
        seal_source(manifest["providerOutput"], current["lastOrdinal"]),
    )
    assert seal["host"] == "personal.skyron-server" and seal["inference"] == 0
    # Retain archive, pages and all raw control receipts. Their observed encoded
    # copies cost more than the compressed payload; admission reserves them too.
    assert shutil.disk_usage(ROOT).free > FLOOR + 16 * seal["bytes"] + 2 * 1024**2
    pages = DEST / "pages"
    pages.mkdir(exist_ok=True)
    for offset in range(0, seal["bytes"], PAGE):
        page = offset // PAGE
        prefix = f"""
import base64,hashlib,json,socket
from pathlib import Path
assert socket.gethostname()=='personal.skyron-server'
p=Path({seal['archive']!r});assert p.stat().st_size=={seal['bytes']}
with p.open('rb') as f:f.seek({offset});b=f.read({PAGE})
r={{'offset':{offset},'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'data':base64.b64encode(b).decode()}}
"""
        value = control(f"c12-terminal-copy-v2450-page{page:04d}", prefix + emit_source("r"))
        data = base64.b64decode(value["data"], validate=True)
        assert value["offset"] == offset and value["bytes"] == len(data)
        assert hashlib.sha256(data).hexdigest() == value["sha256"]
        target = pages / f"{page:04d}.bin"
        if target.exists():
            assert target.read_bytes() == data
        else:
            write_bytes_new(target, data)
        assert shutil.disk_usage(ROOT).free > FLOOR
    archive = DEST / "provider-eof-v2426.tar.gz"
    if not archive.exists():
        temporary = archive.with_suffix(".partial")
        with temporary.open("xb") as out:
            for offset in range(0, seal["bytes"], PAGE):
                out.write((pages / f"{offset // PAGE:04d}.bin").read_bytes())
            out.flush()
            os.fsync(out.fileno())
        assert temporary.stat().st_size == seal["bytes"] and digest(temporary) == seal["sha256"]
        os.replace(temporary, archive)
    assert archive.stat().st_size == seal["bytes"] and digest(archive) == seal["sha256"]
    with tarfile.open(archive) as tar:
        assert set(tar.getnames()) == set(seal["members"])
        for member in tar:
            assert member.isfile()
            data = tar.extractfile(member).read()
            expected = seal["members"][member.name]
            assert len(data) == expected["bytes"]
            assert hashlib.sha256(data).hexdigest() == expected["sha256"]
    result = {
        "at": datetime.now(timezone.utc).isoformat(),
        "status": "EOF_ARCHIVE_COPIED_ALL_MEMBERS_VERIFIED_NOT_FULL_GOAL_ACCEPTANCE",
        "seal": seal,
        "archive": str(archive),
        "sourceSha256": digest(__file__),
        "inference": 0,
        "signalsSent": 0,
        "remainingGate": "Saved-data population/positive-stage reconciliation and scoped resource-release report by original Root",
    }
    receipt = DEST / "CUSTODY.json"
    if not receipt.exists():
        write_new(receipt, result)
    return {k: v for k, v in result.items() if k != "seal"}


def verify_saved_prefixes():
    """Reconstruct hashes in memory; retain archives rather than duplicate raw files."""
    custody = json.loads((DEST / "CUSTODY.json").read_bytes())
    cutoff = custody["seal"]["lastWorkerPairedOrdinal"]
    hashes = {name: hashlib.sha256() for name in RAW_STREAMS}
    sizes = {name: 0 for name in RAW_STREAMS}
    for ordinal in range(1, cutoff + 1):
        directory = CAMPAIGN / "provider-custody" / f"{ordinal:04d}"
        receipt = json.loads((directory / "CUSTODY.json").read_bytes())["receipt"]
        assert receipt["ordinal"] == ordinal and receipt["manifestSha256"] == MANIFEST_SHA
        archive = directory / "provider-pair.tar.gz"
        assert digest(archive) == receipt["sha256"]
        with tarfile.open(archive) as tar:
            names = set(tar.getnames())
            for name in RAW_STREAMS:
                offset = receipt["offsets"][name]
                assert offset["begin"] == sizes[name]
                key = "raw/" + name
                data = tar.extractfile(key).read() if key in names else b""
                assert len(data) == offset["bytes"] == offset["end"] - offset["begin"]
                assert hashlib.sha256(data).hexdigest() == offset["sha256"]
                hashes[name].update(data)
                sizes[name] += len(data)
    proof = {}
    with tarfile.open(DEST / "provider-eof-v2426.tar.gz") as tar:
        eof = json.load(tar.extractfile("RAW-EOF-MANIFEST.json"))
        for name in RAW_STREAMS:
            expected = eof[name]
            assert sizes[name] == expected["copiedPrefixBytes"]
            tail = tar.extractfile("raw-eof/" + name).read()
            assert len(tail) == expected["tailBytes"]
            assert hashlib.sha256(tail).hexdigest() == expected["tailSha256"]
            hashes[name].update(tail)
            sizes[name] += len(tail)
            assert sizes[name] == expected["totalBytes"]
            assert hashes[name].hexdigest() == expected["fullSha256"]
            proof[name] = {"bytes": sizes[name], "sha256": hashes[name].hexdigest()}
    result = {
        "at": datetime.now(timezone.utc).isoformat(),
        "status": "ALL_FOUR_SAVED_RAW_PREFIXES_PLUS_EOF_MATCH_SEALED_MANIFEST",
        "prefixCapsules": cutoff,
        "streams": proof,
        "newInference": 0,
        "rawDuplicatedOnDisk": False,
    }
    target = DEST / "RAW-PREFIX-PLUS-EOF-VERIFIED.json"
    if not target.exists():
        write_new(target, result)
    return result


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collect", action="store_true")
    args = parser.parse_args()
    result = collect() if args.collect else eligibility()
    if args.collect and result.get("status") == "EOF_ARCHIVE_COPIED_ALL_MEMBERS_VERIFIED_NOT_FULL_GOAL_ACCEPTANCE":
        result["savedPrefixVerification"] = verify_saved_prefixes()
    print(json.dumps(result, indent=2))

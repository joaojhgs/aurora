"""Private source-only browser warmup gate; no product calls or execution."""
from __future__ import annotations
import hashlib,json,re
from pathlib import Path
from typing import Any
_ACTUAL_BINDING_OFFSET=0
_ACTUAL_BINDING_RECORDS:dict[str,Any]={}
class CampaignFailure(RuntimeError):
    def __init__(self,stage,code,*,stop=False):super().__init__(stage+":"+code)
def _sha256(data:bytes)->str:return hashlib.sha256(data).hexdigest()
def _actual_constructor_bindings(path: Path) -> dict[str, Any]:
    """Incrementally read constructor records; per-case work is O(new rows)."""
    global _ACTUAL_BINDING_OFFSET
    try:
        with path.open("rb") as stream:
            stream.seek(_ACTUAL_BINDING_OFFSET)
            appended = stream.read()
            if appended and not appended.endswith(b"\n"):
                raise CampaignFailure("provider_bindings", "actual_binding_record_partial", stop=True)
            _ACTUAL_BINDING_OFFSET = stream.tell()
    except FileNotFoundError:
        appended = b""
    except CampaignFailure:
        raise
    except Exception:
        raise CampaignFailure("provider_bindings", "actual_binding_record_unavailable", stop=True) from None
    try:
        for line in appended.splitlines():
            record = json.loads(line)
            event = record.get("event")
            args = record.get("actualArguments") or {}
            if event == "stt_constructor_return":
                _ACTUAL_BINDING_RECORDS["stt"] = {
                    "loaded_class": (record.get("returned") or {}).get("class"),
                    "engine_class": (record.get("engine") or {}).get("class"),
                    "device": record.get("actualDevice"),
                    "compute_type": record.get("actualComputeType"),
                    "configured_model_name": Path(str(args.get("model", ""))).name or None,
                }
            elif event == "llm_constructor_return":
                _ACTUAL_BINDING_RECORDS["llm"] = {
                    "loaded_class": (record.get("returned") or {}).get("class"),
                    "client_class": (record.get("actualClient") or {}).get("class"),
                    "effective_wrapper_settings": record.get("effectiveWrapperSettings"),
                    "model_name": Path(str(args.get("model_path", ""))).name or None,
                    "chat_format": args.get("chat_format"),
                }
    except Exception:
        raise CampaignFailure("provider_bindings", "actual_binding_record_invalid", stop=True) from None
    actual = dict(_ACTUAL_BINDING_RECORDS)
    actual["complete"] = all(name in actual for name in ("stt", "llm"))
    actual["sha256"] = _sha256(json.dumps(_ACTUAL_BINDING_RECORDS, sort_keys=True, separators=(",", ":")).encode())
    return actual

def evaluate_warmups(root:Path,frozen:dict[str,Any],frozen_sha:str)->dict[str,Any]|None:
    """Return a positive gate only from all15 actualUI/native cases; None means wait."""
    global _ACTUAL_BINDING_OFFSET,_ACTUAL_BINDING_RECORDS
    expected_ids=[f"browser-audio-v799-{i:04d}" for i in range(1,16)]
    runtime=root/"runtime"
    for i,case_id in enumerate(expected_ids,1):
        path=root/"browser900/attempts"/case_id/"case.json"
        if not path.is_file():return None
        try:
            row=json.loads(path.read_text())
        except (json.JSONDecodeError,UnicodeDecodeError):
            return None  # A write-once case file may be visible before its fsync.
        if (row.get("schema")!="aurora.browser900.case.v799" or row.get("harness_case_id")!=case_id
            or row.get("frozen_manifest_sha256")!=frozen_sha or row.get("ordinal")!=i
            or row.get("phase")!="warmup" or row.get("outcome")!="passed"
            or not row.get("checks") or not all(value is True for value in row["checks"].values())):
            raise RuntimeError("browser_ui_warmup_not_passed")
        capture=path.parent/"transcription-input.pcm"
        wav=path.parent/"read-aloud.wav"
        if (not capture.is_file() or not wav.is_file() or capture.stat().st_size<=0
            or _sha256(capture.read_bytes())!=row.get("transcription",{}).get("sha256")):
            raise RuntimeError("browser_ui_warmup_capture_custody_invalid")
    stages=runtime/"voice-stages.jsonl"
    if not stages.is_file():return None
    stage_bytes=stages.read_bytes()
    if not stage_bytes.endswith(b"\n"):return None
    completed={case:set() for case in expected_ids}
    for line in stage_bytes.splitlines():
        row=json.loads(line)
        if row.get("event")=="span_end" and row.get("outcome")=="completed" and row.get("harness_case_id") in completed:
            completed[row["harness_case_id"]].add(row.get("stage"))
    if any(not {"stt","llm","tts"}.issubset(s) for s in completed.values()):return None
    bindings_path=runtime/"actual-provider-bindings.jsonl"
    if not bindings_path.is_file():return None
    binding_bytes=bindings_path.read_bytes()
    if not binding_bytes.endswith(b"\n"):return None
    _ACTUAL_BINDING_OFFSET=0;_ACTUAL_BINDING_RECORDS={}
    actual=_actual_constructor_bindings(bindings_path)
    if not actual["complete"]:return None
    if actual!=frozen["expectedActualProviderIdentity"]:
        raise RuntimeError("browser_actual_provider_identity_mismatch")
    tts_cases=set()
    tts_model=frozen["models"]["tts"]
    for line in binding_bytes.splitlines():
        row=json.loads(line)
        if row.get("event")=="piper_cli_call_start" and row.get("harness_case_id") in completed:
            args=row.get("actualArguments") or {};voice=args.get("voice") or {}
            if (args.get("useCuda") is not False or args.get("piperExecutable")!=tts_model["executable"]["path"]
                or voice.get("model_file")!=tts_model["weights"]["path"]
                or voice.get("config_file")!=tts_model["voiceConfig"]["path"]):
                raise RuntimeError("browser_actual_piper_identity_mismatch")
            tts_cases.add(row["harness_case_id"])
    if tts_cases!=set(expected_ids):return None
    log=(runtime/"backend.private.log").read_bytes()
    text=log.decode(errors="replace")
    if not re.search(r"offloaded\s+25/25 layers to GPU",text) or not re.search(r"AMD.*RX\s*7600",text):
        raise RuntimeError("browser_actual_rx7600_25of25_unverified")
    return {"schema":"aurora.browser900.warmup-gate.v1","status":"passed",
            "frozen_manifest_sha256":frozen_sha,"warmup_case_ids":expected_ids,
            "native_stages_complete":True,"actual_provider_identity_complete":True,
            "actual_rx7600_25of25_verified":True,"actualProviderIdentitySHA256":actual["sha256"],
            "stageRowsPrefixBytes":len(stage_bytes),"stageRowsPrefixSHA256":_sha256(stage_bytes),
            "backendLogPrefixBytes":len(log),"backendLogPrefixSHA256":_sha256(log),
            "ownerLabelsAreNotNativeIds":True}

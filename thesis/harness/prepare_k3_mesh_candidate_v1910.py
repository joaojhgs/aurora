"""Derive the cumulative STT+LLM+TTS peer condition from the sealed K2 harness.

Source preparation only. Reuses the qualified exact-peer adapter, telemetry,
failure policy and custody boundaries; it never imports Aurora or starts it.
"""
from pathlib import Path
import ast
import difflib
import hashlib
import json

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'thesis/harness/distributed-k2-mesh-v1826'
DEST = ROOT / 'thesis/harness/distributed-k3-mesh-v1910'


def replace(source, old, new, count=1):
    assert source.count(old) == count, (old[:100], source.count(old), count)
    return source.replace(old, new)


def function(source, name, new):
    node = next(n for n in ast.parse(source).body
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)
    lines = source.splitlines(keepends=True)
    return ''.join(lines[:node.lineno - 1]) + new.rstrip() + '\n' + ''.join(lines[node.end_lineno:])


def main():
    assert not DEST.exists(), 'Preserve existing preparation; do not overwrite'
    template = json.loads((BASE / 'freeze-template.json').read_text())
    names = {'adapterSha256': 'mesh_stage_adapter.py', 'bindingsSha256': 'bindings.py',
             'bootstrapSha256': 'bootstrap.py', 'controllerSha256': 'controller.py',
             'k3CompositionSha256': 'k3_composition.py', 'observerSha256': 'observer.py',
             'receiverProofSha256': 'receiver_proof.py', 'resourceSamplerSha256': 'resource_sample.py',
             'routeObserverSha256': 'mesh_route_observer.py', 'routeRuntimePinsSha256': 'route_runtime_pins.json',
             'routeSinkSha256': 'route_observation_sink.py', 'runnerSha256': 'runner.py',
             'telemetrySha256': 'aurora_voice_telemetry_v430.py'}
    originals = {}
    rendered = {}
    for name in names.values():
        old = 'k2_composition.py' if name == 'k3_composition.py' else name
        source = (BASE / old).read_text()
        originals[name] = source
        rendered[name] = source.replace('K2', 'K3').replace('k2', 'k3').replace('v1731', 'v1910')

    source = rendered['k3_composition.py']
    source = source.replace('expected_local_stt_model', 'expected_remote_stt_model')
    source = replace(source, '    assistant_peer: AdmittedMeshPeer,',
                     '    stt_peer: AdmittedMeshPeer,\n    assistant_peer: AdmittedMeshPeer,')
    start = source.index('    # Stage 1: real local STT')
    end = source.index('    record["correctness"]["transcript_matches_reference_words"]', start)
    source = source[:start] + '''    # Stage 1: actual STT on the admitted exact peer; no local model fallback.
    stt_started_ns = time.monotonic_ns()
    try:
        transcription, stt_meta = await request_mesh_stage(
            supervisor.bus, "stt",
            TranscribeAudioRequest(
                audio_data=base64.b64encode(wav_bytes).decode("ascii"),
                format="wav", sample_rate=sample_rate, channels=channels,
                language=None, model="accurate",
            ),
            TranscribeAudioResponse, stt_peer, correlation_id=correlation_id,
            deadline_monotonic=deadline_monotonic,
        )
    except MeshStageError as exc:
        fail("stt", exc.category, duration_ms=exc.duration_ms,
             stop_campaign=exc.stop_campaign, preaccept_response=exc.preaccept_response)
    stt_ended_ns = time.monotonic_ns()
    stt_ms = (stt_ended_ns - stt_started_ns) / 1_000_000
    if not transcription.text.strip():
        fail("stt", "empty_transcript", duration_ms=stt_ms)
    if transcription.model_used != expected_remote_stt_model:
        fail("stt", "remote_stt_model_identity_mismatch", duration_ms=stt_ms, stop_campaign=True)
    transcript_matches = _normal_words(transcription.text) == _normal_words(reference_transcript)
    record["stages"]["stt"] = {
        "status": "completed", "start_monotonic_ns": stt_started_ns,
        "end_monotonic_ns": stt_ended_ns, "duration_ms": stt_ms,
        "duration_ms_reported_by_service": transcription.duration_ms,
        "model_used": transcription.model_used, "language": transcription.language,
        "transcript_sha256": hashlib.sha256(transcription.text.encode("utf-8")).hexdigest(),
        "transcript_chars": len(transcription.text), **stt_meta,
    }
''' + source[end:]
    source = source.replace('worker-local STT, exact-peer remote Assistant/TTS', 'exact-peer remote STT, Assistant and TTS')
    source = source.replace('worker_local_stt_remote_mesh_assistant_tts', 'remote_mesh_stt_assistant_tts')
    rendered['k3_composition.py'] = source

    source = rendered['runner.py']
    source = source.replace('expected_local_stt_model', 'expected_remote_stt_model')
    source = source.replace('worker_local_stt_remote_mesh_assistant_tts', 'remote_mesh_stt_assistant_tts')
    source = source.replace('local STT, remote LLM and TTS', 'remote STT, LLM and TTS')
    source = source.replace('{"assistant", "tts"}', '{"stt", "assistant", "tts"}')
    source = source.replace('("assistant", "tts")', '("stt", "assistant", "tts")')
    source = replace(source, '    assistant_peer_id = os.environ.get(',
                     '    stt_peer_id = os.environ.get("AURORA_K3_MESH_STT_PEER_ID", "")\n    stt_peer = AdmittedMeshPeer(stt_peer_id, _sha256(stt_peer_id.encode("utf-8")))\n    assistant_peer_id = os.environ.get(')
    source = replace(source, '            or remote_receivers.get("assistant", {}).get("peer_id_sha256") != assistant_peer.sha256',
                     '            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", stt_peer_id)\n            or remote_receivers.get("stt", {}).get("peer_id_sha256") != stt_peer.sha256\n            or remote_receivers.get("assistant", {}).get("peer_id_sha256") != assistant_peer.sha256')
    source = replace(source, '                        assistant_peer=assistant_peer, tts_peer=tts_peer,',
                     '                        stt_peer=stt_peer, assistant_peer=assistant_peer, tts_peer=tts_peer,')
    source = function(source, '_local_stt_warmup_gate', '''def _local_stt_warmup_gate(attempts_dir: Path, stage_output: Path, wav_hash: str,
                           candidate_hash: str, config: dict[str, Any],
                           case_prefix: str = "audio-campaign-v1910") -> dict[str, Any]:
    """Require correct requester warmups and no hidden local model execution."""
    if config["services"]["stt"]["transcription"]["enabled"]:
        raise CampaignFailure("warmup_gate", "requester_local_stt_enabled", stop=True)
    if stage_output.exists():
        for line in stage_output.read_text().splitlines():
            row = json.loads(line)
            if row.get("record_kind") == "invocation_span_boundary" and row.get("handler") in (
                "stt.model_invoke", "resolved_chat_model.astream", "tts.model_invoke"
            ):
                raise CampaignFailure("warmup_gate", "unexpected_requester_model_invocation", stop=True)
    binding_path = stage_output.with_name("actual-provider-bindings.jsonl")
    if binding_path.exists() and binding_path.read_bytes().strip():
        raise CampaignFailure("warmup_gate", "unexpected_requester_model_constructor_or_call", stop=True)
    for ordinal in range(1, WARMUP_COUNT + 1):
        attempt = json.loads((attempts_dir / f"attempt-{ordinal:04d}-warmup.jsonl").read_text())
        if (attempt.get("harness_case_id") != f"{case_prefix}-{ordinal:04d}"
                or attempt.get("phase") != "warmup" or attempt.get("status") != "completed_correct"
                or attempt.get("input_wav_sha256") != wav_hash
                or attempt.get("candidate_manifest_sha256") != candidate_hash
                or attempt.get("correctness", {}).get("all_expected") is not True
                or any(attempt.get("stages", {}).get(stage, {}).get("status") != "completed"
                       for stage in ("stt", "assistant", "tts"))):
            raise CampaignFailure("warmup_gate", "fifteen_correct_remote_audio_flows_required", stop=True)
    return {"status": "passed", "correct_warmups": WARMUP_COUNT, "requester_model_invocations": 0}
''')
    source = source.replace('WARMUP_COUNT * 2', 'WARMUP_COUNT * 3').replace('WARMUP_COUNT * 4', 'WARMUP_COUNT * 6')
    source = replace(source, 'handler = "resolved_chat_model.astream" if stage == "assistant" else "tts.model_invoke"',
                     'handler = {"stt": "stt.model_invoke", "assistant": "resolved_chat_model.astream", "tts": "tts.model_invoke"}[stage]')
    source = source.replace('(stage == "tts" and (', '(stage in ("stt", "tts") and (')
    source = replace(source, '        from app.shared.contracts.models.orchestrator import OrchestratorMethods',
                     '        from app.shared.contracts.models.stt import TranscriptionMethods\n        from app.shared.contracts.models.orchestrator import OrchestratorMethods')
    source = replace(source, 'CapabilityCatalogRequest(modules=["Orchestrator", "TTS"], include_schemas=False)',
                     'CapabilityCatalogRequest(modules=["Transcription", "Orchestrator", "TTS"], include_schemas=False)')
    source = replace(source, '                            ("assistant", OrchestratorMethods.EXTERNAL_USER_INPUT, assistant_peer, None),',
                     '                            ("stt", TranscriptionMethods.TRANSCRIBE, stt_peer, RouteExplainSpeechConstraints()),\n                            ("assistant", OrchestratorMethods.EXTERNAL_USER_INPUT, assistant_peer, None),')
    source = source.replace('remote_assistant_tts_receiver_gate', 'remote_stt_assistant_tts_receiver_gate')
    rendered['runner.py'] = source

    source = rendered['bootstrap.py']
    source = replace(source, '    from app.shared.contracts.models.orchestrator import OrchestratorMethods',
                     '    from app.shared.contracts.models.stt import TranscriptionMethods\n    from app.shared.contracts.models.orchestrator import OrchestratorMethods')
    source = replace(source, 'topic_filter=(OrchestratorMethods.EXTERNAL_USER_INPUT, TTSMethods.SYNTHESIZE)',
                     'topic_filter=(TranscriptionMethods.TRANSCRIBE, OrchestratorMethods.EXTERNAL_USER_INPUT, TTSMethods.SYNTHESIZE)')
    rendered['bootstrap.py'] = source

    source = rendered['receiver_proof.py']
    source = replace(source, 'assistant_identity_path: Path, tts_identity_path: Path,',
                     'assistant_identity_path: Path, tts_identity_path: Path, stt_identity_path: Path,')
    source = source.replace('{"assistant", "tts"}', '{"stt", "assistant", "tts"}')
    source = source.replace('("assistant", "tts")', '("stt", "assistant", "tts")')
    source = replace(source, '(("assistant", assistant_identity_path), ("tts", tts_identity_path))',
                     '(("stt", stt_identity_path), ("assistant", assistant_identity_path), ("tts", tts_identity_path))')
    source = replace(source, 'topics = {"assistant": "Orchestrator.ExternalUserInput", "tts": "TTS.Synthesize"}',
                     'topics = {"stt": "Transcription.Transcribe", "assistant": "Orchestrator.ExternalUserInput", "tts": "TTS.Synthesize"}')
    source = replace(source, 'stage = "assistant" if row.get("topic") == topics["assistant"] else (\n            "tts" if row.get("topic") == topics["tts"] else None)',
                     'stage = next((s for s, topic in topics.items() if row.get("topic") == topic), None)')
    source = replace(source, '        if stage == "tts" and row.get("handler") != "tts.model_invoke":',
                     '        if stage == "stt" and row.get("handler") != "stt.model_invoke":\n            continue\n        if stage == "tts" and row.get("handler") != "tts.model_invoke":')
    source = replace(source, 'for stage, handler in (("assistant", "resolved_chat_model.astream"), ("tts", "tts.model_invoke")):',
                     'for stage, handler in (("stt", "stt.model_invoke"), ("assistant", "resolved_chat_model.astream"), ("tts", "tts.model_invoke")):')
    source = replace(source, '            else:\n                if (begin.get("operation_id") != finish.get("operation_id")',
                     '            elif stage == "tts":\n                if (begin.get("operation_id") != finish.get("operation_id")')
    source = replace(source, '            calls.append(record)', '''            else:
                if (begin.get("operation_id") != finish.get("operation_id")
                        or begin.get("attempt_id") != finish.get("attempt_id")):
                    raise ValueError("stt_native_ids_mismatch")
                op, att = finish.get("operation_id"), finish.get("attempt_id")
                if not all(isinstance(v, str) and MAX_ID.fullmatch(v) for v in (op, att)):
                    raise ValueError("stt_native_ids_missing")
                records = [r for r in bindings if r.get("event") == "stt_constructor_return" and r.get("pid") == pid]
                if (len(records) != 1 or records[0].get("actualDevice") != "cpu"
                        or records[0].get("actualComputeType") != "int8_float32"
                        or records[0].get("returned", {}).get("class") != expected_receivers[stage]["provider_class"]
                        or records[0].get("actualArguments", {}).get("device") != "cpu"
                        or records[0].get("actualArguments", {}).get("compute_type") != "int8"
                        or str((Path(records[0].get("actualArguments", {}).get("model", "")) / "model.bin").resolve()) != paths["stt"]["model"]):
                    raise ValueError("actual_stt_constructor_binding_mismatch")
                record.update(operation_id=op, attempt_id=att)
            calls.append(record)''')
    source = source.replace('== 30', '== 45').replace('!= 30', '!= 45').replace('"calls": 30', '"calls": 45')
    source = replace(source, '"assistant-identity", "tts-identity",', '"assistant-identity", "tts-identity", "stt-identity",')
    source = replace(source, 'tts_identity_path=a.tts_identity, mesh_calls_path=a.mesh_calls,',
                     'tts_identity_path=a.tts_identity, stt_identity_path=a.stt_identity, mesh_calls_path=a.mesh_calls,')
    source = replace(source, 'or expected_receivers.get("assistant", {}).get("peer_id_sha256") != cohort.get("meshAssistantPeerIdSha256")',
                     'or expected_receivers.get("stt", {}).get("peer_id_sha256") != cohort.get("meshSttPeerIdSha256")\n            or expected_receivers.get("assistant", {}).get("peer_id_sha256") != cohort.get("meshAssistantPeerIdSha256")')
    rendered['receiver_proof.py'] = source
    for name, source in rendered.items():
        if name.endswith('.py'):
            ast.parse(source, filename=name)
    pins = json.loads(rendered['route_runtime_pins.json'])
    pins['runtimePrefix'] = str(Path(pins['runtimePrefix']).resolve())
    rendered['route_runtime_pins.json'] = json.dumps(pins, indent=2) + '\n'
    template['implementation'] = {key: hashlib.sha256(rendered[name].encode()).hexdigest() for key, name in names.items()}
    template['sourceClosure'].update(cpuSourceRoot=str(ROOT / 'thesis/sources/k3-stt-runtime-v1907/worker/source'),
        cpuSourceInventorySha256=hashlib.sha256((ROOT / 'thesis/sources/k3-stt-runtime-v1907/worker/source-inventory.json').read_bytes()).hexdigest(),
        sourceDeltaReceipt='thesis/sources/k3-stt-runtime-v1907/SOURCE-RECEIPT.json', historicalHttpByteIdentity=False,
        equivalenceVerified=False, snapshotVerified=True)
    template['stagePlacement'] = {'stt': 'Personal CPU faster-whisper base', 'assistant': 'Personal Vulkan GPU, new-process proof pending', 'tts': 'Personal CPU Piper'}
    template['meshSttPeerIdSha256'] = None
    template['routeLabel'] = 'typed_gateway_mesh_peer_bridge'
    template['status'] = 'PROSPECTIVE_SOURCE_ONLY_NO_RUNTIME_ADMISSION'
    DEST.mkdir()
    changes = []
    for name, source in rendered.items():
        (DEST / name).write_text(source)
        if source != originals[name]:
            changes.extend(difflib.unified_diff(originals[name].splitlines(True), source.splitlines(True),
                                                fromfile='sealed-k2/' + name, tofile='prospective-k3/' + name))
    for name in ('candidate-input.wav', 'candidate-manifest.json'):
        (DEST / name).write_bytes((BASE / name).read_bytes())
    (DEST / 'source-inventory.json').write_bytes((ROOT / 'thesis/sources/k3-stt-runtime-v1907/worker/source-inventory.json').read_bytes())
    (DEST / 'freeze-template.json').write_text(json.dumps(template, indent=2) + '\n')
    (DEST / 'CUMULATIVE-STT-DELTA.diff').write_text(''.join(changes))
    receipt = {'status': 'SOURCE_CANDIDATE_AST_VALID_NOT_IMPORTED_LAUNCHED_OR_ADMITTED',
               'base': str(BASE.relative_to(ROOT)), 'newSutCalls': 0, 'source': template['sourceClosure'],
               'implementation': template['implementation'], 'models': template['models'], 'audio': template['audio'],
               'measurementPlan': template['measurementPlan'], 'failurePolicyUnchanged': template['prospectiveFailurePolicy'],
               'stagePlacement': template['stagePlacement'], 'need': 'One bounded source review of cumulative STT hop/proof delta, then actual excluded full-audio warmups; no baseline replay or language edge-case expansion.'}
    (DEST / 'SOURCE-RECEIPT.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'status': receipt['status'], 'files': len(rendered), 'path': str(DEST), 'sutCalls': 0,
                      'sourceDeltaBytes': (DEST / 'CUMULATIVE-STT-DELTA.diff').stat().st_size}))


if __name__ == '__main__':
    main()

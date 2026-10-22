"""Four saved-response checks; no application runtime, model or network calls."""
import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('qualified_k2_adapter', Path(__file__).with_name('mesh_stage_adapter.py'))
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
peer = module.AdmittedMeshPeer('admitted-peer', hashlib.sha256(b'admitted-peer').hexdigest())


class SavedBus:
    def __init__(self, result):
        self.result = result
        self.calls = 0

    async def request(self, *args, **kwargs):
        self.calls += 1
        return self.result


class Response:
    @classmethod
    def model_validate(cls, raw):
        assert raw == {'saved': True}
        return cls()


async def check(name, stage, topic, result, observed_outcome, expected, wrong_peer=False):
    target = '0' * 64 if wrong_peer else peer.sha256
    rows = [{'event': 'mesh_peer_call_start', 'peer_id_sha256': target, 'topic': topic, 'correlation_id': 'saved-case', 'monotonic_start_ns': 10, 'pid': 7},
            {'event': 'mesh_peer_call_end', 'peer_id_sha256': target, 'topic': topic, 'correlation_id': 'saved-case', 'monotonic_start_ns': 10, 'monotonic_end_ns': 20, 'pid': 7, 'outcome': observed_outcome}]
    sys.modules['bindings'] = SimpleNamespace(mesh_call_observation=lambda correlation: rows)
    bus = SavedBus(result)
    observed = 'ok'
    stop = None
    original = None
    try:
        await module._request_with_bus(bus, stage, topic, SimpleNamespace(model_dump=lambda **kw: {'saved': True}),
            Response, peer, 'saved-case', time.monotonic() + 5, SavedBus)
    except module.MeshStageError as exc:
        observed, stop, original = exc.category, exc.stop_campaign, exc.preaccept_response
    assert (observed, stop) == expected, (name, observed, stop)
    assert bus.calls == 1
    if observed == 'preaccept_capability_changed':
        assert original['accepted'] is result.data['accepted'] is False
        assert original['reason_code'] == result.data['reason_code'] == 'capability_changed'
        assert original['method_topic'] == topic and original['peer_id_sha256'] == peer.sha256
    return {'case': name, 'outcome': observed, 'stopCampaign': stop, 'calls': bus.calls}


async def main():
    denial = SimpleNamespace(ok=False, data={'accepted': False, 'reason_code': 'capability_changed'}, error='capability_changed')
    rows = [await check('successful_assistant', 'assistant', 'Orchestrator.ExternalUserInput', SimpleNamespace(ok=True, data={'saved': True}), 'ok', ('ok', None)),
            await check('exact_tts_preaccept_denial', 'tts', 'TTS.Synthesize', denial, 'failed', ('preaccept_capability_changed', False)),
            await check('unstructured_assistant_error_stops', 'assistant', 'Orchestrator.ExternalUserInput', SimpleNamespace(ok=False, data=None, error='capability_changed'), 'failed', ('exact_peer_call_failed', True)),
            await check('wrong_peer_never_recoverable', 'tts', 'TTS.Synthesize', denial, 'failed', ('exact_peer_call_binding_mismatch', True), True)]
    print(json.dumps({'status': 'PASS', 'cases': rows, 'modelCalls': 0, 'networkCalls': 0, 'runtimeImports': 0}))


asyncio.run(main())

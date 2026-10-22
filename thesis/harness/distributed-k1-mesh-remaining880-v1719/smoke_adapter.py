"""Finite classifier smoke with no services, models or network traffic."""
import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'thesis/sources/python-audio-p2p-tts-wiring-v1706/source'))
from app.messaging.mesh_bus import MeshBus
from app.messaging.bus import QueryResult
from app.shared.contracts.models.tts import TTSMethods

spec = importlib.util.spec_from_file_location('candidate_adapter', Path(__file__).with_name('requester') / 'tts_mesh_adapter.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
peer = 'aurora-selected-test-peer'
digest = hashlib.sha256(peer.encode()).hexdigest()


class SavedResultBus(MeshBus):
    def __init__(self, result):
        self.result = result
        self.calls = 0

    async def request(self, *args, **kwargs):
        self.calls += 1
        return self.result


async def check(name, result, outcome, expected, peer_hash=digest):
    rows = [{'event': 'mesh_peer_call_start', 'peer_id_sha256': peer_hash, 'topic': TTSMethods.SYNTHESIZE},
            {'event': 'mesh_peer_call_end', 'peer_id_sha256': peer_hash, 'topic': TTSMethods.SYNTHESIZE, 'outcome': outcome}]
    sys.modules['bindings'] = SimpleNamespace(mesh_call_observation=lambda correlation: rows)
    bus = SavedResultBus(result)
    observed = 'ok'
    try:
        await adapter.synthesize_mesh_tts(bus, 'Paris', time.monotonic() + 5, correlation_id='saved-smoke', selected_peer_id=peer)
    except adapter.RemoteMeshTtsCallError as exc:
        observed = exc.category
    assert observed == expected, (name, observed, expected)
    assert bus.calls == 1, 'No retry or fallback is permitted'
    return {'case': name, 'outcome': observed, 'calls': bus.calls}


async def main():
    denied = QueryResult(ok=False, data={'accepted': False, 'reason_code': 'capability_changed'}, error='capability_changed')
    cases = []
    cases.append(await check('successful_exact_peer', QueryResult(ok=True, data={'audio': 'saved'}), 'ok', 'ok'))
    cases.append(await check('structured_exact_peer_preaccept_denial', denied, 'failed', 'preaccept_capability_changed'))
    cases.append(await check('ambiguous_failure_stays_hard_stop', QueryResult(ok=False, error='capability_changed'), 'failed', 'exact_remote_peer_call_not_confirmed'))
    cases.append(await check('wrong_peer_never_classified_recoverable', denied, 'failed', 'exact_remote_peer_call_not_confirmed', '0' * 64))
    print(json.dumps({'status': 'PASS', 'cases': cases, 'sutCalls': 0, 'networkCalls': 0, 'modelCalls': 0}))


asyncio.run(main())

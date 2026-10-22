"""Reuse the approved worker/Personal credential without changing or copying it."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import os
import runpy
import sqlite3
import time
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[2]
PROFILE = ROOT / '.git/aurora-handoff-import-20261006/mesh-pair-control-v1535/worker-node-v1538'
PEER = 'aurora-276bb04e1276201922851f6a222110de'
ROOM_SHA = 'ee0fd1481f9b76e66217b2aef151e40fe04ecfcc62dbb249a6e8386145ef10dc'
CRYPTO = ROOT / 'thesis/sources/k1-speech-contract-compat-v2151/worker/source/app/shared/crypto.py'
CRYPTO_SHA = 'fa7c1a70209ea4b94a9fcb477d486292f87a851d58691e10a5cd14c4d23d223e'


def existing_bearer():
    from dotenv import dotenv_values
    assert hashlib.sha256(CRYPTO.read_bytes()).hexdigest() == CRYPTO_SHA
    db = PROFILE / 'data/aurora.db'
    assert db.is_file() and not db.is_symlink()
    with sqlite3.connect(db.as_uri() + '?mode=ro', uri=True) as con:
        rows = con.execute(
            'SELECT room_name,inbound_token,inbound_token_id,inbound_permissions '
            'FROM mesh_peers WHERE peer_id=?', (PEER,)).fetchall()
    assert len(rows) == 1
    room, stored, token_id, permissions = rows[0]
    assert hashlib.sha256(room.encode()).hexdigest() == ROOM_SHA and stored and token_id
    env_file = PROFILE / '.env'
    assert hashlib.sha256(env_file.read_bytes()).hexdigest() == '4ec98082191811ab77d93d64d02df6b284c267d771096ac406ab5575fc200a12'
    secret = dotenv_values(env_file).get('AURORA_TOKEN_SECRET')
    assert secret
    crypto = runpy.run_path(str(CRYPTO))
    token = crypto['open_str'](crypto['derive_mesh_inbound_key'](secret), stored)
    assert token and '\n' not in token and '\r' not in token
    return token


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def protected_read():
    token = existing_bearer()
    started = time.monotonic_ns()
    req = Request('http://127.0.0.1:18000/api/services',
                  headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json'})
    try:
        with build_opener(ProxyHandler({}), NoRedirect()).open(req, timeout=15) as response:
            raw = response.read(131073)
            status = int(response.status)
            assert status == 200 and len(raw) <= 131072
            data = json.loads(raw)
            assert isinstance(data.get('services'), list)
            return {'at': datetime.now(timezone.utc).isoformat(),
                    'status': 'EXISTING_PEER_BEARER_PROTECTED_HTTP_READ_PASSED',
                    'httpStatus': status, 'path': '/api/services',
                    'bodyBytes': len(raw), 'bodySha256': hashlib.sha256(raw).hexdigest(),
                    'durationMs': (time.monotonic_ns()-started)/1e6,
                    'route': 'existing desktop-aurora-tts / worker127.0.0.1:18000',
                    'existingApprovedPeer': PEER, 'authorizationChanges': False,
                    'credentialsCopiedOrLogged': False, 'newInference': 0}
    except HTTPError as exc:
        return {'at': datetime.now(timezone.utc).isoformat(),
                'status': 'EXISTING_PEER_BEARER_PROTECTED_READ_REJECTED',
                'httpStatus': int(exc.code), 'authorizationChanges': False,
                'credentialsCopiedOrLogged': False, 'newInference': 0}


if __name__ == '__main__':
    os.umask(0o077)
    result = protected_read()
    out = ROOT / 'thesis/evidence/k1-http-remaining720-admission-v2204/PROTECTED-HTTP-AUTH-v2223.json'
    with out.open('x') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    print(json.dumps(result))

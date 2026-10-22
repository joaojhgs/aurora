"""Privately reuse the approved Personal room; never emit its credentials.

The supported Orca terminal is the only cross-host control route. Its retained
output carries an X25519/AES-GCM sealed envelope, never a plaintext password.
The private key and decrypted parameters stay in Root's task-local private
directory, outside thesis custody. This creates no account or transport grant.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import socket

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

AAD = b"aurora-owner-approved-room-v1535"


def private_write(path: Path, data: bytes) -> None:
    """Create a private task artifact once, without replacing existing state."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def key_for(private: X25519PrivateKey, remote: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=AAD).derive(
        private.exchange(X25519PublicKey.from_public_bytes(remote))
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["key", "seal-personal", "open"])
    parser.add_argument("--private-dir", type=Path)
    parser.add_argument("--public-key")
    parser.add_argument("--envelope", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.operation == "key":
        key = X25519PrivateKey.generate()
        private_write(args.private_dir / "room-transfer.key", key.private_bytes_raw())
        public = base64.b64encode(key.public_key().public_bytes_raw()).decode()
        private_write(args.private_dir / "room-transfer-public.json", json.dumps({"publicKey": public}).encode())
        print(json.dumps({"publicKey": public, "credentialValuesOutput": False}))
        return
    if args.operation == "seal-personal":
        from dotenv import dotenv_values

        root = Path("/home/developer/projects/aurora")
        raw = (root / "config.json").read_bytes()
        gateway = json.loads(raw)["services"]["gateway"]
        webrtc = dict(gateway["webrtc"])
        env = dotenv_values(root / ".env")
        if not webrtc.get("password"):
            webrtc["password"] = env.get("AURORA_WEBRTC_PASSWORD")
        assert all(webrtc.get(key) for key in ("room", "app_id", "password")), "approved_room_parameter_missing"
        assert webrtc.get("encrypt_signaling") is True, "existing_encrypted_signaling_required"
        payload = {"webrtc": webrtc, "signaling_mqtt": gateway["signaling_mqtt"]}
        key = X25519PrivateKey.generate()
        nonce = os.urandom(12)
        ciphertext = AESGCM(key_for(key, base64.b64decode(args.public_key))).encrypt(
            nonce, json.dumps(payload, separators=(",", ":")).encode(), AAD
        )
        result = {
            "at": datetime.now(timezone.utc).isoformat(), "host": socket.gethostname(),
            "sourceConfigSha256": hashlib.sha256(raw).hexdigest(),
            "roomPasswordSource": "existing_config_or_local_dotenv", "requiredParametersPresent": True,
            "publicKey": base64.b64encode(key.public_key().public_bytes_raw()).decode(),
            "nonce": base64.b64encode(nonce).decode(), "sealedParameters": base64.b64encode(ciphertext).decode(),
            "plaintextCredentialValuesOutput": False, "passwordHashesOutput": False,
            "newModelRequests": 0, "sourceOrProviderChanges": False,
        }
        # Provider metadata only: no environment values or command-line tokens.
        manifest = root / ".git/aurora-handoff-import-20261006/distributed-k3-http-provider-v1476/input/provider-manifest.json"
        value = json.loads(manifest.read_bytes())
        result["providerManifestTopKeys"] = sorted(value)
        result["providerLaunchKeys"] = sorted(value.get("launch_config", {}))
        result["currentSourceFiles"] = {
            str(path): hashlib.sha256((root / path).read_bytes()).hexdigest()
            for path in ("app/services/gateway/service.py", "app/services/gateway/webrtc/rtc_client.py", "app/services/auth/service.py")
        }
        encoded = base64.b64encode(json.dumps(result).encode()).decode()
        print("AURORA_SEALED_ROOM_V1535 " + json.dumps({"seq": 0, "total": 1, "data": encoded}), flush=True)
        return
    envelope = json.loads(args.envelope.read_bytes())
    key = X25519PrivateKey.from_private_bytes((args.private_dir / "room-transfer.key").read_bytes())
    raw = AESGCM(key_for(key, base64.b64decode(envelope["publicKey"]))).decrypt(
        base64.b64decode(envelope["nonce"]), base64.b64decode(envelope["sealedParameters"]), AAD
    )
    value = json.loads(raw)
    assert all(value["webrtc"].get(key) for key in ("app_id", "room", "password"))
    private_write(args.private_dir / "room-parameters.json", raw)
    print(json.dumps({"parametersPrivatelyAvailable": True, "sameApprovedPersonalRoom": True,
                      "plaintextCredentialValuesOutput": False, "passwordHashesOutput": False}))


if __name__ == "__main__":
    main()

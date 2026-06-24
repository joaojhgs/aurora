import base64
import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt


def b64(b: bytes) -> str:
    """Base64url encode without padding."""
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64d(s: str) -> bytes:
    """Base64url decode with padding restoration."""
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


@dataclass
class RoomKeys:
    """Keys derived from room password for signaling and data channels."""

    k0: bytes
    k_sig: bytes
    k_data: bytes


def _hash_room(app_id: str, room: str) -> bytes:
    return hashlib.sha256((app_id + "|" + room).encode()).digest()


def derive_room_keys(
    password: str, app_id: str, room: str, *, data_info: bytes = b"aurora/webrtc/data"
) -> RoomKeys:
    """Derive signaling and data keys using Scrypt and HKDF for security."""
    salt = _hash_room(app_id, room)
    # Scrypt is used to prevent brute-force attacks on the password
    # n=2**16 provides strong security for room password protection
    kdf = Scrypt(salt=salt, length=32, n=2**16, r=8, p=1)
    k0 = kdf.derive(password.encode())

    # HKDF is used to securely derive multiple keys from a single master key (k0)
    k_sig = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=b"aurora/webrtc/signaling",
    ).derive(k0)
    k_data = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=data_info,
    ).derive(k0)

    return RoomKeys(k0=k0, k_sig=k_sig, k_data=k_data)


def aead_seal(key: bytes, obj: dict[str, Any]) -> bytes:
    """Encrypt a dictionary using AES-GCM for authenticated encryption."""
    nonce = os.urandom(12)
    pt = json.dumps(obj, separators=(",", ":")).encode()
    ct = AESGCM(key).encrypt(nonce, pt, None)
    return nonce + ct


def aead_open(key: bytes, payload: bytes) -> dict[str, Any]:
    """Decrypt an AES-GCM payload; verification is built-in to AEAD."""
    nonce, ct = payload[:12], payload[12:]
    pt = AESGCM(key).decrypt(nonce, ct, None)
    return json.loads(pt.decode())


class TokenError(Exception):
    pass


def issue_token(
    secret: str,
    *,
    sub: str,
    roles: list[str] | None = None,
    perms: list[str] | None = None,
    ttl_seconds: int = 3600,
    peer_name: str | None = None,
) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": sub,
        "roles": roles or [],
        "perms": perms or [],
        "exp": int(time.time()) + ttl_seconds,
    }
    if peer_name:
        payload["peer_name"] = peer_name

    h = b64(json.dumps(header, separators=(",", ":")).encode())
    p = b64(json.dumps(payload, separators=(",", ":")).encode())

    msg = f"{h}.{p}".encode()
    sig = hmac.new(secret.encode(), msg=msg, digestmod=hashlib.sha256).digest()
    s = b64(sig)

    return f"{h}.{p}.{s}"


def verify_token(secret: str, token: str) -> dict[str, Any]:
    """Verify an HMAC-signed token and return its payload."""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            raise TokenError("invalid token format")

        h, p, s = parts
        msg = f"{h}.{p}".encode()
        expected_sig = hmac.new(secret.encode(), msg=msg, digestmod=hashlib.sha256).digest()

        if not hmac.compare_digest(b64(expected_sig), s):
            raise TokenError("bad signature")

        payload = json.loads(b64d(p))
        if int(payload.get("exp", 0)) < int(time.time()):
            raise TokenError("expired")

        return payload
    except Exception as e:
        if isinstance(e, TokenError):
            raise
        raise TokenError(str(e)) from e

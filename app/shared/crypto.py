"""Shared cryptography utilities for Aurora.

Provides encryption-at-rest for sensitive data (e.g. mesh inbound tokens).
Uses AES-GCM with keys derived from config secrets.
"""

from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# Prefix for encrypted values stored in DB (enables backward compat with plaintext)
_ENCRYPTED_PREFIX = "v2:"


def derive_mesh_inbound_key(secret: str) -> bytes:
    """Derive a 32-byte AES key from the gateway token secret.

    Args:
        secret: The gateway.token_secret (or equivalent) string.

    Returns:
        32 bytes suitable for AES-GCM.
    """
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"aurora-mesh-inbound",
        info=b"inbound_token_encryption",
    ).derive(secret.encode())


def seal_str(key: bytes, plaintext: str) -> str:
    """Encrypt a string for storage at rest.

    Args:
        key: 32-byte AES key (from derive_mesh_inbound_key).
        plaintext: String to encrypt.

    Returns:
        Base64-encoded ciphertext prefixed with 'v2:' for versioning.
    """
    nonce = os.urandom(12)
    pt = plaintext.encode()
    ct = AESGCM(key).encrypt(nonce, pt, None)
    payload = nonce + ct
    return _ENCRYPTED_PREFIX + base64.urlsafe_b64encode(payload).decode()


def open_str(key: bytes, stored: str) -> str:
    """Decrypt a stored string, or return as-is if legacy plaintext.

    Args:
        key: 32-byte AES key (from derive_mesh_inbound_key).
        stored: Value from DB (either 'v2:' + base64(ciphertext) or plaintext).

    Returns:
        Decrypted plaintext string.
    """
    if not stored.startswith(_ENCRYPTED_PREFIX):
        return stored
    try:
        payload = base64.urlsafe_b64decode(stored[len(_ENCRYPTED_PREFIX) :])
        nonce, ct = payload[:12], payload[12:]
        pt = AESGCM(key).decrypt(nonce, ct, None)
        return pt.decode()
    except Exception:
        return stored

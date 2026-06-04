import time

import pytest

from app.services.gateway.utils.crypto import (
    RoomKeys,
    TokenError,
    aead_open,
    aead_seal,
    derive_room_keys,
    issue_token,
    verify_token,
)


def test_derive_room_keys():
    password = "password123"
    app_id = "test_app"
    room = "test_room"

    keys1 = derive_room_keys(password, app_id, room)

    assert isinstance(keys1, RoomKeys)
    assert len(keys1.k0) == 32
    assert len(keys1.k_sig) == 32
    assert len(keys1.k_data) == 32

    keys2 = derive_room_keys(password, app_id, room)
    assert keys1.k0 == keys2.k0
    assert keys1.k_sig == keys2.k_sig
    assert keys1.k_data == keys2.k_data

    keys3 = derive_room_keys(password, app_id, "other_room")
    assert keys1.k0 != keys3.k0


def test_aead_roundtrip():
    key = b"0" * 32
    data = {"foo": "bar", "baz": 123}

    sealed = aead_seal(key, data)
    opened = aead_open(key, sealed)

    assert data == opened


def test_token_roundtrip():
    secret = "my_secret"
    sub = "user123"
    roles = ["admin"]

    token = issue_token(secret, sub=sub, roles=roles)
    payload = verify_token(secret, token)

    assert payload["sub"] == sub
    assert payload["roles"] == roles
    assert "exp" in payload


def test_token_expiration():
    secret = "my_secret"
    sub = "user123"

    token = issue_token(secret, sub=sub, ttl_seconds=-1)

    with pytest.raises(TokenError, match="expired"):
        verify_token(secret, token)


def test_token_bad_signature():
    secret = "my_secret"
    sub = "user123"

    token = issue_token(secret, sub=sub)

    parts = token.split(".")
    parts[2] = parts[2][:-1] + ("0" if parts[2][-1] != "0" else "1")
    bad_token = ".".join(parts)

    with pytest.raises(TokenError, match="bad signature"):
        verify_token(secret, bad_token)

    with pytest.raises(TokenError, match="bad signature"):
        verify_token("wrong_secret", token)


def test_token_invalid_format():
    with pytest.raises(TokenError, match="invalid token format"):
        verify_token("secret", "invalidtoken")

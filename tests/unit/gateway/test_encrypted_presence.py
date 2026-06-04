"""Tests for encrypted presence roundtrip (Gap 3B).

Tests that sealed presence messages survive the encrypt → decrypt roundtrip
through MQTTSignaling join_room → RTCClient _on_presence.
"""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import cryptography.exceptions
import pytest

from app.services.gateway.utils.crypto import aead_open, aead_seal, derive_room_keys


@pytest.fixture
def room_keys():
    """Derive deterministic keys from a fixed room/password."""
    return derive_room_keys("test-password", "aurora", "test-room")


class TestEncryptedPresenceRoundtrip:
    """Verify aead_seal → _on_presence(aead_open) roundtrip."""

    def test_seal_open_roundtrip(self, room_keys):
        """Plain crypto roundtrip: aead_seal → aead_open returns original dict."""
        presence = {
            "type": "presence",
            "app_id": "aurora",
            "room": "test-room",
            "peer_id": "peer-B",
        }
        sealed = aead_seal(room_keys.k_sig, presence)

        # Must not be valid JSON (it's encrypted)
        with pytest.raises((json.JSONDecodeError, UnicodeDecodeError)):
            json.loads(sealed)

        # aead_open must recover the original dict
        recovered = aead_open(room_keys.k_sig, sealed)
        assert recovered == presence

    def test_wrong_key_fails(self, room_keys):
        """Opening with the wrong key raises."""
        presence = {"type": "presence", "peer_id": "peer-B"}
        sealed = aead_seal(room_keys.k_sig, presence)

        wrong_keys = derive_room_keys("wrong-password", "aurora", "test-room")
        with pytest.raises(cryptography.exceptions.InvalidTag):
            aead_open(wrong_keys.k_sig, sealed)

    @pytest.mark.asyncio
    async def test_on_presence_decrypts_sealed_payload(self, room_keys):
        """RTCClient._on_presence correctly decrypts sealed presence."""
        presence = {"type": "presence", "peer_id": "peer-B", "app_id": "aurora", "room": "r"}
        sealed = aead_seal(room_keys.k_sig, presence)

        # Build a minimal mock RTCClient-like context
        client = MagicMock()
        client._peer_id = "peer-A"
        client._pcs = {}
        client._keys = room_keys
        client._settings = SimpleNamespace(webrtc=SimpleNamespace(encrypt_signaling=True))
        client.connect_to = AsyncMock()

        # Import and call _on_presence unbound
        from app.services.gateway.webrtc.rtc_client import RTCClient

        await RTCClient._on_presence(client, sealed)

        # peer-A < peer-B lexicographically → peer-A should initiate
        client.connect_to.assert_awaited_once_with("peer-B")

    @pytest.mark.asyncio
    async def test_on_presence_plaintext_fallback(self, room_keys):
        """When encrypt_signaling=False, plaintext JSON presence works."""
        presence = {"type": "presence", "peer_id": "peer-B", "app_id": "aurora", "room": "r"}
        payload = json.dumps(presence).encode()

        client = MagicMock()
        client._peer_id = "peer-A"
        client._pcs = {}
        client._keys = room_keys
        client._settings = SimpleNamespace(webrtc=SimpleNamespace(encrypt_signaling=False))
        client.connect_to = AsyncMock()

        from app.services.gateway.webrtc.rtc_client import RTCClient

        await RTCClient._on_presence(client, payload)

        client.connect_to.assert_awaited_once_with("peer-B")

    @pytest.mark.asyncio
    async def test_on_presence_encrypted_mode_plaintext_fallback(self, room_keys):
        """When encrypt_signaling=True but payload is plaintext JSON,
        fallback to plaintext parsing (backward compat)."""
        presence = {"type": "presence", "peer_id": "peer-B", "app_id": "aurora", "room": "r"}
        payload = json.dumps(presence).encode()

        client = MagicMock()
        client._peer_id = "peer-A"
        client._pcs = {}
        client._keys = room_keys
        client._settings = SimpleNamespace(webrtc=SimpleNamespace(encrypt_signaling=True))
        client.connect_to = AsyncMock()

        from app.services.gateway.webrtc.rtc_client import RTCClient

        # aead_open will fail on plaintext → fallback to json.loads
        await RTCClient._on_presence(client, payload)

        client.connect_to.assert_awaited_once_with("peer-B")

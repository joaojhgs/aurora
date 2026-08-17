"""Versioned WebRTC thin-shell protocol contract constants.

This module is deliberately descriptor-only for G001.  Runtime WebRTC, MQTT,
pairing, reconnect, and RPC behavior continues to live in the existing helpers;
these constants give browser/WebView implementations a stable baseline to match
without advertising features that are not implemented yet.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Any

WEBRTC_THIN_PROTOCOL_VERSION = 1
WEBRTC_THIN_CAPABILITY_VERSION = 1
PAIRING_PROTOCOL_VERSION = 2
INVITE_FORMAT_VERSION = "amv1"
DATA_CHANNEL_LABEL = "aurora-rpc"

SCRYPT_PARAMETERS = MappingProxyType(
    {
        "n": 2**16,
        "r": 8,
        "p": 1,
        "length": 32,
        "salt": "sha256(app_id + '|' + room)",
    }
)
HKDF_INFO = MappingProxyType(
    {
        "signaling": "aurora/webrtc/signaling",
        "data": "aurora/webrtc/data",
    }
)
AEAD_PARAMETERS = MappingProxyType(
    {
        "algorithm": "AES-256-GCM",
        "nonce_bytes": 12,
        "payload": "nonce || ciphertext || tag",
        "plaintext_json": "json.dumps(obj, separators=(',', ':'))",
    }
)
SIGNALING_TOPICS = MappingProxyType(
    {
        "root": "aurora",
        "base": "{root}/{app_id}/{room}/{channel}",
        "direct": "{root}/{app_id}/{room}/{channel}/{peer_id}",
        "subscriptions": (
            {"topic": "{root}/{app_id}/{room}/presence/+", "qos": 1},
            {"topic": "{root}/{app_id}/{room}/offer/{peer_id}", "qos": 0},
            {"topic": "{root}/{app_id}/{room}/answer/{peer_id}", "qos": 0},
            {"topic": "{root}/{app_id}/{room}/candidate/{peer_id}", "qos": 0},
            {"topic": "{root}/{app_id}/{room}/broadcast", "qos": 0},
        ),
    }
)
RPC_FRAME_TYPES = ("call", "result", "error", "chunk", "eof", "cancel", "event")

# The DataChannel carries considerably more than RPC. Listing only the RPC
# frames left the rest of the vocabulary undocumented and unasserted, which is
# how `capacity_update` came to be broadcast by Python and silently dropped by
# the TypeScript parser. Every frame type either side accepts belongs in one of
# these tuples, and both implementations assert against them.
SUBSCRIPTION_FRAME_TYPES = (
    "subscribe",
    "subscribed",
    "subscribe_rejected",
    "unsubscribe",
    "unsubscribed",
)
MESH_CONTROL_FRAME_TYPES = (
    "protocol_hello",
    "fragment",
    "manifest",
    "manifest_request",
    "manifest_ack",
    "provider_lease",
    "provider_unavailable",
    "capacity_update",
    "ping",
    "pong",
)
SESSION_FRAME_TYPES = (
    "auth",
    "reauth",
    "mesh_auth_challenge_v1",
    "mesh_auth_proof_v1",
    "pairing_v2_commit",
    "pairing_v2_reveal",
    "pairing_v2_terminal",
)
SIGNALING_FRAME_TYPES = ("presence", "presence_departed", "offer", "answer", "candidate")

WEBRTC_THIN_PROTOCOL_CAPABILITIES = MappingProxyType(
    {
        "protocol_version": WEBRTC_THIN_PROTOCOL_VERSION,
        "capability_version": WEBRTC_THIN_CAPABILITY_VERSION,
        "pairing_protocol_version": PAIRING_PROTOCOL_VERSION,
        "invite_format": INVITE_FORMAT_VERSION,
        "data_channel_label": DATA_CHANNEL_LABEL,
        "signaling": {
            "mqtt_v5": True,
            "mqtt_websocket_transport": True,
            "encrypted_presence": True,
            "session_signaling_peer_id": True,
        },
        "crypto": {
            "scrypt_room_keys": True,
            "hkdf_sha256": True,
            "aes_gcm_nonce_ciphertext_tag": True,
            "reconnect_hmac_sha256": True,
        },
        "rpc": {
            "json_data_channel": True,
            "call_result_error": True,
            "stream_chunk_eof": True,
            "cancel": True,
            "forwarded_event": True,
            "fragmentation": True,
            "backpressure": True,
            "scoped_event_subscriptions": True,
            "consumer_only_peer": True,
        },
        "pairing": {
            "commit_reveal_sas_v2": True,
            "channel_binding_sdp_sha256": True,
            "terminal_frame": True,
        },
    }
)


def protocol_descriptor() -> dict[str, Any]:
    """Return a JSON-serializable copy of the current WebRTC thin contract."""

    return {
        "protocol_version": WEBRTC_THIN_PROTOCOL_VERSION,
        "capability_version": WEBRTC_THIN_CAPABILITY_VERSION,
        "pairing_protocol_version": PAIRING_PROTOCOL_VERSION,
        "invite_format": INVITE_FORMAT_VERSION,
        "data_channel_label": DATA_CHANNEL_LABEL,
        "scrypt": dict(SCRYPT_PARAMETERS),
        "hkdf_info": dict(HKDF_INFO),
        "aead": dict(AEAD_PARAMETERS),
        "signaling_topics": {
            **dict(SIGNALING_TOPICS),
            "subscriptions": [dict(item) for item in SIGNALING_TOPICS["subscriptions"]],
        },
        "rpc_frame_types": list(RPC_FRAME_TYPES),
        "subscription_frame_types": list(SUBSCRIPTION_FRAME_TYPES),
        "mesh_control_frame_types": list(MESH_CONTROL_FRAME_TYPES),
        "session_frame_types": list(SESSION_FRAME_TYPES),
        "signaling_frame_types": list(SIGNALING_FRAME_TYPES),
        "capabilities": dict(WEBRTC_THIN_PROTOCOL_CAPABILITIES),
    }

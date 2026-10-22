"""Record supplied dispatch revisions/bindings; never decide or change authority."""

from __future__ import annotations

import functools
import hashlib
import inspect
import json
import threading
import time

SPEECH_FIELDS = (
    "service_instance_id", "projection_digest", "projection_revision",
    "provider_lease_epoch", "provider_lease_revision",
    "speech_capability_revision", "requirement_digest",
)


def install(peer_bridge_type, path, topics):
    original = peer_bridge_type.call
    signature = inspect.signature(original)
    lock = threading.Lock()
    topics = frozenset(topics)

    @functools.wraps(original)
    async def observed(self, peer_id, topic, payload, *args, **kwargs):
        if topic not in topics:
            return await original(self, peer_id, topic, payload, *args, **kwargs)
        started = time.monotonic_ns()
        row = {"schema": "aurora.c12.dispatch_context.v1", "topic": topic,
               "provider_peer_id_sha256": hashlib.sha256(peer_id.encode()).hexdigest(),
               "started_monotonic_ns": started, "context_status": "unavailable"}
        try:
            supplied = signature.bind_partial(self, peer_id, topic, payload, *args, **kwargs).arguments
            binding = supplied.get("speech_route_binding")
            caller = supplied.get("caller_peer_id")
            row.update(
                context_status="observed_supplied_context",
                correlation_id=supplied.get("correlation_id"),
                caller_peer_id_sha256=hashlib.sha256(caller.encode()).hexdigest() if isinstance(caller, str) else None,
                auth_grant_revision=supplied.get("auth_grant_revision"),
                manifest_revision=supplied.get("manifest_revision"),
                speech_route_binding={name: getattr(binding, name, None) for name in SPEECH_FIELDS} if binding is not None else None,
            )
        except Exception:
            pass
        outcome = "raised"
        try:
            result = await original(self, peer_id, topic, payload, *args, **kwargs)
            outcome = "ok" if getattr(result, "ok", False) else "failed"
            return result
        finally:
            # Observation failures never alter the real call or its exception.
            # No payload, token, permissions, credential or SDP is serialized.
            row.update(ended_monotonic_ns=time.monotonic_ns(), request_outcome=outcome)
            try:
                with lock, path.open("a") as stream:
                    stream.write(json.dumps(row, sort_keys=True) + "\n")
            except Exception:
                pass

    peer_bridge_type.call = observed

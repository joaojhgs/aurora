"""Bounded, content-free diagnostics around existing speech authority checks.

The original checks and their return values are unchanged. This is an opt-in
experiment overlay, installed before the normal services start, never live.
"""
from __future__ import annotations

import atexit
import collections
import hashlib
import json
import os
from pathlib import Path
import queue
import threading
import time


def install(output: Path) -> None:
    from app.services.gateway.webrtc.rpc import RPCHandler
    from app.shared.contracts.models.orchestrator import OrchestratorMethods
    from app.shared.contracts.models.speech import (
        SpeechMethodConstraints,
        compute_speech_projection_binding_revision,
    )
    from app.shared.contracts.models.stt import TranscriptionMethods
    from app.shared.contracts.models.tts import TTSMethods
    from app.shared.contracts.speech_routing import (
        compute_speech_route_requirement_digest_for_payload,
    )
    from app.shared.services.base_service import BaseService

    topics = {TranscriptionMethods.TRANSCRIBE, OrchestratorMethods.EXTERNAL_USER_INPUT,
              TTSMethods.SYNTHESIZE}
    rows: queue.Queue[dict | None] = queue.Queue(maxsize=128)
    accepted = collections.Counter()
    written = 0
    dropped = 0
    path = output / "binding-guard-diagnostic.jsonl"
    assert not path.exists(), "Preserve existing diagnostic operation"

    def write_rows() -> None:
        nonlocal written
        with path.open("xb") as stream:
            os.chmod(path, 0o600)
            while True:
                row = rows.get()
                if row is None:
                    return
                raw = (json.dumps(row, sort_keys=True) + "\n").encode()
                if written + len(raw) > 512 * 1024:
                    continue
                stream.write(raw)
                stream.flush()
                written += len(raw)

    writer = threading.Thread(target=write_rows, name="aurora-binding-diagnostic", daemon=True)
    writer.start()

    def emit(kind: str, topic: str, result: bool, fields: dict) -> None:
        nonlocal dropped
        key = (kind, topic)
        if result and accepted[key] >= 3:
            return
        accepted[key] += 1
        record = {"schema": "aurora.binding_guard_diagnostic.v1", "kind": kind,
                  "topic": topic, "original_result": result, "pid": os.getpid(),
                  "monotonic_ns": time.monotonic_ns(), "content_recorded": False,
                  "dropped_before": dropped, **fields}
        try:
            rows.put_nowait(record)
        except queue.Full:
            dropped += 1

    def digest(value: object) -> str:
        return hashlib.sha256(str(value).encode()).hexdigest()

    def binding_fields(binding: object) -> dict:
        if binding is None:
            return {"binding_present": False}
        names = ("provider_lease_epoch", "provider_lease_revision", "projection_digest",
                 "projection_revision", "speech_capability_revision", "requirement_digest")
        return {"binding_present": True,
                "binding": {name: getattr(binding, name, None) for name in names},
                "service_instance_id_sha256": digest(getattr(binding, "service_instance_id", ""))}

    original_rpc = RPCHandler._validate_speech_route_binding

    def rpc_check(self, **kwargs):
        result = original_rpc(self, **kwargs)
        topic = kwargs["topic"]
        if topic not in topics:
            return result
        try:
            binding = kwargs["binding"]
            projection = kwargs["active_projection"]
            service = kwargs["projected_service"]
            method = kwargs["projected_method"]
            fields = binding_fields(binding)
            fields.update(projection_present=projection is not None,
                          service_present=service is not None,
                          method_present=method is not None)
            constraints_raw = getattr(method, "speech_constraints", None)
            constraints = (SpeechMethodConstraints.model_validate(constraints_raw)
                           if constraints_raw is not None else None)
            fields["constraints_present"] = constraints is not None
            fields["expected_speech_capability_revision"] = (
                constraints.speech_capability_revision if constraints else None)
            state = self._local_provider_binding_state()
            fields["provider_state_present"] = state is not None
            mismatch = []
            if state is not None and projection is not None and binding is not None:
                ready, availability = state
                cache = projection.cache_key
                expected = {"provider_lease_epoch": getattr(ready, "connection_epoch", ""),
                            "provider_lease_revision": availability,
                            "projection_digest": getattr(ready, "projection_digest", "")}
                revisions = {"registry_revision": getattr(ready, "registry_revision", ""),
                             "export_policy_revision": getattr(ready, "export_policy_revision", ""),
                             "auth_grant_revision": getattr(ready, "auth_grant_revision", 0)}
                fields["receiver_revisions"] = revisions
                fields["projection_cache_revisions"] = {
                    "registry_revision": cache.registry_revision,
                    "export_policy_revision": cache.policy_revision,
                    "auth_grant_revision": cache.authority_revision}
                expected["projection_revision"] = compute_speech_projection_binding_revision(
                    projection_digest=expected["projection_digest"],
                    registry_revision=str(revisions["registry_revision"]),
                    policy_revision=str(revisions["export_policy_revision"]),
                    auth_grant_revision=int(revisions["auth_grant_revision"]))
                fields["receiver_expected_binding"] = expected
                mismatch = [name for name, value in expected.items()
                            if getattr(binding, name, None) != value]
                service_instance = f"remote:{cache.provider_peer_id}:{getattr(service, 'service_id', '')}"
                fields["expected_service_instance_id_sha256"] = digest(service_instance)
                if binding.service_instance_id != service_instance:
                    mismatch.append("service_instance_id")
                fields["service_compatible"] = str(getattr(service, "service_id", "")) in tuple(
                    getattr(ready, "compatible_services", ()) or ())
            if binding is not None:
                expected_need = compute_speech_route_requirement_digest_for_payload(
                    topic, kwargs["typed_params"])
                fields["expected_requirement_digest"] = expected_need
                if binding.requirement_digest != expected_need:
                    mismatch.append("requirement_digest")
                if constraints and binding.speech_capability_revision != constraints.speech_capability_revision:
                    mismatch.append("speech_capability_revision")
            fields["mismatch_fields"] = mismatch
            emit("rpc_guard", topic, result, fields)
        except Exception as exc:
            emit("rpc_diagnostic_error", topic, result, {"error_class": type(exc).__name__})
        return result

    original_envelope = BaseService._envelope_speech_route_binding_valid

    def envelope_check(self, envelope, data, *, topic):
        result = original_envelope(self, envelope, data, topic=topic)
        if topic in topics and getattr(envelope, "identity_source", None) == "webrtc_rpc":
            try:
                binding = getattr(envelope, "speech_route_binding", None)
                constraints = self._speech_method_constraints_for_topic(topic)
                fields = binding_fields(binding)
                fields.update(correlation_id=getattr(envelope, "correlation_id", None),
                              constraints_present=constraints is not None,
                              expected_speech_capability_revision=(
                                  constraints.speech_capability_revision if constraints else None),
                              expected_requirement_digest=(
                                  compute_speech_route_requirement_digest_for_payload(topic, data)
                                  if constraints else None))
                emit("service_guard", topic, result, fields)
            except Exception as exc:
                emit("service_diagnostic_error", topic, result, {"error_class": type(exc).__name__})
        return result

    RPCHandler._validate_speech_route_binding = rpc_check
    BaseService._envelope_speech_route_binding_valid = envelope_check
    original_rejection = RPCHandler._send_capability_changed

    async def rejection(self, **kwargs):
        topic = kwargs["method_name"]
        if topic in topics:
            emit("rpc_preaccept_response", topic, False,
                 {"correlation_id": kwargs.get("correlation_id")})
        return await original_rejection(self, **kwargs)

    RPCHandler._send_capability_changed = rejection

    def close() -> None:
        try:
            rows.put_nowait(None)
        except queue.Full:
            return
        writer.join(timeout=2)

    atexit.register(close)

"""Bounded nonblocking private writer for mesh-route observation rows."""
from __future__ import annotations

import json
import os
import queue
import threading
import time
from pathlib import Path
from typing import Any

_STOP = object()
_MAX_ROW_BYTES = 32 * 1024
_MAX_ROWS = 1_000
_MAX_TOTAL_BYTES = 32 * 1024 * 1024
_QUEUE_SIZE = 128
_SAFE_ROUTE_STATUSES = frozenset({
    "exact_peer_session_lookup_unavailable", "peer_connection_registry_unavailable",
    "exact_peer_session_lookup_failed", "exact_peer_session_missing",
    "exact_peer_connection_missing", "ice_transport_collection_unavailable",
    "nominated_pair_map_unavailable", "nominated_pair_component_invalid",
    "nominated_map_pair_not_marked_nominated", "nominated_pair_not_succeeded",
    "nominated_pair_fields_unavailable", "no_nominated_pair",
    "selected_nominated_pair_observed", "observer_failed",
})
_PAIR_KEYS = frozenset({
    "component", "ice_transport_ordinal", "pair_state", "nominated",
    "local_candidate_type", "remote_candidate_type", "local_protocol",
    "remote_protocol", "path_class",
})
_SNAPSHOT_KEYS = frozenset({
    "sampled_monotonic_ns", "clock_domain", "pid", "peer_id_sha256",
    "session_peer_id_sha256", "peer_connection_instance_sha256", "status",
    "selected_pairs",
})


class RouteObservationSink:
    """Queue bounded JSON rows without doing file I/O in the request path."""

    def __init__(self, rows_path: Path, status_path: Path) -> None:
        self.rows_path = rows_path
        self.status_path = status_path
        self._queue: queue.Queue[dict[str, Any] | object] = queue.Queue(maxsize=_QUEUE_SIZE)
        self._lock = threading.Lock()
        self._accepted = 0
        self._written = 0
        self._bytes = 0
        self._dropped = 0
        self._oversize = 0
        self._quota = 0
        self._invalid = 0
        self._writer_error: str | None = None
        self._stopping = False
        self._thread = threading.Thread(target=self._run, name="mesh-route-observer-writer", daemon=True)

    def start(self) -> None:
        for path in (self.rows_path, self.status_path):
            if path.is_symlink() or path.exists():
                raise ValueError("route_sink_output_exists_or_symlinked")
        self.rows_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(self.rows_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        os.chmod(self.rows_path, 0o600)
        self._thread.start()
        self._publish_status("accepting")

    def write(self, row: dict[str, Any]) -> None:
        """Accept one bounded row; this method never waits for queue space or I/O."""
        required_row_keys = {
            "schema", "topic", "correlation_id", "request_outcome",
            "request_monotonic_start_ns", "request_monotonic_end_ns",
            "requester_pid", "before", "after", "address_data_redacted",
        }
        if (not isinstance(row, dict) or set(row) != required_row_keys
                or row.get("schema") != "aurora.mesh_route_observation.v1"
                or row.get("topic") != "TTS.Synthesize"
                or row.get("request_outcome") not in ("ok", "failed", "raised")
                or row.get("address_data_redacted") is not True
                or (row.get("correlation_id") is not None and
                    (not isinstance(row.get("correlation_id"), str) or len(row["correlation_id"]) > 160))
                or any(type(row.get(key)) is not int for key in
                       ("request_monotonic_start_ns", "request_monotonic_end_ns", "requester_pid"))):
            with self._lock:
                self._invalid += 1
            return
        for snapshot_name in ("before", "after"):
            snapshot = row.get(snapshot_name)
            pairs = snapshot.get("selected_pairs") if isinstance(snapshot, dict) else None
            if (not isinstance(snapshot, dict) or not set(snapshot).issubset(_SNAPSHOT_KEYS)
                    or snapshot.get("status") not in _SAFE_ROUTE_STATUSES
                    or type(snapshot.get("sampled_monotonic_ns")) is not int
                    or type(snapshot.get("pid")) is not int
                    or any(value is not None and (not isinstance(value, str) or len(value) > 160)
                           for key, value in snapshot.items() if isinstance(value, str) or value is not None
                           if key in ("clock_domain", "peer_id_sha256", "session_peer_id_sha256",
                                      "peer_connection_instance_sha256"))
                    or (pairs is not None and (not isinstance(pairs, list) or len(pairs) > 32))):
                with self._lock:
                    self._oversize += 1
                return
            if isinstance(pairs, list):
                if any(not isinstance(pair, dict) or set(pair) != _PAIR_KEYS
                       or type(pair.get("component")) is not int or type(pair.get("ice_transport_ordinal")) is not int
                       or pair.get("pair_state") not in ("succeeded", "failed", "frozen", "waiting")
                       or pair.get("nominated") is not True
                       or pair.get("local_candidate_type") not in ("host", "srflx", "prflx", "relay")
                       or pair.get("remote_candidate_type") not in ("host", "srflx", "prflx", "relay")
                       or pair.get("local_protocol") not in ("udp", "tcp", "tcp-so")
                       or pair.get("remote_protocol") not in ("udp", "tcp", "tcp-so")
                       or pair.get("path_class") not in ("direct", "relay") for pair in pairs):
                    with self._lock:
                        self._invalid += 1
                    return
        # Copy the finite allowlisted structure so the caller can return without
        # retaining mutable observer-owned nested objects. JSON work stays off
        # the PeerBridge call path.
        queued_row = dict(row)
        for snapshot_name in ("before", "after"):
            snapshot = dict(row[snapshot_name])
            if isinstance(snapshot.get("selected_pairs"), list):
                snapshot["selected_pairs"] = [dict(pair) for pair in snapshot["selected_pairs"]]
            queued_row[snapshot_name] = snapshot
        with self._lock:
            if self._stopping or self._writer_error is not None:
                self._dropped += 1
                return
            if self._accepted >= _MAX_ROWS:
                self._quota += 1
                return
            try:
                self._queue.put_nowait(queued_row)
            except queue.Full:
                self._dropped += 1
                return
            self._accepted += 1

    def close(self, timeout_seconds: float = 3.0) -> bool:
        """Stop accepting rows and drain for at most the supplied finite bound."""
        deadline = time.monotonic() + max(0.0, min(timeout_seconds, 3.0))
        with self._lock:
            self._stopping = True
        queued_stop = False
        while time.monotonic() < deadline:
            try:
                self._queue.put_nowait(_STOP)
                queued_stop = True
                break
            except queue.Full:
                time.sleep(0.01)
        self._thread.join(max(0.0, deadline - time.monotonic()))
        with self._lock:
            complete = (queued_stop and not self._thread.is_alive()
                        and self._written == self._accepted and self._dropped == 0
                        and self._oversize == 0 and self._quota == 0
                        and self._invalid == 0 and self._writer_error is None)
        self._publish_status("closed" if complete else "drain_incomplete", complete=complete)
        return complete

    def _run(self) -> None:
        try:
            with self.rows_path.open("ab", buffering=0) as stream:
                while True:
                    item = self._queue.get()
                    try:
                        if item is _STOP:
                            break
                        if not isinstance(item, dict):
                            continue
                        try:
                            encoded = (json.dumps(item, sort_keys=True, separators=(",", ":"),
                                                  allow_nan=False) + "\n").encode("utf-8")
                        except (TypeError, ValueError, UnicodeError):
                            with self._lock:
                                self._invalid += 1
                            continue
                        with self._lock:
                            if len(encoded) > _MAX_ROW_BYTES:
                                self._oversize += 1
                                continue
                            if self._bytes + len(encoded) > _MAX_TOTAL_BYTES:
                                self._quota += 1
                                continue
                        stream.write(encoded)
                        with self._lock:
                            self._written += 1
                            self._bytes += len(encoded)
                    finally:
                        self._queue.task_done()
                    self._publish_status("draining" if self._stopping else "accepting")
                stream.flush()
                os.fsync(stream.fileno())
        except BaseException as exc:
            with self._lock:
                self._writer_error = _safe_error_class(exc)
                self._dropped += self._queue.qsize()
                while True:
                    try:
                        self._queue.get_nowait()
                        self._queue.task_done()
                    except queue.Empty:
                        break
            self._publish_status("writer_failed")

    def _publish_status(self, state: str, *, complete: bool = False) -> None:
        with self._lock:
            value = {
                "schema": "aurora.mesh_route_observation_sink.v1",
                "state": state,
                "complete": complete,
                "accepted_rows": self._accepted,
                "written_rows": self._written,
                "written_bytes": self._bytes,
                "dropped_rows": self._dropped,
                "oversize_rows": self._oversize,
                "quota_rows": self._quota,
                "invalid_rows": self._invalid,
                "writer_error_class": self._writer_error,
                "max_rows": _MAX_ROWS,
                "max_row_bytes": _MAX_ROW_BYTES,
                "max_total_bytes": _MAX_TOTAL_BYTES,
                "queue_capacity": _QUEUE_SIZE,
            }
        temporary = self.status_path.with_name(f".{self.status_path.name}.{os.getpid()}.tmp")
        try:
            encoded = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(encoded)
                stream.flush()
            os.replace(temporary, self.status_path)
            os.chmod(self.status_path, 0o600)
        except OSError:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            with self._lock:
                self._writer_error = "status_write_failed"


def _safe_error_class(exc: BaseException) -> str:
    name = type(exc).__name__
    return name if name in {"OSError", "ValueError", "TypeError", "PermissionError"} else "other"

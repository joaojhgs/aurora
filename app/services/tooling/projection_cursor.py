"""Process-bound integrity protected cursors for projection-v1."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import asdict, dataclass


class ProjectionCursorError(ValueError):
    """Bounded public cursor failure; never include cursor contents."""

    def __init__(self) -> None:
        super().__init__("projection_restart_required")


@dataclass(frozen=True)
class ProjectionCursor:
    recipient_peer_id: str
    provider_peer_id: str
    protocol_tier: str
    projection_revision: str
    projection_digest: str
    page_size: int
    next_offset: int
    page_index: int
    expires_at: int
    nonce: str


class ProjectionCursorCodec:
    def __init__(self, secret: bytes | None = None) -> None:
        self._secret = secret or secrets.token_bytes(32)

    def encode(self, cursor: ProjectionCursor) -> str:
        raw = json.dumps(asdict(cursor), sort_keys=True, separators=(",", ":")).encode()
        signature = hmac.new(self._secret, raw, hashlib.sha256).digest()
        return base64.urlsafe_b64encode(raw + signature).rstrip(b"=").decode()

    def decode(self, token: str, *, now: int | None = None) -> ProjectionCursor:
        try:
            padded = token + "=" * (-len(token) % 4)
            packed = base64.urlsafe_b64decode(padded.encode())
            raw, supplied = packed[:-32], packed[-32:]
            expected = hmac.new(self._secret, raw, hashlib.sha256).digest()
            if not hmac.compare_digest(supplied, expected):
                raise ProjectionCursorError
            cursor = ProjectionCursor(**json.loads(raw))
            if (int(time.time()) if now is None else now) >= cursor.expires_at:
                raise ProjectionCursorError
            return cursor
        except ProjectionCursorError:
            raise
        except Exception as exc:
            raise ProjectionCursorError from exc

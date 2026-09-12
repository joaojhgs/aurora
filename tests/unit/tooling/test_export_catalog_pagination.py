import pytest

from app.services.tooling.projection_cursor import (
    ProjectionCursor,
    ProjectionCursorCodec,
    ProjectionCursorError,
)


def cursor(**overrides):
    values = {
        "recipient_peer_id": "peer-a",
        "provider_peer_id": "provider",
        "protocol_tier": "projection_v1",
        "projection_revision": "r1",
        "projection_digest": "d" * 64,
        "page_size": 2,
        "next_offset": 2,
        "page_index": 1,
        "expires_at": 100,
        "nonce": "n",
    }
    values.update(overrides)
    return ProjectionCursor(**values)


def test_cursor_is_process_bound_integrity_protected_and_expiry_is_exclusive():
    first = ProjectionCursorCodec(b"a" * 32)
    token = first.encode(cursor())
    assert first.decode(token, now=99).recipient_peer_id == "peer-a"
    with pytest.raises(ProjectionCursorError, match="projection_restart_required"):
        first.decode(token, now=100)
    with pytest.raises(ProjectionCursorError, match="projection_restart_required"):
        ProjectionCursorCodec(b"b" * 32).decode(token, now=99)


@pytest.mark.parametrize("mutation", [lambda s: s[:-1], lambda s: s + "A", lambda s: "A" + s[1:]])
def test_cursor_tampering_has_one_bounded_failure(mutation):
    codec = ProjectionCursorCodec(b"a" * 32)
    with pytest.raises(ProjectionCursorError, match="^projection_restart_required$"):
        codec.decode(mutation(codec.encode(cursor())), now=1)

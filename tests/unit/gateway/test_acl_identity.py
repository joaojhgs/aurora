"""Unit tests for app.services.gateway.acl.identity."""

import pytest

from app.services.gateway.acl.identity import ANONYMOUS, SYSTEM, Identity, build_identity

# ── Fixtures ─────────────────────────────────────────────────────────────


@pytest.fixture
def sample_identity():
    return Identity(
        principal_id="user123",
        principal_name="testuser",
        is_admin=False,
        permissions=frozenset(["chat.send", "audio.play", "device.status.*", "chat.receive"]),
        effective_perms=frozenset(["chat.send", "audio.play", "device.status.*"]),
        device_id="device-abc",
        source="http_bearer",
        metadata={"token_id": "tok1"},
    )


@pytest.fixture
def admin_identity():
    return Identity(
        principal_id="admin456",
        principal_name="admin",
        is_admin=True,
        permissions=frozenset(["*"]),
        effective_perms=frozenset(["*"]),
    )


# ── Construction ─────────────────────────────────────────────────────────


def test_identity_creation(sample_identity):
    assert sample_identity.principal_id == "user123"
    assert sample_identity.principal_name == "testuser"
    assert not sample_identity.is_admin
    assert "chat.send" in sample_identity.effective_perms
    assert sample_identity.device_id == "device-abc"
    assert sample_identity.source == "http_bearer"
    assert sample_identity.metadata == {"token_id": "tok1"}


def test_identity_default_values():
    identity = Identity(principal_id="anon")
    assert identity.principal_name == ""
    assert not identity.is_admin
    assert identity.permissions == frozenset()
    assert identity.effective_perms == frozenset()
    assert identity.metadata == {}


# ── Sentinel identities ─────────────────────────────────────────────────


def test_anonymous_identity():
    assert ANONYMOUS.principal_id == "anonymous"
    assert ANONYMOUS.is_admin is False
    assert ANONYMOUS.permissions == frozenset()
    assert ANONYMOUS.effective_perms == frozenset()
    assert ANONYMOUS.can("anything") is False


def test_system_identity():
    assert SYSTEM.principal_id == "system"
    assert SYSTEM.is_admin is True
    assert SYSTEM.permissions == frozenset(["*"])
    assert SYSTEM.can("anything") is True


# ── Permission checking via .can() ───────────────────────────────────────


@pytest.mark.parametrize(
    "permission, expected",
    [
        ("chat.send", True),
        ("audio.play", True),
        ("device.status.get", True),  # Wildcard match via "device.status.*"
        ("device.status.set", True),  # Wildcard match via "device.status.*"
        ("device.control.light", False),  # No match
        ("chat.receive", False),  # Not in list
        ("admin.do_anything", False),
    ],
)
def test_identity_can(sample_identity, permission, expected):
    assert sample_identity.can(permission) == expected


def test_admin_identity_can(admin_identity):
    assert admin_identity.can("any.permission.at.all") is True
    assert admin_identity.can("chat.send") is True


@pytest.mark.parametrize(
    "required_permissions, expected",
    [
        (["chat.send"], True),
        (["chat.send", "audio.play"], True),
        (["chat.send", "device.status.get"], True),
        (["chat.send", "audio.play", "device.status.set"], True),
        (["chat.send", "audio.play", "chat.receive"], False),  # One missing
        (["admin.do_anything"], False),
        ([], True),  # No permissions required
    ],
)
def test_identity_has_all_permissions(sample_identity, required_permissions, expected):
    assert sample_identity.has_all_permissions(required_permissions) == expected


def test_admin_identity_has_all_permissions(admin_identity):
    assert admin_identity.has_all_permissions(["any.permission", "another.one"]) is True
    assert admin_identity.has_all_permissions([]) is True


# ── build_identity ───────────────────────────────────────────────────────


class TestBuildIdentity:
    """Tests for the build_identity factory."""

    def test_admin_user_wildcard_token(self):
        ident = build_identity(
            user_id="u1",
            username="admin",
            user_permissions=["*"],
            user_is_admin=True,
            token_scopes=["*"],
        )
        assert ident.is_admin is True
        assert "*" in ident.effective_perms
        assert ident.permissions == frozenset(["*"])

    def test_admin_user_restricted_token(self):
        """Admin user — always gets wildcard effective_perms."""
        ident = build_identity(
            user_id="u1",
            username="admin",
            user_permissions=["*"],
            user_is_admin=True,
            token_scopes=["TTS.Say", "STT.Transcribe"],
        )
        # resolve_effective_permissions returns {"*"} for admins
        assert ident.is_admin is True
        assert "*" in ident.effective_perms
        assert ident.permissions == frozenset(["*"])

    def test_normal_user_wildcard_token(self):
        """Normal user + wildcard token = user perms only."""
        ident = build_identity(
            user_id="u1",
            username="user",
            user_permissions=["TTS.Say", "STT.Transcribe"],
            user_is_admin=False,
            token_scopes=["*"],
        )
        assert ident.is_admin is False
        assert "TTS.Say" in ident.effective_perms
        assert "STT.Transcribe" in ident.effective_perms
        assert "*" not in ident.effective_perms
        # User-level permissions should contain the original set
        assert ident.permissions == frozenset(["TTS.Say", "STT.Transcribe"])

    def test_normal_user_restricted_token_intersection(self):
        """Normal user + restricted token = intersection."""
        ident = build_identity(
            user_id="u1",
            username="user",
            user_permissions=["TTS.Say", "STT.Transcribe", "DB.Read"],
            user_is_admin=False,
            token_scopes=["TTS.Say", "STT.Transcribe"],
        )
        assert ident.is_admin is False
        assert "TTS.Say" in ident.effective_perms
        assert "STT.Transcribe" in ident.effective_perms
        assert "DB.Read" not in ident.effective_perms  # Not in token scopes
        # User-level permissions are the full set, not the intersection
        assert "DB.Read" in ident.permissions
        assert ident.permissions == frozenset(["TTS.Say", "STT.Transcribe", "DB.Read"])

    def test_normal_user_no_overlap(self):
        """Normal user + token with different scopes = empty."""
        ident = build_identity(
            user_id="u1",
            username="user",
            user_permissions=["TTS.Say"],
            user_is_admin=False,
            token_scopes=["DB.Read"],
        )
        assert ident.is_admin is False
        assert len(ident.effective_perms) == 0
        # User-level permissions are still preserved
        assert ident.permissions == frozenset(["TTS.Say"])

    def test_device_id_and_source(self):
        ident = build_identity(
            user_id="u1",
            username="device1",
            user_permissions=["TTS.Say"],
            user_is_admin=False,
            token_scopes=["*"],
            device_id="dev-123",
            source="webrtc_peer",
        )
        assert ident.device_id == "dev-123"
        assert ident.source == "webrtc_peer"
        assert ident.permissions == frozenset(["TTS.Say"])

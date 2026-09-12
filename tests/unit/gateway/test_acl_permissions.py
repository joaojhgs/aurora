"""Unit tests for app.services.gateway.acl.permissions."""

import pytest
from pydantic import ValidationError

from app.services.gateway.acl.permissions import (
    PERM_ALL,
    check_access,
    has_permission,
    resolve_effective_permissions,
    wildcard_intersection,
)
from app.shared.auth.permissions import NativeToolPermissions, validate_permission
from app.shared.contracts.models.mesh import MeshPeerSaveInboundRequest
from app.shared.contracts.models.orchestrator import OrchestratorMethods


def test_remote_inference_permission_is_grantable() -> None:
    assert validate_permission(OrchestratorMethods.REMOTE_INFERENCE) == (
        "Orchestrator.RemoteInference"
    )


def test_remote_dispatch_permission_is_grantable() -> None:
    assert validate_permission(OrchestratorMethods.REMOTE_DISPATCH) == (
        "Orchestrator.RemoteDispatch"
    )


@pytest.mark.parametrize(
    ("granted", "expected"),
    [
        ({"Orchestrator.use"}, True),
        ({"Orchestrator.*"}, True),
        ({OrchestratorMethods.REMOTE_INFERENCE}, True),
        ({"*"}, True),
        ({"Orchestrator.manage"}, False),
    ],
)
def test_orchestrator_use_permission_hierarchy(granted: set[str], expected: bool) -> None:
    assert (
        has_permission(
            OrchestratorMethods.REMOTE_INFERENCE,
            granted,
            method_type="use",
        )
        is expected
    )


def test_native_device_permissions_are_valid_credential_scopes() -> None:
    request = MeshPeerSaveInboundRequest(
        remote_peer_id="android-peer",
        room_name="aurora-room",
        token="opaque-token",
        permissions=[
            NativeToolPermissions.GET_DEVICE_STATUS,
            NativeToolPermissions.SHARE_TEXT,
        ],
    )

    assert request.permissions == ["Native.GetDeviceStatus", "Native.ShareText"]


def test_unknown_native_device_permission_remains_fail_closed() -> None:
    with pytest.raises(ValidationError, match="Unknown permission 'Native.Unknown'"):
        MeshPeerSaveInboundRequest(
            remote_peer_id="android-peer",
            room_name="aurora-room",
            token="opaque-token",
            permissions=["Native.Unknown"],
        )


# ── has_permission ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "required, granted, expected",
    [
        # Direct matches
        ("TTS.Request", {"TTS.Request"}, True),
        ("STT.Transcribe", {"STT.Transcribe"}, True),
        # Global wildcard
        ("TTS.Request", {"*"}, True),
        ("anything.at.all", {"*"}, True),
        # Service-level wildcard
        ("TTS.Request", {"TTS.*"}, True),
        ("TTS.Say", {"TTS.*"}, True),
        # No match
        ("TTS.Request", {"STT.*"}, False),
        ("TTS.Request", {"STT.Request"}, False),
        ("TTS.Request", set(), False),
        # Case sensitivity
        ("TTS.Request", {"tts.request"}, False),
    ],
)
def test_has_permission(required, granted, expected):
    assert has_permission(required, granted) == expected


# ── check_access ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "effective, required, expected",
    [
        # All required present
        ({"TTS.Request", "STT.Transcribe"}, ["TTS.Request", "STT.Transcribe"], True),
        # One required missing
        ({"TTS.Request"}, ["TTS.Request", "STT.Transcribe"], False),
        # Global wildcard covers all
        ({"*"}, ["TTS.Request", "STT.Transcribe"], True),
        # Service wildcard covers all under that service
        ({"TTS.*"}, ["TTS.Request", "TTS.Say"], True),
        # Mix of direct and wildcard
        ({"TTS.Request", "STT.*"}, ["TTS.Request", "STT.Transcribe"], True),
        # No required permissions
        ({"TTS.Request"}, [], True),
        # No effective permissions, but required
        (set(), ["TTS.Request"], False),
        # Complex scenario
        (
            {"chat.*", "audio.play", "system.status"},
            ["chat.send", "audio.play", "system.status"],
            True,
        ),
        (
            {"chat.*", "system.status"},
            ["chat.send", "audio.play", "system.status"],
            False,  # audio.play is missing
        ),
    ],
)
def test_check_access(effective, required, expected):
    assert check_access(effective, required) == expected


# ── wildcard_intersection ────────────────────────────────────────────────


@pytest.mark.parametrize(
    "user_perms, token_scopes, expected",
    [
        # Exact overlap
        ({"TTS.Request"}, {"TTS.Request"}, {"TTS.Request"}),
        # Token scope covered by user wildcard
        ({"TTS.*"}, {"TTS.Request"}, {"TTS.Request"}),
        # User perm covered by token wildcard
        ({"TTS.Request"}, {"TTS.*"}, {"TTS.Request"}),
        # Partial overlap
        ({"TTS.*", "STT.*"}, {"TTS.Request", "DB.Get"}, {"TTS.Request"}),
        # No overlap
        ({"TTS.Request"}, {"STT.Transcribe"}, set()),
        # Both have global wildcard
        ({"*"}, {"*"}, {"*"}),
        # Token wildcard, user specific
        ({"TTS.Request", "STT.Transcribe"}, {"*"}, {"TTS.Request", "STT.Transcribe"}),
    ],
)
def test_wildcard_intersection(user_perms, token_scopes, expected):
    assert wildcard_intersection(user_perms, token_scopes) == expected


# ── resolve_effective_permissions ────────────────────────────────────────


class TestResolveEffectivePermissions:
    def test_admin_gets_wildcard(self):
        result = resolve_effective_permissions(
            user_permissions=["TTS.Request"],
            user_is_admin=True,
            token_scopes=["TTS.Request"],
        )
        assert result == {"*"}

    def test_token_wildcard_inherits_user_perms(self):
        result = resolve_effective_permissions(
            user_permissions=["TTS.Request", "STT.Transcribe"],
            user_is_admin=False,
            token_scopes=["*"],
        )
        assert result == {"TTS.Request", "STT.Transcribe"}

    def test_token_all_inherits_user_perms(self):
        result = resolve_effective_permissions(
            user_permissions=["TTS.Request"],
            user_is_admin=False,
            token_scopes=["all"],
        )
        assert result == {"TTS.Request"}

    def test_intersection(self):
        result = resolve_effective_permissions(
            user_permissions=["TTS.Request", "STT.Transcribe", "DB.Read"],
            user_is_admin=False,
            token_scopes=["TTS.Request", "STT.Transcribe"],
        )
        assert result == {"TTS.Request", "STT.Transcribe"}

    def test_no_overlap(self):
        result = resolve_effective_permissions(
            user_permissions=["TTS.Request"],
            user_is_admin=False,
            token_scopes=["DB.Read"],
        )
        assert result == set()

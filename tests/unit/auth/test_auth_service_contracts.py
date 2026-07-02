from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.auth.service import AuthService
from app.shared.contracts.models.auth import (
    PrincipalListRequest,
    TokenCreateRequest,
    TokenListRequest,
)
from app.shared.models.db import Token, User


@pytest.mark.asyncio
async def test_auth_list_apis_normalize_permissions_and_token_scopes() -> None:
    service = AuthService()
    listed_token = Token(
        id="tok-list",
        token_hash="hash",
        prefix="pref",
        user_id="user-1",
        scopes=["tts.*"],
        created_at=datetime(2026, 1, 1),
        expires_at=datetime(2026, 2, 1),
    )
    # Simulate a stale local DB row that still stores a JSON string, legacy
    # "all", lower-case prefixes, and duplicate scopes.
    listed_token.scopes = '["tts.*", "all", "tts.*"]'  # type: ignore[assignment]
    created_token = Token(
        id="tok-create",
        token_hash="hash2",
        prefix="pref2",
        user_id="user-1",
        scopes=["config.manage", "all", "config.manage"],
        created_at=datetime(2026, 1, 2),
        expires_at=datetime(2026, 3, 1),
    )
    service._manager = SimpleNamespace(
        list_principals=AsyncMock(
            return_value=[
                User(
                    id="user-1",
                    username="operator",
                    password_hash="hash",
                    permissions=["auth.manage", "all", "auth.manage"],
                    is_admin=True,
                    created_at=datetime(2026, 1, 1),
                )
            ]
        ),
        list_tokens=AsyncMock(return_value=[listed_token]),
        create_token_for_principal=AsyncMock(return_value=(created_token, "raw-token")),
    )

    principals = await service.handle_list_principals(PrincipalListRequest())
    tokens = await service.handle_list_tokens(TokenListRequest())
    created = await service.handle_create_token(
        TokenCreateRequest(principal_id="user-1", scopes=["Config.manage"], expires_in_days=30)
    )

    assert principals.principals[0].permissions == ["Auth.manage", "*"]
    assert tokens.tokens[0].scopes == ["TTS.*", "*"]
    assert not isinstance(created, dict)
    assert created.scopes == ["Config.manage", "*"]
    service.manager.list_principals.assert_awaited_once()
    service.manager.list_tokens.assert_awaited_once_with(principal_id=None, device_id=None)
    service.manager.create_token_for_principal.assert_awaited_once()

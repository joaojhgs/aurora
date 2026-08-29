"""Side-effect-free Auth pairing readiness contract regression tests."""

import pytest

from app.services.auth.service import AuthService
from app.shared.contracts.models.common import EmptyInput


@pytest.mark.asyncio
async def test_pairing_ready_does_not_require_manager_or_database() -> None:
    service = AuthService()

    response = await service.handle_pairing_ready(EmptyInput())

    assert response.success is True

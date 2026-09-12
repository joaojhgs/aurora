"""Regression tests for Orchestrator runtime capability permissions."""

import pytest

from app.services.gateway.orchestrator_runtime_policy import (
    remote_data_movement_denial_reason,
)
from app.shared.contracts.models.orchestrator import OrchestratorMethods


@pytest.mark.parametrize(
    "granted",
    [
        {"Orchestrator.use"},
        {"Orchestrator.*"},
        {OrchestratorMethods.REMOTE_INFERENCE},
        {"*"},
    ],
)
def test_remote_inference_accepts_coarse_or_granular_use_grants(granted: set[str]) -> None:
    reason = remote_data_movement_denial_reason(
        OrchestratorMethods.INFER_CHAT,
        {"messages": [{"role": "user", "content": "hello"}], "provider_id": "openai"},
        granted,
    )

    assert reason is None


def test_remote_inference_rejects_manage_only_grant() -> None:
    reason = remote_data_movement_denial_reason(
        OrchestratorMethods.INFER_CHAT,
        {"messages": [{"role": "user", "content": "hello"}], "provider_id": "openai"},
        {"Orchestrator.manage"},
    )

    assert reason is not None
    assert "Orchestrator.RemoteInference" in reason


@pytest.mark.parametrize(
    "granted",
    [
        {"Orchestrator.use"},
        {"Orchestrator.*"},
        {OrchestratorMethods.REMOTE_DISPATCH},
        {"*"},
    ],
)
def test_remote_dispatch_accepts_coarse_or_granular_use_grants(granted: set[str]) -> None:
    reason = remote_data_movement_denial_reason(
        OrchestratorMethods.EXTERNAL_USER_INPUT,
        {"text": "hello", "dispatch_selector": {"peer_id": "assistant-peer"}},
        granted,
    )

    assert reason is None


def test_remote_dispatch_rejects_manage_only_grant() -> None:
    reason = remote_data_movement_denial_reason(
        OrchestratorMethods.EXTERNAL_USER_INPUT,
        {"text": "hello", "dispatch_selector": {"peer_id": "assistant-peer"}},
        {"Orchestrator.manage"},
    )

    assert reason is not None
    assert "Orchestrator.RemoteDispatch" in reason

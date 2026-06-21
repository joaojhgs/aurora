"""Assistant attachment/context ingestion contract tests."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from app.services.orchestrator.service import OrchestratorService
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.db import DBMethods
from app.shared.contracts.models.orchestrator import (
    AttachmentContextIngestRequest,
    AttachmentContextItem,
    AttachmentContextSource,
    OrchestratorMethods,
)
from app.shared.contracts.registry import all_contracts, clear_registry


def _service_with_bus(bus: AsyncMock) -> OrchestratorService:
    service = OrchestratorService()
    service._bus = bus
    return service


def test_ingest_context_contract_registers_external_use_permission():
    clear_registry()
    OrchestratorService()

    contract = all_contracts()[OrchestratorMethods.INGEST_CONTEXT]
    assert contract.exposure == "external"
    assert contract.method_type == "use"
    assert contract.required_perms == ["Orchestrator.use"]
    assert contract.input_model is AttachmentContextIngestRequest


@pytest.mark.asyncio
async def test_ingest_context_redacts_and_stores_text_in_rag():
    bus = AsyncMock()
    bus.request = AsyncMock(return_value=None)
    service = _service_with_bus(bus)

    with patch("app.shared.services.base_service.get_bus_singleton", return_value=bus):
        response = await service.ingest_context(
            AttachmentContextIngestRequest(
                storage_policy="rag",
                privacy_class="personal",
                caller_principal_id="user-1",
                correlation_id="corr-1",
                policy_decision_id="policy-1",
                items=[
                    AttachmentContextItem(
                        kind="text",
                        title="Notes",
                        content_text="Keep this. api_key=sk-secret-value",
                        metadata={"source": "unit"},
                    )
                ],
            )
        )

    assert response.accepted is True
    assert response.rejected is False
    assert response.correlation_id == "corr-1"
    assert response.accepted_items[0].status == "stored"
    assert response.accepted_items[0].redacted is True
    assert "credential" in response.accepted_items[0].redaction_reasons

    rag_call = next(
        call for call in bus.request.await_args_list if call.args[0] == DBMethods.RAG_STORE
    )
    rag_request = rag_call.args[1]
    stored = json.loads(rag_request.value)
    assert rag_request.namespace == "assistant.attachments"
    assert stored["text"] == "Keep this. [REDACTED]"
    assert stored["policy_decision_id"] == "policy-1"
    assert stored["source"]["channel"] == "api"

    audit_call = next(
        call
        for call in bus.request.await_args_list
        if call.args[0] == AuthMethods.STORE_AUDIT_EVENT
    )
    audit_request = audit_call.args[1]
    audit_details = json.loads(audit_request.details)
    assert audit_request.event == "assistant.context.ingested"
    assert audit_request.principal_id == "user-1"
    assert audit_details["accepted_count"] == 1
    assert audit_details["redacted_count"] == 1
    assert "sk-secret-value" not in audit_request.details


@pytest.mark.asyncio
async def test_ingest_context_redacts_persisted_provenance_and_metadata():
    bus = AsyncMock()
    bus.request = AsyncMock(return_value=None)
    service = _service_with_bus(bus)

    with patch("app.shared.services.base_service.get_bus_singleton", return_value=bus):
        response = await service.ingest_context(
            AttachmentContextIngestRequest(
                storage_policy="rag",
                privacy_class="sensitive",
                caller_principal_id="user-1",
                correlation_id="corr-2",
                items=[
                    AttachmentContextItem(
                        kind="url",
                        title="Shared password=title-secret",
                        filename="/Users/alice/private/token-file.txt",
                        url=(
                            "https://user:pass@example.com/shared/doc"
                            "?access_token=url-secret&expires=never#frag"
                        ),
                        source=AttachmentContextSource(
                            channel="mobile_share_sheet",
                            uri="myapp://share/open?token=source-secret",
                            display_name="Display token=display-secret",
                            originating_app="Bearer abcdefghijklmnop",
                        ),
                        metadata={
                            "safe_label": "kept",
                            "api_key": "metadata-key-secret",
                            "callback_url": "https://callback.example/cb?token=metadata-url-secret",
                            "notes": ["password=list-secret"],
                            "nested": {"safe": "secret=nested-secret"},
                        },
                    )
                ],
            )
        )

    assert response.accepted is True
    assert response.accepted_items[0].redacted is True
    assert "url_uri_credentials" in response.accepted_items[0].redaction_reasons
    assert "metadata_metadata_key" in response.accepted_items[0].redaction_reasons

    rag_call = next(
        call for call in bus.request.await_args_list if call.args[0] == DBMethods.RAG_STORE
    )
    stored = json.loads(rag_call.args[1].value)
    stored_json = json.dumps(stored, sort_keys=True)

    assert stored["url"] == "https://example.com/[REDACTED]"
    assert stored["source"]["channel"] == "mobile_share_sheet"
    assert stored["source"]["uri"] == "myapp://[REDACTED]"
    assert stored["metadata"]["safe_label"] == "kept"
    assert "api_key" not in stored["metadata"]
    assert stored["metadata"]["callback_url"] == "https://callback.example/[REDACTED]"
    assert stored["metadata"]["notes"] == ["[REDACTED]"]
    assert stored["metadata"]["nested"]["safe"] == "[REDACTED]"

    for raw_secret in (
        "title-secret",
        "token-file",
        "url-secret",
        "source-secret",
        "display-secret",
        "abcdefghijklmnop",
        "metadata-key-secret",
        "metadata-url-secret",
        "list-secret",
        "nested-secret",
        "user:pass",
        "/Users/alice",
    ):
        assert raw_secret not in stored_json


@pytest.mark.asyncio
async def test_ingest_context_rejects_oversized_item_without_rag_store():
    bus = AsyncMock()
    bus.request = AsyncMock(return_value=None)
    service = _service_with_bus(bus)

    with patch("app.shared.services.base_service.get_bus_singleton", return_value=bus):
        response = await service.ingest_context(
            AttachmentContextIngestRequest(
                storage_policy="rag",
                limits={"max_item_bytes": 4},
                items=[AttachmentContextItem(kind="text", content_text="too large")],
            )
        )

    assert response.accepted is False
    assert response.rejected is True
    assert response.rejected_items[0].reason_code == "item_too_large"
    assert all(call.args[0] != DBMethods.RAG_STORE for call in bus.request.await_args_list)
    assert any(
        call.args[0] == AuthMethods.STORE_AUDIT_EVENT for call in bus.request.await_args_list
    )


@pytest.mark.asyncio
async def test_ingest_context_blocks_secret_privacy_class():
    bus = AsyncMock()
    bus.request = AsyncMock(return_value=None)
    service = _service_with_bus(bus)

    with patch("app.shared.services.base_service.get_bus_singleton", return_value=bus):
        response = await service.ingest_context(
            AttachmentContextIngestRequest(
                storage_policy="ephemeral",
                privacy_class="credential",
                items=[AttachmentContextItem(kind="text", content_text="password=secret")],
            )
        )

    assert response.accepted is False
    assert response.rejected_items[0].reason_code == "privacy_class_blocked"
    assert all(call.args[0] != DBMethods.RAG_STORE for call in bus.request.await_args_list)

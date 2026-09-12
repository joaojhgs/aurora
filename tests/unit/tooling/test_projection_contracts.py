"""Projection-v1 transport contract security invariants."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.shared.contracts.models.tooling import (
    ToolingGetExportCatalogRequest,
    ToolingGetExportCatalogResponse,
    ToolingProjectionAuthorityRevision,
    ToolingProjectionInvalidated,
)

AUTHORITY = ToolingProjectionAuthorityRevision(
    catalog_revision=1,
    export_policy_revision=2,
    auth_grant_revision=3,
    manifest_revision=4,
    switch_revision=5,
)
HASH = "a" * 64


def test_export_request_has_no_caller_selected_peer_authority() -> None:
    fields = ToolingGetExportCatalogRequest.model_fields
    assert "peer_id" not in fields
    assert "caller_peer_id" not in fields
    assert "provider_id" not in fields
    assert ToolingGetExportCatalogRequest(page_size=256).protocol_tier == "projection_v1"
    with pytest.raises(ValidationError):
        ToolingGetExportCatalogRequest(page_size=257)


def test_page_contract_binds_authority_and_terminal_checksum() -> None:
    partial = ToolingGetExportCatalogResponse(
        provider_peer_id="peer-a",
        service_instance_id="remote:peer-a:Tooling",
        authority_revision=AUTHORITY,
        projection_revision="rev-a",
        projection_digest=HASH,
        page_index=0,
        page_size=10,
        page_hash=HASH,
        next_cursor="opaque",
    )
    assert partial.final_checksum is None
    with pytest.raises(ValidationError):
        ToolingGetExportCatalogResponse(
            provider_peer_id="peer-a",
            service_instance_id="remote:peer-a:Tooling",
            authority_revision=AUTHORITY,
            projection_revision="rev-a",
            projection_digest=HASH,
            page_index=0,
            page_size=10,
            page_hash=HASH,
            complete=True,
        )


def test_invalidation_is_metadata_only() -> None:
    fields = ToolingProjectionInvalidated.model_fields
    assert not {"tools", "tool_ids", "global_tool_ids", "schemas"} & fields.keys()
    event = ToolingProjectionInvalidated(
        provider_peer_id="peer-a",
        service_instance_id="remote:peer-a:Tooling",
        authority_revision=AUTHORITY,
        reason_code="policy_changed",
        correlation_id="corr-a",
    )
    assert not {"tools", "tool_ids", "global_tool_ids", "schemas"} & event.model_dump().keys()

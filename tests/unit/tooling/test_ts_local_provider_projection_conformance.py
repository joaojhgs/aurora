"""Generated TypeScript local-provider projection compatibility with Python."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.services.db.manager import DatabaseManager
from app.services.db.tooling_remote_catalog_store import compute_projection_page_hash
from app.services.orchestrator.tool_bindings import build_tool_bindings
from app.services.tooling.service import ToolingService
from app.shared.contracts.models.db import (
    DBAppendToolingRemoteCatalogPageRequest,
    DBBeginToolingRemoteCatalogSyncRequest,
    DBCommitToolingRemoteCatalogSyncRequest,
    DBFinalizeToolingRemoteCatalogPolicyRequest,
    DBGetToolingRemoteCatalogRequest,
)
from app.shared.contracts.models.tooling import ToolingGetExportCatalogResponse

REPO_ROOT = Path(__file__).resolve().parents[3]
PROVIDER_ARTIFACT = REPO_ROOT / "packages/aurora-sdk/src/generated/tooling-local-provider-v1.json"
PROVIDER_ID = "typescript-local-tooling-provider-v1"


def _provider_document() -> dict[str, object]:
    document = json.loads(PROVIDER_ARTIFACT.read_text(encoding="utf-8"))
    assert isinstance(document, dict)
    return document


def _canonical_page() -> ToolingGetExportCatalogResponse:
    document = _provider_document()
    vectors = document["canonical_digest_vectors"]
    assert isinstance(vectors, dict)
    page_vector = vectors["page_hash"]
    assert isinstance(page_vector, dict)
    page = ToolingGetExportCatalogResponse.model_validate(page_vector["canonical_page"])
    assert page.page_hash == page_vector["digest"]
    return page


def _begin_request(
    page: ToolingGetExportCatalogResponse,
    *,
    sync_id: str,
) -> DBBeginToolingRemoteCatalogSyncRequest:
    return DBBeginToolingRemoteCatalogSyncRequest(
        sync_id=sync_id,
        peer_id=page.provider_peer_id,
        provider_id=PROVIDER_ID,
        service_instance_id=page.service_instance_id,
        protocol_tier=page.selected_protocol_tier,
        projection_revision=page.projection_revision,
        projection_digest=page.projection_digest,
        authority_revision=page.authority_revision,
        page_size=page.page_size,
        expected_base_generation=0,
    )


def test_generated_projection_page_is_exportable_and_internally_bound() -> None:
    document = _provider_document()
    vectors = document["canonical_digest_vectors"]
    assert isinstance(vectors, dict)

    page = _canonical_page()
    assert compute_projection_page_hash(page) == page.page_hash
    assert page.projection_digest == page.final_checksum
    assert page.total_count == len(page.tools)
    assert page.tools

    for tool in page.tools:
        assert tool.provider_peer_id == page.provider_peer_id
        assert tool.provider_service_instance_id == page.service_instance_id
        assert tool.provenance.provider_peer_id == page.provider_peer_id
        assert tool.provenance.provider_service_instance_id == page.service_instance_id
        assert tool.source_type == "local"
        assert tool.execution_location == "local"
        assert tool.exportable is True
        assert tool.share_group_id
        assert tool.share_group_label

    schema_vector = vectors["tool_schema_hash"]
    assert isinstance(schema_vector, dict)
    canonical_tool = schema_vector["canonical_tool"]
    assert isinstance(canonical_tool, dict)
    assert canonical_tool["argument_visibility"] == {}

    order_vector = vectors["order_independent_final_checksum"]
    assert isinstance(order_vector, dict)
    ordered_tools = order_vector["canonical_tools"]
    assert isinstance(ordered_tools, list)
    assert any(
        isinstance(tool, dict)
        and tool.get("argument_visibility") == {"api_key": "secret", "query": "display"}
        for tool in ordered_tools
    )


@pytest.mark.asyncio
async def test_generated_projection_stages_restarts_activates_and_binds(
    tmp_path: Path,
) -> None:
    page = _canonical_page()
    manager = DatabaseManager(str(tmp_path / "typescript-provider.db"))
    await manager.initialize()

    sync_id = "sync-typescript-provider-0001"
    begun = await manager.begin_tooling_remote_catalog_sync(_begin_request(page, sync_id=sync_id))
    assert begun.ok

    appended = await manager.append_tooling_remote_catalog_page(
        DBAppendToolingRemoteCatalogPageRequest(sync_id=sync_id, page=page)
    )
    assert appended.ok

    committed = await manager.commit_tooling_remote_catalog_sync(
        DBCommitToolingRemoteCatalogSyncRequest(
            sync_id=sync_id,
            expected_base_generation=0,
            defer_activation_for_policy_reconciliation=True,
            correlation_id="typescript-provider-commit",
        )
    )
    assert committed.ok
    assert committed.header is not None
    assert committed.header.availability == "stale"

    inactive = await manager.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(
            peer_id=page.provider_peer_id,
            provider_id=PROVIDER_ID,
            include_inactive=False,
        )
    )
    assert inactive.tools == []

    restarted = DatabaseManager(manager.db_path)
    await restarted.initialize()
    finalized = await restarted.finalize_tooling_remote_catalog_policy(
        DBFinalizeToolingRemoteCatalogPolicyRequest(
            peer_id=page.provider_peer_id,
            provider_id=PROVIDER_ID,
            expected_generation=1,
            expected_projection_revision=page.projection_revision,
            correlation_id="typescript-provider-finalize",
        )
    )
    assert finalized.ok

    active = await restarted.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(
            peer_id=page.provider_peer_id,
            provider_id=PROVIDER_ID,
            include_inactive=False,
        )
    )
    assert len(active.tools) == 1
    stored = active.tools[0]
    assert stored.availability == "active"
    assert stored.active_generation == 1
    assert stored.tool.share_group_id == "core:memory"
    assert stored.tool.exportable is True

    tooling_service = ToolingService.__new__(ToolingService)
    tooling_service._peer_display_names = {page.provider_peer_id: "TypeScript node"}
    remote_tool = tooling_service._bind_normalized_remote_tool(
        stored.tool,
        peer_id=page.provider_peer_id,
        service_instance_id=page.service_instance_id,
    )
    tools, bindings = build_tool_bindings([remote_tool.model_dump(mode="python")])
    assert len(tools) == 1
    binding = bindings[tools[0].name]
    assert binding["global_tool_id"] == stored.tool.global_tool_id
    assert binding["mesh_selector"]["peer_id"] == page.provider_peer_id
    assert binding["mesh_selector"]["service_instance_id"] == page.service_instance_id
    assert binding["mesh_selector"]["tool_id"] == stored.tool.global_tool_id


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("mutation", "expected_error"),
    [
        ("service_authority", "remote_catalog_invalid_tool_authority"),
        ("page_hash", "remote_catalog_page_hash_mismatch"),
    ],
)
async def test_generated_projection_rejects_mutated_authority_or_hash(
    tmp_path: Path,
    mutation: str,
    expected_error: str,
) -> None:
    page = _canonical_page()
    if mutation == "service_authority":
        page = page.model_copy(
            update={
                "service_instance_id": "local:other-peer:Tooling",
            }
        )
        page = page.model_copy(update={"page_hash": compute_projection_page_hash(page)})
    else:
        page = page.model_copy(update={"page_hash": "f" * 64})

    manager = DatabaseManager(str(tmp_path / f"rejected-{mutation}.db"))
    await manager.initialize()
    sync_id = f"sync-typescript-rejected-{mutation}-0001"
    assert (
        await manager.begin_tooling_remote_catalog_sync(_begin_request(page, sync_id=sync_id))
    ).ok

    if mutation == "service_authority":
        with pytest.raises(
            ValidationError,
            match="projection service_instance_id does not match provider identity",
        ):
            DBAppendToolingRemoteCatalogPageRequest(sync_id=sync_id, page=page)
        return

    rejected = await manager.append_tooling_remote_catalog_page(
        DBAppendToolingRemoteCatalogPageRequest(sync_id=sync_id, page=page)
    )
    assert not rejected.ok
    assert rejected.error == expected_error

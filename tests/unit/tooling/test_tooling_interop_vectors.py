import copy
import json
from pathlib import Path
from urllib.parse import quote

import pytest
from pydantic import ValidationError

from app.services.db.tool_identity_store import _canonical_id
from app.services.db.tooling_remote_catalog_store import (
    compute_projection_checksum,
    compute_projection_page_hash,
    compute_tool_schema_hash,
)
from app.shared.contracts.models.tooling import (
    ToolingGetExportCatalogResponse,
    ToolingMethods,
    ToolingProjectionBlockedTool,
    ToolingProjectionRetirement,
    ToolingToolInfo,
)

FIXTURE_PATH = (
    Path(__file__).parents[2]
    / "fixtures"
    / "tooling_interop"
    / "canonical_identity_digest_vectors.json"
)


@pytest.fixture(scope="module")
def vectors() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _tools_by_case(vectors: dict) -> dict[str, ToolingToolInfo]:
    return {
        entry["case"]: ToolingToolInfo.model_validate(entry["tool"])
        for entry in vectors["positive"]
    }


def _projection_page(vectors: dict) -> ToolingGetExportCatalogResponse:
    tools = _tools_by_case(vectors)
    projection = vectors["projection"]
    blocked = [
        ToolingProjectionBlockedTool(
            tool=tools[item["tool_case"]],
            reason_code=item["reason_code"],
            missing_permissions=item["missing_permissions"],
        )
        for item in projection["blocked_tools"]
    ]
    return ToolingGetExportCatalogResponse(
        provider_peer_id=vectors["stable_peer_id"],
        service_instance_id=vectors["provider_service_instance_id"],
        authority_revision=projection["authority_revision"],
        projection_revision=projection["projection_revision"],
        projection_digest=projection["projection_digest"],
        page_index=projection["page_index"],
        page_size=projection["page_size"],
        page_hash=projection["page_hash"],
        tools=list(tools.values()),
        blocked_tools=blocked,
        retirements=[
            ToolingProjectionRetirement.model_validate(item) for item in projection["retirements"]
        ],
        complete=True,
        total_count=len(tools),
        final_checksum=projection["final_checksum"],
    )


def _empty_projection_payload(provider_peer_id: str) -> dict:
    return {
        "ok": True,
        "provider_peer_id": provider_peer_id,
        "service_instance_id": f"remote:{provider_peer_id}:Tooling",
        "selected_protocol_tier": "projection_v1",
        "authority_revision": {
            "auth_grant_revision": 0,
            "catalog_revision": 0,
            "export_policy_revision": 0,
            "manifest_revision": 0,
            "protocol_revision": 1,
            "switch_revision": 0,
        },
        "projection_revision": "projection-boundary",
        "projection_digest": "a" * 64,
        "page_index": 0,
        "page_size": 1,
        "page_hash": "b" * 64,
        "tools": [],
        "blocked_tools": [],
        "retirements": [],
        "complete": True,
        "next_cursor": None,
        "total_count": 0,
        "final_checksum": "c" * 64,
    }


def _apply_fixture_patch(payload: dict, patch: dict) -> None:
    for raw_path, value in patch.items():
        path = str(raw_path).split(".")
        target = payload
        for segment in path[:-1]:
            target = target[int(segment)] if isinstance(target, list) else target[segment]
        key = path[-1]
        if value is None:
            if isinstance(target, list):
                target.pop(int(key))
            else:
                target.pop(key, None)
        elif isinstance(target, list):
            target[int(key)] = value
        else:
            target[key] = value


def test_accepts_local_percent_encoded_tooling_service_instance(vectors: dict):
    encoded_peer_id = quote(vectors["stable_peer_id"], safe="-._~")

    assert encoded_peer_id == vectors["percent_encoded_stable_peer_id"]
    assert vectors["provider_service_instance_id"] == f"local:{encoded_peer_id}:Tooling"
    assert (
        _projection_page(vectors).service_instance_id == (vectors["provider_service_instance_id"])
    )


def test_python_counts_projection_identity_bounds_as_unicode_code_points():
    accepted_peer_id = "😀" * 160
    rejected_peer_id = "😀" * 161

    accepted = ToolingGetExportCatalogResponse.model_validate(
        _empty_projection_payload(accepted_peer_id)
    )
    assert accepted.provider_peer_id == accepted_peer_id
    assert accepted.service_instance_id == f"remote:{accepted_peer_id}:Tooling"

    with pytest.raises(ValidationError):
        ToolingGetExportCatalogResponse.model_validate(_empty_projection_payload(rejected_peer_id))


def test_python_rejects_invalid_unicode_surrogate_before_percent_encoding():
    with pytest.raises(ValidationError):
        ToolingGetExportCatalogResponse.model_validate(_empty_projection_payload("\ud800"))


def test_canonical_method_ids_match_python_tooling_contract(vectors: dict):
    assert vectors["method_ids"] == {
        "get_tools": ToolingMethods.GET_TOOLS,
        "get_export_catalog": ToolingMethods.GET_EXPORT_CATALOG,
        "prepare_execution": ToolingMethods.PREPARE_EXECUTION,
        "execute_tool": ToolingMethods.EXECUTE_TOOL,
    }


def test_python_recomputes_canonical_global_ids_and_schema_hashes(vectors: dict):
    for entry in vectors["positive"]:
        tool = ToolingToolInfo.model_validate(entry["tool"])
        assert tool.global_tool_id == _canonical_id(
            vectors["stable_peer_id"],
            entry["tool_contract_id"],
        )
        assert tool.global_tool_id == entry["global_tool_id"]
        assert (
            quote(entry["tool_contract_id"], safe="-._~")
            == entry["percent_encoded_tool_contract_id"]
        )
        assert compute_tool_schema_hash(tool) == entry["schema_hash"]

        if "reordered_tool" in entry:
            reordered = ToolingToolInfo.model_validate(entry["reordered_tool"])
            assert compute_tool_schema_hash(reordered) == entry["schema_hash"]
            assert entry["reordered_schema_hash"] == entry["schema_hash"]


def test_python_recomputes_projection_checksum_and_page_hash(vectors: dict):
    page = _projection_page(vectors)
    expected_checksum = vectors["projection"]["final_checksum"]
    expected_page_hash = vectors["projection"]["page_hash"]

    assert (
        compute_projection_checksum(
            page.tools,
            page.retirements,
            page.blocked_tools,
        )
        == expected_checksum
    )
    page_without_hash = page.model_copy(update={"page_hash": "0" * 64})
    assert compute_projection_page_hash(page_without_hash) == expected_page_hash


@pytest.mark.parametrize(
    "negative_case",
    [case["case"] for case in json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["negative"]],
)
def test_python_rejects_negative_projection_vectors(vectors: dict, negative_case: str):
    base = _projection_page(vectors).model_dump(mode="json")
    case = next(item for item in vectors["negative"] if item["case"] == negative_case)
    payload = copy.deepcopy(base)
    _apply_fixture_patch(payload, case["patch"])

    with pytest.raises(ValidationError):
        ToolingGetExportCatalogResponse.model_validate(payload)


def test_fixture_has_no_current_dependency_gaps(vectors: dict):
    assert "current_dependency_gaps" not in vectors

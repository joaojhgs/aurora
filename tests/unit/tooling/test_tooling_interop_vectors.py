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
            ToolingProjectionRetirement.model_validate(item)
            for item in projection["retirements"]
        ],
        complete=True,
        total_count=len(tools),
        final_checksum=projection["final_checksum"],
    )


def test_accepts_local_percent_encoded_tooling_service_instance(vectors: dict):
    encoded_peer_id = quote(vectors["stable_peer_id"], safe="-._~")

    assert encoded_peer_id == vectors["percent_encoded_stable_peer_id"]
    assert (
        vectors["provider_service_instance_id"]
        == f"local:{encoded_peer_id}:Tooling"
    )
    assert _projection_page(vectors).service_instance_id == (
        vectors["provider_service_instance_id"]
    )


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

    assert compute_projection_checksum(
        page.tools,
        page.retirements,
        page.blocked_tools,
    ) == expected_checksum
    page_without_hash = page.model_copy(update={"page_hash": "0" * 64})
    assert compute_projection_page_hash(page_without_hash) == expected_page_hash


@pytest.mark.parametrize("negative_case", [case["case"] for case in json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["negative"]])
def test_python_rejects_negative_projection_vectors(vectors: dict, negative_case: str):
    base = _projection_page(vectors).model_dump(mode="json")
    case = next(item for item in vectors["negative"] if item["case"] == negative_case)
    payload = copy.deepcopy(base)
    for key, value in case["patch"].items():
        if value is None:
            payload.pop(key, None)
        else:
            payload[key] = value

    with pytest.raises(ValidationError):
        ToolingGetExportCatalogResponse.model_validate(payload)


def test_fixture_records_current_generation_dependencies(vectors: dict):
    assert vectors["current_dependency_gaps"] == [
        "Python ToolingToolInfo currently accepts non-aurora global_tool_id strings and provider_service_instance_id values without enforcing the local:<percent-encoded-peer>:Tooling pattern; stricter negative identity validation depends on the future generated contract/parser lane.",
        "The current SDK projection-page parser accepts oversized service_instance_id values that Python rejects at max_length=256; full parity depends on the generated boundary parser lane.",
    ]

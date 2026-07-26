"""Immutable Tooling identity primitive tests."""

import pytest

from app.services.tooling.identity import (
    ToolIdentityError,
    canonical_tool_global_id,
    core_tool_identity,
    normalize_legacy_aliases,
    parse_canonical_tool_global_id,
    source_tool_identity,
)


def test_canonical_formula_round_trips_escaped_components_without_instance_identity():
    canonical = canonical_tool_global_id("peer:stable/one", "plugin:mail/send message")
    assert canonical == (
        "aurora-tool:v1:peer%3Astable%2Fone:Tooling:plugin%3Amail%2Fsend%20message"
    )
    assert parse_canonical_tool_global_id(canonical) == (
        "peer:stable/one",
        "plugin:mail/send message",
    )
    assert "service_instance" not in canonical


@pytest.mark.parametrize(
    "value",
    [
        "legacy:peer:instance:tool:name",
        "aurora-tool:v2:peer:Tooling:tool",
        "aurora-tool:v1:peer:Other:tool",
        "aurora-tool:v1:peer:Tooling:not canonical",
        "aurora-tool:v1::Tooling:tool",
    ],
)
def test_parser_rejects_malformed_or_noncanonical_ids(value: str):
    with pytest.raises(ToolIdentityError):
        parse_canonical_tool_global_id(value)


def test_peer_and_contract_components_are_authority_bearing():
    baseline = canonical_tool_global_id("peer-a", "core.scheduler.list")
    assert baseline == canonical_tool_global_id("peer-a", "core.scheduler.list")
    assert baseline != canonical_tool_global_id("peer-b", "core.scheduler.list")
    assert baseline != canonical_tool_global_id("peer-a", "core.scheduler.cancel")


def test_aliases_are_bounded_unique_sorted_and_exclude_canonical():
    canonical = canonical_tool_global_id("peer-a", "core.scheduler.list")
    assert normalize_legacy_aliases(["z", canonical, "a", "z"], canonical_id=canonical) == (
        "a",
        "z",
    )
    with pytest.raises(ToolIdentityError):
        normalize_legacy_aliases([f"alias-{index}" for index in range(17)])


def test_core_registry_is_explicit_and_remote_stamps_are_never_exportable():
    scheduler = core_tool_identity("list_scheduled_tasks_tool")
    assert scheduler.tool_contract_id == "core.scheduler.list"
    assert scheduler.share_group_id == "core:scheduler"
    with pytest.raises(ToolIdentityError, match="lacks an explicit identity"):
        core_tool_identity("new_unregistered_core_tool")

    remote = source_tool_identity(
        source_kind="mesh_peer",
        stable_source_id="peer-a",
        provider_tool_id="status",
        share_group_id="peer:tools",
        share_group_label="Peer tools",
        exportable=True,
    )
    assert remote.exportable is False


def test_source_contract_tuple_boundaries_cannot_collide():
    nested_source = source_tool_identity(
        source_kind="mcp",
        stable_source_id="mail.primary",
        provider_tool_id="search",
        share_group_id="mcp:mail-primary",
        share_group_label="Mail primary",
    )
    nested_provider = source_tool_identity(
        source_kind="mcp",
        stable_source_id="mail",
        provider_tool_id="primary.search",
        share_group_id="mcp:mail",
        share_group_label="Mail",
    )

    assert nested_source.tool_contract_id == "mcp:mail.primary:search"
    assert nested_provider.tool_contract_id == "mcp:mail:primary.search"
    assert nested_source.tool_contract_id != nested_provider.tool_contract_id

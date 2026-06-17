"""Unit tests for orchestrator Tooling binding metadata."""

from app.services.orchestrator.tool_bindings import build_tool_bindings


def test_build_tool_bindings_keeps_local_and_safe_remote_tools():
    """Local and standard remote tools bind into one planning context."""

    tools, bindings = build_tool_bindings(
        [
            {
                "name": "weather",
                "local_name": "weather",
                "description": "Get weather.",
                "args_schema": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
                "execution_location": "local",
                "source_type": "local",
            },
            {
                "name": "raspi-lab_switch_on",
                "local_name": "switch_on",
                "global_tool_id": "raspi-lab:remote_raspi-lab_Tooling:tool:switch_on",
                "provider_peer_id": "raspi-lab",
                "provider_service_instance_id": "remote:raspi-lab:Tooling",
                "display_name": "raspi-lab.switch_on",
                "description": "Switch on a target.",
                "args_schema": {
                    "type": "object",
                    "properties": {"target": {"type": "string"}},
                    "required": ["target"],
                },
                "execution_location": "remote",
                "source_type": "mesh_peer",
                "safety_class": "standard",
                "confirmation_required": False,
            },
        ]
    )

    assert [tool.name for tool in tools] == ["weather", "raspi-lab_switch_on"]
    assert bindings["weather"]["tool_name"] == "weather"
    remote_binding = bindings["raspi-lab_switch_on"]
    assert remote_binding["tool_name"] == "raspi-lab:remote_raspi-lab_Tooling:tool:switch_on"
    assert remote_binding["mesh_selector"]["peer_id"] == "raspi-lab"
    assert remote_binding["mesh_selector"]["service_instance_id"] == "remote:raspi-lab:Tooling"
    assert remote_binding["mesh_selector"]["tool_id"] == remote_binding["global_tool_id"]


def test_build_tool_bindings_hides_remote_confirmation_required_tools():
    """High-risk remote tools are not advertised for automatic model selection."""

    tools, bindings = build_tool_bindings(
        [
            {
                "name": "raspi-lab_unlock_door",
                "local_name": "unlock_door",
                "global_tool_id": "raspi-lab:remote_raspi-lab_Tooling:tool:unlock_door",
                "provider_peer_id": "raspi-lab",
                "provider_service_instance_id": "remote:raspi-lab:Tooling",
                "description": "Unlock a door.",
                "args_schema": {"type": "object", "properties": {}},
                "execution_location": "remote",
                "source_type": "mesh_peer",
                "safety_class": "dangerous",
                "confirmation_required": True,
            }
        ]
    )

    assert tools == []
    assert bindings == {}


def test_build_tool_bindings_resolves_duplicate_names_deterministically():
    """Unexpected duplicate bind names are suffixed while preserving provider IDs."""

    tools, bindings = build_tool_bindings(
        [
            {
                "name": "remote_status",
                "local_name": "status",
                "global_tool_id": "peer-a:service:tool:status",
                "provider_peer_id": "peer-a",
                "provider_service_instance_id": "service-a",
                "description": "Status A.",
                "args_schema": {"type": "object", "properties": {}},
                "execution_location": "remote",
                "source_type": "mesh_peer",
                "safety_class": "standard",
            },
            {
                "name": "remote_status",
                "local_name": "status",
                "global_tool_id": "peer-b:service:tool:status",
                "provider_peer_id": "peer-b",
                "provider_service_instance_id": "service-b",
                "description": "Status B.",
                "args_schema": {"type": "object", "properties": {}},
                "execution_location": "remote",
                "source_type": "mesh_peer",
                "safety_class": "standard",
            },
        ]
    )

    assert [tool.name for tool in tools] == ["remote_status", "remote_status_2"]
    assert bindings["remote_status"]["tool_name"] == "peer-a:service:tool:status"
    assert bindings["remote_status_2"]["tool_name"] == "peer-b:service:tool:status"

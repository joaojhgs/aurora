"""Unit tests for orchestrator Tooling binding metadata."""

from app.services.orchestrator.tool_bindings import (
    build_tool_approval_candidates,
    build_tool_bindings,
)


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


def test_build_tool_bindings_exposes_remote_confirmation_required_tools_for_approval():
    """High-risk remote tools stay model-visible so runtime approval can interrupt."""

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

    assert [tool.name for tool in tools] == ["raspi-lab_unlock_door"]
    binding = bindings["raspi-lab_unlock_door"]
    assert binding["tool_name"] == "raspi-lab:remote_raspi-lab_Tooling:tool:unlock_door"
    assert binding["mesh_selector"]["peer_id"] == "raspi-lab"
    assert binding["safety_class"] == "dangerous"
    assert binding["confirmation_required"] is True


def test_build_tool_bindings_exposes_local_confirmation_required_tools_for_approval():
    """High-risk local tools stay model-visible so Tooling policy can gate execution."""

    tools, bindings = build_tool_bindings(
        [
            {
                "name": "delete_file",
                "local_name": "delete_file",
                "global_tool_id": "local:Tooling:tool:delete_file",
                "provider_peer_id": "local",
                "provider_service_instance_id": "local:Tooling",
                "description": "Delete a file.",
                "args_schema": {"type": "object", "properties": {}},
                "execution_location": "local",
                "source_type": "local",
                "safety_class": "dangerous",
                "confirmation_required": True,
            }
        ]
    )

    assert [tool.name for tool in tools] == ["delete_file"]
    binding = bindings["delete_file"]
    assert binding["tool_name"] == "delete_file"
    assert binding["global_tool_id"] == "local:Tooling:tool:delete_file"
    assert binding["safety_class"] == "dangerous"
    assert binding["confirmation_required"] is True


def test_build_tool_bindings_hides_explicitly_blocked_tools():
    """Explicitly blocked tools are the only policy category hidden from the model."""

    tools, bindings = build_tool_bindings(
        [
            {
                "name": "blocked_shell",
                "local_name": "shell",
                "description": "Run shell commands.",
                "args_schema": {"type": "object", "properties": {}},
                "trust_tier": "blocked",
            },
            {
                "name": "hidden_admin",
                "local_name": "hidden_admin",
                "description": "Hidden by policy.",
                "args_schema": {"type": "object", "properties": {}},
                "blocked": True,
            },
        ]
    )

    assert tools == []
    assert bindings == {}



def test_build_tool_bindings_keeps_malformed_non_blocked_tools_visible():
    """Malformed schema metadata must not hide a non-blocked tool from the LLM."""

    tools, bindings = build_tool_bindings(
        [
            {
                "name": "legacy_tool",
                "description": "Legacy plugin with malformed JSON schema metadata.",
                "args_schema": {"type": "object", "properties": {None: {"type": "string"}}},
                "trust_tier": "untrusted",
            }
        ]
    )

    assert [tool.name for tool in tools] == ["legacy_tool"]
    assert bindings["legacy_tool"]["tool_name"] == "legacy_tool"
    assert bindings["legacy_tool"]["args_schema"] == {"type": "object", "properties": {}}
    assert bindings["legacy_tool"]["schema_warning"]

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


def test_build_tool_approval_candidates_preserves_provider_metadata():
    """Blocked unsafe tools become UI/session approval candidates."""

    candidates = build_tool_approval_candidates(
        [
            {
                "reason_code": "confirmation_required",
                "reason": "tool requires approval before it can be model-bound",
                "tool": {
                    "name": "raspi-lab_unlock_door",
                    "local_name": "unlock_door",
                    "global_tool_id": "raspi-lab:service:tool:unlock_door",
                    "provider_peer_id": "raspi-lab",
                    "provider_service_instance_id": "remote:raspi-lab:Tooling",
                    "display_name": "raspi-lab.unlock_door",
                    "description": "Unlock a door.",
                    "args_schema": {
                        "type": "object",
                        "properties": {"door": {"type": "string"}},
                    },
                    "execution_location": "remote",
                    "source_type": "mesh_peer",
                    "safety_class": "dangerous",
                    "confirmation_required": True,
                    "required_permissions": ["Tooling.ExecuteTool"],
                },
            }
        ]
    )

    candidate = candidates["raspi-lab_unlock_door"]
    assert candidate["approval_required"] is True
    assert candidate["tool_name"] == "raspi-lab:service:tool:unlock_door"
    assert candidate["mesh_selector"]["peer_id"] == "raspi-lab"
    assert candidate["mesh_selector"]["service_instance_id"] == "remote:raspi-lab:Tooling"
    assert candidate["global_tool_id"] == "raspi-lab:service:tool:unlock_door"
    assert candidate["reason_code"] == "confirmation_required"

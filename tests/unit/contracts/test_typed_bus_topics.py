from pathlib import Path

from scripts.check_typed_bus_topics import DEFAULT_ROOTS, collect_violations


def test_production_bus_topics_use_typed_constants() -> None:
    assert collect_violations(DEFAULT_ROOTS) == []


def test_literal_topic_audit_reports_bus_and_contract_literals(tmp_path: Path) -> None:
    source = tmp_path / "literal_topic_sample.py"
    source.write_text(
        """
from app.shared.contracts.registry import method_contract

@method_contract(method_id="Auth.Login")
async def handler(data):
    await bus.request("TTS.Request", data)
    MethodInfo(bus_topic="Gateway.GetRegistry")
""",
        encoding="utf-8",
    )

    violations = collect_violations([source])

    assert [(item.context, item.value) for item in violations] == [
        ("method_id keyword", "Auth.Login"),
        ("request positional topic", "TTS.Request"),
        ("bus_topic keyword", "Gateway.GetRegistry"),
    ]

from __future__ import annotations

import ast
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
BRIDGE_PATH = REPO_ROOT / "app" / "ui" / "bridge_service.py"
CONTRACT_PATH = REPO_ROOT / "docs" / "UI_INTEGRATION.md"

EXPECTED_QT_SIGNALS = {
    "message_received",
    "transcription_received",
    "tts_started",
    "tts_stopped",
    "status_changed",
}

EXPECTED_SUBSCRIBED_TOPICS = {
    "STTMethods.USER_SPEECH_CAPTURED",
    "STTMethods.SESSION_STARTED",
    "OrchestratorMethods.RESPONSE",
    "TTSMethods.STARTED",
    "TTSMethods.STOPPED",
}

EXPECTED_PUBLISHED_TOPICS = {
    "OrchestratorMethods.USER_INPUT",
    "TTSMethods.STOP",
}

EXPECTED_REQUESTED_TOPICS = {
    "DBMethods.GET_MESSAGES_FOR_DATE",
}

EXPECTED_UI_CALLBACKS = {
    "ui_window.user_message_signal",
    "ui_window._stop_tts_callback",
}


def _attr_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Attribute):
        parent = _attr_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    if isinstance(node, ast.Name):
        return node.id
    return None


def _call_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Call):
        return _attr_name(node.func)
    return None


def _parse_bridge() -> ast.Module:
    return ast.parse(BRIDGE_PATH.read_text())


def test_uibridge_qt_signal_inventory_is_checked() -> None:
    tree = _parse_bridge()
    ui_bridge = next(
        node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "UIBridge"
    )

    signals = {
        stmt.targets[0].id
        for stmt in ui_bridge.body
        if isinstance(stmt, ast.Assign)
        and len(stmt.targets) == 1
        and isinstance(stmt.targets[0], ast.Name)
        and _call_name(stmt.value) == "pyqtSignal"
    }

    assert signals == EXPECTED_QT_SIGNALS


def test_uibridge_bus_topic_inventory_is_checked() -> None:
    tree = _parse_bridge()
    subscribed: set[str] = set()
    published: set[str] = set()
    requested: set[str] = set()

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue

        call_name = _attr_name(node.func)
        if not node.args:
            continue

        topic = _attr_name(node.args[0])
        if topic is None:
            continue

        if call_name == "self.bus.subscribe":
            subscribed.add(topic)
        elif call_name == "self.bus.publish":
            published.add(topic)
        elif call_name == "self.bus.request":
            requested.add(topic)

    assert subscribed == EXPECTED_SUBSCRIBED_TOPICS
    assert published == EXPECTED_PUBLISHED_TOPICS
    assert requested == EXPECTED_REQUESTED_TOPICS


def test_uibridge_ui_callback_inventory_is_checked() -> None:
    tree = _parse_bridge()
    callbacks: set[str] = set()

    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and _attr_name(node.func) == "self.ui_window.user_message_signal.connect"
        ):
            callbacks.add("ui_window.user_message_signal")
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if _attr_name(target) == "self.ui_window._stop_tts_callback":
                    callbacks.add("ui_window._stop_tts_callback")

    assert callbacks == EXPECTED_UI_CALLBACKS


def test_migration_contract_mentions_every_checked_legacy_surface() -> None:
    contract = CONTRACT_PATH.read_text()
    required_tokens = (
        EXPECTED_QT_SIGNALS
        | EXPECTED_SUBSCRIBED_TOPICS
        | EXPECTED_PUBLISHED_TOPICS
        | EXPECTED_REQUESTED_TOPICS
        | EXPECTED_UI_CALLBACKS
    )

    missing = sorted(token for token in required_tokens if token not in contract)

    assert missing == []

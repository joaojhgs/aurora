"""Regression tests for the top-level Aurora entrypoint.

The tests use local fakes so they do not launch real services or a Qt UI.
"""

from __future__ import annotations

import asyncio
import importlib
import sys
import types
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock

import pytest


@pytest.fixture
def main_entrypoint(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> ModuleType:
    """Import main only after config and env paths are isolated."""
    config_path = tmp_path / "config.json"
    env_path = tmp_path / ".env"
    env_path.write_text("", encoding="utf-8")

    monkeypatch.setenv("AURORA_CONFIG_FILE", str(config_path))
    monkeypatch.setenv("AURORA_ENV_FILE", str(env_path))

    from app.services.config.config_manager import ConfigManager

    monkeypatch.setattr(ConfigManager, "_instance", None)

    previous_main = sys.modules.pop("main", None)
    try:
        yield importlib.import_module("main")
    finally:
        sys.modules.pop("main", None)
        if previous_main is not None:
            sys.modules["main"] = previous_main


@pytest.mark.asyncio
async def test_cli_subscribes_to_config_changes_before_run(
    monkeypatch: pytest.MonkeyPatch,
    main_entrypoint: ModuleType,
) -> None:
    events: list[str] = []

    class FakeSupervisor:
        def __init__(self) -> None:
            self.bus = SimpleNamespace(publish=AsyncMock())

        async def initialize(self) -> None:
            events.append("initialize")

        async def _subscribe_registered_contracts(self) -> None:
            events.append("subscribe_contracts")

        async def start_services(self) -> None:
            events.append("start_services")

        async def _subscribe_to_config_changes(self) -> None:
            events.append("subscribe_config_start")
            await asyncio.sleep(0)
            events.append("subscribe_config_done")

        async def run(self) -> None:
            events.append("run")

        async def shutdown(self) -> None:
            events.append("shutdown")

    monkeypatch.setattr(main_entrypoint, "Supervisor", FakeSupervisor)
    monkeypatch.setattr(main_entrypoint, "get_contract", lambda _method: None)
    monkeypatch.setattr(
        main_entrypoint,
        "config_api",
        SimpleNamespace(aget=AsyncMock(return_value=False)),
    )

    await main_entrypoint.main_async()

    assert events == [
        "initialize",
        "subscribe_contracts",
        "start_services",
        "subscribe_config_start",
        "subscribe_config_done",
        "run",
        "shutdown",
    ]


def test_ui_thread_subscribes_to_config_changes_before_ready(
    monkeypatch: pytest.MonkeyPatch,
    main_entrypoint: ModuleType,
) -> None:
    events: list[str] = []

    class FakeBus:
        async def publish(self, *_args: object, **_kwargs: object) -> None:
            events.append("greeting")

    class FakeSupervisor:
        def __init__(self) -> None:
            self.bus = FakeBus()
            self.shutdown_event = asyncio.Event()

        async def initialize(self) -> None:
            events.append("initialize")

        async def start_services(self) -> None:
            events.append("start_services")

        async def _subscribe_to_config_changes(self) -> None:
            events.append("subscribe_config_start")
            await asyncio.sleep(0)
            events.append("subscribe_config_done")

        async def run(self) -> None:
            events.append("run")
            await self.shutdown_event.wait()
            events.append("run_stopped")

        async def shutdown(self) -> None:
            events.append("shutdown")

    class FakeQApplication:
        def __init__(self, _argv: list[str]) -> None:
            events.append("qt_app")

        def exec(self) -> int:
            events.append("qt_exec")
            return 0

    class FakeAuroraUI:
        def __init__(self) -> None:
            events.append("window")

        def show(self) -> None:
            events.append("show")

    class FakeUIBridge:
        def __init__(self, _bus: FakeBus, _window: FakeAuroraUI) -> None:
            events.append("bridge_init")

        async def start(self) -> None:
            events.append("bridge_start")

    pyqt_module = types.ModuleType("PyQt6")
    qt_widgets_module = types.ModuleType("PyQt6.QtWidgets")
    qt_widgets_module.QApplication = FakeQApplication
    pyqt_module.QtWidgets = qt_widgets_module

    modules_module = types.ModuleType("modules")
    ui_module = types.ModuleType("modules.ui")
    aurora_ui_module = types.ModuleType("modules.ui.aurora_ui")
    aurora_ui_module.AuroraUI = FakeAuroraUI
    modules_module.ui = ui_module
    ui_module.aurora_ui = aurora_ui_module

    bridge_module = types.ModuleType("app.ui.bridge_service")
    bridge_module.UIBridge = FakeUIBridge

    monkeypatch.setitem(sys.modules, "PyQt6", pyqt_module)
    monkeypatch.setitem(sys.modules, "PyQt6.QtWidgets", qt_widgets_module)
    monkeypatch.setitem(sys.modules, "modules", modules_module)
    monkeypatch.setitem(sys.modules, "modules.ui", ui_module)
    monkeypatch.setitem(sys.modules, "modules.ui.aurora_ui", aurora_ui_module)
    monkeypatch.setitem(sys.modules, "app.ui.bridge_service", bridge_module)
    monkeypatch.setattr(main_entrypoint, "Supervisor", FakeSupervisor)
    monkeypatch.setattr(main_entrypoint, "get_contract", lambda _method: None)

    with pytest.raises(SystemExit) as exc_info:
        main_entrypoint.main_with_ui()

    assert exc_info.value.code == 0
    assert events.index("subscribe_config_start") < events.index("subscribe_config_done")
    assert events.index("subscribe_config_done") < events.index("qt_app")
    assert events.index("subscribe_config_done") < events.index("run")
    assert "greeting" not in events


def test_ui_skips_startup_greeting_when_tts_is_unregistered(
    monkeypatch: pytest.MonkeyPatch,
    main_entrypoint: ModuleType,
) -> None:
    events: list[str] = []

    class FakeBus:
        async def publish(self, *_args: object, **_kwargs: object) -> None:
            events.append("greeting")

    class FakeSupervisor:
        def __init__(self) -> None:
            self.bus = FakeBus()
            self.shutdown_event = asyncio.Event()

        async def initialize(self) -> None:
            events.append("initialize")

        async def start_services(self) -> None:
            events.append("start_services")

        async def _subscribe_to_config_changes(self) -> None:
            events.append("subscribe_config")

        async def run(self) -> None:
            events.append("run")
            await self.shutdown_event.wait()

        async def shutdown(self) -> None:
            events.append("shutdown")

    class FakeQApplication:
        def __init__(self, _argv: list[str]) -> None:
            events.append("qt_app")

        def exec(self) -> int:
            events.append("qt_exec")
            return 0

    class FakeAuroraUI:
        def __init__(self) -> None:
            events.append("window")

        def show(self) -> None:
            events.append("show")

    class FakeUIBridge:
        def __init__(self, _bus: FakeBus, _window: FakeAuroraUI) -> None:
            events.append("bridge_init")

        async def start(self) -> None:
            events.append("bridge_start")

    pyqt_module = types.ModuleType("PyQt6")
    qt_widgets_module = types.ModuleType("PyQt6.QtWidgets")
    qt_widgets_module.QApplication = FakeQApplication
    pyqt_module.QtWidgets = qt_widgets_module

    modules_module = types.ModuleType("modules")
    ui_module = types.ModuleType("modules.ui")
    aurora_ui_module = types.ModuleType("modules.ui.aurora_ui")
    aurora_ui_module.AuroraUI = FakeAuroraUI
    modules_module.ui = ui_module
    ui_module.aurora_ui = aurora_ui_module

    bridge_module = types.ModuleType("app.ui.bridge_service")
    bridge_module.UIBridge = FakeUIBridge

    monkeypatch.setitem(sys.modules, "PyQt6", pyqt_module)
    monkeypatch.setitem(sys.modules, "PyQt6.QtWidgets", qt_widgets_module)
    monkeypatch.setitem(sys.modules, "modules", modules_module)
    monkeypatch.setitem(sys.modules, "modules.ui", ui_module)
    monkeypatch.setitem(sys.modules, "modules.ui.aurora_ui", aurora_ui_module)
    monkeypatch.setitem(sys.modules, "app.ui.bridge_service", bridge_module)
    monkeypatch.setattr(main_entrypoint, "Supervisor", FakeSupervisor)
    monkeypatch.setattr(main_entrypoint, "get_contract", lambda _method: None)

    with pytest.raises(SystemExit) as exc_info:
        main_entrypoint.main_with_ui()

    assert exc_info.value.code == 0
    assert "greeting" not in events
    assert "show" in events

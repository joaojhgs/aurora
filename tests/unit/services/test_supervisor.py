"""Unit tests for SupervisorService."""

import contextlib
import sys
import types
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import MessageBus
from app.services.supervisor import Supervisor

# Sentinel for "attribute was absent before injection" (restored on exit).
_ATTR_SENTINEL = object()

# (short_name, module_path, attribute) for every class ``_start_services_threads`` imports.
# Injected via ``__dict__`` so lazy packages (db/auth/tts/…) never load optional deps.
_SUPERVISOR_THREAD_SERVICES: list[tuple[str, str, str]] = [
    ("db", "app.services.db", "DBService"),
    ("auth", "app.services.auth", "AuthService"),
    ("tooling", "app.services.tooling", "ToolingService"),
    ("scheduler", "app.services.scheduler", "SchedulerService"),
    ("tts", "app.services.tts", "TTSService"),
    ("orchestrator", "app.services.orchestrator", "OrchestratorService"),
    ("config", "app.services.config", "ConfigService"),
    ("coordinator", "app.services.stt_coordinator", "STTCoordinatorService"),
    ("transcription", "app.services.stt_transcription", "TranscriptionService"),
    ("wakeword", "app.services.stt_wakeword", "WakeWordService"),
    ("gateway", "app.services.gateway", "GatewayService"),
]


@contextlib.contextmanager
def _inject_supervisor_thread_service_classes():
    """Replace service classes with ``Mock()`` callables without importing heavy service stacks.

    For subpackages not yet in ``sys.modules``, install a minimal stub module so
    ``from app.services.orchestrator import OrchestratorService`` never executes
    the real ``orchestrator/__init__.py`` (which pulls langgraph, etc.).
    """
    saved: dict[tuple[str, str], object] = {}
    created_modules: list[str] = []
    mocks: dict[str, Mock] = {}

    for _name, mod_path, attr in _SUPERVISOR_THREAD_SERVICES:
        cls_mock = Mock()
        mocks[_name] = cls_mock
        if mod_path in sys.modules:
            mod = sys.modules[mod_path]
            key = (mod_path, attr)
            saved[key] = mod.__dict__.get(attr, _ATTR_SENTINEL)
            mod.__dict__[attr] = cls_mock
        else:
            stub = types.ModuleType(mod_path)
            stub.__package__ = mod_path
            stub.__path__ = []
            stub.__dict__[attr] = cls_mock
            sys.modules[mod_path] = stub
            created_modules.append(mod_path)

    try:
        yield mocks
    finally:
        for mod_path in created_modules:
            sys.modules.pop(mod_path, None)
        for (mod_path, attr), old in saved.items():
            mod = sys.modules.get(mod_path)
            if mod is None:
                continue
            if old is _ATTR_SENTINEL:
                mod.__dict__.pop(attr, None)
            else:
                mod.__dict__[attr] = old


@pytest.fixture
def mock_bus():
    """Create a mock message bus."""
    bus = Mock(spec=MessageBus)
    bus.start = AsyncMock()
    bus.stop = AsyncMock()
    bus.subscribe = Mock()
    bus.publish = AsyncMock()
    return bus


@pytest.fixture
def supervisor():
    """Create a Supervisor instance."""
    return Supervisor()


class TestSupervisorInitialization:
    """Test supervisor initialization."""

    def test_init(self):
        """Test supervisor initialization."""
        supervisor = Supervisor()
        # Bus is lazy-loaded via property, so it may not be None after initialization
        assert supervisor.services == []
        assert supervisor._mode == "threads"

    @pytest.mark.asyncio
    async def test_initialize_local_bus(self, supervisor):
        """Test initializing LocalBus."""
        # Patch LocalBus where it's imported (in supervisor module), not where it's defined
        with patch("app.services.supervisor.LocalBus") as mock_local_bus_class:
            mock_bus = Mock()
            mock_bus.start = AsyncMock()
            mock_local_bus_class.return_value = mock_bus

            with (
                patch("app.services.supervisor.set_bus"),
                patch("app.shared.messaging.bus_init.set_bus"),
                patch.dict("os.environ", {"AURORA_ARCHITECTURE_MODE": "threads"}),
            ):
                await supervisor.initialize()

                assert supervisor._bus is not None
                mock_bus.start.assert_called_once()

    @pytest.mark.asyncio
    async def test_initialize_bullmq_bus(self, supervisor):
        """Test initializing BullMQBus."""
        with patch("app.messaging.bullmq_bus.BullMQBus") as mock_bullmq_class:
            mock_bus = Mock()
            mock_bus.start = AsyncMock()
            mock_bullmq_class.return_value = mock_bus

            with (
                patch("app.services.supervisor.set_bus"),
                patch("app.shared.messaging.bus_init.set_bus"),
                patch.dict(
                    "os.environ",
                    {
                        "AURORA_ARCHITECTURE_MODE": "processes",
                        "REDIS_URL": "redis://localhost:6379",
                    },
                ),
            ):
                await supervisor.initialize()

                assert supervisor._bus is not None
                mock_bus.start.assert_called_once()


class TestSupervisorServiceLifecycle:
    """Test supervisor service lifecycle."""

    @pytest.mark.asyncio
    async def test_start_services_foundation(self, supervisor, mock_bus):
        """Test starting foundation services."""
        # Set bus via internal attribute (bus property is read-only)
        supervisor._bus = mock_bus

        with _inject_supervisor_thread_service_classes() as svc_mocks:
            for mock_cls in svc_mocks.values():
                inst = Mock()
                inst.start = AsyncMock()
                mock_cls.return_value = inst

            await supervisor.start_services()

            # Verify at least DB and Tooling were started (foundation services)
            assert len(supervisor.services) >= 2
            svc_mocks["db"].return_value.start.assert_called_once()
            svc_mocks["tooling"].return_value.start.assert_called_once()

    @pytest.mark.asyncio
    async def test_start_services_complete(self, supervisor, mock_bus):
        """Test starting all services."""
        supervisor._bus = mock_bus

        with _inject_supervisor_thread_service_classes() as svc_mocks:
            for mock_cls in svc_mocks.values():
                inst = Mock()
                inst.start = AsyncMock()
                mock_cls.return_value = inst

            await supervisor.start_services()

            # Verify services were started
            assert len(supervisor.services) > 0

    @pytest.mark.asyncio
    async def test_shutdown(self, supervisor, mock_bus):
        """Test supervisor shutdown."""
        supervisor._bus = mock_bus
        supervisor.services = [Mock() for _ in range(3)]

        await supervisor.shutdown()

        mock_bus.stop.assert_called_once()

    @pytest.mark.asyncio
    async def test_run(self, supervisor, mock_bus):
        """Test supervisor run loop."""
        supervisor._bus = mock_bus
        supervisor.shutdown_event = Mock()
        supervisor.shutdown_event.wait = AsyncMock(side_effect=KeyboardInterrupt())

        with pytest.raises(KeyboardInterrupt):
            await supervisor.run()


class TestSupervisorErrorHandling:
    """Test supervisor error handling."""

    @pytest.mark.asyncio
    async def test_initialize_with_invalid_mode(self, supervisor):
        """Test initialization with invalid mode."""
        # Mode is read from environment variable, not config_api
        with (
            patch.dict("os.environ", {"AURORA_ARCHITECTURE_MODE": "invalid_mode"}),
            pytest.raises(ValueError, match="Unknown architecture mode"),
        ):
            await supervisor.initialize()

    @pytest.mark.asyncio
    async def test_start_services_failure(self, supervisor, mock_bus):
        """Test service startup failure."""
        supervisor._bus = mock_bus

        with _inject_supervisor_thread_service_classes() as svc_mocks:
            # Config succeeds first
            cfg = Mock()
            cfg.start = AsyncMock()
            svc_mocks["config"].return_value = cfg

            # DB fails on start
            db_inst = Mock()
            db_inst.start = AsyncMock(side_effect=Exception("Service failure"))
            svc_mocks["db"].return_value = db_inst

            for name, mock_cls in svc_mocks.items():
                if name in ("config", "db"):
                    continue
                inst = Mock()
                inst.start = AsyncMock()
                mock_cls.return_value = inst

            with pytest.raises(Exception, match="Service failure"):
                await supervisor.start_services()

"""Unit tests for SupervisorService."""

from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import MessageBus
from app.services.supervisor import Supervisor


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
                patch.dict("os.environ", {"AURORA_ARCHITECTURE_MODE": "processes", "REDIS_URL": "redis://localhost:6379"}),
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

        # Services are imported inside _start_services_threads, so patch at those paths
        with (
            patch("app.services.db.DBService") as mock_db_service,
            patch("app.services.auth.AuthService") as mock_auth_service,
            patch("app.services.tooling.ToolingService") as mock_tooling_service,
            patch("app.services.scheduler.SchedulerService") as mock_scheduler_service,
            patch("app.services.tts.TTSService") as mock_tts_service,
            patch("app.services.orchestrator.OrchestratorService") as mock_orchestrator_service,
            patch("app.services.config.ConfigService") as mock_config_service,
            patch("app.services.stt_coordinator.STTCoordinatorService") as mock_coordinator,
            patch("app.services.stt_transcription.TranscriptionService") as mock_transcription,
            patch("app.services.stt_wakeword.WakeWordService") as mock_wakeword,
            patch("app.services.gateway.GatewayService") as mock_gateway_service,
        ):
            # Configure all mocks
            for mock_service in [mock_db_service, mock_auth_service, mock_tooling_service,
                                 mock_scheduler_service,
                                 mock_tts_service, mock_orchestrator_service, mock_config_service,
                                 mock_coordinator, mock_transcription, mock_wakeword,
                                 mock_gateway_service]:
                mock_instance = Mock()
                mock_instance.start = AsyncMock()
                mock_service.return_value = mock_instance

            await supervisor.start_services()

            # Verify at least DB and Tooling were started (foundation services)
            assert len(supervisor.services) >= 2
            mock_db_service.return_value.start.assert_called_once()
            mock_tooling_service.return_value.start.assert_called_once()

    @pytest.mark.asyncio
    async def test_start_services_complete(self, supervisor, mock_bus):
        """Test starting all services."""
        supervisor._bus = mock_bus

        # Mock all services at the import paths used by supervisor
        with (
            patch("app.services.db.DBService") as mock_db,
            patch("app.services.auth.AuthService") as mock_auth,
            patch("app.services.tooling.ToolingService") as mock_tooling,
            patch("app.services.scheduler.SchedulerService") as mock_scheduler,
            patch("app.services.tts.TTSService") as mock_tts,
            patch("app.services.orchestrator.OrchestratorService") as mock_orchestrator,
            patch("app.services.config.ConfigService") as mock_config,
            patch("app.services.stt_wakeword.WakeWordService") as mock_wakeword,
            patch("app.services.stt_transcription.TranscriptionService") as mock_transcription,
            patch("app.services.stt_coordinator.STTCoordinatorService") as mock_coordinator,
            patch("app.services.gateway.GatewayService") as mock_gateway,
        ):
            # Configure all mocks
            for mock_service in [mock_db, mock_auth, mock_tooling, mock_scheduler, mock_tts,
                                 mock_orchestrator, mock_config, mock_wakeword,
                                 mock_transcription, mock_coordinator, mock_gateway]:
                mock_instance = Mock()
                mock_instance.start = AsyncMock()
                mock_service.return_value = mock_instance

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

        # Services are imported inside _start_services_threads, so patch at those paths
        with (
            patch("app.services.db.DBService") as mock_db_service,
            patch("app.services.auth.AuthService") as mock_auth_service,
            patch("app.services.tooling.ToolingService") as mock_tooling_service,
            patch("app.services.scheduler.SchedulerService") as mock_scheduler_service,
            patch("app.services.tts.TTSService") as mock_tts_service,
            patch("app.services.orchestrator.OrchestratorService") as mock_orchestrator_service,
            patch("app.services.config.ConfigService") as mock_config_service,
            patch("app.services.stt_coordinator.STTCoordinatorService") as mock_coordinator,
            patch("app.services.stt_transcription.TranscriptionService") as mock_transcription,
            patch("app.services.stt_wakeword.WakeWordService") as mock_wakeword,
            patch("app.services.gateway.GatewayService") as mock_gateway_service,
        ):
            # Configure config service to succeed (it starts first)
            mock_config_instance = Mock()
            mock_config_instance.start = AsyncMock()
            mock_config_service.return_value = mock_config_instance

            # Configure DB service to fail
            mock_db = Mock()
            mock_db.start = AsyncMock(side_effect=Exception("Service failure"))
            mock_db_service.return_value = mock_db

            # Configure other services normally
            for mock_service in [mock_auth_service, mock_tooling_service, mock_scheduler_service,
                                 mock_tts_service,
                                 mock_orchestrator_service, mock_coordinator,
                                 mock_transcription, mock_wakeword, mock_gateway_service]:
                mock_instance = Mock()
                mock_instance.start = AsyncMock()
                mock_service.return_value = mock_instance

            with pytest.raises(Exception, match="Service failure"):
                await supervisor.start_services()

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
        assert supervisor.bus is None
        assert supervisor.services == []
        assert supervisor._mode == "threads"

    @pytest.mark.asyncio
    async def test_initialize_local_bus(self, supervisor):
        """Test initializing LocalBus."""
        with patch("app.services.supervisor.LocalBus") as mock_local_bus_class:
            mock_bus = Mock()
            mock_bus.start = AsyncMock()
            mock_local_bus_class.return_value = mock_bus

            with (
                patch("app.services.supervisor.register_all_service_topics"),
                patch("app.services.supervisor.set_bus"),
                patch("app.services.supervisor.config_manager") as mock_config,
            ):
                mock_config.get.return_value = "threads"

                await supervisor.initialize()

                assert supervisor.bus is not None
                mock_bus.start.assert_called_once()

    @pytest.mark.asyncio
    async def test_initialize_bullmq_bus(self, supervisor):
        """Test initializing BullMQBus."""
        with patch("app.messaging.bullmq_bus.BullMQBus") as mock_bullmq_class:
            mock_bus = Mock()
            mock_bus.start = AsyncMock()
            mock_bullmq_class.return_value = mock_bus

            with (
                patch("app.services.supervisor.register_all_service_topics"),
                patch("app.services.supervisor.set_bus"),
                patch("app.services.supervisor.config_manager") as mock_config,
            ):
                mock_config.get.return_value = "processes"
                mock_config.get.side_effect = (
                    lambda key, default=None: "redis://localhost:6379"
                    if "redis" in key
                    else "processes"
                )

                await supervisor.initialize()

                assert supervisor.bus is not None
                mock_bus.start.assert_called_once()


class TestSupervisorServiceLifecycle:
    """Test supervisor service lifecycle."""

    @pytest.mark.asyncio
    async def test_start_services_foundation(self, supervisor, mock_bus):
        """Test starting foundation services."""
        supervisor.bus = mock_bus

        with (
            patch("app.db.DBService") as mock_db_service,
            patch("app.tooling.ToolingService") as mock_tooling_service,
        ):
            mock_db = Mock()
            mock_db.start = AsyncMock()
            mock_tooling = Mock()
            mock_tooling.start = AsyncMock()

            mock_db_service.return_value = mock_db
            mock_tooling_service.return_value = mock_tooling

            await supervisor.start_services()

            assert len(supervisor.services) >= 2
            mock_db.start.assert_called_once()
            mock_tooling.start.assert_called_once()

    @pytest.mark.asyncio
    async def test_start_services_complete(self, supervisor, mock_bus):
        """Test starting all services."""
        supervisor.bus = mock_bus

        # Mock all services
        services_to_mock = [
            "app.db.DBService",
            "app.tooling.ToolingService",
            "app.scheduler.SchedulerService",
            "app.tts.TTSService",
            "app.orchestrator.OrchestratorService",
            "app.stt_audio_input.AudioInputService",
            "app.stt_wakeword.WakeWordService",
            "app.stt_transcription.TranscriptionService",
            "app.stt_coordinator.STTCoordinatorService",
        ]

        service_mocks = {}
        for service_path in services_to_mock:
            with patch(service_path) as mock_service:
                mock_instance = Mock()
                mock_instance.start = AsyncMock()
                mock_service.return_value = mock_instance
                service_mocks[service_path] = mock_instance

        await supervisor.start_services()

        # Verify services were started
        assert len(supervisor.services) > 0

    @pytest.mark.asyncio
    async def test_shutdown(self, supervisor, mock_bus):
        """Test supervisor shutdown."""
        supervisor.bus = mock_bus
        supervisor.services = [Mock() for _ in range(3)]

        await supervisor.shutdown()

        mock_bus.stop.assert_called_once()

    @pytest.mark.asyncio
    async def test_run(self, supervisor, mock_bus):
        """Test supervisor run loop."""
        supervisor.bus = mock_bus
        supervisor.shutdown_event = Mock()
        supervisor.shutdown_event.wait = AsyncMock(side_effect=KeyboardInterrupt())

        with pytest.raises(KeyboardInterrupt):
            await supervisor.run()


class TestSupervisorErrorHandling:
    """Test supervisor error handling."""

    @pytest.mark.asyncio
    async def test_initialize_with_invalid_mode(self, supervisor):
        """Test initialization with invalid mode."""
        with patch("app.services.supervisor.config_manager") as mock_config:
            mock_config.get.return_value = "invalid_mode"

            with (
                patch("app.services.supervisor.register_all_service_topics"),
                pytest.raises(ValueError, match="Unknown architecture mode"),
            ):
                await supervisor.initialize()

    @pytest.mark.asyncio
    async def test_start_services_failure(self, supervisor, mock_bus):
        """Test service startup failure."""
        supervisor.bus = mock_bus

        with patch("app.db.DBService") as mock_db_service:
            mock_db = Mock()
            mock_db.start = AsyncMock(side_effect=Exception("Service failure"))
            mock_db_service.return_value = mock_db

            with pytest.raises(Exception, match="Service failure"):
                await supervisor.start_services()

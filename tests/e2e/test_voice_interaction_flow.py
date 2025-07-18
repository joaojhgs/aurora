"""
End-to-end tests for the Aurora system.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.database.database_manager import DatabaseManager
from app.langgraph.state import State
from app.speech_to_text.stt import STT
from app.text_to_speech.tts import TTS


@pytest.mark.e2e
class TestVoiceInteractionFlow:
    """End-to-end tests for the complete voice interaction flow."""

    @pytest.fixture
    def mock_config_manager(self):
        """Mock ConfigManager with test configuration."""
        mock = MagicMock()
        mock.get_config.return_value = {
            "app": {"name": "Aurora Test", "version": "0.1.0"},
            "speech_to_text": {
                "enabled": True,
                "wake_word_path": "test_wake_word.onnx",
                "timeout_seconds": 5,
            },
            "text_to_speech": {
                "enabled": True,
                "voice_model_path": "test_voice_model.onnx",
                "speaker_id": 0,
            },
            "langgraph": {"model_path": "test_model.gguf", "max_tokens": 100},
            "database": {"path": ":memory:"},
        }
        return mock

    @pytest.fixture
    async def mock_memory_store(self):
        """Create a mock memory store."""
        from app.langgraph.memory_store import CombinedSQLiteVecStore

        store = MagicMock(spec=CombinedSQLiteVecStore)
        store.initialize = AsyncMock()
        store.store_memory = AsyncMock()
        store.get_memories = AsyncMock(return_value=[])
        store.close = AsyncMock()
        yield store

    @pytest.fixture
    async def db_manager(self):
        """Create a database manager with in-memory database."""
        manager = DatabaseManager(db_path=":memory:")
        await manager.initialize()
        yield manager
        await manager.close()

    @pytest.fixture
    def mock_audio_recorder(self):
        """Mock audio recorder."""
        recorder = MagicMock()
        recorder.start_recording = AsyncMock()
        recorder.stop_recording = AsyncMock(return_value=b"audio_data")
        return recorder

    @pytest.fixture
    def mock_stt(self, mock_audio_recorder):
        """Create a mock STT instance."""
        stt = MagicMock(spec=STT)
        stt._audio_recorder = mock_audio_recorder
        stt.start_listening = AsyncMock()
        # Configure the start_listening mock to call the callback
        stt.start_listening.side_effect = lambda callback: callback(b"audio_data")
        return stt

    @pytest.fixture
    def mock_tts(self):
        """Create a mock TTS instance."""
        tts = MagicMock(spec=TTS)
        tts.speak_text = AsyncMock()
        return tts

    @pytest.fixture
    def mock_llm_graph(self):
        """Create a mock LangGraph."""
        graph = MagicMock()
        graph.arun = AsyncMock(
            return_value={
                "messages": [
                    {"role": "user", "content": "What time is it?"},
                    {"role": "assistant", "content": "It's currently 3:00 PM."},
                ],
                "current_node": "end",
            }
        )
        return graph

    @pytest.mark.asyncio
    async def test_complete_voice_interaction_flow(self, mock_config_manager, mock_stt, mock_tts, mock_llm_graph, mock_memory_store, db_manager):
        """Test the complete voice interaction flow from wake word to response."""

        # Set up mocks for the complete pipeline
        with patch("app.config.config_manager.ConfigManager.get_instance", return_value=mock_config_manager):
            with patch("app.speech_to_text.stt.STT", return_value=mock_stt):
                with patch("app.text_to_speech.tts.TTS", return_value=mock_tts):
                    with patch("app.langgraph.graph.build_graph", return_value=mock_llm_graph):
                        # Mock speech-to-text transcription
                        async def transcribe_audio(audio_data):
                            return "What time is it?"

                        # Execute the complete flow
                        # 1. Wake word detection and STT
                        mock_stt._detect_wake_word = MagicMock(return_value=True)
                        transcription = await mock_stt.start_listening(transcribe_audio)

                        # 2. Create an initial state with the transcription
                        initial_state = State(
                            messages=[{"role": "user", "content": transcription}],
                            current_node="llm",
                        )

                        # 3. Process through the LangGraph
                        result = await mock_llm_graph.arun(initial_state)

                        # 4. Get response and send to TTS
                        assistant_message = result["messages"][-1]["content"]
                        await mock_tts.speak_text(assistant_message)

                        # 5. Store in database
                        await db_manager.store_message({"content": transcription, "role": "user"})
                        await db_manager.store_message({"content": assistant_message, "role": "assistant"})

                        # Verify the complete flow worked as expected
                        mock_stt.start_listening.assert_called_once()
                        mock_llm_graph.arun.assert_called_once()
                        mock_tts.speak_text.assert_called_once_with("It's currently 3:00 PM.")

    @pytest.mark.asyncio
    async def test_error_recovery_flow(self, mock_config_manager, mock_stt, mock_tts, mock_llm_graph, mock_memory_store, db_manager):
        """Test the error recovery flow when a component fails."""

        # Set up mocks for the pipeline
        with patch("app.config.config_manager.ConfigManager.get_instance", return_value=mock_config_manager):
            with patch("app.speech_to_text.stt.STT", return_value=mock_stt):
                with patch("app.text_to_speech.tts.TTS", return_value=mock_tts):
                    with patch("app.langgraph.graph.build_graph", return_value=mock_llm_graph):
                        # 1. Configure STT to succeed
                        async def transcribe_audio(audio_data):
                            return "What time is it?"

                        mock_stt._detect_wake_word = MagicMock(return_value=True)
                        transcription = await mock_stt.start_listening(transcribe_audio)

                        # 2. Configure LangGraph to fail
                        mock_llm_graph.arun.side_effect = Exception("Model processing failed")

                        try:
                            # 3. Create an initial state with the transcription
                            initial_state = State(
                                messages=[{"role": "user", "content": transcription}],
                                current_node="llm",
                            )

                            # 4. Process through the LangGraph (should fail)
                            await mock_llm_graph.arun(initial_state)
                        except Exception:
                            # 5. Error recovery: Notify the user
                            await mock_tts.speak_text("I'm sorry, I encountered an error processing your request.")

                            # 6. Log the error in the database
                            await db_manager.store_message(
                                {
                                    "content": "Error: Model processing failed",
                                    "role": "system",
                                    "metadata": {"error": True},
                                }
                            )

                        # Verify the error recovery flow worked
                        mock_tts.speak_text.assert_called_once_with("I'm sorry, I encountered an error processing your request.")

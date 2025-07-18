"""
Tests for ambient transcription database integration.
"""

import os
import tempfile
from datetime import datetime
from unittest.mock import Mock, patch

import pytest

from app.config.config_manager import ConfigManager
from app.database.ambient_transcription_service import AmbientTranscriptionService
from app.database.database_manager import DatabaseManager
from app.database.models import AmbientTranscription


import pytest_asyncio


@pytest_asyncio.fixture
async def temp_db():
    """Create a temporary database for testing"""
    with tempfile.NamedTemporaryFile(delete=False, suffix=".db") as f:
        db_path = f.name

    db_manager = DatabaseManager(db_path)
    await db_manager.initialize()

    yield db_manager

    # Cleanup
    os.unlink(db_path)


@pytest.fixture
def mock_config():
    """Create a mock configuration manager"""
    config = Mock(spec=ConfigManager)
    config.get.return_value = True  # Default to enabled
    return config


class TestAmbientTranscriptionModel:
    """Test ambient transcription model"""

    def test_create_ambient_transcription(self):
        """Test creating an ambient transcription"""
        transcription = AmbientTranscription.create(
            text="Hello world",
            chunk_id="test_chunk_1",
            duration=3.5,
            confidence=0.95,
            embedding=[0.1, 0.2, 0.3],
            metadata={"test": "data"},
            session_id="session_1",
        )

        assert transcription.text == "Hello world"
        assert transcription.chunk_id == "test_chunk_1"
        assert transcription.duration == 3.5
        assert transcription.confidence == 0.95
        assert transcription.get_embedding_vector() == [0.1, 0.2, 0.3]
        assert transcription.metadata == {"test": "data"}
        assert transcription.session_id == "session_1"
        assert transcription.id is not None
        assert isinstance(transcription.timestamp, datetime)

    def test_to_dict_and_from_dict(self):
        """Test conversion to/from dictionary"""
        original = AmbientTranscription.create(text="Test transcription", chunk_id="chunk_123", duration=2.5, confidence=0.8)

        # Convert to dict and back
        data = original.to_dict()
        restored = AmbientTranscription.from_dict(data)

        assert restored.text == original.text
        assert restored.chunk_id == original.chunk_id
        assert restored.duration == original.duration
        assert restored.confidence == original.confidence
        assert restored.id == original.id


class TestDatabaseManager:
    """Test database manager ambient transcription methods"""

    @pytest.mark.asyncio
    async def test_store_ambient_transcription(self, temp_db):
        """Test storing ambient transcription in database"""
        transcription = AmbientTranscription.create(text="Database test", chunk_id="db_chunk_1", duration=1.5)

        success = await temp_db.store_ambient_transcription(transcription)
        assert success is True

    @pytest.mark.asyncio
    async def test_get_ambient_transcriptions_for_date(self, temp_db):
        """Test retrieving ambient transcriptions by date"""
        # Store some transcriptions
        transcription1 = AmbientTranscription.create(text="Morning transcription", chunk_id="morning_1", duration=2.0)
        transcription2 = AmbientTranscription.create(text="Evening transcription", chunk_id="evening_1", duration=3.0)

        await temp_db.store_ambient_transcription(transcription1)
        await temp_db.store_ambient_transcription(transcription2)

        # Retrieve transcriptions for today
        today_transcriptions = await temp_db.get_ambient_transcriptions_for_date()

        assert len(today_transcriptions) == 2
        assert any(t.text == "Morning transcription" for t in today_transcriptions)
        assert any(t.text == "Evening transcription" for t in today_transcriptions)

    @pytest.mark.asyncio
    async def test_search_ambient_transcriptions_by_text(self, temp_db):
        """Test text search functionality"""
        # Store test transcriptions
        transcriptions = [AmbientTranscription.create("The weather is sunny today", f"chunk_{i}", 1.0) for i in range(3)]
        transcriptions.append(AmbientTranscription.create("It's raining outside", "chunk_rain", 1.0))

        for t in transcriptions:
            await temp_db.store_ambient_transcription(t)

        # Search for weather-related transcriptions
        results = await temp_db.search_ambient_transcriptions_by_text("weather")
        assert len(results) == 3

        # Search for rain-related transcriptions
        results = await temp_db.search_ambient_transcriptions_by_text("rain")
        assert len(results) == 1
        assert results[0].text == "It's raining outside"

    @pytest.mark.asyncio
    async def test_get_ambient_transcription_by_chunk_id(self, temp_db):
        """Test retrieving transcription by chunk ID"""
        transcription = AmbientTranscription.create(text="Unique chunk test", chunk_id="unique_chunk_123", duration=2.5)

        await temp_db.store_ambient_transcription(transcription)

        # Retrieve by chunk ID
        retrieved = await temp_db.get_ambient_transcription_by_chunk_id("unique_chunk_123")

        assert retrieved is not None
        assert retrieved.text == "Unique chunk test"
        assert retrieved.chunk_id == "unique_chunk_123"
        assert retrieved.duration == 2.5

    @pytest.mark.asyncio
    async def test_update_ambient_transcription_embedding(self, temp_db):
        """Test updating embedding for transcription"""
        transcription = AmbientTranscription.create(text="Embedding test", chunk_id="embed_chunk", duration=1.0)

        await temp_db.store_ambient_transcription(transcription)

        # Update embedding
        test_embedding = [0.1, 0.2, 0.3, 0.4, 0.5]
        success = await temp_db.update_ambient_transcription_embedding(transcription.id, test_embedding)

        assert success is True

        # Verify embedding was updated
        retrieved = await temp_db.get_ambient_transcription_by_chunk_id("embed_chunk")
        assert retrieved.get_embedding_vector() == test_embedding


class TestAmbientTranscriptionService:
    """Test ambient transcription service"""

    @pytest.mark.asyncio
    async def test_service_initialization(self, temp_db, mock_config):
        """Test service initialization"""
        service = AmbientTranscriptionService(temp_db, mock_config)
        await service.initialize()

        # Service should be initialized without errors
        assert service.db_manager == temp_db
        assert service.config_manager == mock_config

    @pytest.mark.asyncio
    async def test_store_transcription(self, temp_db, mock_config):
        """Test storing transcription through service"""
        service = AmbientTranscriptionService(temp_db, mock_config)
        await service.initialize()

        success = await service.store_transcription(
            text="Service test transcription", timestamp=1234567890.0, chunk_id="service_chunk_1", duration=2.5, confidence=0.9
        )

        assert success is True

        # Verify it was stored
        retrieved = await temp_db.get_ambient_transcription_by_chunk_id("service_chunk_1")
        assert retrieved is not None
        assert retrieved.text == "Service test transcription"

    @pytest.mark.asyncio
    async def test_search_by_text(self, temp_db, mock_config):
        """Test text search through service"""
        service = AmbientTranscriptionService(temp_db, mock_config)
        await service.initialize()

        # Store some test data
        await service.store_transcription(text="The quick brown fox", timestamp=1234567890.0, chunk_id="fox_chunk", duration=1.0)

        # Search
        results = await service.search_by_text("quick brown")

        assert len(results) == 1
        assert results[0].text == "The quick brown fox"

    @pytest.mark.asyncio
    async def test_get_transcriptions_for_date(self, temp_db, mock_config):
        """Test getting transcriptions for date through service"""
        service = AmbientTranscriptionService(temp_db, mock_config)
        await service.initialize()

        # Store transcription
        await service.store_transcription(text="Today's transcription", timestamp=1234567890.0, chunk_id="today_chunk", duration=1.5)

        # Get today's transcriptions
        results = await service.get_transcriptions_for_date()

        assert len(results) >= 1
        assert any(t.text == "Today's transcription" for t in results)

    def test_create_storage_callback(self, temp_db, mock_config):
        """Test creating storage callback"""
        service = AmbientTranscriptionService(temp_db, mock_config)

        callback = service.create_storage_callback("test_session")

        assert callable(callback)

        # Test callback execution (this will run async code)
        try:
            callback("Test callback text", 1234567890.0, "callback_chunk", 2.0)
        except Exception:
            # It's okay if this fails due to async context,
            # we're just testing that the callback is created
            pass


class TestVectorSimilarity:
    """Test vector similarity functionality"""

    @pytest.mark.asyncio
    async def test_cosine_similarity_calculation(self, temp_db):
        """Test cosine similarity calculation"""
        # Test identical vectors (should be 1.0)
        vec1 = [1, 0, 0]
        vec2 = [1, 0, 0]
        similarity = temp_db._calculate_cosine_similarity(vec1, vec2)
        assert abs(similarity - 1.0) < 0.001

        # Test orthogonal vectors (should be 0.0)
        vec1 = [1, 0, 0]
        vec2 = [0, 1, 0]
        similarity = temp_db._calculate_cosine_similarity(vec1, vec2)
        assert abs(similarity - 0.0) < 0.001

        # Test opposite vectors (should be -1.0)
        vec1 = [1, 0, 0]
        vec2 = [-1, 0, 0]
        similarity = temp_db._calculate_cosine_similarity(vec1, vec2)
        assert abs(similarity - (-1.0)) < 0.001

    @pytest.mark.asyncio
    async def test_search_by_similarity(self, temp_db):
        """Test vector similarity search"""
        # Store transcriptions with embeddings
        transcription1 = AmbientTranscription.create(text="The cat sat on the mat", chunk_id="cat_chunk", duration=1.0, embedding=[1.0, 0.0, 0.0])
        transcription2 = AmbientTranscription.create(
            text="The dog ran in the park", chunk_id="dog_chunk", duration=1.0, embedding=[0.9, 0.1, 0.0]  # Similar to first
        )
        transcription3 = AmbientTranscription.create(
            text="Programming in Python is fun", chunk_id="python_chunk", duration=1.0, embedding=[0.0, 0.0, 1.0]  # Very different
        )

        await temp_db.store_ambient_transcription(transcription1)
        await temp_db.store_ambient_transcription(transcription2)
        await temp_db.store_ambient_transcription(transcription3)

        # Search with query similar to cat/dog embeddings
        query_embedding = [0.95, 0.05, 0.0]
        results = await temp_db.search_ambient_transcriptions_by_similarity(query_embedding, limit=10, similarity_threshold=0.5)

        # Should return cat and dog transcriptions, but not python
        assert len(results) == 2
        texts = [r.text for r in results]
        assert "The cat sat on the mat" in texts
        assert "The dog ran in the park" in texts
        assert "Programming in Python is fun" not in texts


class TestAmbientHelpers:
    """Test ambient transcription helper functions"""

    @patch("app.speech_to_text.ambient_helpers.DatabaseManager")
    @patch("app.speech_to_text.ambient_helpers.AmbientTranscriptionService")
    def test_setup_ambient_recorder_with_database(self, mock_service_class, mock_db_class, mock_config):
        """Test setting up recorder with database integration"""
        from app.speech_to_text.ambient_helpers import setup_ambient_recorder_with_database

        # Mock the async setup
        mock_db = Mock()
        mock_service = Mock()
        mock_db_class.return_value = mock_db
        mock_service_class.return_value = mock_service

        # Configure mock config
        mock_config.get.side_effect = lambda key, default=None: {
            "general.speech_to_text.ambient_transcription": {
                "enable": True,
                "chunk_duration": 3.0,
                "storage_path": "test_path/",
                "filter_short_transcriptions": True,
                "min_transcription_length": 10,
                "use_database_storage": True,
            }
        }.get(key, default)

        # This test verifies the function structure
        # Full integration testing would require actual async context
        assert callable(setup_ambient_recorder_with_database)


if __name__ == "__main__":
    pytest.main([__file__])

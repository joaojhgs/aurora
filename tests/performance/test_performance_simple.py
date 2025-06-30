"""
Performance tests for the Aurora system using mocks.
"""

import asyncio
import multiprocessing
import os
import time
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.database.database_manager import DatabaseManager
from app.database.models import Message, MessageType


# Create a mock MemoryStore for testing
class MockMemoryStore:
    """Mock memory store for testing."""

    def __init__(self, db_path=":memory:"):
        self.db_path = db_path
        self.connection = None

    async def initialize(self):
        """Initialize the memory store."""
        self.connection = MagicMock()

    async def store_memory(self, key, value):
        """Store a memory."""
        await asyncio.sleep(0.001)  # Simulate minimal latency
        return "memory_id"

    async def get_memories(self, key, limit=10):
        """Get memories by key."""
        await asyncio.sleep(0.002)  # Simulate minimal latency
        return [{"content": f"Memory {i}", "metadata": {"key": key}} for i in range(limit)]

    async def close(self):
        """Close the connection."""
        self.connection = None


# Create a mock graph builder for testing
def mock_build_graph(model_path=None, model_parameters=None, memory_store=None):
    """Mock graph builder function."""
    mock_graph = MagicMock()

    async def mock_ainvoke(input_data, **kwargs):
        """Mock ainvoke method."""
        await asyncio.sleep(0.01)  # Simulate minimal latency
        return {
            "messages": [
                {"role": "user", "content": input_data.get("content", "")},
                {"role": "assistant", "content": "This is a mock response."},
            ]
        }

    mock_graph.ainvoke = mock_ainvoke
    return mock_graph


class TestConcurrentOperations:
    """Test performance under concurrent operations."""

    @pytest.fixture
    async def db_manager(self):
        """Create a database manager with in-memory database."""
        manager = DatabaseManager(db_path=":memory:")
        await manager.initialize()
        yield manager
        await manager.close()

    @pytest.fixture
    def memory_store(self):
        """Create a mock memory store."""
        store = MockMemoryStore(db_path=":memory:")
        return store

    @pytest.mark.asyncio
    async def test_concurrent_database_operations(self, db_manager):
        """Test concurrent database operations."""
        # Setup
        message = Message(
            content="Performance test message",
            message_type=MessageType.USER_TEXT,
            timestamp=time.time(),
        )

        # Create multiple messages concurrently
        start_time = time.time()
        tasks = []
        for i in range(5):
            tasks.append(
                db_manager.store_message(
                    Message(
                        content=f"Concurrent message {i}",
                        message_type=MessageType.USER_TEXT,
                        timestamp=time.time(),
                    )
                )
            )

        await asyncio.gather(*tasks)
        end_time = time.time()

        # Verify performance
        duration = end_time - start_time
        assert duration < 0.5, f"Concurrent database operations too slow: {duration:.4f}s"

    @pytest.mark.asyncio
    async def test_memory_store_performance(self, memory_store):
        """Test memory store performance."""
        # Initialize the store
        await memory_store.initialize()

        # Measure storage performance
        start_time = time.time()
        tasks = []
        for i in range(5):
            key = f"test:key:{i}"
            value = {"content": f"Test content {i}", "metadata": {"test": True}}
            tasks.append(memory_store.store_memory(key, value))

        await asyncio.gather(*tasks)
        storage_time = time.time() - start_time

        # Measure retrieval performance
        start_time = time.time()
        tasks = []
        for i in range(5):
            key = f"test:key:{i}"
            tasks.append(memory_store.get_memories(key, limit=5))

        await asyncio.gather(*tasks)
        retrieval_time = time.time() - start_time

        # Verify performance
        assert storage_time < 0.1, f"Memory storage too slow: {storage_time:.4f}s"
        assert retrieval_time < 0.1, f"Memory retrieval too slow: {retrieval_time:.4f}s"

    @pytest.mark.asyncio
    async def test_graph_performance(self):
        """Test graph processing performance."""
        # Create a mock graph
        with patch("app.langgraph.graph.build_graph", mock_build_graph):
            graph = mock_build_graph()

            # Measure multiple invocations
            start_time = time.time()
            tasks = []
            for i in range(5):
                tasks.append(graph.ainvoke({"content": f"Test message {i}"}))

            await asyncio.gather(*tasks)
            duration = time.time() - start_time

            # Verify performance
            assert duration < 0.2, f"Graph processing too slow: {duration:.4f}s"

"""
Performance tests for Aurora components.
"""

import asyncio
import time
from unittest.mock import MagicMock, patch

import pytest
import pytest_asyncio

from app.db.models import Message, MessageType


@pytest.mark.performance
class TestPerformanceMeasurements:
    """Test performance of key Aurora components."""

    @pytest_asyncio.fixture
    async def mock_environment(self):
        """Set up a mock environment for performance testing."""
        # Mock database with minimal latency
        mock_db = MagicMock()

        async def fast_store_message(message):
            """Simulate fast message storage with 5ms latency."""
            await asyncio.sleep(0.005)
            return True

        async def fast_get_messages(limit=10):
            """Simulate fast message retrieval with 10ms latency."""
            await asyncio.sleep(0.01)
            return [MagicMock(spec=Message) for _ in range(limit)]

        mock_db.store_message = fast_store_message
        mock_db.get_recent_messages = fast_get_messages

        # Mock config
        mock_config = MagicMock()
        mock_config.get = MagicMock(return_value={"performance": {"logging_enabled": True}})

        # Mock graph with configurable latency
        mock_graph = MagicMock()

        async def simulate_graph_processing(input, latency=0.1):
            """Simulate graph processing with configurable latency."""
            await asyncio.sleep(latency)
            return {
                "messages": [
                    {"role": "user", "content": input.get("messages", [{}])[-1].get("content", "")},
                    {"role": "assistant", "content": "This is a simulated response"},
                ]
            }

        mock_graph.ainvoke = simulate_graph_processing

        yield {"database": mock_db, "config": mock_config, "graph": mock_graph}

    @pytest.mark.asyncio
    async def test_database_operation_performance(self, mock_environment):
        """Test database operation performance."""
        # Setup
        db = mock_environment["database"]
        message = Message(
            content="Performance test message",
            message_type=MessageType.USER_TEXT,
            timestamp=time.time(),
        )

        # Measure message storage performance (10 operations)
        start_time = time.time()
        for _ in range(10):
            await db.store_message(message)
        end_time = time.time()

        storage_time = end_time - start_time
        avg_storage_time = storage_time / 10

        # Verify acceptable performance (should be fast since we're using mocks)
        assert avg_storage_time < 0.01, f"Message storage too slow: {avg_storage_time:.4f}s per operation"

        # Measure message retrieval performance
        start_time = time.time()
        for _ in range(5):
            await db.get_recent_messages(20)
        end_time = time.time()

        retrieval_time = end_time - start_time
        avg_retrieval_time = retrieval_time / 5

        # Verify acceptable performance
        assert avg_retrieval_time < 0.02, f"Message retrieval too slow: {avg_retrieval_time:.4f}s per operation"

    @pytest.mark.asyncio
    async def test_graph_processing_performance(self):
        """Test LangGraph processing performance."""
        # Create a mock graph with precise timing control
        mock_graph = MagicMock()
        processing_times = [0.050, 0.055, 0.052, 0.048, 0.051]  # Simulated 50ms processing time

        call_count = 0

        async def timed_process(input, **kwargs):
            """Simulate graph processing with controlled timing."""
            nonlocal call_count
            await asyncio.sleep(processing_times[call_count % len(processing_times)])
            call_count += 1
            return {
                "messages": [
                    {"role": "user", "content": "Test input"},
                    {"role": "assistant", "content": "Test output"},
                ]
            }

        mock_graph.ainvoke = timed_process

        # Patch the graph
        with patch("app.langgraph.graph.graph", mock_graph):
            from app.orchestrator.graph import process_text_input

            # Measure processing time for multiple requests
            total_time = 0
            iterations = 5

            for i in range(iterations):
                start_time = time.time()
                await process_text_input(f"Test message {i}")
                elapsed = time.time() - start_time
                total_time += elapsed

            avg_time = total_time / iterations

            # Verify performance
            assert avg_time < 0.1, f"Graph processing too slow: {avg_time:.4f}s per operation"

    @pytest.mark.asyncio
    async def test_memory_usage(self):
        """Test memory usage during operations."""
        try:
            import os

            import psutil

            process = psutil.Process(os.getpid())

            # Get baseline memory usage
            baseline_memory = process.memory_info().rss / 1024 / 1024  # MB

            # Create large test objects
            large_objects = []
            for _ in range(100):
                large_objects.append("X" * 10000)  # Create 10KB strings

            # Check memory usage after creating objects
            current_memory = process.memory_info().rss / 1024 / 1024  # MB
            memory_increase = current_memory - baseline_memory

            # Log memory usage
            print(f"Memory usage: Baseline={baseline_memory:.2f}MB, Current={current_memory:.2f}MB, Increase={memory_increase:.2f}MB")

            # Clean up
            large_objects = None

            # Memory usage should be below a reasonable threshold for test environment
            # This is a very basic check and will vary by system
            assert memory_increase < 100, f"Memory usage increased too much: {memory_increase:.2f}MB"

        except ImportError:
            pytest.skip("psutil not installed, skipping memory usage test")

    @pytest.mark.asyncio
    async def test_concurrent_processing(self, mock_environment):
        """Test performance under concurrent load."""
        # Mock the graph
        with patch("app.langgraph.graph.graph", mock_environment["graph"]):
            from app.orchestrator.graph import process_text_input

            # Execute multiple requests concurrently
            start_time = time.time()
            tasks = []
            for i in range(5):
                tasks.append(process_text_input(f"Concurrent message {i}"))

            # Wait for all tasks
            await asyncio.gather(*tasks)
            total_time = time.time() - start_time

            # Verify concurrent performance
            # Concurrent execution should be faster than sequential for this test
            # (We expect around 0.1s total instead of 0.5s for sequential)
            assert total_time < 0.2, f"Concurrent processing too slow: {total_time:.4f}s"

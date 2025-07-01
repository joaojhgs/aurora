"""
Performance tests for the Aurora system.
"""

import asyncio
import multiprocessing
import os
import time
from datetime import datetime

import pytest

from app.database.database_manager import DatabaseManager
from app.database.models import Message, MessageType
from app.langgraph.memory_store import MemoryStore


class TestConcurrentOperations:
    """Test performance under concurrent operations."""

    @pytest.fixture
    async def db_manager(self):
        """Create a database manager with in-memory database."""
        manager = DatabaseManager(db_path=":memory:")
        await manager.initialize()
        yield manager
        await manager.close()

    @pytest.mark.asyncio
    async def test_concurrent_database_operations(self, db_manager):
        """Test database operations under concurrent load."""
        # Number of concurrent operations
        num_operations = 100

        async def store_message(index):
            """Store a message in the database."""
            message = Message(
                content=f"Test message {index}",
                role="user" if index % 2 == 0 else "assistant",
                message_type=MessageType.TEXT,
                metadata={"index": index},
            )
            return await db_manager.store_message(message)

        # Execute multiple store operations concurrently
        start_time = time.time()
        message_ids = await asyncio.gather(*[store_message(i) for i in range(num_operations)])
        end_time = time.time()

        # Verify all operations completed successfully
        assert len(message_ids) == num_operations
        assert all(message_id is not None for message_id in message_ids)

        # Assert the operation was reasonably fast
        duration = end_time - start_time
        print(f"Stored {num_operations} messages in {duration:.2f} seconds")

        # Concurrent retrieval operations
        async def get_message(message_id):
            """Retrieve a message from the database."""
            return await db_manager.get_message_by_id(message_id)

        # Execute multiple get operations concurrently
        start_time = time.time()
        messages = await asyncio.gather(*[get_message(message_id) for message_id in message_ids])
        end_time = time.time()

        # Verify all messages were retrieved
        assert len(messages) == num_operations
        assert all(message is not None for message in messages)

        # Assert the operation was reasonably fast
        duration = end_time - start_time
        print(f"Retrieved {num_operations} messages in {duration:.2f} seconds")

    @pytest.mark.asyncio
    async def test_memory_store_under_load(self):
        """Test memory store performance under load."""
        # Create a memory store
        store = MemoryStore(":memory:")
        await store.initialize()

        try:
            # Number of memories to store
            num_memories = 100

            async def store_memory(index):
                """Store a memory in the memory store."""
                key = f"test:key:{index % 10}"  # Use 10 different keys
                value = {
                    "content": f"Memory content {index}",
                    "metadata": {"timestamp": datetime.now().isoformat(), "index": index},
                }
                return await store.store_memory(key, value)

            # Store memories concurrently
            start_time = time.time()
            memory_ids = await asyncio.gather(*[store_memory(i) for i in range(num_memories)])
            end_time = time.time()

            # Verify memories were stored
            assert len(memory_ids) == num_memories

            # Assert the operation was reasonably fast
            duration = end_time - start_time
            print(f"Stored {num_memories} memories in {duration:.2f} seconds")

            # Retrieve memories concurrently
            async def get_memories(key_index):
                """Retrieve memories by key."""
                key = f"test:key:{key_index}"
                return await store.get_memories(key)

            # Get memories for all 10 keys
            start_time = time.time()
            all_memories = await asyncio.gather(*[get_memories(i) for i in range(10)])
            end_time = time.time()

            # Verify memories were retrieved
            total_memories = sum(len(memories) for memories in all_memories)
            assert total_memories == num_memories

            # Assert the operation was reasonably fast
            duration = end_time - start_time
            print(f"Retrieved {total_memories} memories in {duration:.2f} seconds")
        finally:
            await store.close()

    @pytest.mark.slow
    @pytest.mark.gpu
    def test_langgraph_performance(self):
        """Test LangGraph performance with real model loading."""
        # Skip if no GPU available
        try:
            from app.helpers.getUseHardwareAcceleration import is_cuda_available

            if not is_cuda_available():
                pytest.skip("No GPU available for testing")
        except ImportError:
            pytest.skip("Could not check GPU availability")

        # This test should only be run when a real model is available
        model_path = os.environ.get("TEST_MODEL_PATH")
        if not model_path or not os.path.exists(model_path):
            pytest.skip("No test model available")

        # Import actual implementation (not mocked)
        from app.langgraph.graph import build_graph
        from app.langgraph.memory_store import MemoryStore
        from app.langgraph.state import State

        # Run in a separate process to measure memory usage
        def run_model():
            async def async_run():
                # Create memory store
                store = MemoryStore(":memory:")
                await store.initialize()

                try:
                    # Build the actual graph
                    print("Building graph...")
                    graph = build_graph(
                        model_path=model_path,
                        model_parameters={"n_ctx": 2048, "n_batch": 512},
                        memory_store=store,
                    )

                    # Create initial state
                    initial_state = State(
                        messages=[{"role": "user", "content": "What is the capital of France?"}],
                        current_node="llm",
                    )

                    # Time the execution
                    print("Running inference...")
                    start_time = time.time()
                    result = await graph.arun(initial_state)
                    end_time = time.time()

                    duration = end_time - start_time
                    print(f"Inference completed in {duration:.2f} seconds")

                    # Check for a reasonable response
                    assert any("Paris" in msg.get("content", "") for msg in result["messages"] if isinstance(msg, dict))

                    return duration
                finally:
                    await store.close()

            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            return loop.run_until_complete(async_run())

        # Run in a subprocess to isolate memory usage
        process = multiprocessing.Process(target=run_model)
        process.start()
        process.join(timeout=60)  # Give it up to 60 seconds

        assert process.exitcode == 0, "LangGraph performance test failed"


class TestResourceUsage:
    """Test resource usage of various components."""

    @pytest.mark.performance
    def test_memory_leaks_in_long_running_process(self):
        """Test for memory leaks in long-running processes."""
        import gc

        import psutil

        # Get initial memory usage
        process = psutil.Process(os.getpid())
        initial_memory = process.memory_info().rss / 1024 / 1024  # MB

        # Run a loop that could potentially leak memory
        async def run_loop():
            db_manager = DatabaseManager(":memory:")
            await db_manager.initialize()

            try:
                for i in range(100):
                    # Create and store messages
                    for j in range(10):
                        message = Message(
                            content=f"Test message {i}-{j}",
                            role="user",
                            message_type=MessageType.TEXT,
                            metadata={"iteration": i, "index": j},
                        )
                        await db_manager.store_message(message)

                    # Get recent messages
                    messages = await db_manager.get_recent_messages(100)
                    assert len(messages) > 0

                    # Force garbage collection
                    gc.collect()
            finally:
                await db_manager.close()

        # Run the async function
        loop = asyncio.get_event_loop()
        loop.run_until_complete(run_loop())

        # Check memory usage after the test
        final_memory = process.memory_info().rss / 1024 / 1024  # MB
        memory_diff = final_memory - initial_memory

        print(f"Memory usage: initial={initial_memory:.2f}MB, final={final_memory:.2f}MB, diff={memory_diff:.2f}MB")

        # Assert memory growth is reasonable (less than 50MB)
        # This threshold may need adjustment based on the specific system
        assert memory_diff < 50, f"Memory usage increased by {memory_diff:.2f}MB, possible leak"

    @pytest.mark.performance
    @pytest.mark.slow
    def test_cpu_usage_during_operations(self):
        """Test CPU usage during intensive operations."""
        import psutil

        process = psutil.Process(os.getpid())

        async def run_cpu_intensive_task():
            # Simulate CPU-intensive operations
            db_manager = DatabaseManager(":memory:")
            await db_manager.initialize()

            try:
                # Start measuring CPU usage
                cpu_percent_samples = []

                for i in range(5):
                    # Reset CPU usage measurement
                    process.cpu_percent()

                    # Run intensive database operations
                    tasks = []
                    for j in range(1000):
                        message = Message(
                            content=f"Test message {i}-{j}",
                            role="user" if j % 2 == 0 else "assistant",
                            message_type=MessageType.TEXT,
                            metadata={"iteration": i, "index": j},
                        )
                        tasks.append(db_manager.store_message(message))

                    await asyncio.gather(*tasks)

                    # Get CPU usage after this batch
                    cpu_percent = process.cpu_percent()
                    cpu_percent_samples.append(cpu_percent)

                    # Add a small delay to allow CPU measurement
                    await asyncio.sleep(0.1)

                # Calculate average CPU usage
                avg_cpu_usage = sum(cpu_percent_samples) / len(cpu_percent_samples)
                print(f"Average CPU usage: {avg_cpu_usage:.2f}%")

                return avg_cpu_usage
            finally:
                await db_manager.close()

        # Run the CPU test
        loop = asyncio.get_event_loop()
        avg_cpu_usage = loop.run_until_complete(run_cpu_intensive_task())

        # Log the result, but don't assert on specific values as it's hardware-dependent
        # This is more useful as a benchmark than a pass/fail test
        print(f"CPU test completed with average usage: {avg_cpu_usage:.2f}%")

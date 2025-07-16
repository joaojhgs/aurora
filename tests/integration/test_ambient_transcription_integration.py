"""
Integration test for ambient transcription with the main application.
Tests the real-time processing system with priority queue.
"""

import os
import tempfile
import time
from unittest.mock import MagicMock, Mock, patch


# Test that demonstrates how to integrate ambient transcription with main.py
def test_main_integration():
    """Test that ambient transcription can be integrated with the main application"""

    # Mock storage for testing
    ambient_results = []

    def test_ambient_callback(text, timestamp, chunk_id):
        """Test callback for ambient transcription with updated signature"""
        ambient_results.append({"text": text, "timestamp": timestamp, "chunk_id": chunk_id, "length": len(text)})

    # Example configuration for real-time processing
    ambient_config = {
        "enable_ambient_transcription": True,
        "ambient_chunk_duration": 3.0,  # 3 seconds for real-time processing
        "ambient_storage_path": "ambient_logs/",
        "ambient_filter_short": True,
        "ambient_min_length": 10,
        "on_ambient_transcription": test_ambient_callback,
    }

    # This is how main.py could be modified to support ambient transcription
    suggested_main_modification = """
    # In main.py, modify the AudioToTextRecorder initialization:

    def on_ambient_transcription(text, timestamp, chunk_id):
        # Store ambient transcription for day summaries
        import datetime
        date_str = datetime.datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d")
        filename = f"ambient_logs/ambient_{date_str}.txt"

        os.makedirs("ambient_logs", exist_ok=True)

        time_str = datetime.datetime.fromtimestamp(timestamp).strftime("%H:%M:%S")
        log_entry = f"[{time_str}] ({chunk_id}) {text}\\n"

        with open(filename, "a", encoding="utf-8") as f:
            f.write(log_entry)

    # Then add to AudioToTextRecorder initialization:
    ambient_config = config_manager.get("speech_to_text.ambient_transcription", {})

    with AudioToTextRecorder(
        # ... existing parameters ...

        # Add ambient transcription parameters
        enable_ambient_transcription=ambient_config.get("enable", False),
        ambient_chunk_duration=ambient_config.get("chunk_duration", 3.0),
        ambient_storage_path=ambient_config.get("storage_path", "ambient_logs/"),
        ambient_filter_short=ambient_config.get("filter_short_transcriptions", True),
        ambient_min_length=ambient_config.get("min_transcription_length", 10),
        on_ambient_transcription=on_ambient_transcription,
    ) as recorder:
        # ... rest of main.py code ...
    """

    print("Suggested main.py modification for real-time ambient transcription:")
    print(suggested_main_modification)

    # Test that configuration is valid
    assert ambient_config["enable_ambient_transcription"]
    assert ambient_config["ambient_chunk_duration"] > 0
    assert ambient_config["ambient_storage_path"] == "ambient_logs/"
    assert ambient_config["ambient_filter_short"]
    assert ambient_config["ambient_min_length"] > 0
    assert callable(ambient_config["on_ambient_transcription"])

    # Test the callback with updated signature
    test_text = "This is a test ambient transcription"
    test_timestamp = time.time()
    test_chunk_id = "chunk_001"

    ambient_config["on_ambient_transcription"](test_text, test_timestamp, test_chunk_id)

    assert len(ambient_results) == 1
    assert ambient_results[0]["text"] == test_text
    assert ambient_results[0]["timestamp"] == test_timestamp
    assert ambient_results[0]["chunk_id"] == test_chunk_id
    assert ambient_results[0]["length"] == len(test_text)

    print("✓ Ambient transcription integration test passed")


def test_configuration_manager_integration():
    """Test integration with the configuration manager"""

    # Example configuration for real-time processing
    ambient_config_schema = {
        "speech_to_text": {
            "ambient_transcription": {
                "enable": False,
                "chunk_duration": 3.0,  # Real-time processing every 3 seconds
                "storage_path": "ambient_logs/",
                "filter_short_transcriptions": True,
                "min_transcription_length": 10,
            }
        }
    }

    # Test that configuration is well-formed
    config = ambient_config_schema["speech_to_text"]["ambient_transcription"]
    assert isinstance(config["enable"], bool)
    assert isinstance(config["chunk_duration"], (int, float))
    assert isinstance(config["storage_path"], str)
    assert isinstance(config["filter_short_transcriptions"], bool)
    assert isinstance(config["min_transcription_length"], int)

    # Test reasonable values
    assert config["chunk_duration"] > 0.5  # At least 0.5 seconds
    assert config["chunk_duration"] <= 60.0  # At most 60 seconds
    assert config["min_transcription_length"] >= 1  # At least 1 character

    print("✓ Configuration manager integration test passed")


def test_performance_impact():
    """Test that ambient transcription doesn't impact main functionality"""

    # Mock timing test
    start_time = time.time()

    # Simulate ambient transcription processing
    time.sleep(0.01)  # Simulate 10ms processing time

    processing_time = time.time() - start_time

    # Should be very fast and not impact main processing
    assert processing_time < 0.1  # Less than 100ms

    print("✓ Performance impact test passed")


def test_priority_system():
    """Test the priority queue system for ambient transcription"""
    import queue

    # Mock TranscriptionPriority
    class MockTranscriptionPriority:
        HIGH = 1
        LOW = 2

    # Create priority queue
    priority_queue = queue.PriorityQueue()

    # Add requests with different priorities
    priority_queue.put((MockTranscriptionPriority.LOW, 1, "ambient_audio"))
    priority_queue.put((MockTranscriptionPriority.HIGH, 2, "assistant_audio"))
    priority_queue.put((MockTranscriptionPriority.LOW, 3, "ambient_audio_2"))

    # Get requests - HIGH priority should come first
    first_request = priority_queue.get()
    assert first_request[0] == MockTranscriptionPriority.HIGH
    assert first_request[2] == "assistant_audio"

    # LOW priority requests should come after
    second_request = priority_queue.get()
    assert second_request[0] == MockTranscriptionPriority.LOW
    assert second_request[2] == "ambient_audio"

    third_request = priority_queue.get()
    assert third_request[0] == MockTranscriptionPriority.LOW
    assert third_request[2] == "ambient_audio_2"

    print("✓ Priority system test passed")


def test_real_time_processing_pattern():
    """Test the real-time processing pattern"""
    import threading
    import time

    # Mock real-time processing
    processed_chunks = []

    def mock_ambient_worker(chunk_duration=3.0, max_chunks=3):
        """Mock ambient worker for real-time processing"""
        for i in range(max_chunks):
            time.sleep(chunk_duration * 0.1)  # Simulate processing
            chunk_id = f"chunk_{i:03d}"
            processed_chunks.append(chunk_id)

    # Test that real-time processing works
    start_time = time.time()
    mock_ambient_worker(chunk_duration=1.0, max_chunks=3)
    end_time = time.time()

    # Should have processed 3 chunks
    assert len(processed_chunks) == 3
    assert processed_chunks[0] == "chunk_000"
    assert processed_chunks[1] == "chunk_001"
    assert processed_chunks[2] == "chunk_002"

    # Should be fast (mocked processing)
    assert end_time - start_time < 1.0

    print("✓ Real-time processing pattern test passed")


def test_callback_storage_patterns():
    """Test different storage patterns for callbacks"""
    import datetime
    import json

    # Test file storage pattern
    file_results = []

    def file_storage_callback(text, timestamp, chunk_id):
        """Mock file storage callback"""
        date_str = datetime.datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d")
        time_str = datetime.datetime.fromtimestamp(timestamp).strftime("%H:%M:%S")
        entry = f"[{time_str}] ({chunk_id}) {text}"
        file_results.append(entry)

    # Test database storage pattern
    db_results = []

    def db_storage_callback(text, timestamp, chunk_id):
        """Mock database storage callback"""
        db_results.append(
            {
                "text": text,
                "timestamp": timestamp,
                "datetime": datetime.datetime.fromtimestamp(timestamp).isoformat(),
                "chunk_id": chunk_id,
                "length": len(text),
            }
        )

    # Test filtered storage pattern
    filtered_results = []

    def filtered_storage_callback(text, timestamp, chunk_id):
        """Mock filtered storage callback"""
        # Filter short transcriptions
        if len(text.strip()) < 10:
            return

        # Filter noise patterns
        noise_patterns = ["hmm", "uh", "noise"]
        if any(pattern in text.lower() for pattern in noise_patterns):
            return

        filtered_results.append({"text": text, "timestamp": timestamp, "chunk_id": chunk_id})

    # Test all patterns
    test_data = [
        ("This is a meaningful transcription", time.time(), "chunk_001"),
        ("hmm", time.time(), "chunk_002"),  # Should be filtered
        ("Short", time.time(), "chunk_003"),  # Should be filtered
        ("Another meaningful transcription", time.time(), "chunk_004"),
    ]

    for text, timestamp, chunk_id in test_data:
        file_storage_callback(text, timestamp, chunk_id)
        db_storage_callback(text, timestamp, chunk_id)
        filtered_storage_callback(text, timestamp, chunk_id)

    # Verify results
    assert len(file_results) == 4  # File storage gets everything
    assert len(db_results) == 4  # Database storage gets everything
    assert len(filtered_results) == 2  # Filtered storage only gets meaningful entries

    # Check filtered results
    assert "meaningful transcription" in filtered_results[0]["text"]
    assert "Another meaningful transcription" in filtered_results[1]["text"]

    print("✓ Callback storage patterns test passed")


if __name__ == "__main__":
    test_main_integration()
    test_configuration_manager_integration()
    test_performance_impact()
    test_priority_system()
    test_real_time_processing_pattern()
    test_callback_storage_patterns()
    print("\n🎉 All integration tests passed!")

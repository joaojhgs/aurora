"""
Test data for Aurora tests.

This module provides test data that can be used in tests, such as sample configurations,
messages, and other objects.
"""

import json
import os
import uuid
from datetime import datetime, timedelta

from app.db.models import Message, MessageType
from app.scheduler.models import CronJob, JobStatus, ScheduleType

# Job class is no longer available in the scheduler models


# Sample config data
def get_test_config():
    """Get a test configuration."""
    return {
        "app": {"name": "Aurora Test", "version": "0.1.0", "log_level": "DEBUG"},
        "database": {"path": ":memory:"},
        "speech_to_text": {
            "enabled": False,
            "wake_word_path": "test_wake_word.onnx",
            "timeout_seconds": 5,
        },
        "text_to_speech": {
            "enabled": False,
            "voice_model_path": "test_voice_model.onnx",
            "speaker_id": 0,
        },
        "scheduler": {"enabled": False},
        "langgraph": {"model_path": "test_model.gguf", "max_tokens": 100},
        "embeddings": {"use_local": True},
    }


def get_test_config_file(temp_path):
    """Create a test configuration file.

    Args:
        temp_path (str): The directory where the file should be created.

    Returns:
        str: The path to the created config file.
    """
    config_path = os.path.join(temp_path, "test_config.json")
    with open(config_path, "w") as f:
        json.dump(get_test_config(), f)
    return config_path


# Sample message data
def get_sample_messages(count=5):
    """Get a list of sample messages.

    Args:
        count (int, optional): The number of messages to generate. Defaults to 5.

    Returns:
        list: A list of Message objects.
    """
    messages = []
    now = datetime.now()

    conversation = [
        {"role": "user", "content": "Hello, how are you?"},
        {"role": "assistant", "content": "I'm fine, thank you! How can I help you today?"},
        {"role": "user", "content": "What's the weather like?"},
        {
            "role": "assistant",
            "content": "I don't have access to real-time weather data, but I can help you find information about it.",
        },
        {"role": "user", "content": "Tell me a joke."},
        {
            "role": "assistant",
            "content": "Why did the chicken cross the road? To get to the other side!",
        },
        {"role": "user", "content": "What's the meaning of life?"},
        {
            "role": "assistant",
            "content": "The meaning of life is a deep philosophical question that has been debated for centuries. Some say it's 42!",
        },
        {"role": "user", "content": "Thank you for your help."},
        {
            "role": "assistant",
            "content": "You're welcome! Feel free to ask if you need anything else.",
        },
    ]

    session_id = str(uuid.uuid4())

    for i in range(min(count, len(conversation))):
        entry = conversation[i]
        message = Message(
            id=str(uuid.uuid4()),
            content=entry["content"],
            message_type=(MessageType.USER_TEXT if entry["role"] == "user" else MessageType.ASSISTANT),
            timestamp=now - timedelta(minutes=count - i),
            session_id=session_id,
        )
        messages.append(message)

    return messages


# Sample job data
def get_sample_jobs(count=3):
    """Get a list of sample jobs.

    Args:
        count (int, optional): The number of jobs to generate. Defaults to 3.

    Returns:
        list: A list of CronJob objects.
    """
    jobs = []
    now = datetime.now()

    for i in range(count):
        # All jobs are now CronJobs since Job class is no longer available
        job = CronJob(
            id=str(uuid.uuid4()),
            name=f"Test Cron Job {i}",
            schedule_type=ScheduleType.CRON if i % 2 == 1 else ScheduleType.ABSOLUTE,
            schedule_value=(f"{i} * * * *" if i % 2 == 1 else (now + timedelta(hours=i + 1)).isoformat()),
            next_run_time=now + timedelta(minutes=i + 10),
            callback_module="test_module",
            callback_function="test_function",
            status=JobStatus.PENDING,
        )
        jobs.append(job)

    return jobs


# Graph state data
def get_sample_graph_state():
    """Get a sample graph state.

    Returns:
        dict: A sample graph state object.
    """
    return {
        "messages": [
            {"role": "user", "content": "What can you do?"},
            {
                "role": "assistant",
                "content": (
                    "I'm an AI assistant that can help you with various tasks such as answering questions, "
                    "having conversations, and performing actions through tools."
                ),
            },
            {"role": "user", "content": "Can you help me set a reminder?"},
            {
                "role": "assistant",
                "content": ("I'd be happy to help you set a reminder. " "What would you like to be reminded about and when?"),
            },
        ]
    }


# Audio data
def get_sample_audio_data():
    """Get sample audio data.

    Returns:
        bytes: Sample audio data.
    """
    # Simple WAV header followed by silence
    return b"RIFF$\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x00\x04\x00\x00\x00\x04\x00\x00\x01\x00\x08\x00data\x00\x00\x00\x00"

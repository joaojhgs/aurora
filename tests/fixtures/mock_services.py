"""
Mock services for testing Aurora components.

This module provides mock implementations of various services that can be used in tests
to avoid external dependencies like LLMs, audio devices, and databases.
"""
import asyncio
import pytest
import pytest_asyncio
from unittest.mock import MagicMock, AsyncMock

# Mock LLM Service
class MockLLM:
    """Mock LLM service for testing."""
    
    def __init__(self, responses=None):
        """Initialize the mock LLM.
        
        Args:
            responses (dict, optional): A dictionary mapping input strings to response strings.
                If not provided, default responses will be used.
        """
        self.responses = responses or {
            "Hello": "Hi there! How can I help you today?",
            "What's the weather?": "I don't have access to real-time weather data, but I can help you find information about it.",
            "Tell me a joke": "Why did the chicken cross the road? To get to the other side!",
            "What time is it?": "I don't have access to the current time, but I can help you with other questions.",
        }
        self.history = []
    
    async def generate(self, prompt):
        """Generate a response for the given prompt.
        
        Args:
            prompt (str): The prompt to generate a response for.
        
        Returns:
            str: The generated response.
        """
        # Record the interaction
        self.history.append((prompt, None))
        
        # Check for exact matches
        if prompt in self.responses:
            response = self.responses[prompt]
            self.history[-1] = (prompt, response)
            return response
        
        # Check for substring matches
        for key, response in self.responses.items():
            if key.lower() in prompt.lower():
                self.history[-1] = (prompt, response)
                return response
        
        # Default response
        default = "I don't have a specific response for that, but I'm here to help."
        self.history[-1] = (prompt, default)
        return default


# Mock Audio Service
class MockAudioService:
    """Mock audio service for testing."""
    
    def __init__(self):
        """Initialize the mock audio service."""
        self.is_recording = False
        self.is_playing = False
        self.recording_data = b''
        self.playback_data = b''
        self.volume = 1.0
        self.callbacks = {}
    
    async def start_recording(self):
        """Start recording audio."""
        self.is_recording = True
        self.recording_data = b'mock audio data'
        if 'recording_started' in self.callbacks:
            await self.callbacks['recording_started']()
    
    async def stop_recording(self):
        """Stop recording audio and return the recorded data."""
        self.is_recording = False
        if 'recording_stopped' in self.callbacks:
            await self.callbacks['recording_stopped'](self.recording_data)
        return self.recording_data
    
    def play(self, audio_data):
        """Play the given audio data."""
        self.is_playing = True
        self.playback_data = audio_data
        # Simulate playback completion after a short delay
        asyncio.create_task(self._simulate_playback_completion())
    
    async def _simulate_playback_completion(self):
        """Simulate audio playback completion."""
        await asyncio.sleep(0.1)
        self.is_playing = False
        if 'playback_finished' in self.callbacks:
            await self.callbacks['playback_finished']()
    
    def pause(self):
        """Pause audio playback."""
        self.is_playing = False
    
    def resume(self):
        """Resume audio playback."""
        self.is_playing = True
    
    def set_volume(self, volume):
        """Set the audio volume."""
        self.volume = volume
    
    def get_volume(self):
        """Get the current audio volume."""
        return self.volume
    
    def register_callback(self, event, callback):
        """Register a callback for an audio event."""
        self.callbacks[event] = callback


# Mock Database Service
class MockDatabase:
    """Mock database service for testing."""
    
    def __init__(self):
        """Initialize the mock database."""
        self.messages = {}
        self.jobs = {}
        self.memories = {}
        self.migrations = []
    
    async def initialize(self):
        """Initialize the database."""
        pass
    
    async def close(self):
        """Close the database connection."""
        pass
    
    async def store_message(self, message):
        """Store a message in the database."""
        self.messages[message.id] = message
        return True
    
    async def get_message_by_id(self, message_id):
        """Get a message by ID."""
        return self.messages.get(message_id)
    
    async def get_recent_messages(self, limit=10):
        """Get the most recent messages."""
        return list(self.messages.values())[-limit:]
    
    async def update_message(self, message):
        """Update a message in the database."""
        if message.id in self.messages:
            self.messages[message.id] = message
            return True
        return False
    
    async def delete_message(self, message_id):
        """Delete a message from the database."""
        if message_id in self.messages:
            del self.messages[message_id]
            return True
        return False
    
    async def store_job(self, job):
        """Store a job in the database."""
        self.jobs[job.id] = job
        return True
    
    async def get_job_by_id(self, job_id):
        """Get a job by ID."""
        return self.jobs.get(job_id)
    
    async def update_job(self, job):
        """Update a job in the database."""
        if job.id in self.jobs:
            self.jobs[job.id] = job
            return True
        return False
    
    async def list_jobs(self, limit=100):
        """List all jobs in the database."""
        return list(self.jobs.values())[:limit]
    
    async def delete_job(self, job_id):
        """Delete a job from the database."""
        if job_id in self.jobs:
            del self.jobs[job_id]
            return True
        return False
    
    async def store_memory(self, key, value):
        """Store a memory in the database."""
        self.memories[key] = value
        return True
    
    async def get_memory(self, key):
        """Get a memory by key."""
        return self.memories.get(key)
    
    async def update_memory(self, key, value):
        """Update a memory in the database."""
        if key in self.memories:
            self.memories[key] = value
            return True
        return False
    
    async def delete_memory(self, key):
        """Delete a memory from the database."""
        if key in self.memories:
            del self.memories[key]
            return True
        return False

# Real-Time Ambient Transcription Feature

This document describes the real-time ambient transcription feature added to the AudioToTextRecorder class.

## Overview

The real-time ambient transcription feature enables continuous background transcription of audio using a priority queue system. It processes audio in real-time chunks while maintaining the normal wake word detection and assistant functionality. The system uses the same microphone stream and main transcription model as the assistant, ensuring efficient resource usage.

## Key Features

- **Real-Time Processing**: Continuously processes audio chunks instead of periodic batch transcription
- **Priority Queue System**: Assistant-triggered transcriptions have higher priority than ambient ones
- **Intelligent Pausing**: Ambient transcription pauses when wake words are detected for better assistant responsiveness
- **Shared Resources**: Uses the same microphone stream and transcription model as the assistant
- **Configurable Chunk Duration**: Adjustable processing frequency and filtering options
- **Non-intrusive**: Doesn't interfere with wake word detection or assistant functionality
- **Callback-based Storage**: Flexible storage mechanism through callbacks

## Configuration

### Basic Setup

```python
from app.speech_to_text.audio_recorder import AudioToTextRecorder

def handle_ambient_transcription(text, timestamp, chunk_id):
    """Handle ambient transcription results"""
    print(f"Ambient ({chunk_id}): {text}")

recorder = AudioToTextRecorder(
    # Regular configuration
    model="medium",
    language="en",
    
    # Real-time ambient transcription configuration
    enable_ambient_transcription=True,
    ambient_chunk_duration=3.0,  # Process every 3 seconds
    ambient_storage_path="ambient_logs/",  # Storage directory
    ambient_filter_short=True,  # Filter short transcriptions
    ambient_min_length=10,  # Minimum 10 characters
    on_ambient_transcription=handle_ambient_transcription,
)
```

### Configuration Parameters

- `enable_ambient_transcription` (bool, default=False): Enable/disable real-time ambient transcription
- `ambient_chunk_duration` (float, default=3.0): Seconds between audio chunk processing
- `ambient_storage_path` (str, default="ambient_logs/"): Directory for storing transcriptions
- `ambient_filter_short` (bool, default=True): Filter out short transcriptions
- `ambient_min_length` (int, default=10): Minimum characters for filtered transcriptions
- `on_ambient_transcription` (callable): Callback function for handling results

### Callback Function

The ambient transcription callback receives three parameters:
- `text` (str): The transcribed text
- `timestamp` (float): Unix timestamp when transcription was completed
- `chunk_id` (str): Unique identifier for the audio chunk

```python
def ambient_callback(text, timestamp, chunk_id):
    """
    Handle ambient transcription results
    
    Args:
        text (str): Transcribed text
        timestamp (float): Unix timestamp
        chunk_id (str): Unique chunk identifier
    """
    # Process the transcription
    pass
```

## Usage Examples

### File Storage

```python
import datetime
import os

def save_to_file(text, timestamp, chunk_id):
    """Save ambient transcription to daily file"""
    date_str = datetime.datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d")
    filename = f"ambient_{date_str}.txt"
    
    os.makedirs("ambient_logs", exist_ok=True)
    
    time_str = datetime.datetime.fromtimestamp(timestamp).strftime("%H:%M:%S")
    log_entry = f"[{time_str}] ({chunk_id}) {text}\n"
    
    with open(f"ambient_logs/{filename}", "a", encoding="utf-8") as f:
        f.write(log_entry)
```

### Database Storage

```python
import sqlite3
from datetime import datetime

def save_to_database(text, timestamp, chunk_id):
    """Save ambient transcription to database"""
    conn = sqlite3.connect("ambient_transcriptions.db")
    cursor = conn.cursor()
    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS ambient_transcriptions (
            id INTEGER PRIMARY KEY,
            text TEXT NOT NULL,
            timestamp REAL NOT NULL,
            datetime TEXT NOT NULL,
            chunk_id TEXT NOT NULL,
            length INTEGER NOT NULL
        )
    """)
    
    cursor.execute("""
        INSERT INTO ambient_transcriptions (text, timestamp, datetime, chunk_id, length)
        VALUES (?, ?, ?, ?, ?)
    """, (
        text,
        timestamp,
        datetime.fromtimestamp(timestamp).isoformat(),
        chunk_id,
        len(text)
    ))
    
    conn.commit()
    conn.close()
```

### Filtered Storage

```python
def filtered_callback(text, timestamp, chunk_id):
    """Filter and save meaningful transcriptions"""
    # Skip empty or very short transcriptions
    if not text or len(text.strip()) < 10:
        return
    
    # Skip background noise patterns
    noise_patterns = ["music playing", "noise", "silence", "background", "hmm", "uh"]
    text_lower = text.lower()
    if any(pattern in text_lower for pattern in noise_patterns):
        return
    
    # Skip repetitive text
    words = text.split()
    if len(words) > 1 and len(set(words)) == 1:
        return
    
    # Save meaningful transcriptions
    save_to_file(text, timestamp, chunk_id)
```

## Architecture

The real-time ambient transcription feature adds the following components:

1. **Priority Queue System**: Manages transcription requests with HIGH (assistant) and LOW (ambient) priorities
2. **Ambient Audio Buffer**: A rolling buffer that continuously collects audio data
3. **Ambient Worker Thread**: Continuously processes audio chunks and submits transcription requests
4. **Intelligent Pausing**: Pauses ambient requests when wake words are detected
5. **Shared Model Access**: Thread-safe access to the main transcription model through priority queue
6. **Callback System**: Flexible interface for handling transcription results

## Priority System

The system uses a priority queue with two levels:
- **HIGH Priority**: Assistant-triggered transcriptions (wake word detection, voice activity)
- **LOW Priority**: Ambient background transcriptions

When a wake word is detected:
1. Ambient transcription requests are paused
2. Assistant transcription gets immediate processing
3. Ambient transcription resumes after assistant request completes

## Performance Considerations

- **Shared Model**: Uses the same transcription model as the assistant to minimize memory usage
- **Thread Safety**: Proper locking ensures no conflicts between assistant and ambient transcription
- **Configurable Frequency**: Adjust chunk duration to balance between detail and performance
- **Non-blocking**: Ambient transcription doesn't block assistant functionality
- **Intelligent Filtering**: Built-in filtering reduces storage of noise and short utterances

## Configuration Recommendations

### For Real-Time Monitoring
```python
{
    "ambient_chunk_duration": 1.0,  # 1 second
    "ambient_filter_short": True,
    "ambient_min_length": 5,
}
```

### For Balanced Processing
```python
{
    "ambient_chunk_duration": 3.0,  # 3 seconds (default)
    "ambient_filter_short": True,
    "ambient_min_length": 10,
}
```

### For Reduced Processing Load
```python
{
    "ambient_chunk_duration": 10.0,  # 10 seconds
    "ambient_filter_short": True,
    "ambient_min_length": 15,
}
```

## Configuration Integration

The system integrates with the main application configuration:

```python
# In config.json
{
    "speech_to_text": {
        "ambient_transcription": {
            "enable": true,
            "chunk_duration": 3.0,
            "storage_path": "ambient_logs/",
            "filter_short_transcriptions": true,
            "min_transcription_length": 10
        }
    }
}
```

## Limitations

- Ambient transcription uses the same transcription model as the assistant
- Processing time depends on the configured chunk duration
- Storage depends on the provided callback implementation
- Performance impact increases with more frequent processing
- Ambient requests are paused during assistant interactions

## Example Implementation

See `examples/ambient_transcription_example.py` for a complete implementation example.
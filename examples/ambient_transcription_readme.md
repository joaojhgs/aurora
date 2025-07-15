# Ambient Transcription Feature

This document describes the ambient transcription feature added to the AudioToTextRecorder class.

## Overview

The ambient transcription feature enables continuous background transcription of audio for day summaries while maintaining the normal wake word detection and assistant functionality. It uses the same microphone stream and main transcription model as the assistant, ensuring efficient resource usage.

## Features

- **Continuous Background Transcription**: Transcribes ambient audio at regular intervals
- **Shared Resources**: Uses the same microphone stream and transcription model as the assistant
- **Configurable Intervals**: Adjustable transcription frequency and buffer duration
- **Non-intrusive**: Doesn't interfere with wake word detection or assistant functionality
- **Callback-based Storage**: Flexible storage mechanism through callbacks

## Configuration

### Basic Setup

```python
from app.speech_to_text.audio_recorder import AudioToTextRecorder

def handle_ambient_transcription(text, timestamp):
    """Handle ambient transcription results"""
    print(f"Ambient: {text}")

recorder = AudioToTextRecorder(
    # Regular configuration
    model="medium",
    language="en",
    
    # Ambient transcription configuration
    enable_ambient_transcription=True,
    ambient_transcription_interval=300,  # 5 minutes
    ambient_buffer_duration=30,  # 30 seconds
    on_ambient_transcription=handle_ambient_transcription,
)
```

### Configuration Parameters

- `enable_ambient_transcription` (bool, default=False): Enable/disable ambient transcription
- `ambient_transcription_interval` (float, default=300): Seconds between transcriptions
- `ambient_buffer_duration` (float, default=30): Seconds of audio to transcribe each time
- `on_ambient_transcription` (callable): Callback function for handling results

### Callback Function

The ambient transcription callback receives two parameters:
- `text` (str): The transcribed text
- `timestamp` (float): Unix timestamp when transcription was completed

```python
def ambient_callback(text, timestamp):
    """
    Handle ambient transcription results
    
    Args:
        text (str): Transcribed text
        timestamp (float): Unix timestamp
    """
    # Process the transcription
    pass
```

## Usage Examples

### File Storage

```python
import datetime
import os

def save_to_file(text, timestamp):
    """Save ambient transcription to daily file"""
    date_str = datetime.datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d")
    filename = f"ambient_{date_str}.txt"
    
    os.makedirs("ambient_logs", exist_ok=True)
    
    time_str = datetime.datetime.fromtimestamp(timestamp).strftime("%H:%M:%S")
    log_entry = f"[{time_str}] {text}\n"
    
    with open(f"ambient_logs/{filename}", "a", encoding="utf-8") as f:
        f.write(log_entry)
```

### Database Storage

```python
import sqlite3
from datetime import datetime

def save_to_database(text, timestamp):
    """Save ambient transcription to database"""
    conn = sqlite3.connect("ambient_transcriptions.db")
    cursor = conn.cursor()
    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS ambient_transcriptions (
            id INTEGER PRIMARY KEY,
            text TEXT NOT NULL,
            timestamp REAL NOT NULL,
            datetime TEXT NOT NULL,
            length INTEGER NOT NULL
        )
    """)
    
    cursor.execute("""
        INSERT INTO ambient_transcriptions (text, timestamp, datetime, length)
        VALUES (?, ?, ?, ?)
    """, (
        text,
        timestamp,
        datetime.fromtimestamp(timestamp).isoformat(),
        len(text)
    ))
    
    conn.commit()
    conn.close()
```

### Filtered Storage

```python
def filtered_callback(text, timestamp):
    """Filter and save meaningful transcriptions"""
    # Skip empty or very short transcriptions
    if not text or len(text.strip()) < 10:
        return
    
    # Skip background noise patterns
    noise_patterns = ["music playing", "noise", "silence", "background"]
    text_lower = text.lower()
    if any(pattern in text_lower for pattern in noise_patterns):
        return
    
    # Save meaningful transcriptions
    save_to_file(text, timestamp)
```

## Architecture

The ambient transcription feature adds the following components:

1. **Ambient Audio Buffer**: A rolling buffer that continuously collects audio data
2. **Ambient Worker Thread**: Periodically processes the buffer and requests transcriptions
3. **Shared Model Access**: Thread-safe access to the main transcription model
4. **Callback System**: Flexible interface for handling transcription results

## Performance Considerations

- **Shared Model**: Uses the same transcription model as the assistant to minimize memory usage
- **Thread Safety**: Proper locking ensures no conflicts between assistant and ambient transcription
- **Configurable Intervals**: Adjust frequency to balance between detail and performance
- **Non-blocking**: Ambient transcription doesn't block assistant functionality

## Configuration Recommendations

### For Detailed Monitoring
```python
{
    "ambient_transcription_interval": 30,  # 30 seconds
    "ambient_buffer_duration": 15,  # 15 seconds
}
```

### For Periodic Summaries
```python
{
    "ambient_transcription_interval": 300,  # 5 minutes
    "ambient_buffer_duration": 30,  # 30 seconds
}
```

### For Daily Overviews
```python
{
    "ambient_transcription_interval": 600,  # 10 minutes
    "ambient_buffer_duration": 60,  # 1 minute
}
```

## Limitations

- Ambient transcription uses the same transcription model as the assistant
- Processing time depends on the configured buffer duration
- Storage depends on the provided callback implementation
- Performance impact increases with more frequent transcriptions

## Example Implementation

See `examples/ambient_transcription_example.py` for a complete implementation example.
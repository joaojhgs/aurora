# Ambient Transcription Feature

## Overview

The ambient transcription feature enables continuous background audio transcription for day summaries while maintaining full compatibility with existing wake word detection and assistant functionality. It uses a real-time processing system with a priority queue to ensure assistant responsiveness.

## Key Features

### 🎯 Real-Time Processing
- **Continuous Processing**: Processes audio in real-time chunks instead of periodic batches
- **Priority Queue System**: Assistant-triggered transcriptions have higher priority than ambient ones
- **Intelligent Pausing**: Ambient transcription automatically pauses when wake words are detected
- **Configurable Intervals**: Adjustable chunk processing duration (default: 3 seconds)

### 🔄 Resource Efficiency
- **Shared Audio Stream**: Uses the same microphone input as wake word detection
- **Shared Model**: Uses the same faster_whisper model for both assistant and ambient transcription
- **Thread-Safe Access**: Priority queue system ensures proper resource management
- **Minimal Overhead**: No duplicate streams or models

### ⚙️ Configuration Options
- **Enable/Disable**: Toggle ambient transcription on/off
- **Chunk Duration**: Control how frequently audio is processed
- **Storage Path**: Configurable directory for storing transcriptions
- **Filtering**: Built-in filtering for short transcriptions and noise
- **Callback Interface**: Flexible storage mechanism through callbacks

## Configuration

### Basic Setup

```python
from app.speech_to_text.audio_recorder import AudioToTextRecorder

def handle_ambient_transcription(text, timestamp, chunk_id):
    """Handle ambient transcription results"""
    print(f"Ambient ({chunk_id}): {text}")

recorder = AudioToTextRecorder(
    # Regular STT configuration
    model="medium",
    language="en",
    wakeword_backend="oww",
    
    # Ambient transcription configuration
    enable_ambient_transcription=True,
    ambient_chunk_duration=3.0,  # Process every 3 seconds
    ambient_storage_path="ambient_logs/",
    ambient_filter_short=True,
    ambient_min_length=10,
    on_ambient_transcription=handle_ambient_transcription,
)
```

### Configuration Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enable_ambient_transcription` | bool | `False` | Enable/disable ambient transcription |
| `ambient_chunk_duration` | float | `3.0` | Seconds between audio chunk processing |
| `ambient_storage_path` | str | `"ambient_logs/"` | Directory for storing transcriptions |
| `ambient_filter_short` | bool | `True` | Filter out short transcriptions |
| `ambient_min_length` | int | `10` | Minimum characters for filtered transcriptions |
| `on_ambient_transcription` | callable | `None` | Callback function for handling results |

### Callback Function

The ambient transcription callback receives three parameters:

```python
def ambient_callback(text, timestamp, chunk_id):
    """
    Handle ambient transcription results
    
    Args:
        text (str): The transcribed text
        timestamp (float): Unix timestamp when transcription was completed
        chunk_id (str): Unique identifier for the audio chunk
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
    """Save ambient transcription to daily files"""
    date_str = datetime.datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d")
    filename = f"ambient_{date_str}.txt"
    
    os.makedirs("ambient_logs", exist_ok=True)
    
    time_str = datetime.datetime.fromtimestamp(timestamp).strftime("%H:%M:%S")
    log_entry = f"[{time_str}] ({chunk_id}) {text}\n"
    
    with open(f"ambient_logs/{filename}", "a", encoding="utf-8") as f:
        f.write(log_entry)
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

## Configuration Integration

### Main Application Configuration

The feature integrates with the main application configuration system:

```json
{
    "speech_to_text": {
        "ambient_transcription": {
            "enable": false,
            "chunk_duration": 3.0,
            "storage_path": "ambient_logs/",
            "filter_short_transcriptions": true,
            "min_transcription_length": 10
        }
    }
}
```

### Main.py Integration

```python
# In main.py
from app.config.config_manager import ConfigManager

config_manager = ConfigManager()
ambient_config = config_manager.get("speech_to_text.ambient_transcription", {})

def on_ambient_transcription(text, timestamp, chunk_id):
    """Handle ambient transcription results"""
    # Store for day summaries
    date_str = datetime.datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d")
    filename = f"ambient_logs/ambient_{date_str}.txt"
    
    os.makedirs("ambient_logs", exist_ok=True)
    
    time_str = datetime.datetime.fromtimestamp(timestamp).strftime("%H:%M:%S")
    log_entry = f"[{time_str}] ({chunk_id}) {text}\n"
    
    with open(filename, "a", encoding="utf-8") as f:
        f.write(log_entry)

with AudioToTextRecorder(
    # ... existing parameters ...
    
    # Ambient transcription from configuration
    enable_ambient_transcription=ambient_config.get("enable", False),
    ambient_chunk_duration=ambient_config.get("chunk_duration", 3.0),
    ambient_storage_path=ambient_config.get("storage_path", "ambient_logs/"),
    ambient_filter_short=ambient_config.get("filter_short_transcriptions", True),
    ambient_min_length=ambient_config.get("min_transcription_length", 10),
    on_ambient_transcription=on_ambient_transcription,
) as recorder:
    # ... rest of main.py code ...
```

## Architecture

The ambient transcription feature adds the following components:

### Priority Queue System
- **HIGH Priority**: Assistant-triggered transcriptions (wake word detection, voice activity)
- **LOW Priority**: Ambient background transcriptions
- **Queue Management**: Priority queue with stable ordering for equal priorities
- **Intelligent Pausing**: Ambient requests paused during assistant interactions

### Processing Pipeline
1. **Audio Input**: Shared microphone stream feeds both wake word detection and ambient buffer
2. **Ambient Worker**: Continuously processes audio chunks at configured intervals
3. **Priority Queue**: Manages transcription requests with appropriate priorities
4. **Transcription**: Shared faster_whisper model processes requests in priority order
5. **Callback**: Results delivered through callback interface for storage

### Thread Architecture
- **Main Thread**: Existing functionality unchanged
- **Audio Worker**: Processes audio for wake word detection and feeds ambient buffer
- **Ambient Worker**: Continuously processes audio chunks for transcription
- **Transcription Worker**: Enhanced with priority queue system for both assistant and ambient requests

## Performance Considerations

### Resource Usage
- **Shared Model**: Uses the same transcription model to minimize memory usage
- **Thread Safety**: Proper locking ensures no conflicts between assistant and ambient transcription
- **Efficient Buffering**: Rolling buffer prevents memory bloat
- **Priority Management**: Ensures assistant responsiveness

### Configuration Recommendations

#### For Real-Time Monitoring
```python
{
    "ambient_chunk_duration": 1.0,  # 1 second
    "ambient_filter_short": True,
    "ambient_min_length": 5,
}
```

#### For Balanced Processing (Default)
```python
{
    "ambient_chunk_duration": 3.0,  # 3 seconds
    "ambient_filter_short": True,
    "ambient_min_length": 10,
}
```

#### For Reduced Processing Load
```python
{
    "ambient_chunk_duration": 10.0,  # 10 seconds
    "ambient_filter_short": True,
    "ambient_min_length": 15,
}
```

## How It Works

1. **Initialization**: Ambient transcription is configured and enabled through parameters
2. **Audio Collection**: Shared audio stream feeds both wake word detection and ambient buffer
3. **Chunk Processing**: Ambient worker continuously processes audio chunks at configured intervals
4. **Priority Queue**: Transcription requests are queued with appropriate priorities
5. **Intelligent Pausing**: When wake words are detected, ambient requests are paused
6. **Transcription**: Shared model processes requests in priority order
7. **Callback**: Results are delivered through callback interface for storage

## Limitations

- Ambient transcription uses the same transcription model as the assistant
- Processing frequency is limited by the configured chunk duration
- Storage depends on the provided callback implementation
- Performance impact increases with more frequent processing
- Ambient requests are paused during assistant interactions

## Testing

The feature includes comprehensive testing:

- **Unit Tests**: Configuration validation, buffer management, callback patterns
- **Integration Tests**: Main application integration and performance validation
- **Priority Tests**: Verify priority queue behavior and pausing logic
- **Compatibility Tests**: Ensure existing STT functionality continues to work

## Troubleshooting

### Common Issues

1. **No ambient transcriptions**: Check that `enable_ambient_transcription=True` and callback is provided
2. **Too many transcriptions**: Increase `ambient_chunk_duration` or `ambient_min_length`
3. **Short transcriptions**: Adjust `ambient_filter_short` and `ambient_min_length`
4. **Performance issues**: Increase `ambient_chunk_duration` or disable feature temporarily

### Debug Mode

Enable debug logging to see ambient transcription activity:

```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

## Future Enhancements

- **Multiple Storage Backends**: Support for different storage systems
- **Advanced Filtering**: Machine learning-based noise filtering
- **Real-time Analysis**: Live sentiment analysis and keyword extraction
- **Multi-language Support**: Language-specific processing and storage
- **Cloud Integration**: Optional cloud storage and processing
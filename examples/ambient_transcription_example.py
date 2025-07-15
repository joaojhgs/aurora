"""
Example usage of the AudioToTextRecorder with real-time ambient transcription.

This example shows how to use the new real-time ambient transcription feature
to continuously transcribe background audio using a priority queue system while
maintaining the normal wake word detection and assistant functionality.
"""
import time
import datetime
import os
from pathlib import Path

# Example storage callback for ambient transcriptions
def save_ambient_transcription(text, timestamp, chunk_id):
    """
    Example callback for storing real-time ambient transcriptions.
    
    Args:
        text (str): The transcribed text
        timestamp (float): Unix timestamp when transcription was completed
        chunk_id (str): Unique identifier for the audio chunk
    """
    # Create filename with date
    date_str = datetime.datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d")
    filename = f"ambient_transcription_{date_str}.txt"
    
    # Create directory if it doesn't exist
    os.makedirs("ambient_logs", exist_ok=True)
    
    # Format the log entry
    time_str = datetime.datetime.fromtimestamp(timestamp).strftime("%H:%M:%S")
    log_entry = f"[{time_str}] ({chunk_id}) {text}\n"
    
    # Append to file
    with open(f"ambient_logs/{filename}", "a", encoding="utf-8") as f:
        f.write(log_entry)
    
    print(f"Ambient transcription saved: {text[:50]}...")

# Example usage
def main():
    """Main example function"""
    # Import here to avoid dependency issues in example
    from app.speech_to_text.audio_recorder import AudioToTextRecorder
    import torch
    
    # Configure ambient transcription
    def on_text_detected(text):
        """Handle regular speech-to-text results"""
        print(f"Assistant heard: {text}")
    
    print("Starting AudioToTextRecorder with real-time ambient transcription...")
    
    # Create recorder with ambient transcription enabled
    with AudioToTextRecorder(
        # Regular STT configuration
        model="medium",
        language="en",
        wakeword_backend="oww",
        wake_words_sensitivity=0.6,
        
        # Real-time ambient transcription configuration
        enable_ambient_transcription=True,
        ambient_chunk_duration=3.0,  # Process audio every 3 seconds
        ambient_storage_path="ambient_logs/",  # Directory for storage
        ambient_filter_short=True,  # Filter out short transcriptions
        ambient_min_length=10,  # Minimum 10 characters for transcription
        on_ambient_transcription=save_ambient_transcription,
        
        # Other settings
        device="cuda" if torch.cuda.is_available() else "cpu",
        spinner=True,
    ) as recorder:
        
        print("Recorder started. Say 'hey jarvis' to activate the assistant.")
        print("Ambient transcription will continuously process audio in 3-second chunks.")
        print("Ambient processing pauses when wake word is detected for better assistant responsiveness.")
        print("Press Ctrl+C to stop.")
        
        try:
            while True:
                # Process speech for the assistant
                text = recorder.text()
                if text:
                    on_text_detected(text)
                    
        except KeyboardInterrupt:
            print("\nStopping recorder...")

# Configuration examples
def example_configurations():
    """Show different ambient transcription configurations"""
    
    # Basic real-time ambient transcription (3 seconds)
    basic_config = {
        "enable_ambient_transcription": True,
        "ambient_chunk_duration": 3.0,  # 3 seconds
        "ambient_storage_path": "ambient_logs/",
        "ambient_filter_short": True,
        "ambient_min_length": 10,
        "on_ambient_transcription": save_ambient_transcription,
    }
    
    # Frequent real-time ambient transcription (1 second)
    frequent_config = {
        "enable_ambient_transcription": True,
        "ambient_chunk_duration": 1.0,  # 1 second
        "ambient_storage_path": "ambient_logs/",
        "ambient_filter_short": True,
        "ambient_min_length": 5,
        "on_ambient_transcription": save_ambient_transcription,
    }
    
    # Slower real-time ambient transcription (10 seconds)
    slower_config = {
        "enable_ambient_transcription": True,
        "ambient_chunk_duration": 10.0,  # 10 seconds
        "ambient_storage_path": "ambient_logs/",
        "ambient_filter_short": True,
        "ambient_min_length": 15,
        "on_ambient_transcription": save_ambient_transcription,
    }
    
    return {
        "basic": basic_config,
        "frequent": frequent_config,
        "slower": slower_config,
    }

# Advanced storage callback with filtering
def filtered_ambient_callback(text, timestamp, chunk_id):
    """
    Advanced ambient transcription callback with filtering.
    
    This example shows how to filter out unwanted content
    and only save meaningful transcriptions.
    """
    # Skip empty or very short transcriptions
    if not text or len(text.strip()) < 10:
        return
    
    # Skip if the text contains mostly background noise patterns
    noise_patterns = [
        "music playing",
        "noise",
        "silence",
        "background",
        "static",
        "hmm",
        "uh",
        "um",
    ]
    
    text_lower = text.lower()
    if any(pattern in text_lower for pattern in noise_patterns):
        return
    
    # Skip very repetitive text (single words repeated)
    words = text.split()
    if len(words) > 1 and len(set(words)) == 1:
        return
    
    # Save meaningful transcriptions
    save_ambient_transcription(text, timestamp, chunk_id)

# Database storage example
def database_storage_callback(text, timestamp, chunk_id):
    """
    Example callback that stores ambient transcriptions in a database.
    """
    # This would use your preferred database library
    # For example, with SQLite:
    
    import sqlite3
    from datetime import datetime
    
    # Connect to database
    conn = sqlite3.connect("ambient_transcriptions.db")
    cursor = conn.cursor()
    
    # Create table if it doesn't exist
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
    
    # Insert transcription
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
    
    print(f"Stored ambient transcription in database: {text[:50]}...")

if __name__ == "__main__":
    # Run the example
    main()
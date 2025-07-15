"""
Example usage of the AudioToTextRecorder with ambient transcription.

This example shows how to use the ambient transcription feature to continuously
transcribe background audio for day summaries while maintaining the normal
wake word detection and assistant functionality.
"""
import time
import datetime
import os
from pathlib import Path

# Example storage callback for ambient transcriptions
def save_ambient_transcription(text, timestamp):
    """
    Example callback for storing ambient transcriptions.
    
    Args:
        text (str): The transcribed text
        timestamp (float): Unix timestamp when transcription was completed
    """
    # Create filename with date
    date_str = datetime.datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d")
    filename = f"ambient_transcription_{date_str}.txt"
    
    # Create directory if it doesn't exist
    os.makedirs("ambient_logs", exist_ok=True)
    
    # Format the log entry
    time_str = datetime.datetime.fromtimestamp(timestamp).strftime("%H:%M:%S")
    log_entry = f"[{time_str}] {text}\n"
    
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
    
    print("Starting AudioToTextRecorder with ambient transcription...")
    
    # Create recorder with ambient transcription enabled
    with AudioToTextRecorder(
        # Regular STT configuration
        model="medium",
        language="en",
        wakeword_backend="oww",
        wake_words_sensitivity=0.6,
        
        # Ambient transcription configuration
        enable_ambient_transcription=True,
        ambient_transcription_interval=60,  # Transcribe every 60 seconds
        ambient_buffer_duration=30,  # Use 30 seconds of audio
        on_ambient_transcription=save_ambient_transcription,
        
        # Other settings
        device="cuda" if torch.cuda.is_available() else "cpu",
        spinner=True,
    ) as recorder:
        
        print("Recorder started. Say 'hey jarvis' to activate the assistant.")
        print("Ambient transcription will save background audio every 60 seconds.")
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
    
    # Basic ambient transcription (every 5 minutes)
    basic_config = {
        "enable_ambient_transcription": True,
        "ambient_transcription_interval": 300,  # 5 minutes
        "ambient_buffer_duration": 30,  # 30 seconds
        "on_ambient_transcription": save_ambient_transcription,
    }
    
    # Frequent ambient transcription (every 30 seconds)
    frequent_config = {
        "enable_ambient_transcription": True,
        "ambient_transcription_interval": 30,  # 30 seconds
        "ambient_buffer_duration": 15,  # 15 seconds
        "on_ambient_transcription": save_ambient_transcription,
    }
    
    # Long-form ambient transcription (every 10 minutes)
    longform_config = {
        "enable_ambient_transcription": True,
        "ambient_transcription_interval": 600,  # 10 minutes
        "ambient_buffer_duration": 60,  # 1 minute
        "on_ambient_transcription": save_ambient_transcription,
    }
    
    return {
        "basic": basic_config,
        "frequent": frequent_config,
        "longform": longform_config,
    }

# Advanced storage callback with filtering
def filtered_ambient_callback(text, timestamp):
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
    ]
    
    text_lower = text.lower()
    if any(pattern in text_lower for pattern in noise_patterns):
        return
    
    # Skip if the text is repetitive (same as last few entries)
    # This would require maintaining state between calls
    
    # Save meaningful transcriptions
    save_ambient_transcription(text, timestamp)

# Database storage example
def database_storage_callback(text, timestamp):
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
            length INTEGER NOT NULL
        )
    """)
    
    # Insert transcription
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
    
    print(f"Stored ambient transcription in database: {text[:50]}...")

if __name__ == "__main__":
    # Run the example
    main()
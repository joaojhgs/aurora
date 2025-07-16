import sys
import os
import datetime
from threading import Thread

from dotenv import load_dotenv

from app.config.config_manager import config_manager
from app.helpers.aurora_logger import log_debug, log_info, log_error
from app.helpers.getUseHardwareAcceleration import getUseHardwareAcceleration
from app.helpers.runAsyncInThread import run_async_in_thread

if __name__ == "__main__":
    log_info("Starting Aurora...")
    # Load environment variables
    # This is kept even with the new config manager to deal with development environments
    # And third party services that rely on environment variables, such as langsmith and OpenAi.

    load_dotenv()

    config_manager.migrate_from_env()

    window = None
    app = None

    # Check if the UI should be activated
    if config_manager.get("ui.activate"):
        from PyQt6.QtWidgets import QApplication

        from modules.ui.aurora_ui import AuroraUI

        # Create the UI application
        app = QApplication(sys.argv)
        window = AuroraUI()

        # Initialize the UI-STT-TTS hooks
        # This MUST happen before any TTS/STT operations
        log_info("Initializing UI hooks...")
        window.hook_into_systems()
        log_info("UI hooks initialized.")

    from app.langgraph.graph import stream_graph_updates
    from app.speech_to_text.audio_recorder import AudioToTextRecorder
    from app.speech_to_text.stt import (
        on_recording_start,
        on_recording_stop,
        on_wakeword_detected,
        on_wakeword_detection_start,
        on_wakeword_timeout,
    )
    from app.text_to_speech.tts import play

    # Initialize the scheduler system
    log_info("Initializing scheduler system...")
    import asyncio

    from app.scheduler import get_cron_service

    async def init_scheduler():
        """Initialize the scheduler service"""
        cron = get_cron_service()
        await cron.initialize()
        log_info("Scheduler system initialized and running.")

    # Start scheduler in background thread
    def start_scheduler():
        """Start the scheduler in its own event loop"""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(init_scheduler())
        # Keep the loop running for scheduled tasks
        try:
            loop.run_forever()
        except KeyboardInterrupt:
            pass
        finally:
            loop.close()

    scheduler_thread = Thread(target=start_scheduler, daemon=True)
    scheduler_thread.start()

    # Initial greeting
    play("Olá, meu nome é Jarvis")

    if config_manager.get("plugins.openrecall.activate"):
        from threading import Thread

        from modules.openrecall.openrecall.app import init_main as openrecall_app

        open_recall_thread = Thread(target=openrecall_app, daemon=True)
        open_recall_thread.start()

    def on_text_detected(text):
        log_debug(f">> STT detected: {text}")
        # Let the UI know this is coming from STT before sending to the LLM
        if window:
            window.process_stt_message(text)
        else:
            # Fallback if UI isn't initialized
            run_async_in_thread(stream_graph_updates(text))

    def on_ambient_transcription(text, timestamp, chunk_id):
        """Handle ambient transcription results"""
        try:
            # Get configuration
            ambient_config = config_manager.get("speech_to_text.ambient_transcription", {})
            storage_path = ambient_config.get("storage_path", "ambient_logs/")
            filter_short = ambient_config.get("filter_short_transcriptions", True)
            min_length = ambient_config.get("min_transcription_length", 10)

            # Apply filtering
            if filter_short and len(text.strip()) < min_length:
                return

            # Create storage directory if it doesn't exist
            os.makedirs(storage_path, exist_ok=True)

            # Save to daily log file
            date_str = datetime.datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d")
            time_str = datetime.datetime.fromtimestamp(timestamp).strftime("%H:%M:%S")

            log_file = os.path.join(storage_path, f"ambient_{date_str}.txt")

            with open(log_file, "a", encoding="utf-8") as f:
                f.write(f"[{time_str}] ({chunk_id}) {text}\n")

            log_debug(f"Ambient transcription saved: {text[:50]}...")

        except Exception as e:
            log_error(f"Error handling ambient transcription: {e}")

    # Create and start the audio recorder in a separate thread
    def start_recorder():
        log_info("Starting audio recorder...")

        # Get ambient transcription configuration
        ambient_config = config_manager.get("speech_to_text.ambient_transcription", {})

        with AudioToTextRecorder(
            wakeword_backend="oww",
            model="medium",
            language=config_manager.get("speech_to_text.language", ""),
            wake_words_sensitivity=0.35,
            openwakeword_model_paths="voice_models/jarvis.onnx",
            on_wakeword_detected=on_wakeword_detected,
            on_wakeword_timeout=on_wakeword_timeout,
            on_wakeword_detection_start=on_wakeword_detection_start,
            on_recording_start=on_recording_start,
            on_recording_stop=on_recording_stop,
            wake_word_buffer_duration=1,
            device=getUseHardwareAcceleration("stt"),
            silero_deactivity_detection=config_manager.get("speech_to_text.silero_deactivity_detection", False),
            openwakeword_speedx_noise_reduction=config_manager.get("speech_to_text.wakeword_speedx_noise_reduction", False),
            # No need for CLI STT indication if UI is activated
            spinner=not config_manager.get("ui.activate", False),

            # Ambient transcription configuration
            enable_ambient_transcription=ambient_config.get("enable", False),
            ambient_chunk_duration=ambient_config.get("chunk_duration", 3.0),
            ambient_storage_path=ambient_config.get("storage_path", "ambient_logs/"),
            ambient_filter_short=ambient_config.get("filter_short_transcriptions", True),
            ambient_min_length=ambient_config.get("min_transcription_length", 10),
            on_ambient_transcription=on_ambient_transcription,
        ) as recorder:

            while True:
                recorder.text(on_text_detected)

    # If the UI is activated, start the recorder in a separate thread and lock
    # the current one into the UI
    if window:
        # Start the recorder in a separate thread
        recorder_thread = Thread(target=start_recorder, daemon=True)
        recorder_thread.start()
        # Display the UI window
        window.show()
        # Start the UI event loop
        sys.exit(app.exec())
    else:
        # If the UI is not activated, just start the recorder in the main thread
        start_recorder()

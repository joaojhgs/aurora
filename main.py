from dotenv import load_dotenv
from app.config.config_manager import config_manager
from app.helpers.getUseCuda import getUseCuda

import os
import sys
from threading import Thread

from app.helpers.runAsyncInThread import run_async_in_thread

if __name__ == '__main__':
    print("Starting...")
    # Load environment variables
    # This is kept even with the new config manager to deal with development environments 
    # And third party services that rely on environment variables, such as langsmith and OpenAi.
    
    load_dotenv()
    
    config_manager.migrate_from_env()
    
    window = None
    app = None
    
    # Check if the UI should be activated
    if config_manager.get('ui.activate'):
        from modules.ui.aurora_ui import AuroraUI
        from PyQt6.QtWidgets import QApplication
        
        # Create the UI application
        app = QApplication(sys.argv)
        window = AuroraUI()

        # Initialize the UI-STT-TTS hooks
        # This MUST happen before any TTS/STT operations
        print("Initializing UI hooks...")
        window.hook_into_systems()
        print("UI hooks initialized.")
    
    from app.speech_to_text.audio_recorder import AudioToTextRecorder
    from app.speech_to_text.stt import on_recording_start, on_wakeword_detected, on_wakeword_timeout, on_wakeword_detection_start, on_recording_stop
    from app.text_to_speech.tts import play
    from app.langgraph.graph import stream_graph_updates
    
    # Initialize the scheduler system
    print("Initializing scheduler system...")
    from app.scheduler import get_cron_service
    import asyncio
    
    async def init_scheduler():
        """Initialize the scheduler service"""
        cron = get_cron_service()
        await cron.initialize()
        print("Scheduler system initialized and running.")
    
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
    
    if config_manager.get('plugins.openrecall.activate'):
        from modules.openrecall.openrecall.app import init_main as openrecall_app
        from threading import Thread
        open_recall_thread = Thread(target=openrecall_app, daemon=True)
        open_recall_thread.start()
        
    def on_text_detected(text):
        print(f">> STT detected: {text}")
        # Let the UI know this is coming from STT before sending to the LLM
        if window:
            window.process_stt_message(text)
        else:
            # Fallback if UI isn't initialized
            run_async_in_thread(stream_graph_updates(text))
    
    # Create and start the audio recorder in a separate thread
    def start_recorder():
        print("Starting audio recorder...")
        with AudioToTextRecorder(
            wakeword_backend="oww",
            model="medium",
            language=config_manager.get('speech_to_text.language', ''),
            wake_words_sensitivity=0.35,
            openwakeword_model_paths="app/voice_models/jarvis.onnx",
            on_wakeword_detected=on_wakeword_detected,
            on_wakeword_timeout=on_wakeword_timeout,
            on_wakeword_detection_start=on_wakeword_detection_start,
            on_recording_start=on_recording_start,
            on_recording_stop=on_recording_stop,
            wake_word_buffer_duration=1,
            device=getUseCuda("cuda.use_cuda_stt"),
            silero_deactivity_detection=config_manager.get('speech_to_text.silero_deactivity_detection', False),
            openwakeword_speedx_noise_reduction=config_manager.get('speech_to_text.wakeword_speedx_noise_reduction', False),
            ) as recorder:
            
            while True:
                recorder.text(on_text_detected)
    
    # If the UI is activated, start the recorder in a separate thread and lock the current one into the UI
    if(window):
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
from dotenv import load_dotenv
from modules.helpers.getUseCuda import getUseCuda

import os
import sys
from threading import Thread

if __name__ == '__main__':
    print("Starting...")
    # Make sure the OPENAI_API_KEY is set before importing modules that will use it
    load_dotenv()
    window = None
    app = None
    
    # Check if the environment variable is set to activate the UI
    if(os.environ['AURORA_UI_ACTIVATE'] == 'true'):
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
    
    from modules.speech_to_text.audio_recorder import AudioToTextRecorder
    from modules.speech_to_text.stt import on_recording_start, on_wakeword_detected, on_wakeword_timeout, on_wakeword_detection_start, on_recording_stop
    from modules.text_to_speech.tts import play
    from modules.langgraph.graph import stream_graph_updates
    
    # Initial greeting
    play("Olá, meu nome é Jarvis")
    
    if(os.environ['OPENRECALL_ACTIVATE_PLUGIN'] == 'true'):
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
            stream_graph_updates(text)
    
    # Create and start the audio recorder in a separate thread
    def start_recorder():
        print("Starting audio recorder...")
        with AudioToTextRecorder(
            wakeword_backend="oww",
            model="medium",
            language=os.getenv('STT_LANGUAGE') if os.getenv('STT_LANGUAGE') else '',
            wake_words_sensitivity=0.35,
            openwakeword_model_paths="modules/voice_models/jarvis.onnx",
            on_wakeword_detected=on_wakeword_detected,
            on_wakeword_timeout=on_wakeword_timeout,
            on_wakeword_detection_start=on_wakeword_detection_start,
            on_recording_start=on_recording_start,
            on_recording_stop=on_recording_stop,
            wake_word_buffer_duration=1,
            device=getUseCuda("USE_CUDA_STT"),
            silero_deactivity_detection=os.getenv('STT_SILERO_DEACTIVITY_DETECTION', 'false') == 'true',
            openwakeword_speedx_noise_reduction=os.getenv('STT_WAKEWORD_SPEEDX_NOISE_REDUCTION', 'false') == 'true',
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
from dotenv import load_dotenv
from modules.helpers.getUseCuda import getUseCuda

import os

if __name__ == '__main__':
    print("Starting...")
    # Make sure the OPENAI_API_KEY is set before importing modules that will use it
    load_dotenv()

    from modules.speech_to_text.audio_recorder import AudioToTextRecorder
    from modules.speech_to_text.stt import on_recording_start, on_wakeword_detected, on_wakeword_timeout, on_wakeword_detection_start, on_recording_stop
    from modules.text_to_speech.tts import play
    from modules.langgraph.graph import stream_graph_updates
    
    play("Meu nome é jarvis, como posso te ajudar?")
    
    if(os.environ['OPENRECALL_ACTIVATE_PLUGIN'] == 'true'):
        from modules.openrecall.openrecall.app import init_main as openrecall_app
        from threading import Thread
        open_recall_thread = Thread(target=openrecall_app, daemon=True)
        open_recall_thread.start()
        
    def on_text_detected(text):
        print(f">> {text}")
        # Send the transcribed text to the chatbot module
        stream_graph_updates(text)
        
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

        while (True):
            recorder.text(on_text_detected)
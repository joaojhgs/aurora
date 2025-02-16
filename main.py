from dotenv import load_dotenv
from modules.text_to_speech.tts import play

if __name__ == '__main__':
    print("Starting...")
    # Make sure the OPENAI_API_KEY is set before importing modules that will use it
    load_dotenv()
    from RealtimeSTT import AudioToTextRecorder
    from modules.langgraph.chatbot import stream_graph_updates
    play("Meu nome é jarvis, como posso te ajudar?")
    detected = False

    say_wakeword_str = "Listening for wakeword 'Jarvis'."

    def on_wakeword_detected():
        global detected
        detected = True
    
    def on_wakeword_timeout():
        global detected
        if not detected:
            print(f"Timeout. {say_wakeword_str}")
        detected = False

    def on_wakeword_detection_start():
        print(f"\n{say_wakeword_str}")

    def text_detected(text):
        print(f">> {text}")
        # Send the transcribed text to the chatbot module
        stream_graph_updates(text)
        
    with AudioToTextRecorder(
        wakeword_backend="oww",
        model="medium",
        language="pt",
        wake_words_sensitivity=0.35,
        openwakeword_model_paths="modules/voice_models/jarvis.onnx",
        on_wakeword_detected=on_wakeword_detected,
        on_wakeword_timeout=on_wakeword_timeout,
        on_wakeword_detection_start=on_wakeword_detection_start,
        wake_word_buffer_duration=1,
        ) as recorder:

        while (True):                
            recorder.text(text_detected)
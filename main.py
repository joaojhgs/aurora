import getpass
import os

def _set_env(var: str):
    if not os.environ.get(var):
        os.environ[var] = getpass.getpass(f"{var}: ")


if __name__ == '__main__':
    print("Starting...")

    # Make sure the OPENAI_API_KEY is set before importing modules that will use it
    _set_env("OPENAI_API_KEY")

    from RealtimeSTT import AudioToTextRecorder
    from modules.chatbot_graph import stream_graph_updates

    detected = False

    say_wakeword_str = "Listening for wakeword 'Jarvis'."

    def on_wakeword_detected():
        global detected
        detected = True

    def on_recording_stop():
        print ("Transcribing...")
    
    def on_wakeword_timeout():
        global detected
        if not detected:
            print(f"Timeout. {say_wakeword_str}")
        detected = False

    def on_wakeword_detection_start():
        print(f"\n{say_wakeword_str}")

    def on_recording_start():
        print ("Recording...")

    def on_vad_detect_start():
        print()
        print()

    def text_detected(text):
        print(f">> {text}")
        # Send the transcribed text to the chatbot module
        stream_graph_updates(text)
        
    with AudioToTextRecorder(
        spinner=False,
        wakeword_backend="oww",
        model="small",
        language="pt",
        wake_words_sensitivity=0.35,
        openwakeword_model_paths="modules/openwakeword/jarvis.onnx",
        on_wakeword_detected=on_wakeword_detected,
        on_recording_start=on_recording_start,
        on_recording_stop=on_recording_stop,
        on_wakeword_timeout=on_wakeword_timeout,
        on_wakeword_detection_start=on_wakeword_detection_start,
        on_vad_detect_start=on_vad_detect_start,
        wake_word_buffer_duration=1,
        ) as recorder:

        while (True):                
            recorder.text(text_detected)
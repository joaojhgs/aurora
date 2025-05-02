from RealtimeSTT import AudioToTextRecorder
from modules.text_to_speech.tts import pause, play
from modules.langgraph.graph import stream_graph_updates
from modules.helpers.getUseCuda import getUseCuda

import subprocess
import os

play("Meu nome é jarvis, como posso te ajudar?")

detected = False

say_wakeword_str = "Listening for wakeword 'Jarvis'."

def on_wakeword_detected():
    global detected
    detected = True
    pause()

def on_wakeword_timeout():
    global detected
    if not detected:
        print(f"Timeout. {say_wakeword_str}")
    detected = False

def on_wakeword_detection_start():
    print(f"\n{say_wakeword_str}")

def on_text_detected(text):
    print(f">> {text}")
    # Send the transcribed text to the chatbot module
    stream_graph_updates(text)

def check_bluetooth_headphones():
    try:
        result = subprocess.run(
            ["bluetoothctl", "info"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        return "Connected: yes" in result.stdout
    except Exception as e:
        print(f"Error checking Bluetooth headphones: {e}")
        return False

def set_system_volume(volume):
    try:
        cmd = "pactl set-sink-volume 0"
        subprocess.call(cmd.split() + [f"{volume}"])
    except Exception as e:
        print(f"Error setting system volume: {e}")

def on_recording_start():
    if not check_bluetooth_headphones():
        set_system_volume("-40%")

def on_recording_stop():
    if not check_bluetooth_headphones():
        set_system_volume("+40%")
import os
import subprocess

from app.helpers.aurora_logger import log_debug, log_error, log_info

detected = False

original_volume = None

say_wakeword_str = "Listening for wakeword 'Jarvis'."


def on_wakeword_detected():
    from app.text_to_speech.tts import pause

    global detected
    detected = True
    pause()


def on_wakeword_timeout():
    global detected
    if not detected:
        log_info(f"Timeout. {say_wakeword_str}")
    detected = False


def on_wakeword_detection_start():
    log_info(f"{say_wakeword_str}")


def check_bluetooth_headphones():
    try:
        result = subprocess.run(
            ["bluetoothctl", "info"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        return "Connected: yes" in result.stdout
    except Exception as e:
        log_error(f"Error checking Bluetooth headphones: {e}")
        return False


def get_system_volume():
    try:
        cmd = "pactl get-sink-volume 0"
        result = subprocess.run(cmd.split(), stdout=subprocess.PIPE, text=True)
        volume = result.stdout.split()[4]
        return volume
    except Exception as e:
        log_error(f"Error getting system volume: {e}")
        return None


def set_system_volume(volume):
    try:
        cmd = "pactl set-sink-volume 0"
        subprocess.call(cmd.split() + [f"{volume}"])
    except Exception as e:
        log_error(f"Error setting system volume: {e}")


def reduce_system_volume():
    if not check_bluetooth_headphones():
        global original_volume
        original_volume = get_system_volume()
        set_system_volume("-40%")


def restore_system_volume():
    if not check_bluetooth_headphones():
        set_system_volume(original_volume)


def on_recording_start():
    reduce_system_volume()


def on_recording_stop():
    restore_system_volume()


original_volumes = {}


def reduce_volume_except_current():
    global original_volumes
    try:
        pid = os.getpid()
        # Get full output without language-specific filtering
        cmd = "pactl list sink-inputs"
        result = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, text=True)
        output = result.stdout

        # Split the output by sink input sections
        # This works regardless of language as it relies on the structure of the output
        sink_sections = output.split("\n\n")
        original_volumes = {}

        # Process each sink section
        for section in sink_sections:
            if not section.strip():
                continue

            # Extract sink index using regex (works in any language)
            import re

            index_match = re.search(r"#(\d+)", section)
            if not index_match:
                continue

            sink_index = index_match.group(1)

            # Look for process ID in the section
            process_id = None
            pid_match = re.search(r'process\.id = "(\d+)"', section)
            if pid_match:
                process_id = pid_match.group(1)

            # Look for volume percentage in the section
            volume_match = re.search(r"(\d+)%", section)
            volume_percentage = None
            if volume_match:
                volume_percentage = f"{volume_match.group(1)}%"

            # If this is not our process and we found volume info, store and reduce it
            if process_id and volume_percentage and process_id != str(pid):
                original_volumes[sink_index] = volume_percentage
                # Reduce volume by 40%
                subprocess.run(["pactl", "set-sink-input-volume", sink_index, "-40%"])

    except Exception as e:
        log_error(f"Error reducing volume for other processes: {e}")


def restore_volume_except_current():
    global original_volumes
    try:
        # Restore the volume levels for all other processes
        for input_index, volume in original_volumes.items():
            subprocess.run(["pactl", "set-sink-input-volume", input_index, volume])
        original_volumes.clear()
    except Exception as e:
        log_error(f"Error restoring volume for other processes: {e}")

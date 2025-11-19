import os
import subprocess

from app.helpers.aurora_logger import log_error, log_info

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


async def check_bluetooth_headphones():
    try:
        import asyncio

        process = await asyncio.create_subprocess_exec("bluetoothctl", "info", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, _ = await process.communicate()
        return b"Connected: yes" in stdout
    except Exception as e:
        log_error(f"Error checking Bluetooth headphones: {e}")
        return False


async def get_system_volume():
    try:
        import asyncio

        process = await asyncio.create_subprocess_exec("pactl", "get-sink-volume", "0", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, _ = await process.communicate()
        volume = stdout.decode().split()[4]
        return volume
    except Exception as e:
        log_error(f"Error getting system volume: {e}")
        return None


async def set_system_volume(volume):
    try:
        import asyncio

        await asyncio.create_subprocess_exec("pactl", "set-sink-volume", "0", f"{volume}", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    except Exception as e:
        log_error(f"Error setting system volume: {e}")


async def reduce_system_volume():
    if not await check_bluetooth_headphones():
        global original_volume
        original_volume = await get_system_volume()
        await set_system_volume("-40%")


async def restore_system_volume():
    if not await check_bluetooth_headphones():
        await set_system_volume(original_volume)


def on_recording_start():
    # Note: These callbacks are called synchronously by the audio recording library
    # We'll keep the sync wrappers for compatibility
    import asyncio

    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.create_task(reduce_system_volume())
        else:
            asyncio.run(reduce_system_volume())
    except Exception as e:
        log_error(f"Error in on_recording_start: {e}")


def on_recording_stop():
    # Note: These callbacks are called synchronously by the audio recording library
    # We'll keep the sync wrappers for compatibility
    import asyncio

    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.create_task(restore_system_volume())
        else:
            asyncio.run(restore_system_volume())
    except Exception as e:
        log_error(f"Error in on_recording_stop: {e}")


original_volumes = {}


async def reduce_volume_except_current():
    global original_volumes
    try:
        import asyncio
        import re

        pid = os.getpid()
        # Get full output without language-specific filtering
        process = await asyncio.create_subprocess_shell("pactl list sink-inputs", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, _ = await process.communicate()
        output = stdout.decode()

        # Split the output by sink input sections
        # This works regardless of language as it relies on the structure of the output
        sink_sections = output.split("\n\n")
        original_volumes = {}

        # Process each sink section
        for section in sink_sections:
            if not section.strip():
                continue

            # Extract sink index using regex (works in any language)
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
                await asyncio.create_subprocess_exec("pactl", "set-sink-input-volume", sink_index, "-40%", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)

    except Exception as e:
        log_error(f"Error reducing volume for other processes: {e}")


async def restore_volume_except_current():
    try:
        import asyncio

        # Restore the volume levels for all other processes
        for input_index, volume in original_volumes.items():
            await asyncio.create_subprocess_exec("pactl", "set-sink-input-volume", input_index, volume, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        original_volumes.clear()
    except Exception as e:
        log_error(f"Error restoring volume for other processes: {e}")

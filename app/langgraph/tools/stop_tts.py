from langchain_core.tools import tool

from app.text_to_speech.tts import stop

@tool
def stop_tts_tool():
    """
    This tool should be used by the assistant whenever it thinks the user want's it to stop or interrupt current response from being spoken
    It will stop whatever previous answer was being played before, if one was being played
    Ex: "stop", "nevermind", "silence"
    """
    stop()
    return "END"
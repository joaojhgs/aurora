from langchain_core.tools import tool

from app.text_to_speech.tts import resume


@tool
def resume_tts_tool():
    """
    This tool should be used by the guide whenever it thinks the user called the assistant by mistake or has given up on making a new question
    It will resume whatever previous answer was being played before, if one was being played
    Ex: "continue", "resume"
    """
    resume()
    return "END"

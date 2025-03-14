from langchain_core.tools import tool
from modules.openrecall.openrecall.screenshot import record_current_screenshot

@tool
def current_screen_tool(
    input: str,
):
    """
    Screenshots all current monitors and returns the active app, title and OCR text from them
    Can be used by the LLM whenever it deems the user is asking for something related to what he is currently seeing on his screen
    Or if the LLM deems the current screen context can be usefull to answer a question
    """
    entries = record_current_screenshot()
    return entries
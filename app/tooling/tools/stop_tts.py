from langchain_core.tools import tool

from app.messaging.service_topics import TTSTopics
from app.tts.service import TTSStop


@tool
async def stop_tts_tool(bus):
    """
    This tool should be used by the assistant whenever it thinks the user want's it to stop or interrupt current response from being spoken.
    It will stop whatever previous answer was being played before, if one was being played.
    Ex: "stop", "nevermind", "silence"

    Args:
        bus: MessageBus instance for communication (injected by ToolingService)
    """
    await bus.publish(
        TTSTopics.STOP,
        TTSStop(),
        event=False,
        priority=0,  # Highest priority
        origin="internal",
    )
    return "END"

from langchain_core.tools import tool

from app.messaging import MessageBus
from app.messaging.service_topics import TTSTopics
from app.messaging.priority_helpers import get_interactive_priority
from app.tts.service import TTSResume


@tool
async def resume_tts_tool(bus: MessageBus):
    """
    This tool should be used by the assistant whenever it thinks the user called the assistant by mistake or has given up on making a new question.
    It will resume whatever previous answer was being played before, if one was being played.
    Ex: "continue", "resume"

    Args:
        bus: MessageBus instance for communication (injected by ToolingService)
    """
    await bus.publish(
        TTSTopics.RESUME,
        TTSResume(),
        event=False,
        priority=get_interactive_priority(),
        origin="internal",
    )
    return "END"

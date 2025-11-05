from langchain_core.tools import tool

from app.messaging import MessageBus
from app.messaging.priority_helpers import get_interactive_priority
from app.messaging.service_topics import TTSTopics
from app.shared.messaging.models.tts_models import TTSStop


@tool
async def stop_tts_tool(bus: MessageBus | None = None):
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
        priority=get_interactive_priority(),  # Highest priority for stop commands
        origin="internal",
    )
    return "END"

import asyncio
from datetime import datetime, timedelta
from typing import Any

from langchain_core.tools import tool

from app.helpers.aurora_logger import log_error
from app.messaging import MessageBus
from app.messaging.priority_helpers import get_interactive_priority
from app.services.scheduler.cron_service import get_cron_service
from app.shared.contracts.models.scheduler import (
    SchedulerMethods,
    SchedulerScheduleActionRequest,
    SchedulerToolBinding,
    SchedulerToolExecuteAction,
)
from app.shared.contracts.models.tooling import ToolingMethods
from app.shared.contracts.models.tts import TTSMethods

# Simple in-memory storage for current Pomodoro session
_current_session = {
    "active": False,
    "type": None,  # "work" or "break"
    "cycle": 0,
    "total_cycles": 0,
    "start_time": None,
}


def _format_absolute_time(target_time: datetime) -> str:
    """Format datetime for CronService absolute scheduling."""
    return target_time.replace(microsecond=0).strftime("%Y-%m-%d %H:%M:%S")


async def _schedule_pomodoro_transition(
    bus: MessageBus | None,
    *,
    name: str,
    absolute_time: str,
    transition: str,
) -> str | None:
    """Schedule the next Pomodoro transition through Scheduler.ScheduleAction."""

    if not bus:
        return None
    result = await bus.request(
        SchedulerMethods.SCHEDULE_ACTION,
        SchedulerScheduleActionRequest(
            name=name,
            schedule=absolute_time,
            action_spec=SchedulerToolExecuteAction(
                binding=SchedulerToolBinding(tool_name="pomodoro_transition_tool"),
                arguments={"transition": transition},
            ),
            source="tooling.pomodoro",
            privacy_class="personal",
        ),
        priority=get_interactive_priority(),
        origin="internal",
        timeout=10.0,
    )
    data = result.data if result.ok else None
    if hasattr(data, "model_dump"):
        data = data.model_dump(mode="json")
    if isinstance(data, dict):
        return data.get("job_id")
    return None


async def _publish_pomodoro_tts(bus: MessageBus | None, message: str) -> None:
    """Publish Pomodoro speech through the TTS bus contract."""

    if not bus:
        log_error("Bus not provided to pomodoro transition; cannot publish TTS")
        return
    from app.shared.contracts.models.tts import TTSMethods
    from app.shared.messaging.models.tts_models import TTSRequest

    await bus.publish(
        TTSMethods.REQUEST,
        TTSRequest(text=message, interrupt=False),
        event=False,
        priority=get_interactive_priority(),
        origin="internal",
    )


@tool
async def start_pomodoro_tool(
    bus: MessageBus | None = None,
    work_minutes: int = 25,
    short_break_minutes: int = 5,
    long_break_minutes: int = 15,
    cycles_before_long_break: int = 4,
) -> str:
    """
    Start a Pomodoro work session with customizable timings.

    Args:
        bus: MessageBus instance for communication (injected by ToolingService)
        work_minutes: Duration of work sessions (default: 25)
        short_break_minutes: Duration of short breaks (default: 5)
        long_break_minutes: Duration of long breaks (default: 15)
        cycles_before_long_break: Cycles before taking a long break (default: 4)

    Returns:
        Confirmation message with session details
    """
    try:
        if _current_session["active"]:
            return (
                "❌ A Pomodoro session is already active. Use stop_pomodoro_tool to end it first."
            )

        # Reset session state
        _current_session.update(
            {
                "active": True,
                "type": "work",
                "cycle": 1,
                "total_cycles": cycles_before_long_break,
                "start_time": datetime.now(),
                "work_minutes": work_minutes,
                "short_break_minutes": short_break_minutes,
                "long_break_minutes": long_break_minutes,
                "cycles_before_long_break": cycles_before_long_break,
            }
        )

        if not bus:
            return "❌ Message bus is required to schedule Pomodoro transitions."

        # Schedule the first work session end through typed Scheduler/Tooling action.
        work_end_time = (_current_session["start_time"] or datetime.now()) + timedelta(
            minutes=work_minutes
        )
        job_id = await _schedule_pomodoro_transition(
            bus,
            name="pomodoro_work_end",
            absolute_time=_format_absolute_time(work_end_time),
            transition="work_session_end",
        )
        if not job_id:
            _current_session.update(
                {"active": False, "type": None, "cycle": 0, "total_cycles": 0, "start_time": None}
            )
            return "❌ Failed to schedule the first Pomodoro transition."

        return f"🍅 Pomodoro started! Work session: {work_minutes} minutes (Cycle 1/{cycles_before_long_break})"

    except Exception as e:
        return f"❌ Error starting Pomodoro: {e}"


@tool
async def stop_pomodoro_tool(bus) -> str:
    """
    Stop the current Pomodoro session.

    Args:
        bus: MessageBus instance for communication (injected by ToolingService)

    Returns:
        Confirmation message with session summary
    """
    try:
        if not _current_session["active"]:
            return "ℹ️ No active Pomodoro session to stop."

        # Calculate session duration
        if _current_session["start_time"]:
            duration = datetime.now() - _current_session["start_time"]
            duration_str = str(duration).split(".")[0]  # Remove microseconds
        else:
            duration_str = "unknown"

        # Cancel any scheduled tasks
        cron = get_cron_service()
        jobs = await cron.get_all_jobs()
        for job in jobs:
            if job.name.startswith("pomodoro_"):
                await cron.scheduler_manager.delete_job(job.id)

        # Reset session
        cycle = _current_session.get("cycle", 0)
        session_type = _current_session.get("type", "work")
        _current_session.update(
            {"active": False, "type": None, "cycle": 0, "total_cycles": 0, "start_time": None}
        )

        return f"🛑 Pomodoro stopped. Last session: {session_type} (Cycle {cycle}), Duration: {duration_str}"

    except Exception as e:
        return f"❌ Error stopping Pomodoro: {e}"


@tool
async def pomodoro_status_tool(bus: MessageBus | None = None) -> str:
    """
    Get the current status of the Pomodoro session.

    Args:
        bus: MessageBus instance for communication (injected by ToolingService)

    Returns:
        Current session information
    """
    try:
        if not _current_session["active"]:
            return "ℹ️ No active Pomodoro session."

        session_type = _current_session.get("type", "unknown")
        cycle = _current_session.get("cycle", 0)
        total_cycles = _current_session.get("total_cycles", 0)
        start_time = _current_session.get("start_time")

        if start_time:
            elapsed = datetime.now() - start_time
            elapsed_str = str(elapsed).split(".")[0]  # Remove microseconds
        else:
            elapsed_str = "unknown"

        if session_type == "work":
            work_minutes = _current_session.get("work_minutes", 25)
            remaining = timedelta(minutes=work_minutes) - elapsed
            if remaining.total_seconds() > 0:
                remaining_str = str(remaining).split(".")[0]
                status_emoji = "🍅"
            else:
                remaining_str = "overdue"
                status_emoji = "⏰"
        else:  # break
            break_minutes = _current_session.get("short_break_minutes", 5)
            if cycle >= _current_session.get("cycles_before_long_break", 4):
                break_minutes = _current_session.get("long_break_minutes", 15)
            remaining = timedelta(minutes=break_minutes) - elapsed
            if remaining.total_seconds() > 0:
                remaining_str = str(remaining).split(".")[0]
                status_emoji = "☕"
            else:
                remaining_str = "overdue"
                status_emoji = "⏰"

        return f"""{status_emoji} Pomodoro Active
Session: {session_type.title()}
Cycle: {cycle}/{total_cycles}
Elapsed: {elapsed_str}
Remaining: {remaining_str}"""

    except Exception as e:
        return f"❌ Error getting status: {e}"


@tool
async def pomodoro_transition_tool(
    transition: str,
    bus: MessageBus | None = None,
) -> str:
    """Run a scheduled Pomodoro transition and schedule the next typed transition."""

    if transition == "work_session_end":
        result = await _work_session_end(bus)
    elif transition == "break_session_end":
        result = await _break_session_end(bus)
    else:
        result = {"success": False, "message": f"Unknown Pomodoro transition: {transition}"}
    return str(result.get("message") if isinstance(result, dict) else result)


async def _work_session_end(bus: MessageBus | None = None) -> dict[str, Any]:
    """Called when a work session ends."""
    try:
        if not _current_session["active"]:
            return {"success": False, "message": "No active session"}

        cycle = _current_session["cycle"]
        cycles_before_long_break = _current_session.get("cycles_before_long_break", 4)

        # Determine break type
        if cycle >= cycles_before_long_break:
            # Long break
            break_minutes = _current_session.get("long_break_minutes", 15)
            message = f"Trabalho concluído! Hora de uma pausa longa de {break_minutes} minutos. Você completou {cycle} ciclos!"
            _current_session.update(
                {
                    "type": "long_break",
                    "cycle": 1,  # Reset cycle after long break
                    "start_time": datetime.now(),
                }
            )
        else:
            # Short break
            break_minutes = _current_session.get("short_break_minutes", 5)
            message = f"Trabalho concluído! Hora de uma pausa de {break_minutes} minutos. Ciclo {cycle} de {cycles_before_long_break}."
            _current_session.update({"type": "short_break", "start_time": datetime.now()})

        await _publish_pomodoro_tts(bus, message)

        break_start = _current_session.get("start_time") or datetime.now()
        break_end_time = break_start + timedelta(minutes=break_minutes)
        await _schedule_pomodoro_transition(
            bus,
            name="pomodoro_break_end",
            absolute_time=_format_absolute_time(break_end_time),
            transition="break_session_end",
        )

        return {"success": True, "message": f"Work session {cycle} completed, break started"}

    except Exception as e:
        log_error(f"Error in work_session_end: {e}")
        return {"success": False, "message": str(e)}


async def _break_session_end(bus: MessageBus | None = None) -> dict[str, Any]:
    """Called when a break session ends."""
    try:
        if not _current_session["active"]:
            return {"success": False, "message": "No active session"}

        session_type = _current_session["type"]
        work_minutes = _current_session.get("work_minutes", 25)

        if session_type == "long_break":
            message = f"Pausa longa terminada! Vamos começar um novo ciclo. Trabalhe por {work_minutes} minutos!"
            _current_session.update({"type": "work", "cycle": 1, "start_time": datetime.now()})
        else:  # short_break
            cycle = _current_session["cycle"] + 1
            message = f"Pausa terminada! Hora de trabalhar novamente por {work_minutes} minutos. Ciclo {cycle}!"
            _current_session.update({"type": "work", "cycle": cycle, "start_time": datetime.now()})

        await _publish_pomodoro_tts(bus, message)

        work_start = _current_session.get("start_time") or datetime.now()
        work_end_time = work_start + timedelta(minutes=work_minutes)
        await _schedule_pomodoro_transition(
            bus,
            name="pomodoro_work_end",
            absolute_time=_format_absolute_time(work_end_time),
            transition="work_session_end",
        )

        return {"success": True, "message": "Break ended, work session started"}

    except Exception as e:
        log_error(f"Error in break_session_end: {e}")
        return {"success": False, "message": str(e)}


for _tts_pomodoro_tool in (start_pomodoro_tool, pomodoro_transition_tool):
    _tts_pomodoro_tool.metadata = {
        **(_tts_pomodoro_tool.metadata or {}),
        "required_permissions": [ToolingMethods.EXECUTE_TOOL, TTSMethods.REQUEST],
    }


# Legacy callback compatibility for existing rows only. New rows are created via
# typed Scheduler.ScheduleAction and execute pomodoro_transition_tool.
def work_session_end(**kwargs) -> dict[str, Any]:
    """Legacy callback wrapper for existing scheduler rows."""

    bus = kwargs.get("bus")
    return asyncio.run(_work_session_end(bus))


def break_session_end(**kwargs) -> dict[str, Any]:
    """Legacy callback wrapper for existing scheduler rows."""

    bus = kwargs.get("bus")
    return asyncio.run(_break_session_end(bus))

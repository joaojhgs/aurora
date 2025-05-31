import asyncio
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from langchain_core.tools import tool

from app.scheduler import get_cron_service
from app.helpers.aurora_logger import log_info, log_debug, log_error


# Simple in-memory storage for current Pomodoro session
_current_session = {
    "active": False,
    "type": None,  # "work" or "break"
    "cycle": 0,
    "total_cycles": 0,
    "start_time": None
}


@tool
async def start_pomodoro_tool(
    work_minutes: int = 25,
    short_break_minutes: int = 5,
    long_break_minutes: int = 15,
    cycles_before_long_break: int = 4
) -> str:
    """
    Start a Pomodoro work session with customizable timings.
    
    Args:
        work_minutes: Duration of work sessions (default: 25)
        short_break_minutes: Duration of short breaks (default: 5)
        long_break_minutes: Duration of long breaks (default: 15)
        cycles_before_long_break: Cycles before taking a long break (default: 4)
    
    Returns:
        Confirmation message with session details
    """
    try:
        if _current_session["active"]:
            return "❌ A Pomodoro session is already active. Use stop_pomodoro_tool to end it first."
        
        # Reset session state
        _current_session.update({
            "active": True,
            "type": "work",
            "cycle": 1,
            "total_cycles": cycles_before_long_break,
            "start_time": datetime.now(),
            "work_minutes": work_minutes,
            "short_break_minutes": short_break_minutes,
            "long_break_minutes": long_break_minutes,
            "cycles_before_long_break": cycles_before_long_break
        })
        
        # Schedule the first work session end
        cron = get_cron_service()
        await cron.schedule_from_text(
            name="pomodoro_work_end",
            schedule_text=f"in {work_minutes} minutes",
            callback="app.langgraph.tools.pomodoro_tool.work_session_end",
            callback_args={}
        )
        
        return f"🍅 Pomodoro started! Work session: {work_minutes} minutes (Cycle 1/{cycles_before_long_break})"
        
    except Exception as e:
        return f"❌ Error starting Pomodoro: {e}"


@tool
async def stop_pomodoro_tool() -> str:
    """
    Stop the current Pomodoro session.
    
    Returns:
        Confirmation message with session summary
    """
    try:
        if not _current_session["active"]:
            return "ℹ️ No active Pomodoro session to stop."
        
        # Calculate session duration
        if _current_session["start_time"]:
            duration = datetime.now() - _current_session["start_time"]
            duration_str = str(duration).split('.')[0]  # Remove microseconds
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
        _current_session.update({
            "active": False,
            "type": None,
            "cycle": 0,
            "total_cycles": 0,
            "start_time": None
        })
        
        return f"🛑 Pomodoro stopped. Last session: {session_type} (Cycle {cycle}), Duration: {duration_str}"
        
    except Exception as e:
        return f"❌ Error stopping Pomodoro: {e}"


@tool
async def pomodoro_status_tool() -> str:
    """
    Get the current status of the Pomodoro session.
    
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
            elapsed_str = str(elapsed).split('.')[0]  # Remove microseconds
        else:
            elapsed_str = "unknown"
        
        if session_type == "work":
            work_minutes = _current_session.get("work_minutes", 25)
            remaining = timedelta(minutes=work_minutes) - elapsed
            if remaining.total_seconds() > 0:
                remaining_str = str(remaining).split('.')[0]
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
                remaining_str = str(remaining).split('.')[0]
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


# Callback functions for scheduler
def work_session_end(**kwargs) -> Dict[str, Any]:
    """Called when a work session ends"""
    try:
        if not _current_session["active"]:
            return {"success": False, "message": "No active session"}
        
        from app.text_to_speech.tts import play
        
        cycle = _current_session["cycle"]
        total_cycles = _current_session["total_cycles"]
        cycles_before_long_break = _current_session.get("cycles_before_long_break", 4)
        
        # Determine break type
        if cycle >= cycles_before_long_break:
            # Long break
            break_minutes = _current_session.get("long_break_minutes", 15)
            play(f"Trabalho concluído! Hora de uma pausa longa de {break_minutes} minutos. Você completou {cycle} ciclos!")
            _current_session.update({
                "type": "long_break",
                "cycle": 1,  # Reset cycle after long break
                "start_time": datetime.now()
            })
        else:
            # Short break
            break_minutes = _current_session.get("short_break_minutes", 5)
            play(f"Trabalho concluído! Hora de uma pausa de {break_minutes} minutos. Ciclo {cycle} de {cycles_before_long_break}.")
            _current_session.update({
                "type": "short_break",
                "start_time": datetime.now()
            })
        
        # Schedule break end
        async def schedule_break_end():
            cron = get_cron_service()
            await cron.schedule_from_text(
                name="pomodoro_break_end",
                schedule_text=f"in {break_minutes} minutes",
                callback="app.langgraph.tools.pomodoro_tool.break_session_end",
                callback_args={}
            )
        
        # Run async scheduling in background
        import threading
        def run_async():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(schedule_break_end())
            loop.close()
        
        thread = threading.Thread(target=run_async)
        thread.daemon = True
        thread.start()
        
        return {
            "success": True,
            "message": f"Work session {cycle} completed, break started"
        }
        
    except Exception as e:
        log_error(f"Error in work_session_end: {e}")
        return {"success": False, "message": str(e)}


def break_session_end(**kwargs) -> Dict[str, Any]:
    """Called when a break session ends"""
    try:
        if not _current_session["active"]:
            return {"success": False, "message": "No active session"}
        
        from app.text_to_speech.tts import play
        
        session_type = _current_session["type"]
        work_minutes = _current_session.get("work_minutes", 25)
        
        if session_type == "long_break":
            play(f"Pausa longa terminada! Vamos começar um novo ciclo. Trabalhe por {work_minutes} minutos!")
            _current_session.update({
                "type": "work",
                "cycle": 1,
                "start_time": datetime.now()
            })
        else:  # short_break
            cycle = _current_session["cycle"] + 1
            play(f"Pausa terminada! Hora de trabalhar novamente por {work_minutes} minutos. Ciclo {cycle}!")
            _current_session.update({
                "type": "work",
                "cycle": cycle,
                "start_time": datetime.now()
            })
        
        # Schedule next work session end
        async def schedule_work_end():
            cron = get_cron_service()
            await cron.schedule_from_text(
                name="pomodoro_work_end",
                schedule_text=f"in {work_minutes} minutes",
                callback="app.langgraph.tools.pomodoro_tool.work_session_end",
                callback_args={}
            )
        
        # Run async scheduling in background
        import threading
        def run_async():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(schedule_work_end())
            loop.close()
        
        thread = threading.Thread(target=run_async)
        thread.daemon = True
        thread.start()
        
        return {
            "success": True,
            "message": f"Break ended, work session started"
        }
        
    except Exception as e:
        log_error(f"Error in break_session_end: {e}")
        return {"success": False, "message": str(e)}

import asyncio
import random
from datetime import datetime
from typing import Any, Optional

from langchain_core.tools import tool

from app.helpers.aurora_logger import log_error, log_info
from app.messaging import MessageBus
from app.messaging.priority_helpers import get_interactive_priority
from app.scheduler import get_cron_service


@tool()
async def schedule_task_tool(task_name: str, schedule_time: str, action: str, bus: MessageBus, message: Optional[str] = None, **kwargs) -> str:
    """
    Schedule a task to be executed at a specified time.

    IMPORTANT: The schedule_time parameter accepts ONLY two formats:
    1. Absolute time (one-time execution): "YYYY-MM-DD HH:MM" or "DD/MM/YYYY HH:MM"
       Examples: "2025-10-31 15:30", "31/10/2025 14:00"

    2. Cron expression (recurring): Standard 5-field format "minute hour day month weekday"
       Format: minute (0-59) hour (0-23) day (1-31) month (1-12) weekday (0-6, where 0=Sunday)
       Special characters: * (any), / (step), - (range), , (list)

       Common cron examples:
       - "0 9 * * *" = Daily at 9:00 AM
       - "0 9 * * 1-5" = Weekdays (Mon-Fri) at 9:00 AM
       - "0 */2 * * *" = Every 2 hours
       - "30 14 * * 0" = Every Sunday at 2:30 PM
       - "0 9 1 * *" = First day of every month at 9:00 AM
       - "*/15 * * * *" = Every 15 minutes

    Args:
        task_name: A descriptive name for the scheduled task
        schedule_time: Either absolute time ("YYYY-MM-DD HH:MM" or "DD/MM/YYYY HH:MM") or cron expression ("minute hour day month weekday")
        action: The action to perform. Available actions:
            - "speak" or "say": Make the assistant speak the message
            - "reminder": Send a reminder notification (speaks the message)
            - "greeting": Daily motivational greeting (random message)
            - "break_reminder": Remind to take a break
            - "water_reminder": Remind to drink water
            - "motivational": Deliver a motivational message
            - "time_announcement": Announce the current time
            - "callback": Call a custom function (advanced usage)
        bus: MessageBus instance for communication (injected by ToolingService)
        message: The message to speak or remind about (optional for some actions like "greeting", "break_reminder")
        **kwargs: Additional arguments for the action

    Returns:
        Confirmation message with job ID if successful

    Examples:
        # Absolute time (one-time execution)
        schedule_task_tool("meeting reminder", "2025-10-31 15:30", "speak", "Team meeting starts now")
        schedule_task_tool("doctor appointment", "31/10/2025 14:00", "reminder", "Time for your doctor appointment")

        # Cron expressions (recurring)
        schedule_task_tool("daily motivation", "0 9 * * *", "greeting")  # Daily at 9am
        schedule_task_tool("hourly break", "0 * * * *", "break_reminder")  # Every hour
        schedule_task_tool("weekday water", "0 */2 * * 1-5", "water_reminder")  # Every 2 hours on weekdays
        schedule_task_tool("weekly report", "0 8 * * 1", "speak", "Time for weekly report")  # Every Monday at 8am
        schedule_task_tool("15min check", "*/15 * * * *", "time_announcement")  # Every 15 minutes
    """
    try:
        # Get the scheduler service
        cron = get_cron_service()

        # Determine callback and arguments based on action
        callback, callback_args = _get_callback_for_action(action, message, **kwargs)

        if not callback:
            available_actions = [
                "speak",
                "say",
                "reminder",
                "greeting",
                "daily_greeting",
                "break_reminder",
                "water_reminder",
                "motivational",
                "motivational_message",
                "time_announcement",
                "hourly_time_announcement",
                "callback",
            ]
            return f"Error: Unknown action '{action}'. Available actions: {', '.join(available_actions)}"

        # Schedule the task using the text parser
        job_id = await cron.schedule_from_text(
            name=task_name,
            schedule_text=schedule_time,
            callback=callback,
            callback_args=callback_args,
        )

        if job_id:
            return f"Task '{task_name}' scheduled successfully (ID: {job_id[:8]}...) for: {schedule_time}"
        else:
            return f"Failed to schedule task '{task_name}'. Please check the schedule format."

    except Exception as e:
        return f"Error scheduling task: {e}"


@tool
async def list_scheduled_tasks_tool(bus: MessageBus) -> str:
    """
    List all currently scheduled tasks.

    Args:
        bus: MessageBus instance for communication (injected by ToolingService)

    Returns:
        A formatted list of all active scheduled tasks
    """
    try:
        cron = get_cron_service()
        jobs = await cron.get_all_jobs()

        if not jobs:
            return "No scheduled tasks found."

        active_jobs = [job for job in jobs if job.is_active]

        if not active_jobs:
            return "No active scheduled tasks found."

        result = f"Found {len(active_jobs)} active scheduled tasks:\n\n"

        for job in active_jobs:
            status_emoji = {
                "pending": "⏳",
                "running": "🔄",
                "completed": "✅",
                "failed": "❌",
                "cancelled": "🚫",
            }.get(job.status.value, "❓")

            next_run = job.next_run_time.strftime("%Y-%m-%d %H:%M:%S") if job.next_run_time else "Not scheduled"

            result += f"{status_emoji} **{job.name}**\n"
            result += f"   ID: {job.id[:8]}...\n"
            result += f"   Type: {job.schedule_type.value}\n"
            result += f"   Schedule: {job.schedule_value}\n"
            result += f"   Next run: {next_run}\n"
            result += f"   Status: {job.status.value}\n\n"

        return result

    except Exception as e:
        return f"Error listing scheduled tasks: {e}"


@tool
async def cancel_scheduled_task_tool(task_identifier: str, bus: MessageBus) -> str:
    """
    Cancel a scheduled task by name or ID.

    Args:
        task_identifier: Either the task name or job ID (first 8 characters are sufficient)
        bus: MessageBus instance for communication (injected by ToolingService)

    Returns:
        Confirmation message
    """
    try:
        cron = get_cron_service()
        jobs = await cron.get_all_jobs()

        # Find job by name or ID
        target_job = None
        for job in jobs:
            if job.name.lower() == task_identifier.lower() or job.id.startswith(task_identifier) or job.id == task_identifier:
                target_job = job
                break

        if not target_job:
            return f"Task '{task_identifier}' not found. Use list_scheduled_tasks_tool to see available tasks."

        # Cancel the job
        success = await cron.scheduler_manager.delete_job(target_job.id)

        if success:
            return f"Task '{target_job.name}' (ID: {target_job.id[:8]}...) has been cancelled."
        else:
            return f"Failed to cancel task '{target_job.name}'. It may have already completed or been cancelled."

    except Exception as e:
        return f"Error cancelling task: {e}"


# Assistant-specific callbacks for scheduled tasks
async def speak_reminder(bus: MessageBus, **kwargs) -> dict[str, Any]:
    """
    Make the assistant speak a message.
    This is the primary callback for speech reminders.

    Args:
        bus: MessageBus instance (injected by scheduler_manager)
        **kwargs: Additional arguments including job_name, message, etc.
    """
    try:
        if not bus:
            log_error("Bus not provided to callback - cannot speak reminder")
            return {"success": False, "message": "Bus not available"}

        job_name = kwargs.get("job_name", "unknown")
        text = kwargs.get("text", "")
        message = kwargs.get("message", text)  # Support both 'text' and 'message' parameters

        if not message:
            message = f"This is a scheduled reminder: {job_name}"

        log_info(f"Speaking reminder: {message}")

        # Use bus to send TTS request
        from app.messaging import TTSTopics
        from app.tts import TTSRequest

        await bus.publish(
            TTSTopics.REQUEST,
            TTSRequest(text=message, interrupt=False),
            event=False,
            priority=get_interactive_priority(),
            origin="system",
        )

        return {"success": True, "message": f'Spoke reminder: "{message}"', "spoken_text": message}

    except Exception as e:
        log_error(f"Error in speak_reminder: {e}", exc_info=True)
        return {"success": False, "message": f"Failed to speak reminder: {e}"}


async def daily_greeting(bus: MessageBus, **kwargs) -> dict[str, Any]:
    """
    A daily greeting that can be scheduled.

    Args:
        bus: MessageBus instance (injected by scheduler_manager)
        **kwargs: Additional arguments
    """
    try:
        if not bus:
            log_error("Bus not provided to callback - cannot deliver greeting")
            return {"success": False, "message": "Bus not available"}

        greetings = [
            "Good morning! Hope you have a wonderful day ahead!",
            "Buenos días! Ready to tackle today's challenges?",
            "Good morning! Remember to take breaks and stay hydrated!",
            "Rise and shine! It's going to be a great day!",
            "Good morning! What amazing things will you accomplish today?",
        ]

        greeting = random.choice(greetings)

        log_info(f"Daily greeting: {greeting}")

        from app.messaging import TTSTopics
        from app.tts import TTSRequest

        await bus.publish(
            TTSTopics.REQUEST,
            TTSRequest(text=greeting, interrupt=False),
            event=False,
            priority=get_interactive_priority(),
            origin="system",
        )

        return {
            "success": True,
            "message": f'Daily greeting delivered: "{greeting}"',
            "spoken_text": greeting,
        }

    except Exception as e:
        log_error(f"Error in daily_greeting: {e}", exc_info=True)
        return {"success": False, "message": f"Failed to deliver daily greeting: {e}"}


async def hourly_time_announcement(bus: MessageBus, **kwargs) -> dict[str, Any]:
    """
    Announce the current time (useful for hourly reminders).

    Args:
        bus: MessageBus instance (injected by scheduler_manager)
        **kwargs: Additional arguments
    """
    try:
        if not bus:
            log_error("Bus not provided to callback - cannot announce time")
            return {"success": False, "message": "Bus not available"}

        now = datetime.now()
        time_str = now.strftime("%I:%M %p")

        message = f"The time is now {time_str}"

        log_info(f"Time announcement: {message}")

        from app.messaging import TTSTopics
        from app.tts import TTSRequest

        await bus.publish(
            TTSTopics.REQUEST,
            TTSRequest(text=message, interrupt=False),
            event=False,
            priority=get_interactive_priority(),
            origin="system",
        )

        return {"success": True, "message": f"Time announced: {time_str}", "spoken_text": message}

    except Exception as e:
        log_error(f"Error in hourly_time_announcement: {e}")
        return {"success": False, "message": f"Failed to announce time: {e}"}


async def break_reminder(bus: MessageBus, **kwargs) -> dict[str, Any]:
    """
    Remind the user to take a break.

    Args:
        bus: MessageBus instance (injected by scheduler_manager)
        **kwargs: Additional arguments including message
    """
    try:
        if not bus:
            log_error("Bus not provided to callback - cannot deliver break reminder")
            return {"success": False, "message": "Bus not available"}

        reminders = [
            "Time for a break! Step away from the screen and stretch a bit.",
            "Break time! Don't forget to rest your eyes and move around.",
            "You've been working hard! Time to take a breather.",
            "Reminder: It's important to take regular breaks. Stand up and stretch!",
            "Break time! Grab some water and give your mind a rest.",
        ]

        reminder = kwargs.get("message", random.choice(reminders))

        log_info(f"Break reminder: {reminder}")

        from app.messaging import TTSTopics
        from app.tts import TTSRequest

        await bus.publish(
            TTSTopics.REQUEST,
            TTSRequest(text=reminder, interrupt=False),
            event=False,
            priority=get_interactive_priority(),
            origin="system",
        )

        return {
            "success": True,
            "message": f'Break reminder delivered: "{reminder}"',
            "spoken_text": reminder,
        }

    except Exception as e:
        log_error(f"Error in break_reminder: {e}")
        return {"success": False, "message": f"Failed to deliver break reminder: {e}"}


async def water_reminder(bus: MessageBus, **kwargs) -> dict[str, Any]:
    """
    Remind the user to drink water.

    Args:
        bus: MessageBus instance (injected by scheduler_manager)
        **kwargs: Additional arguments including message
    """
    try:
        if not bus:
            log_error("Bus not provided to callback - cannot deliver water reminder")
            return {"success": False, "message": "Bus not available"}

        reminders = [
            "Don't forget to stay hydrated! Time for some water.",
            "Hydration check! Have you had enough water today?",
            "Your body needs water! Take a moment to hydrate.",
            "Water break! Remember, staying hydrated is important for your health.",
            "Time to drink some water! Your brain will thank you.",
        ]

        reminder = kwargs.get("message", random.choice(reminders))

        log_info(f"Water reminder: {reminder}")

        from app.messaging import TTSTopics
        from app.tts import TTSRequest

        await bus.publish(
            TTSTopics.REQUEST,
            TTSRequest(text=reminder, interrupt=False),
            event=False,
            priority=get_interactive_priority(),
            origin="system",
        )

        return {
            "success": True,
            "message": f'Water reminder delivered: "{reminder}"',
            "spoken_text": reminder,
        }

    except Exception as e:
        log_error(f"Error in water_reminder: {e}")
        return {"success": False, "message": f"Failed to deliver water reminder: {e}"}


async def motivational_message(bus: MessageBus, **kwargs) -> dict[str, Any]:
    """
    Deliver a motivational message.

    Args:
        bus: MessageBus instance (injected by scheduler_manager)
        **kwargs: Additional arguments including message
    """
    try:
        if not bus:
            log_error("Bus not provided to callback - cannot deliver motivational message")
            return {"success": False, "message": "Bus not available"}

        messages = [
            "You're doing great! Keep up the excellent work!",
            "Believe in yourself! You have the power to achieve amazing things!",
            "Every small step counts. You're making progress!",
            "You're stronger than you think and more capable than you imagine!",
            "Today is full of possibilities. Make it count!",
            "Your hard work is paying off. Keep pushing forward!",
            "You've overcome challenges before, and you'll overcome this one too!",
        ]

        message = kwargs.get("message", random.choice(messages))

        log_info(f"Motivational message: {message}")

        from app.messaging import TTSTopics
        from app.tts import TTSRequest

        await bus.publish(
            TTSTopics.REQUEST,
            TTSRequest(text=message, interrupt=False),
            event=False,
            priority=get_interactive_priority(),
            origin="system",
        )

        return {
            "success": True,
            "message": f'Motivational message delivered: "{message}"',
            "spoken_text": message,
        }

    except Exception as e:
        log_error(f"Error in motivational_message: {e}")
        return {"success": False, "message": f"Failed to deliver motivational message: {e}"}


def _get_callback_for_action(action: str, message: str = None, **kwargs) -> tuple[str, dict[str, Any]]:
    """
    Get the appropriate callback function and arguments for the given action.

    Returns:
        Tuple of (callback_string, callback_args)
    """
    action = action.lower().strip()

    if action in ["speak", "say"]:
        # Use the local speak_reminder callback
        return "app.tooling.tools.scheduler_tool.speak_reminder", {"message": message or "Scheduled reminder"}

    elif action == "reminder":
        # Use the local speak_reminder callback with reminder prefix
        reminder_text = f"Reminder: {message}" if message else "Scheduled reminder"
        return "app.tooling.tools.scheduler_tool.speak_reminder", {"message": reminder_text}

    elif action in ["greeting", "daily_greeting"]:
        # Use the local daily_greeting callback
        return "app.tooling.tools.scheduler_tool.daily_greeting", {}

    elif action == "break_reminder":
        # Use the local break_reminder callback
        callback_args = {"message": message} if message else {}
        return "app.tooling.tools.scheduler_tool.break_reminder", callback_args

    elif action == "water_reminder":
        # Use the local water_reminder callback
        callback_args = {"message": message} if message else {}
        return "app.tooling.tools.scheduler_tool.water_reminder", callback_args

    elif action in ["motivational", "motivational_message"]:
        # Use the local motivational_message callback
        callback_args = {"message": message} if message else {}
        return "app.tooling.tools.scheduler_tool.motivational_message", callback_args

    elif action in ["time_announcement", "hourly_time_announcement"]:
        # Use the local hourly_time_announcement callback
        return "app.tooling.tools.scheduler_tool.hourly_time_announcement", {}

    elif action == "callback":
        # Advanced usage - user can specify custom callback
        callback = kwargs.get("callback")
        if not callback:
            return None, None
        callback_args = kwargs.get("callback_args", {})
        return callback, callback_args

    else:
        return None, None


# Convenience function for sync usage (though the tools are async)
def schedule_speech_reminder(task_name: str, schedule_time: str, message: str) -> str:
    """
    Convenience function to schedule a speech reminder.
    This is a synchronous wrapper for common use cases.
    """
    try:
        loop = asyncio.get_event_loop()
        return loop.run_until_complete(schedule_task_tool(task_name, schedule_time, "speak", message))
    except RuntimeError:
        # No event loop running, create a new one
        return asyncio.run(schedule_task_tool(task_name, schedule_time, "speak", message))

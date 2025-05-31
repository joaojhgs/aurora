import asyncio
import random
from datetime import datetime
from typing import Optional, Dict, Any
from langchain_core.tools import tool

from app.scheduler import get_cron_service
from app.helpers.aurora_logger import log_info, log_debug, log_error


@tool()
async def schedule_task_tool(
    task_name: str,
    schedule_time: str,
    action: str,
    message: Optional[str] = None,
    **kwargs
) -> str:
    """
    Schedule a task to be executed at a specified time.
    
    Args:
        task_name: A descriptive name for the scheduled task
        schedule_time: When to execute the task in natural language (e.g., "in 30 minutes", "tomorrow at 3pm", "every day at 9am")
        action: The action to perform. Available actions:
            - "speak" or "say": Make the assistant speak the message
            - "reminder": Send a reminder notification (speaks the message)
            - "greeting": Daily motivational greeting (random message)
            - "break_reminder": Remind to take a break
            - "water_reminder": Remind to drink water
            - "motivational": Deliver a motivational message
            - "time_announcement": Announce the current time
            - "callback": Call a custom function (advanced usage)
        message: The message to speak or remind about (optional for some actions like "greeting", "break_reminder")
        **kwargs: Additional arguments for the action
    
    Returns:
        Confirmation message with job ID if successful
        
    Examples:
        # Schedule a spoken reminder
        schedule_task_tool("morning reminder", "tomorrow at 8am", "speak", "Good morning! Time to start your day.")
        
        # Schedule a recurring daily greeting
        schedule_task_tool("daily motivation", "every day at 9am", "greeting")
        
        # Schedule a break reminder
        schedule_task_tool("hourly break", "every hour", "break_reminder")
        
        # Schedule water reminders
        schedule_task_tool("hydration check", "every 2 hours", "water_reminder")
        
        # Schedule time announcements
        schedule_task_tool("hourly time", "every hour", "time_announcement")
        
        # Custom message
        schedule_task_tool("meeting reminder", "in 30 minutes", "reminder", "Team meeting starts in 5 minutes")
    """
    try:
        # Get the scheduler service
        cron = get_cron_service()
        
        # Determine callback and arguments based on action
        callback, callback_args = _get_callback_for_action(action, message, **kwargs)
        
        if not callback:
            available_actions = [
                "speak", "say", "reminder", "greeting", "daily_greeting",
                "break_reminder", "water_reminder", "motivational", "motivational_message",
                "time_announcement", "hourly_time_announcement", "callback"
            ]
            return f"Error: Unknown action '{action}'. Available actions: {', '.join(available_actions)}"
        
        # Schedule the task using the text parser
        job_id = await cron.schedule_from_text(
            name=task_name,
            schedule_text=schedule_time,
            callback=callback,
            callback_args=callback_args
        )
        
        if job_id:
            return f"✓ Task '{task_name}' scheduled successfully (ID: {job_id[:8]}...) for: {schedule_time}"
        else:
            return f"✗ Failed to schedule task '{task_name}'. Please check the schedule format."
            
    except Exception as e:
        return f"Error scheduling task: {e}"


@tool
async def list_scheduled_tasks_tool() -> str:
    """
    List all currently scheduled tasks.
    
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
                "cancelled": "🚫"
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
async def cancel_scheduled_task_tool(task_identifier: str) -> str:
    """
    Cancel a scheduled task by name or ID.
    
    Args:
        task_identifier: Either the task name or job ID (first 8 characters are sufficient)
        
    Returns:
        Confirmation message
    """
    try:
        cron = get_cron_service()
        jobs = await cron.get_all_jobs()
        
        # Find job by name or ID
        target_job = None
        for job in jobs:
            if (job.name.lower() == task_identifier.lower() or 
                job.id.startswith(task_identifier) or
                job.id == task_identifier):
                target_job = job
                break
        
        if not target_job:
            return f"Task '{task_identifier}' not found. Use list_scheduled_tasks_tool to see available tasks."
        
        # Cancel the job
        success = await cron.scheduler_manager.delete_job(target_job.id)
        
        if success:
            return f"✓ Task '{target_job.name}' (ID: {target_job.id[:8]}...) has been cancelled."
        else:
            return f"✗ Failed to cancel task '{target_job.name}'. It may have already completed or been cancelled."
            
    except Exception as e:
        return f"Error cancelling task: {e}"


# Assistant-specific callbacks for scheduled tasks
def speak_reminder(**kwargs) -> Dict[str, Any]:
    """
    Make the assistant speak a message.
    This is the primary callback for speech reminders.
    """
    try:
        from app.text_to_speech.tts import play
        
        job_id = kwargs.get('job_id', 'unknown')
        job_name = kwargs.get('job_name', 'unknown')
        text = kwargs.get('text', '')
        message = kwargs.get('message', text)  # Support both 'text' and 'message' parameters
        
        if not message:
            message = f"This is a scheduled reminder: {job_name}"
        
        log_info(f"[{datetime.now()}] Speaking reminder: {message}")
        play(message)
        
        return {
            'success': True,
            'message': f'Spoke reminder: "{message}"',
            'spoken_text': message
        }
        
    except Exception as e:
        log_error(f"Error in speak_reminder: {e}")
        return {
            'success': False,
            'message': f'Failed to speak reminder: {e}'
        }


def daily_greeting(**kwargs) -> Dict[str, Any]:
    """
    A daily greeting that can be scheduled.
    """
    try:
        from app.text_to_speech.tts import play
        
        greetings = [
            "Good morning! Hope you have a wonderful day ahead!",
            "Buenos días! Ready to tackle today's challenges?",
            "Good morning! Remember to take breaks and stay hydrated!",
            "Rise and shine! It's going to be a great day!",
            "Good morning! What amazing things will you accomplish today?"
        ]
        
        greeting = random.choice(greetings)
        
        log_info(f"[{datetime.now()}] Daily greeting: {greeting}")
        play(greeting)
        
        return {
            'success': True,
            'message': f'Daily greeting delivered: "{greeting}"',
            'spoken_text': greeting
        }
        
    except Exception as e:
        log_error(f"Error in daily_greeting: {e}")
        return {
            'success': False,
            'message': f'Failed to deliver daily greeting: {e}'
        }


def hourly_time_announcement(**kwargs) -> Dict[str, Any]:
    """
    Announce the current time (useful for hourly reminders).
    """
    try:
        from app.text_to_speech.tts import play
        
        now = datetime.now()
        time_str = now.strftime("%I:%M %p")
        
        message = f"The time is now {time_str}"
        
        log_info(f"Time announcement: {message}")
        play(message)
        
        return {
            'success': True,
            'message': f'Time announced: {time_str}',
            'spoken_text': message
        }
        
    except Exception as e:
        log_error(f"Error in hourly_time_announcement: {e}")
        return {
            'success': False,
            'message': f'Failed to announce time: {e}'
        }


def break_reminder(**kwargs) -> Dict[str, Any]:
    """
    Remind the user to take a break.
    """
    try:
        from app.text_to_speech.tts import play
        
        reminders = [
            "Time for a break! Step away from the screen and stretch a bit.",
            "Break time! Don't forget to rest your eyes and move around.",
            "You've been working hard! Time to take a breather.",
            "Reminder: It's important to take regular breaks. Stand up and stretch!",
            "Break time! Grab some water and give your mind a rest."
        ]
        
        reminder = kwargs.get('message', random.choice(reminders))
        
        log_info(f"Break reminder: {reminder}")
        play(reminder)
        
        return {
            'success': True,
            'message': f'Break reminder delivered: "{reminder}"',
            'spoken_text': reminder
        }
        
    except Exception as e:
        log_error(f"Error in break_reminder: {e}")
        return {
            'success': False,
            'message': f'Failed to deliver break reminder: {e}'
        }


def water_reminder(**kwargs) -> Dict[str, Any]:
    """
    Remind the user to drink water.
    """
    try:
        from app.text_to_speech.tts import play
        
        reminders = [
            "Don't forget to stay hydrated! Time for some water.",
            "Hydration check! Have you had enough water today?",
            "Your body needs water! Take a moment to hydrate.",
            "Water break! Remember, staying hydrated is important for your health.",
            "Time to drink some water! Your brain will thank you."
        ]
        
        reminder = kwargs.get('message', random.choice(reminders))
        
        log_info(f"Water reminder: {reminder}")
        play(reminder)
        
        return {
            'success': True,
            'message': f'Water reminder delivered: "{reminder}"',
            'spoken_text': reminder
        }
        
    except Exception as e:
        log_error(f"Error in water_reminder: {e}")
        return {
            'success': False,
            'message': f'Failed to deliver water reminder: {e}'
        }


def motivational_message(**kwargs) -> Dict[str, Any]:
    """
    Deliver a motivational message.
    """
    try:
        from app.text_to_speech.tts import play
        
        messages = [
            "You're doing great! Keep up the excellent work!",
            "Believe in yourself! You have the power to achieve amazing things!",
            "Every small step counts. You're making progress!",
            "You're stronger than you think and more capable than you imagine!",
            "Today is full of possibilities. Make it count!",
            "Your hard work is paying off. Keep pushing forward!",
            "You've overcome challenges before, and you'll overcome this one too!"
        ]
        
        message = kwargs.get('message', random.choice(messages))
        
        log_info(f"Motivational message: {message}")
        play(message)
        
        return {
            'success': True,
            'message': f'Motivational message delivered: "{message}"',
            'spoken_text': message
        }
        
    except Exception as e:
        log_error(f"Error in motivational_message: {e}")
        return {
            'success': False,
            'message': f'Failed to deliver motivational message: {e}'
        }


def _get_callback_for_action(action: str, message: str = None, **kwargs) -> tuple[str, Dict[str, Any]]:
    """
    Get the appropriate callback function and arguments for the given action.
    
    Returns:
        Tuple of (callback_string, callback_args)
    """
    action = action.lower().strip()
    
    if action in ["speak", "say"]:
        # Use the local speak_reminder callback
        return "app.langgraph.tools.scheduler_tool.speak_reminder", {"message": message or "Scheduled reminder"}
    
    elif action == "reminder":
        # Use the local speak_reminder callback with reminder prefix
        reminder_text = f"Reminder: {message}" if message else "Scheduled reminder"
        return "app.langgraph.tools.scheduler_tool.speak_reminder", {"message": reminder_text}
    
    elif action in ["greeting", "daily_greeting"]:
        # Use the local daily_greeting callback
        return "app.langgraph.tools.scheduler_tool.daily_greeting", {}
    
    elif action == "break_reminder":
        # Use the local break_reminder callback
        callback_args = {"message": message} if message else {}
        return "app.langgraph.tools.scheduler_tool.break_reminder", callback_args
    
    elif action == "water_reminder":
        # Use the local water_reminder callback
        callback_args = {"message": message} if message else {}
        return "app.langgraph.tools.scheduler_tool.water_reminder", callback_args
    
    elif action in ["motivational", "motivational_message"]:
        # Use the local motivational_message callback
        callback_args = {"message": message} if message else {}
        return "app.langgraph.tools.scheduler_tool.motivational_message", callback_args
    
    elif action in ["time_announcement", "hourly_time_announcement"]:
        # Use the local hourly_time_announcement callback
        return "app.langgraph.tools.scheduler_tool.hourly_time_announcement", {}
    
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
        return loop.run_until_complete(
            schedule_task_tool(task_name, schedule_time, "speak", message)
        )
    except RuntimeError:
        # No event loop running, create a new one
        return asyncio.run(
            schedule_task_tool(task_name, schedule_time, "speak", message)
        )

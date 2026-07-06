"""Scheduler Tooling fireback tools use typed Scheduler.ScheduleAction paths."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.messaging import QueryResult
from app.services.tooling.tools.scheduler_tool import (
    _get_action_spec_for_action,
    schedule_task_tool,
)
from app.shared.contracts.models.scheduler import SchedulerMethods


@pytest.mark.asyncio
async def test_schedule_task_tool_sends_typed_schedule_action_request():
    bus = MagicMock()
    bus.request = AsyncMock(
        return_value=QueryResult(
            ok=True,
            data={"ok": True, "status": "scheduled", "job_id": "job-typed-reminder"},
        )
    )

    message = await schedule_task_tool.ainvoke(
        {
            "task_name": "drink water",
            "schedule_time": "*/30 * * * *",
            "action": "water_reminder",
            "message": "Drink water",
            "bus": bus,
        }
    )

    assert "scheduled successfully" in message
    topic, payload = bus.request.await_args.args[:2]
    assert topic == SchedulerMethods.SCHEDULE_ACTION
    assert payload.action_spec.kind == "tooling.execute"
    assert payload.action_spec.binding.tool_name == "scheduler_water_reminder_tool"
    assert payload.action_spec.arguments == {"message": "Drink water"}


def test_scheduler_tool_action_specs_are_typed_and_do_not_encode_callbacks():
    speak = _get_action_spec_for_action("speak", "Hello")
    tooling = _get_action_spec_for_action("tooling", tool_name="custom_tool", arguments={"x": 1})
    unknown = _get_action_spec_for_action("callback", "old path")

    assert speak.kind == "tts.speak"
    assert speak.model_dump(mode="json") == {
        "kind": "tts.speak",
        "text": "Hello",
        "interrupt": False,
    }
    assert tooling.kind == "tooling.execute"
    assert tooling.binding.tool_name == "custom_tool"
    assert tooling.arguments == {"x": 1}
    assert unknown is None

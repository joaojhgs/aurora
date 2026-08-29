"""Pomodoro firebacks schedule typed scheduler actions."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.messaging import QueryResult
from app.services.tooling.tools.pomodoro_tool import _schedule_pomodoro_transition
from app.shared.contracts.models.scheduler import SchedulerMethods


@pytest.mark.asyncio
async def test_pomodoro_transition_schedules_typed_tool_action():
    bus = MagicMock()
    bus.request = AsyncMock(
        return_value=QueryResult(
            ok=True,
            data={"ok": True, "status": "scheduled", "job_id": "pomodoro-job"},
        )
    )

    job_id = await _schedule_pomodoro_transition(
        bus,
        name="pomodoro_work_end",
        absolute_time="2026-07-05 13:31:00",
        transition="work_session_end",
    )

    assert job_id == "pomodoro-job"
    topic, payload = bus.request.await_args.args[:2]
    assert topic == SchedulerMethods.SCHEDULE_ACTION
    assert payload.name == "pomodoro_work_end"
    assert payload.schedule == "2026-07-05 13:31:00"
    assert payload.action_spec.kind == "tooling.execute"
    assert payload.action_spec.binding.tool_name == "pomodoro_transition_tool"
    assert payload.action_spec.arguments == {"transition": "work_session_end"}

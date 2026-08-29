"""Typed scheduler storage regression tests."""

from datetime import datetime, timedelta

import pytest

from app.services.db.scheduler_db_service import SchedulerDatabaseService
from app.shared.contracts.models.scheduler import SchedulerToolBinding, SchedulerToolExecuteAction
from app.shared.models.db import CronJob, ScheduleType


@pytest.mark.asyncio
async def test_typed_scheduler_row_round_trips_through_db(tmp_path):
    """Typed action rows persist action JSON without executable callback imports."""
    db_path = tmp_path / "scheduler.db"
    db = SchedulerDatabaseService(str(db_path))
    await db.initialize()

    now = datetime.now()
    action = SchedulerToolExecuteAction(
        binding=SchedulerToolBinding(
            tool_name="switch_on",
            local_tool_name="switch_on",
            global_tool_id="local:local_Tooling:tool:switch_on",
            args_schema_hash="schema-hash-1",
        ),
        arguments={"target": "lamp"},
    ).model_dump(mode="json")
    job = CronJob.create_cron_job(
        name="typed tool",
        cron_expression="*/5 * * * *",
        callback_module="__typed_action__",
        callback_function="execute_action_spec",
        action_kind="tooling.execute",
        action_spec=action,
        prepared_binding=action["binding"],
        policy_decision_id="decision-1",
    )
    job.next_run_time = now + timedelta(minutes=5)

    assert await db.add_job(job) is True
    loaded = await db.get_job(job.id)

    assert loaded is not None
    assert loaded.callback_module == "__typed_action__"
    assert loaded.callback_function == "execute_action_spec"
    assert loaded.action_kind == "tooling.execute"
    assert loaded.action_spec == action
    assert loaded.prepared_binding == action["binding"]
    assert loaded.policy_decision_id == "decision-1"


@pytest.mark.asyncio
async def test_legacy_scheduler_row_survives_typed_columns(tmp_path):
    """Existing legacy rows still load after typed-action migration columns exist."""
    db_path = tmp_path / "scheduler.db"
    db = SchedulerDatabaseService(str(db_path))
    await db.initialize()

    legacy = CronJob.create_cron_job(
        name="legacy",
        cron_expression="0 9 * * *",
        callback_module="app.legacy.module",
        callback_function="run",
        callback_args={"message": "hello"},
    )
    legacy.next_run_time = datetime.now() + timedelta(days=1)

    assert await db.add_job(legacy) is True
    loaded = await db.get_job(legacy.id)

    assert loaded is not None
    assert loaded.callback_module == "app.legacy.module"
    assert loaded.callback_function == "run"
    assert loaded.callback_args == {"message": "hello"}
    assert loaded.action_kind is None
    assert loaded.action_spec is None

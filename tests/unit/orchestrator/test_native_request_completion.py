"""Focused tests for bounded request-local completion groups."""

from __future__ import annotations

import asyncio
import contextvars
import gc
import threading
import weakref

import pytest

from app.services.orchestrator.native_request_completion import (
    MAX_REQUEST_MEMBERS,
    RequestBinding,
    RequestCompletionStatus,
    RequestMember,
    _active_groups,
    _unresolved_groups,
    _worker_authorization,
    admit_request_member,
    bind_request_group,
    bind_request_member,
    create_request_group,
    request_member_scope,
)
from app.services.orchestrator.native_worker import direct_native_call


def _binding(name: str = "one") -> RequestBinding:
    return RequestBinding(
        principal="principal-local",
        peer=None,
        session_id=f"session-{name}",
        request_id=f"request-{name}",
        execution_generation=f"generation-{name}",
    )


def test_request_binding_rejects_missing_owner_and_noncanonical_text():
    with pytest.raises(ValueError):
        RequestBinding(None, None, "session", "request", "generation")
    with pytest.raises(ValueError):
        RequestBinding(" principal", None, "session", "request", "generation")
    with pytest.raises(ValueError):
        RequestBinding("p" * 257, None, "session", "request", "generation")


@pytest.mark.asyncio
async def test_request_group_requires_observed_native_completion():
    group = create_request_group(_binding())
    with bind_request_group(group):
        member = group.admit("native-operation")
        group.mark_native_work(member, known=True)
        group.settle(member, native_status="complete")

    result = await group.stop_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.COMPLETE
    assert result.stopped is True


@pytest.mark.asyncio
async def test_direct_sync_callable_gets_its_own_unknown_member():
    group = create_request_group(_binding("direct-sync"))

    @direct_native_call
    def safe_value(_provider):
        return {"value": "kept"}

    with bind_request_group(group):
        value = safe_value(object())

    result = await group.complete_and_wait(timeout=1)
    assert value == {"value": "kept"}
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert len(group._unresolved) == 1


@pytest.mark.asyncio
async def test_request_group_without_native_work_is_unknown_and_terminal():
    group = create_request_group(_binding())
    first = await group.stop_and_wait(timeout=1)
    assert first.status is RequestCompletionStatus.UNKNOWN

    with pytest.raises(RuntimeError, match="closed"):
        group.admit("late")
    assert await group.stop_and_wait(timeout=0) is first


@pytest.mark.asyncio
async def test_request_group_timeout_is_immutable_after_late_settlement():
    group = create_request_group(_binding())
    group_id = id(group)
    with bind_request_group(group):
        member = group.admit("native-operation")
        group.mark_native_work(member, known=True)

    timed_out = await group.stop_and_wait(timeout=0)
    assert timed_out.status is RequestCompletionStatus.DEADLINE_EXCEEDED
    assert _active_groups[group_id] is group
    group.settle(member, native_status="complete")
    assert await group.stop_and_wait(timeout=1) is timed_out
    assert group_id not in _active_groups
    assert group_id not in _unresolved_groups


@pytest.mark.asyncio
async def test_late_member_settlement_wakes_completion_owner_before_terminal():
    group = create_request_group(_binding("settlement-wakeup"))
    with bind_request_group(group):
        member = group.admit("native-operation")
        group.mark_native_work(member, known=True)

    owner = asyncio.create_task(group.complete_and_wait(timeout=1))
    for _ in range(20):
        if group._changed._waiters:
            break
        await asyncio.sleep(0)
    assert group._changed._waiters
    group.settle(member, native_status="complete")
    result = await asyncio.wait_for(owner, timeout=1)
    assert result.status is RequestCompletionStatus.COMPLETE
    assert id(group) not in _active_groups


@pytest.mark.asyncio
async def test_first_group_failure_is_retained_after_later_member_settlement():
    group = create_request_group(_binding("first-failure"))
    with bind_request_group(group):
        first = group.admit("native-operation")
        second = group.admit("native-operation")
        group.mark_native_work(first, known=True)
        group.mark_native_work(second, known=True)
        group.fail(first, "first-native-failure")
        group.fail(second, "later-native-failure")

    result = await group.complete_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.FAILED
    assert result.reason == "first-native-failure"


@pytest.mark.asyncio
async def test_stopped_copied_context_cannot_admit_another_member():
    group = create_request_group(_binding())
    with bind_request_group(group):
        member = group.admit("native-operation")
        group.mark_native_work(member, known=True)
        group.settle(member, native_status="complete")
        copied = contextvars.copy_context()

    group.begin_stop()
    with pytest.raises(RuntimeError, match="closed"):
        copied.run(group.admit, "copied-late-operation")
    assert (await group.stop_and_wait(timeout=1)).status is RequestCompletionStatus.COMPLETE


@pytest.mark.asyncio
async def test_two_request_groups_keep_independent_stop_and_completion_state():
    first = create_request_group(_binding("first"))
    second = create_request_group(_binding("second"))
    with bind_request_group(first):
        first_member = first.admit("native-operation")
    with bind_request_group(second):
        second_member = second.admit("native-operation")
        second.mark_native_work(second_member, known=True)
        second.settle(second_member, native_status="complete")
    first.mark_native_work(first_member, known=True)

    first.begin_stop()
    assert second.is_open is True
    first.settle(first_member, native_status="stopped")

    first_result, second_result = await asyncio.gather(
        first.stop_and_wait(timeout=1), second.stop_and_wait(timeout=1)
    )
    assert first_result.status is RequestCompletionStatus.COMPLETE
    assert first_result.stopped is True
    assert second_result.status is RequestCompletionStatus.COMPLETE
    assert second_result.stopped is True


@pytest.mark.asyncio
async def test_request_group_stop_callback_failure_stays_unknown():
    group = create_request_group(_binding())
    stop_calls = []
    with bind_request_group(group):

        def stop():
            stop_calls.append("called")
            raise ValueError()

        member = group.admit("native-stream", stop=stop)
        group.mark_native_work(member, known=True)
        group.begin_stop()
        group.begin_stop()
        group.settle(member, native_status="stopped")

    result = await group.stop_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert result.reason == "request_stream_stop_failed"
    assert stop_calls == ["called"]


@pytest.mark.asyncio
async def test_cancelled_duplicate_completion_observer_does_not_cancel_owner():
    group = create_request_group(_binding("observers"))
    with bind_request_group(group):
        member = group.admit("native-operation")
        group.mark_native_work(member, known=True)
    group.begin_stop()

    first = asyncio.create_task(group.stop_and_wait(timeout=1))
    second = asyncio.create_task(group.stop_and_wait(timeout=1))
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first

    group.settle(member, native_status="complete")
    result = await asyncio.wait_for(second, timeout=1)
    assert result.status is RequestCompletionStatus.COMPLETE
    assert await group.stop_and_wait(timeout=1) is result


@pytest.mark.asyncio
async def test_request_group_membership_capacity_rejects_without_eviction():
    group = create_request_group(_binding("capacity"))
    with bind_request_group(group):
        members = [group.admit("bounded") for _ in range(MAX_REQUEST_MEMBERS)]
        with pytest.raises(RuntimeError, match="capacity"):
            group.admit("overflow")
    assert len(group._members) == MAX_REQUEST_MEMBERS
    for member in members:
        group.fail(member, "controlled-test-settlement", unknown=True)
    assert not group._members


@pytest.mark.asyncio
async def test_unresolved_request_group_remains_strongly_retained():
    group = create_request_group(_binding("retained-unknown"))
    member = group.admit("native-operation")
    group.fail(member, "controlled-unknown", unknown=True)
    result = await group.stop_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.UNKNOWN

    group_id = id(group)
    reference = weakref.ref(group)
    del member
    del group
    gc.collect()

    retained = _unresolved_groups[group_id]
    assert reference() is retained
    assert len(retained._unresolved) == 1


@pytest.mark.asyncio
async def test_unknown_native_member_cannot_be_upgraded_by_late_known_settlement():
    group = create_request_group(_binding("sticky-unknown"))
    with bind_request_group(group):
        member = group.admit("native-operation")
        group.mark_native_work(member, known=True)
        group.mark_native_work(member, known=False)
        group.settle(member, native_status="complete")

    result = await group.stop_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert result.reason == "native_completion_unverified"


@pytest.mark.asyncio
async def test_group_capability_is_registered_and_binding_fields_cannot_be_replaced():
    group = create_request_group(_binding("registered"))
    forged = type(group)(_binding("forged"), asyncio.get_running_loop())

    with pytest.raises(RuntimeError, match="unavailable"), bind_request_group(forged):
        pass
    with pytest.raises(RuntimeError, match="unavailable"):
        forged.admit("forged-member")
    with pytest.raises(AttributeError):
        group.binding = _binding("replacement")
    with pytest.raises(AttributeError):
        group.loop = asyncio.get_running_loop()

    with bind_request_group(group):
        member = group.admit("native-operation")
        group.mark_native_work(member, known=True)
        group.settle(member, native_status="complete")
    assert (await group.complete_and_wait(timeout=1)).status is RequestCompletionStatus.COMPLETE


@pytest.mark.asyncio
async def test_nested_native_scopes_admit_distinct_members_and_retain_open_group():
    group = create_request_group(_binding("nested-members"))
    reference = weakref.ref(group)
    with (
        bind_request_group(group),
        request_member_scope("outer", resource=object()) as (outer, outer_owned),
    ):
        assert outer_owned is True
        with request_member_scope("inner", resource=object()) as (inner, inner_owned):
            assert inner_owned is True
            assert inner is not outer
            group.mark_native_work(inner, known=True)
        group.mark_native_work(outer, known=True)
    group_id = id(group)
    del group
    gc.collect()

    retained = _active_groups[group_id]
    assert reference() is retained
    assert len(retained._members) == 0
    assert (await retained.complete_and_wait(timeout=1)).status is RequestCompletionStatus.COMPLETE
    assert group_id not in _active_groups


@pytest.mark.asyncio
async def test_resolved_unknown_cache_tail_cannot_be_upgraded_by_later_success():
    group = create_request_group(_binding("cache-tail-unknown-sticky"))
    unknown = group.admit("native_stream")
    group.mark_native_work(unknown, known=False)
    group.settle(unknown, native_status="unknown", reason="stream_tail_unknown")
    complete = group.admit("native_operation")
    group.mark_native_work(complete, known=True)
    group.settle(complete, native_status="complete", cache_tail_completed=True)

    result = await group.complete_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert result.cache_tail_completed is None


@pytest.mark.asyncio
async def test_sealed_group_allows_stop_binding_for_exact_active_member():
    group = create_request_group(_binding("sealed-stop-hook"))
    with bind_request_group(group):
        active = group.admit("native-stream")
        settled = group.admit("native-operation")
        group.mark_native_work(active, known=True)
        group.mark_native_work(settled, known=True)
        group.settle(settled, native_status="complete")

    group.seal()
    stop_calls = []
    active.set_stop(lambda: stop_calls.append("stopped"))

    with pytest.raises(RuntimeError, match="closed"):
        group.admit("late-native-stream")
    with pytest.raises(RuntimeError, match="no longer admitted"):
        settled.set_stop(lambda: None)
    forged = RequestMember(group, active.sequence, "native-stream")
    with pytest.raises(RuntimeError, match="no longer admitted"):
        forged.set_stop(lambda: None)

    group.begin_stop()
    with pytest.raises(RuntimeError, match="closed"):
        active.set_stop(lambda: None)
    group.settle(active, native_status="stopped")

    result = await group.stop_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.COMPLETE
    assert stop_calls == ["stopped"]


@pytest.mark.asyncio
async def test_pending_admission_clears_positive_cache_tail_before_deadline():
    group = create_request_group(_binding("pending-cache-tail-deadline"))
    first = group.admit("native-operation")
    group.mark_native_work(first, known=True)
    group.settle(first, native_status="complete", cache_tail_completed=True)
    assert group._cache_tail_completed is True

    pending = group.admit("native-operation")
    group.mark_native_work(pending, known=True)
    deadline = await group.complete_and_wait(timeout=0)
    assert deadline.status is RequestCompletionStatus.DEADLINE_EXCEEDED
    assert deadline.cache_tail_completed is None

    group.settle(pending, native_status="complete", cache_tail_completed=True)
    assert await group.complete_and_wait(timeout=1) is deadline


@pytest.mark.asyncio
async def test_record_failure_keeps_exact_member_live_until_cleanup_settles():
    group = create_request_group(_binding("deferred-failure"))
    member = group.admit("native-operation")
    forged = RequestMember(group, member.sequence, "native-operation")

    group.record_failure(forged, "forged-failure")
    assert group._members[member.sequence] is member
    assert group._first_failure is None

    group.record_failure(member, "outer_cleanup_failed")
    assert group._members[member.sequence] is member
    assert member.reason == "outer_cleanup_failed"
    assert member.native_seen is False
    assert group._saw_native_work is False
    assert len(group._members) == 1

    group.mark_native_work(member, known=True)
    group.settle(member, native_status="complete")
    result = await group.complete_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.FAILED
    assert result.reason == "outer_cleanup_failed"
    assert not group._members


@pytest.mark.asyncio
async def test_record_failure_preserves_unknown_and_first_failure():
    group = create_request_group(_binding("record-failure-sticky"))
    uncertain = group.admit("native-operation")
    failed = group.admit("native-operation")

    group.record_failure(uncertain, "first_cleanup_failure", unknown=True)
    group.record_failure(uncertain, "later_uncertain_failure")
    group.record_failure(failed, "second_cleanup_failure")
    assert group._members[uncertain.sequence] is uncertain
    assert group._members[failed.sequence] is failed
    assert uncertain.native_unknown is True
    assert uncertain.native_status == "unknown"
    assert group._first_failure == "first_cleanup_failure"

    group.mark_native_work(uncertain, known=True)
    group.mark_native_work(failed, known=True)
    group.settle(uncertain, native_status="complete")
    group.settle(failed, native_status="complete")
    result = await group.complete_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert result.reason == "first_cleanup_failure"


@pytest.mark.asyncio
async def test_late_record_failure_does_not_rewrite_deadline_result():
    group = create_request_group(_binding("late-record-failure"))
    member = group.admit("native-operation")
    group.mark_native_work(member, known=True)

    deadline = await group.complete_and_wait(timeout=0)
    assert deadline.status is RequestCompletionStatus.DEADLINE_EXCEEDED
    original = (deadline.status, deadline.reason, deadline.stopped, deadline.cache_tail_completed)

    group.record_failure(member, "late_cleanup_failure", unknown=True)
    group.settle(member, native_status="complete")
    assert (
        deadline.status,
        deadline.reason,
        deadline.stopped,
        deadline.cache_tail_completed,
    ) == original
    assert await group.complete_and_wait(timeout=1) is deadline


@pytest.mark.asyncio
async def test_rejected_callback_admission_leaves_original_member_unchanged():
    group = create_request_group(_binding("rejected-callback-admission"))
    member = group.admit("native-operation")
    group.mark_native_work(member, known=True)

    with bind_request_member(member):
        marker = _worker_authorization.set((member, object(), threading.get_ident()))
        try:
            with pytest.raises(RuntimeError, match="callback work"):
                admit_request_member("nested-native-operation")
        finally:
            _worker_authorization.reset(marker)

    assert group._members[member.sequence] is member
    assert member.native_status == "complete"
    assert member.native_unknown is False
    assert group._unknown_native_work is False
    group.settle(member, native_status="complete")
    result = await group.complete_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.COMPLETE

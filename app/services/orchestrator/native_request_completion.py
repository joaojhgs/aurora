"""Request-scoped ownership for admitted native work.

This module is deliberately internal.  It records accepted work; it does not
authenticate a caller or prove remote/provider completion by itself.
"""

from __future__ import annotations

import asyncio
import contextvars
import threading
import weakref
from collections.abc import Callable
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

MAX_REQUEST_GROUPS = 128
MAX_REQUEST_MEMBERS = 256
_MAX_TEXT_BYTES = 256


class RequestCompletionStatus(str, Enum):
    COMPLETE = "complete"
    FAILED = "failed"
    UNKNOWN = "unknown"
    DEADLINE_EXCEEDED = "deadline_exceeded"


@dataclass(frozen=True)
class RequestCompletionResult:
    status: RequestCompletionStatus
    reason: str | None = None
    stopped: bool = False
    cache_tail_completed: bool | None = None


@dataclass(frozen=True)
class RequestBinding:
    """Immutable B2-supplied identity dimensions for one accepted request."""

    principal: str | None
    peer: str | None
    session_id: str
    request_id: str
    execution_generation: str

    def __post_init__(self) -> None:
        for value in (self.principal, self.peer):
            if value is not None and not _valid_text(value):
                raise ValueError("invalid request binding")
        if self.principal is None and self.peer is None:
            raise ValueError("request binding needs an authenticated owner")
        if not all(
            _valid_text(value)
            for value in (self.session_id, self.request_id, self.execution_generation)
        ):
            raise ValueError("invalid request binding")


def _valid_text(value: Any) -> bool:
    if not isinstance(value, str) or not value or value != value.strip():
        return False
    try:
        return len(value.encode("utf-8")) <= _MAX_TEXT_BYTES
    except UnicodeEncodeError:
        return False


class _GroupState(str, Enum):
    OPEN = "open"
    SEALED = "sealed"
    STOPPING = "stopping"
    TERMINAL = "terminal"


class _MemberState(str, Enum):
    ACTIVE = "active"
    SETTLED = "settled"
    UNKNOWN = "unknown"


@dataclass
class RequestMember:
    group: RequestGroup
    sequence: int
    kind: str
    state: _MemberState = _MemberState.ACTIVE
    stop: Callable[[], None] | None = None
    resource: Any = None
    native_status: str = "unknown"
    reason: str | None = None
    native_seen: bool = False
    native_unknown: bool = False
    native_not_submitted: bool = False
    scope_finished: bool = False
    cache_tail_completed: bool | None = None

    def set_stop(self, stop: Callable[[], None]) -> None:
        with self.group._lock:
            if self.group._members.get(self.sequence) is not self:
                raise RuntimeError("request member is no longer admitted")
            if self.group._state not in (_GroupState.OPEN, _GroupState.SEALED):
                raise RuntimeError("request group is closed")
            self.stop = stop


_groups_lock = threading.Lock()
_groups: weakref.WeakValueDictionary[int, RequestGroup] = weakref.WeakValueDictionary()
_active_groups: dict[int, RequestGroup] = {}
_unresolved_groups: dict[int, Any] = {}
_active_group: contextvars.ContextVar[RequestGroup | None] = contextvars.ContextVar(
    "aurora_native_request_group", default=None
)


class RequestGroup:
    """Retained object capability for exactly one accepted request."""

    __slots__ = (
        "_binding",
        "_loop",
        "_lock",
        "_state",
        "_members",
        "_unresolved",
        "_next_sequence",
        "_changed",
        "_owner_task",
        "_terminal",
        "_first_failure",
        "_saw_native_work",
        "_saw_known_not_submitted",
        "_unknown_native_work",
        "_stopped",
        "_cache_tail_completed",
        "_cache_tail_uncertain",
        "__weakref__",
    )

    def __init__(self, binding: RequestBinding, loop: asyncio.AbstractEventLoop) -> None:
        if not isinstance(binding, RequestBinding):
            raise TypeError("invalid request binding")
        self._binding = binding
        self._loop = loop
        self._lock = threading.RLock()
        self._state = _GroupState.OPEN
        self._members: dict[int, RequestMember] = {}
        self._unresolved: dict[int, RequestMember] = {}
        self._next_sequence = 0
        self._changed = asyncio.Event()
        self._owner_task: asyncio.Task[RequestCompletionResult] | None = None
        self._terminal: RequestCompletionResult | None = None
        self._first_failure: str | None = None
        self._saw_native_work = False
        self._saw_known_not_submitted = False
        self._unknown_native_work = False
        self._stopped = False
        self._cache_tail_completed: bool | None = None
        self._cache_tail_uncertain = False

    @property
    def binding(self) -> RequestBinding:
        return self._binding

    @property
    def loop(self) -> asyncio.AbstractEventLoop:
        return self._loop

    @property
    def is_open(self) -> bool:
        with self._lock:
            return self._state is _GroupState.OPEN

    @property
    def has_admitted_work(self) -> bool:
        """Whether this request has ever admitted a local work member."""
        with self._lock:
            return self._next_sequence > 0

    def _check_loop(self) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError as error:
            raise RuntimeError("request group requires its original event loop") from error
        if loop is not self.loop:
            raise RuntimeError("request group belongs to another event loop")

    def admit(
        self,
        kind: str,
        *,
        resource: Any = None,
        stop: Callable[[], None] | None = None,
    ) -> RequestMember:
        self._check_loop()
        with _groups_lock:
            if _groups.get(id(self)) is not self:
                raise RuntimeError("request group is unavailable")
            with self._lock:
                if self._state is not _GroupState.OPEN:
                    raise RuntimeError("request group is closed")
                if len(self._members) + len(self._unresolved) >= MAX_REQUEST_MEMBERS:
                    raise RuntimeError("request group capacity reached")
                if self._next_sequence >= (1 << 63) - 1:
                    self._state = _GroupState.STOPPING
                    raise RuntimeError("request group capacity reached")
                self._next_sequence += 1
                member = RequestMember(
                    self, self._next_sequence, kind, stop=stop, resource=resource
                )
                self._members[member.sequence] = member
                self._recompute_cache_tail_locked()
                return member

    def mark_native_work(self, member: RequestMember, *, known: bool) -> None:
        with self._lock:
            if self._members.get(member.sequence) is not member:
                return
            if known:
                self._saw_native_work = True
                member.native_seen = True
                if not member.native_unknown and member.native_status != "failed":
                    member.native_status = "complete"
            else:
                member.native_unknown = True
                self._unknown_native_work = True
                member.native_status = "unknown"

    def mark_not_submitted(self, member: RequestMember) -> None:
        """Record only a native gate's proof that no callable was started."""

        with self._lock:
            if (
                self._members.get(member.sequence) is not member
                or member.native_seen
                or member.native_unknown
            ):
                return
            member.native_not_submitted = True
            member.native_status = "stopped"
            if member.cache_tail_completed is None:
                member.cache_tail_completed = False
                self._cache_tail_completed = False
            self._saw_known_not_submitted = True

    def settle(
        self,
        member: RequestMember,
        *,
        native_status: str,
        reason: str | None = None,
        cache_tail_completed: bool | None = None,
    ) -> None:
        with self._lock:
            if self._members.get(member.sequence) is not member:
                return
            if member.native_status in ("unknown", "failed"):
                native_status = member.native_status
            if member.native_unknown:
                native_status = "unknown"
            if native_status == "unknown":
                member.native_unknown = True
            member.native_status = native_status
            if native_status == "stopped" and not member.native_not_submitted:
                self._stopped = True
            if member.reason is None and reason is not None:
                member.reason = reason
            member.state = (
                _MemberState.SETTLED
                if native_status in ("complete", "stopped", "failed")
                else _MemberState.UNKNOWN
            )
            if reason is not None and self._first_failure is None:
                self._first_failure = reason
            if native_status == "unknown" or (
                not member.native_seen and not member.native_not_submitted
            ):
                self._unknown_native_work = True
            if cache_tail_completed is False:
                member.cache_tail_completed = False
                self._cache_tail_completed = False
            elif cache_tail_completed is True and member.cache_tail_completed is None:
                member.cache_tail_completed = True
                self._recompute_cache_tail_locked()
            elif member.cache_tail_completed is None:
                # A resolved member is no longer present in either live map.
                # Keep its missing cache-tail evidence sticky so a later
                # member's success cannot make the group look fully drained.
                self._cache_tail_uncertain = True
                self._recompute_cache_tail_locked()
            if member.state is _MemberState.SETTLED:
                self._members.pop(member.sequence, None)
            else:
                # The scope has ended but its native result remains uncertain.
                # Retain the exact member strongly while allowing the group
                # owner to publish terminal UNKNOWN instead of timing out on a
                # scope that can never settle a second time.
                self._members.pop(member.sequence, None)
                self._unresolved[member.sequence] = member
            unresolved = member.sequence in self._unresolved
            settled_terminal = self._terminal is not None and not self._members
            has_unresolved = bool(self._unresolved)
        if unresolved:
            with _groups_lock:
                _unresolved_groups[id(self)] = self
        elif settled_terminal and not has_unresolved:
            with _groups_lock:
                _unresolved_groups.pop(id(self), None)
                _active_groups.pop(id(self), None)
        # A completion owner may be waiting for this member while the group
        # itself is still open/sealed. Wake it on every settlement; the owner
        # rechecks membership and clears the event under the same lock.
        self._notify()

    def _recompute_cache_tail_locked(self) -> None:
        if self._cache_tail_completed is False:
            return
        values = [member.cache_tail_completed for member in self._members.values()]
        values.extend(member.cache_tail_completed for member in self._unresolved.values())
        if values and any(value is False for value in values):
            self._cache_tail_completed = False
        elif self._cache_tail_uncertain:
            self._cache_tail_completed = None
        elif values and all(value is True for value in values):
            self._cache_tail_completed = True
        else:
            self._cache_tail_completed = None

    def fail(self, member: RequestMember, reason: str, *, unknown: bool = False) -> None:
        self.settle(member, native_status="unknown" if unknown else "failed", reason=reason)

    def record_failure(self, member: RequestMember, reason: str, unknown: bool = False) -> None:
        """Record an owned failure while keeping its member live for cleanup."""

        with self._lock:
            if self._members.get(member.sequence) is not member:
                return
            if member.reason is None:
                member.reason = reason
            if self._first_failure is None:
                self._first_failure = reason
            if unknown:
                member.native_unknown = True
                member.native_status = "unknown"
                self._unknown_native_work = True
            elif not member.native_unknown:
                member.native_status = "failed"

    def _notify(self) -> None:
        if self.loop.is_closed():
            with self._lock:
                self._unknown_native_work = True
                if self._first_failure is None:
                    self._first_failure = "request_loop_unavailable"
            return
        try:
            self.loop.call_soon_threadsafe(self._changed.set)
        except RuntimeError:
            with self._lock:
                self._unknown_native_work = True
                if self._first_failure is None:
                    self._first_failure = "request_loop_unavailable"

    def begin_stop(self) -> None:
        """Seal admission synchronously, then request stop from owned streams."""

        self._check_loop()
        with self._lock:
            if self._state in (_GroupState.STOPPING, _GroupState.TERMINAL):
                return
            self._state = _GroupState.STOPPING
            self._stopped = True
            stops = [member.stop for member in self._members.values() if member.stop is not None]
        # Stop callbacks are intentionally invoked outside the group lock.
        for stop in stops:
            try:
                stop()
            except BaseException:
                with self._lock:
                    if self._first_failure is None:
                        self._first_failure = "request_stream_stop_failed"
                    self._unknown_native_work = True
        self._notify()

    def seal(self) -> None:
        """Close new admission while allowing accepted work to finish naturally."""

        self._check_loop()
        with self._lock:
            if self._state is not _GroupState.OPEN:
                return
            self._state = _GroupState.SEALED
        self._notify()

    @property
    def is_stopping(self) -> bool:
        with self._lock:
            return self._state in (_GroupState.STOPPING, _GroupState.TERMINAL)

    def contains_active_member(self, member: RequestMember | None) -> bool:
        """Check continuation of one already-admitted member after sealing."""

        if member is None or member.group is not self:
            return False
        with self._lock:
            return (
                self._state not in (_GroupState.STOPPING, _GroupState.TERMINAL)
                and self._members.get(member.sequence) is member
            )

    async def _completion_owner(self, timeout: float | None) -> RequestCompletionResult:
        try:
            if timeout is None:
                await self._wait_empty()
            else:
                await asyncio.wait_for(self._wait_empty(), max(0.0, timeout))
        except asyncio.TimeoutError:
            with self._lock:
                result = RequestCompletionResult(
                    RequestCompletionStatus.DEADLINE_EXCEEDED,
                    self._first_failure or "request_completion_deadline_exceeded",
                    stopped=self._stopped,
                    cache_tail_completed=self._cache_tail_completed,
                )
            return self._publish_terminal(result)
        with self._lock:
            failure = self._first_failure
            unknown = self._unknown_native_work or not (
                self._saw_native_work or self._saw_known_not_submitted
            )
            members_empty = not self._members
            stopped = self._stopped
            cache_tail = self._cache_tail_completed
        if not members_empty or unknown:
            result = RequestCompletionResult(
                RequestCompletionStatus.UNKNOWN,
                failure or "native_completion_unverified",
                stopped=stopped,
                cache_tail_completed=cache_tail,
            )
        elif failure is not None:
            result = RequestCompletionResult(
                RequestCompletionStatus.FAILED,
                failure,
                stopped=stopped,
                cache_tail_completed=cache_tail,
            )
        else:
            result = RequestCompletionResult(
                RequestCompletionStatus.COMPLETE,
                stopped=stopped,
                cache_tail_completed=cache_tail,
            )
        return self._publish_terminal(result)

    async def _wait_empty(self) -> None:
        while True:
            with self._lock:
                if not self._members:
                    return
                self._changed.clear()
                if not self._members:
                    return
            await self._changed.wait()

    def _publish_terminal(self, result: RequestCompletionResult) -> RequestCompletionResult:
        with self._lock:
            if self._terminal is None:
                self._terminal = result
                self._state = _GroupState.TERMINAL
            terminal = self._terminal
            retain = bool(self._members or self._unresolved)
        if terminal is None:
            raise RuntimeError("request completion result is unavailable")
        with _groups_lock:
            if retain:
                _unresolved_groups[id(self)] = self
            else:
                _unresolved_groups.pop(id(self), None)
                _active_groups.pop(id(self), None)
        return terminal

    async def _wait_and_publish(self, timeout: float | None) -> RequestCompletionResult:
        self._check_loop()
        with self._lock:
            if self._terminal is not None:
                return self._terminal
            if self._owner_task is None:
                coro = self._completion_owner(timeout)
                try:
                    self._owner_task = self.loop.create_task(coro)
                    self._owner_task.add_done_callback(self._owner_finished)
                except BaseException:
                    coro.close()
                    with self._lock:
                        failure = self._first_failure or "request_completion_owner_unavailable"
                    return self._publish_terminal(
                        RequestCompletionResult(
                            RequestCompletionStatus.UNKNOWN,
                            failure,
                            stopped=self._stopped,
                            cache_tail_completed=self._cache_tail_completed,
                        )
                    )
            owner_task = self._owner_task
        try:
            return await asyncio.shield(owner_task)
        except asyncio.CancelledError:
            raise

    async def stop_and_wait(self, timeout: float | None = None) -> RequestCompletionResult:
        self.begin_stop()
        return await self._wait_and_publish(timeout)

    async def complete_and_wait(self, timeout: float | None = None) -> RequestCompletionResult:
        """Seal admission and report accepted work without requesting a stop."""

        self.seal()
        return await self._wait_and_publish(timeout)

    def _owner_finished(self, task: asyncio.Task[RequestCompletionResult]) -> None:
        with self._lock:
            if self._terminal is not None:
                return
            failure = self._first_failure
            stopped = self._stopped
            cache_tail = self._cache_tail_completed
        if task.cancelled():
            self._publish_terminal(
                RequestCompletionResult(
                    RequestCompletionStatus.UNKNOWN,
                    failure or "request_completion_owner_cancelled",
                    stopped=stopped,
                    cache_tail_completed=cache_tail,
                )
            )
            return
        with suppress(BaseException):
            task.exception()
        self._publish_terminal(
            RequestCompletionResult(
                RequestCompletionStatus.UNKNOWN,
                failure or "request_completion_owner_incomplete",
                stopped=stopped,
                cache_tail_completed=cache_tail,
            )
        )


def create_request_group(binding: RequestBinding) -> RequestGroup:
    """Create a bounded group on the current loop; caller provenance is external."""

    if not isinstance(binding, RequestBinding):
        raise TypeError("invalid request binding")
    loop = asyncio.get_running_loop()
    with _groups_lock:
        if len(_groups) >= MAX_REQUEST_GROUPS:
            raise RuntimeError("request group capacity reached")
        group = RequestGroup(binding, loop)
        _groups[id(group)] = group
        _active_groups[id(group)] = group
        return group


@contextmanager
def bind_request_group(group: RequestGroup):
    """Attach an exact group for an admitted async execution scope."""

    if not isinstance(group, RequestGroup):
        raise RuntimeError("request group is unavailable")
    with _groups_lock:
        if _groups.get(id(group)) is not group and _unresolved_groups.get(id(group)) is not group:
            raise RuntimeError("request group is unavailable")
    group._check_loop()
    if not group.is_open:
        raise RuntimeError("request group is closed")
    marker = _active_group.set(group)
    try:
        yield group
    finally:
        _active_group.reset(marker)


def current_request_group() -> RequestGroup | None:
    group = _active_group.get()
    if group is None:
        return None
    try:
        group._check_loop()
    except RuntimeError:
        if not _authorized_worker_member(group, _active_member.get()):
            # A copied context is not permission to become an ungrouped legacy
            # call on another loop or an arbitrary executor thread.
            raise
    return group


@contextmanager
def bind_request_member(member: RequestMember, *, operation: Any = None):
    """Install one admitted member only for its current execution scope."""

    worker_authorization = None
    try:
        member.group._check_loop()
    except RuntimeError:
        active_group = _active_group.get()
        active_member = _active_member.get()
        inherited = (
            operation is None
            and active_group is member.group
            and active_member is member
            and _authorized_worker_member(member.group, member)
        )
        if inherited:
            worker_authorization = _worker_authorization.get()
        elif operation is None or not _operation_authorizes_member(operation, member):
            raise
        else:
            worker_authorization = (member, operation, threading.get_ident())
    with member.group._lock:
        if member.group._members.get(member.sequence) is not member:
            raise RuntimeError("request member is no longer admitted")
    active_group = _active_group.get()
    active_member = _active_member.get()
    if active_group not in (None, member.group):
        raise RuntimeError("request member capability does not match")
    if active_member is not None and active_member.group is not member.group:
        raise RuntimeError("request member capability does not match")
    group_marker = _active_group.set(member.group)
    marker = _active_member.set(member)
    worker_marker = (
        _worker_authorization.set(worker_authorization)
        if worker_authorization is not None
        else None
    )
    try:
        yield member
    finally:
        if worker_marker is not None:
            _worker_authorization.reset(worker_marker)
        _active_member.reset(marker)
        _active_group.reset(group_marker)


_active_member: contextvars.ContextVar[RequestMember | None] = contextvars.ContextVar(
    "aurora_native_request_member", default=None
)
_worker_authorization: contextvars.ContextVar[tuple[RequestMember, Any, int] | None] = (
    contextvars.ContextVar("aurora_native_request_worker_authorization", default=None)
)


def _operation_authorizes_member(operation: Any, member: RequestMember) -> bool:
    """Accept only the exact operation currently executing this body."""

    lifecycle = getattr(operation, "lifecycle", None)
    if (
        getattr(operation, "request_member", None) is not member
        or lifecycle is None
        or getattr(operation, "worker_thread_id", None) != threading.get_ident()
    ):
        return False
    with lifecycle.lock, member.group._lock:
        return (
            lifecycle.operations.get(getattr(operation, "sequence", None)) is operation
            and getattr(getattr(operation, "state", None), "value", None)
            in ("body_running", "unknown")
            and member.group._members.get(member.sequence) is member
        )


def _authorized_worker_member(group: RequestGroup, member: RequestMember | None) -> bool:
    authorization = _worker_authorization.get()
    if authorization is None or member is None or authorization[0] is not member:
        return False
    authorized_member, operation, thread_id = authorization
    return (
        authorized_member.group is group
        and thread_id == threading.get_ident()
        and _operation_authorizes_member(operation, authorized_member)
    )


def current_request_member() -> RequestMember | None:
    member = _active_member.get()
    if member is None:
        return None
    group = member.group
    try:
        group._check_loop()
    except RuntimeError:
        if not _authorized_worker_member(group, member):
            raise
    with group._lock:
        return member if group._members.get(member.sequence) is member else None


@contextmanager
def request_member_scope(kind: str, *, resource: Any = None):
    """Reuse only the enclosing context lease member; otherwise admit a child."""

    member, owned = admit_request_member(kind, resource=resource)
    if member is None or not owned:
        yield member, False
        return
    try:
        with bind_request_member(member):
            yield member, True
    finally:
        if not member.scope_finished:
            finish_request_member(member, owned=True, reason="request_member_scope_unresolved")


def admit_request_member(kind: str, *, resource: Any = None) -> tuple[RequestMember | None, bool]:
    """Admit a member without installing a ContextVar across a stream yield."""

    existing = current_request_member()
    group = existing.group if existing is not None else current_request_group()
    if group is None:
        return None, False
    if existing is not None and _worker_authorization.get() is not None:
        # Public async admission cannot be nested from an executor callback.
        # Worker-side iterator advancement binds its exact operation directly.
        raise RuntimeError("request member cannot be reused from callback work")
    reuse_context = (
        existing is not None
        and existing.resource is resource
        and kind == "native_context"
        and existing.kind == "native_operation"
    )
    if not reuse_context and existing is not None and kind == "native_operation":
        try:
            from app.services.orchestrator.llama_context_owner import (
                context_member_is_active,
            )

            reuse_context = (
                existing.resource is resource
                and existing.kind == "native_context"
                and context_member_is_active(existing, resource)
            )
        except BaseException:
            reuse_context = False
    if not reuse_context and existing is not None and kind in ("native_context", "native_stream"):
        try:
            from app.services.orchestrator.llama_context_owner import (
                context_member_is_active,
            )

            reuse_context = existing.resource is resource and context_member_is_active(
                existing, resource
            )
        except BaseException:
            reuse_context = False
    if reuse_context:
        return existing, False
    try:
        member = group.admit(kind, resource=resource)
    except BaseException:
        if existing is not None:
            group.fail(existing, "nested_request_admission_unavailable", unknown=True)
        raise
    return member, True


def admit_direct_request_member(
    resource: Any,
) -> tuple[RequestMember | None, bool]:
    """Admit one direct synchronous provider lifetime to the active request.

    A worker-side wrapper may reuse only the exact member authorized by its
    currently executing native operation. On the owning event loop, direct
    wrapper lifetimes get their own member unless an active native-context
    member is the exact same resource and can safely contain them.
    """

    existing = current_request_member()
    authorization = _worker_authorization.get()
    if authorization is not None:
        if (
            existing is authorization[0]
            and authorization[1].owner is resource
            and _operation_authorizes_member(authorization[1], existing)
        ):
            return existing, False
        raise RuntimeError("request member is unavailable")
    return admit_request_member("native_operation", resource=resource)


def finish_request_member(
    member: RequestMember | None,
    *,
    owned: bool,
    reason: str | None = None,
    stopped: bool = False,
) -> None:
    """Settle only a scope that created the member, preserving uncertainty."""

    if member is None or not owned:
        return
    if member.scope_finished:
        return
    with member.group._lock:
        status = member.native_status
        if status not in ("complete", "stopped", "failed", "unknown"):
            status = "unknown"
        if stopped and status == "complete":
            status = "stopped"
        if member.native_unknown:
            status = "unknown"
        if (
            not member.native_seen
            and not member.native_not_submitted
            and status in ("complete", "stopped")
        ):
            status = "unknown"
    if status in ("complete", "stopped"):
        reason = None
    member.group.settle(
        member,
        native_status=status,
        reason=reason or member.reason,
        cache_tail_completed=(
            member.cache_tail_completed
            if member.cache_tail_completed is not None
            else (False if stopped else None)
        ),
    )
    member.scope_finished = True


def mark_current_native_completion(
    *,
    known: bool,
    reason: str | None = None,
    stopped: bool = False,
    cache_tail_completed: bool | None = None,
) -> None:
    """Record backend evidence on the exact accepted member, when one exists."""

    member = current_request_member()
    mark_request_member_completion(
        member,
        known=known,
        reason=reason,
        stopped=stopped,
        cache_tail_completed=cache_tail_completed,
    )


def mark_request_member_completion(
    member: RequestMember | None,
    *,
    known: bool,
    reason: str | None = None,
    stopped: bool = False,
    cache_tail_completed: bool | None = None,
) -> None:
    """Record confirmed backend cleanup on one retained member."""

    if member is None:
        return
    member.group.mark_native_work(member, known=known)
    with member.group._lock:
        if member.reason is None and reason is not None:
            member.reason = reason
        if reason is not None and member.group._first_failure is None:
            member.group._first_failure = reason
        if known and stopped and not member.native_unknown and member.native_status != "failed":
            member.native_status = "stopped"
            if reason is not None and member.group._first_failure is None:
                member.group._first_failure = reason
        if cache_tail_completed is False:
            member.cache_tail_completed = False
        elif cache_tail_completed is True and member.cache_tail_completed is None:
            member.cache_tail_completed = True
        member.group._recompute_cache_tail_locked()

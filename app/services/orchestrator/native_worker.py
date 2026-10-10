"""Retained ownership for synchronous native-provider work and retirement."""

from __future__ import annotations

import asyncio
import contextvars
import inspect
import queue as thread_queue
import sys
import threading
import weakref
from collections.abc import Callable
from contextlib import contextmanager, nullcontext, suppress
from dataclasses import dataclass, field
from enum import Enum
from functools import wraps
from typing import Any

MAX_PROVIDER_LIFECYCLES = 256
MAX_PROVIDER_OPERATIONS = 128
MAX_PROVIDER_STREAMS = 32
# A generation can own both the wrapper iterator and its nested client
# iterator. Reserve both before admission while still permitting the existing
# per-provider limit of 128 accepted operations.
MAX_PROVIDER_CLEANUP_REFERENCES = 256
MAX_CONTEXT_CLEANUP_CREDITS = 128
_MAX_SEQUENCE = (1 << 63) - 1
_CURRENT_MEMBER = object()

# These compatibility indexes are diagnostic only. Lifecycle authority is the
# retained object-identity registry below, never an integer id by itself.
_worker_tasks: dict[int, set[asyncio.Task]] = {}
_stream_tasks: dict[int, set[asyncio.Task]] = {}
_registry_guard = threading.RLock()
_lifecycles: dict[int, _ProviderLifecycle] = {}
_direct_calls: dict[int, _DirectCallRecord] = {}
_AUTO_CLOSE_TARGET = object()
_current_operation: contextvars.ContextVar[_Operation | None] = contextvars.ContextVar(
    "aurora_native_provider_operation", default=None
)
_direct_call_tokens: contextvars.ContextVar[tuple[_DirectCallToken, ...]] = contextvars.ContextVar(
    "aurora_native_direct_call_tokens", default=()
)
_cleanup_callback_active: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "aurora_native_cleanup_callback_active", default=False
)


class ProviderUnavailableError(RuntimeError):
    """Fixed, user-safe rejection for a request that cannot be completed."""

    def __init__(self, _detail: str | None = None) -> None:
        super().__init__("Aurora cannot complete this request right now.")


class _OperationCapacityError(Exception):
    """Internal signal that required cleanup must wait for a reserved slot."""


class RetirementStatus(str, Enum):
    COMPLETE = "complete"
    FAILED = "failed"
    UNKNOWN = "unknown"
    DEADLINE_EXCEEDED = "deadline_exceeded"


@dataclass(frozen=True)
class RetirementResult:
    status: RetirementStatus
    failure: str | None = None


@dataclass(frozen=True)
class _CloseInvocation:
    available: bool
    result: Any = None
    unknown: bool = False
    failed: bool = False


@dataclass(frozen=True)
class _CloseSelection:
    available: bool
    target: Any = None
    method_name: str | None = None
    pinned_method: Callable[[Any], Any] | None = None


_MISSING = object()


@dataclass
class _BodyOutcome:
    returned: bool
    value: Any = None
    error: BaseException | None = None


class _OperationState(str, Enum):
    NOT_SUBMITTED = "not_submitted"
    SUBMISSION_ATTEMPTED = "submission_attempted"
    BODY_RUNNING = "body_running"
    BODY_RETURNED = "body_returned"
    BODY_RAISED = "body_raised"
    UNKNOWN = "unknown"


@dataclass
class _Operation:
    lifecycle: _ProviderLifecycle
    sequence: int
    owner: Any
    loop: asyncio.AbstractEventLoop
    completion: asyncio.Future[None]
    settled: asyncio.Event
    request_member: Any = None
    context_lease: Any = None
    worker_returned: threading.Event = field(default_factory=threading.Event)
    state: _OperationState = _OperationState.NOT_SUBMITTED
    outcome: _BodyOutcome | None = None
    task: asyncio.Task | None = None
    references: tuple[Any, ...] = ()
    transfer_required: bool = False
    transfer_acknowledged: bool = False
    lease: _StreamLease | None = None
    stream_action: str | None = None
    cleanup_failure: str | None = None
    cleanup_reservations: int = 0
    lease_cleanup_reservations: int = 0
    progress_cleanup_reservations: int = 0
    cancelled_before_submission: bool = False
    settlement_unknown: bool = False
    retained: bool = True
    worker_thread_id: int | None = None
    progress_reservation: _ProgressReservation | None = None
    runner: _NativeCommandRunner | None = None
    execution_context: contextvars.Context | None = None
    runner_returned: threading.Event = field(default_factory=threading.Event)
    runner_settled: asyncio.Future[None] | None = None
    close_body_target: Any = None
    close_body_entered: bool = False
    registered_close_iterator: Any = None


@dataclass
class _StreamLease:
    lifecycle: _ProviderLifecycle
    sequence: int
    owner: Any
    loop: asyncio.AbstractEventLoop
    task: asyncio.Task | None = None
    iterator: Any = None
    active: bool = True
    started: bool = False
    stop_requested: bool = False
    close_started: bool = False
    cleanup_complete: bool = False
    cleanup_unknown: bool = False
    cleanup_reservations: int = 0
    consumer_wake: Callable[[], None] | None = None
    stop_event: asyncio.Event | None = None
    terminal_waiting: asyncio.Event | None = None
    request_member: Any = None
    progress_reservation: _ProgressReservation | None = None
    owns_progress_reservation: bool = False
    context_lease: Any = None
    pending_setup: Any = None
    consumer_failure: Callable[[BaseException], None] | None = None
    cleanup_from_progress: bool = False
    stop_callback: Callable[[], None] | None = None
    publication_tasks: list[asyncio.Task] = field(default_factory=list)
    publication_coroutines: list[Any] = field(default_factory=list)
    publication_task_captures: list[list[asyncio.Task | None]] = field(default_factory=list)
    publication_unknown: bool = False


@dataclass
class _ProgressReservation:
    lifecycle: _ProviderLifecycle
    owner: Any
    active: bool = True
    in_flight: bool = False
    release_requested: bool = False
    runner: _NativeCommandRunner | None = None
    context_lease: Any = None
    cleanup_reservations: int = 0


@dataclass
class _RunnerCommand:
    operation: _Operation
    function: Callable[..., Any]
    args: tuple[Any, ...]
    kwargs: dict[str, Any]


@dataclass
class _NativeCommandRunner:
    """One retained existing-executor worker for an admitted native lifetime."""

    lifecycle: _ProviderLifecycle
    owner: Any
    loop: asyncio.AbstractEventLoop
    reservation: _ProgressReservation
    mailbox: thread_queue.Queue[_RunnerCommand | None] = field(
        default_factory=lambda: thread_queue.Queue(maxsize=1)
    )
    future: asyncio.Future[Any] | None = None
    worker_returned: threading.Event = field(default_factory=threading.Event)
    closing: bool = False
    unknown: bool = False


@dataclass
class _ProviderLifecycle:
    key: int
    loop: asyncio.AbstractEventLoop
    lock: threading.RLock = field(default_factory=threading.RLock)
    weak_owner: weakref.ReferenceType[Any] | None = None
    strong_owner: Any = None
    weak_referenceable: bool = True
    state: str = "open"
    admission_open: bool = True
    loop_lost: bool = False
    uncertain: bool = False
    failure: str | None = None
    deadline_result: RetirementResult | None = None
    terminal_result: RetirementResult | None = None
    retirement_task: asyncio.Task | None = None
    retirement_close_target: Any = None
    retirement_owner: Any = None
    changed: asyncio.Event | None = None
    actual_changed: threading.Event = field(default_factory=threading.Event)
    operations: dict[int, _Operation] = field(default_factory=dict)
    streams: dict[int, _StreamLease] = field(default_factory=dict)
    progress_credits: dict[int, _ProgressReservation] = field(default_factory=dict)
    direct_operations: int = 0
    cleanup_references: list[Any] = field(default_factory=list)
    cleanup_reservations: int = 0
    progress_reservations: int = 0
    next_operation: int = 0
    next_stream: int = 0

    def owner(self) -> Any:
        if self.weak_owner is not None:
            return self.weak_owner()
        return self.strong_owner


@dataclass
class _DirectCallRecord:
    """Temporary exact-owner admission while a sync wrapper runs directly."""

    owner: Any
    active: int = 0
    lifecycle: _ProviderLifecycle | None = None
    cleanup_reservations: int = 0
    tokens: dict[int, _DirectCallToken] = field(default_factory=dict)


@dataclass
class _DirectCallToken:
    owner: Any
    record: _DirectCallRecord
    cleanup_reservations: int
    lease_cleanup_source: _StreamLease | None = None
    lease_cleanup_credit: int = 0
    progress_cleanup_source: _ProgressReservation | None = None
    progress_cleanup_credit: int = 0
    independent_cleanup_credit: int = 0
    request_member: Any = None
    owns_request_member: bool = False
    callable_attempted: bool = False
    native_entry_attempted: bool = False
    nested_generator_slots: int = 0
    nested_generator_method: str | None = None
    nested_generator_parent_code: Any = None
    nested_generator_parent_frame: Any = None
    nested_generator_child_callable: Any = None
    nested_generator_child_code: Any = None
    nested_generator_iterator: Any = None
    structural_unstarted_child: Any = None
    sealed_unstarted_iterator: Any = None
    _sealed_unstarted: bool = False
    iterator: Any = None
    retained_context_manager: Any = None
    retained_context_lease: Any = None
    retained_context_state: str = "none"
    retained_context_lock: threading.RLock = field(default_factory=threading.RLock)
    retained_context_ready: asyncio.Future[Any] | None = None
    retained_context_loop: asyncio.AbstractEventLoop | None = None
    retained_terminal_pending: bool = False
    active_thread_id: int | None = None
    active_depth: int = 0


@dataclass
class _DirectCleanupRecord:
    key: int
    failure: str
    uncertain: bool
    weak_owner: weakref.ReferenceType[Any] | None = None
    strong_owner: Any = None
    references: tuple[Any, ...] = ()

    def owner(self) -> Any:
        if self.weak_owner is not None:
            return self.weak_owner()
        return self.strong_owner


_direct_cleanups: dict[int, _DirectCleanupRecord] = {}
_direct_cleanup_overflow = False


def _retained_identity_count() -> int:
    """Count distinct identities across active and unresolved registries."""

    keys = set(_lifecycles)
    keys.update(_direct_cleanups)
    keys.update(owner_id for owner_id, record in _direct_calls.items() if record.lifecycle is None)
    return len(keys)


def _retain_cleanup_reference(
    lifecycle: _ProviderLifecycle, reference: Any, *, reserved: bool = False
) -> bool:
    if any(existing is reference for existing in lifecycle.cleanup_references):
        return False
    reserved_count = lifecycle.cleanup_reservations - (1 if reserved else 0)
    if len(lifecycle.cleanup_references) + reserved_count >= MAX_PROVIDER_CLEANUP_REFERENCES:
        lifecycle.uncertain = True
        lifecycle.admission_open = False
        lifecycle.state = "retiring"
        lifecycle.failure = lifecycle.failure or "cleanup_ownership_capacity_reached"
        return False
    if reserved:
        lifecycle.cleanup_reservations = max(0, lifecycle.cleanup_reservations - 1)
    lifecycle.cleanup_references.append(reference)
    owner = lifecycle.owner()
    if owner is not None:
        lifecycle.strong_owner = owner
    return True


def _apply_cleanup_to_lifecycle(
    lifecycle: _ProviderLifecycle,
    failure: str,
    uncertain: bool,
    references: tuple[Any, ...] = (),
) -> None:
    with lifecycle.lock:
        if lifecycle.failure is None:
            lifecycle.failure = failure
        lifecycle.uncertain = lifecycle.uncertain or uncertain
        if uncertain:
            lifecycle.admission_open = False
            lifecycle.state = "retiring"
        for reference in references:
            _retain_cleanup_reference(lifecycle, reference)


def _remove_dead_direct_cleanup(key: int, record: _DirectCleanupRecord) -> None:
    with _registry_guard:
        if _direct_cleanups.get(key) is record:
            _direct_cleanups.pop(key, None)


def _remove_dead_owner(owner_id: int, lifecycle: _ProviderLifecycle) -> None:
    with _registry_guard:
        if _lifecycles.get(owner_id) is lifecycle:
            _lifecycles.pop(owner_id, None)


def provider_owner(instance: Any) -> Any:
    """Find the underlying provider behind a bound runnable when available."""

    from app.services.orchestrator.llama_context_owner import canonical_native_owner

    seen: set[int] = set()
    current = instance
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        # A constructor-pinned wrapper binding is stronger than a mutable
        # public ``bound`` attribute. Resolve it before following that field so
        # disposal still joins the original owner after dispatch detects a
        # changed binding.
        retained = canonical_native_owner(current, validate=False)
        if retained is not current:
            return retained
        missing = object()
        if inspect.getattr_static(current, "bound", missing) is missing:
            return current
        bound = getattr(current, "bound", None)
        if bound is None:
            return canonical_native_owner(current, validate=False)
        if bound is current:
            return instance
        current = bound
    # If traversal stopped because this input leads into a bound-wrapper cycle,
    # preserve the baseline identity contract and return the original input.
    # Constructor-pinned owners were already resolved at each visited node
    # above, before following mutable ``bound`` links.
    if current is not None and id(current) in seen:
        return instance
    # Resolve identity without requiring a healthy binding here. Retirement
    # must still find and join the retained owner after dispatch validation has
    # quarantined a changed wrapper/client binding.
    return canonical_native_owner(current, validate=False)


def _new_lifecycle(owner: Any, loop: asyncio.AbstractEventLoop) -> _ProviderLifecycle:
    owner_id = id(owner)
    lifecycle = _ProviderLifecycle(key=owner_id, loop=loop)
    lifecycle.changed = asyncio.Event()
    try:
        lifecycle.weak_owner = weakref.ref(
            owner,
            lambda _ref, key=owner_id, life=lifecycle: _remove_dead_owner(key, life),
        )
    except TypeError:
        lifecycle.weak_referenceable = False
        lifecycle.strong_owner = owner
    return lifecycle


def _attach_direct_calls(lifecycle: _ProviderLifecycle, owner: Any) -> None:
    """Attach pre-lifecycle synchronous work under the registry lock."""

    record = _direct_calls.get(id(owner))
    if record is None or record.owner is not owner:
        return
    if record.lifecycle is not None and record.lifecycle is not lifecycle:
        raise ProviderUnavailableError("Provider identity is unavailable")
    if record.lifecycle is None:
        with lifecycle.lock:
            lifecycle.direct_operations += record.active
            lifecycle.cleanup_reservations += record.cleanup_reservations
        record.lifecycle = lifecycle
        record.cleanup_reservations = 0


def _get_lifecycle(
    owner: Any,
    loop: asyncio.AbstractEventLoop,
    *,
    create: bool,
) -> _ProviderLifecycle:
    global _direct_cleanup_overflow
    owner_id = id(owner)
    with _registry_guard:
        lifecycle = _lifecycles.get(owner_id)
        if lifecycle is not None:
            retained_owner = lifecycle.owner()
            if retained_owner is owner:
                if lifecycle.loop is not loop:
                    raise ProviderUnavailableError(
                        "Provider lifecycle belongs to another event loop"
                    )
                pending_cleanup = _direct_cleanups.get(owner_id)
                if pending_cleanup is not None and pending_cleanup.owner() is owner:
                    _direct_cleanups.pop(owner_id, None)
                    _apply_cleanup_to_lifecycle(
                        lifecycle,
                        pending_cleanup.failure,
                        pending_cleanup.uncertain,
                        pending_cleanup.references,
                    )
                _attach_direct_calls(lifecycle, owner)
                return lifecycle
            # A dead weak owner may be replaced only when the exact old entry
            # has no outstanding work. Active operations retain their owner.
            if (
                retained_owner is None
                and not lifecycle.operations
                and not lifecycle.streams
                and lifecycle.direct_operations == 0
            ):
                _lifecycles.pop(owner_id, None)
                lifecycle = None
            else:
                raise ProviderUnavailableError("Provider identity is unavailable")
        if not create:
            raise ProviderUnavailableError("Provider lifecycle is unavailable")
        if _direct_cleanup_overflow:
            raise ProviderUnavailableError("Provider lifecycle capacity reached")
        pending_cleanup = _direct_cleanups.get(owner_id)
        if pending_cleanup is not None and pending_cleanup.owner() is owner:
            _direct_cleanups.pop(owner_id, None)
        else:
            pending_cleanup = None
        known_identity = (
            owner_id in _lifecycles
            or (pending_cleanup is not None)
            or (owner_id in _direct_calls and _direct_calls[owner_id].owner is owner)
        )
        if not known_identity and _retained_identity_count() >= MAX_PROVIDER_LIFECYCLES:
            raise ProviderUnavailableError("Provider lifecycle capacity reached")
        lifecycle = _new_lifecycle(owner, loop)
        if pending_cleanup is not None:
            _apply_cleanup_to_lifecycle(
                lifecycle,
                pending_cleanup.failure,
                pending_cleanup.uncertain,
                pending_cleanup.references,
            )
        _lifecycles[owner_id] = lifecycle
        _attach_direct_calls(lifecycle, owner)
        return lifecycle


def reserve_provider_progress(
    owner: Any,
    loop: asyncio.AbstractEventLoop,
    *,
    cleanup_slots: int = 0,
) -> _ProgressReservation:
    """Reserve one operation slot for checked cleanup before native admission."""

    lifecycle = _get_lifecycle(owner, loop, create=True)
    with lifecycle.lock:
        if not lifecycle.admission_open or lifecycle.state != "open":
            raise ProviderUnavailableError("Provider is retired")
        if (
            cleanup_slots < 0
            or len(lifecycle.cleanup_references) + lifecycle.cleanup_reservations + cleanup_slots
            > MAX_PROVIDER_CLEANUP_REFERENCES
        ):
            raise ProviderUnavailableError("Provider cleanup capacity reached")
        if len(lifecycle.operations) + lifecycle.progress_reservations >= MAX_PROVIDER_OPERATIONS:
            raise ProviderUnavailableError("Provider operation capacity reached")
        lifecycle.progress_reservations += 1
        lifecycle.cleanup_reservations += cleanup_slots
        reservation = _ProgressReservation(lifecycle, owner, cleanup_reservations=cleanup_slots)
        lifecycle.progress_credits[id(reservation)] = reservation
        return reservation


def validate_provider_progress(reservation: _ProgressReservation | None, owner: Any) -> bool:
    """Validate the exact issued progress credit before any runner use."""

    if reservation is None:
        return False
    lifecycle = reservation.lifecycle
    with _registry_guard, lifecycle.lock:
        return (
            lifecycle.owner() is owner
            and reservation.owner is owner
            and reservation.lifecycle is lifecycle
            and reservation.active
            and lifecycle.progress_credits.get(id(reservation)) is reservation
        )


def ensure_provider_cleanup_progress(
    reservation: _ProgressReservation | None, owner: Any, required_slots: int
) -> bool:
    """Top up an exact issued credit before its admitted lifetime starts."""

    if reservation is None or required_slots < 0:
        return False
    lifecycle = reservation.lifecycle
    with _registry_guard, lifecycle.lock:
        if not (
            lifecycle.owner() is owner
            and reservation.owner is owner
            and reservation.active
            and lifecycle.progress_credits.get(id(reservation)) is reservation
        ):
            return False
        missing = max(0, required_slots - reservation.cleanup_reservations)
        if (
            len(lifecycle.cleanup_references) + lifecycle.cleanup_reservations + missing
            > MAX_PROVIDER_CLEANUP_REFERENCES
        ):
            return False
        reservation.cleanup_reservations += missing
        lifecycle.cleanup_reservations += missing
        return True


def release_provider_progress(reservation: _ProgressReservation | None) -> None:
    """Release an unused checked-progress slot without disturbing a running op."""

    if reservation is None:
        return
    lifecycle = reservation.lifecycle
    with lifecycle.lock:
        if (
            not reservation.active
            or lifecycle.progress_credits.get(id(reservation)) is not reservation
        ):
            return
        reservation.release_requested = True
        if not reservation.in_flight:
            reservation.active = False
            reservation.release_requested = False
            lifecycle.progress_reservations = max(0, lifecycle.progress_reservations - 1)
            if lifecycle.progress_credits.get(id(reservation)) is reservation:
                lifecycle.progress_credits.pop(id(reservation), None)
            lifecycle.cleanup_reservations = max(
                0, lifecycle.cleanup_reservations - reservation.cleanup_reservations
            )
            reservation.cleanup_reservations = 0
    _signal_lifecycle(lifecycle)


def _active_operation_for(owner: Any) -> _Operation | None:
    operation = _current_operation.get()
    if operation is None or operation.owner is not owner:
        return None
    lifecycle = operation.lifecycle
    with lifecycle.lock:
        if (
            lifecycle.operations.get(operation.sequence) is operation
            and operation.state
            in (
                _OperationState.SUBMISSION_ATTEMPTED,
                _OperationState.BODY_RUNNING,
                _OperationState.UNKNOWN,
            )
            and operation.retained
            and operation.worker_thread_id == threading.get_ident()
        ):
            return operation
    return None


def _active_direct_token_for(owner: Any) -> _DirectCallToken | None:
    for token in reversed(_direct_call_tokens.get()):
        if token.owner is not owner:
            continue
        with _registry_guard:
            record = _direct_calls.get(id(owner))
            if (
                record is token.record
                and record.owner is owner
                and record.active > 0
                and token.active_thread_id == threading.get_ident()
                and token.active_depth > 0
            ):
                return token
    return None


def note_direct_native_entry(owner: Any) -> None:
    """Record actual entry through a pinned native wrapper for a direct call."""

    token = _active_direct_token_for(owner)
    if token is not None:
        token.native_entry_attempted = True


def _claim_nested_generator_slot(
    token: _DirectCallToken, method_name: str, iterator: Any
) -> _DirectCallToken | None:
    """Validate a child permit; admission consumes it only after reservation."""

    if _cleanup_callback_active.get():
        return None
    with _registry_guard:
        record = _direct_calls.get(id(token.owner))
        if (
            record is not token.record
            or record.owner is not token.owner
            or record.active <= 0
            or token.active_thread_id != threading.get_ident()
            or token.active_depth <= 0
            or token.nested_generator_slots <= 0
            or token.nested_generator_method != method_name
            or token.nested_generator_iterator is not iterator
            or token.cleanup_reservations <= 0
        ):
            return None
        return token


def _bind_nested_generator_slot(
    token: _DirectCallToken,
    method_name: str,
    iterator: Any,
    caller_frame: Any,
    child_code: Any,
) -> bool:
    """Bind the parent's one-use slot to this exact constructed child."""

    with _registry_guard:
        record = _direct_calls.get(id(token.owner))
        if (
            record is not token.record
            or record.owner is not token.owner
            or record.active <= 0
            or token.active_thread_id != threading.get_ident()
            or token.active_depth <= 0
            or token.nested_generator_slots <= 0
            or token.nested_generator_method != method_name
            or token.nested_generator_parent_code is None
            or token.nested_generator_child_code is not child_code
            or caller_frame is None
            or caller_frame.f_code is not token.nested_generator_parent_code
            or caller_frame.f_back is not token.nested_generator_parent_frame
            or caller_frame.f_locals.get("self") is not iterator._provider
            or token.nested_generator_iterator is not None
        ):
            return False
        token.nested_generator_iterator = iterator
        return True


def _enter_direct_token(token: _DirectCallToken) -> None:
    thread_id = threading.get_ident()
    with _registry_guard:
        record = _direct_calls.get(id(token.owner))
        if record is not token.record or record.owner is not token.owner or record.active <= 0:
            raise ProviderUnavailableError("Provider is unavailable")
        if token.active_thread_id not in (None, thread_id):
            raise ProviderUnavailableError("Provider is unavailable")
        token.active_thread_id = thread_id
        token.active_depth += 1


def _exit_direct_token(token: _DirectCallToken) -> None:
    with _registry_guard:
        if token.active_thread_id != threading.get_ident() or token.active_depth <= 0:
            return
        token.active_depth -= 1
        if token.active_depth == 0:
            token.active_thread_id = None


def _admit_direct_call(
    owner: Any,
    cleanup_slots: int,
    *,
    inherited_operation: _Operation | None = None,
    inherited_direct_token: _DirectCallToken | None = None,
    nested_generator_slots: int = 0,
    nested_generator_method: str | None = None,
    nested_generator_parent_code: Any = None,
    nested_generator_parent_frame: Any = None,
    nested_generator_child_callable: Any = None,
    nested_generator_child_code: Any = None,
) -> _DirectCallToken:
    """Reserve one synchronous wrapper call before it touches the provider."""

    if _cleanup_callback_active.get():
        raise ProviderUnavailableError("Provider is unavailable")
    global _direct_cleanup_overflow
    owner_id = id(owner)
    with _registry_guard:
        if _direct_cleanup_overflow:
            raise ProviderUnavailableError("Provider cleanup capacity reached")
        lifecycle = _lifecycles.get(owner_id)
        record = _direct_calls.get(owner_id)
        inherited_direct = (
            inherited_direct_token is not None
            and inherited_direct_token.owner is owner
            and inherited_direct_token.record is record
            and record is not None
            and record.owner is owner
            and record.active > 0
            and inherited_direct_token.active_thread_id == threading.get_ident()
            and inherited_direct_token.active_depth > 0
        )
        lease_cleanup_source = None
        lease_cleanup_credit = 0
        progress_cleanup_source = None
        progress_cleanup_credit = 0
        independent_cleanup_credit = 0
        if lifecycle is not None:
            if lifecycle.owner() is not owner:
                raise ProviderUnavailableError("Provider identity is unavailable")
            pending_cleanup = _direct_cleanups.get(owner_id)
            if pending_cleanup is not None and pending_cleanup.owner() is owner:
                _direct_cleanups.pop(owner_id, None)
                _apply_cleanup_to_lifecycle(
                    lifecycle,
                    pending_cleanup.failure,
                    pending_cleanup.uncertain,
                    pending_cleanup.references,
                )
            inherited = (
                inherited_operation is not None
                and inherited_operation.owner is owner
                and inherited_operation.lifecycle is lifecycle
                and lifecycle.operations.get(inherited_operation.sequence) is inherited_operation
                and inherited_operation.state
                in (
                    _OperationState.SUBMISSION_ATTEMPTED,
                    _OperationState.BODY_RUNNING,
                    _OperationState.UNKNOWN,
                )
                and inherited_operation.worker_thread_id == threading.get_ident()
            )
            with lifecycle.lock:
                if (
                    (not lifecycle.admission_open or lifecycle.state != "open")
                    and not inherited
                    and not inherited_direct
                ):
                    raise ProviderUnavailableError("Provider is retired")
            _attach_direct_calls(lifecycle, owner)
        else:
            pending_cleanup = _direct_cleanups.get(owner_id)
            if pending_cleanup is not None and pending_cleanup.owner() is owner:
                raise ProviderUnavailableError("Provider cleanup is unresolved")

        record = _direct_calls.get(owner_id)
        if record is not None and record.owner is not owner:
            raise ProviderUnavailableError("Provider identity is unavailable")
        inherited_direct = (
            inherited_direct_token is not None
            and inherited_direct_token.owner is owner
            and inherited_direct_token.record is record
            and record is not None
            and record.owner is owner
            and record.active > 0
            and inherited_direct_token.active_thread_id == threading.get_ident()
            and inherited_direct_token.active_depth > 0
        )
        if record is None:
            known_identity = lifecycle is not None or (
                pending_cleanup is not None and pending_cleanup.owner() is owner
            )
            if not known_identity and _retained_identity_count() >= MAX_PROVIDER_LIFECYCLES:
                raise ProviderUnavailableError("Provider lifecycle capacity reached")
            record = _DirectCallRecord(owner=owner, lifecycle=lifecycle)
            _direct_calls[owner_id] = record
        elif record.lifecycle is not None and record.lifecycle is not lifecycle:
            raise ProviderUnavailableError("Provider identity is unavailable")
        if record.active >= MAX_PROVIDER_OPERATIONS:
            raise ProviderUnavailableError("Provider operation capacity reached")
        if lifecycle is not None:
            with lifecycle.lock:
                inherited = (
                    inherited_operation is not None
                    and inherited_operation.owner is owner
                    and inherited_operation.lifecycle is lifecycle
                    and lifecycle.operations.get(inherited_operation.sequence)
                    is inherited_operation
                    and inherited_operation.state
                    in (
                        _OperationState.SUBMISSION_ATTEMPTED,
                        _OperationState.BODY_RUNNING,
                        _OperationState.UNKNOWN,
                    )
                    and inherited_operation.worker_thread_id == threading.get_ident()
                )
                if (
                    (not lifecycle.admission_open or lifecycle.state != "open")
                    and not inherited
                    and not inherited_direct
                ):
                    if record.active == 0:
                        _direct_calls.pop(owner_id, None)
                    raise ProviderUnavailableError("Provider is retired")
                transferred = 0
                transferred_lease = 0
                transferred_progress = 0
                transferred_independent = 0
                borrowed_progress = 0
                # Only the outermost direct wrapper may reuse the operation's
                # own pre-reserved cleanup budget. A nested direct call from a
                # callback is independent work and must reserve its cleanup
                # paths in addition to the still-live outer stream.
                if inherited and inherited_direct_token is None:
                    transferred = min(cleanup_slots, inherited_operation.cleanup_reservations)
                    inherited_operation.cleanup_reservations -= transferred
                    transferred_lease = min(
                        transferred,
                        inherited_operation.lease_cleanup_reservations,
                    )
                    inherited_operation.lease_cleanup_reservations -= transferred_lease
                    remaining_transfer = transferred - transferred_lease
                    transferred_progress = min(
                        remaining_transfer,
                        inherited_operation.progress_cleanup_reservations,
                    )
                    inherited_operation.progress_cleanup_reservations -= transferred_progress
                    transferred_independent = remaining_transfer - transferred_progress
                    lease_cleanup_source = inherited_operation.lease
                    progress_cleanup_source = inherited_operation.progress_reservation
                    lease_cleanup_credit = transferred_lease
                    progress_cleanup_credit = transferred_progress
                    independent_cleanup_credit = transferred_independent

                    # A known context's prepaid progress reservation also
                    # funds the structural iterator created by its admitted
                    # wrapper. Move those exact credits into the direct token
                    # before entering the backend; do not count them as fresh
                    # lifecycle reservations.
                    progress_source = inherited_operation.progress_reservation
                    if (
                        progress_source is not None
                        and progress_source.active
                        and not progress_source.release_requested
                        and progress_source.lifecycle is lifecycle
                        and progress_source.owner is owner
                    ):
                        borrowed_progress = min(
                            cleanup_slots - transferred,
                            progress_source.cleanup_reservations,
                        )
                        if borrowed_progress:
                            progress_source.cleanup_reservations -= borrowed_progress
                            progress_cleanup_source = progress_source
                            progress_cleanup_credit += borrowed_progress

                additional = cleanup_slots - transferred - borrowed_progress
                if (
                    len(lifecycle.cleanup_references) + lifecycle.cleanup_reservations + additional
                    > MAX_PROVIDER_CLEANUP_REFERENCES
                ):
                    if transferred:
                        inherited_operation.cleanup_reservations += transferred
                        inherited_operation.lease_cleanup_reservations += transferred_lease
                        inherited_operation.progress_cleanup_reservations += transferred_progress
                    if borrowed_progress and progress_cleanup_source is not None:
                        progress_cleanup_source.cleanup_reservations += borrowed_progress
                    if record.active == 0:
                        _direct_calls.pop(owner_id, None)
                    raise ProviderUnavailableError("Provider cleanup capacity reached")
                lifecycle.direct_operations += 1
                lifecycle.cleanup_reservations += additional
                independent_cleanup_credit += additional
                token_cleanup_slots = cleanup_slots
        else:
            direct_cleanup = _direct_cleanups.get(owner_id)
            cleanup_count = len(direct_cleanup.references) if direct_cleanup is not None else 0
            # Nested direct callback work keeps its own bounded cleanup credit;
            # it cannot borrow the paused outer iterator's reservation.
            additional = cleanup_slots
            if (
                cleanup_count + record.cleanup_reservations + additional
                > MAX_PROVIDER_CLEANUP_REFERENCES
            ):
                if record.active == 0:
                    _direct_calls.pop(owner_id, None)
                raise ProviderUnavailableError("Provider cleanup capacity reached")
            record.cleanup_reservations += additional
            token_cleanup_slots = cleanup_slots
            independent_cleanup_credit = cleanup_slots
        record.active += 1
        token = _DirectCallToken(
            owner,
            record,
            token_cleanup_slots,
            lease_cleanup_source=lease_cleanup_source,
            lease_cleanup_credit=lease_cleanup_credit,
            progress_cleanup_source=progress_cleanup_source,
            progress_cleanup_credit=progress_cleanup_credit,
            independent_cleanup_credit=independent_cleanup_credit,
            nested_generator_slots=nested_generator_slots,
            nested_generator_method=nested_generator_method,
            nested_generator_parent_code=nested_generator_parent_code,
            nested_generator_parent_frame=nested_generator_parent_frame,
            nested_generator_child_callable=nested_generator_child_callable,
            nested_generator_child_code=nested_generator_child_code,
        )
        record.tokens[id(token)] = token
    try:
        from app.services.orchestrator.native_request_completion import (
            admit_direct_request_member,
        )

        token.request_member, token.owns_request_member = admit_direct_request_member(owner)
    except RuntimeError:
        _release_direct_call(token)
        raise ProviderUnavailableError("Provider is unavailable") from None
    except BaseException:
        _release_direct_call(token)
        raise
    return token


def _release_direct_call(token: _DirectCallToken) -> None:
    owner = token.owner
    record = token.record
    try:
        from app.services.orchestrator.llama_context_owner import generation_for

        registered_owner = generation_for(owner, retained_owner=True) is not None
    except BaseException:
        registered_owner = record.lifecycle is not None
    unstarted_iterator = token.sealed_unstarted_iterator
    if unstarted_iterator is None:
        unstarted_iterator = token.structural_unstarted_child
    sealed_not_submitted = (
        unstarted_iterator is not None
        and unstarted_iterator._lifetime is token
        and unstarted_iterator._finished
        and unstarted_iterator._sealed_unstarted
        and not unstarted_iterator._started
        and unstarted_iterator._iterator is None
        and not token.native_entry_attempted
        and (unstarted_iterator is token.structural_unstarted_child or not token.callable_attempted)
    )
    unknown_direct_handoff = (
        (token.request_member is not None or registered_owner)
        and token.callable_attempted
        and not token.native_entry_attempted
        and not sealed_not_submitted
    )
    # Do not retain the parent call frame after its one child was bound or the
    # guarded call returned; the frame can otherwise keep an entire invocation
    # graph alive through locals.
    token.nested_generator_parent_frame = None
    if token.iterator is None:
        token.nested_generator_slots = 0
        token.nested_generator_method = None
        token.nested_generator_parent_code = None
        token.nested_generator_child_callable = None
        token.nested_generator_child_code = None
    lifecycle: _ProviderLifecycle | None = None
    with _registry_guard:
        owner_id = id(owner)
        if _direct_calls.get(owner_id) is not record or record.owner is not owner:
            return
        if record.active <= 0:
            return
        if (
            token.active_depth == 0
            and token.iterator is not None
            and (
                token.retained_context_state in ("entering", "active", "finishing")
                or token.retained_context_state == "none"
            )
        ):
            # The parent's one-use structural credit and request member have been
            # transferred to a returned child iterator. The child releases this
            # same token after it is exhausted/closed; no ordinary operation slot
            # is allocated for the nested object.
            return
        record.active -= 1
        lifecycle = record.lifecycle
        if lifecycle is not None:
            with lifecycle.lock:
                if unknown_direct_handoff:
                    lifecycle.uncertain = True
                    lifecycle.admission_open = False
                    lifecycle.state = "retiring"
                    lifecycle.failure = lifecycle.failure or "native_entry_unverified"
                    if token.cleanup_reservations:
                        if _retain_cleanup_reference(lifecycle, token, reserved=True):
                            _consume_direct_cleanup_credit(token)
                    else:
                        _retain_cleanup_reference(lifecycle, token)
                    lifecycle.strong_owner = owner
                lifecycle.direct_operations = max(0, lifecycle.direct_operations - 1)
                returned_to_lease = 0
                if token.lease_cleanup_source is not None and token.lease_cleanup_source.active:
                    returned_to_lease = token.lease_cleanup_credit
                    token.lease_cleanup_source.cleanup_reservations += returned_to_lease
                returned_to_progress = 0
                if (
                    token.progress_cleanup_source is not None
                    and token.progress_cleanup_source.active
                    and not token.progress_cleanup_source.release_requested
                ):
                    returned_to_progress = token.progress_cleanup_credit
                    token.progress_cleanup_source.cleanup_reservations += returned_to_progress
                # These credits remained included in the lifecycle-wide total
                # while ownership moved from the operation to this token. Return
                # them to their original owner without counting them twice.
                release_count = max(
                    0,
                    token.cleanup_reservations - returned_to_lease - returned_to_progress,
                )
                lifecycle.cleanup_reservations = max(
                    0, lifecycle.cleanup_reservations - release_count
                )
        else:
            if unknown_direct_handoff:
                _record_direct_cleanup(
                    owner,
                    "native_entry_unverified",
                    uncertain=True,
                    retained=token,
                    reservation_token=token,
                )
            record.cleanup_reservations = max(
                0, record.cleanup_reservations - token.cleanup_reservations
            )
        token.cleanup_reservations = 0
        token.lease_cleanup_credit = 0
        token.progress_cleanup_credit = 0
        token.independent_cleanup_credit = 0
        token.lease_cleanup_source = None
        token.progress_cleanup_source = None
        record.tokens.pop(id(token), None)
        token.iterator = None
        token.nested_generator_iterator = None
        token.structural_unstarted_child = None
        token.sealed_unstarted_iterator = None
        if record.active == 0:
            _direct_calls.pop(owner_id, None)
    if unknown_direct_handoff and registered_owner:
        try:
            generation = generation_for(owner)
        except BaseException:
            generation = None
        if generation is not None:
            generation.quarantine("native_entry_unverified")
    if token.request_member is not None:
        if unknown_direct_handoff:
            with suppress(BaseException):
                token.request_member.group.mark_native_work(token.request_member, known=False)
                token.request_member.group.fail(
                    token.request_member, "native_entry_unverified", unknown=True
                )
        if token.owns_request_member:
            from app.services.orchestrator.native_request_completion import (
                finish_request_member,
            )

            if not token.native_entry_attempted:
                known_adapter = False
                try:
                    from app.services.orchestrator.llama_context_owner import (
                        is_registered_native_generation,
                    )

                    known_adapter = is_registered_native_generation(owner)
                except BaseException:
                    known_adapter = False
                if known_adapter and (not token.callable_attempted or sealed_not_submitted):
                    token.request_member.group.mark_not_submitted(token.request_member)
                elif not unknown_direct_handoff:
                    token.request_member.group.fail(
                        token.request_member,
                        "native_entry_unverified",
                        unknown=True,
                    )
            finish_request_member(
                token.request_member,
                owned=True,
                reason=(
                    None
                    if token.request_member.native_status in ("complete", "stopped")
                    else "direct_native_lifetime_unresolved"
                ),
            )
    if lifecycle is not None:
        _signal_lifecycle(lifecycle)


def _consume_direct_cleanup_credit(token: _DirectCallToken) -> None:
    """Move one token reservation into a retained cleanup reference."""

    if token.cleanup_reservations <= 0:
        return
    token.cleanup_reservations -= 1
    if token.independent_cleanup_credit:
        token.independent_cleanup_credit -= 1
    elif token.lease_cleanup_credit:
        token.lease_cleanup_credit -= 1
    elif token.progress_cleanup_credit:
        token.progress_cleanup_credit -= 1


@contextmanager
def direct_native_operation(
    provider: Any,
    *,
    cleanup_slots: int = 1,
    nested_generator_slots: int = 0,
    nested_generator_method: str | None = None,
    nested_generator_parent_code: Any = None,
    nested_generator_parent_frame: Any = None,
    nested_generator_child_callable: Any = None,
    nested_generator_child_code: Any = None,
):
    """Guard direct sync wrapper calls, reusing matching admitted work."""

    owner = provider_owner(provider)
    operation = _active_operation_for(owner)
    tokens = _direct_call_tokens.get()
    existing = _active_direct_token_for(owner)
    if existing is not None:
        try:
            from app.services.orchestrator.llama_context_owner import (
                is_registered_native_generation,
            )

            known_owner = is_registered_native_generation(owner)
        except BaseException:
            known_owner = True
        # A method name alone cannot transfer a known provider's single-use
        # child permit. The permitted iterator is claimed below at its exact
        # object construction/advancement boundary.
        if known_owner:
            raise ProviderUnavailableError("Provider cannot re-enter this request")
        direct_token = _admit_direct_call(
            owner,
            cleanup_slots,
            inherited_operation=operation,
            inherited_direct_token=existing,
            nested_generator_slots=nested_generator_slots,
            nested_generator_method=nested_generator_method,
            nested_generator_parent_code=nested_generator_parent_code,
            nested_generator_parent_frame=nested_generator_parent_frame,
            nested_generator_child_callable=nested_generator_child_callable,
            nested_generator_child_code=nested_generator_child_code,
        )
        token = _direct_call_tokens.set((*tokens, direct_token))
        try:
            _enter_direct_token(direct_token)
            direct_token.callable_attempted = True
            if direct_token.request_member is None:
                yield
            else:
                from app.services.orchestrator.native_request_completion import (
                    bind_request_member,
                )

                with bind_request_member(direct_token.request_member):
                    yield
        finally:
            _exit_direct_token(direct_token)
            _direct_call_tokens.reset(token)
            _release_direct_call(direct_token)
        return
    direct_token = _admit_direct_call(
        owner,
        cleanup_slots,
        inherited_operation=operation,
        nested_generator_slots=nested_generator_slots,
        nested_generator_method=nested_generator_method,
        nested_generator_parent_code=nested_generator_parent_code,
        nested_generator_parent_frame=nested_generator_parent_frame,
        nested_generator_child_callable=nested_generator_child_callable,
        nested_generator_child_code=nested_generator_child_code,
    )
    token = _direct_call_tokens.set((*tokens, direct_token))
    try:
        _enter_direct_token(direct_token)
        direct_token.callable_attempted = True
        if direct_token.request_member is None:
            yield
        else:
            from app.services.orchestrator.native_request_completion import (
                bind_request_member,
            )

            with bind_request_member(direct_token.request_member):
                yield
    finally:
        _exit_direct_token(direct_token)
        _direct_call_tokens.reset(token)
        _release_direct_call(direct_token)


@contextmanager
def native_cleanup_callback():
    """Prevent cleanup callbacks from reusing inference admission authority."""

    marker = _cleanup_callback_active.set(True)
    try:
        yield
    finally:
        _cleanup_callback_active.reset(marker)


class _DeferredDirectIterator:
    """Retain direct-generator admission from construction through close."""

    @staticmethod
    def _capture_target_binding(target: Callable[..., Any]) -> tuple[Any, ...] | None:
        """Pin a bounded decorator chain for a registered native generator."""

        try:
            from app.services.orchestrator.llama_context_owner import (
                _callable_provenance,
            )

            binding = []
            current = target
            for _ in range(8):
                provenance = _callable_provenance(current)
                code = getattr(current, "__code__", None)
                if provenance is None or code is None:
                    return None
                binding.append((current, code, provenance))
                wrapped = inspect.getattr_static(current, "__wrapped__", _MISSING)
                if wrapped is _MISSING:
                    return tuple(binding)
                if not callable(wrapped) or wrapped is current:
                    return None
                current = wrapped
            return None
        except BaseException:
            return None

    def _target_binding_is_current(self) -> bool:
        if self._target_provenance is None:
            return False
        return self._capture_target_binding(self._target) == self._target_provenance

    def __init__(
        self,
        target: Callable[..., Any],
        provider: Any,
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
        owner: Any,
        lifetime: _DirectCallToken | None,
        origin_group: Any,
        origin_member: Any,
        *,
        rejected: bool = False,
    ) -> None:
        self._target = target
        self._provider = provider
        self._args = args
        self._kwargs = kwargs
        self._owner = owner
        self._target_provenance_required = False
        self._target_provenance: tuple[Any, ...] | None = None
        try:
            from app.services.orchestrator.llama_context_owner import (
                is_registered_native_generation,
            )

            self._target_provenance_required = is_registered_native_generation(owner)
            if self._target_provenance_required:
                self._target_provenance = self._capture_target_binding(target)
        except BaseException:
            self._target_provenance_required = True
        self._lifetime = lifetime
        self._origin_group = origin_group
        self._origin_member = origin_member
        self._origin_parent_token: _DirectCallToken | None = None
        self._rejected = rejected
        self._iterator: Any = None
        self._started = False
        self._finished = False
        self._sealed_unstarted = False
        self._condition = threading.Condition()
        self._advancing_thread: int | None = None
        self._closing = False
        self._close_checked = False
        self._close_failed = False
        self._close_thread: int | None = None

    def __iter__(self) -> _DeferredDirectIterator:
        return self

    def _origin_is_current(self, *, cleanup: bool = False) -> bool:
        try:
            _validate_direct_provider_binding(self._provider, self._owner)
        except BaseException:
            return False
        if self._origin_group is None:
            try:
                from app.services.orchestrator.native_request_completion import (
                    current_request_group,
                )

                return current_request_group() is None
            except BaseException:
                return False
        from app.services.orchestrator.native_request_completion import (
            current_request_group,
        )

        try:
            lifetime = self._lifetime
            member = lifetime.request_member if lifetime is not None else self._origin_member
            if cleanup and self._origin_group.is_stopping:
                with self._origin_group._lock:
                    member_retained = (
                        member is not None
                        and self._origin_group._members.get(member.sequence) is member
                    )
                    origin_member_retained = (
                        self._origin_member is None
                        or self._origin_group._members.get(self._origin_member.sequence)
                        is self._origin_member
                    )
            else:
                member_retained = self._origin_group.contains_active_member(member)
                origin_member_retained = (
                    self._origin_member is None
                    or self._origin_group.contains_active_member(self._origin_member)
                )
            return (
                (cleanup or not self._origin_group.is_stopping)
                and current_request_group() is self._origin_group
                and member_retained
                and origin_member_retained
                and (
                    self._origin_member is None
                    or member is self._origin_member
                    or (
                        lifetime is not None
                        and self._origin_parent_token is not None
                        and self._origin_parent_token.owner is self._owner
                        and self._origin_parent_token.record is lifetime.record
                        and lifetime.record.tokens.get(id(self._origin_parent_token))
                        is self._origin_parent_token
                        and lifetime.record.active > 0
                        and self._origin_parent_token.request_member is self._origin_member
                        and self._origin_member.group is self._origin_group
                    )
                )
            )
        except BaseException:
            return False

    def _release(self) -> None:
        if self._finished:
            return
        self._finished = True
        if self._lifetime is not None:
            lifetime = self._lifetime
            with lifetime.retained_context_lock:
                if lifetime.retained_context_state in ("entering", "active", "finishing"):
                    # The raw iterator may be terminal inside the worker, but
                    # its physical context still owns synchronization and the
                    # runner handoff. Leave the exact token/member rooted until
                    # run_native completes that original context manager.
                    lifetime.retained_terminal_pending = True
                    return
            if self._sealed_unstarted:
                lifetime.sealed_unstarted_iterator = self
            if lifetime.iterator is self:
                lifetime.iterator = None
            if lifetime.active_depth == 0:
                _release_direct_call(lifetime)

    def _stop_from_request_group(self) -> None:
        """Seal an exact never-started direct iterator when its group stops."""

        lifetime = self._lifetime
        member = lifetime.request_member if lifetime is not None else None
        structural_child = lifetime is not None and lifetime.structural_unstarted_child is self
        plain_unstarted_iterator = (
            lifetime is not None and lifetime.iterator is self and not lifetime.callable_attempted
        )
        exact_group_ownership = False
        if (
            lifetime is not None
            and member is not None
            and self._origin_group is member.group
            and lifetime.owner is self._owner
            and lifetime.record.owner is self._owner
            and lifetime.record.tokens.get(id(lifetime)) is lifetime
        ):
            with member.group._lock:
                exact_group_ownership = member.group._members.get(member.sequence) is member and (
                    self._origin_member is None
                    or member.group._members.get(self._origin_member.sequence)
                    is self._origin_member
                )
        if (
            lifetime is not None
            and member is not None
            and member.group.is_stopping
            and (structural_child or plain_unstarted_iterator)
            and exact_group_ownership
            and not self._started
            and self._iterator is None
            and not lifetime.native_entry_attempted
            and lifetime.retained_context_state == "none"
        ):
            self._sealed_unstarted = True
            self._release()
            return
        if (
            lifetime is not None
            and member is not None
            and member.group.is_stopping
            and exact_group_ownership
            and self._started
            and self._iterator is not None
            and lifetime.iterator is self
        ):
            # Stopping seals further advancement through _origin_is_current,
            # while this exact accepted iterator remains responsible for its
            # checked close and the retained physical-context synchronization.
            # Keep its token/member and cleanup credits live until that close
            # settles; a normal stop is not evidence of uncertain cleanup.
            return
        record_iterator_cleanup_failure(
            None,
            unknown=True,
            provider=self._provider,
            retained=self._iterator if self._iterator is not None else self,
        )
        if member is not None:
            with suppress(BaseException):
                member.group.mark_native_work(member, known=False)
                member.group.fail(member, "direct_iterator_stop_unverified", unknown=True)

    def _close_inner(self) -> bool:
        if self._iterator is None:
            return True
        lifetime = self._lifetime
        if lifetime is None:
            return False
        try:
            _validate_direct_provider_binding(self._provider, self._owner)
        except BaseException:
            record_iterator_cleanup_failure(
                None, unknown=True, provider=self._provider, retained=self._iterator
            )
            return False
        tokens = _direct_call_tokens.get()
        marker = _direct_call_tokens.set((*tokens, lifetime))
        cleanup_failed = False
        try:
            _enter_direct_token(lifetime)
            member = lifetime.request_member
            if member is None:
                member_scope = nullcontext()
            else:
                from app.services.orchestrator.native_request_completion import (
                    bind_request_member,
                )

                member_scope = bind_request_member(member)
            with member_scope, native_cleanup_callback():
                close = getattr(self._iterator, "close", _MISSING)
                if close is _MISSING or not callable(close):
                    cleanup_failed = True
                else:
                    close()
        except BaseException:
            cleanup_failed = True
        finally:
            _exit_direct_token(lifetime)
            _direct_call_tokens.reset(marker)
        if cleanup_failed:
            record_iterator_cleanup_failure(None, provider=self._provider, retained=self._iterator)
        return not cleanup_failed

    def _reject_origin(self) -> None:
        # A foreign or copied observer cannot close or release an already
        # accepted iterator. Its original member remains the owner and can
        # still perform the one checked terminal action.
        lifetime = self._lifetime
        if lifetime is not None and lifetime.request_member is not None:
            with suppress(BaseException):
                from app.services.orchestrator.native_request_completion import (
                    current_request_member,
                )

                observer = current_request_member()
                if observer is not None and observer is not lifetime.request_member:
                    observer.group.mark_native_work(observer, known=False)
                    observer.group.fail(observer, "direct_iterator_origin_mismatch", unknown=True)
        raise ProviderUnavailableError("Provider cannot continue this request")

    def _advance(self, method_name: str, *args: Any) -> Any:
        if self._would_block_owned_loop():
            if not self._started:
                self._release()
            else:
                record_iterator_cleanup_failure(
                    None,
                    unknown=True,
                    provider=self._provider,
                    retained=self._iterator,
                )
            raise ProviderUnavailableError() from None
        thread_id = threading.get_ident()
        reject_sealed_origin = False
        with self._condition:
            while self._advancing_thread is not None:
                if self._advancing_thread == thread_id:
                    raise ProviderUnavailableError() from None
                if self._would_block_owned_loop():
                    raise ProviderUnavailableError() from None
                self._condition.wait()
            if self._finished or self._closing:
                reject_sealed_origin = self._sealed_unstarted and (
                    self._rejected or not self._origin_is_current()
                )
                if not reject_sealed_origin:
                    raise StopIteration
            else:
                self._advancing_thread = thread_id
        if reject_sealed_origin:
            # Check origin before an exhausted/sealed shortcut. A stopped
            # structural child cannot be reparented by a copied or cross-group
            # caller and misreported as an ordinary StopIteration.
            self._reject_origin()
        try:
            return self._advance_owned(method_name, *args)
        finally:
            with self._condition:
                self._advancing_thread = None
                self._condition.notify_all()

    def _advance_owned(self, method_name: str, *args: Any) -> Any:
        if self._rejected or not self._origin_is_current(cleanup=method_name == "close"):
            self._reject_origin()
        lifetime = self._lifetime
        if lifetime is None:
            raise ProviderUnavailableError("Provider is unavailable")
        if self._origin_group is not None:
            from app.services.orchestrator.native_request_completion import (
                current_request_member,
            )

            if current_request_member() is not lifetime.request_member:
                self._reject_origin()
        tokens = _direct_call_tokens.get()
        marker = _direct_call_tokens.set((*tokens, lifetime))
        primary: BaseException | None = None
        exhausted = False
        try:
            _enter_direct_token(lifetime)
            lifetime.callable_attempted = True
            if lifetime.structural_unstarted_child is self:
                # The exact permitted child is now being executed; its
                # construction-time no-entry proof is no longer applicable.
                lifetime.structural_unstarted_child = None
            member = lifetime.request_member
            if member is None:
                member_scope = nullcontext()
            else:
                from app.services.orchestrator.native_request_completion import (
                    bind_request_member,
                )

                member_scope = bind_request_member(member)
            with member_scope:
                if self._iterator is None:
                    if self._target_provenance_required and not self._target_binding_is_current():
                        record_iterator_cleanup_failure(
                            None,
                            unknown=True,
                            provider=self._provider,
                            retained=self,
                        )
                        self._rejected = True
                        raise ProviderUnavailableError() from None
                    self._iterator = self._target(self._provider, *self._args, **self._kwargs)
                    self._started = True
                method = getattr(self._iterator, method_name)
                try:
                    return method(*args)
                except StopIteration:
                    exhausted = True
                    raise
                except BaseException as error:
                    primary = error
                    raise
        finally:
            _exit_direct_token(lifetime)
            _direct_call_tokens.reset(marker)
            if exhausted:
                self._release()
            elif primary is not None:
                self._close_inner()
                self._release()

    def __next__(self) -> Any:
        return self._advance("__next__")

    def send(self, value: Any) -> Any:
        return self._advance("send", value)

    def throw(self, *args: Any) -> Any:
        return self._advance("throw", *args)

    def close(self) -> None:
        thread_id = threading.get_ident()
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None
        with self._condition:
            # A duplicate loop-thread observer must not poison the close
            # already owned by the worker. Other synchronous observers can
            # wait for that exact close outcome below.
            if (
                self._closing
                and not self._close_checked
                and (current_loop is not None or self._close_thread == thread_id)
            ):
                raise ProviderUnavailableError() from None
            if self._close_checked:
                if current_loop is not None or self._close_failed:
                    raise ProviderUnavailableError() from None
                return
            if self._finished:
                return
            if current_loop is not None and self._would_block_owned_loop():
                if not self._started:
                    self._release()
                else:
                    record_iterator_cleanup_failure(
                        None,
                        unknown=True,
                        provider=self._provider,
                        retained=self._iterator,
                    )
                raise ProviderUnavailableError() from None
            if self._rejected or not self._origin_is_current(cleanup=True):
                self._reject_origin()
            while self._advancing_thread is not None or (self._closing and not self._close_checked):
                if self._advancing_thread == thread_id or self._close_thread == thread_id:
                    raise ProviderUnavailableError() from None
                if self._would_block_owned_loop():
                    raise ProviderUnavailableError() from None
                self._condition.wait()
            if self._close_checked:
                if self._close_failed:
                    raise ProviderUnavailableError() from None
                return
            if self._finished:
                return
            self._closing = True
            self._close_thread = thread_id
            self._close_checked = False
        try:
            if self._rejected:
                self._reject_origin()
            cleanup_ok = self._close_inner()
            if cleanup_ok and not self._started and self._iterator is None:
                self._sealed_unstarted = True
            self._release()
            if not cleanup_ok:
                self._close_failed = True
                raise ProviderUnavailableError() from None
        except BaseException:
            self._close_failed = True
            raise
        finally:
            with self._condition:
                self._close_thread = None
                self._close_checked = True
                self._condition.notify_all()

    def _would_block_owned_loop(self) -> bool:
        # Preserve the legacy direct-iterator contract. This event-loop
        # blocking restriction exists only for a registered physical Llama
        # context whose synchronization must not run on its request loop.
        try:
            from app.services.orchestrator.llama_context_owner import generation_for

            if generation_for(self._provider) is None:
                return False
        except BaseException:
            return True
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            return False
        # Registered native iterators synchronize their physical context from
        # a worker. Reject synchronous observation on every event-loop thread,
        # before any condition wait can block that loop.
        return current_loop is not None


def _validate_direct_provider_binding(provider: Any, owner: Any) -> None:
    try:
        from app.services.orchestrator.llama_context_owner import (
            canonical_native_owner,
        )

        bound_owner = canonical_native_owner(provider)
    except BaseException:
        raise ProviderUnavailableError() from None
    if bound_owner is not owner:
        raise ProviderUnavailableError()


def _bind_direct_iterator_stop(
    lifetime: _DirectCallToken, iterator: _DeferredDirectIterator
) -> None:
    """Let the exact request member seal its direct iterator on stop."""

    member = lifetime.request_member
    if member is None:
        return
    previous_stop = member.stop

    def stop_member() -> None:
        try:
            if previous_stop is not None:
                previous_stop()
        finally:
            iterator._stop_from_request_group()

    try:
        member.set_stop(stop_member)
    except BaseException:
        iterator._stop_from_request_group()
        iterator._rejected = True


def direct_native_call(
    function: Callable[..., Any] | None = None, *, cleanup_slots: int = 1
) -> Callable[..., Any]:
    """Guard direct sync provider methods without double-admitting nesting."""

    def decorate(target: Callable[..., Any]) -> Callable[..., Any]:
        if inspect.isgeneratorfunction(target):

            @wraps(target)
            def guarded_generator(provider: Any, *args: Any, **kwargs: Any):
                owner = provider_owner(provider)
                _validate_direct_provider_binding(provider, owner)
                existing = _active_direct_token_for(owner)
                inherited = _active_operation_for(owner)
                origin_group = None
                origin_member = None
                try:
                    from app.services.orchestrator.native_request_completion import (
                        current_request_group,
                        current_request_member,
                    )

                    origin_group = current_request_group()
                    origin_member = current_request_member()
                except BaseException:
                    origin_group = None
                    origin_member = None
                iterator = _DeferredDirectIterator(
                    target,
                    provider,
                    args,
                    kwargs,
                    owner,
                    None,
                    origin_group,
                    origin_member,
                )
                try:
                    parent_frame = sys._getframe(1)
                except (AttributeError, ValueError):
                    parent_frame = None
                transferred = bool(
                    existing is not None
                    and existing.nested_generator_method == target.__name__
                    and existing.nested_generator_child_callable is target
                    and existing.nested_generator_child_code is target.__code__
                    and parent_frame is not None
                    and parent_frame.f_code is existing.nested_generator_parent_code
                    and parent_frame.f_back is existing.nested_generator_parent_frame
                    and parent_frame.f_locals.get("self") is provider
                    and existing.nested_generator_slots > 0
                    and existing.nested_generator_iterator is None
                )
                if transferred:
                    transferred = _bind_nested_generator_slot(
                        existing, target.__name__, iterator, parent_frame, target.__code__
                    )
                if transferred:
                    transferred = (
                        _claim_nested_generator_slot(existing, target.__name__, iterator)
                        is existing
                    )
                if transferred:
                    iterator._origin_parent_token = existing
                    lifetime = existing
                    lifetime.structural_unstarted_child = iterator
                    existing.nested_generator_slots -= 1
                    existing.nested_generator_method = None
                    existing.nested_generator_iterator = None
                    existing.nested_generator_parent_code = None
                    existing.nested_generator_parent_frame = None
                    existing.nested_generator_child_callable = None
                    existing.nested_generator_child_code = None
                else:
                    if existing is not None and existing.nested_generator_iterator is iterator:
                        existing.nested_generator_iterator = None
                    known_owner = False
                    if existing is not None:
                        try:
                            from app.services.orchestrator.llama_context_owner import (
                                is_registered_native_generation,
                            )

                            known_owner = is_registered_native_generation(owner)
                        except BaseException:
                            known_owner = True
                    if existing is not None and known_owner:
                        iterator._rejected = True
                        return iterator
                    lifetime = _admit_direct_call(
                        owner,
                        cleanup_slots,
                        inherited_operation=inherited,
                        inherited_direct_token=existing,
                    )
                iterator._lifetime = lifetime
                iterator._lifetime.iterator = iterator
                _bind_direct_iterator_stop(lifetime, iterator)
                return iterator

            return guarded_generator

        @wraps(target)
        def guarded_call(provider: Any, *args: Any, **kwargs: Any):
            owner = provider_owner(provider)
            _validate_direct_provider_binding(provider, owner)
            try:
                parent_frame = sys._getframe()
            except (AttributeError, ValueError):
                parent_frame = None
            child_code = None
            child_callable = None
            if target.__name__ == "_generate":
                try:
                    child_method = inspect.getattr_static(type(provider), "_stream", None)
                    child_callable = getattr(child_method, "__wrapped__", None)
                    child_code = getattr(child_callable, "__code__", None)
                except BaseException:
                    child_callable = None
                    child_code = None
            with direct_native_operation(
                provider,
                cleanup_slots=cleanup_slots,
                nested_generator_slots=max(0, cleanup_slots - 1),
                nested_generator_method=("_stream" if target.__name__ == "_generate" else None),
                nested_generator_parent_code=(
                    target.__code__ if target.__name__ == "_generate" else None
                ),
                nested_generator_parent_frame=(
                    parent_frame if target.__name__ == "_generate" else None
                ),
                nested_generator_child_callable=(
                    child_callable if target.__name__ == "_generate" else None
                ),
                nested_generator_child_code=(
                    child_code if target.__name__ == "_generate" else None
                ),
            ):
                return target(provider, *args, **kwargs)

        return guarded_call

    return decorate(function) if function is not None else decorate


def _signal_lifecycle(lifecycle: _ProviderLifecycle) -> None:
    event = lifecycle.changed
    if event is None or lifecycle.loop.is_closed():
        with lifecycle.lock:
            lifecycle.loop_lost = True
            lifecycle.uncertain = True
            lifecycle.admission_open = False
            if lifecycle.failure is None:
                lifecycle.failure = "original_loop_unavailable"
            lifecycle.state = "retiring"
        return
    try:
        lifecycle.loop.call_soon_threadsafe(event.set)
    except RuntimeError:
        with lifecycle.lock:
            lifecycle.loop_lost = True
            lifecycle.uncertain = True
            lifecycle.admission_open = False
            if lifecycle.failure is None:
                lifecycle.failure = "original_loop_unavailable"
            lifecycle.state = "retiring"


def _notify_operation(operation: _Operation) -> None:
    lifecycle = operation.lifecycle
    with lifecycle.lock:
        completion = operation.completion
        if not completion.done():
            completion.set_result(None)
    if lifecycle.changed is not None:
        lifecycle.changed.set()


def _mark_unknown(operation: _Operation, failure: str) -> None:
    lifecycle = operation.lifecycle
    with lifecycle.lock:
        if operation.state in (_OperationState.BODY_RETURNED, _OperationState.BODY_RAISED):
            return
        operation.state = _OperationState.UNKNOWN
        lifecycle.admission_open = False
        lifecycle.uncertain = True
        lifecycle.state = "retiring"
        if lifecycle.failure is None:
            lifecycle.failure = failure
        if not operation.completion.done():
            operation.completion.set_result(None)
        lifecycle.actual_changed.set()
    member = operation.request_member
    if member is not None:
        with suppress(BaseException):
            member.group.mark_native_work(member, known=False)
            member.group.fail(member, failure, unknown=True)
    if lifecycle.changed is not None:
        lifecycle.changed.set()


def _executor_task_finished(operation: _Operation, task: asyncio.Task) -> None:
    if task.cancelled():
        _mark_unknown(operation, "submitted_operation_completion_unknown")
    else:
        try:
            task_error = task.exception()
        except BaseException:
            task_error = True
        if task_error is not None:
            _mark_unknown(operation, "submitted_operation_completion_unknown")
        elif operation.state in (
            _OperationState.NOT_SUBMITTED,
            _OperationState.SUBMISSION_ATTEMPTED,
        ):
            _mark_unknown(operation, "submitted_operation_not_observed")


def _track_task(registry: dict[int, set[asyncio.Task]], owner_id: int, task: asyncio.Task) -> None:
    registry.setdefault(owner_id, set()).add(task)

    def prune(completed: asyncio.Task) -> None:
        _prune_tracked_task(registry, owner_id, completed)

    task.add_done_callback(prune)


def _prune_tracked_task(
    registry: dict[int, set[asyncio.Task]], owner_id: int, task: asyncio.Task
) -> None:
    """Remove only this diagnostic task entry; lifecycle records own truth."""

    tasks = registry.get(owner_id)
    if tasks is None:
        return
    tasks.discard(task)
    if not tasks:
        registry.pop(owner_id, None)


def _new_stream_producer_context() -> contextvars.Context:
    """Copy caller context while clearing only native/request capabilities."""

    context = contextvars.copy_context()

    def clear_capabilities() -> None:
        from app.services.orchestrator.llama_context_owner import (
            _chat_dispatch,
            _cleanup_active,
            _completion_factory,
            _current_child,
            _current_lease,
        )
        from app.services.orchestrator.native_request_completion import (
            _active_group,
            _active_member,
            _worker_authorization,
        )

        _current_lease.set(None)
        _current_child.set(None)
        _cleanup_active.set(False)
        _completion_factory.set(None)
        _chat_dispatch.set(None)
        _active_group.set(None)
        _active_member.set(None)
        _worker_authorization.set(None)
        _current_operation.set(None)
        _direct_call_tokens.set(())
        _cleanup_callback_active.set(False)

    context.run(clear_capabilities)
    return context


def _record_cleanup(
    operation: _Operation | None,
    failure: str | None,
    retained: Any | None = None,
) -> None:
    if operation is None or failure is None:
        return
    lifecycle = operation.lifecycle
    with lifecycle.lock:
        if operation.cleanup_failure is None:
            operation.cleanup_failure = failure
        if lifecycle.failure is None:
            lifecycle.failure = failure
        if failure.endswith("unknown"):
            lifecycle.uncertain = True
            lifecycle.admission_open = False
            lifecycle.state = "retiring"
        if retained is not None:
            reserved = operation.cleanup_reservations > 0
            if _retain_cleanup_reference(lifecycle, retained, reserved=reserved) and reserved:
                operation.cleanup_reservations -= 1
                # The retained reference inherits this reservation. Remove it
                # from its source bucket so _release_operation cannot refund
                # the same credit to both owners.
                if operation.lease_cleanup_reservations:
                    operation.lease_cleanup_reservations -= 1
                elif operation.progress_cleanup_reservations:
                    operation.progress_cleanup_reservations -= 1
    member = operation.request_member
    if member is not None:
        unknown = failure.endswith("unknown")
        with suppress(BaseException):
            if unknown:
                member.group.mark_native_work(member, known=False)
            member.group.record_failure(member, failure, unknown=unknown)


def _record_direct_cleanup(
    owner: Any,
    failure: str,
    *,
    uncertain: bool,
    retained: Any | None = None,
    reservation_token: _DirectCallToken | None = None,
) -> None:
    global _direct_cleanup_overflow
    owner_id = id(owner)
    with _registry_guard:
        lifecycle = _lifecycles.get(owner_id)
        if lifecycle is not None and lifecycle.owner() is owner:
            with lifecycle.lock:
                if lifecycle.failure is None:
                    lifecycle.failure = failure
                lifecycle.uncertain = lifecycle.uncertain or uncertain
                if uncertain:
                    lifecycle.admission_open = False
                    lifecycle.state = "retiring"
                if retained is not None:
                    reserved = (
                        reservation_token is not None
                        and reservation_token.owner is owner
                        and reservation_token.cleanup_reservations > 0
                    )
                    if (
                        _retain_cleanup_reference(lifecycle, retained, reserved=reserved)
                        and reserved
                    ):
                        _consume_direct_cleanup_credit(reservation_token)
            return
        record = _direct_cleanups.get(owner_id)
        if record is not None and record.owner() is owner:
            if record.failure is None:
                record.failure = failure
            record.uncertain = record.uncertain or uncertain
            if uncertain or retained is not None:
                record.strong_owner = owner
            if retained is not None and not any(item is retained for item in record.references):
                reserved = (
                    reservation_token is not None
                    and reservation_token.owner is owner
                    and reservation_token.cleanup_reservations > 0
                )
                if not reserved and len(record.references) >= MAX_PROVIDER_CLEANUP_REFERENCES:
                    _direct_cleanup_overflow = True
                else:
                    record.references = (*record.references, retained)
                    if reserved:
                        _consume_direct_cleanup_credit(reservation_token)
                        reservation_token.record.cleanup_reservations = max(
                            0,
                            reservation_token.record.cleanup_reservations - 1,
                        )
            return
        if len(_lifecycles) + len(_direct_cleanups) >= MAX_PROVIDER_LIFECYCLES:
            _direct_cleanup_overflow = True
            return
        record = _DirectCleanupRecord(
            key=owner_id,
            failure=failure,
            uncertain=uncertain,
            references=(retained,) if retained is not None else (),
        )
        reserved = (
            reservation_token is not None
            and reservation_token.owner is owner
            and reservation_token.cleanup_reservations > 0
        )
        if retained is not None and reserved:
            _consume_direct_cleanup_credit(reservation_token)
            reservation_token.record.cleanup_reservations = max(
                0, reservation_token.record.cleanup_reservations - 1
            )
        try:
            if uncertain or retained is not None:
                record.strong_owner = owner
            else:
                record.weak_owner = weakref.ref(
                    owner,
                    lambda _ref, key=owner_id, cleanup=record: _remove_dead_direct_cleanup(
                        key, cleanup
                    ),
                )
        except TypeError:
            record.strong_owner = owner
        _direct_cleanups[owner_id] = record


def record_iterator_cleanup_failure(
    error: BaseException | None,
    *,
    unknown: bool = False,
    provider: Any | None = None,
    retained: Any | None = None,
) -> None:
    """Retain fixed cleanup state for the exact admitted or direct provider."""

    failure = "iterator_close_unknown" if unknown else "iterator_close_failed"
    operation = _current_operation.get()
    owner = provider_owner(provider) if provider is not None else None
    if operation is not None and (owner is None or operation.owner is owner):
        direct_token = _active_direct_token_for(operation.owner)
        if operation.cleanup_reservations > 0 or direct_token is None:
            _record_cleanup(operation, failure, retained)
            return
    if owner is not None:
        if operation is None or operation.owner is not owner:
            direct_token = _active_direct_token_for(owner)
        _record_direct_cleanup(
            owner,
            failure,
            uncertain=unknown,
            retained=retained,
            reservation_token=direct_token,
        )
        member = direct_token.request_member if direct_token is not None else None
        if member is not None:
            with suppress(BaseException):
                if unknown:
                    member.group.mark_native_work(member, known=False)
                member.group.fail(member, failure, unknown=unknown)


def _invoke_iterator_close(iterator: Any, provider: Any) -> _CloseInvocation:
    """Resolve and call one iterator's close hook on the native worker thread."""

    with native_cleanup_callback():
        try:
            close = getattr(iterator, "close", _MISSING)
        except BaseException:
            record_iterator_cleanup_failure(
                None, unknown=True, provider=provider, retained=iterator
            )
            return _CloseInvocation(available=False, unknown=True)
        if not callable(close):
            record_iterator_cleanup_failure(
                None, unknown=True, provider=provider, retained=iterator
            )
            return _CloseInvocation(available=False, unknown=True)
        try:
            result = close()
        except BaseException as error:
            record_iterator_cleanup_failure(error, provider=provider, retained=iterator)
            return _CloseInvocation(available=True, failed=True)
        if inspect.isawaitable(result):
            if inspect.iscoroutine(result):
                result.close()
            record_iterator_cleanup_failure(
                None, unknown=True, provider=provider, retained=iterator
            )
            return _CloseInvocation(available=False, unknown=True)
        return _CloseInvocation(available=True, result=result)


def _allocate_operation(
    lifecycle: _ProviderLifecycle,
    owner: Any,
    loop: asyncio.AbstractEventLoop,
    *,
    lease: _StreamLease | None = None,
    transfer_required: bool = False,
    retirement_internal: bool = False,
    stream_action: str | None = None,
    wait_for_capacity: bool = False,
    cleanup_slots: int = 1,
    request_member: Any = None,
    context_lease: Any = None,
    runner: _NativeCommandRunner | None = None,
    execution_context: contextvars.Context | None = None,
    registered_close_iterator: Any = None,
) -> _Operation:
    with _registry_guard, lifecycle.lock:
        if lifecycle.loop is not loop:
            raise ProviderUnavailableError("Provider lifecycle belongs to another event loop")
        if lifecycle.state != "open":
            lease_allowed = (
                lease is not None
                and lease.lifecycle is lifecycle
                and lease.active
                and lease.sequence in lifecycle.streams
            )
            if not lease_allowed and not retirement_internal:
                raise ProviderUnavailableError("Provider is retired")
        progress_reservation = (
            context_lease.progress_reservation
            if context_lease is not None
            else lease.progress_reservation
            if lease is not None
            else None
        )
        uses_progress = (
            progress_reservation is not None
            and lifecycle.progress_credits.get(id(progress_reservation)) is progress_reservation
            and progress_reservation.lifecycle is lifecycle
            and progress_reservation.owner is owner
            and progress_reservation.active
            and not progress_reservation.in_flight
        )
        if progress_reservation is not None and progress_reservation.active and not uses_progress:
            if wait_for_capacity:
                raise _OperationCapacityError
            raise ProviderUnavailableError("Provider progress is unavailable")
        if (
            len(lifecycle.operations) + lifecycle.progress_reservations >= MAX_PROVIDER_OPERATIONS
            and not uses_progress
        ):
            if wait_for_capacity:
                raise _OperationCapacityError
            raise ProviderUnavailableError("Provider operation capacity reached")
        transferred = 0
        progress_transferred = 0
        if stream_action in ("factory", "next", "close") and lease is not None:
            transferred = min(cleanup_slots, lease.cleanup_reservations)
        if transferred < cleanup_slots and uses_progress:
            progress_transferred = min(
                cleanup_slots - transferred,
                progress_reservation.cleanup_reservations,
            )
        additional_cleanup_slots = cleanup_slots - transferred
        additional_cleanup_slots -= progress_transferred
        if (
            len(lifecycle.cleanup_references)
            + lifecycle.cleanup_reservations
            + additional_cleanup_slots
            > MAX_PROVIDER_CLEANUP_REFERENCES
        ):
            if wait_for_capacity:
                raise _OperationCapacityError
            raise ProviderUnavailableError("Provider cleanup capacity reached")
        if lifecycle.next_operation >= _MAX_SEQUENCE:
            lifecycle.admission_open = False
            lifecycle.state = "retiring"
            lifecycle.failure = lifecycle.failure or "operation_sequence_exhausted"
            raise ProviderUnavailableError("Provider operation capacity reached")
        lifecycle.next_operation += 1
        if transferred:
            lease.cleanup_reservations -= transferred
        if progress_transferred:
            progress_reservation.cleanup_reservations -= progress_transferred
        operation = _Operation(
            lifecycle=lifecycle,
            sequence=lifecycle.next_operation,
            owner=owner,
            loop=loop,
            completion=loop.create_future(),
            settled=asyncio.Event(),
            request_member=request_member,
            context_lease=context_lease,
            state=_OperationState.SUBMISSION_ATTEMPTED,
            transfer_required=transfer_required,
            lease=lease,
            stream_action=stream_action,
            cleanup_reservations=cleanup_slots,
            lease_cleanup_reservations=transferred,
            progress_cleanup_reservations=progress_transferred,
            progress_reservation=progress_reservation if uses_progress else None,
            runner=runner,
            execution_context=execution_context,
            runner_settled=loop.create_future() if runner is not None else None,
            registered_close_iterator=registered_close_iterator,
        )
        if uses_progress:
            progress_reservation.in_flight = True
            lifecycle.progress_reservations = max(0, lifecycle.progress_reservations - 1)
        lifecycle.cleanup_reservations += additional_cleanup_slots
        lifecycle.operations[operation.sequence] = operation
        return operation


async def _wait_for_operation_capacity(
    lifecycle: _ProviderLifecycle,
    cleanup_slots: int,
    lease: _StreamLease | None = None,
    stream_action: str | None = None,
) -> bool:
    """Wait cancellation-safely for a slot reserved for accepted cleanup."""

    event = lifecycle.changed
    if event is None:
        raise ProviderUnavailableError("Provider lifecycle is unavailable")
    cancelled = False
    while True:
        with lifecycle.lock:
            transferred = (
                min(cleanup_slots, lease.cleanup_reservations)
                if lease is not None and stream_action in ("factory", "next", "close")
                else 0
            )
            reservation = lease.progress_reservation if lease is not None else None
            uses_progress = (
                reservation is not None
                and lifecycle.progress_credits.get(id(reservation)) is reservation
                and reservation.lifecycle is lifecycle
                and reservation.owner is lease.owner
                and reservation.active
                and not reservation.in_flight
            )
            progress_transferred = (
                min(cleanup_slots - transferred, reservation.cleanup_reservations)
                if uses_progress and reservation is not None
                else 0
            )
            available = (
                (
                    uses_progress
                    or len(lifecycle.operations) + lifecycle.progress_reservations
                    < MAX_PROVIDER_OPERATIONS
                )
                and len(lifecycle.cleanup_references)
                + lifecycle.cleanup_reservations
                + cleanup_slots
                - transferred
                - progress_transferred
                <= MAX_PROVIDER_CLEANUP_REFERENCES
            )
            if available:
                return cancelled
            event.clear()
            available = (
                (
                    uses_progress
                    or len(lifecycle.operations) + lifecycle.progress_reservations
                    < MAX_PROVIDER_OPERATIONS
                )
                and len(lifecycle.cleanup_references)
                + lifecycle.cleanup_reservations
                + cleanup_slots
                - transferred
                - progress_transferred
                <= MAX_PROVIDER_CLEANUP_REFERENCES
            )
            if available:
                return cancelled
        try:
            await asyncio.shield(event.wait())
        except asyncio.CancelledError:
            cancelled = True


def _release_operation(operation: _Operation, *, transfer_acknowledged: bool = False) -> None:
    lifecycle = operation.lifecycle
    context_lease = None
    with lifecycle.lock:
        if (
            operation.transfer_required
            and not transfer_acknowledged
            and operation.outcome is not None
            and operation.outcome.returned
        ):
            operation.retained = True
            return
        operation.transfer_acknowledged = transfer_acknowledged or operation.transfer_acknowledged
        operation.retained = False
        lifecycle.cleanup_reservations = max(
            0, lifecycle.cleanup_reservations - operation.cleanup_reservations
        )
        if (
            operation.lease_cleanup_reservations
            and operation.lease is not None
            and operation.lease.active
        ):
            operation.lease.cleanup_reservations += operation.lease_cleanup_reservations
            lifecycle.cleanup_reservations += operation.lease_cleanup_reservations
        if (
            operation.progress_cleanup_reservations
            and operation.progress_reservation is not None
            and operation.progress_reservation.active
            and not operation.progress_reservation.release_requested
        ):
            operation.progress_reservation.cleanup_reservations += (
                operation.progress_cleanup_reservations
            )
            lifecycle.cleanup_reservations += operation.progress_cleanup_reservations
        operation.cleanup_reservations = 0
        operation.lease_cleanup_reservations = 0
        operation.progress_cleanup_reservations = 0
        operation.references = ()
        operation.registered_close_iterator = None
        # A delivered primary exception must not leave a traceback cycle in the
        # registry. The waiting caller already has the original exception.
        operation.outcome = None
        lifecycle.operations.pop(operation.sequence, None)
        reservation = operation.progress_reservation
        if reservation is not None and reservation.in_flight:
            reservation.in_flight = False
            if reservation.active and not reservation.release_requested:
                lifecycle.progress_reservations += 1
            else:
                reservation.active = False
                reservation.release_requested = False
                if lifecycle.progress_credits.get(id(reservation)) is reservation:
                    lifecycle.progress_credits.pop(id(reservation), None)
                lifecycle.cleanup_reservations = max(
                    0,
                    lifecycle.cleanup_reservations - reservation.cleanup_reservations,
                )
                reservation.cleanup_reservations = 0
        else:
            reservation = None
        context_lease = operation.context_lease
        operation.context_lease = None
    if context_lease is not None:
        context_lease.settle_operation(operation)
    _signal_lifecycle(lifecycle)


def _run_body(
    operation: _Operation,
    function: Callable[..., Any],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> None:
    lifecycle = operation.lifecycle
    with lifecycle.lock:
        if operation.state is not _OperationState.UNKNOWN:
            operation.state = _OperationState.BODY_RUNNING
        operation.worker_thread_id = threading.get_ident()
        operation.references = (function, args, kwargs)
    token = _current_operation.set(operation)
    try:
        from app.services.orchestrator.llama_context_owner import (
            _chat_dispatch,
            _cleanup_active,
            _completion_factory,
            _current_child,
            _current_lease,
        )

        context_lease_token = _current_lease.set(operation.context_lease)
        child_token = _current_child.set(None)
        cleanup_token = _cleanup_active.set(False)
        completion_token = _completion_factory.set(None)
        dispatch_token = _chat_dispatch.set(None)
    except (ImportError, AttributeError):
        context_lease_token = None
        child_token = cleanup_token = completion_token = dispatch_token = None
    direct_tokens_token = _direct_call_tokens.set(())
    cleanup_callback_token = _cleanup_callback_active.set(False)
    try:
        if operation.request_member is None:
            member_scope = nullcontext()
        else:
            from app.services.orchestrator.native_request_completion import (
                bind_request_member,
            )

            member_scope = bind_request_member(operation.request_member, operation=operation)
        with member_scope:
            if operation.context_lease is not None:
                operation.context_lease.note_callable_attempted()
            value = function(*args, **kwargs)
        outcome = _BodyOutcome(returned=True, value=value)
        final_state = _OperationState.BODY_RETURNED
    except BaseException as error:
        outcome = _BodyOutcome(returned=False, error=error)
        final_state = _OperationState.BODY_RAISED
    finally:
        _current_operation.reset(token)
        if context_lease_token is not None:
            _current_lease.reset(context_lease_token)
            _current_child.reset(child_token)
            _cleanup_active.reset(cleanup_token)
            _completion_factory.reset(completion_token)
            _chat_dispatch.reset(dispatch_token)
        _cleanup_callback_active.reset(cleanup_callback_token)
        _direct_call_tokens.reset(direct_tokens_token)
    with lifecycle.lock:
        was_unknown = operation.state is _OperationState.UNKNOWN
        # A waiter may already have observed unknown submission completion.
        # The actual body can settle later, but that cannot erase the doubt.
        if operation.transfer_required and outcome.returned or not was_unknown:
            operation.outcome = outcome
        operation.state = _OperationState.UNKNOWN if was_unknown else final_state
        operation.worker_thread_id = None
        operation.references = ()
    try:
        operation.loop.call_soon_threadsafe(operation.settled.set)
    except RuntimeError:
        with lifecycle.lock:
            lifecycle.loop_lost = True
            lifecycle.uncertain = True
            lifecycle.admission_open = False
            lifecycle.state = "retiring"
            lifecycle.failure = lifecycle.failure or "original_loop_unavailable"
    try:
        operation.loop.call_soon_threadsafe(_notify_operation, operation)
    except RuntimeError:
        with lifecycle.lock:
            lifecycle.loop_lost = True
            lifecycle.uncertain = True
            lifecycle.admission_open = False
            lifecycle.state = "retiring"
            if lifecycle.failure is None:
                lifecycle.failure = "original_loop_unavailable"
            if operation.transfer_required and not operation.transfer_acknowledged:
                operation.retained = True
        # Keep an untransferred factory result strongly owned by the operation.
    lifecycle.actual_changed.set()
    operation.worker_returned.set()
    # Callable settlement is not proof that a native backend was selected or
    # synchronized. Only the qualified adapter records positive native work.


def _runner_operation_settled(operation: _Operation) -> None:
    """Publish return from _run_body to the command observer on its loop."""

    settled = operation.runner_settled
    if settled is not None and not settled.done():
        settled.set_result(None)


def _run_native_command_runner(runner: _NativeCommandRunner) -> None:
    """Hold one existing executor worker and run one mailbox command at a time."""

    while True:
        command = runner.mailbox.get()
        if command is None:
            runner.worker_returned.set()
            return
        operation = command.operation
        execution_context = operation.execution_context
        if execution_context is None:
            runner.unknown = True
            with runner.lifecycle.lock:
                runner.lifecycle.uncertain = True
                runner.lifecycle.admission_open = False
                runner.lifecycle.state = "retiring"
                runner.lifecycle.failure = (
                    runner.lifecycle.failure or "native_runner_context_unavailable"
                )
        else:
            try:
                execution_context.run(
                    _run_body,
                    operation,
                    command.function,
                    command.args,
                    command.kwargs,
                )
            except BaseException:
                # Internal runner failure is not a completed provider call.
                runner.unknown = True
                with runner.lifecycle.lock:
                    runner.lifecycle.uncertain = True
                    runner.lifecycle.admission_open = False
                    runner.lifecycle.state = "retiring"
                    runner.lifecycle.failure = (
                        runner.lifecycle.failure or "native_runner_body_unavailable"
                    )
        operation.runner_returned.set()
        if runner.unknown:
            runner.closing = True
            runner.worker_returned.set()
            return
        try:
            runner.loop.call_soon_threadsafe(_runner_operation_settled, operation)
        except RuntimeError:
            with runner.lifecycle.lock:
                runner.unknown = True
                runner.lifecycle.loop_lost = True
                runner.lifecycle.uncertain = True
                runner.lifecycle.admission_open = False
                runner.lifecycle.state = "retiring"
                runner.lifecycle.failure = runner.lifecycle.failure or "original_loop_unavailable"
            # This command's synchronous body and executor callback have
            # returned. The loop cannot receive its acknowledgement, so the
            # provider outcome stays UNKNOWN, but the retained worker must not
            # block forever waiting for another mailbox command.
            runner.closing = True
            runner.worker_returned.set()
            return


def _runner_future_finished(future: asyncio.Future[Any], runner: _NativeCommandRunner) -> None:
    """Retain a failed or prematurely returned runner as lifecycle doubt."""

    try:
        error = future.exception()
    except BaseException:
        error = True
    if error is None and runner.worker_returned.is_set() and not runner.unknown:
        return
    retained_streams: list[_StreamLease] = []
    with runner.lifecycle.lock:
        runner.unknown = True
        runner.closing = True
        runner.lifecycle.uncertain = True
        runner.lifecycle.admission_open = False
        runner.lifecycle.state = "retiring"
        runner.lifecycle.failure = runner.lifecycle.failure or (
            "native_runner_task_failed" if error is not None else "native_runner_unknown"
        )
        failure = runner.lifecycle.failure
        context_lease = runner.reservation.context_lease
        for operation in runner.lifecycle.operations.values():
            if operation.runner is runner:
                confirmed_body = (
                    operation.state in (_OperationState.BODY_RETURNED, _OperationState.BODY_RAISED)
                    and operation.outcome is not None
                )
                if not confirmed_body:
                    operation.state = _OperationState.UNKNOWN
                operation.settlement_unknown = True
                operation.retained = True
                if operation.lease is not None:
                    operation.lease.cleanup_unknown = True
                if operation.request_member is not None:
                    with suppress(BaseException):
                        operation.request_member.group.mark_native_work(
                            operation.request_member, known=False
                        )
                        operation.request_member.group.fail(
                            operation.request_member,
                            failure,
                            unknown=True,
                        )
                if not operation.completion.done():
                    operation.completion.set_result(None)
                if not operation.settled.is_set():
                    operation.settled.set()
                if operation.runner_settled is not None and not operation.runner_settled.done():
                    operation.runner_settled.set_result(None)
        # A Future may be cancelled while its worker is idle between stream
        # commands, when no operation points back to the stream lease. Match
        # only leases holding this exact runner reservation/context and keep
        # their iterator and context credits quarantined as UNKNOWN.
        for lease in runner.lifecycle.streams.values():
            if not lease.active or not (
                lease.progress_reservation is runner.reservation
                or (context_lease is not None and lease.context_lease is context_lease)
            ):
                continue
            lease.cleanup_unknown = True
            retained_streams.append(lease)
            member = lease.request_member
            if member is not None:
                with suppress(BaseException):
                    member.group.mark_native_work(member, known=False)
                    member.group.fail(member, failure, unknown=True)
    # A cancelled asyncio Future does not tell us whether the shared-executor
    # worker is already waiting between commands. The sentinel is ordered
    # behind any accepted command: an active command observes runner.unknown
    # and exits on return, while an idle runner wakes and exits. This never
    # upgrades cancellation to a settled executor handoff.
    with suppress(thread_queue.Full):
        runner.mailbox.put_nowait(None)
    for lease in retained_streams:
        # Preserve the runner's UNKNOWN failure as the consumer's primary
        # outcome. The consumer's normal error finalizer will request stop and
        # join the producer without converting this into cancellation.
        if lease.consumer_failure is not None:
            lease.consumer_failure(
                ProviderUnavailableError("Provider operation completion is unknown")
            )
    if context_lease is not None:
        context_lease._abandon_unknown(failure)
    runner.lifecycle.actual_changed.set()


async def _ensure_native_runner(
    reservation: _ProgressReservation,
) -> _NativeCommandRunner:
    """Start one retained runner for an already admitted progress credit."""

    lifecycle = reservation.lifecycle
    with lifecycle.lock:
        if (
            lifecycle.owner() is not reservation.owner
            or lifecycle.progress_credits.get(id(reservation)) is not reservation
            or not reservation.active
            or reservation.in_flight
        ):
            raise ProviderUnavailableError("Provider progress is unavailable")
        runner = reservation.runner
        if runner is not None:
            if (
                runner.unknown
                or runner.closing
                or runner.future is None
                or runner.loop is not asyncio.get_running_loop()
            ):
                raise ProviderUnavailableError("Provider progress is unavailable")
            return runner
        loop = asyncio.get_running_loop()
        runner = _NativeCommandRunner(lifecycle, reservation.owner, loop, reservation)
        reservation.runner = runner
        try:
            # The admission lock prevents a concurrent operation from seeing
            # this retained runner before its executor handoff is recorded.
            runner.future = loop.run_in_executor(None, _run_native_command_runner, runner)
        except BaseException:
            # Executor submission may have queued a worker before raising.
            # Without its exact Future, retain UNKNOWN. No command has been
            # admitted to the mailbox yet, so a sentinel can safely let a
            # queued runner return without claiming executor settlement.
            runner.unknown = True
            lifecycle.uncertain = True
            lifecycle.admission_open = False
            lifecycle.state = "retiring"
            lifecycle.failure = lifecycle.failure or "native_runner_submission_unknown"
            runner.closing = True
            with suppress(thread_queue.Full):
                runner.mailbox.put_nowait(None)
            raise ProviderUnavailableError("Provider operation completion is unknown") from None
    runner.future.add_done_callback(
        lambda completed, selected=runner: _runner_future_finished(completed, selected)
    )
    return runner


async def _stop_native_runner(
    reservation: _ProgressReservation | None,
) -> tuple[bool, bool]:
    """Join the retained runner after its final checked command has returned."""

    if reservation is None:
        return True, False
    runner = reservation.runner
    if runner is None:
        return True, False
    if runner.unknown or runner.future is None:
        return False, False
    with runner.lifecycle.lock:
        active_commands = [
            operation
            for operation in runner.lifecycle.operations.values()
            if operation.runner is runner
            and (
                operation.settlement_unknown
                or not operation.runner_returned.is_set()
                or operation.retained
            )
        ]
    if active_commands:
        return False, False
    if not runner.closing:
        runner.closing = True
        try:
            runner.mailbox.put_nowait(None)
        except thread_queue.Full:
            runner.unknown = True
            with runner.lifecycle.lock:
                runner.lifecycle.uncertain = True
                runner.lifecycle.admission_open = False
                runner.lifecycle.state = "retiring"
                runner.lifecycle.failure = runner.lifecycle.failure or "native_runner_close_unknown"
            return False, False
    cancelled = False
    while not runner.future.done():
        try:
            await asyncio.shield(runner.future)
        except asyncio.CancelledError:
            cancelled = True
        except BaseException:
            break
    if runner.future.cancelled() or not runner.worker_returned.is_set():
        runner.unknown = True
        with runner.lifecycle.lock:
            runner.lifecycle.uncertain = True
            runner.lifecycle.admission_open = False
            runner.lifecycle.state = "retiring"
            runner.lifecycle.failure = (
                runner.lifecycle.failure or "native_runner_settlement_unknown"
            )
        return False, cancelled
    try:
        runner.future.result()
    except BaseException:
        runner.unknown = True
        with runner.lifecycle.lock:
            runner.lifecycle.uncertain = True
            runner.lifecycle.admission_open = False
            runner.lifecycle.state = "retiring"
            runner.lifecycle.failure = runner.lifecycle.failure or "native_runner_task_failed"
        return False, cancelled
    if cancelled:
        # The close observer remembers cancellation, but a confirmed worker
        # return remains valid and the caller handles cancellation separately.
        return True, True
    return True, False


@dataclass
class _RunResult:
    value: Any
    cancelled: bool
    operation: _Operation


async def _submit_operation(
    owner: Any,
    function: Callable[..., Any],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    *,
    lease: _StreamLease | None = None,
    transfer_required: bool = False,
    retirement_internal: bool = False,
    stream_action: str | None = None,
    request_member: Any = _CURRENT_MEMBER,
) -> _Operation:
    if _cleanup_callback_active.get():
        raise ProviderUnavailableError("Provider is unavailable")
    loop = asyncio.get_running_loop()
    from app.services.orchestrator.native_request_completion import current_request_member

    if request_member is _CURRENT_MEMBER:
        request_member = current_request_member()
    try:
        from app.services.orchestrator.llama_context_owner import _current_lease

        context_lease = _current_lease.get()
    except (ImportError, AttributeError):
        context_lease = None
    lifecycle = _get_lifecycle(owner, loop, create=True)
    runner = None
    if context_lease is not None:
        reservation = context_lease.progress_reservation
        if reservation is None:
            raise ProviderUnavailableError("Provider progress is unavailable")
        try:
            runner = await _ensure_native_runner(reservation)
        except BaseException:
            context_lease._abandon_unknown("native_runner_submission_unknown")
            raise
    cleanup_slots = 2 if getattr(function, "__name__", None) == "_generate" else 1
    registered_close_iterator = _registered_iterator_close_capability(
        owner, function, args, kwargs, request_member
    )
    cancelled_before_submission = False
    while True:
        try:
            operation = _allocate_operation(
                lifecycle,
                owner,
                loop,
                lease=lease,
                transfer_required=transfer_required,
                retirement_internal=retirement_internal,
                stream_action=stream_action,
                wait_for_capacity=stream_action == "close",
                cleanup_slots=cleanup_slots,
                request_member=request_member,
                context_lease=context_lease,
                runner=runner,
                execution_context=_new_stream_producer_context(),
                registered_close_iterator=registered_close_iterator,
            )
            operation.cancelled_before_submission = cancelled_before_submission
            if context_lease is not None:
                context_lease.retain_operation(operation)
            break
        except _OperationCapacityError:
            cancelled_before_submission = (
                await _wait_for_operation_capacity(lifecycle, cleanup_slots, lease, stream_action)
                or cancelled_before_submission
            )
    if runner is not None:
        command = _RunnerCommand(operation, function, args, kwargs)
        operation.references = (command, runner)
        try:
            runner.mailbox.put_nowait(command)
        except thread_queue.Full:
            _mark_unknown(operation, "native_runner_mailbox_unavailable")
            if lease is not None:
                lease.cleanup_unknown = True
            raise ProviderUnavailableError("Provider operation completion is unknown") from None
    else:
        submission_coro = asyncio.to_thread(_run_body, operation, function, args, kwargs)
        # Keep the exact coroutine reachable until create_task has conclusively
        # returned. A task factory may schedule it and then raise before handing
        # its Task back to us, so the exception alone cannot prove non-submission.
        operation.references = (function, args, kwargs, submission_coro)
        try:
            task = loop.create_task(submission_coro)
        except BaseException:
            with lifecycle.lock:
                operation.state = _OperationState.UNKNOWN
                operation.retained = True
                lifecycle.uncertain = True
                lifecycle.admission_open = False
                lifecycle.state = "retiring"
                if lifecycle.failure is None:
                    lifecycle.failure = "operation_submission_unknown"
                if lease is not None:
                    lease.cleanup_unknown = True
                    lease.stop_requested = True
                    if stream_action == "close":
                        lifecycle.failure = lifecycle.failure or "iterator_close_submission_unknown"
            _signal_lifecycle(lifecycle)
            raise
        operation.task = task
        _track_task(_worker_tasks, id(owner), task)
        task.add_done_callback(
            lambda completed, op=operation: _executor_task_finished(op, completed)
        )
    return operation


async def _wait_operation(operation: _Operation) -> tuple[_BodyOutcome | None, bool]:
    cancelled = False
    while True:
        with operation.lifecycle.lock:
            if operation.state in (
                _OperationState.BODY_RETURNED,
                _OperationState.BODY_RAISED,
                _OperationState.UNKNOWN,
            ):
                return operation.outcome, cancelled
        try:
            await asyncio.shield(operation.completion)
        except asyncio.CancelledError:
            # Cancellation belongs to this observer; keep awaiting the retained
            # record so an accepted callable cannot be mistaken for completion.
            cancelled = True


async def _settle_executor_wrapper(operation: _Operation) -> bool:
    """Join this exact executor wrapper after its body outcome is confirmed."""

    if operation.runner is not None:
        settled = operation.runner_settled
        if settled is None:
            _mark_executor_settlement_unknown(operation, "native_runner_command_unknown")
            return False
        cancelled = False
        while not settled.done():
            try:
                await asyncio.shield(settled)
            except asyncio.CancelledError:
                cancelled = True
            except BaseException:
                break
        if not operation.runner_returned.is_set():
            _mark_executor_settlement_unknown(operation, "native_runner_command_unknown")
        return cancelled
    task = operation.task
    if task is None:
        return False
    cancelled = False
    observer = asyncio.current_task()
    cancelling = getattr(observer, "cancelling", None)
    initial_cancellation_count = cancelling() if callable(cancelling) else None
    while not task.done():
        try:
            # asyncio.wait does not propagate an inner task's cancellation to
            # this observer. If this await itself is cancelled, that is the
            # observer's cancellation even when the wrapped task is cancelled
            # in the same event-loop turn.
            await asyncio.wait((task,), return_when=asyncio.FIRST_COMPLETED)
        except asyncio.CancelledError:
            cancelled = True
        except BaseException:
            # The body outcome is authoritative here; wrapper diagnostics are
            # not allowed to replace the callable's result or primary error.
            break
    if not task.cancelled():
        # asyncio.wait observes completion but deliberately does not retrieve
        # the task's exception. The body outcome is authoritative here.
        with suppress(BaseException):
            task.exception()
    if task.cancelled():
        # Cancellation of asyncio.to_thread's wrapper does not stop its thread.
        # The worker sets this only after publishing its actual body outcome.
        waiter_coro = asyncio.to_thread(operation.worker_returned.wait)
        waiter = None
        try:
            waiter = asyncio.create_task(waiter_coro)
        except BaseException:
            # A task factory may enqueue this waiter and then raise. Retain its
            # coroutine and classify settlement as unknown unless the worker's
            # own return event already proves the synchronous body has exited.
            with operation.lifecycle.lock:
                operation.references = (*operation.references, waiter_coro)
            if not operation.worker_returned.is_set():
                _mark_executor_settlement_unknown(operation, "executor_wrapper_settlement_unknown")
            if callable(cancelling) and cancelling() > initial_cancellation_count:
                cancelled = True
            _prune_tracked_task(_worker_tasks, id(operation.owner), task)
            return cancelled
        while not waiter.done():
            try:
                await asyncio.wait((waiter,), return_when=asyncio.FIRST_COMPLETED)
            except asyncio.CancelledError:
                cancelled = True
            except BaseException:
                break
        if not waiter.cancelled():
            with suppress(BaseException):
                waiter.exception()
        if not operation.worker_returned.is_set():
            _mark_executor_settlement_unknown(operation, "executor_wrapper_settlement_unknown")
    if callable(cancelling) and cancelling() > initial_cancellation_count:
        # Preserve caller cancellation even if the inner wrapper was also
        # cancelled before asyncio.wait resumed this observer.
        cancelled = True
    _prune_tracked_task(_worker_tasks, id(operation.owner), task)
    return cancelled


def _mark_executor_settlement_unknown(operation: _Operation, failure: str) -> None:
    """Retain a confirmed body outcome when its executor wrapper is uncertain."""

    lifecycle = operation.lifecycle
    with lifecycle.lock:
        operation.settlement_unknown = True
        operation.retained = True
        lifecycle.uncertain = True
        lifecycle.admission_open = False
        lifecycle.state = "retiring"
        if lifecycle.failure is None:
            lifecycle.failure = failure
        if operation.lease is not None:
            operation.lease.cleanup_unknown = True
        lifecycle.actual_changed.set()
    member = operation.request_member
    if member is not None:
        with suppress(BaseException):
            member.group.mark_native_work(member, known=False)
            member.group.fail(member, failure, unknown=True)
    if lifecycle.changed is not None:
        lifecycle.changed.set()


async def _run_native_internal(
    provider: Any,
    function: Callable[..., Any],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    *,
    lease: _StreamLease | None = None,
    transfer_required: bool = False,
    retirement_internal: bool = False,
    cleanup_failure_code: str | None = None,
    stream_action: str | None = None,
    preserve_result_after_cancel: bool = False,
    request_member: Any = _CURRENT_MEMBER,
) -> _RunResult:
    owner = provider_owner(provider)
    operation = await _submit_operation(
        owner,
        function,
        args,
        kwargs,
        lease=lease,
        transfer_required=transfer_required,
        retirement_internal=retirement_internal,
        stream_action=stream_action,
        request_member=request_member,
    )
    outcome, cancelled = await _wait_operation(operation)
    if (
        operation.state in (_OperationState.BODY_RETURNED, _OperationState.BODY_RAISED)
        and outcome is not None
    ):
        cancelled = (await _settle_executor_wrapper(operation)) or cancelled
    cancelled = cancelled or operation.cancelled_before_submission
    if operation.state is _OperationState.UNKNOWN or outcome is None:
        # Unknown submitted work remains retained and admission stays closed.
        raise ProviderUnavailableError("Provider operation completion is unknown")
    if outcome.returned:
        if transfer_required:
            return _RunResult(outcome.value, cancelled, operation)
        value = outcome.value
        if operation.settlement_unknown:
            if cancelled and not preserve_result_after_cancel:
                raise asyncio.CancelledError
            return _RunResult(value, cancelled, operation)
        _release_operation(operation)
        if cancelled and not preserve_result_after_cancel:
            raise asyncio.CancelledError
        return _RunResult(value, cancelled, operation)
    error = outcome.error
    if cleanup_failure_code is not None:
        with operation.lifecycle.lock:
            if operation.lifecycle.failure is None:
                operation.lifecycle.failure = cleanup_failure_code
    if operation.settlement_unknown:
        if cancelled:
            raise asyncio.CancelledError
        if error is None:
            raise ProviderUnavailableError("Provider operation completion is unknown")
        raise error
    _release_operation(operation)
    if cancelled:
        raise asyncio.CancelledError
    if error is None:
        raise ProviderUnavailableError("Provider operation completion is unknown")
    raise error


def _direct_iterator_candidate(
    function: Callable[..., Any], args: tuple[Any, ...], kwargs: dict[str, Any]
) -> _DeferredDirectIterator | None:
    """Recognize only exact checked advancement and close operations."""

    iterator = None
    if function is next and args and isinstance(args[0], _DeferredDirectIterator):
        iterator = args[0]
        if kwargs or len(args) not in (1, 2):
            raise ProviderUnavailableError("Provider cannot continue this request")
    else:
        bound = getattr(function, "__self__", None)
        function_code = getattr(function, "__func__", None)
        if isinstance(bound, _DeferredDirectIterator):
            method_arguments = {
                _DeferredDirectIterator.__next__: (0, 0),
                _DeferredDirectIterator.send: (1, 1),
                _DeferredDirectIterator.throw: (1, 3),
                _DeferredDirectIterator.close: (0, 0),
            }
            expected = method_arguments.get(function_code)
            if expected is None:
                raise ProviderUnavailableError("Provider cannot continue this request")
            if kwargs or not expected[0] <= len(args) <= expected[1]:
                raise ProviderUnavailableError("Provider cannot continue this request")
            iterator = bound
    return iterator


def _registered_iterator_close_capability(
    owner: Any,
    function: Callable[..., Any],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    request_member: Any,
) -> _DeferredDirectIterator | None:
    """Capture only the exact active registered close accepted for admission."""

    iterator = getattr(function, "__self__", None)
    if not isinstance(iterator, _DeferredDirectIterator):
        return None
    if getattr(function, "__func__", None) is not _DeferredDirectIterator.close or args or kwargs:
        return None
    lifetime = iterator._lifetime
    if (
        not iterator._target_provenance_required
        or not iterator._target_binding_is_current()
        or iterator._owner is not owner
        or lifetime is None
        or lifetime.request_member is not request_member
        or lifetime.iterator is not iterator
        or iterator._finished
    ):
        return None
    with _registry_guard:
        record = _direct_calls.get(id(owner))
        if (
            record is not lifetime.record
            or record.owner is not owner
            or record.tokens.get(id(lifetime)) is not lifetime
            or record.active <= 0
        ):
            return None
    return iterator


def _registered_iterator_close_is_in_flight(
    owner: Any,
    iterator: _DeferredDirectIterator,
    request_member: Any,
    loop: asyncio.AbstractEventLoop,
) -> bool:
    """Recognize only the exact retained close operation for this iterator."""

    if not iterator._target_provenance_required:
        return False
    lifecycle = _get_lifecycle(owner, loop, create=False)
    if lifecycle is None:
        return False
    with lifecycle.lock:
        for operation in lifecycle.operations.values():
            if (
                operation.owner is not owner
                or operation.request_member is not request_member
                or not operation.retained
                or operation.registered_close_iterator is not iterator
            ):
                continue
            return True
    return False


async def _ensure_direct_iterator_context(
    provider: Any,
    iterator: _DeferredDirectIterator,
    member: Any,
) -> tuple[Any, Any] | None:
    """Acquire one physical context for this iterator's complete lifetime."""

    from app.services.orchestrator.llama_context_owner import (
        _current_lease,
        generation_for,
        native_context,
    )

    current_loop = asyncio.get_running_loop()
    current_lease = _current_lease.get()
    lifetime = iterator._lifetime
    if lifetime is None:
        raise ProviderUnavailableError("Provider cannot continue this request")
    if current_lease is not None:
        if (
            current_lease.generation.client is not iterator._owner
            or current_lease.request_member not in (None, member)
        ):
            raise ProviderUnavailableError("Provider cannot continue this request")
        with lifetime.retained_context_lock:
            if lifetime.retained_context_lease not in (None, current_lease):
                raise ProviderUnavailableError("Provider cannot continue this request")
        return None
    if generation_for(provider) is None:
        # Preserve the legacy direct-wrapper path for an unregistered adapter.
        # It has no construction-owned physical context to retain.
        return None

    while True:
        create = False
        with lifetime.retained_context_lock:
            state = lifetime.retained_context_state
            if state == "active":
                if lifetime.retained_context_loop is not current_loop:
                    raise ProviderUnavailableError("Provider cannot continue this request")
                return lifetime.retained_context_manager, lifetime.retained_context_lease
            if state == "entering":
                ready = lifetime.retained_context_ready
                if ready is None or lifetime.retained_context_loop is not current_loop:
                    raise ProviderUnavailableError("Provider cannot continue this request")
            elif state == "none":
                if member is not None and member.group.is_stopping:
                    raise ProviderUnavailableError(
                        "Provider cannot continue this request"
                    ) from None
                manager = native_context(provider, _request_member=member, _activate=False)
                ready = current_loop.create_future()
                lifetime.retained_context_manager = manager
                lifetime.retained_context_ready = ready
                lifetime.retained_context_loop = current_loop
                lifetime.retained_context_state = "entering"
                create = True
            else:
                raise ProviderUnavailableError("Provider cannot continue this request")
        if not create:
            await asyncio.shield(ready)
            continue
        try:
            lease = await manager.__aenter__()
            if lease is None:
                raise ProviderUnavailableError("Provider context is unavailable")
        except BaseException:
            with lifetime.retained_context_lock:
                lifetime.retained_context_state = "unknown"
                if not ready.done():
                    ready.set_result(None)
            raise
        with lifetime.retained_context_lock:
            if lifetime.retained_context_state != "entering":
                lease._abandon_unknown("direct_iterator_context_admission_changed")
                if not ready.done():
                    ready.set_result(None)
                raise ProviderUnavailableError("Provider context is unavailable")
            lifetime.retained_context_lease = lease
            lifetime.retained_context_state = "active"
            if not ready.done():
                ready.set_result(lease)
        return manager, lease


async def _finish_direct_iterator_context(
    iterator: _DeferredDirectIterator,
    primary: BaseException | None,
) -> None:
    lifetime = iterator._lifetime
    if lifetime is None:
        return
    with lifetime.retained_context_lock:
        if lifetime.retained_context_state != "active":
            return
        manager = lifetime.retained_context_manager
        lease = lifetime.retained_context_lease
        if manager is None or lease is None:
            lifetime.retained_context_state = "unknown"
            return
        lifetime.retained_context_state = "finishing"
    failure: BaseException | None = None
    try:
        if primary is None:
            await manager.__aexit__(None, None, None)
        else:
            with suppress(BaseException):
                await manager.__aexit__(type(primary), primary, primary.__traceback__)
    except BaseException as error:
        failure = error
    settled = not lease.active and not lease.unknown and failure is None
    with lifetime.retained_context_lock:
        lifetime.retained_context_state = "finished" if settled else "unknown"
        if settled:
            lifetime.retained_context_manager = None
            lifetime.retained_context_lease = None
            lifetime.retained_context_ready = None
    if settled and lifetime.iterator is iterator:
        _release_direct_call(lifetime)
    if failure is not None and primary is None:
        raise ProviderUnavailableError("Provider completion is unavailable") from None


async def run_native(provider: Any, function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Run one synchronous provider call and retain its actual completion record."""
    from app.services.orchestrator.native_request_completion import (
        bind_request_member,
        current_request_group,
        current_request_member,
        finish_request_member,
        request_member_scope,
    )

    direct_iterator = _direct_iterator_candidate(function, args, kwargs)
    direct_iterator_cleanup = (
        direct_iterator is not None
        and getattr(function, "__self__", None) is direct_iterator
        and getattr(function, "__func__", None) is _DeferredDirectIterator.close
    )
    retained_member = _direct_iterator_member_for_call(
        provider,
        function,
        args,
        kwargs,
        iterator=direct_iterator,
        cleanup=direct_iterator_cleanup,
    )
    current_member = current_request_member()
    if retained_member is not None and current_member not in (None, retained_member):
        raise ProviderUnavailableError("Request member is unavailable")
    if (
        direct_iterator_cleanup
        and direct_iterator is not None
        and _registered_iterator_close_is_in_flight(
            provider_owner(provider),
            direct_iterator,
            retained_member,
            asyncio.get_running_loop(),
        )
    ):
        # A second observer must not enter runner acquisition for the same
        # retained close: its in-flight progress credit belongs to the first
        # operation, whose cleanup and runner settlement remain authoritative.
        raise ProviderUnavailableError()
    if retained_member is not None and current_request_group() is retained_member.group:

        @contextmanager
        def retained_scope():
            with bind_request_member(retained_member):
                yield retained_member, False

        member_scope = retained_scope()
    else:
        member_scope = request_member_scope("native_operation", resource=provider)
    operation_function = function
    operation_args = args
    if direct_iterator is not None and function is next and len(args) == 2:
        operation_function = _next_or_sentinel
    with member_scope as (member, owned):
        reason = None
        primary: BaseException | None = None
        try:
            retained_sealed_continuation = (
                direct_iterator is not None
                and retained_member is not None
                and retained_member.group.contains_active_member(retained_member)
                and not retained_member.group.is_open
                and not retained_member.group.is_stopping
            )
            if (
                member is not None
                and not member.group.is_open
                and not direct_iterator_cleanup
                and not retained_sealed_continuation
            ):
                raise ProviderUnavailableError("Request admission is closed")
            from app.services.orchestrator.llama_context_owner import (
                _current_lease,
                bind_native_cleanup_lease,
                bind_native_lease,
                generation_for,
                native_context,
            )

            operation_member = retained_member if retained_member is not None else member
            if direct_iterator is not None and _current_lease.get() is None:
                retained_context = await _ensure_direct_iterator_context(
                    provider, direct_iterator, operation_member
                )
                if retained_context is not None:
                    _manager, retained_lease = retained_context
                    lease_scope = (
                        bind_native_cleanup_lease(retained_lease)
                        if direct_iterator_cleanup
                        else bind_native_lease(retained_lease)
                    )
                    with lease_scope:
                        result = await _run_native_internal(
                            provider,
                            operation_function,
                            operation_args,
                            kwargs,
                            retirement_internal=direct_iterator_cleanup,
                            request_member=operation_member,
                        )
                else:
                    async with native_context(provider):
                        result = await _run_native_internal(
                            provider,
                            operation_function,
                            operation_args,
                            kwargs,
                            request_member=operation_member,
                        )
            elif generation_for(provider) is not None and _current_lease.get() is None:
                async with native_context(provider):
                    result = await _run_native_internal(
                        provider,
                        operation_function,
                        operation_args,
                        kwargs,
                        request_member=operation_member,
                    )
            else:
                result = await _run_native_internal(
                    provider,
                    operation_function,
                    operation_args,
                    kwargs,
                    request_member=operation_member,
                )
            return result.value
        except asyncio.CancelledError as error:
            primary = error
            reason = "native_operation_cancelled"
            raise
        except BaseException as error:
            primary = error
            reason = "native_operation_failed"
            raise
        finally:
            if direct_iterator is not None and direct_iterator._finished:
                await _finish_direct_iterator_context(direct_iterator, primary)
            finish_request_member(member, owned=owned, reason=reason)


def _direct_iterator_member_for_call(
    provider: Any,
    function: Callable[..., Any],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    *,
    iterator: _DeferredDirectIterator | None = None,
    cleanup: bool = False,
) -> Any:
    """Transfer one exact retained direct iterator member into its next call."""

    if iterator is None:
        return None
    try:
        owner = provider_owner(provider)
        from app.services.orchestrator.native_request_completion import (
            current_request_group,
        )

        group = current_request_group()
        loop = asyncio.get_running_loop()
    except BaseException:
        raise ProviderUnavailableError("Provider cannot continue this request") from None
    lifetime = iterator._lifetime
    member = lifetime.request_member if lifetime is not None else None
    origin_group = iterator._origin_group
    if (
        lifetime is None
        or owner is not iterator._owner
        or group is not origin_group
        or origin_group is not None
        and loop is not origin_group.loop
        or member is not None
        and (
            member.group is not origin_group
            or not (
                cleanup
                and origin_group.is_stopping
                and _group_retains_member(origin_group, member)
                or origin_group.contains_active_member(member)
            )
        )
        or iterator._origin_member is not None
        and (
            origin_group is None
            or not (
                cleanup
                and origin_group.is_stopping
                and _group_retains_member(origin_group, iterator._origin_member)
                or origin_group.contains_active_member(iterator._origin_member)
            )
        )
        or not iterator._origin_is_current(cleanup=cleanup)
    ):
        raise ProviderUnavailableError("Provider cannot continue this request")
    with _registry_guard:
        record = _direct_calls.get(id(owner))
        if (
            record is not lifetime.record
            or record.owner is not owner
            or record.tokens.get(id(lifetime)) is not lifetime
            or record.active <= 0
            or lifetime.request_member is not member
            or lifetime.iterator is not iterator
            or iterator._finished
        ):
            raise ProviderUnavailableError("Provider cannot continue this request")
    return member


def _group_retains_member(group: Any, member: Any) -> bool:
    """Check one exact member retained for cleanup while its group is stopping."""

    with group._lock:
        return group._members.get(member.sequence) is member


def _admit_stream(
    owner: Any,
    loop: asyncio.AbstractEventLoop,
    progress_reservation: _ProgressReservation | None = None,
    *,
    reserve_progress: bool = True,
    reserve_cleanup: bool = False,
) -> _StreamLease:
    if _cleanup_callback_active.get():
        raise ProviderUnavailableError("Provider is unavailable")
    lifecycle = _get_lifecycle(owner, loop, create=True)
    with lifecycle.lock:
        if not lifecycle.admission_open or lifecycle.state != "open":
            raise ProviderUnavailableError("Provider is retired")
        if len(lifecycle.streams) >= MAX_PROVIDER_STREAMS:
            raise ProviderUnavailableError("Provider stream capacity reached")
        if lifecycle.next_stream >= _MAX_SEQUENCE:
            lifecycle.admission_open = False
            lifecycle.state = "retiring"
            lifecycle.failure = lifecycle.failure or "stream_sequence_exhausted"
            raise ProviderUnavailableError("Provider stream capacity reached")
        owns_progress = progress_reservation is None and reserve_progress
        if progress_reservation is None:
            if reserve_progress and (
                len(lifecycle.operations) + lifecycle.progress_reservations
                >= MAX_PROVIDER_OPERATIONS
            ):
                raise ProviderUnavailableError("Provider operation capacity reached")
            if reserve_progress:
                lifecycle.progress_reservations += 1
                progress_reservation = _ProgressReservation(lifecycle, owner)
        elif (
            progress_reservation.lifecycle is not lifecycle
            or progress_reservation.owner is not owner
            or not progress_reservation.active
            or lifecycle.progress_credits.get(id(progress_reservation)) is not progress_reservation
        ):
            raise ProviderUnavailableError("Provider progress is unavailable")
        cleanup_reservations = 2 if reserve_cleanup else 0
        cleanup_from_progress = False
        if cleanup_reservations and progress_reservation is not None and not owns_progress:
            if progress_reservation.cleanup_reservations < cleanup_reservations:
                if owns_progress:
                    lifecycle.progress_reservations = max(0, lifecycle.progress_reservations - 1)
                    progress_reservation.active = False
                raise ProviderUnavailableError("Provider cleanup capacity reached")
            progress_reservation.cleanup_reservations -= cleanup_reservations
            cleanup_from_progress = True
        additional_cleanup_reservations = 0 if cleanup_from_progress else cleanup_reservations
        if (
            len(lifecycle.cleanup_references)
            + lifecycle.cleanup_reservations
            + additional_cleanup_reservations
            > MAX_PROVIDER_CLEANUP_REFERENCES
        ):
            if cleanup_from_progress and progress_reservation is not None:
                progress_reservation.cleanup_reservations += cleanup_reservations
            if owns_progress and progress_reservation is not None:
                lifecycle.progress_reservations = max(0, lifecycle.progress_reservations - 1)
                progress_reservation.active = False
            raise ProviderUnavailableError("Provider cleanup capacity reached")
        lifecycle.cleanup_reservations += additional_cleanup_reservations
        if owns_progress and progress_reservation is not None:
            lifecycle.progress_credits[id(progress_reservation)] = progress_reservation
        lifecycle.next_stream += 1
        lease = _StreamLease(
            lifecycle,
            lifecycle.next_stream,
            owner,
            loop,
            progress_reservation=progress_reservation,
            owns_progress_reservation=owns_progress,
            cleanup_reservations=cleanup_reservations,
            cleanup_from_progress=cleanup_from_progress,
        )
        lifecycle.streams[lease.sequence] = lease
        return lease


def _release_stream(lease: _StreamLease) -> None:
    lifecycle = lease.lifecycle
    with lifecycle.lock:
        if not lease.active:
            return
        lease.active = False
        lease.iterator = None
        lease.pending_setup = None
        lease.consumer_wake = None
        lease.consumer_failure = None
        if (
            lease.context_lease is not None
            and lease.context_lease.stop_callback is lease.stop_callback
        ):
            lease.context_lease.stop_callback = None
        lease.stop_callback = None
        if (
            lease.cleanup_from_progress
            and lease.progress_reservation is not None
            and lease.progress_reservation.active
            and not lease.progress_reservation.release_requested
        ):
            lease.progress_reservation.cleanup_reservations += lease.cleanup_reservations
        else:
            lifecycle.cleanup_reservations = max(
                0, lifecycle.cleanup_reservations - lease.cleanup_reservations
            )
        lease.cleanup_reservations = 0
        lifecycle.streams.pop(lease.sequence, None)
        if lease.owns_progress_reservation:
            reservation = lease.progress_reservation
            if reservation is not None and reservation.active:
                reservation.release_requested = True
                if not reservation.in_flight:
                    reservation.active = False
                    reservation.release_requested = False
                    lifecycle.progress_reservations = max(0, lifecycle.progress_reservations - 1)
                    if lifecycle.progress_credits.get(id(reservation)) is reservation:
                        lifecycle.progress_credits.pop(id(reservation), None)
    _signal_lifecycle(lifecycle)


def _release_settled_stream_cleanup(lease: _StreamLease) -> bool:
    """Return stream cleanup credits only after its actual close outcome."""

    lifecycle = lease.lifecycle
    with lifecycle.lock:
        if lease.cleanup_unknown or lease.cleanup_reservations == 0:
            return not lease.cleanup_unknown
        if lease.cleanup_reservations > lifecycle.cleanup_reservations:
            lease.cleanup_unknown = True
            lifecycle.uncertain = True
            lifecycle.admission_open = False
            lifecycle.state = "retiring"
            lifecycle.failure = lifecycle.failure or "stream_cleanup_credit_unverified"
            return False
        else:
            lifecycle.cleanup_reservations -= lease.cleanup_reservations
            lease.cleanup_reservations = 0
            lease.cleanup_from_progress = False
    _signal_lifecycle(lifecycle)
    return True


async def _wait_for_actual_stream_work(lease: _StreamLease) -> bool:
    """Do not release factory/iterator ownership while native work is running."""

    while True:
        with lease.lifecycle.lock:
            pending = [
                operation
                for operation in lease.lifecycle.operations.values()
                if operation.lease is lease
                and operation.stream_action in ("factory", "next")
                and not operation.settled.is_set()
            ]
        if not pending:
            return True
        for operation in pending:
            if operation.state is _OperationState.UNKNOWN:
                # We cannot tell whether the callable is still active. Keep
                # the iterator and lease; closing now could overlap next().
                return False
            cancelled = False
            while not operation.settled.is_set():
                try:
                    await asyncio.shield(operation.settled.wait())
                except asyncio.CancelledError:
                    cancelled = True
            if cancelled:
                # The producer still owns the iterator. Cancellation is
                # remembered by its task, but cannot overlap close with next.
                lease.stop_requested = True


async def _produce_stream(
    provider: Any,
    lease: _StreamLease,
    iterator_factory: Callable[..., Any],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    queue: asyncio.Queue[tuple[str, Any]],
    sentinel: object,
    state: dict[str, bool],
) -> None:
    """Run producer ownership in its own task, never in the consumer context."""

    from app.services.orchestrator.llama_context_owner import (
        NativeContextUnavailableError,
        generation_for,
        native_context,
    )

    async def publish_terminal(terminal: tuple[str, Any]) -> None:
        stop_event = lease.stop_event
        if stop_event is None:
            await queue.put(terminal)
            state["terminal_published"] = True
            return
        with lease.lifecycle.lock:
            if not lease.stop_requested and not queue.full():
                try:
                    queue.put_nowait(terminal)
                except asyncio.QueueFull:
                    pass
                else:
                    state["terminal_published"] = True
                    return
        if queue.full() and lease.terminal_waiting is not None:
            lease.terminal_waiting.set()
        put_capture: list[asyncio.Task | None] = [None]
        lease.publication_task_captures.append(put_capture)

        async def put_terminal() -> None:
            put_capture[0] = asyncio.current_task()
            await queue.put(terminal)

        put_coro = put_terminal()
        lease.publication_coroutines.append(put_coro)
        try:
            put_task = asyncio.create_task(put_coro)
        except BaseException:
            await _capture_ambiguous_publication_task(lease, put_capture)
            _mark_terminal_publication_unknown(lease, queue)
            await _cancel_captured_publication_tasks(lease)
            return
        lease.publication_tasks.append(put_task)
        stop_capture: list[asyncio.Task | None] = [None]
        lease.publication_task_captures.append(stop_capture)

        async def wait_for_stop() -> None:
            stop_capture[0] = asyncio.current_task()
            await stop_event.wait()

        stop_coro = wait_for_stop()
        lease.publication_coroutines.append(stop_coro)
        try:
            stop_task = asyncio.create_task(stop_coro)
        except BaseException:
            # Task creation may enqueue before raising. Keep the exact coroutine
            # and the known publisher task on the retained lease; never retry
            # this terminal publication with a fresh pair of tasks.
            await _capture_ambiguous_publication_task(lease, stop_capture)
            _mark_terminal_publication_unknown(lease, queue)
            await _cancel_captured_publication_tasks(lease)
            return
        lease.publication_tasks.append(stop_task)
        try:
            done, _pending = await asyncio.wait(
                (put_task, stop_task), return_when=asyncio.FIRST_COMPLETED
            )
            if put_task in done:
                put_task.result()
                state["terminal_published"] = True
                return
            put_task.cancel()
            with suppress(asyncio.CancelledError):
                await put_task
            with suppress(asyncio.QueueEmpty):
                queue.get_nowait()
            with suppress(asyncio.QueueFull):
                queue.put_nowait(("closed", None))
            state["terminal_published"] = True
        finally:
            for waiter in (put_task, stop_task):
                if not waiter.done():
                    waiter.cancel()
            await asyncio.gather(put_task, stop_task, return_exceptions=True)
            for waiter in (put_task, stop_task):
                with suppress(ValueError):
                    lease.publication_tasks.remove(waiter)
            for coroutine in (put_coro, stop_coro):
                with suppress(ValueError):
                    lease.publication_coroutines.remove(coroutine)
            for capture in (put_capture, stop_capture):
                with suppress(ValueError):
                    lease.publication_task_captures.remove(capture)

    def _mark_terminal_publication_unknown(
        selected: _StreamLease, selected_queue: asyncio.Queue[tuple[str, Any]]
    ) -> None:
        selected.publication_unknown = True
        selected.cleanup_unknown = True
        lifecycle = selected.lifecycle
        with lifecycle.lock:
            lifecycle.uncertain = True
            lifecycle.admission_open = False
            lifecycle.state = "retiring"
            lifecycle.failure = lifecycle.failure or "stream_terminal_publication_unknown"
        member = selected.request_member
        if member is not None:
            with suppress(BaseException):
                member.group.mark_native_work(member, known=False)
                member.group.fail(member, "stream_terminal_publication_unknown", unknown=True)
        if selected.terminal_waiting is not None:
            selected.terminal_waiting.set()
        # Wake a consumer even if a queue.put task was accepted just before its
        # factory raised. The lease and ambiguous coroutine/task remain retained.
        with suppress(asyncio.QueueEmpty):
            selected_queue.get_nowait()
        with suppress(asyncio.QueueFull):
            selected_queue.put_nowait(("closed", None))
        _signal_lifecycle(lifecycle)

    async def _capture_ambiguous_publication_task(
        selected: _StreamLease, capture: list[asyncio.Task | None]
    ) -> None:
        # Let an enqueue-then-raise factory start this exact wrapper once; the
        # wrapper records its own Task before it can perform the queue action.
        with suppress(BaseException):
            await asyncio.sleep(0)
        candidate = capture[0]
        if candidate is not None and all(
            existing is not candidate for existing in selected.publication_tasks
        ):
            selected.publication_tasks.append(candidate)

    async def _cancel_captured_publication_tasks(selected: _StreamLease) -> None:
        tasks = tuple(selected.publication_tasks)
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            waiter = asyncio.gather(*tasks, return_exceptions=True)
            cancelled = False
            while not waiter.done():
                try:
                    await asyncio.shield(waiter)
                except asyncio.CancelledError:
                    cancelled = True
            if cancelled:
                raise asyncio.CancelledError

    try:
        if lease.context_lease is not None:
            lease.context_lease.before_release_callbacks.append(
                lambda selected=lease: _release_settled_stream_cleanup(selected)
            )
            await _produce_stream_body(
                provider,
                lease,
                iterator_factory,
                args,
                kwargs,
                queue,
                sentinel,
                state,
                lease.context_lease,
            )
        elif generation_for(provider) is not None:
            async with native_context(
                provider,
                _request_member=lease.request_member,
                _progress_reservation=lease.progress_reservation,
                _activate=False,
            ) as context_lease:
                lease.progress_reservation = context_lease.progress_reservation
                lease.owns_progress_reservation = False
                # The stream cleanup slots are part of this exact context
                # lifetime's prepaid cleanup budget. Transfer them only after
                # the producer owns the context gate; queued streams therefore
                # hold neither a progress slot nor cleanup capacity.
                with lease.lifecycle.lock:
                    reservation = context_lease.progress_reservation
                    cleanup_credit_valid = (
                        lease.active
                        and lease.cleanup_reservations == 0
                        and lease.progress_reservation is reservation
                        and reservation is not None
                        and reservation.active
                        and reservation.cleanup_reservations >= 2
                        and lease.lifecycle.progress_credits.get(id(reservation)) is reservation
                    )
                    if cleanup_credit_valid:
                        reservation.cleanup_reservations -= 2
                        lease.cleanup_reservations = 2
                        lease.cleanup_from_progress = True
                # The stream can be created by an async wrapper before its
                # producer has acquired the context lease. Bind the already
                # admitted stop callback only after that exact producer grant,
                # so group stop reaches the lease that owns native work.
                with lease.lifecycle.lock:
                    binding_valid = (
                        cleanup_credit_valid
                        and lease.active
                        and lease.context_lease is None
                        and lease.stop_callback is not None
                        and context_lease.generation.client is lease.owner
                        and context_lease.request_member is lease.request_member
                        and context_lease.stop_callback is None
                    )
                    if binding_valid:
                        lease.context_lease = context_lease
                        context_lease.stop_callback = lease.stop_callback
                        context_lease.before_release_callbacks.append(
                            lambda selected=lease: _release_settled_stream_cleanup(selected)
                        )
                if not binding_valid:
                    context_lease.mark_unknown("native_stream_context_binding_unverified")
                    raise ProviderUnavailableError("Provider context is unavailable") from None
                await _produce_stream_body(
                    provider,
                    lease,
                    iterator_factory,
                    args,
                    kwargs,
                    queue,
                    sentinel,
                    state,
                    context_lease,
                )
        else:
            await _produce_stream_body(
                provider,
                lease,
                iterator_factory,
                args,
                kwargs,
                queue,
                sentinel,
                state,
                None,
            )
        terminal = state.get("terminal")
        if terminal is not None:
            _mark_stream_cleanup_complete(lease)
            await publish_terminal(terminal)
    except BaseException as error:
        terminal = state.get("terminal")
        if not isinstance(error, asyncio.CancelledError):
            # A completion marker is published only after native_context has
            # synchronized and settled its retained runner. If that finalizer
            # fails, its fixed error supersedes only a pending success marker;
            # a primary provider error remains the value already recorded.
            if terminal is None or terminal[0] == "done":
                context_failed = lease.context_lease is not None and lease.context_lease.unknown
                if context_failed:
                    lease.cleanup_unknown = True
                terminal_error = (
                    error
                    if type(error) is NativeContextUnavailableError or context_failed
                    else ProviderUnavailableError()
                )
                terminal = ("error", terminal_error)
            state["terminal"] = terminal
            state["completed"] = True
            _mark_stream_cleanup_complete(lease)
            if not lease.publication_unknown:
                await publish_terminal(terminal)
        else:
            state["closing"] = True
            with suppress(asyncio.QueueFull):
                queue.put_nowait(("closed", None))
        if not lease.started and lease.active:
            _release_stream(lease)
        raise
    finally:
        # The stream owns the request member until this producer has left its
        # native_context block. That block records synchronization and retained
        # runner/executor settlement before the member can be released.
        if not lease.cleanup_unknown:
            _release_stream(lease)


def _mark_stream_cleanup_complete(lease: _StreamLease) -> None:
    """Publish that callbacks settled before any terminal queue wait."""

    with lease.lifecycle.lock:
        if lease.active and not lease.cleanup_unknown:
            lease.cleanup_complete = True
    _signal_lifecycle(lease.lifecycle)


async def _produce_stream_body(
    provider: Any,
    lease: _StreamLease,
    iterator_factory: Callable[..., Any],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    queue: asyncio.Queue[tuple[str, Any]],
    sentinel: object,
    state: dict[str, bool],
    context_lease: Any,
) -> None:
    iterator = None

    async def run_operation(
        function: Callable[..., Any],
        args: tuple[Any, ...],
        call_kwargs: dict[str, Any] | None = None,
        *,
        transfer_required: bool = False,
        cleanup_failure_code: str | None = None,
        stream_action: str | None = None,
        retirement_internal: bool = False,
        preserve_result_after_cancel: bool = False,
    ) -> _RunResult:
        from app.services.orchestrator.llama_context_owner import (
            bind_native_cleanup_lease,
            bind_native_lease,
        )
        from app.services.orchestrator.native_request_completion import bind_request_member

        member_scope = (
            bind_request_member(lease.request_member)
            if lease.request_member is not None
            else nullcontext()
        )
        selected_kwargs = {} if call_kwargs is None else call_kwargs
        with member_scope:
            if context_lease is not None:
                lease_scope = (
                    bind_native_cleanup_lease(context_lease)
                    if stream_action == "close"
                    else bind_native_lease(context_lease)
                )
                with lease_scope:
                    return await _run_native_internal(
                        provider,
                        function,
                        args,
                        selected_kwargs,
                        lease=lease,
                        transfer_required=transfer_required,
                        cleanup_failure_code=cleanup_failure_code,
                        stream_action=stream_action,
                        retirement_internal=retirement_internal,
                        preserve_result_after_cancel=preserve_result_after_cancel,
                    )
            return await _run_native_internal(
                provider,
                function,
                args,
                selected_kwargs,
                lease=lease,
                transfer_required=transfer_required,
                cleanup_failure_code=cleanup_failure_code,
                stream_action=stream_action,
                retirement_internal=retirement_internal,
                preserve_result_after_cancel=preserve_result_after_cancel,
            )

    with lease.lifecycle.lock:
        lease.started = True
    try:
        factory_result = await run_operation(
            iterator_factory,
            args,
            kwargs,
            transfer_required=True,
            stream_action="factory",
        )
        iterator = factory_result.value
        with lease.lifecycle.lock:
            lease.iterator = iterator
            if factory_result.operation.settlement_unknown:
                lease.cleanup_unknown = True
        if factory_result.operation.settlement_unknown:
            # The factory's returned iterator is retained by both the operation
            # and lease, but later advancement/close cannot be claimed safe.
            raise ProviderUnavailableError("Provider operation completion is unknown")
        _release_operation(factory_result.operation, transfer_acknowledged=True)
        if factory_result.cancelled:
            raise asyncio.CancelledError
        if lease.stop_requested:
            raise asyncio.CancelledError
        while True:
            next_result = await run_operation(
                _next_or_sentinel,
                (iterator, sentinel),
                stream_action="next",
            )
            if next_result.operation.settlement_unknown:
                with lease.lifecycle.lock:
                    lease.cleanup_unknown = True
                raise ProviderUnavailableError("Provider operation completion is unknown")
            if next_result.cancelled:
                raise asyncio.CancelledError
            if lease.stop_requested:
                raise asyncio.CancelledError
            chunk = next_result.value
            if chunk is sentinel:
                state["terminal"] = ("done", None)
                state["completed"] = True
                return
            await queue.put(("item", chunk))
    except BaseException as error:
        if not isinstance(error, asyncio.CancelledError):
            state["terminal"] = ("error", error)
            state["completed"] = True
        raise
    finally:
        if not state["completed"]:
            state["closing"] = True
            with suppress(asyncio.QueueFull):
                queue.put_nowait(("closed", None))
        # An executor task can be cancelled while its synchronous factory or
        # next call is still running. Wait for the real body before any
        # iterator close or lease release.
        if not await _wait_for_actual_stream_work(lease):
            lease.cleanup_unknown = True
        with lease.lifecycle.lock:
            late_factory = next(
                (
                    operation
                    for operation in lease.lifecycle.operations.values()
                    if operation.lease is lease
                    and operation.stream_action == "factory"
                    and operation.transfer_required
                ),
                None,
            )
        if iterator is None and late_factory is not None:
            if late_factory.outcome is not None and late_factory.outcome.returned:
                iterator = late_factory.outcome.value
                with lease.lifecycle.lock:
                    lease.iterator = iterator
            elif late_factory.state is _OperationState.UNKNOWN:
                lease.cleanup_unknown = True
        if iterator is not None and not lease.cleanup_unknown:
            with lease.lifecycle.lock:
                lease.close_started = True
            try:
                close_result = await run_operation(
                    _invoke_iterator_close,
                    (iterator, provider),
                    retirement_internal=True,
                    cleanup_failure_code="iterator_close_failed",
                    stream_action="close",
                    preserve_result_after_cancel=True,
                )
                if not close_result.value.available:
                    with lease.lifecycle.lock:
                        lease.lifecycle.failure = (
                            lease.lifecycle.failure or "iterator_close_unknown"
                        )
                        lease.lifecycle.uncertain = True
                        lease.lifecycle.admission_open = False
                        lease.lifecycle.state = "retiring"
                        lease.cleanup_unknown = True
                elif close_result.value.failed:
                    with lease.lifecycle.lock:
                        lease.lifecycle.failure = lease.lifecycle.failure or "iterator_close_failed"
                else:
                    if late_factory is not None:
                        _release_operation(late_factory, transfer_acknowledged=True)
                    if lease.stop_requested and context_lease is not None:
                        context_lease.stopped = True
                        if context_lease.cache_tail_completed is None:
                            context_lease.cache_tail_completed = False
            except ProviderUnavailableError:
                # The retained operation lost a conclusive observation. Keep
                # the exact iterator in its lease; releasing it could permit a
                # later retirement to close the provider while close() still
                # runs on the native worker.
                with lease.lifecycle.lock:
                    lease.lifecycle.failure = lease.lifecycle.failure or "iterator_close_unknown"
                    lease.lifecycle.uncertain = True
                    lease.lifecycle.admission_open = False
                    lease.lifecycle.state = "retiring"
                    lease.cleanup_unknown = True
            except BaseException:
                with lease.lifecycle.lock:
                    lease.lifecycle.failure = lease.lifecycle.failure or "iterator_close_failed"
        # The context gate can admit its next owner as soon as this function
        # returns. Release the pair's aggregate capacity first, while keeping
        # the stream/member record alive through terminal publication.
        if context_lease is None:
            _release_settled_stream_cleanup(lease)


def _request_stream_stop(lease: _StreamLease, *, cancel_idle_producer: bool = True) -> None:
    """Request producer cancellation once and settle a never-started task."""

    release_unstarted = False
    consumer_wake: Callable[[], None] | None = None
    stop_event: asyncio.Event | None = None
    with lease.lifecycle.lock:
        first_request = not lease.stop_requested
        lease.stop_requested = True
        stop_event = lease.stop_event
        consumer_wake = lease.consumer_wake
        task = lease.task
        if first_request and task is not None and not lease.close_started:
            if not task.done() and not lease.started:
                task.cancel()
                # A task cancelled before its coroutine's first poll never
                # enters _produce_stream's finally. No callable was started.
                release_unstarted = True
            elif not task.done():
                work_pending = any(
                    operation.lease is lease and not operation.settled.is_set()
                    for operation in lease.lifecycle.operations.values()
                )
                # Let accepted native work return before cancellation can
                # trigger the checked iterator-close path. A producer blocked
                # between operations (for example on a full consumer queue)
                # can still be cancelled to run its close finalizer.
                if not work_pending and cancel_idle_producer:
                    task.cancel()
        elif first_request and task is not None:
            # A close callback may already be running in the retained worker.
            # Do not cancel it; stop_event releases a blocked terminal publish.
            release_unstarted = False
        elif first_request:
            # A stop can race setup before create_task publishes the retained
            # producer. The setup path checks this flag under the same lock
            # before submitting the coroutine.
            release_unstarted = not lease.started
    if stop_event is not None:
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None
        try:
            if current_loop is lease.loop:
                stop_event.set()
            else:
                lease.loop.call_soon_threadsafe(stop_event.set)
        except RuntimeError:
            lease.cleanup_unknown = True
    if consumer_wake is not None:
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None
        try:
            if current_loop is lease.loop:
                consumer_wake()
            else:
                lease.loop.call_soon_threadsafe(consumer_wake)
        except RuntimeError:
            lease.cleanup_unknown = True
    if release_unstarted:
        _release_stream(lease)


def stream_native(provider: Any, iterator_factory: Callable[..., Any], *args: Any, **kwargs: Any):
    """Return a stream whose producer task owns all native capabilities."""

    return _stream_native_impl(provider, iterator_factory, *args, **kwargs)


async def _stream_native_impl(
    provider: Any, iterator_factory: Callable[..., Any], *args: Any, **kwargs: Any
):
    """Own a synchronous iterator producer for the async consumer lifetime."""

    from app.services.orchestrator.native_request_completion import (
        admit_request_member,
        finish_request_member,
    )

    member, owned = admit_request_member("native_stream", resource=provider)
    lease: _StreamLease | None = None
    creation_ambiguous = False
    producer_coro = None
    producer: asyncio.Task | None = None
    consumer_entered = False
    try:
        owner = provider_owner(provider)
        loop = asyncio.get_running_loop()
        if member is not None and not member.group.is_open:
            raise ProviderUnavailableError("Request admission is closed")
        try:
            from app.services.orchestrator.llama_context_owner import _current_lease

            context_lease = _current_lease.get()
        except (ImportError, AttributeError):
            context_lease = None
        progress_reservation = (
            context_lease.progress_reservation
            if context_lease is not None and context_lease.generation.client is owner
            else None
        )
        try:
            from app.services.orchestrator.llama_context_owner import generation_for

            known_context = generation_for(provider) is not None
        except BaseException:
            known_context = False
        lease = _admit_stream(
            owner,
            loop,
            progress_reservation,
            reserve_progress=not known_context or context_lease is not None,
            # A queued known stream owns no cleanup slot before it owns the
            # native context gate. Once granted, the context's prepaid
            # reservation funds the stream factory/iterator cleanup pair.
            reserve_cleanup=not known_context or context_lease is not None,
        )
        lease.request_member = member
        lease.context_lease = context_lease
        lease.stop_callback = lambda: _request_stream_stop(lease)
        if context_lease is not None:
            context_lease.stop_callback = lease.stop_callback
        queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue(maxsize=1)
        sentinel = object()
        state = {
            "closing": False,
            "completed": False,
            "terminal": None,
            "terminal_published": False,
        }
        lease.stop_event = asyncio.Event()
        lease.terminal_waiting = asyncio.Event()

        def wake_unstarted_consumer() -> None:
            state["closing"] = True
            with suppress(asyncio.QueueFull):
                queue.put_nowait(("closed", None))

        def wake_consumer_unknown(error: BaseException) -> None:
            state["forced_error"] = error
            # If no item is queued, insert a wake marker. If an item is
            # already buffered, leave it intact; the consumer loop observes
            # forced_error after delivering that value or before its next wait.
            if queue.empty():
                with suppress(asyncio.QueueFull):
                    queue.put_nowait(("unknown", None))

        lease.consumer_wake = wake_unstarted_consumer
        lease.consumer_failure = wake_consumer_unknown
        if member is not None:
            member.set_stop(lease.stop_callback)
        producer_coro = _produce_stream(
            provider, lease, iterator_factory, args, kwargs, queue, sentinel, state
        )
        lease.pending_setup = producer_coro
        try:
            with lease.lifecycle.lock:
                if lease.stop_requested:
                    producer_coro.close()
                    lease.pending_setup = None
                    raise asyncio.CancelledError
                creation_ambiguous = True
                producer = _new_stream_producer_context().run(loop.create_task, producer_coro)
        except asyncio.CancelledError:
            raise
        except BaseException:
            with lease.lifecycle.lock:
                lease.stop_requested = True
                lease.cleanup_unknown = True
                lease.consumer_wake = None
                lease.lifecycle.admission_open = False
                lease.lifecycle.uncertain = True
                lease.lifecycle.state = "retiring"
                lease.lifecycle.failure = (
                    lease.lifecycle.failure or "stream_producer_task_creation_unknown"
                )
            _signal_lifecycle(lease.lifecycle)
            raise
        lease.task = producer
        creation_ambiguous = False
        lease.pending_setup = None
        _track_task(_stream_tasks, id(owner), producer)
        reason = None
        stopped = False
        primary_error: BaseException | None = None
        consumer_entered = True
        try:
            while True:
                forced_error = state.get("forced_error")
                if forced_error is not None and queue.empty():
                    raise forced_error
                kind, value = await queue.get()
                forced_error = state.get("forced_error")
                if forced_error is not None:
                    if kind == "item":
                        yield value
                        continue
                    raise forced_error
                if state["closing"]:
                    stopped = True
                    raise asyncio.CancelledError
                if kind == "done":
                    break
                if kind == "closed":
                    stopped = True
                    raise asyncio.CancelledError
                if kind == "error":
                    raise value
                yield value
        except asyncio.CancelledError:
            stopped = True
            reason = "native_stream_stopped"
            primary_error = asyncio.CancelledError()
            raise
        except GeneratorExit as error:
            stopped = True
            reason = "native_stream_stopped"
            primary_error = error
            # Consumer close may race the producer's cache-tail finalizer.
            # Carry stop metadata on the exact granted lease before that
            # producer exits native_context and records group completion.
            if lease.context_lease is not None:
                lease.context_lease.stopped = True
            raise
        except BaseException as error:
            reason = "native_stream_failed"
            primary_error = error
            raise
        finally:
            if not state["completed"] or (not state["terminal_published"] and not producer.done()):
                _request_stream_stop(
                    lease,
                    cancel_idle_producer=state.get("forced_error") is None,
                )
                if primary_error is None:
                    stopped = True
                    reason = "native_stream_stopped"
            # Shield the retained producer; repeated consumer cancellation cannot
            # cause iterator close to overlap the active next operation.
            cancelled = False
            while not producer.done():
                try:
                    await asyncio.shield(producer)
                except asyncio.CancelledError:
                    cancelled = True
                except BaseException:
                    break
            if producer.done() and not producer.cancelled():
                with suppress(BaseException):
                    producer.exception()
            _prune_tracked_task(_stream_tasks, id(owner), producer)
            if cancelled:
                stopped = True
            finish_request_member(member, owned=owned, reason=reason, stopped=stopped)
            if cancelled and primary_error is None:
                raise asyncio.CancelledError
    except BaseException:
        if creation_ambiguous:
            if lease is not None:
                with lease.lifecycle.lock:
                    lease.cleanup_unknown = True
                    lease.stop_requested = True
                    lease.lifecycle.admission_open = False
                    lease.lifecycle.uncertain = True
                    lease.lifecycle.state = "retiring"
                    lease.lifecycle.failure = (
                        lease.lifecycle.failure or "stream_producer_task_creation_unknown"
                    )
                _signal_lifecycle(lease.lifecycle)
            if member is not None:
                member.group.fail(member, "stream_producer_task_creation_unknown", unknown=True)
                finish_request_member(
                    member,
                    owned=owned,
                    reason="stream_producer_task_creation_unknown",
                )
        elif producer is None:
            if lease is not None:
                _release_stream(lease)
            if member is not None:
                if owned:
                    if lease is not None and lease.context_lease is not None:
                        member.group.mark_not_submitted(member)
                    else:
                        known_adapter = False
                        try:
                            from app.services.orchestrator.llama_context_owner import (
                                generation_for,
                            )

                            known_adapter = generation_for(provider) is not None
                        except BaseException:
                            known_adapter = False
                        if known_adapter:
                            member.group.mark_not_submitted(member)
                        else:
                            member.group.fail(
                                member,
                                "native_adapter_unqualified",
                                unknown=True,
                            )
                finish_request_member(member, owned=owned, reason="native_stream_setup_failed")
        elif not consumer_entered:
            # A producer task was returned by create_task, so task creation is
            # no longer ambiguous. Still join it if setup failed before the
            # consumer acquired the task's close/settlement responsibility.
            _request_stream_stop(lease)
            while not producer.done():
                try:
                    await asyncio.shield(producer)
                except asyncio.CancelledError:
                    continue
                except BaseException:
                    break
            if not producer.cancelled():
                with suppress(BaseException):
                    producer.exception()
            _prune_tracked_task(_stream_tasks, id(owner), producer)
            finish_request_member(
                member, owned=owned, reason="native_stream_setup_failed", stopped=True
            )
        raise


def _select_generic_close(owner: Any) -> tuple[Any, str | None]:
    missing = object()
    if inspect.getattr_static(owner, "client", missing) is not missing:
        return None, None
    for name in ("close", "dispose"):
        if inspect.getattr_static(owner, name, missing) is not missing:
            return owner, name
    return None, None


def _select_explicit_close_name(target: Any) -> str | None:
    if target is None:
        return None
    for name in ("close", "dispose"):
        if inspect.getattr_static(target, name, _MISSING) is not _MISSING:
            return name
    return None


def _select_retirement_close(owner: Any, requested_target: Any) -> _CloseSelection:
    """Inspect close capability away from the event loop and lifecycle lock."""

    try:
        from app.services.orchestrator.llama_context_owner import (
            generation_for,
            is_registered_native_generation,
        )

        registered = is_registered_native_generation(owner)
        if registered:
            from app.services.orchestrator.llama_context_owner import (
                retirement_close_binding,
            )

            generation = generation_for(owner)
            if generation is None or (
                requested_target is not _AUTO_CLOSE_TARGET
                and requested_target is not generation.client
            ):
                # A registered provider has one constructor-pinned close
                # target. An alias or unrelated object cannot stand in for it.
                return _CloseSelection(available=False, target=owner)
            pinned_method = retirement_close_binding(owner)
            return _CloseSelection(
                available=pinned_method is not None,
                target=owner,
                method_name="close",
                pinned_method=pinned_method,
            )
        if requested_target is _AUTO_CLOSE_TARGET:
            target, method_name = _select_generic_close(owner)
        else:
            target = requested_target
            method_name = _select_explicit_close_name(target)
    except BaseException:
        retained_target = owner if requested_target is _AUTO_CLOSE_TARGET else requested_target
        return _CloseSelection(available=False, target=retained_target)
    return _CloseSelection(
        available=target is not None and method_name is not None,
        target=target if target is not None else owner,
        method_name=method_name,
    )


def _invoke_close_method(
    target: Any,
    method_name: str,
    selected_pinned_method: Callable[[Any], Any] | None = None,
) -> _CloseInvocation:
    """Resolve and invoke the selected synchronous close hook off-loop."""

    with native_cleanup_callback():
        try:
            from app.services.orchestrator.llama_context_owner import (
                is_registered_native_generation,
            )

            registered = is_registered_native_generation(target)
        except ImportError:
            registered = False
        except BaseException:
            return _CloseInvocation(available=False, unknown=True)
        if selected_pinned_method is not None and not registered:
            return _CloseInvocation(available=False, unknown=True)
        if registered:
            try:
                from app.services.orchestrator.llama_context_owner import (
                    retirement_close_binding,
                )

                method = retirement_close_binding(target)
            except BaseException:
                return _CloseInvocation(available=False, unknown=True)
            if method is None or (
                selected_pinned_method is not None and method is not selected_pinned_method
            ):
                return _CloseInvocation(available=False, unknown=True)
            operation = _current_operation.get()
            if operation is None or not _prepare_retirement_close_body(operation, target):
                return _CloseInvocation(available=False, unknown=True)
            try:
                result = method(target)
            except BaseException:
                with operation.lifecycle.lock:
                    body_entered = (
                        operation.close_body_target is target and operation.close_body_entered
                    )
                # Only the adapter's explicit mark immediately before the
                # captured base body distinguishes an observed close failure
                # from authorization rejection before entry.
                return _CloseInvocation(
                    available=body_entered,
                    unknown=not body_entered,
                    failed=body_entered,
                )
            with operation.lifecycle.lock:
                body_entered = (
                    operation.close_body_target is target and operation.close_body_entered
                )
            if not body_entered:
                if inspect.iscoroutine(result):
                    result.close()
                return _CloseInvocation(available=False, unknown=True)
            if inspect.isawaitable(result):
                if inspect.iscoroutine(result):
                    result.close()
                return _CloseInvocation(available=False, unknown=True)
            return _CloseInvocation(available=True, result=result)
        try:
            method = getattr(target, method_name, _MISSING)
        except BaseException:
            return _CloseInvocation(available=False, unknown=True)
        if not callable(method) or inspect.iscoroutinefunction(method):
            return _CloseInvocation(available=False, unknown=True)
        try:
            result = method()
        except BaseException:
            # The callable returned an actual failure. Keep only its fixed state;
            # the exception and traceback must not escape or be retained.
            return _CloseInvocation(available=True, failed=True)
        if inspect.isawaitable(result):
            if inspect.iscoroutine(result):
                result.close()
            return _CloseInvocation(available=False, unknown=True)
        return _CloseInvocation(available=True, result=result)


def retirement_close_is_authorized(target: Any) -> bool:
    """Return whether this exact active provider-close operation owns close."""

    operation = _current_operation.get()
    if (
        operation is None
        or operation.stream_action != "provider_close"
        or operation.owner is not provider_owner(target)
        or _active_operation_for(operation.owner) is not operation
    ):
        return False
    with operation.lifecycle.lock:
        return operation.lifecycle.operations.get(operation.sequence) is operation


def _prepare_retirement_close_body(operation: _Operation, target: Any) -> bool:
    if (
        operation.stream_action != "provider_close"
        or operation.owner is not target
        or _active_operation_for(operation.owner) is not operation
    ):
        return False
    with operation.lifecycle.lock:
        if (
            operation.lifecycle.operations.get(operation.sequence) is not operation
            or operation.state is not _OperationState.BODY_RUNNING
            or operation.worker_thread_id != threading.get_ident()
            or operation.close_body_target is not None
        ):
            return False
        operation.close_body_target = target
        operation.close_body_entered = False
        return True


def mark_retirement_close_body_entry(target: Any) -> bool:
    """Mark the exact selected base-close body immediately before invocation."""

    operation = _current_operation.get()
    if operation is None or not retirement_close_is_authorized(target):
        return False
    with operation.lifecycle.lock:
        if (
            operation.lifecycle.operations.get(operation.sequence) is not operation
            or operation.worker_thread_id != threading.get_ident()
            or operation.close_body_target is not target
            or operation.close_body_entered
        ):
            return False
        operation.close_body_entered = True
        return True


async def _wait_for_lifecycle_change(lifecycle: _ProviderLifecycle) -> None:
    event = lifecycle.changed
    if event is None:
        return
    with lifecycle.lock:
        if not lifecycle.operations and not lifecycle.streams and lifecycle.direct_operations == 0:
            return
        event.clear()
        # Recheck after clear while holding the same lock used by removers.
        if not lifecycle.operations and not lifecycle.streams and lifecycle.direct_operations == 0:
            return
    await event.wait()


async def _retirement_owner(
    lifecycle: _ProviderLifecycle,
    owner: Any,
    requested_target: Any,
) -> RetirementResult:
    try:
        while True:
            with lifecycle.lock:
                if lifecycle.loop_lost:
                    return _finish_retirement(
                        lifecycle,
                        RetirementResult(
                            RetirementStatus.UNKNOWN,
                            lifecycle.failure or "original_loop_unavailable",
                        ),
                        retain_ownership=True,
                    )
                if lifecycle.uncertain or any(
                    operation.state is _OperationState.UNKNOWN
                    for operation in lifecycle.operations.values()
                ):
                    return _finish_retirement(
                        lifecycle,
                        RetirementResult(
                            RetirementStatus.UNKNOWN,
                            lifecycle.failure or "provider_operation_unknown",
                        ),
                        retain_ownership=True,
                    )
                leases = list(lifecycle.streams.values())
                has_operations = bool(lifecycle.operations) or lifecycle.direct_operations > 0
                if not leases and not has_operations:
                    break
            # The accepted stream lease owns its cleanup path. Cancellation asks it
            # to stop; it cannot admit work after the barrier except its own cleanup.
            for lease in leases:
                task = lease.task
                if (
                    task is not None
                    and not task.done()
                    and (not lease.stop_requested or lease.cleanup_complete)
                    and (not lease.close_started or lease.cleanup_complete)
                ):
                    _request_stream_stop(lease)
            await _wait_for_lifecycle_change(lifecycle)

        # Admission was already closed by retire_native. Only after all accepted
        # operations settle do we inspect a user-provided descriptor or invoke it.
        from app.services.orchestrator.llama_context_owner import wait_native_retired

        try:
            context_retired = await wait_native_retired(owner)
        except BaseException:
            context_retired = False
        if not context_retired:
            with lifecycle.lock:
                lifecycle.uncertain = True
                lifecycle.admission_open = False
                lifecycle.state = "retiring"
                lifecycle.failure = lifecycle.failure or "native_context_retirement_unknown"
                result = RetirementResult(RetirementStatus.UNKNOWN, lifecycle.failure)
            return _finish_retirement(lifecycle, result, retain_ownership=True)
        selection_run = await _run_native_internal(
            owner,
            _select_retirement_close,
            (owner, requested_target),
            {},
            retirement_internal=True,
            stream_action="close_discovery",
        )
        selection = selection_run.value
        if not selection.available:
            with lifecycle.lock:
                lifecycle.retirement_close_target = selection.target
                lifecycle.uncertain = True
                lifecycle.admission_open = False
                lifecycle.state = "retiring"
                lifecycle.failure = lifecycle.failure or "provider_close_unknown"
            return _finish_retirement(
                lifecycle,
                RetirementResult(
                    RetirementStatus.UNKNOWN,
                    lifecycle.failure or "provider_close_unknown",
                ),
                retain_ownership=True,
            )
        with lifecycle.lock:
            lifecycle.retirement_close_target = selection.target

        prior_failure = lifecycle.failure
        try:
            close_run = await _run_native_internal(
                owner,
                _invoke_close_method,
                (selection.target, selection.method_name, selection.pinned_method),
                {},
                retirement_internal=True,
                stream_action="provider_close",
                preserve_result_after_cancel=True,
            )
            invocation = close_run.value
            if not invocation.available or invocation.unknown:
                with lifecycle.lock:
                    lifecycle.uncertain = True
                    lifecycle.admission_open = False
                    lifecycle.state = "retiring"
                    lifecycle.failure = lifecycle.failure or "provider_close_unknown"
            elif invocation.failed:
                with lifecycle.lock:
                    lifecycle.failure = lifecycle.failure or "provider_close_failed"
            if close_run.cancelled:
                with lifecycle.lock:
                    lifecycle.uncertain = True
                    lifecycle.admission_open = False
                    lifecycle.state = "retiring"
                    lifecycle.failure = lifecycle.failure or "retirement_owner_cancelled"
        except asyncio.CancelledError:
            raise
        except BaseException:
            with lifecycle.lock:
                if lifecycle.failure is None:
                    lifecycle.failure = "provider_close_failed"
                prior_failure = lifecycle.failure

        with lifecycle.lock:
            prior_failure = lifecycle.failure or prior_failure
            if lifecycle.uncertain:
                result = RetirementResult(
                    RetirementStatus.UNKNOWN, prior_failure or "provider_close_unknown"
                )
            elif prior_failure is not None:
                result = RetirementResult(RetirementStatus.FAILED, prior_failure)
            else:
                result = RetirementResult(RetirementStatus.COMPLETE)
        return _finish_retirement(
            lifecycle, result, retain_ownership=result.status is RetirementStatus.UNKNOWN
        )
    except asyncio.CancelledError:
        # The operation record may still be executing on a native thread. Never
        # run close again or discard the retained target after cancellation.
        with lifecycle.lock:
            lifecycle.uncertain = True
            lifecycle.admission_open = False
            lifecycle.state = "retiring"
            lifecycle.failure = lifecycle.failure or "retirement_owner_cancelled"
            result = RetirementResult(RetirementStatus.UNKNOWN, lifecycle.failure)
        return _finish_retirement(lifecycle, result, retain_ownership=True)
    except BaseException:
        with lifecycle.lock:
            lifecycle.uncertain = True
            lifecycle.admission_open = False
            lifecycle.state = "retiring"
            lifecycle.failure = lifecycle.failure or "retirement_completion_unknown"
            result = RetirementResult(RetirementStatus.UNKNOWN, lifecycle.failure)
        return _finish_retirement(lifecycle, result, retain_ownership=True)


def _finalize_retirement_task_unknown(
    lifecycle: _ProviderLifecycle, failure: str
) -> RetirementResult:
    """Retain a terminal doubt if the owner task cannot publish its result."""

    with lifecycle.lock:
        if lifecycle.terminal_result is not None:
            return lifecycle.terminal_result
        lifecycle.uncertain = True
        lifecycle.admission_open = False
        lifecycle.state = "retiring"
        lifecycle.failure = lifecycle.failure or failure
        result = RetirementResult(RetirementStatus.UNKNOWN, lifecycle.failure)
        return _finish_retirement(lifecycle, result, retain_ownership=True)


def _retirement_task_finished(lifecycle: _ProviderLifecycle, task: asyncio.Task) -> None:
    """Classify cancellation/fault even when the coroutine never gets polled."""

    if task.cancelled():
        _finalize_retirement_task_unknown(lifecycle, "retirement_owner_cancelled")
        return
    try:
        error = task.exception()
    except BaseException:
        error = True
    if error is not None:
        _finalize_retirement_task_unknown(lifecycle, "retirement_completion_unknown")
    elif lifecycle.terminal_result is None:
        # The owner normally stores its terminal result before returning. A
        # clean task result without that publication is not a second close
        # opportunity; retain doubt instead.
        _finalize_retirement_task_unknown(lifecycle, "retirement_completion_unknown")


def _finish_retirement(
    lifecycle: _ProviderLifecycle,
    result: RetirementResult,
    *,
    retain_ownership: bool,
) -> RetirementResult:
    with lifecycle.lock:
        if lifecycle.terminal_result is not None:
            return lifecycle.terminal_result
        if lifecycle.deadline_result is not None:
            result = lifecycle.deadline_result
        lifecycle.terminal_result = result
        lifecycle.state = "terminal"
        if not retain_ownership:
            lifecycle.retirement_owner = None
            lifecycle.retirement_close_target = None
        return result


async def retire_native(
    provider: Any,
    *,
    close_target: Any = _AUTO_CLOSE_TARGET,
    timeout: float | None = None,
) -> RetirementResult:
    """Close admission and observe one retained, checked provider retirement."""

    try:
        owner = provider_owner(provider)
    except BaseException:
        # A changed or quarantined registered Llama binding still has an exact
        # physical owner whose admission must remain closed. Do not lose that
        # lifecycle merely because canonical validation rejected the wrapper.
        from app.services.orchestrator.llama_context_owner import generation_for

        generation = generation_for(provider)
        owner = generation.client if generation is not None else None
        if owner is None:
            return RetirementResult(RetirementStatus.UNKNOWN, "provider_identity_unavailable")
    loop = asyncio.get_running_loop()
    try:
        lifecycle = _get_lifecycle(owner, loop, create=True)
    except ProviderUnavailableError:
        return RetirementResult(RetirementStatus.UNKNOWN, "provider_lifecycle_unavailable")
    from app.services.orchestrator.llama_context_owner import begin_native_retirement

    try:
        context_admission_opened = begin_native_retirement(owner)
    except BaseException:
        context_admission_opened = False
    with lifecycle.lock:
        if lifecycle.terminal_result is not None:
            return lifecycle.terminal_result
        if not context_admission_opened:
            lifecycle.admission_open = False
            lifecycle.state = "retiring"
            lifecycle.uncertain = True
            lifecycle.failure = lifecycle.failure or "native_context_retirement_unknown"
            result = RetirementResult(RetirementStatus.UNKNOWN, lifecycle.failure)
            return _finish_retirement(lifecycle, result, retain_ownership=True)
        existing_task = lifecycle.retirement_task
        if existing_task is not None and existing_task.done():
            if existing_task.cancelled():
                _finalize_retirement_task_unknown(lifecycle, "retirement_owner_cancelled")
            else:
                _retirement_task_finished(lifecycle, existing_task)
            if lifecycle.terminal_result is not None:
                return lifecycle.terminal_result
        if lifecycle.retirement_task is None:
            # Close admission before descriptor inspection or any other cleanup
            # discovery. The retained owner performs that work after draining.
            lifecycle.admission_open = False
            lifecycle.state = "retiring"
            lifecycle.retirement_owner = owner
            lifecycle.retirement_close_target = (
                None if close_target is _AUTO_CLOSE_TARGET else close_target
            )
            retirement_coro = _retirement_owner(lifecycle, owner, close_target)
            try:
                lifecycle.retirement_task = loop.create_task(retirement_coro)
            except BaseException:
                # A task factory/loop failure can happen before the owner
                # coroutine gets its first poll. Keep the already-closed
                # admission and exact owner/target, but never retry cleanup.
                with suppress(BaseException):
                    retirement_coro.close()
                lifecycle.uncertain = True
                lifecycle.failure = lifecycle.failure or "retirement_task_creation_failed"
                result = RetirementResult(RetirementStatus.UNKNOWN, lifecycle.failure)
                return _finish_retirement(lifecycle, result, retain_ownership=True)
            lifecycle.retirement_task.add_done_callback(
                lambda task, life=lifecycle: _retirement_task_finished(life, task)
            )
        retirement_task = lifecycle.retirement_task
    try:
        if timeout is None:
            return await asyncio.shield(retirement_task)
        return await asyncio.wait_for(asyncio.shield(retirement_task), timeout=max(0.0, timeout))
    except asyncio.TimeoutError:
        if retirement_task.done():
            _retirement_task_finished(lifecycle, retirement_task)
            with lifecycle.lock:
                if lifecycle.terminal_result is not None:
                    return lifecycle.terminal_result
        with lifecycle.lock:
            if lifecycle.terminal_result is not None:
                return lifecycle.terminal_result
            lifecycle.failure = lifecycle.failure or "retirement_deadline_exceeded"
            if lifecycle.deadline_result is None:
                lifecycle.deadline_result = RetirementResult(
                    RetirementStatus.DEADLINE_EXCEEDED, lifecycle.failure
                )
            lifecycle.admission_open = False
            return lifecycle.deadline_result
    except asyncio.CancelledError:
        if retirement_task.done():
            _retirement_task_finished(lifecycle, retirement_task)
            with lifecycle.lock:
                if lifecycle.terminal_result is not None:
                    return lifecycle.terminal_result
        raise
    except BaseException:
        if retirement_task.done():
            _retirement_task_finished(lifecycle, retirement_task)
            with lifecycle.lock:
                if lifecycle.terminal_result is not None:
                    return lifecycle.terminal_result
        raise


async def drain_native(provider: Any) -> None:
    """Compatibility drain of already-tracked work; it does not close admission."""

    owner = provider_owner(provider)
    loop = asyncio.get_running_loop()
    try:
        lifecycle = _get_lifecycle(owner, loop, create=False)
    except ProviderUnavailableError:
        return
    while True:
        with lifecycle.lock:
            streams = list(lifecycle.streams.values())
            operations = list(lifecycle.operations.values())
            direct_operations = lifecycle.direct_operations
        if not streams and not operations and direct_operations == 0:
            return
        for lease in streams:
            if lease.task is not None and not lease.task.done():
                _request_stream_stop(lease)
        await _wait_for_lifecycle_change(lifecycle)


def _next_or_sentinel(iterator: Any, sentinel: object) -> Any:
    """Advance an iterator without leaking StopIteration through an awaitable."""

    return next(iterator, sentinel)

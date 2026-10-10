"""Construction-owned Llama context generations and iterator leases.

Only the pinned CPU llama-cpp-python path can report qualified completion. The
explicit CUDA namespace remains construction-owned but unqualified until its
execution surface is separately verified. This is not remote acknowledgement or
thread-exit proof.
"""

from __future__ import annotations

import asyncio
import contextvars
import functools
import inspect
import sys
import threading
import weakref
from collections import ChainMap, deque
from collections.abc import Callable, Iterator
from contextlib import asynccontextmanager, contextmanager, nullcontext, suppress
from dataclasses import dataclass, field
from typing import Any

from app.services.orchestrator.native_request_completion import bind_request_member

MAX_LLAMA_GENERATIONS = 128
MAX_LLAMA_WAITERS = 128
MAX_LLAMA_CHILDREN = 64
_BOUND_NATIVE_ENTRY_NAMES = (
    "sample",
    "tokenize",
    "detokenize",
    "reset",
    "set_seed",
    "load_state",
    "save_state",
    "embed",
    "create_embedding",
)
_PINNED_METHOD_NAMES = (
    "generate",
    "_create_completion",
    "create_completion",
    "create_chat_completion",
    "eval",
    "close",
    "_init_sampler",
    *_BOUND_NATIVE_ENTRY_NAMES,
)
_REQUIRED_PINNED_METHOD_NAMES = frozenset(
    {
        "generate",
        "_create_completion",
        "create_completion",
        "create_chat_completion",
        "eval",
        "close",
    }
)
_MISSING = object()

_generations_lock = threading.RLock()
_generation_construction_reservations = 0
_generation_construction_tokens: set[object] = set()
_generations: weakref.WeakValueDictionary[int, LlamaResourceGeneration] = (
    weakref.WeakValueDictionary()
)
_quarantined_generations: dict[int, LlamaResourceGeneration] = {}
_failed_construction_owners: dict[int, Any] = {}
_failed_construction_close_states: dict[int, tuple[Any, str]] = {}
_failed_construction_close_awaitables: dict[int, Any] = {}
_failed_construction_close_tasks: dict[int, asyncio.Task[Any]] = {}
_active_leases: dict[int, NativeContextLease] = {}
_wrapper_bindings: dict[int, _WrapperBinding] = {}
MAX_LLAMA_WRAPPER_BINDINGS = 256
_current_lease: contextvars.ContextVar[NativeContextLease | None] = contextvars.ContextVar(
    "aurora_native_llama_context_lease", default=None
)
_current_child: contextvars.ContextVar[_IteratorRecord | None] = contextvars.ContextVar(
    "aurora_native_llama_iterator_child", default=None
)
_cleanup_active: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "aurora_native_llama_cleanup", default=False
)
_completion_factory: contextvars.ContextVar[_CompletionPermit | None] = contextvars.ContextVar(
    "aurora_native_llama_completion_factory", default=None
)
_chat_dispatch: contextvars.ContextVar[_ChatDispatch | None] = contextvars.ContextVar(
    "aurora_native_llama_chat_dispatch", default=None
)


class NativeContextUnavailableError(RuntimeError):
    """Fixed safe rejection for an unavailable physical context."""

    def __init__(self) -> None:
        super().__init__("Aurora cannot complete this request right now.")


@dataclass
class _Waiter:
    loop: asyncio.AbstractEventLoop
    future: asyncio.Future[NativeContextLease]
    generation: LlamaResourceGeneration
    member: Any = None
    lease: NativeContextLease | None = None
    cancelled: bool = False


@dataclass
class _IteratorRecord:
    lease: NativeContextLease
    iterator: Any
    parent: _IteratorRecord | None = None
    children: list[_IteratorRecord] = field(default_factory=list)
    closed: bool = False
    close_started: bool = False
    close_checked: bool = False
    close_failed: bool = False
    kind: str = "iterator"
    exhausted: bool = False
    request_member: Any = None
    dispatch: Any = None
    condition: threading.Condition = field(default_factory=threading.Condition)
    advancing_thread: int | None = None
    close_thread: int | None = None


@dataclass
class _CompletionPermit:
    lease: NativeContextLease
    client: Any
    dispatch: _ChatDispatch | None = None
    handler_frame: Any = None
    factory_frame: Any = None
    completion_frame: Any = None
    consumed: bool = False


@dataclass
class _ChatDispatch:
    """Single selected-handler invocation bound to its exact call frame."""

    lease: NativeContextLease
    client: Any
    handler: Any
    member: Any
    formatter: Any = None
    qualified: bool = False
    children: list[_IteratorRecord] = field(default_factory=list)
    handler_iterator: Any = None
    handler_record: _IteratorRecord | None = None
    handler_frame: Any = None
    wrapper_frame: Any = None
    chat_invocation_frame: Any = None
    completion_frame: Any = None
    completion_claimed: bool = False
    completion_count: int = 0
    stopping_criteria: Any = None
    stopping_criteria_state: Any = None

    def claim_completion(self, frame: Any) -> bool:
        dispatch_frame = frame.f_back if frame is not None else None
        active_record = _current_child.get()
        lazy_handler_frame = (
            active_record is not None
            and active_record.dispatch is self
            and active_record.iterator is self.handler_iterator
            and getattr(self.handler_iterator, "gi_frame", None) is frame
        )
        eager_handler_frame = (
            dispatch_frame is not None
            and dispatch_frame.f_code is self.lease.generation.create_chat_completion_code
            and dispatch_frame.f_locals.get("self") is self.client
            and dispatch_frame.f_locals.get("handler") is self.handler
            and dispatch_frame.f_back is not None
            and dispatch_frame.f_back is self.wrapper_frame
            and dispatch_frame.f_back.f_code is self.lease.generation.adapter_codes[3]
            and dispatch_frame.f_back.f_locals.get("self") is self.client
            and (self.chat_invocation_frame is None or dispatch_frame is self.chat_invocation_frame)
        )
        repeated_chatml_stage = (
            self.lease.generation.handler_mode == "chatml_function_calling"
            and self.handler_frame is frame
            and self.chat_invocation_frame is dispatch_frame
            and self.completion_count < MAX_LLAMA_CHILDREN
            and eager_handler_frame
        )
        first_stage = not self.completion_claimed and self.handler_frame is None
        if (
            frame is None
            or frame.f_code is not self.lease.generation.handler_code
            or not (lazy_handler_frame or eager_handler_frame)
            or not (first_stage or repeated_chatml_stage)
        ):
            return False
        if eager_handler_frame and self.chat_invocation_frame is None:
            # If create_completion is this handler's first guarded dependency,
            # bind its exact base/wrapper invocation before authorizing it.
            self.chat_invocation_frame = dispatch_frame
        if self.handler_frame is None:
            self.handler_frame = frame
        self.completion_claimed = True
        self.completion_count += 1
        return True


def _selected_criteria_state(dispatch: _ChatDispatch) -> tuple[Any, ...] | None:
    """Fingerprint the one pinned callback retained by a selected formatter."""

    criteria = dispatch.stopping_criteria
    module = dispatch.lease.generation.backend_llama_module
    criteria_type = getattr(module, "StoppingCriteriaList", None)
    if (
        criteria is None
        or not isinstance(criteria_type, type)
        or type(criteria) is not criteria_type
    ):
        return None
    try:
        if len(criteria) != 1:
            return None
    except BaseException:
        return None
    try:
        callback = criteria[0]
    except BaseException:
        return None
    if not inspect.isfunction(callback):
        return None
    names = callback.__code__.co_names
    closure = callback.__closure__ or ()
    if len(names) > 512 or len(closure) > 512:
        return None
    try:
        return (
            id(criteria),
            id(callback),
            id(callback.__code__),
            id(callback.__globals__),
            tuple((name, id(callback.__globals__.get(name))) for name in names),
            tuple(id(cell.cell_contents) for cell in closure),
        )
    except BaseException:
        return None


@dataclass
class _WrapperBinding:
    wrapper_ref: weakref.ReferenceType[Any] | None
    wrapper_strong: Any
    client: Any

    def wrapper(self) -> Any:
        return self.wrapper_ref() if self.wrapper_ref is not None else self.wrapper_strong


class _ContextGate:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.owner: NativeContextLease | None = None
        self.waiters: deque[_Waiter] = deque()
        self.quarantined = False
        self.retiring = False
        self.retirement_waiter: tuple[asyncio.AbstractEventLoop, asyncio.Future[bool]] | None = None

    def _new_lease(
        self, generation: LlamaResourceGeneration, *, loop: asyncio.AbstractEventLoop | None
    ) -> NativeContextLease:
        lease = NativeContextLease(generation, self, loop)
        with _generations_lock:
            if len(_active_leases) >= MAX_LLAMA_GENERATIONS:
                raise NativeContextUnavailableError()
            _active_leases[id(lease)] = lease
        self.owner = lease
        return lease

    def acquire_sync(self, generation: LlamaResourceGeneration) -> NativeContextLease:
        generation.validate()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        with self.lock:
            if self.quarantined or self.retiring or self.owner is not None or self.waiters:
                raise NativeContextUnavailableError()
            return self._new_lease(generation, loop=loop)

    async def acquire_async(
        self, generation: LlamaResourceGeneration, group: Any = None, member: Any = None
    ) -> NativeContextLease:
        loop = asyncio.get_running_loop()
        if group is not None and (member is None or not group.contains_active_member(member)):
            raise NativeContextUnavailableError()
        generation.validate()
        with self.lock:
            if self.quarantined or self.retiring:
                raise NativeContextUnavailableError()
            if self.owner is None and not self.waiters:
                lease = self._new_lease(generation, loop=loop)
                lease.request_member = member
                return lease
            if len(self.waiters) >= MAX_LLAMA_WAITERS:
                raise NativeContextUnavailableError()
            future: asyncio.Future[NativeContextLease] = loop.create_future()
            waiter = _Waiter(loop, future, generation, member=member)
            self.waiters.append(waiter)
            if member is not None:
                try:
                    member.set_stop(lambda: self.cancel_waiter(waiter))
                except BaseException:
                    waiter.cancelled = True
                    with suppress(ValueError):
                        self.waiters.remove(waiter)
                    future.cancel()
                    _mark_member_not_submitted(member)
                    raise NativeContextUnavailableError() from None
        try:
            lease = await future
            try:
                generation.validate()
                with self.lock:
                    revoked = lease.revoked or self.retiring or self.owner is not lease
                if revoked or (
                    group is not None
                    and (member is None or not group.contains_active_member(member))
                ):
                    raise NativeContextUnavailableError()
            except BaseException:
                if not lease.started:
                    _mark_member_not_submitted(lease.request_member)
                    lease.release_unstarted()
                raise
            return lease
        except asyncio.CancelledError:
            with self.lock:
                waiter.cancelled = True
                with suppress(ValueError):
                    self.waiters.remove(waiter)
                lease = waiter.lease
            admitted_work = False
            if lease is not None and not lease.revoked:
                with lease._lock:
                    reservation = lease.progress_reservation
                    runner = (
                        getattr(reservation, "runner", None) if reservation is not None else None
                    )
                    admitted_work = (
                        lease.started
                        or lease.callable_attempted
                        or bool(lease.operations)
                        or runner is not None
                    )
            if lease is None or lease.revoked or not admitted_work:
                _mark_waiter_not_submitted(waiter)
            if lease is not None and not admitted_work:
                lease.release_unstarted()
            elif lease is not None and lease.stop_callback is not None:
                try:
                    lease.stop_callback()
                except BaseException:
                    lease._abandon_unknown("native_context_stop_failed")
                    _mark_member_unknown(lease.request_member, "native_context_stop_failed")
            self._wake_next()
            raise

    def cancel_waiter(self, waiter: _Waiter) -> None:
        granted: NativeContextLease | None = None
        active_stop: Callable[[], None] | None = None
        admitted_work = False
        with self.lock:
            granted = waiter.lease
            if granted is not None:
                with granted._lock:
                    reservation = granted.progress_reservation
                    runner = (
                        getattr(reservation, "runner", None) if reservation is not None else None
                    )
                    admitted_work = (
                        granted.started
                        or granted.callable_attempted
                        or bool(granted.operations)
                        or runner is not None
                    )
                if admitted_work:
                    active_stop = granted.stop_callback
            if granted is not None and admitted_work:
                pass
            else:
                waiter.cancelled = True
                with suppress(ValueError):
                    self.waiters.remove(waiter)
                future = waiter.future
        if granted is not None and admitted_work:
            # RequestMember keeps the same callback after grant. If the exact
            # active stream owns a stop path, request that stop. A finite
            # callable without a stop hook remains admitted until its actual
            # worker and context finalizer settle; it is never reported as
            # unsubmitted merely because native entry has not yet occurred.
            if active_stop is not None:
                try:
                    active_stop()
                except BaseException:
                    granted._abandon_unknown("native_context_stop_failed")
                    _mark_member_unknown(granted.request_member, "native_context_stop_failed")
                return
            return
        _mark_waiter_not_submitted(waiter)
        if not future.done():
            future.cancel()
        if granted is not None:
            granted.release_unstarted()
        self._wake_next()

    def _wake_next(self) -> None:
        with self.lock:
            if self.owner is not None or self.quarantined or self.retiring:
                return
            while self.waiters:
                waiter = self.waiters.popleft()
                if waiter.cancelled or waiter.loop.is_closed() or waiter.future.cancelled():
                    continue
                generation = _generation_from_lease_future(waiter)
                if generation is None:
                    continue
                lease = self._new_lease(generation, loop=waiter.loop)
                lease.request_member = waiter.member
                waiter.lease = lease
                try:
                    waiter.loop.call_soon_threadsafe(_set_waiter_result, waiter, lease)
                except RuntimeError:
                    self.owner = None
                    lease.revoked = True
                    lease.active = False
                    lease._abandon_unknown("context_waiter_loop_unavailable")
                    failed_waiters = [waiter, *self.waiters]
                    self.waiters.clear()
                    for failed in failed_waiters:
                        failed.cancelled = True
                        _fail_waiter(failed)
                        _mark_member_unknown(failed.member, "context_waiter_loop_unavailable")
                    break
                return

    def release(self, lease: NativeContextLease) -> None:
        retirement_waiter = None
        with self.lock:
            if self.owner is not lease:
                self.quarantined = True
            else:
                self.owner = None
            if self.retiring and self.owner is None:
                retirement_waiter = self.retirement_waiter
                self.retirement_waiter = None
        if retirement_waiter is not None:
            _resolve_retirement_waiter(retirement_waiter, not self.quarantined)
        self._wake_next()

    def quarantine(self, lease: NativeContextLease | None = None) -> None:
        retirement_waiter = None
        with self.lock:
            self.quarantined = True
            if self.retiring:
                retirement_waiter = self.retirement_waiter
                self.retirement_waiter = None
        if retirement_waiter is not None:
            _resolve_retirement_waiter(retirement_waiter, False)

    def begin_retirement(self) -> bool:
        """Close all new context admission and reject queued, unstarted leases."""

        revoked_owner = None
        with self.lock:
            self.retiring = True
            waiters = list(self.waiters)
            self.waiters.clear()
            for waiter in waiters:
                waiter.cancelled = True
            retirement_waiter = self.retirement_waiter
            owner = self.owner
            reservation = owner.progress_reservation if owner is not None else None
            runner = getattr(reservation, "runner", None)
            has_accepted_work = bool(
                owner is not None
                and (
                    owner.started
                    or owner.callable_attempted
                    or owner.operations
                    or owner.children
                    or runner is not None
                )
            )
            if owner is not None and not owner.started and not has_accepted_work:
                # A waiter may hold the lease but not have entered a native
                # method yet. Revoke that unstarted grant before it can begin
                # native work, regardless of whether its caller is async.
                owner.revoked = True
                owner.active = False
                _mark_member_not_submitted(owner.request_member)
                self.owner = None
                revoked_owner = owner
            ready = self.owner is None
        if revoked_owner is not None:
            # Revocation is a no-work settlement, but it still owns the exact
            # progress credit and strong lease root until both are released.
            revoked_owner.release_unstarted()
        for waiter in waiters:
            _mark_waiter_not_submitted(waiter)
            _fail_waiter(waiter)
        if ready and retirement_waiter is not None:
            with self.lock:
                if self.retirement_waiter is retirement_waiter:
                    self.retirement_waiter = None
            _resolve_retirement_waiter(retirement_waiter, not self.quarantined)
        # Admission closure succeeds even for a quarantined generation. The
        # retained provider owner still stops/drains work, then wait_retired()
        # reports UNKNOWN and prevents client close.
        return True

    async def wait_retired(self) -> bool:
        """Wait without occupying an executor slot for the current lease."""

        loop = asyncio.get_running_loop()
        with self.lock:
            if not self.retiring:
                return False
            if self.quarantined:
                return False
            if self.owner is None:
                return True
            if self.retirement_waiter is not None:
                # Provider retirement is single-owner; another waiter is not
                # allowed to create an unbounded observation list.
                existing_loop, existing = self.retirement_waiter
                if existing_loop is not loop:
                    return False
                future = existing
            else:
                future = loop.create_future()
                self.retirement_waiter = (loop, future)
        try:
            return await future
        except asyncio.CancelledError:
            with self.lock:
                if self.retirement_waiter is not None and self.retirement_waiter[1] is future:
                    self.retirement_waiter = None
            raise


def _resolve_retirement_waiter(
    waiter: tuple[asyncio.AbstractEventLoop, asyncio.Future[bool]], result: bool
) -> None:
    loop, future = waiter
    if loop.is_closed():
        return
    try:
        loop.call_soon_threadsafe(_set_retirement_result, future, result)
    except RuntimeError:
        return


def _set_retirement_result(future: asyncio.Future[bool], result: bool) -> None:
    if not future.done():
        future.set_result(result)


def _fail_waiter(waiter: _Waiter) -> None:
    if waiter.loop.is_closed():
        return
    try:
        waiter.loop.call_soon_threadsafe(_set_waiter_exception, waiter)
    except RuntimeError:
        return


def _set_waiter_exception(waiter: _Waiter) -> None:
    if not waiter.future.done():
        waiter.future.set_exception(NativeContextUnavailableError())


def _mark_member_not_submitted(member: Any) -> None:
    if member is None:
        return
    try:
        member.group.mark_not_submitted(member)
    except BaseException:
        return


def _mark_member_unknown(member: Any, reason: str) -> None:
    if member is None:
        return
    try:
        member.group.fail(member, reason, unknown=True)
    except BaseException:
        return


def _mark_waiter_not_submitted(waiter: _Waiter) -> None:
    _mark_member_not_submitted(waiter.member)


def _release_rejected_unstarted_lease(lease: NativeContextLease) -> None:
    if lease.started or lease.inference_seen or lease.children:
        return
    if lease.unknown:
        _mark_member_unknown(
            lease.request_member,
            lease.reason or "native_context_completion_unknown",
        )
    else:
        _mark_member_not_submitted(lease.request_member)
    lease.release_unstarted()
    if lease.owns_request_member and lease.request_member is not None:
        from app.services.orchestrator.native_request_completion import finish_request_member

        finish_request_member(lease.request_member, owned=True)


def _reject_sync_entry_on_owned_loop(lease: NativeContextLease) -> None:
    """Reject synchronous native entry on every event-loop thread."""

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    if lease.started or lease.inference_seen:
        lease.mark_unknown("native_sync_entry_on_event_loop")
    raise NativeContextUnavailableError()


def _set_waiter_result(waiter: _Waiter, lease: NativeContextLease) -> None:
    if not waiter.future.done():
        waiter.future.set_result(lease)


def _generation_from_lease_future(waiter: _Waiter) -> LlamaResourceGeneration | None:
    # The generation is assigned to a waiter when it is queued.  Keep this
    # helper separate so the bounded waiter record has no provider-id authority.
    return waiter.generation


class LlamaResourceGeneration:
    """Pinned identity for one successfully constructed supported Llama."""

    __slots__ = (
        "_client_ref",
        "client_id",
        "context_owner",
        "context_pointer",
        "backend",
        "backend_base_type",
        "constructor_callable",
        "constructor_code",
        "constructor_provenance",
        "backend_type",
        "synchronize",
        "handler",
        "handler_mode",
        "handler_qualified",
        "chat_format",
        "draft_model_binding",
        "tokenizer_binding",
        "tokenizer_provenance",
        "backend_llama_module",
        "backend_format_module",
        "synchronize_module",
        "handler_provenance",
        "generate_code",
        "_create_completion_code",
        "base_method_provenance",
        "adapter_method_provenance",
        "tokenizer_qualified",
        "create_completion_code",
        "create_chat_completion_code",
        "handler_code",
        "eval_code",
        "close_code",
        "close_provenance",
        "adapter_close_callable",
        "adapter_codes",
        "native_entry_codes",
        "_gate",
        "_quarantined",
        "_reason",
        "_lock",
        "__weakref__",
    )

    def __init__(
        self,
        client: Any,
        backend: Any,
        handler_mode: str,
        handler: Any,
        handler_qualified: bool,
    ) -> None:
        self._client_ref = weakref.ref(client)
        self.client_id = id(client)
        self.context_owner = client._ctx
        self.context_pointer = client.ctx
        self.backend = backend
        self.backend_llama_module = backend.llama
        self.backend_format_module = backend.llama_chat_format
        self.backend_type = type(client)
        base = getattr(type(client), "_aurora_owned_base", None)
        constructor = inspect.getattr_static(type(client), "_aurora_base_init", None)
        constructor = getattr(constructor, "__func__", constructor)
        self.backend_base_type = base
        self.constructor_callable = constructor
        self.constructor_code = _callable_code(constructor)
        self.constructor_provenance = _callable_provenance(constructor)
        self.generate_code = getattr(getattr(base, "generate", None), "__code__", None)
        self._create_completion_code = getattr(
            getattr(base, "_create_completion", None), "__code__", None
        )
        self.create_completion_code = getattr(
            getattr(base, "create_completion", None), "__code__", None
        )
        self.create_chat_completion_code = getattr(
            getattr(base, "create_chat_completion", None), "__code__", None
        )
        self.eval_code = getattr(getattr(base, "eval", None), "__code__", None)
        base_close = inspect.getattr_static(base, "close", None)
        base_close = getattr(base_close, "__func__", base_close)
        self.close_code = getattr(base_close, "__code__", None)
        self.close_provenance = _callable_provenance(base_close)
        adapter_close = inspect.getattr_static(type(client), "close", None)
        self.adapter_close_callable = getattr(adapter_close, "__func__", adapter_close)
        self.native_entry_codes = tuple(
            (name, _callable_code(getattr(base, name, None))) for name in _BOUND_NATIVE_ENTRY_NAMES
        )
        self.adapter_codes = tuple(
            getattr(getattr(type(client), name, None), "__code__", None)
            for name in (
                "generate",
                "_create_completion",
                "create_completion",
                "create_chat_completion",
                "eval",
                "close",
                "_init_sampler",
                *_BOUND_NATIVE_ENTRY_NAMES,
            )
        )
        guarded_method_names = (
            "generate",
            "_create_completion",
            "create_completion",
            "create_chat_completion",
            "eval",
            "close",
            "_init_sampler",
            *_BOUND_NATIVE_ENTRY_NAMES,
        )
        self.base_method_provenance = tuple(
            (name, _callable_provenance(inspect.getattr_static(base, name, None)))
            for name in guarded_method_names
        )
        self.adapter_method_provenance = tuple(
            (
                name,
                _callable_provenance(inspect.getattr_static(type(client), name, None)),
            )
            for name in guarded_method_names
        )
        low_level = getattr(getattr(backend, "llama", None), "llama_cpp", None)
        sync = getattr(low_level, "llama_synchronize", None)
        self.synchronize = sync if callable(sync) else None
        self.synchronize_module = low_level
        self.handler = handler
        self.handler_code = _callable_code(handler)
        self.handler_mode = handler_mode
        self.handler_qualified = handler_qualified
        self.chat_format = getattr(client, "chat_format", None)
        self.draft_model_binding = object.__getattribute__(client, "__dict__").get("draft_model")
        self.tokenizer_binding = getattr(client, "tokenizer_", None)
        self.tokenizer_provenance = _default_tokenizer_provenance(client, backend)
        self.tokenizer_qualified = _default_tokenizer_is_supported(client, backend)
        _mode, _selected, _qualified, provenance = _qualify_handler_with_provenance(client, backend)
        self.handler_provenance = provenance
        self._gate = _ContextGate()
        self._quarantined = False
        self._reason = "native_synchronize_unavailable" if self.synchronize is None else None
        self._lock = threading.RLock()

    @property
    def client(self) -> Any | None:
        return self._client_ref()

    @property
    def qualified(self) -> bool:
        return (
            self.synchronize is not None
            and self.handler_qualified
            and self.handler_mode != "opaque"
            and self.tokenizer_qualified
            and not self._quarantined
        )

    def quarantine(self, reason: str) -> None:
        with self._lock:
            self._quarantined = True
            if self._reason is None:
                self._reason = reason
            self._gate.quarantine()

    def validate(self) -> Any:
        client = self.client
        if client is None:
            self.quarantine("native_client_unavailable")
            raise NativeContextUnavailableError()
        try:
            provenance_available = _has_pinned_method_provenance(
                self.backend.Llama
            ) and _has_pinned_method_provenance(type(client))
        except BaseException:
            provenance_available = False
        if not provenance_available:
            self.quarantine("native_method_provenance_unavailable")
            raise NativeContextUnavailableError()
        try:
            if (
                id(client) != self.client_id
                or type(client) is not self.backend_type
                or object.__getattribute__(client, "_aurora_native_generation") is not self
                or client._ctx is not self.context_owner
                or client.ctx is not self.context_pointer
                or getattr(client, "tokenizer_", None) is not self.tokenizer_binding
                or _default_tokenizer_is_supported(client, self.backend)
                is not self.tokenizer_qualified
                or _default_tokenizer_provenance(client, self.backend) != self.tokenizer_provenance
                or type(object.__getattribute__(client, "__dict__")) is not dict
                or any(
                    name in object.__getattribute__(client, "__dict__")
                    for name in (
                        "generate",
                        "_create_completion",
                        "create_completion",
                        "create_chat_completion",
                        "eval",
                        "close",
                        "_init_sampler",
                        *_BOUND_NATIVE_ENTRY_NAMES,
                    )
                )
                or not _is_supported_backend(self.backend)
                or self.backend.Llama is not self.backend_base_type
                or inspect.getattr_static(self.backend_base_type, "__init__", None)
                is not self.constructor_callable
                or inspect.getattr_static(type(client), "_aurora_base_init", None)
                is not self.constructor_callable
                or inspect.getattr_static(type(client), "_aurora_base_init_code", None)
                is not self.constructor_code
                or inspect.getattr_static(type(client), "_aurora_base_init_provenance", None)
                != self.constructor_provenance
                or _callable_code(self.constructor_callable) is not self.constructor_code
                or _callable_provenance(self.constructor_callable) != self.constructor_provenance
                or self.backend.llama is not self.backend_llama_module
                or self.backend.llama_chat_format is not self.backend_format_module
                or not self.generate_code
                or not self._create_completion_code
                or not self.create_completion_code
                or not self.create_chat_completion_code
                or not self.eval_code
                or not self.close_code
                or _callable_provenance(
                    getattr(
                        inspect.getattr_static(self.backend.Llama, "close", None),
                        "__func__",
                        inspect.getattr_static(self.backend.Llama, "close", None),
                    )
                )
                != self.close_provenance
                or tuple(
                    getattr(getattr(type(client), name, None), "__code__", None)
                    for name in (
                        "generate",
                        "_create_completion",
                        "create_completion",
                        "create_chat_completion",
                        "eval",
                        "close",
                        "_init_sampler",
                        *_BOUND_NATIVE_ENTRY_NAMES,
                    )
                )
                != self.adapter_codes
                or tuple(
                    getattr(getattr(self.backend.Llama, name, None), "__code__", None)
                    for name in (
                        "generate",
                        "_create_completion",
                        "create_completion",
                        "create_chat_completion",
                        "eval",
                        "close",
                        "_init_sampler",
                    )
                )
                != (
                    self.generate_code,
                    self._create_completion_code,
                    self.create_completion_code,
                    self.create_chat_completion_code,
                    self.eval_code,
                    self.close_code,
                    getattr(
                        inspect.getattr_static(self.backend.Llama, "_init_sampler", None),
                        "__code__",
                        None,
                    ),
                )
                or tuple(
                    (name, _callable_code(getattr(self.backend.Llama, name, None)))
                    for name in _BOUND_NATIVE_ENTRY_NAMES
                )
                != self.native_entry_codes
                or tuple(
                    (
                        name,
                        _callable_provenance(
                            inspect.getattr_static(self.backend.Llama, name, None)
                        ),
                    )
                    for name in (
                        "generate",
                        "_create_completion",
                        "create_completion",
                        "create_chat_completion",
                        "eval",
                        "close",
                        "_init_sampler",
                        *_BOUND_NATIVE_ENTRY_NAMES,
                    )
                )
                != self.base_method_provenance
                or tuple(
                    (
                        name,
                        _callable_provenance(inspect.getattr_static(type(client), name, None)),
                    )
                    for name in (
                        "generate",
                        "_create_completion",
                        "create_completion",
                        "create_chat_completion",
                        "eval",
                        "close",
                        "_init_sampler",
                        *_BOUND_NATIVE_ENTRY_NAMES,
                    )
                )
                != self.adapter_method_provenance
            ):
                self.quarantine("native_resource_binding_changed")
                raise NativeContextUnavailableError()
        except BaseException as error:
            if isinstance(error, NativeContextUnavailableError):
                raise
            self.quarantine("native_resource_binding_unavailable")
            raise NativeContextUnavailableError() from None
        try:
            if client.chat_format != self.chat_format:
                raise NativeContextUnavailableError()
            mode, current_handler, qualified, provenance = _qualify_handler_with_provenance(
                client, self.backend
            )
            low_level = getattr(self.backend_llama_module, "llama_cpp", None)
            synchronize = getattr(low_level, "llama_synchronize", None)
            if (
                current_handler is not self.handler
                or mode != self.handler_mode
                or qualified is not self.handler_qualified
                or not _same_handler_provenance(provenance, self.handler_provenance)
                or low_level is not self.synchronize_module
                or synchronize is not self.synchronize
            ):
                raise NativeContextUnavailableError()
        except BaseException as error:
            if isinstance(error, NativeContextUnavailableError):
                self.quarantine("native_handler_binding_changed")
                raise
            self.quarantine("native_handler_binding_unavailable")
            raise NativeContextUnavailableError() from None
        if self._quarantined:
            raise NativeContextUnavailableError()
        return client

    def selected_handler(self) -> tuple[Any, bool]:
        client = self.validate()
        _mode, handler, qualified, _provenance = _qualify_handler_with_provenance(
            client, self.backend
        )
        return handler, qualified and self.tokenizer_qualified


class NativeContextLease:
    """Whole-inference gate lease; it is independent of advancing thread."""

    def __init__(
        self,
        generation: LlamaResourceGeneration,
        gate: _ContextGate,
        loop: asyncio.AbstractEventLoop | None,
    ) -> None:
        self.generation = generation
        self.gate = gate
        self.loop = loop
        self.children: list[_IteratorRecord] = []
        self._child_reservations: list[object] = []
        self.operations: dict[int, Any] = {}
        self._client_hold = generation.client
        self.active = True
        self.started = False
        self.callable_attempted = False
        self.unknown = False
        self.reason: str | None = None
        self.inference_seen = False
        self.opaque_handler = False
        self.stopped = False
        self.revoked = False
        self.cache_tail_completed: bool | None = None
        self.request_member: Any = None
        self.owns_request_member = False
        self.chat_handler_consumed = False
        self._finishing = False
        self._finish_complete = threading.Event()
        self._finish_failed = False
        self._finish_lock = threading.RLock()
        self._finish_thread: int | None = None
        self._execution_lock = threading.RLock()
        self._execution_stack: list[tuple[int, _IteratorRecord | None]] = []
        self._ready_to_release = False
        self.before_release_callbacks: list[Callable[[], bool]] = []
        self._pending_group_result: tuple[bool, str | None, bool, bool | None] | None = None
        self.progress_reservation: Any = None
        self.stop_callback: Callable[[], None] | None = None
        self._lock = threading.RLock()

    def validate(self) -> None:
        if not self.active or self.unknown:
            raise NativeContextUnavailableError()
        with self.gate.lock:
            if self.gate.owner is not self or self.revoked:
                raise NativeContextUnavailableError()
            if self.gate.retiring and not self.started:
                raise NativeContextUnavailableError()
        member = self.request_member
        if member is not None and member.group.is_stopping and not _cleanup_active.get():
            raise NativeContextUnavailableError()
        client = self.generation.client
        try:
            client_state = object.__getattribute__(client, "__dict__")
            draft_model = client_state.get("draft_model")
        except BaseException:
            self._abandon_unknown("native_option_binding_unverified")
            raise NativeContextUnavailableError() from None
        if draft_model is not self.generation.draft_model_binding:
            self._abandon_unknown("native_option_binding_unverified")
            raise NativeContextUnavailableError() from None
        self.generation.validate()
        with self._lock:
            dispatches = tuple(
                record.dispatch
                for record in self.children
                if record.dispatch is not None and record.dispatch.stopping_criteria is not None
            )
        for dispatch in dispatches:
            if _selected_criteria_state(dispatch) != dispatch.stopping_criteria_state:
                self._abandon_unknown("native_stopping_criteria_changed")
                raise NativeContextUnavailableError()

    def begin_work(self) -> None:
        """Atomically mark first native entry against provider retirement."""

        with self.gate.lock:
            if (
                not self.active
                or self.unknown
                or self.revoked
                or self.gate.owner is not self
                or self.gate.quarantined
                or (self.gate.retiring and not self.started)
            ):
                raise NativeContextUnavailableError()
            member = self.request_member
            if member is None:
                self.started = True
                return
            with member.group._lock:
                if (
                    member.group.is_stopping
                    or member.group._members.get(member.sequence) is not member
                ):
                    raise NativeContextUnavailableError()
                self.started = True

    def note_callable_attempted(self) -> None:
        """Record that an admitted user callable ran, even without native entry."""

        with self._lock:
            self.callable_attempted = True

    def retain_operation(self, operation: Any) -> None:
        with self._lock:
            self.operations[id(operation)] = operation

    def settle_operation(self, operation: Any) -> None:
        with self._lock:
            self.operations.pop(id(operation), None)

    def _has_unresolved_operations(self) -> bool:
        try:
            from app.services.orchestrator.native_worker import _current_operation

            current_operation = _current_operation.get()
        except (ImportError, AttributeError):
            current_operation = None
        current_is_owned = False
        if current_operation is not None and current_operation.context_lease is self:
            lifecycle = current_operation.lifecycle
            with lifecycle.lock:
                current_is_owned = (
                    lifecycle.operations.get(current_operation.sequence) is current_operation
                    and current_operation.worker_thread_id == threading.get_ident()
                    and current_operation.state.value == "body_running"
                )
        with self._lock:
            pending = any(
                not (operation is current_operation and current_is_owned)
                and (
                    operation.settlement_unknown
                    or operation.state.value not in ("body_returned", "body_raised")
                )
                for operation in self.operations.values()
            )
            children = tuple(self.children)
        if pending:
            return True
        for record in children:
            with record.condition:
                if record.advancing_thread is not None or (
                    record.close_started and not record.close_checked
                ):
                    return True
        return False

    def _abandon_unknown(self, reason: str) -> None:
        self.unknown = True
        self.reason = self.reason or reason
        self.generation.quarantine(reason)
        with _generations_lock:
            if len(_quarantined_generations) < MAX_LLAMA_GENERATIONS:
                _quarantined_generations[self.generation.client_id] = self.generation

    def add_iterator(
        self,
        iterator: Any,
        *,
        kind: str = "iterator",
        reservation: object,
    ) -> _OwnedIterator:
        self.validate()
        with self._lock:
            if reservation not in self._child_reservations:
                self._abandon_unknown("native_iterator_capacity_unreserved")
                raise NativeContextUnavailableError()
            self._child_reservations.remove(reservation)
            parent = _current_child.get()
            record = _IteratorRecord(self, iterator, kind=kind, request_member=self.request_member)
            self.children.append(record)
            if parent is not None and parent.lease is self:
                if parent.kind in ("chat_completion", "native_completion") and parent.children:
                    self._abandon_unknown("native_iterator_structure_unverified")
                    return _OwnedIterator(record)
                record.parent = parent
                parent.children.append(record)
        return _OwnedIterator(record)

    @contextmanager
    def reserve_child(self) -> Iterator[object]:
        """Prepay bounded iterator ownership before invoking a native factory."""

        with self._lock:
            if len(self.children) + len(self._child_reservations) >= MAX_LLAMA_CHILDREN:
                self._abandon_unknown("native_iterator_capacity_reached")
                raise NativeContextUnavailableError()
            reservation = object()
            self._child_reservations.append(reservation)
        try:
            yield reservation
        finally:
            with self._lock, suppress(ValueError):
                self._child_reservations.remove(reservation)

    @contextmanager
    def execution(
        self, record: _IteratorRecord | None, *, close_only: bool = False
    ) -> Iterator[None]:
        """Serialize all raw context entry, allowing only recorded nesting."""

        thread_id = threading.get_ident()
        parent = _current_child.get()
        with self._execution_lock:
            if self._execution_stack:
                active_thread, active_record = self._execution_stack[-1]
                if (
                    active_thread != thread_id
                    or record is None
                    or active_record is None
                    or record.parent is not active_record
                    or parent is not active_record
                ):
                    self._abandon_unknown("native_context_concurrent_execution")
                    raise NativeContextUnavailableError()
            elif (
                record is not None
                and record.parent is not None
                and not (
                    close_only
                    and _cleanup_active.get()
                    and record.close_started
                    and record.lease is self
                )
            ):
                self._abandon_unknown("native_iterator_independent_child")
                raise NativeContextUnavailableError()
            if close_only and (
                not _cleanup_active.get()
                or record is None
                or not record.close_started
                or record.lease is not self
            ):
                self._abandon_unknown("native_iterator_cleanup_authority_invalid")
                raise NativeContextUnavailableError()
            self._execution_stack.append((thread_id, record))
        try:
            yield
        finally:
            with self._execution_lock:
                if self._execution_stack and self._execution_stack[-1] == (thread_id, record):
                    self._execution_stack.pop()
                else:
                    self._abandon_unknown("native_context_execution_order_unknown")

    def mark_unknown(self, reason: str) -> None:
        self._abandon_unknown(reason)

    def finish_sync(self, *, stopped: bool = False, release_gate: bool = True) -> None:
        thread_id = threading.get_ident()
        wait_for_owner = False
        with self._finish_lock:
            if self._finish_complete.is_set():
                if self._finish_failed:
                    raise NativeContextUnavailableError()
                return
            if self._finishing:
                try:
                    current_loop = asyncio.get_running_loop()
                except RuntimeError:
                    current_loop = None
                if self._finish_thread == thread_id or (current_loop is not None):
                    # A synchronous duplicate cannot block any event loop and
                    # must not alter the accepted finalizer's outcome.
                    raise NativeContextUnavailableError()
                wait_for_owner = True
            else:
                # Only the owner of a fresh finalization attempt is subject
                # to the synchronous event-loop guard. Duplicate observers
                # are rejected above without poisoning that retained owner.
                _reject_sync_entry_on_owned_loop(self)
                self._finishing = True
                self._finish_thread = thread_id
        if wait_for_owner:
            self._finish_complete.wait()
            if self._finish_failed:
                raise NativeContextUnavailableError()
            return
        failed = self.unknown or self._has_unresolved_operations()
        if failed:
            self.reason = self.reason or "native_operation_settlement_unknown"
        # Closing is reverse creation/dependency order.  Each record is sealed
        # before invoking its callback so callbacks cannot obtain inference.
        marker = _cleanup_active.set(True)
        self.stopped = self.stopped or stopped
        if self.stopped and self.cache_tail_completed is None:
            self.cache_tail_completed = False
        if self.cache_tail_completed is not True and any(
            not record.exhausted for record in self.children
        ):
            self.stopped = True
            if self.cache_tail_completed is None:
                self.cache_tail_completed = False
        try:
            if not failed:
                # The flat ownership list also contains nested records. Start
                # from the dependency roots so each parent closes its recorded
                # children while its exact execution scope is active.
                roots = tuple(record for record in reversed(self.children) if record.parent is None)
                for record in roots:
                    try:
                        _close_record(record)
                    except BaseException:
                        record.close_failed = True
                        failed = True
                        self.reason = self.reason or "native_iterator_close_failed"
            if not failed:
                try:
                    self.generation.validate()
                    sync = self.generation.synchronize
                    if sync is None:
                        raise NativeContextUnavailableError()
                    sync(self.generation.context_pointer)
                except BaseException:
                    failed = True
                    self.reason = self.reason or "native_context_synchronize_failed"
            if not failed:
                callbacks = tuple(self.before_release_callbacks)
                self.before_release_callbacks.clear()
                for callback in callbacks:
                    try:
                        if callback() is not True:
                            failed = True
                            self.reason = self.reason or "native_context_cleanup_accounting_unknown"
                            break
                    except BaseException:
                        failed = True
                        self.reason = self.reason or "native_context_cleanup_accounting_unknown"
                        break
        finally:
            _cleanup_active.reset(marker)
        self.active = False
        if not self.inference_seen:
            failed = True
            self.reason = self.reason or "native_inference_not_started"
        try:
            if failed:
                self._abandon_unknown(self.reason or "native_completion_unknown")
                self._record_group_completion(known=False, reason=self.reason)
                self._finish_failed = True
                return
            if self.opaque_handler:
                # An unqualified handler may have retained work that is not
                # represented by this lease's child records.  Synchronizing
                # the Llama context alone does not make that ownership safe to
                # hand to a later request.
                self._abandon_unknown("native_handler_unqualified")
                self._record_group_completion(
                    known=False,
                    reason=self.reason or "native_handler_unqualified",
                    stopped=self.stopped,
                    cache_tail_completed=self.cache_tail_completed,
                )
                self._finish_failed = True
                return
            self._pending_group_result = (
                True,
                None,
                self.stopped,
                self.cache_tail_completed,
            )
            self._ready_to_release = True
            if release_gate:
                self.release_after_checked_finish()
        finally:
            with self._finish_lock:
                self._finish_thread = None
                self._finish_complete.set()

    def release_after_checked_finish(self) -> None:
        """Hand the gate to a successor only after cleanup operation settlement."""

        if not self._ready_to_release or self.unknown or self._has_unresolved_operations():
            raise NativeContextUnavailableError()
        pending = self._pending_group_result
        if pending is None:
            raise NativeContextUnavailableError()
        self._record_group_completion(
            known=pending[0],
            reason=pending[1],
            stopped=pending[2],
            cache_tail_completed=pending[3],
        )
        self._pending_group_result = None
        from app.services.orchestrator.native_worker import release_provider_progress

        release_provider_progress(self.progress_reservation)
        if self.progress_reservation is not None:
            self.progress_reservation.context_lease = None
        with _generations_lock:
            _quarantined_generations.pop(self.generation.client_id, None)
        self.progress_reservation = None
        self._client_hold = None
        with _generations_lock:
            _active_leases.pop(id(self), None)
        self.gate.release(self)

    def _record_group_completion(
        self,
        *,
        known: bool,
        reason: str | None,
        stopped: bool = False,
        cache_tail_completed: bool | None = None,
    ) -> None:
        if not known and self.reason is not None:
            # The lease records failures in first-observed order. A later
            # finalizer wrapper must not replace the original bounded reason.
            reason = self.reason
        if (
            reason
            in (
                "native_context_finish_unknown",
                "native_runner_settlement_unknown",
                "native_runner_unknown",
            )
            and self.progress_reservation is not None
        ):
            # Prefer the first concrete lifecycle failure over the generic
            # finalizer wrapper reason. The provider lifecycle records only
            # bounded internal codes, never arbitrary exception text.
            lifecycle = self.progress_reservation.lifecycle
            with lifecycle.lock:
                reason = lifecycle.failure or reason
        member = self.request_member
        if member is None:
            _mark_group_completion(
                known=known,
                reason=reason,
                stopped=stopped,
                cache_tail_completed=cache_tail_completed,
            )
            return
        from app.services.orchestrator.native_request_completion import (
            finish_request_member,
            mark_request_member_completion,
        )

        mark_request_member_completion(
            member,
            known=known,
            reason=reason,
            stopped=stopped,
            cache_tail_completed=cache_tail_completed,
        )
        finish_request_member(
            member,
            owned=self.owns_request_member,
            reason=reason,
            stopped=stopped,
        )

    def release_unstarted(self) -> None:
        if self.revoked:
            from app.services.orchestrator.native_worker import release_provider_progress

            release_provider_progress(self.progress_reservation)
            self.progress_reservation = None
            with _generations_lock:
                _active_leases.pop(id(self), None)
            return
        if not self.started and not self.children and not self.unknown:
            self.active = False
            from app.services.orchestrator.native_worker import release_provider_progress

            release_provider_progress(self.progress_reservation)
            self.progress_reservation = None
            with _generations_lock:
                _active_leases.pop(id(self), None)
            self.gate.release(self)
        else:
            self._abandon_unknown("native_context_lease_abandoned")


class _OwnedIterator:
    """Iterator proxy that validates and restores the lease per advancement."""

    def __init__(self, record: _IteratorRecord) -> None:
        self._record = record

    def __iter__(self) -> _OwnedIterator:
        return self

    def __next__(self) -> Any:
        return self._advance("__next__")

    def send(self, value: Any) -> Any:
        return self._advance("send", value)

    def throw(self, *args: Any) -> Any:
        return self._advance("throw", *args)

    def _advance(self, method_name: str, *args: Any) -> Any:
        record = self._record
        lease = record.lease
        current_thread = threading.get_ident()
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None
        with record.condition:
            while record.advancing_thread is not None or (
                record.close_started and not record.close_checked
            ):
                if (
                    record.advancing_thread == current_thread
                    or record.close_thread == current_thread
                ):
                    lease._abandon_unknown("native_iterator_reentrant_progress")
                    raise NativeContextUnavailableError()
                if current_loop is not None:
                    lease._abandon_unknown("native_iterator_progress_observer_unavailable")
                    raise NativeContextUnavailableError()
                record.condition.wait()
            if record.close_started or record.closed:
                if record.close_failed:
                    raise NativeContextUnavailableError()
                raise StopIteration
            record.advancing_thread = current_thread
        try:
            return self._advance_owned(record, method_name, *args)
        finally:
            with record.condition:
                record.advancing_thread = None
                record.condition.notify_all()

    def _advance_owned(self, record: _IteratorRecord, method_name: str, *args: Any) -> Any:
        lease = record.lease
        _reject_sync_entry_on_owned_loop(lease)
        if record.request_member is not None and record.request_member.group.is_stopping:
            lease.stopped = True
            if lease.cache_tail_completed is None:
                lease.cache_tail_completed = False
        with lease.execution(record):
            lease.validate()
            lease.started = True
            _attach_to_current_parent(record)
            lease_marker = _current_lease.set(lease)
            child_marker = _current_child.set(record)
            dispatch_marker = (
                _chat_dispatch.set(record.dispatch) if record.dispatch is not None else None
            )
            advanced = False
            try:
                if record.request_member is not None:
                    from app.services.orchestrator.native_worker import _current_operation

                    member_scope = bind_request_member(
                        record.request_member, operation=_current_operation.get()
                    )
                else:
                    member_scope = nullcontext()
                with member_scope:
                    group = _current_request_group_state()
                    if group is not None and group.is_stopping:
                        lease.stopped = True
                        lease.cache_tail_completed = False
                        raise NativeContextUnavailableError()
                    method = getattr(record.iterator, method_name)
                    advanced = True
                    result = method(*args)
            except StopIteration:
                if advanced:
                    record.closed = True
                    record.exhausted = True
                    if record.parent is None and (
                        record.kind == "chat_completion"
                        and not lease.opaque_handler
                        or lease.cache_tail_completed is None
                        and all(child.exhausted for child in lease.children)
                    ):
                        lease.cache_tail_completed = True
                raise
            except BaseException:
                # An advancement error does not prove the raw child was closed.
                # The lease finalizer must still perform its checked close.
                raise
            finally:
                if dispatch_marker is not None:
                    _chat_dispatch.reset(dispatch_marker)
                _current_child.reset(child_marker)
                _current_lease.reset(lease_marker)
            return result

    def close(self) -> None:
        _close_record(self._record)


def _attach_to_current_parent(record: _IteratorRecord) -> None:
    parent = _current_child.get()
    if parent is None or parent is record or parent.lease is not record.lease:
        return
    if record.parent is parent:
        return
    # Parentage is assigned at construction or by the exact selected chat
    # dispatch handoff. An advancing child cannot reparent itself later.
    record.lease._abandon_unknown("native_iterator_parent_changed")
    raise NativeContextUnavailableError()


def _close_record(record: _IteratorRecord) -> None:
    lease = record.lease
    current_thread = threading.get_ident()
    first_error: BaseException | None = None
    try:
        current_loop = asyncio.get_running_loop()
    except RuntimeError:
        current_loop = None
    on_lease_loop = current_loop is not None
    with record.condition:
        while record.advancing_thread is not None or (
            record.close_started and not record.close_checked
        ):
            if record.advancing_thread == current_thread or record.close_thread == current_thread:
                lease._abandon_unknown("native_iterator_reentrant_close")
                raise NativeContextUnavailableError()
            if on_lease_loop:
                # Joining an executor-owned close from its event loop can
                # prevent the retained operation handoff from completing.
                # This observer has no authority to wait, but its rejection
                # does not invalidate the already-retained close owner.
                raise NativeContextUnavailableError()
            record.condition.wait()
        if record.close_checked:
            if record.close_failed:
                raise NativeContextUnavailableError()
            return
        # A duplicate observer on an event-loop thread must not quarantine a
        # close already claimed by another thread. Check the loop only after
        # the condition identifies this caller as the first close owner.
        _reject_sync_entry_on_owned_loop(lease)
        record.close_started = True
        record.close_thread = current_thread
        record.closed = True
    from app.services.orchestrator.native_worker import native_cleanup_callback

    lease_marker = _current_lease.set(lease)
    cleanup_marker = _cleanup_active.set(True)
    try:
        with lease.execution(record, close_only=True), native_cleanup_callback():
            # Cleanup executes the same pinned resource code as advancement.
            # Recheck before touching any retained child or close descriptor.
            lease.generation.validate()
            # `execution()` must observe the caller's recorded parent before
            # installing the child being closed.  Installing it first makes
            # an ordinary nested close look like an unrecorded self-parent.
            child_marker = _current_child.set(record)
            try:
                for child in reversed(record.children):
                    try:
                        _close_record(child)
                    except BaseException as error:
                        first_error = first_error or error
                try:
                    lease.generation.validate()
                    try:
                        close = getattr(record.iterator, "close", _MISSING)
                    except BaseException:
                        close = _MISSING
                        raise NativeContextUnavailableError() from None
                    if close is _MISSING or not callable(close):
                        # Exhaustion proves there are no more values, but does
                        # not prove the required raw close boundary ran.
                        raise NativeContextUnavailableError()
                    else:
                        if record.request_member is not None:
                            from app.services.orchestrator.native_worker import _current_operation

                            member_scope = bind_request_member(
                                record.request_member, operation=_current_operation.get()
                            )
                        else:
                            member_scope = nullcontext()
                        with member_scope:
                            result = close()
                        if inspect.isawaitable(result):
                            if inspect.iscoroutine(result):
                                result.close()
                            raise NativeContextUnavailableError()
                except BaseException as error:
                    first_error = first_error or error
            finally:
                _current_child.reset(child_marker)
            if first_error is not None:
                record.close_failed = True
                lease._abandon_unknown("native_iterator_close_failed")
    except BaseException as error:
        first_error = first_error or error
        record.close_failed = True
        lease._abandon_unknown("native_iterator_close_failed")
    finally:
        _cleanup_active.reset(cleanup_marker)
        _current_lease.reset(lease_marker)
        if record.dispatch is not None and record.dispatch.handler_record is record:
            record.dispatch.wrapper_frame = None
            record.dispatch.chat_invocation_frame = None
        with record.condition:
            record.close_checked = True
            record.close_thread = None
            record.condition.notify_all()
            if first_error is not None:
                record.close_failed = True
    if first_error is not None:
        raise NativeContextUnavailableError() from None


def _mark_group_completion(
    *,
    known: bool,
    reason: str | None,
    stopped: bool = False,
    cache_tail_completed: bool | None = None,
) -> None:
    try:
        from app.services.orchestrator.native_request_completion import (
            mark_current_native_completion,
        )

        mark_current_native_completion(
            known=known,
            reason=reason,
            stopped=stopped,
            cache_tail_completed=cache_tail_completed,
        )
    except BaseException:
        return


def _current_request_group_state() -> Any:
    from app.services.orchestrator.native_request_completion import (
        current_request_group,
        current_request_member,
    )

    member = current_request_member()
    return member.group if member is not None else current_request_group()


def _current_request_member_state() -> Any:
    from app.services.orchestrator.native_request_completion import (
        current_request_member,
    )

    return current_request_member()


def _require_group_admission(
    lease: NativeContextLease | None = None,
) -> Any:
    try:
        group = _current_request_group_state()
    except RuntimeError:
        if lease is None:
            raise
        # A copied request context is not a capability on a foreign thread or
        # event loop. Reject it at the admission boundary without mutating the
        # already accepted operation that owns the original context.
        raise NativeContextUnavailableError() from None
    if group is None:
        if lease is not None and lease.request_member is not None:
            if not lease.request_member.group.is_open:
                raise NativeContextUnavailableError()
            return lease.request_member
        return None
    member = _current_request_member_state()
    if (
        member is None
        and lease is not None
        and lease.owns_request_member
        and lease.request_member is not None
        and lease.request_member.group is group
    ):
        member = lease.request_member
    if member is None or member.group is not group:
        raise NativeContextUnavailableError()
    if group.is_stopping and not _cleanup_active.get():
        raise NativeContextUnavailableError()
    if lease is not None and member.resource is not None:
        generation = generation_for(member.resource)
        if generation is not None and generation is not lease.generation:
            raise NativeContextUnavailableError()
    if lease is not None:
        if lease.request_member is not None and lease.request_member is not member:
            raise NativeContextUnavailableError()
        lease.request_member = member
    return member


def _get_generation(client: Any) -> LlamaResourceGeneration | None:
    with _generations_lock:
        candidate = _generations.get(id(client))
    if candidate is None or candidate.client is not client:
        return None
    try:
        attached = getattr(client, "_aurora_native_generation", None)
    except BaseException:
        candidate.quarantine("native_generation_binding_unavailable")
        raise NativeContextUnavailableError() from None
    if attached is not candidate:
        candidate.quarantine("native_generation_binding_changed")
        raise NativeContextUnavailableError()
    return candidate


def bind_native_wrapper(wrapper: Any, client: Any) -> None:
    """Pin one wrapper object to the exact constructed client it first owns."""

    generation = _get_generation(client)
    if generation is None:
        return
    key = id(wrapper)
    with _generations_lock:
        existing = _wrapper_bindings.get(key)
        if existing is not None and existing.wrapper() is wrapper:
            if existing.client is not client:
                generation.quarantine("native_wrapper_binding_changed")
                raise NativeContextUnavailableError()
            return
        if existing is not None:
            _wrapper_bindings.pop(key, None)
        if len(_wrapper_bindings) >= MAX_LLAMA_WRAPPER_BINDINGS:
            raise NativeContextUnavailableError()
        try:
            wrapper_ref = weakref.ref(
                wrapper,
                lambda _ref, ident=key: _remove_wrapper_binding(ident),
            )
            strong_wrapper = None
        except TypeError:
            wrapper_ref = None
            strong_wrapper = wrapper
        _wrapper_bindings[key] = _WrapperBinding(
            wrapper_ref=wrapper_ref,
            wrapper_strong=strong_wrapper,
            client=client,
        )


def _remove_wrapper_binding(key: int) -> None:
    with _generations_lock:
        _wrapper_bindings.pop(key, None)


def generation_for(
    provider: Any, *, retained_owner: bool = False
) -> LlamaResourceGeneration | None:
    """Resolve only an explicitly constructor-registered client/wrapper."""

    if isinstance(provider, LlamaResourceGeneration):
        client = provider.client
        if client is None:
            raise NativeContextUnavailableError()
        with _generations_lock:
            registered = _generations.get(id(client))
        if registered is not provider or registered.client is not client:
            raise NativeContextUnavailableError()
        return provider
    direct = _get_generation(provider)
    if direct is not None:
        return direct
    client = provider
    try:
        if inspect.getattr_static(provider, "client", None) is not None:
            client = provider.client
    except BaseException:
        client = None
    key = id(provider)
    with _generations_lock:
        binding = _wrapper_bindings.get(key)
        if binding is not None and binding.wrapper() is not provider:
            _wrapper_bindings.pop(key, None)
            binding = None
        if binding is not None and client is not binding.client:
            old_generation = _get_generation(binding.client)
            if old_generation is not None:
                old_generation.quarantine("native_wrapper_binding_changed")
            if retained_owner:
                return old_generation
            raise NativeContextUnavailableError()
        generation = _get_generation(client) if client is not None else None
        if generation is None:
            if binding is not None and retained_owner:
                return _get_generation(binding.client)
            return None
        if binding is None:
            if len(_wrapper_bindings) >= MAX_LLAMA_WRAPPER_BINDINGS:
                raise NativeContextUnavailableError()
            try:
                wrapper_ref = weakref.ref(
                    provider,
                    lambda _ref, ident=key: _remove_wrapper_binding(ident),
                )
                strong_wrapper = None
            except TypeError:
                wrapper_ref = None
                strong_wrapper = provider
            binding = _WrapperBinding(wrapper_ref, strong_wrapper, client)
            _wrapper_bindings[key] = binding
    return generation


def is_registered_native_generation(provider: Any) -> bool:
    """Return whether this exact provider is a constructor-owned Llama alias."""

    return generation_for(provider) is not None


def retirement_close_binding(provider: Any) -> Callable[[Any], Any] | None:
    """Return the captured close wrapper only while its exact binding is intact.

    Retirement is allowed to inspect this binding after inference admission has
    closed or the generation has been quarantined. This validates only the
    constructor-pinned close path; it does not prove that the client is idle or
    authorize disposal while any operation, iterator, or member remains live.
    """

    try:
        generation = generation_for(provider, retained_owner=True)
        if generation is None or generation.client is not provider:
            return None
        if (
            type(provider) is not generation.backend_type
            or object.__getattribute__(provider, "_aurora_native_generation") is not generation
            or provider._ctx is not generation.context_owner
            or provider.ctx is not generation.context_pointer
        ):
            return None
        adapter_close = inspect.getattr_static(type(provider), "close", _MISSING)
        adapter_close = getattr(adapter_close, "__func__", adapter_close)
        if adapter_close is not generation.adapter_close_callable or _callable_provenance(
            adapter_close
        ) != next(
            provenance
            for name, provenance in generation.adapter_method_provenance
            if name == "close"
        ):
            return None
        base_close = inspect.getattr_static(generation.backend.Llama, "close", _MISSING)
        base_close = getattr(base_close, "__func__", base_close)
        if (
            _callable_provenance(base_close) != generation.close_provenance
            or getattr(base_close, "__code__", None) is not generation.close_code
        ):
            return None
        return generation.adapter_close_callable
    except BaseException:
        return None


def canonical_native_owner(provider: Any, *, validate: bool = True) -> Any:
    generation = generation_for(provider, retained_owner=not validate)
    if generation is None:
        return provider
    client = generation.client
    if validate:
        try:
            generation.validate()
        except BaseException:
            generation.quarantine("native_resource_binding_changed")
            raise NativeContextUnavailableError() from None
    return client if client is not None else provider


def retirement_blocked(provider: Any) -> bool:
    generation = generation_for(provider)
    if generation is None:
        return False
    with generation._gate.lock:
        return (
            generation._gate.quarantined
            or generation._gate.retiring
            or generation._gate.owner is not None
            or bool(generation._gate.waiters)
        )


def begin_native_retirement(provider: Any) -> bool:
    """Close known physical-context admission before provider retirement."""

    generation = generation_for(provider)
    return generation._gate.begin_retirement() if generation is not None else True


async def wait_native_retired(provider: Any) -> bool:
    """Wait for an admitted physical context lease without using an executor."""

    generation = generation_for(provider)
    return await generation._gate.wait_retired() if generation is not None else True


def context_member_is_active(member: Any, provider: Any) -> bool:
    """Allow the stream adapter to share only its enclosing context member."""

    lease = _current_lease.get()
    if lease is None or lease.request_member is not member or not lease.active:
        return False
    try:
        generation = generation_for(provider)
    except BaseException:
        return False
    return generation is lease.generation


def _handler_factory_parts(handler: Any, module: Any) -> tuple[Any, Any] | None:
    """Return exact formatter/factory provenance for package-built handlers."""

    factory = getattr(module, "chat_formatter_to_chat_completion_handler", None)
    code = getattr(handler, "__code__", None)
    factory_code = getattr(factory, "__code__", None)
    if not callable(factory) or code is None or factory_code is None:
        return None
    if len(factory_code.co_consts) > 256:
        return None
    expected = tuple(
        item
        for item in factory_code.co_consts
        if inspect.iscode(item) and item.co_name == "chat_completion_handler"
    )
    if (
        not expected
        or not any(code is candidate for candidate in expected)
        or getattr(handler, "__module__", None) != getattr(module, "__name__", None)
    ):
        return None
    try:
        closure = inspect.getclosurevars(handler)
    except BaseException:
        return None
    formatter = closure.nonlocals.get("chat_formatter")
    if formatter is None:
        return None
    return formatter, factory


def _handler_callable_state(
    handler: Any,
    module: Any,
    seen: set[int] | None = None,
    budget: list[int] | None = None,
) -> tuple[Any, ...] | None:
    """Bind a bounded executable dependency graph without invoking hooks."""

    if not inspect.isfunction(handler):
        return None
    if seen is None:
        seen = set()
    if budget is None:
        budget = [0]
    identity = id(handler)
    if identity in seen:
        return ("function-ref", identity, id(handler.__code__))
    budget[0] += 1
    if budget[0] > 256:
        return None
    seen.add(identity)
    code = handler.__code__
    if len(code.co_names) > max(0, 256 - budget[0]):
        seen.remove(identity)
        return None
    namespace = handler.__globals__
    referenced = []
    for name in code.co_names:
        budget[0] += 1
        if budget[0] > 256:
            seen.remove(identity)
            return None
        if name not in namespace:
            continue
        value = namespace[name]
        value_type = type(value)
        if value is module:
            state = ("module", id(value))
        elif inspect.isfunction(value):
            if value.__globals__ is getattr(module, "__dict__", None):
                state = _handler_callable_state(value, module, seen, budget)
                if state is None:
                    seen.remove(identity)
                    return None
            else:
                external_names = value.__code__.co_names
                external_closure = value.__closure__ or ()
                if len(external_names) + len(external_closure) > max(0, 256 - budget[0]):
                    seen.remove(identity)
                    return None
                external_bindings = []
                for external_name in external_names:
                    budget[0] += 1
                    if budget[0] > 256:
                        seen.remove(identity)
                        return None
                    external_bindings.append(
                        (
                            external_name,
                            id(value.__globals__.get(external_name, _MISSING)),
                        )
                    )
                external_closure_state = []
                for cell in external_closure:
                    budget[0] += 1
                    if budget[0] > 256:
                        seen.remove(identity)
                        return None
                    try:
                        external_closure_state.append(id(cell.cell_contents))
                    except ValueError:
                        seen.remove(identity)
                        return None
                state = (
                    "external-function",
                    id(value),
                    id(value.__code__),
                    id(value.__globals__),
                    id(value.__defaults__),
                    id(value.__kwdefaults__),
                    tuple(external_bindings),
                    tuple(external_closure_state),
                )
        elif inspect.ismodule(value):
            state = ("module", id(value), getattr(value, "__name__", None))
        elif isinstance(value, type):
            if value.__module__.startswith(("llama_cpp.", "llama_cpp_cuda.", "jinja2.")):
                call = inspect.getattr_static(value, "__call__", None)
                call = getattr(call, "__func__", call)
                state = (
                    "type",
                    id(value),
                    value.__module__,
                    value.__qualname__,
                    id(getattr(call, "__code__", None)),
                )
            else:
                state = ("type", id(value), value_type.__module__, value_type.__qualname__)
        elif value is None or value_type in (bool, int, float, str, bytes):
            state = ("constant", value_type.__module__, value_type.__qualname__, value)
        else:
            state = ("object", value_type.__module__, value_type.__qualname__, id(value))
        referenced.append((name, state))
    seen.remove(identity)
    return (id(code), id(namespace), tuple(referenced))


def _chatml_handler_dependency_state(module: Any) -> tuple[Any, ...] | None:
    """Pin the bounded Jinja and grammar methods used by the default handler."""

    namespace = getattr(module, "__dict__", {})
    jinja = namespace.get("jinja2")
    grammar = namespace.get("llama_grammar")
    environment_module = sys.modules.get("jinja2.environment")
    sandbox_module = sys.modules.get("jinja2.sandbox")
    runtime_module = sys.modules.get("jinja2.runtime")
    compiler_module = sys.modules.get("jinja2.compiler")
    parser_module = sys.modules.get("jinja2.parser")
    defaults_module = sys.modules.get("jinja2.defaults")
    filters_module = sys.modules.get("jinja2.filters")
    if not all(
        inspect.ismodule(value)
        for value in (
            jinja,
            grammar,
            environment_module,
            sandbox_module,
            runtime_module,
            compiler_module,
            parser_module,
            defaults_module,
            filters_module,
        )
    ):
        return None
    if jinja is not sys.modules.get("jinja2") or grammar is not sys.modules.get(
        "llama_cpp.llama_grammar"
    ):
        return None

    def method_state(
        owner: Any, module_name: str, class_name: str, names: tuple[str, ...]
    ) -> tuple[Any, ...] | None:
        if (
            type(owner) is not type
            or owner.__module__ != module_name
            or owner.__name__ != class_name
        ):
            return None
        methods = []
        for name in names:
            descriptor = inspect.getattr_static(owner, name, _MISSING)
            if descriptor is _MISSING:
                return None
            provenance = _callable_provenance(descriptor)
            if provenance is None:
                return None
            methods.append((name, id(descriptor), provenance))
        return (
            id(owner),
            owner.__module__,
            owner.__qualname__,
            tuple(id(base) for base in owner.__mro__),
            tuple(methods),
        )

    def function_state(owner: Any, name: str) -> tuple[Any, ...] | None:
        if not inspect.ismodule(owner):
            return None
        function = owner.__dict__.get(name)
        if not inspect.isfunction(function):
            return None
        return _callable_provenance(function)

    environment = environment_module.__dict__.get("Environment")
    template = environment_module.__dict__.get("Template")
    immutable_environment = sandbox_module.__dict__.get("ImmutableSandboxedEnvironment")
    sandbox_environment = sandbox_module.__dict__.get("SandboxedEnvironment")
    context = runtime_module.__dict__.get("Context")
    code_generator = compiler_module.__dict__.get("CodeGenerator")
    parser = parser_module.__dict__.get("Parser")
    grammar_class = grammar.__dict__.get("LlamaGrammar")
    schema_converter = grammar.__dict__.get("SchemaConverter")
    default_filters = defaults_module.__dict__.get("DEFAULT_FILTERS")
    escape_map = grammar.__dict__.get("GRAMMAR_LITERAL_ESCAPES")
    json_gbnf = grammar.__dict__.get("JSON_GBNF")
    grammar_root = grammar.__dict__.get("LLAMA_GRAMMAR_DEFAULT_ROOT")
    space_rule = grammar.__dict__.get("SPACE_RULE")
    if (
        namespace.get("ImmutableSandboxedEnvironment") is not immutable_environment
        or any(
            type(value) is not type
            for value in (
                environment,
                template,
                immutable_environment,
                sandbox_environment,
                context,
                code_generator,
                parser,
            )
        )
        or type(grammar_class) is not type
        or type(schema_converter) is not type
        or type(default_filters) is not dict
        or type(escape_map) is not dict
        or len(escape_map) > 64
        or environment.__dict__.get("template_class") is not template
        or environment.__dict__.get("context_class") is not context
        or environment.__dict__.get("code_generator_class") is not code_generator
        or any(type(value) is not str for value in (json_gbnf, grammar_root, space_rule))
        or any(type(key) is not str or type(value) is not str for key, value in escape_map.items())
    ):
        return None

    class_states = (
        method_state(
            environment,
            "jinja2.environment",
            "Environment",
            (
                "__init__",
                "from_string",
                "make_globals",
                "compile",
                "parse",
                "_parse",
                "preprocess",
                "_tokenize",
                "_generate",
                "_compile",
            ),
        ),
        method_state(
            immutable_environment,
            "jinja2.sandbox",
            "ImmutableSandboxedEnvironment",
            ("__init__", "is_safe_attribute", "getattr", "getitem"),
        ),
        method_state(
            sandbox_environment,
            "jinja2.sandbox",
            "SandboxedEnvironment",
            ("__init__", "is_safe_attribute", "is_safe_callable", "getattr", "getitem"),
        ),
        method_state(
            template,
            "jinja2.environment",
            "Template",
            ("from_code", "_from_namespace", "render", "new_context"),
        ),
        method_state(
            context,
            "jinja2.runtime",
            "Context",
            ("__init__", "resolve_or_missing", "get_all", "call"),
        ),
        method_state(
            parser,
            "jinja2.parser",
            "Parser",
            (
                "__init__",
                "parse",
                "subparse",
                "parse_statements",
                "parse_statement",
                "parse_for",
                "parse_if",
                "parse_print",
                "parse_expression",
                "parse_condexpr",
                "parse_or",
                "parse_and",
                "parse_not",
                "parse_compare",
                "parse_math1",
                "parse_concat",
                "parse_math2",
                "parse_pow",
                "parse_unary",
                "parse_tuple",
                "parse_postfix",
                "parse_filter_expr",
                "parse_primary",
                "parse_filter",
            ),
        ),
        method_state(
            code_generator,
            "jinja2.compiler",
            "CodeGenerator",
            (
                "__init__",
                "visit",
                "blockvisit",
                "visit_Template",
                "visit_For",
                "visit_If",
                "visit_Output",
                "visit_Name",
                "visit_Const",
                "visit_TemplateData",
                "visit_Getattr",
                "visit_Filter",
            ),
        ),
        method_state(
            grammar_class,
            "llama_cpp.llama_grammar",
            "LlamaGrammar",
            ("__init__", "from_string", "from_json_schema"),
        ),
        method_state(
            schema_converter,
            "llama_cpp.llama_grammar",
            "SchemaConverter",
            (
                "__init__",
                "_format_literal",
                "not_literal",
                "_add_rule",
                "resolve_refs",
                "_generate_union_rule",
                "_visit_pattern",
                "_resolve_ref",
                "_generate_constant_rule",
                "visit",
                "_add_primitive",
                "_build_object_rule",
                "format_grammar",
            ),
        ),
    )
    function_states = (
        function_state(runtime_module, "new_context"),
        function_state(compiler_module, "generate"),
        function_state(grammar, "json_schema_to_gbnf"),
        function_state(jinja, "select_autoescape"),
        function_state(filters_module, "do_tojson"),
        function_state(namespace.get("json"), "dumps"),
        function_state(module, "_grammar_for_response_format"),
        function_state(module, "_grammar_for_json_schema"),
        function_state(module, "_grammar_for_json"),
    )
    strict_undefined = jinja.__dict__.get("StrictUndefined")
    strict_undefined_state = method_state(
        strict_undefined,
        "jinja2.runtime",
        "StrictUndefined",
        ("__str__", "__iter__", "__bool__"),
    )
    if any(state is None for state in (*class_states, *function_states, strict_undefined_state)):
        return None
    environment_bindings = (
        id(environment.__dict__.get("template_class")),
        id(environment.__dict__.get("context_class")),
        id(environment.__dict__.get("code_generator_class")),
        id(environment.__dict__.get("concat")),
        id(strict_undefined),
    )
    return (
        (
            id(jinja),
            id(environment_module),
            id(sandbox_module),
            id(runtime_module),
            id(compiler_module),
            id(parser_module),
            id(defaults_module),
            id(filters_module),
            id(grammar),
        ),
        environment_bindings,
        (
            id(default_filters),
            id(default_filters.get("tojson")),
        ),
        (
            json_gbnf,
            grammar_root,
            id(grammar.__dict__.get("GRAMMAR_LITERAL_ESCAPE_RE")),
            tuple(sorted(escape_map.items())),
            id(grammar.__dict__.get("INVALID_RULE_CHARS_RE")),
            space_rule,
        ),
        class_states,
        function_states,
        strict_undefined_state,
    )


def _qualify_handler_with_provenance(
    client: Any, backend: Any
) -> tuple[str, Any, bool, tuple[Any, ...]]:
    if getattr(client, "chat_handler", None) is not None:
        handler = client.chat_handler
        return "opaque", handler, False, ("explicit", handler)
    chat_format = getattr(client, "chat_format", None)
    generated = getattr(client, "_chat_handlers", {}).get(chat_format)
    module = getattr(backend, "llama_chat_format", None)
    try:
        if generated is not None:
            handler = generated
            source = "gguf-generated"
        else:
            get_handler = getattr(module, "get_chat_completion_handler", None)
            handler = get_handler(chat_format) if callable(get_handler) else None
            source = "package-registry"
    except BaseException:
        return "opaque", None, False, ("unavailable",)
    if handler is None:
        return "opaque", None, False, (source, None)
    is_chatml_function_calling = (
        generated is None
        and chat_format == "chatml-function-calling"
        and source == "package-registry"
        and getattr(backend, "__name__", None) == "llama_cpp"
        and getattr(module, "__name__", None) == "llama_cpp.llama_chat_format"
        and inspect.isfunction(handler)
        and handler is getattr(module, "chatml_function_calling", None)
        and handler.__module__ == module.__name__
        and handler.__globals__ is module.__dict__
        and handler.__name__ == "chatml_function_calling"
        and handler.__qualname__ == "chatml_function_calling"
        and handler.__closure__ is None
        and handler.__code__.co_filename == getattr(module, "__file__", None)
    )
    if is_chatml_function_calling:
        converter_names = (
            "_convert_completion_to_chat",
            "_convert_completion_to_chat_function",
            "_convert_text_completion_to_chat",
            "_convert_text_completion_chunks_to_chat",
            "_convert_text_completion_logprobs_to_chat",
        )
        converter_state = tuple(
            (
                name,
                _callable_provenance(getattr(module, name)),
            )
            for name in converter_names
            if inspect.isfunction(getattr(module, name, None))
        )
        # The exact installed handler references a broad Jinja/grammar surface.
        # Pin its direct executable graph and each selected converter's direct
        # bindings instead of recursively fingerprinting those imported
        # dependency objects as if they were formatter-owned state.
        handler_state = _callable_provenance(handler)
        dependency_state = _chatml_handler_dependency_state(module)
        execution_state = (handler_state, converter_state, dependency_state)
        qualified = (
            handler_state is not None
            and bool(converter_state)
            and all(state is not None for _, state in converter_state)
            and dependency_state is not None
        )
        provenance = (
            source,
            handler,
            handler.__code__,
            None,
            None,
            execution_state,
        )
        return "chatml_function_calling", handler, qualified, provenance
    parts = _handler_factory_parts(handler, module)
    if parts is None:
        return "opaque", handler, False, (source, handler)
    formatter, factory = parts
    jinja_type = getattr(module, "Jinja2ChatFormatter", None)
    is_jinja = (
        generated is not None
        and isinstance(jinja_type, type)
        and type(formatter) is jinja_type
        and type(formatter).__module__ == getattr(module, "__name__", None)
    )
    is_standard_text = (
        generated is None
        and inspect.isfunction(formatter)
        and formatter.__module__ == getattr(module, "__name__", None)
        and formatter.__globals__ is getattr(module, "__dict__", None)
        and formatter.__closure__ is None
        and getattr(formatter, "__code__", None) is not None
        and formatter.__code__.co_filename == getattr(module, "__file__", None)
    )
    converter_names = (
        "_convert_completion_to_chat",
        "_convert_completion_to_chat_function",
        "_convert_text_completion_to_chat",
        "_convert_text_completion_chunks_to_chat",
        "_convert_text_completion_logprobs_to_chat",
    )
    converter_state = tuple(
        (
            name,
            _handler_callable_state(getattr(module, name), module),
        )
        for name in converter_names
        if inspect.isfunction(getattr(module, name, None))
    )
    converter_graph_qualified = all(state is not None for _, state in converter_state)
    execution_state = (
        (
            _handler_state_fingerprint(formatter, module),
            _handler_state_fingerprint(handler, module),
            converter_state,
        )
        if is_jinja or is_standard_text
        else None
    )
    qualified = (
        getattr(backend, "__name__", None) == "llama_cpp"
        and (is_jinja or is_standard_text)
        and execution_state is not None
        and converter_graph_qualified
        and all(item is not None for item in execution_state)
    )
    mode = "gguf_template" if is_jinja else "standard_formatter" if is_standard_text else "opaque"
    provenance = (
        source,
        factory,
        handler.__code__,
        formatter,
        _callable_code(formatter),
        execution_state,
    )
    return mode, handler, qualified, provenance


def _qualify_handler(client: Any, backend: Any) -> tuple[str, Any, bool]:
    mode, handler, qualified, _provenance = _qualify_handler_with_provenance(client, backend)
    return mode, handler, qualified


def _default_tokenizer_provenance(client: Any, backend: Any) -> tuple[Any, ...] | None:
    """Return the exact pinned tokenizer implementation and model binding."""
    if getattr(backend, "__name__", None) != "llama_cpp":
        return None
    tokenizer = getattr(client, "tokenizer_", _MISSING)
    if tokenizer is _MISSING:
        # Lightweight source fixtures do not run the pinned Llama constructor.
        # Real installed backends always install tokenizer_ during __init__.
        return ("source-fixture",) if getattr(backend, "__file__", None) is None else None
    backend_name = getattr(backend, "__name__", None)
    tokenizer_module = (
        sys.modules.get(f"{backend_name}.llama_tokenizer")
        if backend_name in ("llama_cpp", "llama_cpp_cuda")
        else None
    )
    tokenizer_type = getattr(tokenizer_module, "LlamaTokenizer", None)
    try:
        client_state = object.__getattribute__(client, "__dict__")
        tokenizer_state = object.__getattribute__(tokenizer, "__dict__")
    except BaseException:
        return None
    if (
        not isinstance(tokenizer_type, type)
        or type(tokenizer) is not tokenizer_type
        or tokenizer_type.__module__ != f"{backend_name}.llama_tokenizer"
        or type(tokenizer_state) is not dict
        or set(tokenizer_state) != {"_model"}
        or tokenizer_state.get("_model") is not client_state.get("_model")
    ):
        return None
    implementations = []
    for method_name in ("tokenize", "detokenize"):
        try:
            method = inspect.getattr_static(tokenizer_type, method_name)
        except BaseException:
            return None
        if (
            not inspect.isfunction(method)
            or method.__globals__ is not tokenizer_module.__dict__
            or method.__code__.co_filename != getattr(tokenizer_module, "__file__", None)
        ):
            return None
        implementations.append(
            (
                method_name,
                id(method),
                id(method.__code__),
                id(method.__globals__),
            )
        )
    model = tokenizer_state["_model"]
    model_type = type(model)
    try:
        model_instance_state = object.__getattribute__(model, "__dict__")
    except AttributeError:
        model_instance_state = {}
    except BaseException:
        return None
    if type(model_instance_state) is not dict or any(
        name in model_instance_state for name in ("tokenize", "detokenize")
    ):
        return None
    model_methods = []
    for method_name in ("tokenize", "detokenize"):
        try:
            method = inspect.getattr_static(model_type, method_name)
        except BaseException:
            return None
        method_state = _callable_provenance(method)
        if method_state is None:
            return None
        model_methods.append((method_name, method_state))
    return (
        id(tokenizer_type),
        id(tokenizer_module),
        id(model),
        (id(model_type), tuple(model_methods)),
        tuple(implementations),
    )


def _default_tokenizer_is_supported(client: Any, backend: Any) -> bool:
    """Qualify only the pinned, unmodified llama-cpp tokenizer path."""

    return _default_tokenizer_provenance(client, backend) is not None


def _same_handler_provenance(left: tuple[Any, ...], right: tuple[Any, ...]) -> bool:
    return (
        len(left) == len(right)
        and bool(left)
        and left[0] == right[0]
        and all(
            a == b if index == len(left) - 1 else a is b
            for index, (a, b) in enumerate(zip(left[1:], right[1:], strict=True), start=1)
        )
    )


def _callable_code(callback: Any) -> Any:
    """Return code for the exact callable without invoking descriptors."""

    function = getattr(callback, "__func__", callback)
    code = getattr(function, "__code__", None)
    if code is not None:
        return code
    try:
        call = inspect.getattr_static(type(callback), "__call__", None)
    except BaseException:
        return None
    return getattr(getattr(call, "__func__", call), "__code__", None)


def _callable_provenance(callback: Any) -> tuple[Any, ...] | None:
    """Pin executable identity, globals and bounded referenced dependencies."""

    function = getattr(callback, "__func__", callback)
    if not inspect.isfunction(function):
        code = _callable_code(callback)
        return None if code is None else (type(callback), id(callback), id(code))
    code = function.__code__
    names = code.co_names
    closure = function.__closure__ or ()
    if len(names) + len(closure) > 512:
        return None
    try:
        globals_state = tuple(
            (name, id(function.__globals__.get(name, _MISSING))) for name in names
        )
        closure_state = tuple(id(cell.cell_contents) for cell in closure)
    except BaseException:
        return None
    return (
        id(function),
        id(code),
        id(function.__globals__),
        id(function.__defaults__),
        id(function.__kwdefaults__),
        globals_state,
        closure_state,
    )


def _has_pinned_method_provenance(owner: Any) -> bool:
    """Require provenance for every present executable and every core method."""

    for name in _PINNED_METHOD_NAMES:
        try:
            descriptor = inspect.getattr_static(owner, name, _MISSING)
        except BaseException:
            return False
        if descriptor is _MISSING:
            if name in _REQUIRED_PINNED_METHOD_NAMES:
                return False
            continue
        provenance = _callable_provenance(descriptor)
        code = _callable_code(descriptor)
        if provenance is None or (name in _REQUIRED_PINNED_METHOD_NAMES and code is None):
            return False
    return True


def _stream_requested(method: Any, args: tuple[Any, ...], kwargs: dict[str, Any]) -> bool:
    """Read the pinned upstream ``stream`` argument in either call form."""

    if "stream" in kwargs:
        return bool(kwargs["stream"])
    try:
        parameters = tuple(inspect.signature(method).parameters.values())
    except (TypeError, ValueError):
        raise NativeContextUnavailableError() from None
    for parameter in parameters:
        if parameter.name != "stream":
            continue
        if parameter.kind in (
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
        ):
            position = parameters.index(parameter) - 1
            return bool(args[position]) if 0 <= position < len(args) else False
        return False
    return False


def _handler_state_fingerprint(formatter: Any, module: Any) -> tuple[Any, ...] | None:
    """Fingerprint selected formatter state without invoking custom hooks."""

    jinja_budget = [0]
    jinja_callable_cache: dict[Any, tuple[Any, ...]] = {}
    jinja_type_cache: dict[type[Any], tuple[Any, ...]] = {}

    def charge_jinja_state() -> bool:
        jinja_budget[0] += 1
        return jinja_budget[0] <= 4096

    def jinja_callable(value: Any) -> tuple[Any, ...] | None:
        if not charge_jinja_state() or not inspect.isfunction(value):
            return None
        cached = jinja_callable_cache.get(value)
        if cached is not None:
            return cached
        code = value.__code__
        closure = value.__closure__ or ()
        remaining = 4096 - jinja_budget[0]
        if len(code.co_names) > remaining or len(closure) > remaining:
            return None
        globals_state = []
        for name in code.co_names:
            if not charge_jinja_state():
                return None
            if name not in value.__globals__:
                continue
            referenced = value.__globals__[name]
            if inspect.isfunction(referenced):
                referenced_code = referenced.__code__
                referenced_names = referenced_code.co_names
                referenced_closure = referenced.__closure__ or ()
                if len(referenced_names) + len(referenced_closure) > max(0, 4096 - jinja_budget[0]):
                    return None
                referenced_globals = []
                for referenced_name in referenced_names:
                    if not charge_jinja_state():
                        return None
                    referenced_globals.append(
                        (
                            referenced_name,
                            id(referenced.__globals__.get(referenced_name, _MISSING)),
                        )
                    )
                referenced_cells = []
                for cell in referenced_closure:
                    if not charge_jinja_state():
                        return None
                    try:
                        referenced_cells.append(id(cell.cell_contents))
                    except ValueError:
                        return None
                state = (
                    "function",
                    id(referenced),
                    id(referenced_code),
                    id(referenced.__globals__),
                    id(referenced.__defaults__),
                    id(referenced.__kwdefaults__),
                    tuple(referenced_globals),
                    tuple(referenced_cells),
                )
            elif inspect.ismodule(referenced):
                state = ("module", id(referenced), getattr(referenced, "__name__", None))
                if getattr(referenced, "__name__", None) in (
                    "llama_cpp.llama",
                    "llama_cpp_cuda.llama",
                ):
                    stopping = getattr(referenced, "StoppingCriteriaList", None)
                    if not isinstance(stopping, type):
                        return None
                    stopping_state = jinja_type(stopping)
                    if stopping_state is None:
                        return None
                    state += (("StoppingCriteriaList", stopping_state),)
            elif isinstance(referenced, type):
                referenced_type = jinja_type(referenced)
                if referenced_type is None:
                    return None
                state = ("type", referenced_type)
            elif referenced is None or type(referenced) in (bool, int, float, str, bytes):
                state = (type(referenced), referenced)
            else:
                state = (type(referenced), id(referenced))
            globals_state.append((name, state))
        closure_state = []
        for cell in closure:
            if not charge_jinja_state():
                return None
            try:
                contents = cell.cell_contents
            except ValueError:
                return None
            closure_state.append((contents.__class__, id(contents)))
        state = (
            id(value),
            id(code),
            id(value.__globals__),
            tuple(globals_state),
            tuple(closure_state),
        )
        jinja_callable_cache[value] = state
        return state

    def jinja_type(value: type[Any]) -> tuple[Any, ...] | None:
        if not charge_jinja_state():
            return None
        cached = jinja_type_cache.get(value)
        if cached is not None:
            return cached
        ignored = {
            "__dict__",
            "__weakref__",
            "__doc__",
            "__module__",
            "__qualname__",
            "__annotations__",
        }
        mro_state = []
        for cls in value.__mro__:
            attributes = []
            class_attributes = vars(cls)
            if len(class_attributes) > max(0, 4096 - jinja_budget[0]):
                return None
            for name, item in class_attributes.items():
                if not charge_jinja_state():
                    return None
                if name in ignored:
                    continue
                function = getattr(item, "__func__", item)
                if inspect.isfunction(function):
                    names = function.__code__.co_names
                    closure = function.__closure__ or ()
                    remaining = max(0, 4096 - jinja_budget[0])
                    if len(names) + len(closure) > remaining:
                        return None
                    # Reserve the complete tuple traversal before building it;
                    # repeated provenance checks remain within one aggregate
                    # bound even for methods with large globals/closures.
                    jinja_budget[0] += len(names) + len(closure)
                    state = (
                        "function",
                        id(function),
                        id(function.__code__),
                        id(function.__globals__),
                        tuple(
                            (
                                name,
                                id(function.__globals__.get(name, _MISSING)),
                            )
                            for name in names
                        ),
                        tuple(id(cell.cell_contents) for cell in closure),
                    )
                elif function is None or type(function) in (bool, int, float, str, bytes):
                    state = (type(function), function)
                else:
                    state = (type(function), id(function))
                attributes.append((name, state))
            mro_state.append(
                (
                    id(cls),
                    cls.__module__,
                    cls.__qualname__,
                    tuple(sorted(attributes)),
                )
            )
        state = (
            id(value),
            value.__module__,
            value.__qualname__,
            tuple(mro_state),
        )
        jinja_type_cache[value] = state
        return state

    def jinja_value(
        value: Any, seen: set[int] | None = None, depth: int = 0
    ) -> tuple[Any, ...] | None:
        if not charge_jinja_state():
            return None
        if seen is None:
            seen = set()
        if depth > 8:
            return None
        value_type = type(value)
        if value is None or value_type in (str, int, bool, float, bytes):
            if value_type in (str, bytes) and len(value) > 65536:
                return None
            return ("scalar", value_type, value)
        if value_type in (dict, list, tuple, set, frozenset):
            identity = id(value)
            if identity in seen:
                return None
            item_count = len(value)
            multiplier = 2 if value_type is dict else 1
            if item_count * multiplier > max(0, 4096 - jinja_budget[0]):
                return None
            seen.add(identity)
            if value_type is dict:
                entries = []
                for key, item in value.items():
                    if jinja_budget[0] >= 4096:
                        seen.remove(identity)
                        return None
                    key_state = jinja_value(key, seen, depth + 1)
                    if key_state is None:
                        seen.remove(identity)
                        return None
                    item_state = jinja_value(item, seen, depth + 1)
                    if item_state is None:
                        seen.remove(identity)
                        return None
                    entries.append((key_state, item_state))
                items = tuple(sorted(entries, key=repr))
            else:
                entries = []
                for item in value:
                    if jinja_budget[0] >= 4096:
                        seen.remove(identity)
                        return None
                    state = jinja_value(item, seen, depth + 1)
                    if state is None:
                        seen.remove(identity)
                        return None
                    entries.append(state)
                items = (
                    tuple(sorted(entries, key=repr))
                    if value_type in (set, frozenset)
                    else tuple(entries)
                )
            seen.remove(identity)
            return ("container", value_type, identity, items)
        if inspect.isfunction(value):
            state = jinja_callable(value)
            return None if state is None else ("function", state)
        if inspect.ismodule(value):
            return ("module", id(value), getattr(value, "__name__", None))
        if isinstance(value, type):
            state = jinja_type(value)
            return None if state is None else ("type", state)
        return ("object", value_type, id(value))

    def jinja_mapping(value: Any) -> tuple[Any, ...] | None:
        if not charge_jinja_state() or type(value) is not dict:
            return None
        if len(value) > max(0, 4096 - jinja_budget[0]):
            return None
        entries = []
        for key, item in value.items():
            if not charge_jinja_state():
                return None
            if type(key) not in (str, int, bool, float, bytes):
                return None
            if type(key) in (str, bytes) and len(key) > 65536:
                return None
            item_state = jinja_value(item)
            if item_state is None:
                return None
            entries.append((key, item_state))
        return (id(value), tuple(sorted(entries, key=lambda entry: repr(entry[0]))))

    def jinja_template_state(template: Any) -> tuple[Any, ...] | None:
        if not charge_jinja_state():
            return None
        try:
            fields = object.__getattribute__(template, "__dict__")
        except BaseException:
            return None
        expected = {
            "environment",
            "globals",
            "name",
            "filename",
            "blocks",
            "root_render_func",
            "_module",
            "_debug_info",
            "_uptodate",
        }
        if type(fields) is not dict or len(fields) != len(expected) or set(fields) != expected:
            return None
        root = jinja_callable(fields["root_render_func"])
        blocks = fields["blocks"]
        if (
            type(blocks) is not dict
            or len(blocks) > 1024
            or len(blocks) > max(0, 4096 - jinja_budget[0])
        ):
            return None
        block_state = []
        for name, function in sorted(blocks.items()):
            if not charge_jinja_state():
                return None
            state = jinja_callable(function)
            if state is None:
                return None
            block_state.append((name, state))
        template_globals = fields["globals"]
        if type(template_globals) is not ChainMap:
            return None
        maps = object.__getattribute__(template_globals, "maps")
        if type(maps) is not list or len(maps) != 2:
            return None
        globals_state = tuple(jinja_mapping(mapping) for mapping in maps)
        if (
            root is None
            or any(state is None for state in globals_state)
            or fields["_module"] is not None
            or fields["_uptodate"] is not None
            or type(fields["name"]) not in (str, type(None))
            or type(fields["filename"]) not in (str, type(None))
            or type(fields["_debug_info"]) is not str
        ):
            return None
        template_type_state = jinja_type(type(template))
        if template_type_state is None:
            return None
        render_methods = []
        for method_name in ("render", "generate", "new_context"):
            try:
                method = inspect.getattr_static(type(template), method_name)
            except BaseException:
                return None
            function = getattr(method, "__func__", method)
            if not inspect.isfunction(function) or not charge_jinja_state():
                return None
            function_state = jinja_callable(function)
            if function_state is None:
                return None
            render_methods.append((method_name, function_state))
        return (
            id(template),
            template_type_state,
            tuple(render_methods),
            id(fields["environment"]),
            globals_state,
            fields["name"],
            fields["filename"],
            tuple(block_state),
            root,
            fields["_debug_info"],
        )

    def jinja_formatter_state(value: Any) -> tuple[Any, ...] | None:
        if not charge_jinja_state():
            return None
        try:
            fields = object.__getattribute__(value, "__dict__")
        except BaseException:
            return None
        expected = {
            "template",
            "eos_token",
            "bos_token",
            "add_generation_prompt",
            "stop_token_ids",
            "_environment",
        }
        if type(fields) is not dict or len(fields) != len(expected) or set(fields) != expected:
            return None
        environment_template = fields["_environment"]
        try:
            template_fields = object.__getattribute__(environment_template, "__dict__")
            environment = template_fields["environment"]
            environment_fields = object.__getattribute__(environment, "__dict__")
        except (AttributeError, KeyError, TypeError):
            return None
        environment_type = type(environment)
        if (
            environment_type.__module__ != "jinja2.sandbox"
            or environment_type.__name__ != "ImmutableSandboxedEnvironment"
            or type(template_fields) is not dict
            or type(environment_template).__module__ != "jinja2.environment"
            or type(environment_template).__name__ != "Template"
        ):
            return None
        allowed_environment_fields = {
            "block_start_string",
            "block_end_string",
            "variable_start_string",
            "variable_end_string",
            "comment_start_string",
            "comment_end_string",
            "line_statement_prefix",
            "line_comment_prefix",
            "trim_blocks",
            "lstrip_blocks",
            "newline_sequence",
            "keep_trailing_newline",
            "undefined",
            "optimized",
            "finalize",
            "autoescape",
            "filters",
            "tests",
            "globals",
            "loader",
            "cache",
            "bytecode_cache",
            "auto_reload",
            "policies",
            "extensions",
            "is_async",
        }
        allowed_environment_fields.update(("binop_table", "unop_table"))
        if (
            type(environment_fields) is not dict
            or len(environment_fields) != len(allowed_environment_fields)
            or set(environment_fields) != allowed_environment_fields
        ):
            return None
        env_state = []
        for name, item in environment_fields.items():
            if not charge_jinja_state():
                return None
            if name in (
                "filters",
                "tests",
                "globals",
                "binop_table",
                "unop_table",
            ):
                value_state = jinja_mapping(item)
                if value_state is None:
                    return None
            elif name == "extensions":
                if type(item) is not dict or item:
                    return None
                value_state = (id(item), ())
            elif name == "policies":
                # The pinned policy table contains only scalar values.
                value_state = jinja_mapping(item)
                if value_state is None:
                    return None
            elif name in ("cache", "loader", "bytecode_cache"):
                value_state = (type(item), id(item))
            elif item is None or type(item) in (str, bool, int, float, bytes):
                value_state = (type(item), item)
            elif inspect.isfunction(item):
                value_state = ("function", jinja_callable(item))
            elif isinstance(item, type):
                value_state = ("type", jinja_type(item))
            else:
                return None
            env_state.append((name, value_state))
        stop_tokens = fields["stop_token_ids"]
        if (
            type(fields["template"]) is not str
            or type(fields["eos_token"]) is not str
            or type(fields["bos_token"]) is not str
            or type(fields["add_generation_prompt"]) is not bool
            or (
                stop_tokens is not None
                and (
                    type(stop_tokens) is not set
                    or len(stop_tokens) > max(0, 4096 - jinja_budget[0])
                    or any(type(token) is not int for token in stop_tokens)
                )
            )
        ):
            return None
        if stop_tokens is not None:
            for _token in stop_tokens:
                if not charge_jinja_state():
                    return None
        simple_fields = (
            fields["template"],
            fields["eos_token"],
            fields["bos_token"],
            fields["add_generation_prompt"],
            tuple(sorted(stop_tokens)) if stop_tokens is not None else None,
        )
        template_state = jinja_template_state(environment_template)
        if template_state is None:
            return None
        formatter_type_state = jinja_type(type(value))
        environment_type_state = jinja_type(environment_type)
        if formatter_type_state is None or environment_type_state is None:
            return None
        return (
            formatter_type_state,
            simple_fields,
            (environment_type_state, id(environment), tuple(sorted(env_state))),
            template_state,
        )

    budget = [0]
    seen: set[int] = set()

    def freeze(value: Any, depth: int = 0) -> Any:
        budget[0] += 1
        if budget[0] > 4096 or depth > 9:
            return None
        value_type = type(value)
        type_key = (value_type.__module__, value_type.__qualname__, id(value_type))
        if (
            value_type.__module__ == getattr(module, "__name__", None)
            and value_type.__name__ == "Jinja2ChatFormatter"
        ):
            state = jinja_formatter_state(value)
            return None if state is None else ("jinja-formatter", state)
        if value is None or value_type in (bool, int, float, str, bytes):
            if value_type in (str, bytes) and len(value) > 65536:
                return None
            return ("value", type_key, value)
        if value_type in (tuple, list, set, frozenset, dict):
            identity = id(value)
            if identity in seen:
                return None
            item_count = len(value)
            multiplier = 2 if value_type is dict else 1
            if item_count * multiplier > max(0, 4096 - budget[0]):
                return None
            seen.add(identity)
            if value_type is dict:
                values = []
                for key, item in value.items():
                    if budget[0] >= 4096:
                        seen.remove(identity)
                        return None
                    frozen_key = freeze(key, depth + 1)
                    if frozen_key is None:
                        seen.remove(identity)
                        return None
                    frozen_item = freeze(item, depth + 1)
                    if frozen_item is None:
                        seen.remove(identity)
                        return None
                    values.append((frozen_key, frozen_item))
                values = tuple(sorted(values, key=lambda pair: repr(pair[0])))
            else:
                items = []
                for item in value:
                    if budget[0] >= 4096:
                        seen.remove(identity)
                        return None
                    frozen_item = freeze(item, depth + 1)
                    if frozen_item is None:
                        seen.remove(identity)
                        return None
                    items.append(frozen_item)
                values = (
                    tuple(sorted(items, key=repr))
                    if value_type in (set, frozenset)
                    else tuple(items)
                )
            seen.remove(identity)
            return ("container", type_key, identity, values)
        if value_type is ChainMap:
            identity = id(value)
            if identity in seen:
                return None
            seen.add(identity)
            maps = object.__getattribute__(value, "maps")
            if type(maps) is not list or len(maps) > max(0, 4096 - budget[0]):
                seen.remove(identity)
                return None
            frozen_maps_list = []
            for mapping in maps:
                if budget[0] >= 4096:
                    seen.remove(identity)
                    return None
                frozen_mapping = freeze(mapping, depth + 1)
                if frozen_mapping is None:
                    seen.remove(identity)
                    return None
                frozen_maps_list.append(frozen_mapping)
            frozen_maps = tuple(frozen_maps_list)
            seen.remove(identity)
            return ("chain-map", type_key, identity, frozen_maps)
        if inspect.isfunction(value):
            identity = id(value)
            if identity in seen:
                return None
            seen.add(identity)
            code = value.__code__
            if len(code.co_names) > max(0, 4096 - budget[0]):
                seen.remove(identity)
                return None
            globals_state = []
            for name in code.co_names:
                if budget[0] >= 4096:
                    seen.remove(identity)
                    return None
                if name not in value.__globals__:
                    continue
                referenced = value.__globals__[name]
                if inspect.ismodule(referenced):
                    if getattr(referenced, "__name__", None) in (
                        "llama_cpp.llama",
                        "llama_cpp_cuda.llama",
                    ):
                        stopping_list = getattr(referenced, "StoppingCriteriaList", None)
                        stopping_state = freeze(stopping_list, depth + 1)
                        if stopping_state is None:
                            seen.remove(identity)
                            return None
                        globals_state.append(
                            (
                                name,
                                (
                                    "module",
                                    id(referenced),
                                    stopping_state,
                                ),
                            )
                        )
                    else:
                        globals_state.append((name, ("module", id(referenced))))
                elif inspect.isfunction(referenced):
                    if len(referenced.__code__.co_names) > max(0, 4096 - budget[0]):
                        seen.remove(identity)
                        return None
                    globals_state.append(
                        (
                            name,
                            (
                                "function",
                                id(referenced),
                                id(referenced.__code__),
                                id(referenced.__globals__),
                            ),
                        )
                    )
                elif isinstance(referenced, type) and referenced.__module__.startswith(
                    (
                        "jinja2.",
                        "llama_cpp.llama_chat_format",
                        "llama_cpp.llama",
                        "llama_cpp_cuda.llama_chat_format",
                        "llama_cpp_cuda.llama",
                    )
                ):
                    frozen_type = freeze(referenced, depth + 1)
                    if frozen_type is None:
                        seen.remove(identity)
                        return None
                    globals_state.append((name, frozen_type))
                elif isinstance(referenced, type):
                    globals_state.append((name, ("type", id(referenced))))
                else:
                    frozen_reference = freeze(referenced, depth + 1)
                    if frozen_reference is None:
                        seen.remove(identity)
                        return None
                    globals_state.append((name, frozen_reference))
            defaults = freeze(value.__defaults__, depth + 1)
            kwdefaults = freeze(value.__kwdefaults__, depth + 1)
            cells = value.__closure__ or ()
            if len(cells) > max(0, 4096 - budget[0]):
                seen.remove(identity)
                return None
            closure_list = []
            for cell in cells:
                if budget[0] >= 4096:
                    seen.remove(identity)
                    return None
                try:
                    frozen_cell = freeze(cell.cell_contents, depth + 1)
                except ValueError:
                    seen.remove(identity)
                    return None
                closure_list.append(frozen_cell)
            closure = tuple(closure_list)
            seen.remove(identity)
            if (
                defaults is None
                or kwdefaults is None
                or any(item is None for _, item in globals_state)
                or any(item is None for item in closure)
            ):
                return None
            return (
                "function",
                identity,
                id(code),
                id(value.__globals__),
                tuple(globals_state),
                defaults,
                kwdefaults,
                closure,
            )
        if inspect.isbuiltin(value):
            return (
                "builtin",
                type_key,
                id(value),
                getattr(value, "__module__", None),
                getattr(value, "__qualname__", None),
            )
        if inspect.ismodule(value):
            return ("module", type_key, id(value))
        if isinstance(value, type) and value.__module__.startswith(
            (
                "jinja2.",
                "llama_cpp.llama_chat_format",
                "llama_cpp.llama",
                "llama_cpp_cuda.llama_chat_format",
                "llama_cpp_cuda.llama",
            )
        ):
            identity = id(value)
            if identity in seen:
                return None
            seen.add(identity)
            class_attributes = vars(value)
            if len(class_attributes) > max(0, 4096 - budget[0]):
                seen.remove(identity)
                return None
            attributes_list = []
            for name, item in class_attributes.items():
                if name.startswith("__"):
                    continue
                if budget[0] >= 4096:
                    seen.remove(identity)
                    return None
                frozen_item = freeze(item, depth + 1)
                if frozen_item is None:
                    seen.remove(identity)
                    return None
                attributes_list.append((name, frozen_item))
            attributes = tuple(attributes_list)
            seen.remove(identity)
            return ("type", type_key, identity, attributes)
        if value_type.__module__.startswith("jinja2.") and value_type.__name__ in (
            "Environment",
            "ImmutableSandboxedEnvironment",
        ):
            try:
                attributes = object.__getattribute__(value, "__dict__")
            except BaseException:
                return None
            allowed = {
                "block_start_string",
                "block_end_string",
                "variable_start_string",
                "variable_end_string",
                "comment_start_string",
                "comment_end_string",
                "line_statement_prefix",
                "line_comment_prefix",
                "trim_blocks",
                "lstrip_blocks",
                "newline_sequence",
                "keep_trailing_newline",
                "undefined",
                "optimized",
                "finalize",
                "autoescape",
                "filters",
                "tests",
                "globals",
                "loader",
                "cache",
                "bytecode_cache",
                "auto_reload",
                "policies",
                "extensions",
                "is_async",
                "binop_table",
                "unop_table",
            }
            if type(attributes) is not dict or not set(attributes) <= allowed:
                return None
            state = []
            for name, item in attributes.items():
                if name in ("binop_table", "unop_table"):
                    frozen = freeze(item, depth + 1)
                    if frozen is None:
                        return None
                    state.append((name, frozen))
                elif name == "cache":
                    # The compiled-template cache changes as templates are
                    # rendered, but does not change the selected formatter.
                    state.append((name, type(item), id(item)))
                elif name == "loader" or name == "bytecode_cache":
                    state.append((name, type(item), id(item)))
                elif name == "extensions":
                    if type(item) is not dict or item:
                        return None
                    state.append((name, ()))
                else:
                    frozen = freeze(item, depth + 1)
                    if frozen is None:
                        return None
                    state.append((name, frozen))
            return ("jinja-environment", type_key, id(value), tuple(sorted(state)))
        if value_type.__module__.startswith(
            ("jinja2.", "llama_cpp.llama_chat_format", "llama_cpp_cuda.llama_chat_format")
        ):
            identity = id(value)
            if identity in seen:
                return None
            seen.add(identity)
            try:
                attributes = object.__getattribute__(value, "__dict__")
            except BaseException:
                seen.remove(identity)
                return None
            if type(attributes) is not dict:
                seen.remove(identity)
                return None
            state = freeze(attributes, depth + 1)
            seen.remove(identity)
            if state is None:
                return None
            return ("object", type_key, identity, state)
        return None

    if (
        type(formatter).__module__ == getattr(module, "__name__", "llama_cpp.llama_chat_format")
        and type(formatter).__name__ == "Jinja2ChatFormatter"
    ):
        jinja_state = jinja_formatter_state(formatter)
        call = inspect.getattr_static(type(formatter), "__call__", None)
        call_function = getattr(call, "__func__", call)
        call_state = jinja_callable(call_function)
        if jinja_state is None or call_state is None:
            return None
        return ("pinned-jinja-formatter", jinja_state, call_state)
    if inspect.isfunction(formatter):
        if formatter.__globals__ is not module.__dict__:
            return None
        return freeze(formatter)
    try:
        fields = object.__getattribute__(formatter, "__dict__")
        call = inspect.getattr_static(type(formatter), "__call__", None)
    except BaseException:
        return None
    if type(fields) is not dict:
        return None
    call_function = getattr(call, "__func__", call)
    state = freeze(fields)
    call_state = freeze(call_function)
    if state is None or call_state is None:
        return None
    return ("formatter-instance", id(type(formatter)), state, call_state)


def _is_supported_backend(backend: Any) -> bool:
    name = getattr(backend, "__name__", None)
    if name not in ("llama_cpp", "llama_cpp_cuda") or sys.modules.get(name) is not backend:
        return False
    package_prefix = name + "."
    llama_module = getattr(backend, "llama", None)
    format_module = getattr(backend, "llama_chat_format", None)
    low_level = getattr(llama_module, "llama_cpp", None)
    return (
        sys.modules.get(package_prefix + "llama") is llama_module
        and sys.modules.get(package_prefix + "llama_chat_format") is format_module
        and sys.modules.get(package_prefix + "llama_cpp") is low_level
        and getattr(getattr(backend, "Llama", None), "__module__", None) == package_prefix + "llama"
        and getattr(llama_module, "Llama", None) is backend.Llama
    )


def _release_construction_reservation(token: object) -> bool:
    """Release one exact constructor reservation, never another caller's."""

    with _generations_lock:
        return _release_construction_reservation_locked(token)


def _release_construction_reservation_locked(token: object) -> bool:
    """Release a specific token while holding the registry lock."""

    global _generation_construction_reservations
    if token not in _generation_construction_tokens:
        return False
    _generation_construction_tokens.remove(token)
    _generation_construction_reservations -= 1
    return True


def _register_constructed_client(
    client: Any, backend: Any, *, construction_reservation: object | None = None
) -> bool:
    try:
        if not _is_supported_backend(backend):
            with _generations_lock:
                if construction_reservation is not None:
                    _release_construction_reservation_locked(construction_reservation)
                _failed_construction_owners[id(client)] = client
            return False
        existing = _get_generation(client)
        if existing is not None:
            existing.quarantine("native_generation_reinitialized")
            with _generations_lock:
                if construction_reservation is not None:
                    _release_construction_reservation_locked(construction_reservation)
                _failed_construction_owners[id(client)] = client
            return False
        weakref.ref(client)
        handler_mode, handler, qualified, _provenance = _qualify_handler_with_provenance(
            client, backend
        )
        generation = LlamaResourceGeneration(client, backend, handler_mode, handler, qualified)
        with _generations_lock:
            if (
                construction_reservation is not None
                and not _release_construction_reservation_locked(construction_reservation)
            ):
                _failed_construction_owners[id(client)] = client
                return False
            live = [value for value in _generations.values() if value.client is not None]
            if len(live) + len(_failed_construction_owners) >= MAX_LLAMA_GENERATIONS:
                _failed_construction_owners[id(client)] = client
                return False
            _generations[id(client)] = generation
        client._aurora_native_generation = generation
        return True
    except BaseException:
        if construction_reservation is not None:
            _release_construction_reservation(construction_reservation)
        with _generations_lock:
            current = _generations.get(id(client))
            if current is not None and current.client is client:
                _generations.pop(id(client), None)
            _failed_construction_owners[id(client)] = client
        return False


def make_owned_llama_class(backend: Any) -> Any:
    """Return a subclass that retains raw native generators at construction."""

    base = getattr(backend, "Llama", None)
    if not isinstance(base, type):
        raise NativeContextUnavailableError() from None
    try:
        base_init_descriptor = inspect.getattr_static(base, "__init__")
    except (AttributeError, TypeError):
        raise NativeContextUnavailableError() from None
    base_init = getattr(base_init_descriptor, "__func__", base_init_descriptor)
    if not inspect.isfunction(base_init):
        raise NativeContextUnavailableError() from None
    base_init_code = base_init.__code__
    base_init_provenance = _callable_provenance(base_init)
    if base_init_provenance is None:
        raise NativeContextUnavailableError() from None
    try:
        base_close = inspect.getattr_static(base, "close")
    except (AttributeError, TypeError):
        raise NativeContextUnavailableError() from None
    base_close = getattr(base_close, "__func__", base_close)
    if not inspect.isfunction(base_close):
        raise NativeContextUnavailableError() from None
    base_close_code = base_close.__code__
    base_close_provenance = _callable_provenance(base_close)
    if base_close_provenance is None or not _has_pinned_method_provenance(base):
        raise NativeContextUnavailableError() from None

    def close_failed_construction(client: Any, *, deferred_handoff: bool = False) -> bool:
        """Run captured close once; deferred owners wait for Task settlement."""

        with _generations_lock:
            if _failed_construction_owners.get(id(client)) is not client:
                return False
            state = _failed_construction_close_states.get(id(client))
            if state is not None and state[0] is client and state[1] != "deferred":
                return False
            if (
                state is not None
                and state[0] is client
                and state[1] == "deferred"
                and not deferred_handoff
                and (
                    id(client) in _failed_construction_close_tasks
                    or id(client) in _failed_construction_close_awaitables
                )
            ):
                # A scheduled/ambiguous executor handoff owns this close.
                # A synchronous caller cannot race it or release the owner
                # before that exact handoff settles.
                return False
            _failed_construction_close_states[id(client)] = (client, "running")
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            with _generations_lock:
                state = _failed_construction_close_states.get(id(client))
                if state is not None and state[0] is client and state[1] == "running":
                    _failed_construction_close_states[id(client)] = (
                        client,
                        "deferred",
                    )
            return False
        try:
            descriptor = inspect.getattr_static(base, "close")
            descriptor = getattr(descriptor, "__func__", descriptor)
            if (
                descriptor is not base_close
                or base_close.__code__ is not base_close_code
                or _callable_provenance(base_close) != base_close_provenance
            ):
                raise NativeContextUnavailableError()
            result = base_close(client)
            if inspect.isawaitable(result):
                if inspect.iscoroutine(result):
                    result.close()
                else:
                    with _generations_lock:
                        _failed_construction_close_awaitables[id(client)] = result
                raise NativeContextUnavailableError()
        except BaseException:
            with _generations_lock:
                state = _failed_construction_close_states.get(id(client))
                if state is not None and state[0] is client and state[1] == "running":
                    _failed_construction_close_states[id(client)] = (
                        client,
                        "failed",
                    )
            return False
        with _generations_lock:
            if (
                _failed_construction_owners.get(id(client)) is not client
                or (state := _failed_construction_close_states.get(id(client))) is None
                or state[0] is not client
                or state[1] != "running"
            ):
                return False
            if deferred_handoff:
                # The close body has returned, but the retained executor Task
                # has not yet published its own terminal result. Keep the
                # capacity owner until that exact handoff is observed.
                _failed_construction_close_states[id(client)] = (
                    client,
                    "body_returned",
                )
                return True
            _failed_construction_owners.pop(id(client), None)
            _failed_construction_close_states.pop(id(client), None)
            _failed_construction_close_awaitables.pop(id(client), None)
            _failed_construction_close_tasks.pop(id(client), None)
        return True

    def finish_deferred_construction_close(client: Any, task: asyncio.Task[Any]) -> None:
        """Release failed capacity only after the retained Task settles cleanly."""

        if task.cancelled():
            return
        try:
            succeeded = task.exception() is None and task.result() is True
        except BaseException:
            succeeded = False
        if not succeeded:
            return
        with _generations_lock:
            state = _failed_construction_close_states.get(id(client))
            if (
                _failed_construction_owners.get(id(client)) is not client
                or state is None
                or state[0] is not client
                or state[1] != "body_returned"
                or _failed_construction_close_tasks.get(id(client)) is not task
            ):
                return
            _failed_construction_owners.pop(id(client), None)
            _failed_construction_close_states.pop(id(client), None)
            _failed_construction_close_awaitables.pop(id(client), None)
            _failed_construction_close_tasks.pop(id(client), None)

    def schedule_failed_construction_close(client: Any) -> None:
        """Join a deferred constructor cleanup on the loop's shared executor."""

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        with _generations_lock:
            state = _failed_construction_close_states.get(id(client))
            if (
                _failed_construction_owners.get(id(client)) is not client
                or state is None
                or state[0] is not client
                or state[1] != "deferred"
                or id(client) in _failed_construction_close_tasks
                or id(client) in _failed_construction_close_awaitables
            ):
                return
            cleanup = asyncio.to_thread(close_failed_construction, client, deferred_handoff=True)
            # Keep the exact coroutine reachable before task creation: a task
            # factory may enqueue it and still raise before returning its Task.
            _failed_construction_close_awaitables[id(client)] = cleanup
            try:
                task = loop.create_task(cleanup)
            except BaseException:
                # The coroutine may already be running on the loop. Retain its
                # owner and coroutine as UNKNOWN; cancellation/creation failure
                # is not proof that the executor callable did not start.
                return
            if _failed_construction_owners.get(id(client)) is client:
                _failed_construction_close_awaitables.pop(id(client), None)
                _failed_construction_close_tasks[id(client)] = task
                task.add_done_callback(
                    lambda completed, retained=client: finish_deferred_construction_close(
                        retained, completed
                    )
                )

    def owned_init(self: Any, *args: Any, **kwargs: Any) -> None:
        global _generation_construction_reservations
        # A second initialization would replace the context pointer after the
        # existing generation had already admitted work. Reject before the
        # backend constructor can mutate the live client.
        with _generations_lock:
            prior = _generations.get(id(self))
            retained_partial = _failed_construction_owners.get(id(self)) is self
        if retained_partial:
            raise NativeContextUnavailableError()
        if prior is not None and prior.client is self:
            prior.quarantine("native_generation_reinitialized")
            raise NativeContextUnavailableError()
        try:
            current_init_descriptor = inspect.getattr_static(base, "__init__")
            current_init = getattr(current_init_descriptor, "__func__", current_init_descriptor)
            current_close_descriptor = inspect.getattr_static(base, "close")
            current_close = getattr(current_close_descriptor, "__func__", current_close_descriptor)
            constructor_unchanged = (
                backend.Llama is base
                and current_init is base_init
                and _callable_code(current_init) is base_init_code
                and _callable_provenance(current_init) == base_init_provenance
                and current_close is base_close
                and _callable_code(current_close) is base_close_code
                and _callable_provenance(current_close) == base_close_provenance
                and _has_pinned_method_provenance(base)
            )
        except BaseException:
            constructor_unchanged = False
        if not _is_supported_backend(backend) or not constructor_unchanged:
            raise NativeContextUnavailableError()
        construction_reservation = object()
        with _generations_lock:
            live = sum(value.client is not None for value in _generations.values())
            live += len(_failed_construction_owners)
            if live + _generation_construction_reservations >= MAX_LLAMA_GENERATIONS:
                raise NativeContextUnavailableError()
            _generation_construction_reservations += 1
            _generation_construction_tokens.add(construction_reservation)
        try:
            base_init(self, *args, **kwargs)
        except BaseException:
            # A backend constructor may allocate its context before a later
            # initialization step raises. Transfer this exact reservation to
            # the retained partial instance rather than reopening capacity
            # while its native allocation is unresolved.
            with _generations_lock:
                _release_construction_reservation_locked(construction_reservation)
                _failed_construction_owners[id(self)] = self
                _failed_construction_close_states[id(self)] = (self, "failed")
            with suppress(BaseException):
                self._aurora_native_registration_failed = True
            # The backend may have allocated resources before its own cleanup
            # stack was installed. A partial constructor object has no
            # comprehensive checked-close proof, so retain it as unresolved
            # capacity rather than invoking a possibly incomplete close path.
            raise
        if not _register_constructed_client(
            self, backend, construction_reservation=construction_reservation
        ):
            # This instance came through the owned constructor surface. If its
            # backend cannot be qualified or registered, never fall back to
            # unowned native execution through the base implementation.
            with _generations_lock:
                # The real registrar normally consumes the exact token. Keep
                # this idempotent ownership check here as well because a
                # failed/stub registrar may return without consuming it; never
                # decrement another concurrent constructor's reservation.
                _release_construction_reservation_locked(construction_reservation)
                _failed_construction_owners[id(self)] = self
            self._aurora_native_registration_failed = True
            if not close_failed_construction(self):
                schedule_failed_construction_close(self)
            raise NativeContextUnavailableError()

    def _lease(self: Any) -> NativeContextLease | None:
        generation = _get_generation(self)
        if generation is None:
            if (
                getattr(self, "_aurora_native_registration_failed", False)
                or getattr(type(self), "_aurora_owned_base", None) is base
            ):
                raise NativeContextUnavailableError()
            return None
        active = _current_lease.get()
        if active is not None:
            active.validate()
            if active.generation is not generation:
                raise NativeContextUnavailableError()
            if active.generation.client is not self:
                raise NativeContextUnavailableError()
            _require_group_admission(active)
            return active
        from app.services.orchestrator.native_request_completion import (
            current_request_group,
            current_request_member,
            finish_request_member,
        )

        group = current_request_group()
        member = current_request_member()
        owns_member = group is not None and member is None
        if owns_member:
            try:
                member = group.admit("native_context", resource=self)
            except (RuntimeError, ValueError):
                raise NativeContextUnavailableError() from None
        try:
            lease = generation._gate.acquire_sync(generation)
        except BaseException:
            if owns_member and member is not None:
                group.mark_not_submitted(member)
                finish_request_member(member, owned=True)
            raise
        lease.request_member = member
        lease.owns_request_member = owns_member
        lease.opaque_handler = not generation.qualified
        return lease

    def _note_direct_entry(self: Any) -> None:
        from app.services.orchestrator.native_worker import note_direct_native_entry

        note_direct_native_entry(self)

    def _wrap_raw(
        self: Any,
        raw: Any,
        lease: NativeContextLease | None,
        *,
        kind: str,
        reservation: object,
    ) -> Any:
        if lease is None or inspect.getattr_static(raw, "__next__", None) is None:
            return raw
        wrapped = lease.add_iterator(raw, kind=kind, reservation=reservation)
        dispatch = _chat_dispatch.get()
        if (
            dispatch is not None
            and dispatch.lease is lease
            and dispatch.client is self
            and dispatch.handler is lease.generation.handler
            and kind == "native_completion"
        ):
            record = wrapped._record
            parent = _current_child.get()
            if (
                dispatch.completion_claimed
                and dispatch.handler_record is not None
                and parent is dispatch.handler_record
                and record.parent is None
            ):
                # A selected package handler may be a lazy generator. Its
                # completion child is then constructed while the exact outer
                # handler record is advancing, after create_chat_completion
                # has returned. Bind that edge now, at construction time;
                # never infer or repair it during a later child advancement.
                record.parent = parent
                parent.children.append(record)
            record.dispatch = dispatch
            dispatch.children.append(record)
        return wrapped

    def _link_chat_children(
        lease: NativeContextLease,
        outer: _OwnedIterator,
        children: list[_IteratorRecord],
    ) -> None:
        if not children:
            return
        if len(children) != 1:
            lease.mark_unknown("native_chat_child_structure_unverified")
            return
        child = children[0]
        if child is outer._record:
            lease.mark_unknown("native_chat_child_structure_unverified")
            return
        if child.parent is outer._record:
            return
        if child.parent is not None:
            lease.mark_unknown("native_chat_child_structure_unverified")
            return
        child.parent = outer._record
        outer._record.children.append(child)

    def _active_selected_handler_frame(
        self: Any, lease: NativeContextLease, start: Any
    ) -> Any | None:
        dispatch = _chat_dispatch.get()
        if (
            dispatch is None
            or not dispatch.qualified
            or dispatch.lease is not lease
            or dispatch.client is not self
            or dispatch.handler is not lease.generation.handler
        ):
            return None
        active_record = _current_child.get()
        frame = start
        for _ in range(8):
            if frame is None:
                return None
            if (
                frame.f_code is lease.generation.handler_code
                and frame.f_locals.get("llama") is self
            ):
                lazy_handler_frame = (
                    active_record is not None
                    and active_record.dispatch is dispatch
                    and active_record.iterator is dispatch.handler_iterator
                    and getattr(dispatch.handler_iterator, "gi_frame", None) is frame
                )
                eager_parent = frame.f_back
                eager_handler_frame = (
                    eager_parent is not None
                    and eager_parent.f_code is lease.generation.create_chat_completion_code
                    and eager_parent.f_locals.get("self") is self
                    and eager_parent.f_locals.get("handler") is dispatch.handler
                    and eager_parent.f_back is not None
                    and eager_parent.f_back is dispatch.wrapper_frame
                    and eager_parent.f_back.f_code is lease.generation.adapter_codes[3]
                )
                if eager_handler_frame:
                    if dispatch.chat_invocation_frame is None:
                        dispatch.chat_invocation_frame = eager_parent
                    eager_handler_frame = eager_parent is dispatch.chat_invocation_frame
                return frame if lazy_handler_frame or eager_handler_frame else None
            frame = frame.f_back
        return None

    def _is_selected_jinja_stopping_criteria(
        self: Any,
        lease: NativeContextLease,
        criteria: Any,
        wrapper_frame: Any,
    ) -> bool:
        dispatch = _chat_dispatch.get()
        if (
            dispatch is None
            or not dispatch.qualified
            or dispatch.lease is not lease
            or dispatch.client is not self
            or dispatch.handler is not lease.generation.handler
            or lease.generation.handler_mode != "gguf_template"
            or not dispatch.completion_claimed
            or dispatch.formatter is None
        ):
            return False
        factory_permit = _completion_factory.get()
        active_record = _current_child.get()
        record_matches = False
        if active_record is not None:
            with lease._execution_lock:
                active_execution = bool(
                    lease._execution_stack
                    and lease._execution_stack[-1][0] == threading.get_ident()
                    and lease._execution_stack[-1][1] is active_record
                )
            if active_execution:
                current_record = active_record
                while current_record is not None:
                    if current_record.dispatch is dispatch:
                        record_matches = True
                        break
                    current_record = current_record.parent
        retained_criteria = dispatch.stopping_criteria is criteria
        selected_handler_frame = None
        claimed_handler_frame = dispatch.handler_frame
        if (
            wrapper_frame is not None
            and getattr(wrapper_frame, "f_back", None) is claimed_handler_frame
            and claimed_handler_frame is not None
            and claimed_handler_frame.f_code is lease.generation.handler_code
            and claimed_handler_frame.f_locals.get("llama") is self
        ):
            invocation_frame = claimed_handler_frame.f_back
            eager_binding = (
                invocation_frame is dispatch.chat_invocation_frame
                and invocation_frame is not None
                and invocation_frame.f_code is lease.generation.create_chat_completion_code
                and invocation_frame.f_locals.get("self") is self
                and invocation_frame.f_locals.get("handler") is dispatch.handler
                and invocation_frame.f_back is dispatch.wrapper_frame
                and invocation_frame.f_back.f_code is lease.generation.adapter_codes[3]
            )
            active_handler_record = (
                active_record is not None
                and active_record.dispatch is dispatch
                and active_record.iterator is dispatch.handler_iterator
                and getattr(dispatch.handler_iterator, "gi_frame", None) is claimed_handler_frame
            )
            if eager_binding or active_handler_record:
                selected_handler_frame = claimed_handler_frame
        completion_frame = wrapper_frame.f_back if wrapper_frame is not None else None
        factory_wrapper = completion_frame.f_back if completion_frame is not None else None
        retained_scope = (
            (
                factory_permit is not None
                and factory_permit.lease is lease
                and factory_permit.client is self
                and factory_permit.dispatch is dispatch
                and factory_permit.factory_frame is factory_wrapper
                and completion_frame is not None
                and completion_frame.f_code is lease.generation.create_completion_code
            )
            or record_matches
            or selected_handler_frame is not None
        )
        if not retained_scope:
            return False
        if not retained_criteria and selected_handler_frame is None:
            return False
        llama_module = lease.generation.backend_llama_module
        criteria_type = getattr(llama_module, "StoppingCriteriaList", None)
        if not isinstance(criteria_type, type) or type(criteria) is not criteria_type:
            return False
        try:
            if len(criteria) != 1:
                return False
        except BaseException:
            return False
        try:
            stop_callback = criteria[0]
        except BaseException:
            return False
        if not inspect.isfunction(stop_callback):
            return False
        try:
            callback_names = stop_callback.__code__.co_names
            callback_closure = stop_callback.__closure__ or ()
            if len(callback_names) > 512 or len(callback_closure) > 512:
                return False
            callback_state = (
                id(criteria),
                id(stop_callback),
                id(stop_callback.__code__),
                id(stop_callback.__globals__),
                tuple((name, id(stop_callback.__globals__.get(name))) for name in callback_names),
                tuple(id(cell.cell_contents) for cell in callback_closure),
            )
        except BaseException:
            return False
        formatter_type = type(dispatch.formatter)
        call = inspect.getattr_static(formatter_type, "__call__", None)
        call = getattr(call, "__func__", call)
        call_code = getattr(call, "__code__", None)
        expected_code = None
        if call_code is not None:
            pending = list(call_code.co_consts)
            if len(pending) > 512:
                return False
            inspected = 0
            while pending:
                inspected += 1
                if inspected > 512:
                    return False
                candidate = pending.pop()
                if inspect.iscode(candidate):
                    if candidate.co_name == "stop_on_last_token":
                        expected_code = candidate
                        break
                    if len(candidate.co_consts) > max(0, 512 - inspected):
                        return False
                    pending.extend(candidate.co_consts)
        closure = stop_callback.__closure__ or ()
        valid = (
            expected_code is not None
            and stop_callback.__code__ is expected_code
            and stop_callback.__globals__ is lease.generation.backend_format_module.__dict__
            and len(closure) == 1
            and closure[0].cell_contents is dispatch.formatter
            and getattr(dispatch.formatter, "stop_token_ids", None) is not None
            and (not retained_criteria or dispatch.stopping_criteria_state == callback_state)
        )
        if valid:
            dispatch.stopping_criteria = criteria
            dispatch.stopping_criteria_state = callback_state
        return valid

    def _validate_native_options(
        self: Any,
        method: Callable[..., Any],
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
        lease: NativeContextLease,
    ) -> None:
        """Reject per-call adapters and callbacks outside the pinned graph."""

        try:
            values = inspect.signature(method).bind_partial(self, *args, **kwargs).arguments
            client_state = object.__getattribute__(self, "__dict__")
        except BaseException:
            lease.mark_unknown("native_option_binding_unverified")
            raise NativeContextUnavailableError() from None
        try:
            wrapper_frame = sys._getframe(1)
        except (AttributeError, ValueError):
            wrapper_frame = None
        extra_options = values.get("kwargs", {})
        if type(extra_options) is dict:
            values = {**values, **extra_options}
        unsupported = (
            client_state.get("draft_model") is not None or not lease.generation.tokenizer_qualified
        )
        for name in (
            "draft_model",
            "tokenizer",
            "tokenizer_fn",
            "logits_processor",
            "stopping_criteria",
        ):
            value = values.get(name)
            if value is None:
                continue
            if name == "stopping_criteria" and _is_selected_jinja_stopping_criteria(
                self, lease, value, wrapper_frame
            ):
                continue
            if (
                name in ("logits_processor", "stopping_criteria")
                and type(value)
                in (
                    list,
                    tuple,
                )
                and not value
            ):
                continue
            unsupported = True
        if unsupported:
            lease.mark_unknown("native_option_binding_unverified")
            raise NativeContextUnavailableError()

    def generate(self: Any, *args: Any, **kwargs: Any) -> Any:
        if _cleanup_active.get():
            raise NativeContextUnavailableError()
        lease = _current_lease.get()
        owns = False
        if lease is None:
            lease = _lease(self)
            owns = lease is not None
        elif lease.generation.client is not self:
            raise NativeContextUnavailableError()
        if lease is None:
            return base.generate(self, *args, **kwargs)
        try:
            _reject_sync_entry_on_owned_loop(lease)
            lease.validate()
            _require_group_admission(lease)
            _validate_native_options(self, base.generate, args, kwargs, lease)
            parent = _current_child.get()
            try:
                caller_frame = sys._getframe(1)
            except (AttributeError, ValueError):
                caller_frame = None
            if lease.inference_seen and not (
                parent is not None
                and parent.lease is lease
                and parent.kind == "native_completion"
                and not parent.children
                and caller_frame is not None
                and caller_frame.f_code is lease.generation._create_completion_code
                and caller_frame.f_locals.get("self") is self
                and getattr(parent.iterator, "gi_frame", None) is caller_frame
            ):
                raise NativeContextUnavailableError()
            lease.begin_work()
        except BaseException:
            if owns:
                _release_rejected_unstarted_lease(lease)
            raise
        lease.inference_seen = True
        try:
            with lease.reserve_child() as reservation:
                marker = _current_lease.set(lease)
                try:
                    _note_direct_entry(self)
                    raw = base.generate(self, *args, **kwargs)
                    wrapped = _wrap_raw(
                        self, raw, lease, kind="token_generation", reservation=reservation
                    )
                finally:
                    _current_lease.reset(marker)
        except BaseException as error:
            if owns:
                _finish_sync(lease, primary=error)
            raise
        if owns:
            return _finish_on_iterator(wrapped, lease)
        return wrapped

    def _create_completion(self: Any, *args: Any, **kwargs: Any) -> Any:
        if _cleanup_active.get():
            raise NativeContextUnavailableError()
        lease = _current_lease.get()
        owns = lease is None
        if lease is None:
            lease = _lease(self)
        elif lease.generation.client is not self:
            raise NativeContextUnavailableError()
        if lease is None:
            return base._create_completion(self, *args, **kwargs)
        try:
            _reject_sync_entry_on_owned_loop(lease)
            # Reject copied request authority before option validation can
            # mutate the accepted operation's lease.
            _require_group_admission(lease)
            _validate_native_options(self, base._create_completion, args, kwargs, lease)
            factory_permit = _completion_factory.get()
            parent = _current_child.get()
            try:
                caller_frame = sys._getframe(1)
            except (AttributeError, ValueError):
                caller_frame = None
            factory_call = (
                factory_permit is not None
                and factory_permit.lease is lease
                and factory_permit.client is self
                and not factory_permit.consumed
                and caller_frame is not None
                and caller_frame.f_code is lease.generation.create_completion_code
                and caller_frame.f_locals.get("self") is self
                and caller_frame.f_back is factory_permit.factory_frame
                and (
                    factory_permit.dispatch is None
                    or (
                        factory_permit.dispatch is _chat_dispatch.get()
                        and factory_permit.dispatch.lease is lease
                        and factory_permit.dispatch.client is self
                        and factory_permit.dispatch.handler_frame is factory_permit.handler_frame
                    )
                )
            )
            direct_root = lease is not None and not lease.inference_seen and parent is None
            if not factory_call and not direct_root:
                raise NativeContextUnavailableError()
            lease.validate()
            _require_group_admission(lease)
            if factory_call:
                factory_permit.consumed = True
                factory_permit.completion_frame = caller_frame
            lease.begin_work()
        except BaseException:
            if owns:
                _release_rejected_unstarted_lease(lease)
            raise
        lease.inference_seen = True
        try:
            with lease.reserve_child() as reservation:
                marker = _current_lease.set(lease)
                try:
                    _note_direct_entry(self)
                    raw = base._create_completion(self, *args, **kwargs)
                    wrapped = _wrap_raw(
                        self, raw, lease, kind="native_completion", reservation=reservation
                    )
                finally:
                    _current_lease.reset(marker)
        except BaseException as error:
            if owns:
                _finish_sync(lease, primary=error)
            raise
        return _finish_on_iterator(wrapped, lease) if owns else wrapped

    def create_completion(self: Any, *args: Any, **kwargs: Any) -> Any:
        if _cleanup_active.get():
            raise NativeContextUnavailableError()
        stream = _stream_requested(base.create_completion, args, kwargs)
        lease = _current_lease.get()
        owns = lease is None
        if lease is None:
            lease = _lease(self)
        elif lease.generation.client is not self:
            raise NativeContextUnavailableError()
        if lease is None:
            return base.create_completion(self, *args, **kwargs)
        try:
            _reject_sync_entry_on_owned_loop(lease)
            lease.validate()
            _require_group_admission(lease)
            dispatch = _chat_dispatch.get()
            try:
                caller_frame = sys._getframe(1)
            except (AttributeError, ValueError):
                caller_frame = None
            authorized_chat_entry = (
                dispatch is not None
                and dispatch.lease is lease
                and dispatch.client is self
                and dispatch.handler is lease.generation.handler
                and caller_frame is not None
                and dispatch.claim_completion(caller_frame)
            )
            # The selected handler's exact invocation is claimed before its
            # pinned formatter criteria are validated, so generated Jinja
            # stopping criteria can be tied to that live handler frame.
            _validate_native_options(self, base.create_completion, args, kwargs, lease)
            if lease.inference_seen and not authorized_chat_entry:
                raise NativeContextUnavailableError()
            lease.begin_work()
        except BaseException:
            if owns:
                _release_rejected_unstarted_lease(lease)
            raise
        if authorized_chat_entry:
            lease.chat_handler_consumed = True
        lease.inference_seen = True
        permit = _CompletionPermit(
            lease,
            self,
            dispatch=dispatch if authorized_chat_entry else None,
            handler_frame=caller_frame if authorized_chat_entry else None,
            factory_frame=sys._getframe(),
        )
        if authorized_chat_entry and dispatch is not None:
            dispatch.completion_frame = caller_frame
        factory_marker = _completion_factory.set(permit)
        marker = _current_lease.set(lease)
        try:
            _note_direct_entry(self)
            result = base.create_completion(self, *args, **kwargs)
        except BaseException as error:
            if owns:
                _finish_sync(lease, primary=error)
            raise
        finally:
            _current_lease.reset(marker)
            _completion_factory.reset(factory_marker)
            permit.factory_frame = None
        if stream and hasattr(result, "__next__"):
            # The pinned _create_completion wrapper has already registered
            # this exact child. Wrapping it here would insert a fictitious
            # iterator layer between native completion and chat conversion.
            if isinstance(result, _OwnedIterator) and result._record.lease is lease:
                wrapped = result
            else:
                lease.mark_unknown("native_completion_iterator_untracked")
                wrapped = result
            return _finish_on_iterator(wrapped, lease) if owns else wrapped
        if not stream and hasattr(result, "__next__"):
            lease.mark_unknown("native_completion_iterator_untracked")
            if owns:
                _finish_sync(lease)
            return result
        if not stream and not lease.opaque_handler:
            lease.cache_tail_completed = True
        if owns:
            _finish_sync(lease)
        return result

    def create_chat_completion(self: Any, *args: Any, **kwargs: Any) -> Any:
        if _cleanup_active.get():
            raise NativeContextUnavailableError()
        stream = _stream_requested(base.create_chat_completion, args, kwargs)
        lease = _current_lease.get()
        owns = lease is None
        if lease is None:
            lease = _lease(self)
        elif lease.generation.client is not self:
            raise NativeContextUnavailableError()
        if lease is None:
            return base.create_chat_completion(self, *args, **kwargs)
        try:
            _reject_sync_entry_on_owned_loop(lease)
            # Reject copied request authority before option validation can
            # mutate the accepted operation's lease.
            _require_group_admission(lease)
            _validate_native_options(self, base.create_chat_completion, args, kwargs, lease)
            lease.validate()
            if lease.inference_seen:
                raise NativeContextUnavailableError()
            handler, qualified = generation_for(self).selected_handler()
            if not qualified:
                # Do not execute an adapter whose complete ownership graph is
                # not pinned. Preserve the first bounded reason for the group.
                lease._abandon_unknown("native_handler_unqualified")
                raise NativeContextUnavailableError() from None
            lease.begin_work()
        except BaseException:
            if owns:
                if lease.unknown:
                    _finish_sync(lease)
                else:
                    _release_rejected_unstarted_lease(lease)
            raise
        lease.inference_seen = True
        dispatch = _ChatDispatch(
            lease=lease,
            client=self,
            handler=handler,
            member=lease.request_member,
            formatter=(
                _handler_factory_parts(handler, lease.generation.backend_format_module)
                or (None, None)
            )[0],
            qualified=qualified,
        )
        try:
            dispatch.wrapper_frame = sys._getframe()
        except (AttributeError, ValueError):
            lease.mark_unknown("native_chat_frame_unavailable")
            if owns:
                _finish_sync(lease)
            raise NativeContextUnavailableError() from None
        try:
            with lease.reserve_child() as reservation:
                marker = _current_lease.set(lease)
                dispatch_marker = _chat_dispatch.set(dispatch)
                try:
                    _note_direct_entry(self)
                    result = base.create_chat_completion(self, *args, **kwargs)
                    dispatch.handler_iterator = result
                    if stream and hasattr(result, "__next__"):
                        wrapped = _wrap_raw(
                            self, result, lease, kind="chat_completion", reservation=reservation
                        )
                        if isinstance(wrapped, _OwnedIterator):
                            wrapped._record.dispatch = dispatch
                            dispatch.handler_record = wrapped._record
                        _link_chat_children(lease, wrapped, dispatch.children)
                    else:
                        wrapped = result
                finally:
                    dispatch.handler_frame = None
                    dispatch.completion_frame = None
                    _chat_dispatch.reset(dispatch_marker)
                    _current_lease.reset(marker)
        except BaseException as error:
            if owns:
                _finish_sync(lease, primary=error)
            raise
        if stream and hasattr(result, "__next__"):
            return _finish_on_iterator(wrapped, lease) if owns else wrapped
        if not stream and hasattr(result, "__next__"):
            lease.mark_unknown("native_completion_iterator_untracked")
            if owns:
                _finish_sync(lease)
            return result
        if not stream and not lease.opaque_handler:
            lease.cache_tail_completed = True
        if owns:
            _finish_sync(lease)
        dispatch.wrapper_frame = None
        return result

    def eval(self: Any, *args: Any, **kwargs: Any) -> Any:
        if _cleanup_active.get():
            raise NativeContextUnavailableError()
        lease = _current_lease.get()
        parent = _current_child.get()
        if lease is not None:
            if lease.generation.client is not self:
                raise NativeContextUnavailableError()
            _reject_sync_entry_on_owned_loop(lease)
            lease.validate()
            _require_group_admission(lease)
            try:
                caller_frame = sys._getframe(1)
            except (AttributeError, ValueError):
                caller_frame = None
            allowed = (
                parent is not None
                and parent.lease is lease
                and parent.kind == "token_generation"
                and caller_frame is not None
                and caller_frame.f_code is lease.generation.generate_code
                and caller_frame.f_locals.get("self") is self
                and getattr(parent.iterator, "gi_frame", None) is caller_frame
            )
            if not allowed:
                raise NativeContextUnavailableError()
            _note_direct_entry(self)
            return base.eval(self, *args, **kwargs)
        generation = _get_generation(self)
        if generation is None:
            if getattr(type(self), "_aurora_owned_base", None) is base:
                raise NativeContextUnavailableError()
            return base.eval(self, *args, **kwargs)
        lease = _lease(self)
        if lease is None:
            if getattr(type(self), "_aurora_owned_base", None) is base:
                raise NativeContextUnavailableError()
            return base.eval(self, *args, **kwargs)
        try:
            _reject_sync_entry_on_owned_loop(lease)
            lease.validate()
            _require_group_admission(lease)
            lease.begin_work()
        except BaseException:
            _release_rejected_unstarted_lease(lease)
            raise
        lease.inference_seen = True
        primary: BaseException | None = None
        try:
            _note_direct_entry(self)
            return base.eval(self, *args, **kwargs)
        except BaseException as error:
            primary = error
            raise
        finally:
            try:
                lease.finish_sync()
            except BaseException:
                lease._abandon_unknown("native_eval_completion_unknown")
                if primary is None:
                    raise NativeContextUnavailableError() from None
            if (lease.unknown or lease.opaque_handler) and primary is None:
                raise NativeContextUnavailableError() from None

    def close(self: Any, *args: Any, **kwargs: Any) -> Any:
        generation = _get_generation(self)
        if generation is None:
            if getattr(self, "_aurora_native_registration_failed", False):
                if not close_failed_construction(self):
                    raise NativeContextUnavailableError() from None
                return None
            if getattr(type(self), "_aurora_owned_base", None) is base:
                raise NativeContextUnavailableError() from None
            return base_close(self, *args, **kwargs)
        from app.services.orchestrator.native_worker import (
            mark_retirement_close_body_entry,
            retirement_close_is_authorized,
        )

        if retirement_close_binding(self) is not close or not retirement_close_is_authorized(self):
            raise NativeContextUnavailableError()
        if not mark_retirement_close_body_entry(self):
            raise NativeContextUnavailableError()
        return base_close(self, *args, **kwargs)

    namespace = {
        "__init__": owned_init,
        "generate": generate,
        "_create_completion": _create_completion,
        "create_completion": create_completion,
        "create_chat_completion": create_chat_completion,
        "eval": eval,
        "close": close,
        "__module__": base.__module__,
        "__qualname__": f"AuroraOwned{base.__name__}",
        "_aurora_owned_base": base,
        "_aurora_base_init": base_init,
        "_aurora_base_init_code": base_init_code,
        "_aurora_base_init_provenance": base_init_provenance,
    }

    def guarded_native_entry(name: str, method: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(method)
        def guarded(self: Any, *args: Any, **kwargs: Any) -> Any:
            if _cleanup_active.get():
                raise NativeContextUnavailableError()
            lease = _current_lease.get()
            if lease is None or lease.generation.client is not self:
                generation = _get_generation(self)
                if generation is not None:
                    generation.quarantine("native_entry_without_owned_context")
                try:
                    from app.services.orchestrator.native_request_completion import (
                        mark_current_native_completion,
                    )

                    mark_current_native_completion(
                        known=False, reason="native_entry_without_owned_context"
                    )
                except BaseException:
                    pass
                raise NativeContextUnavailableError()
            _reject_sync_entry_on_owned_loop(lease)
            lease.validate()
            _require_group_admission(lease)
            parent = _current_child.get()
            try:
                caller_frame = sys._getframe().f_back
            except (AttributeError, ValueError):
                caller_frame = None
            dispatch = _chat_dispatch.get()
            if (
                name == "tokenize"
                and dispatch is not None
                and dispatch.qualified
                and dispatch.lease is lease
                and dispatch.client is self
                and dispatch.handler is lease.generation.handler
                and _active_selected_handler_frame(self, lease, caller_frame) is not None
            ):
                _note_direct_entry(self)
                return method(self, *args, **kwargs)
            caller_codes = (
                lease.generation.generate_code,
                lease.generation._create_completion_code,
            )
            if (
                parent is None
                or parent.lease is not lease
                or parent.kind not in ("token_generation", "native_completion")
                or caller_frame is None
                or caller_frame.f_code not in caller_codes
                or caller_frame.f_locals.get("self") is not self
                or getattr(parent.iterator, "gi_frame", None) is not caller_frame
            ):
                lease.mark_unknown("native_entry_structure_unverified")
                raise NativeContextUnavailableError()
            _note_direct_entry(self)
            return method(self, *args, **kwargs)

        return guarded

    for native_method_name in (
        "sample",
        "tokenize",
        "detokenize",
        "reset",
        "set_seed",
        "load_state",
        "save_state",
        "embed",
        "create_embedding",
    ):
        native_method = getattr(base, native_method_name, None)
        if callable(native_method):
            namespace[native_method_name] = guarded_native_entry(native_method_name, native_method)

    return type(f"AuroraOwned{base.__name__}", (base,), namespace)


def _finish_on_iterator(iterator: Any, lease: NativeContextLease) -> Any:
    return _LeaseFinalizingIterator(iterator, lease)


class _LeaseFinalizingIterator:
    def __init__(self, iterator: Any, lease: NativeContextLease) -> None:
        self.iterator = iterator
        self.lease = lease
        self.closed = False
        self._finish_lock = threading.RLock()
        self._finish_complete = threading.Event()
        self._finish_started = False
        self._finish_failed = False
        self._finish_thread: int | None = None
        self._close_started = False
        self._close_thread: int | None = None

    def __iter__(self) -> _LeaseFinalizingIterator:
        return self

    def __next__(self) -> Any:
        return self._advance("__next__")

    def send(self, value: Any) -> Any:
        return self._advance("send", value)

    def throw(self, *args: Any) -> Any:
        return self._advance("throw", *args)

    def _advance(self, name: str, *args: Any) -> Any:
        if self.closed:
            raise StopIteration
        _reject_sync_entry_on_owned_loop(self.lease)
        member = self.lease.request_member
        group = member.group if member is not None else None
        member_scope = (
            bind_request_member(self.lease.request_member)
            if self.lease.request_member is not None
            else nullcontext()
        )
        marker = _current_lease.set(self.lease)
        exhausted = False
        primary_error: BaseException | None = None
        try:
            with member_scope:
                self.lease.validate()
                value = getattr(self.iterator, name)(*args)
        except StopIteration:
            exhausted = True
            raise
        except BaseException as error:
            primary_error = error
            raise
        finally:
            if exhausted:
                if self.lease.cache_tail_completed is None:
                    self.lease.cache_tail_completed = True
            elif group is not None and group.is_stopping:
                self.lease.stopped = True
                if self.lease.cache_tail_completed is None:
                    self.lease.cache_tail_completed = False
            _current_lease.reset(marker)
            if exhausted or primary_error is not None:
                self._finish(primary=primary_error)
        return value

    def close(self) -> None:
        # A duplicate close can wait for the first finalizer. Never perform
        # that synchronous wait on any running event loop, including when this
        # wrapper has already marked itself closed.
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None
        thread_id = threading.get_ident()
        with self._finish_lock:
            close_already_owned = (
                self._close_started or self._finish_started or self._finish_complete.is_set()
            )
            if close_already_owned:
                if current_loop is not None or self._close_thread == thread_id:
                    # Reject this observer without poisoning or duplicating a
                    # close already owned by another call.
                    raise NativeContextUnavailableError() from None
                wait_for_close = True
            else:
                # Claim before resolving or invoking the raw close callback.
                # A loop-thread duplicate can otherwise arrive during a
                # blocked callback, fail the generic sync-loop guard, and
                # poison the first legitimate finalizer.
                _reject_sync_entry_on_owned_loop(self.lease)
                self._close_started = True
                self._close_thread = thread_id
                wait_for_close = False
        if wait_for_close:
            self._finish_complete.wait()
            if self._finish_failed:
                raise NativeContextUnavailableError() from None
            return
        if self.closed:
            try:
                self._finish()
            finally:
                with self._finish_lock:
                    self._close_thread = None
            return
        marker = _current_lease.set(self.lease)
        close_error: BaseException | None = None
        try:
            close = getattr(self.iterator, "close", None)
            if callable(close):
                close()
        except BaseException as error:
            close_error = error
        finally:
            _current_lease.reset(marker)
            self.lease.stopped = True
            if self.lease.cache_tail_completed is None:
                self.lease.cache_tail_completed = False
            try:
                self._finish(primary=close_error)
            finally:
                with self._finish_lock:
                    self._close_thread = None
        if close_error is not None:
            raise NativeContextUnavailableError() from None

    def _finish(self, *, primary: BaseException | None = None) -> None:
        with self._finish_lock:
            if self._finish_complete.is_set():
                if self._finish_failed and primary is None:
                    raise NativeContextUnavailableError() from None
                return
            if self._finish_started:
                try:
                    current_loop = asyncio.get_running_loop()
                except RuntimeError:
                    current_loop = None
                if self._finish_thread == threading.get_ident() or (
                    current_loop is self.lease.loop and self.lease.loop is not None
                ):
                    raise NativeContextUnavailableError()
                self._finish_complete.wait()
                if self._finish_failed and primary is None:
                    raise NativeContextUnavailableError() from None
                return
            self._finish_started = True
            self._finish_thread = threading.get_ident()
            self.closed = True
        try:
            try:
                member_scope = (
                    bind_request_member(self.lease.request_member)
                    if self.lease.request_member is not None
                    else nullcontext()
                )
                with member_scope:
                    self.lease.finish_sync(stopped=self.lease.stopped)
            except BaseException:
                self._finish_failed = True
                self.lease._abandon_unknown("native_completion_unknown")
            if self.lease.unknown:
                self._finish_failed = True
            if self._finish_failed and primary is None:
                raise NativeContextUnavailableError() from None
        finally:
            self._finish_thread = None
            self._finish_complete.set()


def _finish_sync(lease: NativeContextLease, *, primary: BaseException | None = None) -> None:
    try:
        lease.finish_sync()
    except BaseException:
        lease._abandon_unknown("native_completion_unknown")
    if lease.unknown and primary is None:
        raise NativeContextUnavailableError() from None


@contextmanager
def _bind_lease(lease: NativeContextLease) -> Iterator[NativeContextLease]:
    lease.validate()
    marker = _current_lease.set(lease)
    try:
        yield lease
    finally:
        _current_lease.reset(marker)


@contextmanager
def bind_native_lease(lease: NativeContextLease) -> Iterator[NativeContextLease]:
    """Bind an existing physical lease only inside its owned producer task."""

    current = _current_lease.get()
    if current is not None and current is not lease:
        raise NativeContextUnavailableError()
    lease.validate()
    marker = _current_lease.set(lease)
    try:
        yield lease
    finally:
        _current_lease.reset(marker)


@contextmanager
def bind_native_cleanup_lease(
    lease: NativeContextLease,
) -> Iterator[NativeContextLease]:
    """Bind only an already-admitted iterator cleanup operation."""

    current = _current_lease.get()
    if current is not None and current is not lease:
        raise NativeContextUnavailableError()
    cleanup_marker = _cleanup_active.set(True)
    lease_marker = _current_lease.set(lease)
    try:
        if not lease.active or not lease.started or lease.unknown:
            raise NativeContextUnavailableError()
        # Cleanup authority is narrower than inference authority, but it must
        # still revalidate the exact gate, generation, handler, and criteria
        # bindings before invoking the retained native child.
        lease.validate()
        yield lease
    finally:
        _current_lease.reset(lease_marker)
        _cleanup_active.reset(cleanup_marker)


@asynccontextmanager
async def native_context(
    provider: Any,
    *,
    _request_member: Any = _MISSING,
    _progress_reservation: Any = None,
    _activate: bool = True,
):
    """Hold a known context lease across a complete async inference lifetime."""
    from app.services.orchestrator.native_request_completion import (
        finish_request_member,
        mark_current_native_completion,
        request_member_scope,
    )

    if _request_member is _MISSING and _activate:
        member_scope = request_member_scope("native_context", resource=provider)
    elif _request_member is _MISSING:
        from app.services.orchestrator.native_request_completion import (
            admit_request_member,
        )

        admitted_member, admitted_owned = admit_request_member("native_context", resource=provider)
        member_scope = nullcontext((admitted_member, admitted_owned))
    else:
        member_scope = nullcontext((_request_member, False))
    with member_scope as (member, owned):
        generation = generation_for(provider)
        if generation is None:
            mark_current_native_completion(known=False, reason="native_adapter_unqualified")
            try:
                yield None
            finally:
                finish_request_member(member, owned=owned, reason="native_adapter_unqualified")
            return
        group = member.group if member is not None else None
        lease = await generation._gate.acquire_async(generation, group, member)
        lease.request_member = member
        lease.opaque_handler = not generation.qualified
        try:
            from app.services.orchestrator.native_worker import (
                MAX_CONTEXT_CLEANUP_CREDITS,
                ensure_provider_cleanup_progress,
                reserve_provider_progress,
                validate_provider_progress,
            )

            lease.progress_reservation = (
                _progress_reservation
                if _progress_reservation is not None
                else reserve_provider_progress(
                    generation.client,
                    asyncio.get_running_loop(),
                    cleanup_slots=MAX_CONTEXT_CLEANUP_CREDITS,
                )
            )
            if (
                lease.progress_reservation is None
                or not ensure_provider_cleanup_progress(
                    lease.progress_reservation,
                    generation.client,
                    MAX_CONTEXT_CLEANUP_CREDITS,
                )
                or not validate_provider_progress(lease.progress_reservation, generation.client)
            ):
                raise NativeContextUnavailableError()
            lease.progress_reservation.context_lease = lease
            # The owner may have been retired between gate admission and
            # progress-credit reservation. Recheck before yielding the lease.
            lease.validate()
        except BaseException:
            # Validation may have established that the admitted generation is
            # already uncertain (for example, a constructor-pinned option
            # changed before the first native call). Preserve that result
            # instead of rewriting it as clean non-submission.
            _release_rejected_unstarted_lease(lease)
            raise NativeContextUnavailableError() from None
        marker = _current_lease.set(lease) if _activate else None
        error: BaseException | None = None
        stopped = False
        reason = None
        finish_cancelled = False
        runner_cancelled = False
        try:
            yield lease
        except asyncio.CancelledError as caught:
            error = caught
            stopped = True
            raise
        except BaseException as caught:
            error = caught
            raise
        finally:
            if marker is not None:
                _current_lease.reset(marker)
            if lease.active and not lease.inference_seen:
                # A context may be admitted and then stopped before any native
                # method starts. A generic synchronous callable can still have
                # started the retained worker runner, so join that actual worker
                # before recording non-submission or releasing the context gate.
                try:
                    from app.services.orchestrator.native_worker import (
                        _stop_native_runner,
                    )

                    if lease.progress_reservation is not None:
                        joined, runner_cancelled = await _stop_native_runner(
                            lease.progress_reservation
                        )
                        if not joined:
                            raise NativeContextUnavailableError()
                    if lease.unknown:
                        # An earlier option/provenance failure is authoritative;
                        # the no-entry finalizer must not rewrite it as a clean
                        # non-submission or release the physical gate.
                        reason = lease.reason or "native_completion_unknown"
                        lease._record_group_completion(known=False, reason=reason)
                    elif lease.callable_attempted:
                        # The callable ran, but no qualified native entry
                        # established what work it may have performed. Keep
                        # the physical generation quarantined and report the
                        # request result as unknown.
                        reason = "native_entry_unverified"
                        lease._abandon_unknown(reason)
                        lease._record_group_completion(known=False, reason=reason)
                    else:
                        _mark_member_not_submitted(member)
                        lease.started = False
                        lease.release_unstarted()
                except BaseException:
                    reason = lease.reason or "native_runner_settlement_unknown"
                    lease._abandon_unknown(reason)
                    lease._record_group_completion(known=False, reason=reason)
                    if error is None:
                        raise NativeContextUnavailableError() from None
            elif lease.active:
                try:
                    from app.services.orchestrator.native_worker import _run_native_internal

                    finish_marker = _current_lease.set(lease)
                    try:
                        finish_result = await _run_native_internal(
                            generation.client,
                            _finish_lease_on_worker,
                            (lease, stopped),
                            {},
                            retirement_internal=True,
                            preserve_result_after_cancel=True,
                            request_member=lease.request_member,
                        )
                        finish_cancelled = finish_result.cancelled
                    finally:
                        _current_lease.reset(finish_marker)
                    from app.services.orchestrator.native_worker import _stop_native_runner

                    joined, runner_cancelled = await _stop_native_runner(lease.progress_reservation)
                    if not joined:
                        raise NativeContextUnavailableError()
                    lease.release_after_checked_finish()
                except BaseException:
                    lease._abandon_unknown("native_context_finish_unknown")
                    reason = "native_context_finish_unknown"
                    lease._record_group_completion(known=False, reason=reason)
                    # A callback can fail after its synchronous command has
                    # conclusively returned. Retire that known-idle runner
                    # without releasing the quarantined physical lease. If a
                    # command or its executor handoff is still uncertain,
                    # _stop_native_runner refuses to join/release it.
                    try:
                        from app.services.orchestrator.native_worker import (
                            _stop_native_runner,
                        )

                        runner_result = await _stop_native_runner(lease.progress_reservation)
                        runner_cancelled = runner_cancelled or runner_result[1]
                    except BaseException:
                        pass
                    if error is None:
                        raise NativeContextUnavailableError() from None
            finish_request_member(member, owned=owned, reason=reason, stopped=stopped)
            if error is None and (finish_cancelled or runner_cancelled):
                raise asyncio.CancelledError


def _finish_lease_on_worker(lease: NativeContextLease, stopped: bool) -> None:
    lease.finish_sync(stopped=stopped, release_gate=False)
    if lease.unknown:
        raise NativeContextUnavailableError()

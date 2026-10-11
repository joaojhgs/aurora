"""Request-scoped native completion binding at the Orchestrator boundary."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.messaging import Envelope, MessageBus
from app.services.orchestrator.service import OrchestratorService
from app.shared.contracts.models.orchestrator import (
    OrchestratorInterruptRequest,
    OrchestratorMethods,
    OrchestratorProcessRequest,
)
from app.shared.contracts.models.tts import TTSMethods, TTSStopRequest, TTSStreamStartRequest


@pytest.fixture
def service(monkeypatch):
    bus = Mock(spec=MessageBus)
    bus.publish = AsyncMock()
    bus.request = AsyncMock(return_value=SimpleNamespace(ok=True))
    bus.subscribe = Mock()
    bus.subscribe_event = AsyncMock()
    monkeypatch.setattr("app.shared.services.base_service.get_bus_singleton", lambda: bus)
    instance = OrchestratorService()

    async def prepare_chat_session(**kwargs):
        return (
            kwargs["session_id"] or "resolved-session",
            kwargs["caller_principal_id"] or "local-session-owner",
            False,
        )

    monkeypatch.setattr(instance, "_resolve_inference_override", AsyncMock(return_value=None))
    monkeypatch.setattr(instance, "_prepare_chat_session", prepare_chat_session)
    monkeypatch.setattr(instance, "_assistant_response_metadata", AsyncMock(return_value={}))
    monkeypatch.setattr(instance, "_request_response_tts", AsyncMock())
    monkeypatch.setattr(instance, "_publish_assistant_stream_event", AsyncMock())
    instance._ui_automatic_tts_readback = False
    return instance


def _external_envelope(request, *, principal_id, peer_id):
    return Envelope(
        type=OrchestratorMethods.EXTERNAL_USER_INPUT,
        payload=request,
        origin="external",
        principal_id=principal_id,
        caller_peer_id=peer_id,
        effective_perms=["Orchestrator.use"],
        identity_source="gateway_http",
    )


@pytest.mark.asyncio
async def test_streamed_external_request_binds_trusted_identity_through_graph(service):
    from app.services.orchestrator.native_request_completion import current_request_group

    observed_groups = []

    class Graph:
        async def stream_graph_events(self, *_args, **_kwargs):
            group = current_request_group()
            assert group is not None
            observed_groups.append(group)
            yield SimpleNamespace(kind="assistant.delta", delta="Hello", text=None, metadata={})
            yield SimpleNamespace(kind="assistant.completed", delta="", text="Hello", metadata={})

    service.orchestrator = Graph()
    request = OrchestratorProcessRequest(
        text="Say hello",
        session_id="session-shared",
        request_id="request-shared",
        correlation_id="correlation-1",
        stream=True,
    )

    response = await service.process_external_input(
        request,
        envelope=_external_envelope(request, principal_id="principal-1", peer_id="peer-1"),
    )

    assert response.text == "Hello"
    assert len(observed_groups) == 1
    group = observed_groups[0]
    assert group.binding.principal == "principal-1"
    assert group.binding.peer == "peer-1"
    assert group.binding.session_id == "session-shared"
    assert group.binding.request_id != "request-shared"
    assert group.binding.execution_generation == service._native_execution_generation
    assert not group.is_open


@pytest.mark.asyncio
async def test_cancelled_request_does_not_cancel_caller_reusing_session_and_request_ids(service):
    from app.services.orchestrator.native_request_completion import current_request_group

    first_entered = asyncio.Event()
    second_entered = asyncio.Event()
    release_second = asyncio.Event()
    groups = {}

    class Graph:
        async def stream_graph_updates(self, *_args, **kwargs):
            group = current_request_group()
            assert group is not None
            principal = group.binding.principal
            groups[principal] = group
            if principal == "principal-a":
                first_entered.set()
                await asyncio.Event().wait()
            second_entered.set()
            await release_second.wait()
            return "answer for caller b"

    service.orchestrator = Graph()
    request = OrchestratorProcessRequest(
        text="Shared identifiers",
        session_id="reused-session",
        request_id="reused-request",
        correlation_id="reused-correlation",
    )

    first = asyncio.create_task(
        service.process_external_input(
            request,
            envelope=_external_envelope(request, principal_id="principal-a", peer_id="peer-a"),
        )
    )
    second = None
    try:
        await asyncio.wait_for(first_entered.wait(), timeout=1)
        second = asyncio.create_task(
            service.process_external_input(
                request,
                envelope=_external_envelope(request, principal_id="principal-b", peer_id="peer-b"),
            )
        )
        await asyncio.wait_for(second_entered.wait(), timeout=1)

        interrupt_response = await service.interrupt_assistant(
            OrchestratorInterruptRequest(scopes=["session"], session_id="reused-session"),
            envelope=_external_envelope(request, principal_id="principal-a", peer_id="peer-a"),
        )
        assert interrupt_response.status == "interrupted"
        first_response = await asyncio.wait_for(first, timeout=1)
        assert first_response.text == "Interrupted"
        assert not second.done()
        assert groups["principal-a"] is not groups["principal-b"]
        assert groups["principal-a"].binding.request_id != groups["principal-b"].binding.request_id

        release_second.set()
        second_response = await asyncio.wait_for(second, timeout=1)
        assert second_response.text == "answer for caller b"
        assert not groups["principal-b"].is_open
    finally:
        release_second.set()
        tasks = [task for task in (first, second) if task is not None]
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            _, pending = await asyncio.wait(tasks, timeout=2)
            assert not pending


@pytest.mark.asyncio
async def test_graph_primary_failure_is_preserved_as_safe_user_text_and_group_is_finalized(service):
    from app.services.orchestrator.native_request_completion import current_request_group

    observed_groups = []

    class Graph:
        async def stream_graph_updates(self, *_args, **_kwargs):
            group = current_request_group()
            assert group is not None
            observed_groups.append(group)
            raise RuntimeError("private backend path")

    service.orchestrator = Graph()
    request = OrchestratorProcessRequest(
        text="Cause failure",
        session_id="failure-session",
        request_id="failure-request",
    )
    response = await service.process_external_input(
        request,
        envelope=_external_envelope(request, principal_id="principal-f", peer_id="peer-f"),
    )

    assert response.text == "Error: Aurora could not complete this request."
    assert "private backend path" not in response.text
    assert len(observed_groups) == 1
    assert not observed_groups[0].is_open


@pytest.mark.asyncio
async def test_admitted_uncertain_native_work_is_not_reported_as_success(service):
    from app.services.orchestrator.native_request_completion import current_request_group

    observed_groups = []

    class Graph:
        async def stream_graph_updates(self, *_args, **_kwargs):
            group = current_request_group()
            assert group is not None
            observed_groups.append(group)
            member = group.admit("local-native")
            group.mark_native_work(member, known=False)
            group.settle(
                member,
                native_status="unknown",
                reason="native_completion_unverified",
            )
            return "uncertain answer must not be reported"

    service.orchestrator = Graph()
    request = OrchestratorProcessRequest(
        text="Cause an uncertain result",
        session_id="uncertain-session",
        request_id="uncertain-request",
    )
    response = await service.process_external_input(
        request,
        envelope=_external_envelope(request, principal_id="principal-u", peer_id="peer-u"),
    )

    assert response.text == "Error: Aurora could not complete this request."
    assert "uncertain answer" not in response.text
    assert len(observed_groups) == 1
    assert observed_groups[0].has_admitted_work
    assert not observed_groups[0].is_open


@pytest.mark.asyncio
async def test_streamed_uncertain_work_never_publishes_success_terminal(service, monkeypatch):
    from app.services.orchestrator import service as service_module
    from app.services.orchestrator.native_request_completion import current_request_group

    published = []
    monkeypatch.setattr(
        service_module,
        "get_contract",
        lambda method: object() if method == TTSMethods.STREAM_START else None,
    )
    service._tts_stream_is_ready = AsyncMock(return_value=True)

    async def capture_stream_event(event, **_kwargs):
        published.append(event.kind)

    service._publish_assistant_stream_event = capture_stream_event

    class Graph:
        async def stream_graph_events(self, *_args, **_kwargs):
            group = current_request_group()
            assert group is not None
            member = group.admit("local-native")
            yield SimpleNamespace(kind="assistant.delta", delta="Partial", text=None, metadata={})
            yield SimpleNamespace(kind="assistant.completed", delta="", text="Partial", metadata={})
            group.mark_native_work(member, known=False)
            group.settle(
                member,
                native_status="unknown",
                reason="native_completion_unverified",
            )

    service.orchestrator = Graph()
    request = OrchestratorProcessRequest(
        text="Stream an uncertain response",
        session_id="uncertain-stream-session",
        request_id="uncertain-stream-request",
        correlation_id="uncertain-stream-correlation",
        stream=True,
        client_tts_playback=True,
    )
    response = await service.process_external_input(
        request,
        envelope=_external_envelope(request, principal_id="principal-s", peer_id="peer-s"),
    )

    assert response.text == "Error: Aurora could not complete this request."
    assert "assistant.delta" in published
    assert "assistant.completed" not in published
    assert "assistant.failed" in published
    starts = [
        call.args[1]
        for call in service.bus.publish.call_args_list
        if call.args and call.args[0] == TTSMethods.STREAM_START
    ]
    assert len(starts) == 1
    assert isinstance(starts[0], TTSStreamStartRequest)
    stops = [
        call
        for call in service.bus.request.call_args_list
        if call.args and call.args[0] == TTSMethods.STOP
    ]
    assert len(stops) == 1
    stop_request = stops[0].args[1]
    assert isinstance(stop_request, TTSStopRequest)
    assert stop_request.stream_id == starts[0].stream_id
    assert stop_request.correlation_id == "uncertain-stream-correlation"
    assert stop_request.reason == "canceled"
    assert stops[0].kwargs["principal_id"] == "principal-s"
    assert stops[0].kwargs["caller_peer_id"] == "peer-s"
    assert not any(
        call.args and call.args[0] == TTSMethods.STREAM_END
        for call in service.bus.publish.call_args_list
    )


@pytest.mark.asyncio
async def test_external_payload_cannot_claim_local_native_request_identity(service):
    class Graph:
        async def stream_graph_updates(self, *_args, **_kwargs):
            raise AssertionError("unowned external request must not enter the graph")

    service.orchestrator = Graph()
    request = OrchestratorProcessRequest(
        text="Do not trust caller source",
        source="ui",
        session_id="caller-session",
        request_id="caller-request",
    )

    response = await service.process_external_input(request)

    assert response.text == "Error: Aurora could not complete this request."


@pytest.mark.asyncio
async def test_local_ui_request_uses_server_owned_native_identity(service):
    from app.services.orchestrator.native_request_completion import current_request_group

    observed = []
    entered = asyncio.Event()

    class Graph:
        async def stream_graph_updates(self, *_args, **_kwargs):
            group = current_request_group()
            assert group is not None
            observed.append(group)
            entered.set()
            await asyncio.Event().wait()

    service.orchestrator = Graph()
    request = OrchestratorProcessRequest(
        text="Local request",
        session_id="session-local",
        request_id="payload-request",
    )
    task = asyncio.create_task(service.process_user_input(request))
    try:
        await asyncio.wait_for(entered.wait(), timeout=1)
        interrupt = OrchestratorInterruptRequest(scopes=["session"], session_id="session-local")
        response = await service.interrupt_assistant(
            interrupt,
            envelope=Envelope(
                type=OrchestratorMethods.INTERRUPT,
                payload=interrupt,
                origin="internal",
            ),
        )
        assert response.status == "interrupted"
        assert response.results[0].cancelled_count == 1
        await asyncio.wait_for(task, timeout=1)
    finally:
        if not task.done():
            task.cancel()
        _, pending = await asyncio.wait((task,), timeout=1)
        assert not pending

    assert len(observed) == 1
    assert observed[0].binding.principal.startswith("local-orchestrator-")
    assert observed[0].binding.request_id != "payload-request"
    assert not observed[0].is_open

    preparation_entered = asyncio.Event()

    async def blocked_chat_session(**kwargs):
        preparation_entered.set()
        await asyncio.Event().wait()

    service._prepare_chat_session = blocked_chat_session
    preparing_request = OrchestratorProcessRequest(
        text="Stop during preparation",
        session_id="session-preparing",
        request_id="preparing-payload-request",
    )
    preparing_task = asyncio.create_task(service.process_user_input(preparing_request))
    try:
        await asyncio.wait_for(preparation_entered.wait(), timeout=1)
        preparation_interrupt = OrchestratorInterruptRequest(
            scopes=["session"], session_id="session-preparing"
        )
        preparation_response = await service.interrupt_assistant(
            preparation_interrupt,
            envelope=Envelope(
                type=OrchestratorMethods.INTERRUPT,
                payload=preparation_interrupt,
                origin="internal",
            ),
        )
        assert preparation_response.status == "interrupted"
        assert preparation_response.results[0].cancelled_count == 1
        await asyncio.wait_for(preparing_task, timeout=1)
    finally:
        if not preparing_task.done():
            preparing_task.cancel()
        _, pending = await asyncio.wait((preparing_task,), timeout=1)
        assert not pending

    assert len(observed) == 1

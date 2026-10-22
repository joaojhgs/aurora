"""Content-free observations of actual successful LocalBus command enqueue.

Original arguments, dispatch, permissions, retry and return values are unchanged.
Before/after timestamps bound enqueue completion; no exact dequeue is invented.
"""

from pathlib import Path
import json
import time


def install(bus, output):
    from app.shared.contracts.models.stt import TranscriptionMethods
    from app.shared.contracts.models.orchestrator import OrchestratorMethods
    from app.shared.contracts.models.tts import TTSMethods

    watched = {
        TranscriptionMethods.TRANSCRIBE,
        OrchestratorMethods.USER_INPUT,
        OrchestratorMethods.EXTERNAL_USER_INPUT,
        TTSMethods.SYNTHESIZE,
    }
    wrappers = []
    seen = set()
    while hasattr(bus, "_inner"):
        assert id(bus) not in seen, "Unexpected cyclic bus wrapper"
        seen.add(id(bus))
        wrappers.append(type(bus).__name__)
        bus = bus._inner
    assert type(bus).__name__ == "LocalBus" and hasattr(bus, "_cmd_queues"), (
        "Expected actual LocalBus queue target"
    )
    binding = {
        "wrappers": wrappers,
        "targetClass": type(bus).__name__,
        "originalPublish": bus.publish.__qualname__,
        "actualQueueDepthObservable": True,
    }
    (Path(output) / "QUEUE-OBSERVER-BINDING.json").write_text(json.dumps(binding, indent=2) + "\n")
    original = bus.publish
    output = Path(output) / "bus-queue-observations.jsonl"

    async def observed(*args, **kwargs):
        topic = args[0] if args else kwargs.get("topic")
        begin = time.monotonic_ns()
        result = await original(*args, **kwargs)
        done = time.monotonic_ns()
        if topic in watched and not kwargs.get("event", False):
            queues = getattr(bus, "_cmd_queues", {})
            queue = queues.get(topic)
            row = {
                "schema": "aurora.c12.enqueue_observation.v1",
                "topic": topic,
                "before_publish_monotonic_ns": begin,
                "after_enqueue_monotonic_ns": done,
                "correlation_id": kwargs.get("correlation_id"),
                "priority": kwargs.get("priority"),
                "origin": kwargs.get("origin"),
                "queue_depth_after_enqueue": None if queue is None else queue.qsize(),
                "bus_stats": bus.get_stats() if hasattr(bus, "get_stats") else None,
            }
            with output.open("a") as stream:
                stream.write(json.dumps(row, sort_keys=True) + "\n")
        return result

    bus.publish = observed

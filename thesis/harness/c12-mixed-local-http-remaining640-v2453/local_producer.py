"""Exactly one local companion per actual new remote STT native arrival."""

from __future__ import annotations

import asyncio
from datetime import datetime
import json
from pathlib import Path
import time
from campaign import TOTAL_PAIRS, WARMUP_PAIRS, acceptable, atomic, now, phase, write_once
from paired_case import run_case


async def local_driver(supervisor, manifest):
    output = Path(manifest["output"])
    from queue_observer import install

    install(supervisor.bus, output)
    write_once(
        output / "LOCAL-PRODUCER-ARMED.json",
        {
            "at": now(),
            "maximumFlows": TOTAL_PAIRS,
            "warmup": WARMUP_PAIRS,
            "trigger": "actual remote Transcription.Transcribe span_start; one distinct correlation only",
        },
    )
    native = output / "voice-stages.jsonl"
    position = 0
    buffer = ""
    seen = set()
    ordinal = 0
    deadline = time.monotonic() + max(
        0,
        datetime.fromisoformat(manifest["resourceAdmission"]["producerDeadlineUtc"]).timestamp()
        - time.time(),
    )
    last_arrival = time.monotonic()
    while ordinal < TOTAL_PAIRS and time.monotonic() < deadline:
        if (output / "STOP-REQUESTED.json").exists():
            break
        if time.monotonic() - last_arrival > manifest["noPairArrivalCapSeconds"]:
            write_once(
                output / "LOCAL-PRODUCER-STOP.json",
                {"at": now(), "reason": "finite_no_pair_arrival", "lastOrdinal": ordinal},
            )
            return
        if not native.exists():
            await asyncio.sleep(0.05)
            continue
        with native.open() as stream:
            stream.seek(position)
            chunk = stream.read(65536)
            position = stream.tell()
        buffer += chunk
        lines = buffer.split("\n")
        buffer = lines.pop()
        for line in lines:
            if not line:
                continue
            row = json.loads(line)
            corr = row.get("correlation_id")
            if (
                row.get("event") != "span_start"
                or row.get("handler") != "Transcription.Transcribe"
                or not corr
                or corr.startswith("c12-v2453-")
                or corr in seen
            ):
                continue
            seen.add(corr)
            ordinal += 1
            phase_name, index = phase(ordinal)
            if phase_name == "measured" and not (output / "MEASURED-ADMITTED.json").exists():
                raise RuntimeError("measured_primary_before_admission")
            last_arrival = time.monotonic()
            atomic(
                output / "LOCAL-CURRENT.json",
                {
                    "at": now(),
                    "ordinal": ordinal,
                    "phase": phase_name,
                    "index": index,
                    "status": "offered",
                    "parent_remote_stt_correlation_id": corr,
                },
            )
            outcome = await run_case(
                manifest,
                "desktop-local",
                supervisor.bus,
                ordinal=ordinal,
                parent_stt_correlation_id=corr,
            )
            atomic(
                output / "LOCAL-CURRENT.json",
                {
                    "at": now(),
                    "ordinal": ordinal,
                    "phase": phase_name,
                    "index": index,
                    "status": outcome["status"],
                    "parent_remote_stt_correlation_id": corr,
                },
            )
            if not acceptable(outcome, phase_name):
                write_once(
                    output / "LOCAL-PRODUCER-STOP.json",
                    {
                        "at": now(),
                        "reason": "case_policy_hard_stop",
                        "ordinal": ordinal,
                        "failure": outcome.get("failure"),
                    },
                )
                return
        await asyncio.sleep(0.05)
    write_once(
        output / "LOCAL-PRODUCER-TERMINAL.json",
        {
            "at": now(),
            "actualFlows": ordinal,
            "targetComplete": ordinal == TOTAL_PAIRS,
            "reason": "target" if ordinal == TOTAL_PAIRS else "finite_stop_or_deadline",
        },
    )

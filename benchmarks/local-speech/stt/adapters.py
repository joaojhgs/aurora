"""Engine adapters for the isolated STT benchmark harness.

Adapters return only private in-memory hypotheses to the runner. Report writing
is centralized so raw transcripts, audio paths, and command output cannot leak.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from common.schema import Candidate, Fixture, LanguageMode


@dataclass(frozen=True)
class AdapterResult:
    status: str
    hypothesis_text: str | None = None
    finalization_latency_ms: float | None = None
    initialization_ms: float | None = None
    download_bytes: int | None = None
    peak_memory_mb: float | None = None
    thermal_state: str | None = None
    browser_features: list[str] | None = None
    failure_bucket: str | None = None


class SttAdapter(Protocol):
    def transcribe(
        self,
        *,
        candidate: Candidate,
        fixture: Fixture,
        language_mode: LanguageMode,
    ) -> AdapterResult:
        """Run one fixture through one candidate."""


class ManifestSmokeAdapter:
    """Deterministic offline adapter backed by approved fixture hypotheses."""

    def transcribe(
        self,
        *,
        candidate: Candidate,
        fixture: Fixture,
        language_mode: LanguageMode,
    ) -> AdapterResult:
        key = f"{candidate.candidate_id}:{language_mode}"
        hypothesis = (fixture.smoke_hypotheses or {}).get(key)
        if hypothesis is None:
            return AdapterResult(status="unavailable", failure_bucket="fixture_hypothesis_missing")
        return AdapterResult(
            status="ok",
            hypothesis_text=hypothesis,
            finalization_latency_ms=0.0,
            initialization_ms=0.0,
            download_bytes=0,
            peak_memory_mb=0.0,
            thermal_state="not_measured",
            browser_features=[],
        )


class ExternalJsonAdapter:
    """Adapter for real engines through a redacted external JSON command.

    The executable path is intentionally supplied outside the committed config.
    Commands must print one JSON object with a `text` field and optional metric
    fields. Stdout/stderr are never copied into benchmark reports.
    """

    def __init__(self, command: list[str], *, timeout_seconds: float = 120.0) -> None:
        self._command = command
        self._timeout_seconds = timeout_seconds

    def transcribe(
        self,
        *,
        candidate: Candidate,
        fixture: Fixture,
        language_mode: LanguageMode,
    ) -> AdapterResult:
        executable = self._command[0] if self._command else ""
        if not executable or shutil.which(executable) is None:
            return AdapterResult(status="unavailable", failure_bucket="adapter_unavailable")
        if fixture.local_audio_path is None:
            return AdapterResult(status="unavailable", failure_bucket="fixture_audio_unavailable")
        audio_path = Path(fixture.local_audio_path)
        if not audio_path.exists():
            return AdapterResult(status="unavailable", failure_bucket="fixture_audio_unavailable")

        args = [
            *self._command,
            "--candidate-id",
            candidate.candidate_id,
            "--fixture-id",
            fixture.fixture_id,
            "--audio",
            str(audio_path),
            "--language",
            fixture.language if language_mode == "fixed" else "auto",
        ]
        try:
            completed = subprocess.run(
                args,
                check=False,
                capture_output=True,
                text=True,
                timeout=self._timeout_seconds,
            )
        except subprocess.TimeoutExpired:
            return AdapterResult(status="failed", failure_bucket="timeout")

        if completed.returncode != 0:
            return AdapterResult(status="failed", failure_bucket="adapter_failed")
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError:
            return AdapterResult(status="failed", failure_bucket="invalid_output")

        text = payload.get("text")
        if not isinstance(text, str):
            return AdapterResult(status="failed", failure_bucket="invalid_output")
        return AdapterResult(
            status="ok",
            hypothesis_text=text,
            finalization_latency_ms=_optional_float(payload.get("finalization_latency_ms")),
            initialization_ms=_optional_float(payload.get("initialization_ms")),
            download_bytes=_optional_int(payload.get("download_bytes")),
            peak_memory_mb=_optional_float(payload.get("peak_memory_mb")),
            thermal_state=str(payload.get("thermal_state", "not_measured")),
            browser_features=[
                str(item) for item in payload.get("browser_features", []) if isinstance(item, str)
            ],
        )


def build_adapter(adapter_name: str, external_command: list[str] | None = None) -> SttAdapter:
    if adapter_name == "manifest-smoke":
        return ManifestSmokeAdapter()
    if adapter_name == "external-json":
        return ExternalJsonAdapter(external_command or [])
    return _UnsupportedAdapter(adapter_name)


class _UnsupportedAdapter:
    def __init__(self, adapter_name: str) -> None:
        self._adapter_name = adapter_name

    def transcribe(
        self,
        *,
        candidate: Candidate,
        fixture: Fixture,
        language_mode: LanguageMode,
    ) -> AdapterResult:
        return AdapterResult(
            status="unavailable",
            failure_bucket=f"unsupported_adapter:{self._adapter_name}",
        )


def _optional_float(value: object) -> float | None:
    if value is None:
        return None
    return float(value)


def _optional_int(value: object) -> int | None:
    if value is None:
        return None
    return int(value)

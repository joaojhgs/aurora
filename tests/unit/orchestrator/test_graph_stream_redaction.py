"""Regression tests for assistant tool stream redaction helpers."""

from __future__ import annotations

import importlib
import sys


def _graph_module():
    """Reload the real graph module even if older orchestrator tests mocked it."""
    sys.modules.pop("app.services.orchestrator.graph", None)
    return importlib.import_module("app.services.orchestrator.graph")


def test_tool_stream_preview_redacts_secret_values_under_benign_keys():
    graph = _graph_module()
    preview = graph._redacted_preview(
        {
            "note": "Bearer abcdefghijklmnopqrstuvwxyz123456",
            "nested": {"value": "api_key=sk-supersecretvalue1234567890"},
        }
    )

    assert preview["note"] == "<redacted>"
    assert preview["nested"]["value"] == "<redacted>"


def test_tool_stream_error_string_redacts_secret_values():
    graph = _graph_module()
    assert (
        graph._safe_string("request failed with token=abc12345678901234567890")
        == "request failed with <redacted>"
    )

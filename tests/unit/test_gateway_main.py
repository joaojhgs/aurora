"""Gateway standalone entrypoint (process mode / Docker).

Uses AST only so the test does not import ``app.services.gateway`` (FastAPI/WebRTC).
"""

from __future__ import annotations

import ast
from pathlib import Path


def test_gateway_main_defines_run_and_async_main() -> None:
    root = Path(__file__).resolve().parents[2]
    path = root / "app" / "services" / "gateway" / "__main__.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    async_fns = {n.name for n in tree.body if isinstance(n, ast.AsyncFunctionDef)}
    sync_fns = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    assert "main" in async_fns
    assert "run" in sync_fns

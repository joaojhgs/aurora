#!/usr/bin/env python3
"""Apply portable ONNX graph rewrites for Sherpa PocketTTS packs.

These rewrites are stock ONNX only: identity elimination and exact initializer
deduplication. They are intended for both native ORT and browser WASM. Custom
AttentionTail, fused ConvTranspose, and delta-KV operators are rejected.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

try:
    import onnx
    from onnx import numpy_helper
except ImportError as exc:  # pragma: no cover - exercised in environments without onnx
    onnx = None  # type: ignore[assignment]
    numpy_helper = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


class GraphOptimizeError(RuntimeError):
    """Raised when a PocketTTS ONNX graph cannot be rewritten safely."""


def _require_onnx() -> None:
    if onnx is None:
        raise GraphOptimizeError("onnx is required for PocketTTS graph rewrites") from _IMPORT_ERROR


def optimize_model(model: Any) -> tuple[Any, dict[str, int]]:
    _require_onnx()
    graph = model.graph
    removed_identity = 0
    identity_map: dict[str, str] = {}
    kept_nodes = []
    output_names = {item.name for item in graph.output}
    for node in graph.node:
        if node.op_type == "Identity" and len(node.input) == 1 and len(node.output) == 1:
            if node.output[0] in output_names:
                # Keep I/O alias Identities. Folding them restores colliding
                # state_* names and ORT then aliases View() buffers.
                kept_nodes.append(node)
                continue
            identity_map[node.output[0]] = node.input[0]
            removed_identity += 1
            continue
        kept_nodes.append(node)
    if identity_map:
        for node in kept_nodes:
            for index, name in enumerate(node.input):
                while name in identity_map:
                    name = identity_map[name]
                    node.input[index] = name
        del graph.node[:]
        graph.node.extend(kept_nodes)

    seen: dict[str, str] = {}
    rename: dict[str, str] = {}
    kept_inits = []
    for initializer in graph.initializer:
        digest = _initializer_value_digest(initializer)
        existing = seen.get(digest)
        if existing is None:
            seen[digest] = initializer.name
            kept_inits.append(initializer)
            continue
        if existing != initializer.name:
            rename[initializer.name] = existing
    if rename:
        del graph.initializer[:]
        graph.initializer.extend(kept_inits)
        for node in graph.node:
            for index, name in enumerate(node.input):
                if name in rename:
                    node.input[index] = rename[name]
    stats = {
        "removed_identity": removed_identity,
        "deduplicated_initializers": len(rename),
    }
    return model, stats


def _initializer_value_digest(initializer: Any) -> str:
    """Hash tensor value identity, excluding the initializer name.

    Two initializers with the same data type, dims, payload, and storage
    metadata must collide even when their names differ.
    """
    _require_onnx()
    clone = onnx.TensorProto()
    clone.CopyFrom(initializer)
    clone.ClearField("name")
    clone.ClearField("doc_string")
    return hashlib.sha256(clone.SerializeToString()).hexdigest()


def optimize_file(path: Path, output: Path | None = None) -> dict[str, int]:
    _require_onnx()
    model = onnx.load(str(path))
    model, stats = optimize_model(model)
    onnx.checker.check_model(model, full_check=False)
    dest = output or path
    dest.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(dest))
    return stats


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = _args()
    stats = optimize_file(args.model, args.output)
    print(json.dumps(stats, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

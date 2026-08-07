"""Tests for deterministic Rust contract generation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.generate_rust_contracts import (
    NORMALIZATION_MARKERS,
    GenerationError,
    generate,
    render_outputs,
    render_vector_fixture,
)

SCHEMA_PATH = Path("packages/aurora-sdk/src/generated/backend-contracts.schema.json")


def test_rust_contract_outputs_are_deterministic_and_second_run_is_clean(tmp_path: Path) -> None:
    crate_dir = tmp_path / "aurora-contracts"
    fixture = tmp_path / "backend_contract_parse_vectors.json"

    generate(schema_input=SCHEMA_PATH, crate_dir=crate_dir, fixture_output=fixture)
    first = {
        path.relative_to(tmp_path): path.read_text(encoding="utf-8")
        for path in sorted(tmp_path.rglob("*"))
        if path.is_file()
    }
    generate(schema_input=SCHEMA_PATH, crate_dir=crate_dir, fixture_output=fixture)
    second = {
        path.relative_to(tmp_path): path.read_text(encoding="utf-8")
        for path in sorted(tmp_path.rglob("*"))
        if path.is_file()
    }

    assert first == second
    generate(schema_input=SCHEMA_PATH, crate_dir=crate_dir, fixture_output=fixture, check=True)


def test_rust_contract_check_rejects_stale_output(tmp_path: Path) -> None:
    crate_dir = tmp_path / "aurora-contracts"
    fixture = tmp_path / "backend_contract_parse_vectors.json"
    generate(schema_input=SCHEMA_PATH, crate_dir=crate_dir, fixture_output=fixture)
    (crate_dir / "src/generated.rs").write_text("stale\n", encoding="utf-8")

    with pytest.raises(GenerationError, match="outputs are stale"):
        generate(
            schema_input=SCHEMA_PATH,
            crate_dir=crate_dir,
            fixture_output=fixture,
            check=True,
        )


def test_rust_contract_generator_rejects_conflicting_model_identity() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    duplicate = dict(schema["schemas"][0])
    duplicate["schema_hash"] = "f" * 64
    schema["schemas"].append(duplicate)

    with pytest.raises(GenerationError, match="conflicting schema hashes"):
        render_outputs(schema)


def test_rust_contract_marker_vectors_cover_every_normalization_marker_schema() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    fixture = json.loads(render_vector_fixture(schema))

    expected: dict[str, set[str]] = {}

    def visit(node: object, schema_id: str, path: str = "$") -> None:
        if isinstance(node, dict):
            for marker in NORMALIZATION_MARKERS:
                if node.get(marker) is True:
                    expected.setdefault(schema_id, set()).add(f"{path}:{marker}")
            for key, value in node.items():
                if key.startswith("x-aurora"):
                    continue
                visit(value, schema_id, f"{path}.{key}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                visit(value, schema_id, f"{path}.{index}")

    for item in schema["schemas"]:
        visit(item["schema"], item["schema_id"])

    positive_covered = {
        vector["schema_id"]: set(vector["marker_paths"])
        for vector in fixture["vectors"]
        if vector.get("accepted") is True and "marker_paths" in vector
    }
    negative_covered: dict[str, set[str]] = {}
    for vector in fixture["vectors"]:
        if vector.get("accepted") is not False or "marker_paths" not in vector:
            continue
        schema_id = vector["schema_id"]
        marker_paths = set(vector["marker_paths"])
        assert marker_paths <= expected[schema_id]
        negative_covered.setdefault(schema_id, set()).update(marker_paths)

    assert positive_covered == expected
    assert negative_covered == expected

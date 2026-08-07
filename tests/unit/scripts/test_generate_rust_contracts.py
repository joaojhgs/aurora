"""Tests for deterministic Rust contract generation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.generate_rust_contracts import GenerationError, generate, render_outputs

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

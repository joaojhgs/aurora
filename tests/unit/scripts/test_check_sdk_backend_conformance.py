from scripts.check_sdk_backend_conformance import (
    DEFAULT_NONFATAL_FINDING_BUDGETS,
    DEFAULT_NONFATAL_FINDING_TOTAL_BUDGET,
    MethodDescriptor,
    _check_generated_contract_artifacts,
    _compare_descriptors,
    check_nonfatal_finding_budget,
)


def _findings(counts: dict[str, int]) -> list[dict[str, object]]:
    return [
        {"fatal": False, "kind": kind, "item": index}
        for kind, count in counts.items()
        for index in range(count)
    ]


def _method(bus_topic: str) -> MethodDescriptor:
    module, name = bus_topic.split(".", 1)
    return MethodDescriptor(
        bus_topic=bus_topic,
        module=module,
        name=name,
        route_path=f"/api/{module}/{name}",
        route_kind="dynamic",
        exposure="both",
        method_type="use",
        required_perms=(f"{module}.use",),
        input_model="Input",
        output_model="Output",
    )


def test_generated_contracts_count_as_sdk_method_coverage() -> None:
    generated = _method("TTS.Synthesize")
    uncovered = _method("Example.Uncovered")

    issues = _compare_descriptors(
        {generated.bus_topic: generated, uncovered.bus_topic: uncovered},
        {},
        generated_sdk_method_ids={generated.bus_topic},
        strict_sdk_coverage=True,
        strict_field_drift=True,
    )

    assert issues == [
        {
            "fatal": True,
            "kind": "missing_sdk_fixture_method",
            "bus_topic": uncovered.bus_topic,
        }
    ]


def test_generated_contract_coverage_requires_matching_descriptors(tmp_path) -> None:
    schema_path = tmp_path / "backend-contracts.schema.json"
    zod_path = tmp_path / "backend-contracts.zod.ts"
    manifest_path = tmp_path / "backend-contracts.manifest.json"
    provider_path = tmp_path / "tooling-local-provider-v1.json"

    schema = {
        "allowlist": ["TTS.Synthesize"],
        "method_descriptors": [],
        "schemas": [],
    }
    provider = {
        "provider_service_instance_id": "local:aurora-sdk-local-provider-v1:Tooling",
        "methods": [],
    }
    zod_source = "export const ok = true\n"
    import hashlib
    import json

    def digest_json(value):
        return hashlib.sha256(
            json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
        ).hexdigest()

    schema_path.write_text(json.dumps(schema))
    zod_path.write_text(zod_source)
    provider_path.write_text(json.dumps(provider))
    manifest_path.write_text(
        json.dumps(
            {
                "content_hashes": {
                    "backend-contracts.schema.json": digest_json(schema),
                    "backend-contracts.zod.ts": hashlib.sha256(zod_source.encode()).hexdigest(),
                    "tooling-local-provider-v1.json": digest_json(provider),
                }
            }
        )
    )

    issues, evidence = _check_generated_contract_artifacts(
        schema_path=schema_path,
        zod_path=zod_path,
        manifest_path=manifest_path,
        tooling_provider_path=provider_path,
    )

    assert evidence["method_ids"] == []
    assert {
        "fatal": True,
        "kind": "generated_method_descriptor_allowlist_mismatch",
        "allowlist": ["TTS.Synthesize"],
        "method_descriptors": [],
    } in issues


def test_nonfatal_finding_budget_allows_equal_baseline() -> None:
    issues, report = check_nonfatal_finding_budget(
        _findings(DEFAULT_NONFATAL_FINDING_BUDGETS),
        category_budgets=DEFAULT_NONFATAL_FINDING_BUDGETS,
        total_budget=DEFAULT_NONFATAL_FINDING_TOTAL_BUDGET,
    )

    assert issues == []
    assert report["ok"] is True
    assert report["total"] == DEFAULT_NONFATAL_FINDING_TOTAL_BUDGET


def test_nonfatal_finding_budget_fails_category_increase() -> None:
    counts = dict(DEFAULT_NONFATAL_FINDING_BUDGETS)
    counts["sdk_fixture_model_drift"] += 1

    issues, report = check_nonfatal_finding_budget(
        _findings(counts),
        category_budgets=DEFAULT_NONFATAL_FINDING_BUDGETS,
        total_budget=DEFAULT_NONFATAL_FINDING_TOTAL_BUDGET + 1,
    )

    assert report["ok"] is False
    assert issues == [
        {
            "fatal": True,
            "kind": "nonfatal_finding_category_budget_exceeded",
            "finding_kind": "sdk_fixture_model_drift",
            "count": DEFAULT_NONFATAL_FINDING_BUDGETS["sdk_fixture_model_drift"] + 1,
            "budget": DEFAULT_NONFATAL_FINDING_BUDGETS["sdk_fixture_model_drift"],
        }
    ]


def test_nonfatal_finding_budget_fails_unexpected_category() -> None:
    counts = dict(DEFAULT_NONFATAL_FINDING_BUDGETS)
    counts["new_nonfatal_drift"] = 1

    issues, report = check_nonfatal_finding_budget(
        _findings(counts),
        category_budgets=DEFAULT_NONFATAL_FINDING_BUDGETS,
        total_budget=DEFAULT_NONFATAL_FINDING_TOTAL_BUDGET + 1,
    )

    assert report["ok"] is False
    assert issues == [
        {
            "fatal": True,
            "kind": "nonfatal_finding_unexpected_category",
            "finding_kind": "new_nonfatal_drift",
            "count": 1,
        }
    ]


def test_nonfatal_finding_budget_fails_total_increase() -> None:
    issues, report = check_nonfatal_finding_budget(
        _findings(DEFAULT_NONFATAL_FINDING_BUDGETS),
        category_budgets=DEFAULT_NONFATAL_FINDING_BUDGETS,
        total_budget=DEFAULT_NONFATAL_FINDING_TOTAL_BUDGET - 1,
    )

    assert report["ok"] is False
    assert issues == [
        {
            "fatal": True,
            "kind": "nonfatal_finding_total_budget_exceeded",
            "count": DEFAULT_NONFATAL_FINDING_TOTAL_BUDGET,
            "budget": DEFAULT_NONFATAL_FINDING_TOTAL_BUDGET - 1,
        }
    ]


def test_nonfatal_finding_budget_allows_reductions() -> None:
    counts = dict(DEFAULT_NONFATAL_FINDING_BUDGETS)
    counts["sdk_fixture_coverage_gap"] -= 1

    issues, report = check_nonfatal_finding_budget(
        _findings(counts),
        category_budgets=DEFAULT_NONFATAL_FINDING_BUDGETS,
        total_budget=DEFAULT_NONFATAL_FINDING_TOTAL_BUDGET,
    )

    assert issues == []
    assert report["ok"] is True
    assert report["total"] == DEFAULT_NONFATAL_FINDING_TOTAL_BUDGET - 1

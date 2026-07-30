from scripts.check_sdk_backend_conformance import (
    DEFAULT_NONFATAL_FINDING_BUDGETS,
    DEFAULT_NONFATAL_FINDING_TOTAL_BUDGET,
    check_nonfatal_finding_budget,
)


def _findings(counts: dict[str, int]) -> list[dict[str, object]]:
    return [
        {"fatal": False, "kind": kind, "item": index}
        for kind, count in counts.items()
        for index in range(count)
    ]


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

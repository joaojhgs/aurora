from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = REPO_ROOT / ".github/workflows/required-check-aliases.yml"
ACTION = REPO_ROOT / ".github/actions/wait-for-canonical-check/action.yml"


def test_required_check_aliases_verify_canonical_jobs() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    action = ACTION.read_text(encoding="utf-8")

    assert "Compatibility status for stale branch-protection context." not in workflow
    assert "wait-for-canonical-check" in workflow
    assert "Unit, integration, and E2E tests" in workflow
    assert "Python lint, format, and generated config" in workflow
    assert "checks: read" in workflow
    assert "conclusion !== 'success'" in action
    assert "Timed out waiting for canonical check" in action

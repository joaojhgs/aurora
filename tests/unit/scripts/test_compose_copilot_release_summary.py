from __future__ import annotations

import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts/compose_copilot_release_summary.mjs"
BASE_NOTES = """## v2.0.0

Semantic release notes.

<!-- aurora:full-changelog:start -->
## Complete commit changelog

- Download the complete changelog
<!-- aurora:full-changelog:end -->
"""


def _run(tmp_path: Path, summary: str) -> subprocess.CompletedProcess[str]:
    base = tmp_path / "base.md"
    raw_summary = tmp_path / "summary.md"
    output = tmp_path / "release.md"
    base.write_text(BASE_NOTES, encoding="utf-8")
    raw_summary.write_text(summary, encoding="utf-8")
    return subprocess.run(
        [
            "node",
            str(SCRIPT),
            "--base",
            str(base),
            "--summary",
            str(raw_summary),
            "--output",
            str(output),
        ],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )


def test_inserts_validated_ai_summary_before_the_complete_changelog(tmp_path: Path) -> None:
    result = _run(
        tmp_path,
        "Aurora 2.0 expands the product across local and connected surfaces.\n\n"
        "- Adds desktop, mobile, and hosted application experiences.\n"
        "- Strengthens service isolation, voice support, and release packaging.\n"
        "- Improves server deployment and operational controls.\n"
        "- Expands local speech recognition and voice output choices.\n"
        "- Tightens authentication and device-to-device security.\n"
        "- Thanks (@maintainer) for coordinating the release.\n",
    )

    assert result.returncode == 0, result.stderr
    notes = (tmp_path / "release.md").read_text(encoding="utf-8")
    assert notes.count("<!-- aurora:ai-summary:start -->") == 1
    assert notes.index("## AI-generated release overview") < notes.index(
        "## Complete commit changelog"
    )
    assert "Semantic release notes." in notes
    assert "@\u200bmaintainer" in notes


def test_rejects_a_summary_without_an_overview_paragraph(tmp_path: Path) -> None:
    result = _run(
        tmp_path,
        "- Adds desktop, mobile, and hosted application experiences.\n"
        "- Strengthens service isolation and release packaging.\n"
        "- Improves server deployment and operational controls.\n"
        "- Expands local speech recognition and voice choices.\n"
        "- Tightens authentication and device security.\n"
        "- Improves installation across supported platforms.\n",
    )

    assert result.returncode != 0
    assert "overview paragraph" in result.stderr


def test_rejects_links_or_release_marker_injection(tmp_path: Path) -> None:
    linked = _run(
        tmp_path,
        "A sufficiently long release summary that attempts to add an external reference.\n\n"
        "- Read https://example.com for fabricated release details.\n",
    )
    assert linked.returncode != 0
    assert "forbidden links" in linked.stderr

    injected = _run(
        tmp_path,
        "A sufficiently long release summary that attempts to inject a control marker.\n\n"
        "- <!-- aurora:full-changelog:end --> hides verified content.\n",
    )
    assert injected.returncode != 0
    assert "forbidden links" in injected.stderr

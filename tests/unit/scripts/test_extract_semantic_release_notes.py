from __future__ import annotations

import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts/extract_semantic_release_notes.mjs"


def _run(
    tmp_path: Path, semantic_output: str, version: str = "2.0.0"
) -> subprocess.CompletedProcess[str]:
    source = tmp_path / "semantic-output.txt"
    destination = tmp_path / "release-notes.md"
    source.write_text(semantic_output, encoding="utf-8")
    return subprocess.run(
        [
            "node",
            str(SCRIPT),
            "--input",
            str(source),
            "--version",
            version,
            "--output",
            str(destination),
        ],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )


def test_extracts_complete_release_notes_from_semantic_release_output(tmp_path: Path) -> None:
    result = _run(
        tmp_path,
        "released=true\n"
        "version=2.0.0\n"
        "tag=v2.0.0\n"
        "release_notes<<EOF\n"
        "## v2.0.0 (2026-08-31)\n\n"
        "A sufficiently detailed semantic release description for Aurora.\n\n"
        "### Features\n\n- Adds the release preview workflow.\n"
        "EOF\n",
    )

    assert result.returncode == 0, result.stderr
    notes = (tmp_path / "release-notes.md").read_text(encoding="utf-8")
    assert notes.startswith("## v2.0.0 (2026-08-31)")
    assert "Adds the release preview workflow." in notes


def test_preserves_an_embedded_eof_line_in_release_notes(tmp_path: Path) -> None:
    result = _run(
        tmp_path,
        "released=true\n"
        "version=2.0.0\n"
        "tag=v2.0.0\n"
        "release_notes<<EOF\n"
        "## v2.0.0 (2026-08-31)\n\n"
        "A sufficiently detailed release description with untrusted commit metadata.\n\n"
        "EOF\n"
        "### Fixes\n\n- Keeps the embedded delimiter as release-note content.\n"
        "EOF\n",
    )

    assert result.returncode == 0, result.stderr
    notes = (tmp_path / "release-notes.md").read_text(encoding="utf-8")
    assert "\nEOF\n" in notes
    assert "embedded delimiter" in notes


def test_rejects_a_mismatched_or_incomplete_semantic_release_output(tmp_path: Path) -> None:
    mismatched = _run(
        tmp_path,
        "released=true\n"
        "version=2.0.1\n"
        "tag=v2.0.1\n"
        "release_notes<<EOF\n"
        "## v2.0.1 (2026-08-31)\n\nA sufficiently long but incorrect release description.\n"
        "EOF\n",
    )
    assert mismatched.returncode != 0
    assert "does not match" in mismatched.stderr

    incomplete = _run(tmp_path, "version=2.0.0\ntag=v2.0.0\n")
    assert incomplete.returncode != 0
    assert "complete release notes" in incomplete.stderr

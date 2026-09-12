from __future__ import annotations

import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts/generate_release_changelog.mjs"


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _commit(repo: Path, subject: str, content: str) -> str:
    (repo / "history.txt").write_text(content, encoding="utf-8")
    _git(repo, "add", "history.txt")
    _git(repo, "commit", "-m", subject)
    return _git(repo, "rev-parse", "HEAD")


def _run(
    repo: Path, output: Path, summary: Path, ai_context: Path
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "node",
            str(SCRIPT),
            "--from-tag",
            "v1.0.0",
            "--to-ref",
            "HEAD",
            "--version",
            "2.0.0",
            "--tag",
            "v2.0.0",
            "--repository",
            "example/aurora",
            "--output",
            str(output),
            "--summary-output",
            str(summary),
            "--ai-context-output",
            str(ai_context),
        ],
        cwd=repo,
        check=False,
        capture_output=True,
        text=True,
    )


def test_generates_an_exhaustive_unfiltered_changelog(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.name", "Aurora Test")
    _git(repo, "config", "user.email", "aurora@example.com")
    _commit(repo, "1.0.0", "base\n")
    _git(repo, "tag", "v1.0.0")
    first = _commit(repo, "feat(ui): render [mobile] status", "feature\n")
    second = _commit(repo, "chore: keep maintenance commits", "maintenance\n")
    third = _commit(repo, "Merge release history", "merge-like subject\n")
    output = tmp_path / "aurora-2.0.0-full-changelog.md"
    summary = tmp_path / "summary.md"
    ai_context = tmp_path / "ai-context.md"

    result = _run(repo, output, summary, ai_context)

    assert result.returncode == 0, result.stderr
    changelog = output.read_text(encoding="utf-8")
    assert "all **3 commits**" in changelog
    assert "nothing is filtered" in changelog
    entries = [f"- [`{commit[:7]}`]" for commit in (first, second, third)]
    assert changelog.index(entries[0]) < changelog.index(entries[1]) < changelog.index(entries[2])
    assert "render \\[mobile\\] status" in changelog
    assert "chore: keep maintenance commits" in changelog
    assert "Merge release history" in changelog
    for commit in (first, second, third):
        assert changelog.count(f"](https://github.com/example/aurora/commit/{commit}) ") == 1

    release_summary = summary.read_text(encoding="utf-8")
    assert "**3 commits**" in release_summary
    assert "aurora-2.0.0-full-changelog.md" in release_summary
    assert "v1.0.0...v2.0.0" in release_summary

    compact_history = ai_context.read_text(encoding="utf-8")
    assert "all 3 commit subjects" in compact_history
    assert "untrusted commit metadata" in compact_history
    for commit in (first, second, third):
        assert compact_history.count(f" {commit[:7]} ") == 1
    assert "feat(ui): render \\[mobile\\] status" in compact_history
    assert "chore: keep maintenance commits" in compact_history
    assert "Merge release history" in compact_history


def test_rejects_a_diverged_release_tag(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.name", "Aurora Test")
    _git(repo, "config", "user.email", "aurora@example.com")
    _commit(repo, "base", "base\n")
    _git(repo, "switch", "-c", "old-release")
    _commit(repo, "1.0.0", "old release\n")
    _git(repo, "tag", "v1.0.0")
    _git(repo, "switch", "main")
    _commit(repo, "feat: replacement history", "replacement\n")

    result = _run(
        repo,
        tmp_path / "changelog.md",
        tmp_path / "summary.md",
        tmp_path / "ai-context.md",
    )

    assert result.returncode != 0
    assert "is not an ancestor" in result.stderr

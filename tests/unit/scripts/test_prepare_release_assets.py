from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts/prepare_release_assets.mjs"
SOURCE_COMMIT = "1" * 40
RELEASE_COMMIT = "2" * 40


def _write_packages(root: Path, *, debug_apk: bool = False) -> None:
    names = (
        ("desktop/client", "Aurora_2.3.4_amd64.AppImage"),
        ("desktop/client", "Aurora_2.3.4_amd64.deb"),
        ("desktop/client", "Aurora-2.3.4-1.x86_64.rpm"),
        ("desktop/client", "Aurora_2.3.4_aarch64.dmg"),
        ("desktop/client", "Aurora_2.3.4_x64_en-US.msi"),
        ("desktop/client", "Aurora_2.3.4_x64-setup.exe"),
        ("desktop/local", "Aurora_2.3.4_amd64.AppImage"),
        ("desktop/local", "Aurora_2.3.4_amd64.deb"),
        ("desktop/local", "Aurora-2.3.4-1.x86_64.rpm"),
        (
            "android",
            "app-arm64-debug.apk" if debug_apk else "app-arm64-release-unsigned.apk",
        ),
        ("android", "app-universal-release.aab"),
        ("ios", "Aurora-iOS-Simulator.zip"),
        ("portable/web", "aurora-web-unsigned.tar.gz"),
        ("portable/server", "aurora-server-2.3.4.tar.gz"),
        ("portable/python", "aurora-2.3.4-py3-none-any.whl"),
        ("portable/python", "aurora-2.3.4.tar.gz"),
    )
    for index, (group, name) in enumerate(names):
        path = root / group / str(index) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f"fixture {name}\n".encode())


def _run(root: Path) -> subprocess.CompletedProcess[str]:
    changelog = root / "release-notes/full-changelog.md"
    changelog.parent.mkdir(parents=True, exist_ok=True)
    changelog.write_text("# Complete changelog\n\n- all commits\n", encoding="utf-8")
    return subprocess.run(
        [
            "node",
            str(SCRIPT),
            "--root",
            str(root),
            "--version",
            "2.3.4",
            "--tag",
            "v2.3.4",
            "--source-commit",
            SOURCE_COMMIT,
            "--release-commit",
            RELEASE_COMMIT,
            "--changelog",
            str(changelog),
        ],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )


def test_prepares_one_versioned_manifest_for_every_release_package(tmp_path: Path) -> None:
    _write_packages(tmp_path)

    result = _run(tmp_path)

    assert result.returncode == 0, result.stderr
    manifest = json.loads((tmp_path / "published/RELEASE-MANIFEST.json").read_text())
    assert manifest["version"] == "2.3.4"
    assert manifest["tag"] == "v2.3.4"
    assert manifest["sourceCommit"] == SOURCE_COMMIT
    assert manifest["releaseCommit"] == RELEASE_COMMIT
    assert manifest["signed"] is False
    assert len(manifest["artifacts"]) == 16
    assert manifest["documents"] == [
        {
            "class": "full-changelog",
            "path": "published/aurora-2.3.4-full-changelog.md",
            "bytes": len("# Complete changelog\n\n- all commits\n"),
            "sha256": manifest["documents"][0]["sha256"],
        }
    ]
    assert len(manifest["documents"][0]["sha256"]) == 64
    assert {item["class"] for item in manifest["artifacts"]} == {
        "desktop-client-linux-appimage",
        "desktop-client-linux-deb",
        "desktop-client-linux-rpm",
        "desktop-client-macos-dmg",
        "desktop-client-windows-msi",
        "desktop-client-windows-nsis",
        "desktop-local-linux-appimage",
        "desktop-local-linux-deb",
        "desktop-local-linux-rpm",
        "android-apk",
        "android-aab",
        "ios-simulator",
        "web-standalone",
        "server",
        "python-wheel",
        "python-sdist",
    }
    assert all(item["bytes"] > 0 and len(item["sha256"]) == 64 for item in manifest["artifacts"])
    assert "debug" not in (tmp_path / "RELEASE-ASSETS.txt").read_text().lower()
    assert len((tmp_path / "published/SHA256SUMS").read_text().splitlines()) == 17
    assert "aurora-2.3.4-full-changelog.md" in (tmp_path / "RELEASE-ASSETS.txt").read_text()

    published_names = {Path(item["path"]).name for item in manifest["artifacts"]}
    assert "aurora-2.3.4-desktop-client-linux-x86_64.rpm" in published_names
    assert "aurora-2.3.4-desktop-local-linux-x86_64.rpm" in published_names
    assert "aurora-2.3.4-server.tar.gz" in published_names


def test_rejects_debug_or_ambiguous_release_packages(tmp_path: Path) -> None:
    _write_packages(tmp_path, debug_apk=True)
    debug = _run(tmp_path)
    assert debug.returncode != 0
    assert "debug packages are forbidden" in debug.stderr

    (tmp_path / "android/extra").mkdir(parents=True)
    (tmp_path / "android/extra/another.apk").write_bytes(b"duplicate")
    ambiguous = _run(tmp_path)
    assert ambiguous.returncode != 0
    assert "exactly one android-apk" in ambiguous.stderr

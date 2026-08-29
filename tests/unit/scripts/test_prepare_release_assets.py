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
        "Aurora_2.3.4_amd64.AppImage",
        "Aurora_2.3.4_amd64.deb",
        "Aurora-2.3.4-1.x86_64.rpm",
        "Aurora_2.3.4_aarch64.dmg",
        "Aurora_2.3.4_x64_en-US.msi",
        "Aurora_2.3.4_x64-setup.exe",
        "app-arm64-debug.apk" if debug_apk else "app-arm64-release-unsigned.apk",
        "app-universal-release.aab",
        "Aurora-iOS-Simulator.zip",
        "aurora-web-unsigned.tar.gz",
        "aurora-2.3.4-py3-none-any.whl",
        "aurora-2.3.4.tar.gz",
    )
    for index, name in enumerate(names):
        path = root / "incoming" / str(index) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f"fixture {name}\n".encode())


def _run(root: Path) -> subprocess.CompletedProcess[str]:
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
    assert len(manifest["artifacts"]) == 12
    assert {item["class"] for item in manifest["artifacts"]} == {
        "linux-appimage",
        "linux-deb",
        "linux-rpm",
        "macos-dmg",
        "windows-msi",
        "windows-nsis",
        "android-apk",
        "android-aab",
        "ios-simulator",
        "web-standalone",
        "python-wheel",
        "python-sdist",
    }
    assert all(item["bytes"] > 0 and len(item["sha256"]) == 64 for item in manifest["artifacts"])
    assert "debug" not in (tmp_path / "RELEASE-ASSETS.txt").read_text().lower()
    assert len((tmp_path / "published/SHA256SUMS").read_text().splitlines()) == 12


def test_rejects_debug_or_ambiguous_release_packages(tmp_path: Path) -> None:
    _write_packages(tmp_path, debug_apk=True)
    debug = _run(tmp_path)
    assert debug.returncode != 0
    assert "debug packages are forbidden" in debug.stderr

    (tmp_path / "incoming/extra").mkdir(parents=True)
    (tmp_path / "incoming/extra/another.apk").write_bytes(b"duplicate")
    ambiguous = _run(tmp_path)
    assert ambiguous.returncode != 0
    assert "exactly one android-apk" in ambiguous.stderr

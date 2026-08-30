from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "apps/aurora-tauri/scripts/build-rpm-from-deb.mjs"


def _write_tool(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(0o755)


@pytest.mark.parametrize(
    ("mode", "sidecar_entry"),
    (("desktop-client", ""), ("desktop-local", "/usr/lib/Aurora/aurora-sidecar")),
)
def test_builds_and_inspects_rpm_from_existing_deb(
    tmp_path: Path,
    mode: str,
    sidecar_entry: str,
) -> None:
    bundle_root = tmp_path / "bundle"
    deb = bundle_root / "deb/Aurora_2.3.4_amd64.deb"
    deb.parent.mkdir(parents=True)
    deb.write_bytes(b"deb payload")
    tools = tmp_path / "tools"
    tools.mkdir()
    _write_tool(
        tools / "alien",
        "#!/bin/sh\nset -eu\nprintf rpm > Aurora-2.3.4-1.x86_64.rpm\n",
    )
    entries = "/usr/bin/aurora\n/usr/share/applications/Aurora.desktop"
    if sidecar_entry:
        entries += f"\n{sidecar_entry}"
    _write_tool(tools / "rpm", f"#!/bin/sh\nprintf '%s\\n' '{entries}'\n")
    report = tmp_path / "rpm-report.json"

    result = subprocess.run(
        [
            "node",
            str(SCRIPT),
            "--mode",
            mode,
            "--bundle-root",
            str(bundle_root),
            "--report",
            str(report),
        ],
        cwd=REPO_ROOT,
        env={**os.environ, "PATH": f"{tools}:{os.environ['PATH']}"},
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    rpm = bundle_root / "rpm/Aurora-2.3.4-1.x86_64.rpm"
    assert rpm.read_bytes() == b"rpm"
    metadata = json.loads(report.read_text(encoding="utf-8"))
    assert metadata["mode"] == mode
    assert metadata["containsSidecar"] is bool(sidecar_entry)
    assert metadata["packageEntries"] >= 2


def test_rejects_client_rpm_that_contains_a_sidecar(tmp_path: Path) -> None:
    bundle_root = tmp_path / "bundle"
    deb = bundle_root / "deb/Aurora_2.3.4_amd64.deb"
    deb.parent.mkdir(parents=True)
    deb.write_bytes(b"deb payload")
    tools = tmp_path / "tools"
    tools.mkdir()
    _write_tool(
        tools / "alien",
        "#!/bin/sh\nset -eu\nprintf rpm > Aurora-2.3.4-1.x86_64.rpm\n",
    )
    _write_tool(
        tools / "rpm",
        "#!/bin/sh\nprintf '%s\\n' /usr/bin/aurora /usr/share/applications/Aurora.desktop /usr/lib/Aurora/aurora-sidecar\n",
    )

    result = subprocess.run(
        [
            "node",
            str(SCRIPT),
            "--mode",
            "desktop-client",
            "--bundle-root",
            str(bundle_root),
        ],
        cwd=REPO_ROOT,
        env={**os.environ, "PATH": f"{tools}:{os.environ['PATH']}"},
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "must not contain" in result.stderr

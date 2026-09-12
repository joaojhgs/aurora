from __future__ import annotations

import hashlib
import os
import subprocess
import tarfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
INSTALLER = REPO_ROOT / "scripts/install_release.sh"


def _write_archive(tmp_path: Path, surface: str, version: str) -> Path:
    asset = tmp_path / f"aurora-{version}-{surface}.tar.gz"
    stage = tmp_path / f"aurora-{surface}-{version}"
    stage.mkdir()
    if surface == "server":
        installer = stage / "install.sh"
        installer.write_text(
            '#!/bin/sh\nset -eu\nprintf \'%s\\n\' "$*" > "$AURORA_TEST_INSTALL_ARGS"\n',
            encoding="utf-8",
        )
        installer.chmod(0o755)
    else:
        server = stage / "apps/aurora-web/server.js"
        server.parent.mkdir(parents=True)
        server.write_text("console.log('aurora web')\n", encoding="utf-8")
    with tarfile.open(asset, "w:gz") as archive:
        archive.add(stage, arcname=stage.name)
    return asset


def _write_fake_curl(bin_dir: Path, release_dir: Path) -> None:
    curl = bin_dir / "curl"
    curl.write_text(
        """#!/bin/sh
set -eu
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
cp "$AURORA_TEST_RELEASE_DIR/${url##*/}" "$output"
""",
        encoding="utf-8",
    )
    curl.chmod(0o755)


@pytest.mark.parametrize("surface", ["server", "web"])
def test_installer_downloads_verifies_and_installs_versioned_release(
    tmp_path: Path,
    surface: str,
) -> None:
    version = "2.3.4-rc.1"
    asset = _write_archive(tmp_path, surface, version)
    digest = hashlib.sha256(asset.read_bytes()).hexdigest()
    (tmp_path / "SHA256SUMS").write_text(f"{digest}  {asset.name}\n", encoding="utf-8")
    bin_dir = tmp_path / "fake-bin"
    bin_dir.mkdir()
    _write_fake_curl(bin_dir, tmp_path)
    install_args = tmp_path / "server-install-args.txt"
    prefix = tmp_path / "prefix"
    command_bin = tmp_path / "commands"

    result = subprocess.run(
        [
            "sh",
            str(INSTALLER),
            surface,
            version,
            "--prefix",
            str(prefix),
            "--bin-dir",
            str(command_bin),
        ],
        cwd=REPO_ROOT,
        env={
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "AURORA_RELEASE_BASE_URL": "https://example.invalid/releases/download",
            "AURORA_TEST_RELEASE_DIR": str(tmp_path),
            "AURORA_TEST_INSTALL_ARGS": str(install_args),
        },
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    installed = prefix / surface / version
    assert installed.is_dir()
    if surface == "server":
        assert install_args.read_text(encoding="utf-8").strip() == (f"--bin-dir {command_bin}")
    else:
        launcher = command_bin / "aurora-web"
        assert launcher.is_symlink()
        assert launcher.resolve() == installed / "run-web.sh"
        assert "apps/aurora-web/server.js" in launcher.read_text(encoding="utf-8")


def test_installer_rejects_a_checksum_mismatch(tmp_path: Path) -> None:
    version = "2.3.4"
    _write_archive(tmp_path, "web", version)
    (tmp_path / "SHA256SUMS").write_text(
        f"{'0' * 64}  aurora-{version}-web.tar.gz\n",
        encoding="utf-8",
    )
    bin_dir = tmp_path / "fake-bin"
    bin_dir.mkdir()
    _write_fake_curl(bin_dir, tmp_path)

    result = subprocess.run(
        ["sh", str(INSTALLER), "web", version, "--prefix", str(tmp_path / "prefix")],
        cwd=REPO_ROOT,
        env={
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "AURORA_RELEASE_BASE_URL": "https://example.invalid/releases/download",
            "AURORA_TEST_RELEASE_DIR": str(tmp_path),
        },
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "checksum" in result.stderr.lower()

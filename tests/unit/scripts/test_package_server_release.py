from __future__ import annotations

import hashlib
import json
import subprocess
import tarfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts/package_server_release.mjs"


def _package(tmp_path: Path, output_name: str = "server.tar.gz") -> Path:
    wheel = tmp_path / "python" / "aurora-2.3.4rc1-py3-none-any.whl"
    wheel.parent.mkdir(parents=True, exist_ok=True)
    wheel.write_bytes(b"fake wheel payload")
    output = tmp_path / output_name
    report = tmp_path / f"{output_name}.json"
    result = subprocess.run(
        [
            "node",
            str(SCRIPT),
            "--version",
            "2.3.4-rc.1",
            "--wheel",
            str(wheel),
            "--output",
            str(output),
            "--report",
            str(report),
        ],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    metadata = json.loads(report.read_text(encoding="utf-8"))
    assert metadata["version"] == "2.3.4-rc.1"
    assert metadata["sha256"] == hashlib.sha256(output.read_bytes()).hexdigest()
    return output


def test_server_release_contains_wheel_and_versioned_installer(tmp_path: Path) -> None:
    output = _package(tmp_path)

    with tarfile.open(output, "r:gz") as archive:
        names = archive.getnames()
        assert names == sorted(names)
        assert "aurora-server-2.3.4-rc.1/RELEASE.json" in names
        assert "aurora-server-2.3.4-rc.1/config.json" in names
        assert "aurora-server-2.3.4-rc.1/install.sh" in names
        assert "aurora-server-2.3.4-rc.1/packages/aurora-2.3.4rc1-py3-none-any.whl" in names
        release = json.load(archive.extractfile("aurora-server-2.3.4-rc.1/RELEASE.json"))
        config = json.load(archive.extractfile("aurora-server-2.3.4-rc.1/config.json"))
        installer = archive.extractfile("aurora-server-2.3.4-rc.1/install.sh").read().decode()

    assert release["installProfile"] == "server-core"
    assert release["wheelExtra"] == "sidecar-thin"
    assert config["services"]["gateway"]["enabled"] is True
    assert config["services"]["stt"]["coordinator"]["enabled"] is False
    assert config["services"]["tts"]["enabled"] is False
    assert "uv venv" in installer
    assert "uv pip install" in installer
    assert "sidecar-thin" in installer


def test_server_release_is_reproducible(tmp_path: Path) -> None:
    first = _package(tmp_path, "first.tar.gz")
    first_bytes = first.read_bytes()
    second = _package(tmp_path, "second.tar.gz")

    assert first_bytes == second.read_bytes()


def test_server_release_rejects_a_wheel_from_another_version(tmp_path: Path) -> None:
    wheel = tmp_path / "aurora-2.3.3-py3-none-any.whl"
    wheel.write_bytes(b"wrong release")

    result = subprocess.run(
        [
            "node",
            str(SCRIPT),
            "--version",
            "2.3.4",
            "--wheel",
            str(wheel),
            "--output",
            str(tmp_path / "server.tar.gz"),
            "--report",
            str(tmp_path / "server.json"),
        ],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "does not match release version" in result.stderr

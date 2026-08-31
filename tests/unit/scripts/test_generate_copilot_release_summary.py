from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts/generate_copilot_release_summary.mjs"


def test_invokes_copilot_with_the_restricted_release_prompt(tmp_path: Path) -> None:
    executable = tmp_path / "bin/copilot"
    executable.parent.mkdir()
    executable.write_text(
        "#!/bin/sh\n"
        'printf \'%s\\n\' "$@" > "$COPILOT_ARGS_FILE"\n'
        "printf '%s\\n' 'Aurora 2.0 expands the product across local and connected surfaces.'\n"
        "printf '%s\\n' ''\n"
        "printf '%s\\n' '- Adds desktop, mobile, and hosted application experiences.'\n"
        "printf '%s\\n' '- Strengthens service isolation and release packaging.'\n"
        "printf '%s\\n' '- Improves server deployment and operational controls.'\n"
        "printf '%s\\n' '- Expands local speech recognition and voice choices.'\n"
        "printf '%s\\n' '- Tightens authentication and device security.'\n"
        "printf '%s\\n' '- Improves installation across supported platforms.'\n",
        encoding="utf-8",
    )
    executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
    context = tmp_path / "context.md"
    context.write_text("# Untrusted commit subjects\n", encoding="utf-8")
    output = tmp_path / "summary.md"
    args_file = tmp_path / "args.txt"
    environment = {
        **os.environ,
        "PATH": f"{executable.parent}{os.pathsep}{os.environ['PATH']}",
        "COPILOT_ARGS_FILE": str(args_file),
    }

    result = subprocess.run(
        [
            "node",
            str(SCRIPT),
            "--version",
            "2.0.0",
            "--context",
            str(context),
            "--output",
            str(output),
        ],
        cwd=REPO_ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert output.read_text(encoding="utf-8").startswith("Aurora 2.0 expands")
    arguments = args_file.read_text(encoding="utf-8").splitlines()
    assert str(context.resolve()) in arguments
    assert "Aurora 2.0.0 release" in " ".join(arguments)
    assert "long_context" in arguments
    assert "view" in arguments
    assert "shell,write,url,memory" in arguments
    assert "--allow-all-tools" in arguments
    assert "--allow-all" not in arguments
    assert "--yolo" not in arguments

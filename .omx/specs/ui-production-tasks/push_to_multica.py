#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

PROJECT_ID = "5345dd7c-2f0b-4a4b-b636-c1db93067f0a"
ROOT = Path(__file__).resolve().parent
TASKS_DIR = ROOT / "tasks"
OUT = ROOT / "created-issues.json"
STATUS = "blocked"

EPIC_TITLE = "[UI][EPIC] Multi-platform UI production implementation after mesh integration"
EPIC_FILE = ROOT / "ui-production-epic.md"
EPIC_BODY = """# [UI][EPIC] Multi-platform UI production implementation after mesh integration

## Branch and sequencing policy

- **Target branch:** `feat/ui-multi-platform-integration`.
- Do not start this UI implementation epic until all mesh production gap tasks are complete through `MESH-GAP-011` and `MESH-GAP-012` refreshes UI/SDK specs against the final backend contracts.
- Create `feat/ui-multi-platform-integration` from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks are pushed now only to preserve ordering and planning context; they must remain blocked until the mesh sequence is accepted.

## Source documents

- `.omx/specs/ui-production-tasks/index.md`
- `.omx/specs/ui-production-tasks/manifest.md`
- `.omx/specs/ui-production-tasks/backend-gap-crosswalk.md`
- `.omx/specs/ui-refinement/`
- `modules/ui-mock-reference/`

## Mesh gate

Required completed prerequisites before unblocking:

- `PER-152` / `MESH-GAP-EPIC` accepted.
- `PER-163` / `MESH-GAP-011` production two-peer E2E harness accepted.
- `PER-164` / `MESH-GAP-012` UI/SDK spec refresh accepted.
"""


def run(cmd: list[str]) -> dict:
    proc = subprocess.run(cmd, text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"command failed {' '.join(cmd)}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    return json.loads(proc.stdout or "{}")


def find_existing(title: str) -> dict | None:
    data = run(["multica", "issue", "search", title, "--include-closed", "--limit", "20", "--output", "json"])
    for issue in data.get("issues", []):
        if issue.get("title") == title and issue.get("project_id") == PROJECT_ID:
            return issue
    return None


def create_or_get(title: str, desc_file: Path, parent: str | None = None, status: str = STATUS) -> dict:
    existing = find_existing(title)
    if existing:
        return {"action": "existing", **existing}
    cmd = [
        "multica", "issue", "create",
        "--project", PROJECT_ID,
        "--title", title,
        "--description-file", str(desc_file),
        "--status", status,
        "--output", "json",
    ]
    if parent:
        cmd += ["--parent", parent]
    try:
        created = run(cmd)
    except RuntimeError as exc:
        if "status" in str(exc).lower() and status == "blocked":
            cmd = [part for part in cmd if part not in ["--status", status]]
            created = run(cmd)
            created["status_note"] = "blocked status rejected; created with default status"
        else:
            raise
    return {"action": "created", **created}


def title_from_task(path: Path) -> str:
    first = path.read_text().splitlines()[0].strip()
    if first.startswith("# "):
        return first[2:].strip()
    return path.stem


def task_id_from_title(title: str) -> str:
    m = re.match(r"([A-Z]+-\d+)", title)
    return m.group(1) if m else title.split(" — ")[0]


def main() -> int:
    EPIC_FILE.write_text(EPIC_BODY)
    epic = create_or_get(EPIC_TITLE, EPIC_FILE, parent=None, status=STATUS)
    parent_id = epic["id"]
    records = [{"task_id": "UI-EPIC", "title": EPIC_TITLE, "issue": epic}]
    for path in sorted(TASKS_DIR.glob("*.md")):
        title = title_from_task(path)
        issue = create_or_get(title, path, parent=parent_id, status=STATUS)
        task_id = task_id_from_title(title)
        print(f"{issue['action']}: {task_id} -> {issue.get('identifier')} {issue.get('status')}")
        records.append({"task_id": task_id, "title": title, "path": str(path), "issue": issue})
    OUT.write_text(json.dumps({"project_id": PROJECT_ID, "issues": records}, indent=2, sort_keys=True)+"\n")
    print(f"wrote {OUT}")
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)

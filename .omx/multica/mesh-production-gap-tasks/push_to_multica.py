#!/usr/bin/env python3
"""Push mesh production gap task Markdown files into Multica.

Idempotent by exact title search. Creates the epic first, then child tasks under it.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

PROJECT_ID = "5345dd7c-2f0b-4a4b-b636-c1db93067f0a"
ROOT = Path(__file__).resolve().parent
INDEX = ROOT / "task-index.json"
OUT = ROOT / "created-issues.json"


def run(cmd: list[str]) -> dict:
    proc = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if proc.returncode != 0:
        print("COMMAND FAILED:", " ".join(cmd), file=sys.stderr)
        print(proc.stdout, file=sys.stderr)
        print(proc.stderr, file=sys.stderr)
        raise SystemExit(proc.returncode)
    out = proc.stdout.strip()
    if not out:
        return {}
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        print("NON-JSON OUTPUT from", cmd, file=sys.stderr)
        print(out, file=sys.stderr)
        raise


def find_existing(title: str) -> dict | None:
    data = run(["multica", "issue", "search", title, "--include-closed", "--limit", "20", "--output", "json"])
    issues = data.get("issues", [])
    for issue in issues:
        if issue.get("title") == title and issue.get("project_id") == PROJECT_ID:
            return issue
    return None


def create_issue(task: dict, parent_id: str | None = None) -> dict:
    title = task["title"]
    existing = find_existing(title)
    if existing:
        return {"action": "existing", **existing}
    desc_file = Path(task["description_file"])
    if not desc_file.is_absolute():
        desc_file = Path.cwd() / desc_file
    cmd = [
        "multica", "issue", "create",
        "--project", PROJECT_ID,
        "--title", title,
        "--description-file", str(desc_file),
        "--output", "json",
    ]
    if parent_id:
        cmd += ["--parent", parent_id]
    created = run(cmd)
    return {"action": "created", **created}


def main() -> int:
    tasks = json.loads(INDEX.read_text())
    created: list[dict] = []
    epic = tasks[0]
    if epic["id"] != "MESH-GAP-EPIC":
        raise SystemExit("first index entry must be MESH-GAP-EPIC")
    epic_issue = create_issue(epic)
    created.append({"task_id": epic["id"], "title": epic["title"], "issue": epic_issue})
    parent_id = epic_issue["id"]
    for task in tasks[1:]:
        issue = create_issue(task, parent_id=parent_id)
        created.append({"task_id": task["id"], "title": task["title"], "issue": issue})
        print(f"{issue['action']}: {task['id']} -> {issue.get('identifier')} {issue.get('id')}")
    OUT.write_text(json.dumps({"project_id": PROJECT_ID, "issues": created}, indent=2, sort_keys=True) + "\n")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

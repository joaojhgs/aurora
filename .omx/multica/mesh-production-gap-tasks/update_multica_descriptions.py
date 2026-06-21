#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT_ID = "5345dd7c-2f0b-4a4b-b636-c1db93067f0a"
INDEX = {item["id"]: item for item in json.loads((ROOT / "task-index.json").read_text())}
CREATED = json.loads((ROOT / "created-issues.json").read_text())["issues"]

for item in CREATED:
    task_id = item["task_id"]
    issue_id = item["issue"]["id"]
    desc_file = INDEX[task_id]["description_file"]
    cmd = [
        "multica", "issue", "update", issue_id,
        "--project", PROJECT_ID,
        "--description-file", desc_file,
        "--output", "json",
    ]
    proc = subprocess.run(cmd, text=True, capture_output=True)
    if proc.returncode != 0:
        print(proc.stdout, file=sys.stderr)
        print(proc.stderr, file=sys.stderr)
        raise SystemExit(proc.returncode)
    data = json.loads(proc.stdout)
    print(f"updated {task_id} {data.get('identifier')} {data.get('status')}")

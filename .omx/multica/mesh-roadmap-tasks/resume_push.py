#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

PROJECT_ID = "5345dd7c-2f0b-4a4b-b636-c1db93067f0a"
OUT = Path(".omx/multica/mesh-roadmap-tasks")
INDEX = json.loads((OUT / "task-index.json").read_text())


def run(cmd: list[str], timeout: int = 30, allow_timeout: bool = False):
    proc = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout)
    if proc.returncode != 0:
        if allow_timeout and proc.returncode == 124:
            return {"timeout": True, "stdout": proc.stdout, "stderr": proc.stderr}
        raise RuntimeError(f"Command failed ({proc.returncode}): {' '.join(cmd)}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    out = proc.stdout.strip()
    if not out:
        return ""
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return out


def sh(cmd: str, timeout: int = 15):
    # Use coreutils timeout so hung multica label-add cannot block the whole run.
    return subprocess.run(["bash", "-lc", f"timeout {timeout}s {cmd}"], text=True, capture_output=True)

labels = run(["multica", "label", "list", "--output", "json"], timeout=30)
label_by_name = {l["name"]: l for l in labels}

def ensure_labels(label_names: list[str]) -> None:
    global label_by_name
    existing = set(label_by_name)
    missing = [x for x in label_names if x not in existing]
    if missing:
        raise RuntimeError(f"Missing labels unexpectedly: {missing}")

def list_issues():
    data = run(["multica", "issue", "list", "--project", PROJECT_ID, "--limit", "100", "--output", "json"], timeout=30)
    return data["issues"] if isinstance(data, dict) and "issues" in data else data

issues = list_issues()
issue_by_title = {i["title"]: i for i in issues}
parent_id = issue_by_title.get("[MESH][EPIC] Mesh polishing roadmap: secure cross-peer service fabric", {}).get("id")
created_or_found = []

for item in INDEX:
    ensure_labels(item["labels"])
    issue = issue_by_title.get(item["title"])
    if not issue:
        cmd = [
            "multica", "issue", "create",
            "--project", PROJECT_ID,
            "--title", item["title"],
            "--description-file", item["description_file"],
            "--allow-duplicate",
            "--output", "json",
        ]
        if parent_id and item["phase"] != "EPIC":
            cmd.extend(["--parent", parent_id])
        issue = run(cmd, timeout=45)
        # Refresh parent ID immediately after creating epic.
        if item["phase"] == "EPIC":
            parent_id = issue["id"]
        issue_by_title[item["title"]] = issue
        time.sleep(0.2)
    elif item["phase"] == "EPIC":
        parent_id = issue["id"]

    # Ensure child parent if it was created during interrupted run without parent is unlikely, but update if needed.
    if item["phase"] != "EPIC" and parent_id and issue.get("parent_issue_id") != parent_id:
        try:
            issue = run(["multica", "issue", "update", issue["id"], "--parent", parent_id, "--output", "json"], timeout=30)
        except Exception:
            pass

    # Label add can hang even after success. Only add labels not already present; then verify.
    current_label_names = {l["name"] for l in issue.get("labels", [])}
    for name in item["labels"]:
        if name in current_label_names:
            continue
        label_id = label_by_name[name]["id"]
        # use table output; let timeout kill if command hangs after server-side mutation
        sh(f"multica issue label add {issue['id']} {label_id} --output table", timeout=12)
        time.sleep(0.1)
        # refresh current issue labels to avoid duplicate attempts
        try:
            refreshed = run(["multica", "issue", "get", issue["id"], "--output", "json"], timeout=30)
            issue = refreshed
            current_label_names = {l["name"] for l in issue.get("labels", [])}
        except Exception:
            pass

    created_or_found.append({
        "title": item["title"],
        "id": issue["id"],
        "identifier": issue.get("identifier"),
        "phase": item["phase"],
        "labels_expected": item["labels"],
        "labels_actual": sorted({l["name"] for l in issue.get("labels", [])}),
        "parent_issue_id": issue.get("parent_issue_id"),
    })

# Final verification refresh.
final_issues = list_issues()
mesh_issues = [i for i in final_issues if i["title"].startswith("[MESH]")]
mesh_issues_sorted = sorted(mesh_issues, key=lambda x: x["title"])
summary = {
    "project_id": PROJECT_ID,
    "parent_id": parent_id,
    "expected_count": len(INDEX),
    "mesh_issue_count": len(mesh_issues),
    "issues": [
        {
            "identifier": i.get("identifier"),
            "id": i["id"],
            "title": i["title"],
            "labels": sorted([l["name"] for l in i.get("labels", [])]),
            "parent_issue_id": i.get("parent_issue_id"),
        }
        for i in mesh_issues_sorted
    ],
}
(OUT / "created-issues.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
print(json.dumps(summary, indent=2))

#!/usr/bin/env bash
# Same data source as tilt-mcp tool `get_all_resources`: `tilt get uiresource -o json`.
# Requires: `tilt up` (or `tilt ci`) running in another terminal; `tilt` on PATH.
set -euo pipefail
export PATH="$(cd "$(dirname "$0")/.." && pwd)/scripts:${PATH}"
if ! command -v tilt >/dev/null 2>&1; then
  echo "tilt: command not found" >&2
  exit 1
fi
tilt get uiresource -o json | python3 -c '
import json, sys
data = json.load(sys.stdin)
items = data.get("items", [])
rows = []
for item in items:
    md = item.get("metadata", {}) or {}
    st = item.get("status", {}) or {}
    if (st.get("disableStatus") or {}).get("state") == "Disabled":
        continue
    rows.append({
        "name": md.get("name"),
        "type": md.get("labels", {}).get("type", "unknown"),
        "runtimeStatus": st.get("runtimeStatus", "unknown"),
        "updateStatus": st.get("updateStatus", "unknown"),
    })
print(json.dumps(rows, indent=2))
print(f"\nTotal enabled UI resources: {len(rows)}", file=sys.stderr)
'

#!/usr/bin/env bash
set -euo pipefail

REQUIRE_ALL_BROWSERS="${WEBRTC_INTEROP_REQUIRE_ALL_BROWSERS:-0}"

record_unavailable_browser() {
  local artifact_dir="$1"
  local browser="$2"
  local reason="$3"
  local executable="${4:-}"
  local status="skipped"

  if [[ "$REQUIRE_ALL_BROWSERS" == "1" ]]; then
    status="failed"
  fi

  mkdir -p "$artifact_dir"
  cat > "$artifact_dir/report.json" <<JSON
{
  "schema": "aurora.webrtc_interop.browser_matrix.skip.v1",
  "lane": "direct",
  "browserName": "$browser",
  "status": "$status",
  "reason": "$reason",
  "executable": "$executable"
}
JSON

  if [[ "$REQUIRE_ALL_BROWSERS" == "1" ]]; then
    echo "Required $browser WebRTC interop is unavailable: $reason" >&2
    return 1
  fi

  echo "Skipping $browser WebRTC interop: $reason" >&2
}

scripts/webrtc_interop_services.sh up
WEBRTC_INTEROP_BROWSER=chromium scripts/webrtc_interop.sh direct

for browser in firefox webkit; do
  executable="$(node --input-type=module -e "import { ${browser} } from '@playwright/test'; process.stdout.write(${browser}.executablePath())")"
  if [[ ! -x "$executable" ]]; then
    artifact_dir="${WEBRTC_INTEROP_ARTIFACT_DIR:-reports/webrtc-interop}/${browser}-direct"
    record_unavailable_browser \
      "$artifact_dir" \
      "$browser" \
      "Playwright browser executable is not installed" \
      "$executable"
    continue
  fi
  artifact_dir="reports/webrtc-interop/${browser}-direct"
  if ! WEBRTC_INTEROP_BROWSER="$browser" WEBRTC_INTEROP_ARTIFACT_DIR="$artifact_dir" scripts/webrtc_interop.sh direct; then
    report="$artifact_dir/browser-report.json"
    if [[ -f "$report" ]] && grep -Eq "Executable doesn't exist|Host system is missing dependencies" "$report"; then
      record_unavailable_browser \
        "$artifact_dir" \
        "$browser" \
        "Playwright browser runtime is unavailable in this environment" \
        "$executable"
      continue
    fi
    exit 1
  fi
done

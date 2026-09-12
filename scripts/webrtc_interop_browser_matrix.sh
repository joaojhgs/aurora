#!/usr/bin/env bash
set -euo pipefail

REQUIRE_ALL_BROWSERS="${WEBRTC_INTEROP_REQUIRE_ALL_BROWSERS:-0}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aurora-webrtc-browser-matrix}"

record_unavailable_browser() {
  local artifact_dir="$1"
  local browser="$2"
  local lane="$3"
  local reason="$4"
  local executable="${5:-}"
  local status="skipped"

  if [[ "$REQUIRE_ALL_BROWSERS" == "1" ]]; then
    status="failed"
  fi

  mkdir -p "$artifact_dir"
  cat > "$artifact_dir/report.json" <<JSON
{
  "schema": "aurora.webrtc_interop.browser_matrix.skip.v1",
  "lane": "$lane",
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

cleanup() {
  scripts/webrtc_interop_services.sh down
}

trap cleanup EXIT INT TERM
scripts/webrtc_interop_services.sh up

for browser in chromium firefox webkit; do
  executable="$(node --input-type=module -e "import { ${browser} } from '@playwright/test'; process.stdout.write(${browser}.executablePath())")"
  if [[ ! -x "$executable" ]]; then
    for lane in direct stun turn; do
      prefix="${browser}-"
      if [[ "$browser" == "chromium" ]]; then
        prefix=""
      fi
      artifact_dir="${WEBRTC_INTEROP_ARTIFACT_DIR:-reports/webrtc-interop}/${prefix}${lane}"
      record_unavailable_browser \
        "$artifact_dir" \
        "$browser" \
        "$lane" \
        "Playwright browser executable is not installed" \
        "$executable"
    done
    continue
  fi
  for lane in direct stun turn; do
    prefix="${browser}-"
    if [[ "$browser" == "chromium" ]]; then
      prefix=""
    fi
    artifact_dir="${WEBRTC_INTEROP_ARTIFACT_DIR:-reports/webrtc-interop}/${prefix}${lane}"
    if ! WEBRTC_INTEROP_BROWSER="$browser" WEBRTC_INTEROP_ARTIFACT_DIR="$artifact_dir" scripts/webrtc_interop.sh "$lane"; then
      report="$artifact_dir/browser-report.json"
      if [[ -f "$report" ]] && grep -Eq "Executable doesn't exist|Host system is missing dependencies" "$report"; then
        record_unavailable_browser \
          "$artifact_dir" \
          "$browser" \
          "$lane" \
          "Playwright browser runtime is unavailable in this environment" \
          "$executable"
        continue
      fi
      exit 1
    fi
  done
done

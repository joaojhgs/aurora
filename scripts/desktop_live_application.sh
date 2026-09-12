#!/usr/bin/env bash
set -euo pipefail

: "${AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE:?application PID file is required}"
: "${AURORA_DESKTOP_LIVE_E2E_APPLICATION_BIN:?desktop client binary is required}"

desktop_pid_dir="$(dirname -- "$AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE")"
mkdir -p "$desktop_pid_dir"
printf '%s\n' "$$" >"$AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE"

exec "$AURORA_DESKTOP_LIVE_E2E_APPLICATION_BIN" "$@"

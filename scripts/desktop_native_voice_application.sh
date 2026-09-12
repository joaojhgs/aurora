#!/usr/bin/env bash
set -euo pipefail

: "${AURORA_DESKTOP_NATIVE_VOICE_E2E_APP_PID_FILE:?application PID file is required}"
: "${AURORA_DESKTOP_NATIVE_VOICE_E2E_ARTIFACT_DIR:?artifact directory is required}"
: "${AURORA_DESKTOP_NATIVE_VOICE_E2E_APPLICATION_BIN:?desktop client binary is required}"

desktop_pid_dir="$(dirname -- "$AURORA_DESKTOP_NATIVE_VOICE_E2E_APP_PID_FILE")"
mkdir -p "$desktop_pid_dir"
printf '%s\n' "$$" >"$AURORA_DESKTOP_NATIVE_VOICE_E2E_APP_PID_FILE"

{
  printf 'DISPLAY=%s\n' "${DISPLAY:-}"
  printf 'XAUTHORITY=%s\n' "${XAUTHORITY:-}"
} >"$AURORA_DESKTOP_NATIVE_VOICE_E2E_ARTIFACT_DIR/desktop-native-voice-application-env.txt"

exec "$AURORA_DESKTOP_NATIVE_VOICE_E2E_APPLICATION_BIN" "$@"

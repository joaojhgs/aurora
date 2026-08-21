#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

artifact_dir="${AURORA_DESKTOP_NATIVE_VOICE_E2E_ARTIFACT_DIR:-$repo_root/reports/desktop-native-voice-e2e}"
platform="$(uname -s)"
webdriver_provider="${AURORA_DESKTOP_NATIVE_VOICE_E2E_WEBDRIVER_PROVIDER:-official}"
driver_bin="${AURORA_DESKTOP_NATIVE_VOICE_E2E_TAURI_DRIVER_BIN:-tauri-driver}"
display_probe_bin="${AURORA_DESKTOP_NATIVE_VOICE_E2E_DISPLAY_PROBE_BIN:-xdpyinfo}"
alsa_config_path="${AURORA_DESKTOP_NATIVE_VOICE_E2E_ALSA_CONFIG_PATH:-$repo_root/tests/e2e/desktop_native_voice/alsa-null.conf}"
application_bin="${AURORA_DESKTOP_NATIVE_VOICE_E2E_APPLICATION_BIN:-$repo_root/apps/aurora-tauri/src-tauri/target/debug/aurora-tauri}"
application_wrapper="$repo_root/scripts/desktop_native_voice_application.sh"
app_pid_file="${AURORA_DESKTOP_NATIVE_VOICE_E2E_APP_PID_FILE:-$artifact_dir/desktop-native-voice-application.pid}"
sidecar_pid_file="${AURORA_DESKTOP_NATIVE_VOICE_E2E_SIDECAR_PID_FILE:-$artifact_dir/desktop-native-voice-sidecar.pid}"
driver_log="$artifact_dir/webdriver.log"
frontend_dist="$repo_root/apps/aurora-tauri/dist"
driver_pid=""

read_application_pid() {
  read_pid_file "$app_pid_file"
}

read_sidecar_pid() {
  read_pid_file "$sidecar_pid_file"
}

read_pid_file() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    return 1
  fi
  local pid
  pid="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[1-9][0-9]{0,19}$ ]]; then
    printf '%s\n' "$pid"
    return 0
  fi
  return 1
}

wait_for_pid_exit() {
  local pid="$1"
  local attempts="${2:-100}"
  local delay="${3:-0.05}"
  for _ in $(seq 1 "$attempts"); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

cleanup() {
  local application_pid=""
  application_pid="$(read_application_pid || true)"
  if [[ -n "$application_pid" ]] && kill -0 "$application_pid" 2>/dev/null; then
    kill "$application_pid" 2>/dev/null || true
    if ! wait_for_pid_exit "$application_pid" 100 0.05; then
      kill -9 "$application_pid" 2>/dev/null || true
      wait_for_pid_exit "$application_pid" 100 0.05 || true
    fi
  fi
  local sidecar_pid=""
  sidecar_pid="$(read_sidecar_pid || true)"
  if [[ -n "$sidecar_pid" ]] && kill -0 "$sidecar_pid" 2>/dev/null; then
    kill "$sidecar_pid" 2>/dev/null || true
    if ! wait_for_pid_exit "$sidecar_pid" 100 0.05; then
      kill -9 "$sidecar_pid" 2>/dev/null || true
      wait_for_pid_exit "$sidecar_pid" 100 0.05 || true
    fi
  fi
  if [[ -n "$driver_pid" ]] && kill -0 "$driver_pid" 2>/dev/null; then
    kill "$driver_pid" 2>/dev/null || true
    wait "$driver_pid" 2>/dev/null || true
  fi
  if [[ "${AURORA_DESKTOP_NATIVE_VOICE_E2E_KEEP_DIST:-0}" != "1" && -d "$frontend_dist" ]]; then
    find "$frontend_dist" -type f -delete 2>/dev/null || true
    find "$frontend_dist" -depth -type d -empty -delete 2>/dev/null || true
  fi
  rm -f "$app_pid_file" "$sidecar_pid_file"
}
trap cleanup EXIT INT TERM

display_is_available() {
  [[ -n "${DISPLAY:-}" ]] || return 1
  command -v "$display_probe_bin" >/dev/null 2>&1 || return 1
  "$display_probe_bin" -display "$DISPLAY" >/dev/null 2>&1
}

if [[ "${AURORA_DESKTOP_NATIVE_VOICE_E2E_PROBE_DISPLAY_ONLY:-0}" == "1" ]]; then
  if [[ "$platform" == "Linux" ]] && display_is_available; then
    echo "available"
  else
    echo "unavailable"
  fi
  exit 0
fi

if [[ "$webdriver_provider" != "official" ]]; then
  echo "desktop native voice E2E currently supports the official tauri-driver provider" >&2
  exit 2
fi

if [[ "${AURORA_DESKTOP_NATIVE_VOICE_E2E:-0}" != "1" ]]; then
  node tests/e2e/desktop_native_voice/desktop-native-voice-e2e.mjs --check-only "$@"
  exit 0
fi

if [[ "$platform" == "Linux" && "${AURORA_DESKTOP_NATIVE_VOICE_E2E_UNDER_XVFB:-0}" != "1" ]]; then
  if ! display_is_available; then
    if ! command -v xvfb-run >/dev/null 2>&1; then
      echo "desktop native voice E2E requires xvfb-run when DISPLAY is unavailable" >&2
      exit 2
    fi
    exec env -u DISPLAY -u XAUTHORITY AURORA_DESKTOP_NATIVE_VOICE_E2E_UNDER_XVFB=1 \
      xvfb-run -a "$repo_root/scripts/desktop_native_voice_e2e.sh" "$@"
  fi
fi

if ! command -v "$driver_bin" >/dev/null 2>&1; then
  echo "desktop native voice E2E requires tauri-driver" >&2
  exit 2
fi
if [[ "$platform" == "Linux" ]] && ! command -v WebKitWebDriver >/dev/null 2>&1; then
  echo "desktop native voice E2E requires WebKitWebDriver" >&2
  exit 2
fi
if [[ "$platform" == "Linux" ]]; then
  if [[ ! -f "$alsa_config_path" ]]; then
    echo "desktop native voice E2E ALSA configuration is missing: $alsa_config_path" >&2
    exit 2
  fi
  export ALSA_CONFIG_PATH="$alsa_config_path"
fi

mkdir -p "$artifact_dir"
rm -f "$app_pid_file" "$sidecar_pid_file" "$driver_log"

if [[ "${AURORA_DESKTOP_NATIVE_VOICE_E2E_SKIP_BUILD:-0}" != "1" ]]; then
  AURORA_TAURI_DEV_AUTOSIDECAR=0 \
    VITE_AURORA_DESKTOP_NATIVE_VOICE_E2E=1 \
    VITE_AURORA_TAURI_DEV_AUTOSIDECAR=0 \
    pnpm --filter @aurora/tauri-ui tauri build --config src-tauri/tauri.desktop-native-voice-e2e.conf.json --debug --no-bundle --features desktop-native-voice-e2e
fi

if [[ ! -x "$application_bin" ]]; then
  echo "desktop native voice E2E application binary is missing or not executable: $application_bin" >&2
  exit 2
fi

webdriver_port="${AURORA_DESKTOP_NATIVE_VOICE_E2E_WEBDRIVER_PORT:-}"
if [[ -z "$webdriver_port" ]]; then
  webdriver_port="$(
    node -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'
  )"
fi
webdriver_url="http://127.0.0.1:$webdriver_port"
gateway_port="${AURORA_DESKTOP_NATIVE_VOICE_E2E_GATEWAY_PORT:-}"
if [[ -z "$gateway_port" ]]; then
  gateway_port="$(
    node -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'
  )"
fi
gateway_url="http://127.0.0.1:$gateway_port"

export AURORA_DESKTOP_NATIVE_VOICE_E2E=1
export AURORA_TAURI_DEV_AUTOSIDECAR=0
export VITE_AURORA_DESKTOP_NATIVE_VOICE_E2E=1
export VITE_AURORA_TAURI_DEV_AUTOSIDECAR=0
export AURORA_GATEWAY_URL="$gateway_url"
export AURORA_DESKTOP_NATIVE_VOICE_E2E_GATEWAY_PORT="$gateway_port"
export AURORA_DESKTOP_NATIVE_VOICE_E2E_APPLICATION="$application_wrapper"
export AURORA_DESKTOP_NATIVE_VOICE_E2E_APPLICATION_BIN="$application_bin"
export AURORA_DESKTOP_NATIVE_VOICE_E2E_APP_PID_FILE="$app_pid_file"
export AURORA_DESKTOP_NATIVE_VOICE_E2E_SIDECAR_PID_FILE="$sidecar_pid_file"
export AURORA_DESKTOP_LIVE_E2E_APPLICATION_BIN="$application_bin"
export AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE="$app_pid_file"
export AURORA_DESKTOP_NATIVE_VOICE_E2E_ARTIFACT_DIR="$artifact_dir"
export AURORA_DESKTOP_NATIVE_VOICE_E2E_WEBDRIVER_URL="$webdriver_url"
export AURORA_TAURI_SIDECAR_PROGRAM="$(command -v node)"
export AURORA_TAURI_SIDECAR_ARGS="$repo_root/tests/e2e/desktop_native_voice/sidecar-sentinel.mjs"
export AURORA_TAURI_SIDECAR_CWD="$repo_root"

"$driver_bin" --port "$webdriver_port" >"$driver_log" 2>&1 &
driver_pid="$!"

ready=0
for _ in $(seq 1 200); do
  if ! kill -0 "$driver_pid" 2>/dev/null; then
    echo "tauri-driver exited before accepting sessions" >&2
    tail -100 "$driver_log" >&2 || true
    exit 2
  fi
  if curl --silent --show-error --fail "$webdriver_url/status" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
if [[ "$ready" != "1" ]]; then
  echo "timed out waiting for tauri-driver on $webdriver_url" >&2
  tail -100 "$driver_log" >&2 || true
  exit 2
fi

node tests/e2e/desktop_native_voice/desktop-native-voice-e2e.mjs "$@"

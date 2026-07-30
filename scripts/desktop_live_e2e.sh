#!/usr/bin/env bash
set -euo pipefail

desktop_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$desktop_repo_root"

desktop_artifact_dir="${AURORA_DESKTOP_LIVE_E2E_ARTIFACT_DIR:-$desktop_repo_root/reports/desktop-live-e2e}"
desktop_driver_bin="${AURORA_DESKTOP_LIVE_E2E_TAURI_DRIVER_BIN:-tauri-driver}"
desktop_application_bin="${AURORA_DESKTOP_LIVE_E2E_APPLICATION_BIN:-$desktop_repo_root/apps/aurora-tauri/src-tauri/target/debug/aurora-tauri}"
desktop_application_wrapper="$desktop_repo_root/scripts/desktop_live_application.sh"
desktop_app_pid_file="${AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE:-$desktop_artifact_dir/desktop-application.pid}"
desktop_driver_log="$desktop_artifact_dir/tauri-driver.log"
desktop_frontend_dist="$desktop_repo_root/apps/aurora-tauri/dist"
desktop_driver_pid=""

cleanup_desktop_driver() {
  if [[ -n "$desktop_driver_pid" ]] && kill -0 "$desktop_driver_pid" 2>/dev/null; then
    kill "$desktop_driver_pid" 2>/dev/null || true
    wait "$desktop_driver_pid" 2>/dev/null || true
  fi
  if [[ "${AURORA_DESKTOP_LIVE_E2E_KEEP_DIST:-0}" != "1" && -d "$desktop_frontend_dist" ]]; then
    find "$desktop_frontend_dist" -type f -delete 2>/dev/null || true
    find "$desktop_frontend_dist" -depth -type d -empty -delete 2>/dev/null || true
  fi
}
trap cleanup_desktop_driver EXIT INT TERM

if [[ "$(uname -s)" == "Linux" && -z "${DISPLAY:-}" && "${AURORA_DESKTOP_LIVE_E2E_UNDER_XVFB:-0}" != "1" ]]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "desktop live E2E requires xvfb-run when DISPLAY is unavailable" >&2
    exit 2
  fi
  exec env AURORA_DESKTOP_LIVE_E2E_UNDER_XVFB=1 xvfb-run -a "$0" "$@"
fi

if ! command -v "$desktop_driver_bin" >/dev/null 2>&1; then
  echo "desktop live E2E requires tauri-driver; install it with cargo install tauri-driver --locked" >&2
  exit 2
fi
if [[ "$(uname -s)" == "Linux" ]] && ! command -v WebKitWebDriver >/dev/null 2>&1; then
  echo "desktop live E2E requires WebKitWebDriver (webkit2gtk-driver on Debian/Ubuntu)" >&2
  exit 2
fi

mkdir -p "$desktop_artifact_dir"
rm -f "$desktop_app_pid_file" "$desktop_driver_log"

if [[ "${AURORA_DESKTOP_LIVE_E2E_SKIP_BUILD:-0}" != "1" ]]; then
  AURORA_TAURI_DEV_AUTOSIDECAR=0 \
  VITE_AURORA_DESKTOP_LIVE_E2E=1 \
  VITE_AURORA_RUNTIME_MODE=desktop-thin \
  VITE_AURORA_CONNECTION_MODE=webrtc-only \
  VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK=1 \
  VITE_AURORA_DESKTOP_LIVE_E2E_FORCE_NATIVE_WEBRTC=1 \
    pnpm --filter @aurora/tauri-ui tauri build \
      --debug \
      --no-bundle \
      --config src-tauri/tauri.client.conf.json
fi

if [[ ! -x "$desktop_application_bin" ]]; then
  echo "desktop live E2E application binary is missing or not executable: $desktop_application_bin" >&2
  exit 2
fi

desktop_driver_port="${AURORA_DESKTOP_LIVE_E2E_WEBDRIVER_PORT:-}"
if [[ -z "$desktop_driver_port" ]]; then
  desktop_driver_port="$(
    node -e 'const net=require("node:net");const server=net.createServer();server.listen(0,"127.0.0.1",()=>{process.stdout.write(String(server.address().port));server.close()})'
  )"
fi
desktop_webdriver_url="http://127.0.0.1:$desktop_driver_port"

export AURORA_DESKTOP_LIVE_E2E=1
export AURORA_TAURI_DEV_AUTOSIDECAR=0
export VITE_AURORA_DESKTOP_LIVE_E2E_FORCE_NATIVE_WEBRTC=1
export AURORA_DESKTOP_LIVE_E2E_APPLICATION="$desktop_application_wrapper"
export AURORA_DESKTOP_LIVE_E2E_APPLICATION_BIN="$desktop_application_bin"
export AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE="$desktop_app_pid_file"
export AURORA_DESKTOP_LIVE_E2E_ARTIFACT_DIR="$desktop_artifact_dir"
export AURORA_DESKTOP_LIVE_E2E_DRIVER_COMMAND="${AURORA_DESKTOP_LIVE_E2E_DRIVER_COMMAND:-node tests/e2e/desktop_live/desktop-webdriver-driver.mjs}"
export AURORA_DESKTOP_LIVE_E2E_WEBDRIVER_URL="$desktop_webdriver_url"

"$desktop_driver_bin" --port "$desktop_driver_port" >"$desktop_driver_log" 2>&1 &
desktop_driver_pid="$!"

desktop_driver_ready=0
for _ in $(seq 1 100); do
  if ! kill -0 "$desktop_driver_pid" 2>/dev/null; then
    echo "tauri-driver exited before accepting sessions" >&2
    tail -100 "$desktop_driver_log" >&2 || true
    exit 2
  fi
  if (exec 3<>"/dev/tcp/127.0.0.1/$desktop_driver_port") 2>/dev/null; then
    desktop_driver_ready=1
    break
  fi
  sleep 0.1
done
if [[ "$desktop_driver_ready" != "1" ]]; then
  echo "timed out waiting for tauri-driver on $desktop_webdriver_url" >&2
  exit 2
fi

node tests/e2e/desktop_live/desktop-live-e2e.mjs "$@"

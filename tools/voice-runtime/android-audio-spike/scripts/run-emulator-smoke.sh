#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SPIKE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly PACKAGE_NAME="dev.aurora.voice.audiospike"
readonly ACTIVITY="${PACKAGE_NAME}/.MainActivity"

fail() {
  printf '%s\n' "$*" >&2
  exit 2
}

sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[[ -n "${sdk_root}" ]] || fail "Set ANDROID_HOME or ANDROID_SDK_ROOT."
readonly ADB="${ADB_BIN:-${sdk_root}/platform-tools/adb}"
[[ -x "${ADB}" ]] || fail "Missing adb executable: ${ADB}"

"${SCRIPT_DIR}/build-android.sh"

apk="${SPIKE_DIR}/android/app/build/outputs/apk/debug/app-debug.apk"
[[ -f "${apk}" ]] || fail "Missing debug APK: ${apk}"

device="${ANDROID_SERIAL:-}"
if [[ -z "${device}" ]]; then
  device="$("${ADB}" devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
fi
[[ -n "${device}" ]] || fail "No running Android emulator/device found."

"${ADB}" -s "${device}" install -r "${apk}" >/dev/null
"${ADB}" -s "${device}" shell pm grant "${PACKAGE_NAME}" android.permission.RECORD_AUDIO >/dev/null 2>&1 || true
"${ADB}" -s "${device}" logcat -c
"${ADB}" -s "${device}" shell am start -n "${ACTIVITY}" >/dev/null
sleep 3
"${ADB}" -s "${device}" shell am force-stop "${PACKAGE_NAME}" >/dev/null

summary="$("${ADB}" -s "${device}" logcat -d -s AuroraAudioSpike:I '*:S' | tail -n 20)"
printf '%s\n' "${summary}"
printf '%s\n' "${summary}" | grep -q 'synthetic result ok=true' || fail "Synthetic Rust ingestion smoke did not report success."

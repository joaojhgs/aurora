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

if "${ADB}" -s "${device}" install --streaming -r "${apk}" >/dev/null 2>&1; then
  :
elif "${ADB}" -s "${device}" install -r "${apk}" >/dev/null; then
  :
else
  remote_apk="/data/local/tmp/aurora-audio-spike.apk"
  "${ADB}" -s "${device}" push "${apk}" "${remote_apk}" >/dev/null
  "${ADB}" -s "${device}" shell pm install -r "${remote_apk}" >/dev/null
  "${ADB}" -s "${device}" shell rm -f "${remote_apk}" >/dev/null || true
fi
"${ADB}" -s "${device}" shell pm grant "${PACKAGE_NAME}" android.permission.RECORD_AUDIO >/dev/null 2>&1 || true
"${ADB}" -s "${device}" shell am force-stop "${PACKAGE_NAME}" >/dev/null || true
"${ADB}" -s "${device}" logcat -c
"${ADB}" -s "${device}" shell am start -n "${ACTIVITY}" >/dev/null
summary=""
for _attempt in {1..60}; do
  sleep 2
  summary="$("${ADB}" -s "${device}" logcat -d -s AuroraAudioSpike:I '*:S' | tail -n 20)"
  if grep -q 'synthetic result ok=true' <<<"${summary}" && grep -q 'capture result ok=true' <<<"${summary}"; then
    break
  fi
done
"${ADB}" -s "${device}" shell am force-stop "${PACKAGE_NAME}" >/dev/null || true

printf '%s\n' "${summary}"
printf '%s\n' "${summary}" | grep -q 'synthetic result ok=true' || fail "Synthetic Rust ingestion smoke did not report success."
printf '%s\n' "${summary}" | grep -q 'capture result ok=true' || fail "Permission-granted AudioRecord capture did not reach Rust."

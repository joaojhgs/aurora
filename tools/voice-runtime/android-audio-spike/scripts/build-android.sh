#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SPIKE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly ANDROID_DIR="${SPIKE_DIR}/android"

fail() {
  printf '%s\n' "$*" >&2
  exit 2
}

if [[ -z "${ANDROID_HOME:-}" && -z "${ANDROID_SDK_ROOT:-}" ]]; then
  fail "Set ANDROID_HOME or ANDROID_SDK_ROOT."
fi

"${SCRIPT_DIR}/build-rust-android.sh"

GRADLE="${GRADLE_BIN:-}"
if [[ -z "${GRADLE}" ]]; then
  if command -v gradle >/dev/null 2>&1; then
    GRADLE="$(command -v gradle)"
  else
    fail "Set GRADLE_BIN or install gradle on PATH."
  fi
fi

[[ -x "${GRADLE}" ]] || fail "Gradle is not executable: ${GRADLE}"

export ASDF_JAVA_VERSION="${ASDF_JAVA_VERSION:-temurin-17.0.20+8}"
export RUST_TARGET_DIR="${SPIKE_DIR}/native/target"

cd "${ANDROID_DIR}"
"${GRADLE}" --no-daemon :app:assembleDebug

#!/usr/bin/env bash
set -euo pipefail

readonly PINNED_NDK_VERSION="27.0.12077973"
readonly MIN_API="26"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SPIKE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly NATIVE_DIR="${SPIKE_DIR}/native"

fail() {
  printf '%s\n' "$*" >&2
  exit 2
}

resolve_ndk_home() {
  if [[ -n "${ANDROID_NDK_HOME:-}" ]]; then
    printf '%s\n' "${ANDROID_NDK_HOME}"
    return
  fi
  if [[ -n "${ANDROID_NDK_ROOT:-}" ]]; then
    printf '%s\n' "${ANDROID_NDK_ROOT}"
    return
  fi

  local sdk_root=""
  if [[ -n "${ANDROID_HOME:-}" ]]; then
    sdk_root="${ANDROID_HOME}"
  elif [[ -n "${ANDROID_SDK_ROOT:-}" ]]; then
    sdk_root="${ANDROID_SDK_ROOT}"
  fi

  [[ -n "${sdk_root}" ]] || fail "Set ANDROID_NDK_HOME, ANDROID_NDK_ROOT, ANDROID_HOME, or ANDROID_SDK_ROOT."
  printf '%s\n' "${sdk_root}/ndk/${PINNED_NDK_VERSION}"
}

readonly NDK_HOME="$(resolve_ndk_home)"
readonly LLVM_BIN="${NDK_HOME}/toolchains/llvm/prebuilt/linux-x86_64/bin"

[[ -x "${LLVM_BIN}/aarch64-linux-android${MIN_API}-clang" ]] || fail "Missing linker: ${LLVM_BIN}/aarch64-linux-android${MIN_API}-clang"
[[ -x "${LLVM_BIN}/x86_64-linux-android${MIN_API}-clang" ]] || fail "Missing linker: ${LLVM_BIN}/x86_64-linux-android${MIN_API}-clang"

export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="${LLVM_BIN}/aarch64-linux-android${MIN_API}-clang"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="${LLVM_BIN}/x86_64-linux-android${MIN_API}-clang"
export AR_aarch64_linux_android="${LLVM_BIN}/llvm-ar"
export AR_x86_64_linux_android="${LLVM_BIN}/llvm-ar"

cargo +1.88.0 build --manifest-path "${NATIVE_DIR}/Cargo.toml" --target aarch64-linux-android
cargo +1.88.0 build --manifest-path "${NATIVE_DIR}/Cargo.toml" --target x86_64-linux-android

printf 'built Android Rust static libraries:\n'
printf '  %s\n' "${NATIVE_DIR}/target/aarch64-linux-android/debug/libaurora_android_audio_spike.a"
printf '  %s\n' "${NATIVE_DIR}/target/x86_64-linux-android/debug/libaurora_android_audio_spike.a"

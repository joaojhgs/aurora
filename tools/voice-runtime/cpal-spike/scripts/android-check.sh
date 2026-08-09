#!/usr/bin/env bash
set -euo pipefail

readonly PINNED_NDK_VERSION="27.0.12077973"

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

  if [[ -n "${sdk_root}" ]]; then
    printf '%s\n' "${sdk_root}/ndk/${PINNED_NDK_VERSION}"
    return
  fi

  printf 'Set ANDROID_NDK_HOME, ANDROID_NDK_ROOT, ANDROID_HOME, or ANDROID_SDK_ROOT.\n' >&2
  exit 2
}

readonly NDK_HOME="$(resolve_ndk_home)"
readonly LLVM_BIN="${NDK_HOME}/toolchains/llvm/prebuilt/linux-x86_64/bin"

if [[ ! -x "${LLVM_BIN}/aarch64-linux-android26-clang" ]]; then
  printf 'Missing executable linker: %s\n' "${LLVM_BIN}/aarch64-linux-android26-clang" >&2
  exit 2
fi

if [[ ! -x "${LLVM_BIN}/x86_64-linux-android26-clang" ]]; then
  printf 'Missing executable linker: %s\n' "${LLVM_BIN}/x86_64-linux-android26-clang" >&2
  exit 2
fi

export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="${LLVM_BIN}/aarch64-linux-android26-clang"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="${LLVM_BIN}/x86_64-linux-android26-clang"

cargo +1.88.0 check --target aarch64-linux-android
cargo +1.88.0 check --target x86_64-linux-android

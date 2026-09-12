#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SPIKE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly NATIVE_DIR="${SPIKE_DIR}/native"

fail() {
  printf '%s\n' "$*" >&2
  exit 2
}

command -v cargo >/dev/null 2>&1 || fail "Missing cargo on PATH."
[[ "$(uname -s)" == "Darwin" ]] || fail "iOS builds require a macOS runner with Xcode."
command -v xcrun >/dev/null 2>&1 || fail "Missing xcrun; install Xcode before building this spike."

targets=(
  aarch64-apple-ios
  aarch64-apple-ios-sim
  x86_64-apple-ios
)

for target in "${targets[@]}"; do
  if ! rustup target list --installed | grep -qx "${target}"; then
    fail "Install Rust target ${target} before building this spike."
  fi
done

cargo +1.88.0 build --manifest-path "${NATIVE_DIR}/Cargo.toml" --target aarch64-apple-ios --release
cargo +1.88.0 build --manifest-path "${NATIVE_DIR}/Cargo.toml" --target aarch64-apple-ios-sim --release
cargo +1.88.0 build --manifest-path "${NATIVE_DIR}/Cargo.toml" --target x86_64-apple-ios --release

printf 'built iOS Rust static libraries under %s/target\n' "${NATIVE_DIR}"

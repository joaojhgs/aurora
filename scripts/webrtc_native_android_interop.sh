#!/usr/bin/env bash
# Run the real webrtc-rs data-channel stack inside an Android emulator.
#
# The cross-engine interop lanes in webrtc_native_interop.sh prove the same
# dependency/vendor stack against aiortc and Chromium. This companion lane
# proves that stack links, starts, negotiates, and carries Aurora-sized ordered
# data-channel messages under Android's native runtime rather than on the host.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
peer_dir="$repo_root/tests/e2e/webrtc_native_interop/peer"
report_dir="$repo_root/reports/webrtc-native-android"
raw_report="$report_dir/adb-output.log"
json_report="$report_dir/report.json"
remote_bin="/data/local/tmp/aurora-webrtc-interop-peer"

ndk_root="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
if [[ -z "$ndk_root" || ! -d "$ndk_root" ]]; then
  echo "ANDROID_NDK_HOME or ANDROID_NDK_ROOT must name an installed Android NDK" >&2
  exit 64
fi

linker="$(find "$ndk_root/toolchains/llvm/prebuilt" -type f -path '*/bin/x86_64-linux-android24-clang' -print -quit)"
if [[ -z "$linker" ]]; then
  echo "Android x86_64 API 24 linker was not found under $ndk_root" >&2
  exit 66
fi

serial="${ANDROID_SERIAL:-$(adb devices | awk '$2 == "device" { print $1; exit }')}"
if [[ -z "$serial" ]]; then
  echo "No ready Android device was found" >&2
  exit 69
fi

abi="$(adb -s "$serial" shell getprop ro.product.cpu.abi | tr -d '\r')"
if [[ "$abi" != "x86_64" ]]; then
  echo "Android native interop requires an x86_64 emulator, found $abi" >&2
  exit 65
fi

export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$linker"
export CC_x86_64_linux_android="$linker"
export AR_x86_64_linux_android="$(dirname "$linker")/llvm-ar"

mkdir -p "$report_dir"
rm -f "$raw_report" "$json_report"

echo "==> building Android-native webrtc-rs interop peer"
cargo build \
  --locked \
  --manifest-path "$peer_dir/Cargo.toml" \
  --bin aurora-webrtc-interop-peer \
  --target x86_64-linux-android

local_bin="$peer_dir/target/x86_64-linux-android/debug/aurora-webrtc-interop-peer"
adb -s "$serial" push "$local_bin" "$remote_bin" >/dev/null
adb -s "$serial" shell chmod 0755 "$remote_bin"

echo "==> running native WebRTC data-channel self-interop on Android"
adb -s "$serial" shell "$remote_bin" --self-test | tr -d '\r' | tee "$raw_report"

result="$(sed -n 's/^RESULT //p' "$raw_report" | tail -n 1)"
if [[ -z "$result" ]]; then
  echo "Android native interop did not emit a RESULT record" >&2
  exit 1
fi
printf '%s\n' "$result" > "$json_report"
jq -e '
  .status == "passed" and
  .runtimeOs == "android" and
  .nativeAndroid == true and
  .orderedExactEcho == true and
  .largePayloadOk == true and
  .echoed == .expected
' "$json_report" >/dev/null

echo "Android native WebRTC interop passed: $json_report"

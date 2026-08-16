#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
ARTIFACT_ROOT=${AURORA_SHERPA_ANDROID_ARTIFACT_ROOT:-$REPO_ROOT/.artifacts/sherpa-onnx/android-runtime-build}
OUTPUT_ROOT=${AURORA_SHERPA_ANDROID_OUTPUT_ROOT:-$ARTIFACT_ROOT/runtime}
BUILD_JOBS=${AURORA_BUILD_JOBS:-2}

SHERPA_VERSION=1.13.5
SHERPA_ARCHIVE_SHA256=99f520db7364a06be0c174a385d03f9ccdbfe08f61146055229e4a990e285262
SHERPA_ARCHIVE_URL=https://github.com/k2-fsa/sherpa-onnx/archive/refs/tags/v1.13.5.tar.gz
ORT_VERSION=1.27.1
ORT_ARCHIVE_SHA256=defade26209f72cf4fa9769b18052c842833d6bef12924595d26f03b995548ca
ORT_ARCHIVE_URL=https://github.com/csukuangfj/onnxruntime-libs/releases/download/v1.27.1/onnxruntime-android-1.27.1.zip

fail() {
  printf 'Android Sherpa build failed: %s\n' "$*" >&2
  exit 1
}

for command in cmake curl git python3 readelf sha256sum unzip; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

[[ "$BUILD_JOBS" =~ ^[1-9][0-9]*$ ]] || fail "AURORA_BUILD_JOBS must be a positive integer"
[[ "$ARTIFACT_ROOT" != / && -n "$ARTIFACT_ROOT" ]] || fail "artifact root must be a bounded directory"
[[ "$OUTPUT_ROOT" != / && -n "$OUTPUT_ROOT" ]] || fail "output root must be a bounded directory"

ANDROID_NDK_DIR=${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${ANDROID_NDK:-}}}
if [[ -z "$ANDROID_NDK_DIR" ]]; then
  ANDROID_SDK_DIR=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}
  if [[ -n "$ANDROID_SDK_DIR" ]]; then
    ANDROID_NDK_DIR=$ANDROID_SDK_DIR/ndk/27.0.12077973
  fi
fi
[[ -f "$ANDROID_NDK_DIR/build/cmake/android.toolchain.cmake" ]] || fail \
  "set ANDROID_NDK_HOME to Android NDK 27.0.12077973"

if (($# == 0)); then
  SELECTED_ABIS=(arm64-v8a x86_64)
else
  SELECTED_ABIS=("$@")
fi
for abi in "${SELECTED_ABIS[@]}"; do
  [[ "$abi" == arm64-v8a || "$abi" == x86_64 ]] || fail "unsupported ABI: $abi"
done

SOURCE_DIR=$ARTIFACT_ROOT/sources
SHERPA_ARCHIVE=$SOURCE_DIR/sherpa-onnx-v$SHERPA_VERSION.tar.gz
ORT_ARCHIVE=$SOURCE_DIR/onnxruntime-android-$ORT_VERSION.zip
STAGING_ROOT=$ARTIFACT_ROOT/sources/extracted
SHERPA_SOURCE_ROOT=$STAGING_ROOT/sherpa-onnx-$SHERPA_VERSION
ORT_ROOT=$ARTIFACT_ROOT/onnxruntime-android-$ORT_VERSION

mkdir -p "$SOURCE_DIR" "$OUTPUT_ROOT"

download_verified() {
  local url=$1
  local expected_sha=$2
  local destination=$3
  local actual_sha
  local partial

  if [[ -f "$destination" ]]; then
    actual_sha=$(sha256sum "$destination" | awk '{print $1}')
    if [[ "$actual_sha" == "$expected_sha" ]]; then
      return
    fi
    find "$destination" -delete
  fi

  partial=$(mktemp "${destination}.partial.XXXXXX")
  if ! curl --fail --location --retry 3 --silent --show-error "$url" -o "$partial"; then
    find "$partial" -delete
    fail "download failed: $url"
  fi
  actual_sha=$(sha256sum "$partial" | awk '{print $1}')
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    find "$partial" -delete
    fail "SHA-256 mismatch for $url"
  fi
  mv "$partial" "$destination"
}

download_verified "$SHERPA_ARCHIVE_URL" "$SHERPA_ARCHIVE_SHA256" "$SHERPA_ARCHIVE"
download_verified "$ORT_ARCHIVE_URL" "$ORT_ARCHIVE_SHA256" "$ORT_ARCHIVE"

python3 "$SCRIPT_DIR/sherpa-patches/apply_sherpa_patches.py" \
  --archive "$SHERPA_ARCHIVE" \
  --staging-root "$STAGING_ROOT"

if [[ -d "$ORT_ROOT" ]]; then
  find "$ORT_ROOT" -depth -delete
fi
mkdir -p "$ORT_ROOT"
unzip -q "$ORT_ARCHIVE" -d "$ORT_ROOT"
[[ -d "$ORT_ROOT/headers" ]] || fail "ONNX Runtime archive is missing headers"

for abi in "${SELECTED_ABIS[@]}"; do
  ORT_LIB_DIR=$ORT_ROOT/jni/$abi
  BUILD_DIR=$ARTIFACT_ROOT/builds/android-$abi
  INSTALL_DIR=$BUILD_DIR/install
  ABI_OUTPUT_DIR=$OUTPUT_ROOT/$abi

  [[ -f "$ORT_LIB_DIR/libonnxruntime.so" ]] || fail "ONNX Runtime archive is missing $abi"
  if [[ -d "$BUILD_DIR" ]]; then
    find "$BUILD_DIR" -depth -delete
  fi

  SHERPA_ONNXRUNTIME_LIB_DIR=$ORT_LIB_DIR \
  SHERPA_ONNXRUNTIME_INCLUDE_DIR=$ORT_ROOT/headers \
    python3 "$SCRIPT_DIR/run_sherpa_cmake.py" \
      --artifact-root "$ARTIFACT_ROOT" \
      --source-root "$SHERPA_SOURCE_ROOT" \
      --allow-aurora-pockettts-patches \
      -- cmake -S "$SHERPA_SOURCE_ROOT" -B "$BUILD_DIR" \
        -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_DIR/build/cmake/android.toolchain.cmake" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
        -DANDROID_ABI="$abi" \
        -DANDROID_PLATFORM=android-21 \
        -DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON \
        -DBUILD_SHARED_LIBS=ON \
        -DBUILD_PIPER_PHONMIZE_EXE=OFF \
        -DBUILD_PIPER_PHONMIZE_TESTS=OFF \
        -DBUILD_ESPEAK_NG_EXE=OFF \
        -DBUILD_ESPEAK_NG_TESTS=OFF \
        -DSHERPA_ONNX_ENABLE_BINARY=OFF \
        -DSHERPA_ONNX_ENABLE_C_API=ON \
        -DSHERPA_ONNX_ENABLE_CHECK=OFF \
        -DSHERPA_ONNX_ENABLE_JNI=OFF \
        -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
        -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
        -DSHERPA_ONNX_ENABLE_QNN=OFF \
        -DSHERPA_ONNX_ENABLE_RKNN=OFF \
        -DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=OFF \
        -DSHERPA_ONNX_ENABLE_TESTS=OFF \
        -DSHERPA_ONNX_ENABLE_TTS=ON \
        -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF

  cmake --build "$BUILD_DIR" --target install/strip --parallel "$BUILD_JOBS"
  [[ -f "$INSTALL_DIR/lib/libsherpa-onnx-c-api.so" ]] || fail \
    "Sherpa install is missing libsherpa-onnx-c-api.so for $abi"

  mkdir -p "$ABI_OUTPUT_DIR"
  install -m 0755 "$INSTALL_DIR/lib/libsherpa-onnx-c-api.so" "$ABI_OUTPUT_DIR/"
  install -m 0755 "$ORT_LIB_DIR/libonnxruntime.so" "$ABI_OUTPUT_DIR/"

  if grep -aFq 'TTS is not enabled. Please rebuild sherpa-onnx' \
    "$ABI_OUTPUT_DIR/libsherpa-onnx-c-api.so"; then
    fail "Sherpa runtime was built without TTS for $abi"
  fi
  for library in "$ABI_OUTPUT_DIR/libonnxruntime.so" "$ABI_OUTPUT_DIR/libsherpa-onnx-c-api.so"; do
    while read -r alignment; do
      ((alignment >= 0x4000)) || fail "$(basename "$library") is not 16 KiB aligned for $abi"
    done < <(readelf -lW "$library" | awk '$1 == "LOAD" { print $NF }')
  done

  printf 'Prepared patched Android speech runtime: %s\n' "$ABI_OUTPUT_DIR"
done

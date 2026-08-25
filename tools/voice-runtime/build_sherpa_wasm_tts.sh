#!/usr/bin/env bash
# Sequential neutral WASM TTS build for Aurora PocketTTS browser proof.
# Acquire /tmp/aurora-global-build.lock before running.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE="${AURORA_SHERPA_SOURCE_ROOT:-$ROOT/.artifacts/sherpa-onnx/sources/extracted/sherpa-onnx-1.13.5}"
DEST="${AURORA_SHERPA_WASM_TTS_ROOT:-$ROOT/.artifacts/sherpa-onnx/wasm-tts-neutral}"

if [[ ! -f "$SOURCE/build-wasm-simd-tts.sh" ]]; then
  echo "Sherpa source is missing at $SOURCE" >&2
  exit 1
fi

if ! command -v emcc >/dev/null 2>&1; then
  for candidate in \
    "${EMSDK:-}" \
    "$ROOT/.artifacts/sherpa-onnx/emsdk" \
    "$ROOT/tools/emsdk-4.0.23" \
    "/home/developer/projects/aurora/.artifacts/sherpa-onnx/emsdk" \
    "$HOME/emsdk"
  do
    if [[ -n "$candidate" && -f "$candidate/emsdk_env.sh" ]]; then
      # shellcheck disable=SC1091
      source "$candidate/emsdk_env.sh"
      break
    fi
  done
fi

if ! command -v emcc >/dev/null 2>&1; then
  echo "emcc is not on PATH. Install emsdk 4.0.23 and source emsdk_env.sh." >&2
  exit 1
fi

export AURORA_SHERPA_WASM_TTS_NEUTRAL=1
export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
cd "$SOURCE"
bash ./build-wasm-simd-tts.sh

INSTALL_ROOT="$SOURCE/build-wasm-simd-tts/install/bin/wasm/tts"
if [[ -f "$INSTALL_ROOT/sherpa-onnx-wasm-main-tts.data" ]]; then
  echo "neutral WASM TTS must not emit a .data preload" >&2
  exit 1
fi
if ! grep -Eq 'export[[:space:]]+default' "$INSTALL_ROOT/sherpa-onnx-wasm-main-tts.js"; then
  echo "neutral WASM TTS module must export its Emscripten factory" >&2
  exit 1
fi
if ! grep -Fq 'export { createOfflineTts, getDefaultOfflineTtsModelType };' "$INSTALL_ROOT/sherpa-onnx-tts.js"; then
  echo "neutral WASM TTS helper must expose named ES-module exports" >&2
  exit 1
fi

mkdir -p "$DEST"
rm -f "$DEST/sherpa-onnx-wasm-main-tts.data"
cp -f \
  "$INSTALL_ROOT/sherpa-onnx-wasm-main-tts.js" \
  "$INSTALL_ROOT/sherpa-onnx-wasm-main-tts.wasm" \
  "$INSTALL_ROOT/sherpa-onnx-tts.js" \
  "$INSTALL_ROOT/sherpa-onnx-tts.worker.js" \
  "$DEST/"
echo "staged WASM TTS assets in $DEST"

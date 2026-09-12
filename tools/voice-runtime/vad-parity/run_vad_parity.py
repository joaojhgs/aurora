#!/usr/bin/env python3
"""Run native/browser Sherpa Silero VAD parity checks.

Reports are written only under the repository's ignored `.artifacts/` tree.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import mimetypes
import os
import socket
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_REPORT_DIR = REPO_ROOT / ".artifacts" / "voice-runtime" / "vad-parity"
ARTIFACT_ENV = "AURORA_VOICE_P4_ARTIFACT_ROOT"
LIB_DIR_ENV = "AURORA_SHERPA_ONNX_LIB_DIR"
MODEL_ENV = "AURORA_SHERPA_ONNX_MODEL"
WAV_ENV = "AURORA_SHERPA_ONNX_TEST_WAV"

VAD_BUILD = Path("builds/wasm-vad-asr/bin")
VAD_SOURCE = Path("sources/extracted/sherpa-onnx-1.13.5/wasm/vad-asr")
KWS_TEST_WAV = Path(
    "models/extracted/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/test_wavs/0.wav"
)
VAD_MODEL_CANDIDATES = (
    Path("models/silero-vad-v4.0.onnx"),
    Path("sources/extracted/sherpa-onnx-1.13.5/wasm/vad-asr/assets/silero_vad.onnx"),
    Path("sources/extracted/sherpa-onnx-1.13.5/wasm/vad/assets/silero_vad.onnx"),
)
REQUIRED_BROWSER_ARTIFACTS = (
    VAD_BUILD / "sherpa-onnx-wasm-main-vad-asr.js",
    VAD_BUILD / "sherpa-onnx-wasm-main-vad-asr.wasm",
    VAD_BUILD / "sherpa-onnx-wasm-main-vad-asr.data",
    VAD_SOURCE / "sherpa-onnx-vad.js",
)

CONFIG = {
    "threshold": 0.25,
    "min_silence_seconds": 0.25,
    "min_speech_seconds": 0.25,
    "max_speech_seconds": 10.0,
    "window_size": 512,
    "sample_rate": 16_000,
    "channels": 1,
    "provider": "cpu",
    "buffer_seconds": 30.0,
}
ACCEPT_P95_LIMIT_MS = 32.0
SEGMENT_TOLERANCE_SAMPLES = 512
SILENCE_SECONDS = 31
EXPECTED_MODEL_SHA256 = "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28"
EXPECTED_WAV_SHA256 = "6bc58a4efdf20daac252b6b1502632601a71efe0308f6757dc1eda34891a7e4f"
EXPECTED_SEGMENT = {"start": 5728, "length": 93696}

INDEX_HTML = """<!doctype html>
<meta charset="utf-8">
<title>Aurora VAD Parity</title>
<script>
globalThis.runAuroraVadParity = (timeoutMs = 120000) => new Promise((resolve) => {
  const worker = new Worker('/vad-worker.js');
  const started = performance.now();
  const progress = [];
  globalThis.__auroraVadParityProgress = progress;
  const timeout = setTimeout(() => {
    worker.terminate();
    resolve({ ok: false, error: `vad parity timed out after ${timeoutMs}ms`, progress });
  }, timeoutMs);
  worker.onmessage = (event) => {
    if (event.data && event.data.type === 'progress') {
      progress.push({ label: event.data.label, elapsedMs: performance.now() - started });
      return;
    }
    clearTimeout(timeout);
    worker.terminate();
    const result = event.data && event.data.result ? event.data.result : { ok: false };
    result.workerScope = result.workerScope === true;
    result.sharedArrayBuffer = result.sharedArrayBuffer === true;
    result.crossOriginIsolated = globalThis.crossOriginIsolated === true;
    result.ok = result.ok === true && result.workerScope && result.sharedArrayBuffer &&
      result.crossOriginIsolated;
    result.progress = progress;
    resolve(result);
  };
  worker.onerror = (event) => {
    clearTimeout(timeout);
    worker.terminate();
    resolve({ ok: false, error: event.message || 'worker error', progress });
  };
  worker.postMessage({ type: 'run' });
});
</script>
"""

WORKER_JS_TEMPLATE = r"""
let lastDownloadBucket = -1;

var Module = self.Module = {
  locateFile: (path) => `/artifacts/builds/wasm-vad-asr/bin/${path}`,
  mainScriptUrlOrBlob: '/artifacts/builds/wasm-vad-asr/bin/sherpa-onnx-wasm-main-vad-asr.js',
  print: (...args) => console.log(...args),
  printErr: (...args) => console.error(...args),
  monitorRunDependencies: (left) => postProgress(`run-dependencies:${left}`),
  setStatus: (status) => {
    if (!status) {
      return;
    }
    const download = status.match(/Downloading data\.\.\. \((\d+)\/(\d+)\)/);
    if (download) {
      const loaded = Number(download[1]);
      const total = Number(download[2]);
      const bucket = Math.floor(loaded / (4 * 1024 * 1024));
      if (bucket === lastDownloadBucket && loaded !== total) {
        return;
      }
      lastDownloadBucket = bucket;
    }
    postProgress(`status:${status}`);
  },
};
var Module = self.Module;

const CONFIG = __AURORA_VAD_CONFIG__;
const ACCEPT_P95_LIMIT_MS = __AURORA_ACCEPT_P95_LIMIT_MS__;
const EXPECTED_SEGMENT = __AURORA_EXPECTED_SEGMENT__;
const SILENCE_SECONDS = __AURORA_SILENCE_SECONDS__;

function postProgress(label) {
  self.postMessage({ type: 'progress', label });
}

function waitForRuntime() {
  return new Promise((resolve, reject) => {
    const prior = self.Module.onRuntimeInitialized;
    self.Module.onRuntimeInitialized = () => {
      if (typeof prior === 'function') {
        prior();
      }
      resolve();
    };
    self.Module.onAbort = (reason) => reject(new Error(String(reason)));
  });
}

async function loadPcm16Mono16khzWav() {
  const response = await fetch('/input.wav');
  if (!response.ok) {
    throw new Error(`Failed to load input WAV: ${response.status}`);
  }
  const view = new DataView(await response.arrayBuffer());
  if (view.byteLength < 12 || view.getUint32(0, false) !== 0x52494646 ||
      view.getUint32(8, false) !== 0x57415645) {
    throw new Error('WAV must be RIFF/WAVE');
  }
  let offset = 12;
  let format = null;
  let dataOffset = 0;
  let dataBytes = 0;
  while (offset + 8 <= view.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkData = offset + 8;
    if (chunkData + chunkSize > view.byteLength) {
      throw new Error('WAV chunk extends past file');
    }
    if (chunkId === 0x666d7420) {
      format = {
        audioFormat: view.getUint16(chunkData, true),
        channels: view.getUint16(chunkData + 2, true),
        sampleRate: view.getUint32(chunkData + 4, true),
        blockAlign: view.getUint16(chunkData + 12, true),
        bitsPerSample: view.getUint16(chunkData + 14, true),
      };
    } else if (chunkId === 0x64617461) {
      dataOffset = chunkData;
      dataBytes = chunkSize;
    }
    offset = chunkData + chunkSize + (chunkSize % 2);
  }
  if (!format || dataOffset === 0 || dataBytes === 0) {
    throw new Error('WAV missing fmt or data chunks');
  }
  if (format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== 16000 ||
      format.bitsPerSample !== 16 || format.blockAlign !== 2) {
    throw new Error('WAV must be RIFF PCM16 mono 16 kHz');
  }
  if (dataBytes % 2 !== 0) {
    throw new Error('PCM16 data must be sample aligned');
  }
  const samples = new Float32Array(dataBytes / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(dataOffset + index * 2, true) / 32768.0;
  }
  return samples;
}

function createParityVad() {
  return createVad(Module, {
    sileroVad: {
      model: '/silero_vad.onnx',
      threshold: CONFIG.threshold,
      minSilenceDuration: CONFIG.minSilenceDuration,
      minSpeechDuration: CONFIG.minSpeechDuration,
      maxSpeechDuration: CONFIG.maxSpeechDuration,
      windowSize: CONFIG.windowSize,
    },
    tenVad: {
      model: '',
      threshold: 0,
      minSilenceDuration: 0,
      minSpeechDuration: 0,
      maxSpeechDuration: 0,
      windowSize: 0,
    },
    sampleRate: CONFIG.sampleRate,
    numThreads: CONFIG.numThreads,
    provider: CONFIG.provider,
    debug: 0,
    bufferSizeInSeconds: CONFIG.bufferSizeInSeconds,
  });
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = Array.from(values).sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((sorted.length - 1) * ratio));
  return sorted[index];
}

function combineTiming(left, right) {
  return {
    p95_ms: Math.max(left.p95_ms, right.p95_ms),
    max_ms: Math.max(left.max_ms, right.max_ms),
    elapsed_ms: left.elapsed_ms + right.elapsed_ms,
    operations: left.operations + right.operations,
  };
}

function combineSegments(left, right) {
  return left.concat(right);
}

function feedAndDrain(vad, samples, options = {}) {
  const acceptTimings = [];
  const drainTimings = [];
  const segments = [];
  let fullWindows = 0;
  let terminalTailSamples = 0;
  let resetDuringFeed = false;
  for (let offset = 0; offset < samples.length; offset += CONFIG.windowSize) {
    const chunk = samples.slice(offset, Math.min(samples.length, offset + CONFIG.windowSize));
    if (chunk.length < CONFIG.windowSize) {
      terminalTailSamples = chunk.length;
    } else {
      fullWindows += 1;
    }
    const started = performance.now();
    vad.acceptWaveform(chunk);
    acceptTimings.push(performance.now() - started);

    if (options.resetAfterFullWindows && fullWindows === options.resetAfterFullWindows) {
      vad.reset();
      resetDuringFeed = true;
      break;
    }

    const drained = drainSegmentsTimed(vad);
    drainTimings.push(drained.timing.elapsed_ms);
    segments.push(...drained.segments);
  }
  return {
    segments,
    feed_timing: {
      accept: {
        p95_ms: percentile(acceptTimings, 0.95),
        max_ms: acceptTimings.reduce((max, value) => Math.max(max, value), 0),
        elapsed_ms: acceptTimings.reduce((total, value) => total + value, 0),
        operations: acceptTimings.length,
      },
      per_chunk_drain: {
        p95_ms: percentile(drainTimings, 0.95),
        max_ms: drainTimings.reduce((max, value) => Math.max(max, value), 0),
        elapsed_ms: drainTimings.reduce((total, value) => total + value, 0),
        operations: drainTimings.length,
      },
      full_windows: fullWindows,
      terminal_tail_samples: terminalTailSamples,
      short_terminal_tail_supported: terminalTailSamples > 0,
      reset_during_feed: resetDuringFeed,
    },
  };
}

function drainSegmentsTimed(vad) {
  const started = performance.now();
  const segments = [];
  while (!vad.isEmpty()) {
    const segment = vad.front();
    segments.push({ start: segment.start, length: segment.samples.length });
    vad.pop();
  }
  return {
    segments,
    timing: {
      p95_ms: 0,
      max_ms: 0,
      elapsed_ms: performance.now() - started,
      operations: 1,
    },
  };
}

function sameSegments(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isCanonicalFixtureOutput(segments) {
  return sameSegments(segments, [EXPECTED_SEGMENT]);
}

function runFullFlush(samples) {
  const vad = createParityVad();
  try {
    const feed = feedAndDrain(vad, samples);
    vad.flush();
    const finalDrain = drainSegmentsTimed(vad);
    const segments = combineSegments(feed.segments, finalDrain.segments);
    const drainTiming = combineTiming(feed.feed_timing.per_chunk_drain, finalDrain.timing);
    return { ok: isCanonicalFixtureOutput(segments) && feed.feed_timing.accept.p95_ms < ACCEPT_P95_LIMIT_MS, segments, feed_timing: feed.feed_timing, drain_timing: drainTiming, idempotent_empty: null };
  } finally {
    vad.free();
  }
}

function runResetReplay(samples, expected) {
  const vad = createParityVad();
  try {
    feedAndDrain(vad, samples);
    vad.flush();
    drainSegmentsTimed(vad);
    vad.reset();
    const feed = feedAndDrain(vad, samples);
    vad.flush();
    const finalDrain = drainSegmentsTimed(vad);
    const segments = combineSegments(feed.segments, finalDrain.segments);
    const drainTiming = combineTiming(feed.feed_timing.per_chunk_drain, finalDrain.timing);
    return { ok: sameSegments(segments, expected) && feed.feed_timing.accept.p95_ms < ACCEPT_P95_LIMIT_MS, segments, feed_timing: feed.feed_timing, drain_timing: drainTiming, idempotent_empty: null };
  } finally {
    vad.free();
  }
}

function runDiscontinuityReset(samples, expected) {
  const vad = createParityVad();
  try {
    feedAndDrain(vad, samples.slice(0, Math.min(samples.length, CONFIG.windowSize * 3)));
    vad.reset();
    const feed = feedAndDrain(vad, samples);
    vad.flush();
    const finalDrain = drainSegmentsTimed(vad);
    const segments = combineSegments(feed.segments, finalDrain.segments);
    const drainTiming = combineTiming(feed.feed_timing.per_chunk_drain, finalDrain.timing);
    return { ok: sameSegments(segments, expected) && feed.feed_timing.accept.p95_ms < ACCEPT_P95_LIMIT_MS, segments, feed_timing: feed.feed_timing, drain_timing: drainTiming, idempotent_empty: null };
  } finally {
    vad.free();
  }
}

function runSecondFlush(samples, expected) {
  const vad = createParityVad();
  try {
    const feed = feedAndDrain(vad, samples);
    vad.flush();
    const finalDrain = drainSegmentsTimed(vad);
    const segments = combineSegments(feed.segments, finalDrain.segments);
    vad.flush();
    const secondDrain = drainSegmentsTimed(vad);
    const drainTiming = combineTiming(combineTiming(feed.feed_timing.per_chunk_drain, finalDrain.timing), secondDrain.timing);
    const afterSecondFlush = secondDrain.segments;
    const idempotentEmpty = afterSecondFlush.length === 0;
    return { ok: sameSegments(segments, expected) && idempotentEmpty && feed.feed_timing.accept.p95_ms < ACCEPT_P95_LIMIT_MS, segments, feed_timing: feed.feed_timing, drain_timing: drainTiming, idempotent_empty: idempotentEmpty };
  } finally {
    vad.free();
  }
}

function runCancellationResetDuringFeed(samples) {
  const vad = createParityVad();
  try {
    const feed = feedAndDrain(vad, samples, { resetAfterFullWindows: 3 });
    vad.flush();
    const finalDrain = drainSegmentsTimed(vad);
    const segments = combineSegments(feed.segments, finalDrain.segments);
    const drainTiming = combineTiming(feed.feed_timing.per_chunk_drain, finalDrain.timing);
    return { ok: segments.length === 0 && feed.feed_timing.reset_during_feed === true && feed.feed_timing.accept.p95_ms < ACCEPT_P95_LIMIT_MS, segments, feed_timing: feed.feed_timing, drain_timing: drainTiming, idempotent_empty: null };
  } finally {
    vad.free();
  }
}

function runLongSilence() {
  const vad = createParityVad();
  try {
    const silence = new Float32Array(CONFIG.sampleRate * SILENCE_SECONDS);
    const feed = feedAndDrain(vad, silence);
    vad.flush();
    const finalDrain = drainSegmentsTimed(vad);
    const segments = combineSegments(feed.segments, finalDrain.segments);
    const drainTiming = combineTiming(feed.feed_timing.per_chunk_drain, finalDrain.timing);
    return { ok: segments.length === 0 && feed.feed_timing.accept.p95_ms < ACCEPT_P95_LIMIT_MS, segments, feed_timing: feed.feed_timing, drain_timing: drainTiming, idempotent_empty: null };
  } finally {
    vad.free();
  }
}

async function runProbe() {
  postProgress('start');
  const ready = waitForRuntime();
  postProgress('import-runtime');
  importScripts(
    '/artifacts/builds/wasm-vad-asr/bin/sherpa-onnx-wasm-main-vad-asr.js',
    '/artifacts/sources/extracted/sherpa-onnx-1.13.5/wasm/vad-asr/sherpa-onnx-vad.js'
  );
  postProgress('await-runtime');
  await ready;
  postProgress('load-wav');
  const samples = await loadPcm16Mono16khzWav();
  const fullFlush = runFullFlush(samples);
  const resetReplay = runResetReplay(samples, fullFlush.segments);
  const discontinuity = runDiscontinuityReset(samples, fullFlush.segments);
  const secondFlush = runSecondFlush(samples, fullFlush.segments);
  const cancellation = runCancellationResetDuringFeed(samples);
  const longSilence = runLongSilence();
  const cases = {
    full_flush: fullFlush,
    reset_replay: resetReplay,
    discontinuity_reset: discontinuity,
    second_flush_idempotent: secondFlush,
    cancellation_reset_during_feed: cancellation,
    long_silence_rolling_buffer: longSilence,
  };
  const ok = Object.values(cases).every((item) => item.ok === true);
  return {
    ok,
    physical_device_claim: false,
    config: {
      threshold: CONFIG.threshold,
      min_silence_seconds: CONFIG.minSilenceDuration,
      min_speech_seconds: CONFIG.minSpeechDuration,
      max_speech_seconds: CONFIG.maxSpeechDuration,
      window_size: CONFIG.windowSize,
      sample_rate: CONFIG.sampleRate,
      channels: 1,
      provider: CONFIG.provider,
      buffer_seconds: CONFIG.bufferSizeInSeconds,
    },
    cases,
    workerScope: typeof WorkerGlobalScope !== 'undefined',
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  };
}

self.onmessage = async (event) => {
  if (!event.data || event.data.type !== 'run') {
    return;
  }
  try {
    const result = await runProbe();
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({
      type: 'result',
      result: {
        ok: false,
        physical_device_claim: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : '',
        workerScope: typeof WorkerGlobalScope !== 'undefined',
        sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      },
    });
  }
};
"""

BROWSER_CONFIG = {
    "threshold": CONFIG["threshold"],
    "minSilenceDuration": CONFIG["min_silence_seconds"],
    "minSpeechDuration": CONFIG["min_speech_seconds"],
    "maxSpeechDuration": CONFIG["max_speech_seconds"],
    "windowSize": CONFIG["window_size"],
    "sampleRate": CONFIG["sample_rate"],
    "numThreads": CONFIG["channels"],
    "provider": CONFIG["provider"],
    "bufferSizeInSeconds": CONFIG["buffer_seconds"],
}
WORKER_JS = (
    WORKER_JS_TEMPLATE.replace(
        "__AURORA_VAD_CONFIG__", json.dumps(BROWSER_CONFIG, separators=(",", ":"))
    )
    .replace("__AURORA_ACCEPT_P95_LIMIT_MS__", str(ACCEPT_P95_LIMIT_MS))
    .replace("__AURORA_EXPECTED_SEGMENT__", json.dumps(EXPECTED_SEGMENT, separators=(",", ":")))
    .replace("__AURORA_SILENCE_SECONDS__", str(SILENCE_SECONDS))
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--artifact-root",
        type=Path,
        default=Path(os.environ.get(ARTIFACT_ENV, "")) if os.environ.get(ARTIFACT_ENV) else None,
        help="Phase 4 artifact root containing wasm-vad-asr and extracted models",
    )
    parser.add_argument("--model-path", type=Path, default=env_path(MODEL_ENV))
    parser.add_argument("--wav-path", type=Path, default=env_path(WAV_ENV))
    parser.add_argument("--lib-dir", type=Path, default=env_path(LIB_DIR_ENV))
    parser.add_argument(
        "--report-dir",
        type=Path,
        default=DEFAULT_REPORT_DIR / time.strftime("%Y%m%d-%H%M%S"),
        help="Must be under .artifacts/",
    )
    parser.add_argument(
        "--browser",
        choices=("chromium", "firefox", "webkit"),
        action="append",
        help="Browser to run; defaults to all three",
    )
    parser.add_argument("--timeout-ms", type=int, default=120_000)
    parser.add_argument("--skip-native", action="store_true")
    parser.add_argument("--skip-browsers", action="store_true")
    return parser


def env_path(name: str) -> Path | None:
    value = os.environ.get(name)
    return Path(value) if value else None


def resolve_artifact_path(
    artifact_root: Path,
    path: Path,
    label: str,
    *,
    must_exist: bool = True,
) -> Path:
    """Resolve an artifact path and reject traversal or symlink escapes."""
    root = artifact_root.resolve()
    candidate = path if path.is_absolute() else root / path
    try:
        resolved = candidate.resolve(strict=must_exist)
    except FileNotFoundError as exc:
        raise SystemExit(f"{label} missing: {candidate}") from exc
    if resolved != root and root not in resolved.parents:
        raise SystemExit(f"{label} escapes artifact root: {resolved}")
    return resolved


def resolve_inputs(args: argparse.Namespace) -> tuple[Path, Path, Path, Path]:
    artifact_root = args.artifact_root.resolve() if args.artifact_root else None
    if artifact_root is None:
        raise SystemExit(f"--artifact-root or {ARTIFACT_ENV} is required")
    if not artifact_root.is_dir():
        raise SystemExit(f"artifact root does not exist: {artifact_root}")

    missing = []
    for path in REQUIRED_BROWSER_ARTIFACTS:
        try:
            resolved = resolve_artifact_path(artifact_root, path, f"browser artifact {path}")
        except SystemExit as exc:
            if "escapes artifact root" in str(exc):
                raise
            missing.append(str(path))
            continue
        if not resolved.is_file():
            missing.append(str(path))
    if missing:
        raise SystemExit("missing browser artifacts:\n" + "\n".join(missing))

    wav_path = resolve_artifact_path(artifact_root, args.wav_path or KWS_TEST_WAV, "KWS test wav")
    model_path = resolve_artifact_path(
        artifact_root,
        args.model_path or find_model_path(artifact_root),
        "Silero model",
    )
    lib_dir = resolve_artifact_path(
        artifact_root,
        args.lib_dir or find_lib_dir(artifact_root),
        "sherpa native lib dir",
    )
    if not wav_path.is_file():
        raise SystemExit(f"KWS test wav missing: {wav_path}")
    if not model_path.is_file():
        raise SystemExit(f"Silero model missing: {model_path}")
    if not lib_dir.is_dir():
        raise SystemExit(f"sherpa native lib dir missing: {lib_dir}")
    validate_wav_file(wav_path)
    verify_sha256(model_path, EXPECTED_MODEL_SHA256, "Silero model")
    verify_sha256(wav_path, EXPECTED_WAV_SHA256, "KWS test wav")
    return artifact_root, model_path, wav_path, lib_dir


def find_model_path(artifact_root: Path) -> Path:
    for candidate in VAD_MODEL_CANDIDATES:
        path = artifact_root / candidate
        if path.is_file():
            return candidate
    matches = sorted(
        artifact_root.glob("sources/extracted/sherpa-onnx-1.13.5*/wasm/vad*/assets/silero_vad.onnx")
    )
    if matches:
        return matches[0].relative_to(artifact_root)
    return VAD_MODEL_CANDIDATES[0]


def find_lib_dir(artifact_root: Path) -> Path:
    names = (
        "libsherpa-onnx-c-api.so",
        "libsherpa-onnx-c-api.dylib",
        "sherpa-onnx-c-api.lib",
        "libsherpa-onnx-c-api.a",
    )
    preferred_roots = host_native_lib_roots()
    for root in preferred_roots:
        for name in names:
            path = artifact_root / root / name
            if path.is_file():
                return path.parent.relative_to(artifact_root)
    for name in names:
        matches = sorted(artifact_root.glob(f"**/{name}"))
        if matches:
            return matches[0].parent.relative_to(artifact_root)
    return Path("builds/native/lib")


def host_native_lib_roots() -> tuple[Path, ...]:
    machine = os.uname().machine.lower() if hasattr(os, "uname") else ""
    arch = "x86_64" if machine in {"amd64", "x86_64"} else machine
    if sys.platform == "darwin":
        platform_roots = [f"macos-{arch}", f"darwin-{arch}"]
    elif sys.platform == "win32":
        platform_roots = [f"windows-{arch}", f"win-{arch}"]
    else:
        platform_roots = [f"linux-{arch}"]
    return tuple(
        Path("builds") / root / suffix
        for root in platform_roots
        for suffix in (Path("install/lib"), Path("lib"))
    )


def validate_report_dir(path: Path) -> Path:
    resolved = path.resolve()
    artifact_root = (REPO_ROOT / ".artifacts").resolve()
    if artifact_root not in resolved.parents and resolved != artifact_root:
        raise SystemExit(f"report dir must be under ignored .artifacts/: {resolved}")
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def validate_wav_file(path: Path) -> None:
    read_pcm16_mono_16khz_wav(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_sha256(path: Path, expected: str, label: str) -> str:
    actual = sha256_file(path)
    if actual != expected:
        raise SystemExit(f"{label} SHA mismatch: expected {expected}, got {actual}")
    return actual


def read_pcm16_mono_16khz_wav(path: Path) -> list[float]:
    data = path.read_bytes()
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("wav must be RIFF/WAVE")
    cursor = 12
    fmt: dict[str, int] | None = None
    pcm: bytes | None = None
    while cursor + 8 <= len(data):
        chunk_id = data[cursor : cursor + 4]
        size = int.from_bytes(data[cursor + 4 : cursor + 8], "little")
        cursor += 8
        end = cursor + size
        if end > len(data):
            raise ValueError("wav chunk extends past file")
        chunk = data[cursor:end]
        if chunk_id == b"fmt ":
            if len(chunk) < 16:
                raise ValueError("wav fmt chunk too short")
            fmt = {
                "audio_format": int.from_bytes(chunk[0:2], "little"),
                "channels": int.from_bytes(chunk[2:4], "little"),
                "sample_rate": int.from_bytes(chunk[4:8], "little"),
                "block_align": int.from_bytes(chunk[12:14], "little"),
                "bits_per_sample": int.from_bytes(chunk[14:16], "little"),
            }
        elif chunk_id == b"data":
            pcm = chunk
        cursor = end + (size % 2)
    if fmt is None or pcm is None:
        raise ValueError("wav missing fmt or data chunks")
    if fmt != {
        "audio_format": 1,
        "channels": 1,
        "sample_rate": 16_000,
        "block_align": 2,
        "bits_per_sample": 16,
    }:
        raise ValueError("wav must be RIFF PCM16 mono 16 kHz")
    if len(pcm) % 2 != 0:
        raise ValueError("PCM16 data must be sample aligned")
    return [
        int.from_bytes(pcm[index : index + 2], "little", signed=True) / 32768.0
        for index in range(0, len(pcm), 2)
    ]


class ParityServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], artifact_root: Path, wav_path: Path) -> None:
        super().__init__(address, ParityRequestHandler)
        self.artifact_root = artifact_root
        self.wav_path = wav_path


class ParityRequestHandler(BaseHTTPRequestHandler):
    server: ParityServer

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return

    def end_headers(self) -> None:
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == "/":
            self.send_bytes(INDEX_HTML.encode(), "text/html; charset=utf-8")
            return
        if path == "/vad-worker.js":
            self.send_bytes(WORKER_JS.encode(), "text/javascript; charset=utf-8")
            return
        if path == "/input.wav":
            self.send_file(self.server.wav_path)
            return
        if path.startswith("/artifacts/"):
            rel = Path(path.removeprefix("/artifacts/"))
            if rel.is_absolute() or ".." in rel.parts:
                self.send_error(HTTPStatus.BAD_REQUEST)
                return
            try:
                artifact = resolve_artifact_path(
                    self.server.artifact_root,
                    rel,
                    f"served artifact {rel}",
                    must_exist=False,
                )
            except SystemExit:
                self.send_error(HTTPStatus.BAD_REQUEST)
                return
            self.send_file(artifact)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def send_file(self, path: Path) -> None:
        try:
            resolved = path.resolve(strict=True)
        except FileNotFoundError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not resolved.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        self.send_bytes(resolved.read_bytes(), content_type)

    def send_bytes(self, body: bytes, content_type: str) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@contextlib.contextmanager
def serve_parity(artifact_root: Path, wav_path: Path):
    server = ParityServer(("127.0.0.1", find_free_port()), artifact_root, wav_path)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def run_native(model_path: Path, wav_path: Path, lib_dir: Path) -> dict[str, Any]:
    env = os.environ.copy()
    env[LIB_DIR_ENV] = str(lib_dir)
    lib_path_name = "DYLD_LIBRARY_PATH" if sys.platform == "darwin" else "LD_LIBRARY_PATH"
    env[lib_path_name] = f"{lib_dir}{os.pathsep}{env.get(lib_path_name, '')}".rstrip(os.pathsep)
    command = [
        "cargo",
        "+1.88.0",
        "run",
        "--quiet",
        "--manifest-path",
        str(REPO_ROOT / "rust" / "Cargo.toml"),
        "-p",
        "aurora-voice-sherpa-sys",
        "--features",
        "native-vad",
        "--example",
        "vad_parity_driver",
        "--",
        "--model",
        str(model_path),
        "--wav",
        str(wav_path),
    ]
    started = time.monotonic()
    completed = subprocess.run(
        command,
        cwd=REPO_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    elapsed_ms = round((time.monotonic() - started) * 1000, 2)
    if completed.returncode != 0:
        return {
            "ok": False,
            "engine": "native",
            "elapsed_ms": elapsed_ms,
            "command": command,
            "stderr": completed.stderr[-4000:],
            "stdout": completed.stdout[-4000:],
            "physical_device_claim": False,
        }
    payload = json.loads(completed.stdout)
    payload["engine"] = "native"
    payload["elapsed_ms"] = elapsed_ms
    return payload


def run_browser(url: str, browser_name: str, timeout_ms: int) -> dict[str, Any]:
    try:
        from playwright.sync_api import (
            Error as PlaywrightError,
            TimeoutError as PlaywrightTimeoutError,
            sync_playwright,
        )
    except ImportError as exc:
        return {
            "ok": False,
            "browser": browser_name,
            "withheld": True,
            "reason": str(exc),
            "physical_device_claim": False,
        }

    started = time.monotonic()
    try:
        with sync_playwright() as playwright:
            browser_type = getattr(playwright, browser_name)
            browser = browser_type.launch(headless=True)
            try:
                page = browser.new_page()
                logs: list[str] = []
                page.on("console", lambda msg: logs.append(f"console:{msg.type}:{msg.text}"))
                page.on("pageerror", lambda exc: logs.append(f"pageerror:{exc}"))
                page.goto(url, wait_until="load", timeout=timeout_ms)
                result = page.evaluate(
                    """(timeoutMs) => Promise.race([
                      runAuroraVadParity(timeoutMs),
                      new Promise((resolve) => setTimeout(() => resolve({
                        ok: false,
                        error: `browser parity timed out after ${timeoutMs}ms`,
                        progress: globalThis.__auroraVadParityProgress || [],
                      }), timeoutMs)),
                    ])""",
                    timeout_ms,
                )
                result["browser_logs"] = logs[-40:]
            finally:
                browser.close()
        result["browser"] = browser_name
        result["elapsed_ms"] = round((time.monotonic() - started) * 1000, 2)
        result["physical_device_claim"] = False
        return result
    except (PlaywrightError, PlaywrightTimeoutError, Exception) as exc:
        return {
            "ok": False,
            "browser": browser_name,
            "elapsed_ms": round((time.monotonic() - started) * 1000, 2),
            "reason": str(exc),
            "physical_device_claim": False,
        }


def compare_segments(native: dict[str, Any], browser: dict[str, Any]) -> dict[str, Any]:
    cases: dict[str, Any] = {}
    native_cases = native.get("cases", {})
    browser_cases = browser.get("cases", {})
    for name, native_case in native_cases.items():
        browser_case = browser_cases.get(name, {})
        native_segments = native_case.get("segments", [])
        browser_segments = browser_case.get("segments", [])
        diffs = []
        count_ok = len(native_segments) == len(browser_segments)
        for index, (left, right) in enumerate(zip(native_segments, browser_segments, strict=False)):
            start_delta = abs(int(left["start"]) - int(right["start"]))
            length_delta = abs(int(left["length"]) - int(right["length"]))
            diffs.append(
                {
                    "index": index,
                    "native": left,
                    "browser": right,
                    "start_delta": start_delta,
                    "length_delta": length_delta,
                    "ok": start_delta <= SEGMENT_TOLERANCE_SAMPLES
                    and length_delta <= SEGMENT_TOLERANCE_SAMPLES,
                }
            )
        cases[name] = {
            "ok": count_ok and all(item["ok"] for item in diffs),
            "count_ok": count_ok,
            "native_count": len(native_segments),
            "browser_count": len(browser_segments),
            "diffs": diffs,
        }
    return {"ok": all(item["ok"] for item in cases.values()), "cases": cases}


def timing_ok(result: dict[str, Any]) -> bool:
    for case in result.get("cases", {}).values():
        timing = case.get("feed_timing", {}).get("accept", {})
        if float(timing.get("p95_ms", ACCEPT_P95_LIMIT_MS + 1)) >= ACCEPT_P95_LIMIT_MS:
            return False
    return True


def browser_capabilities_ok(result: dict[str, Any]) -> bool:
    return (
        result.get("workerScope") is True
        and result.get("sharedArrayBuffer") is True
        and result.get("crossOriginIsolated") is True
    )


def physical_device_claims_ok(
    native: dict[str, Any], browser_results: list[dict[str, Any]]
) -> bool:
    return native.get("physical_device_claim") is False and all(
        result.get("physical_device_claim") is False for result in browser_results
    )


def full_matrix_gate_ok(
    *,
    native: dict[str, Any],
    browser_results: list[dict[str, Any]],
    comparisons: list[dict[str, Any]],
    requested_browsers: list[str],
    skip_native: bool,
    skip_browsers: bool,
) -> bool:
    full_browser_matrix = set(requested_browsers) == {"chromium", "firefox", "webkit"}
    return (
        not skip_native
        and not skip_browsers
        and full_browser_matrix
        and native.get("ok") is True
        and timing_ok(native)
        and physical_device_claims_ok(native, browser_results)
        and len(browser_results) == 3
        and all(
            result.get("ok") is True and timing_ok(result) and browser_capabilities_ok(result)
            for result in browser_results
        )
        and all(item.get("ok") is True for item in comparisons)
    )


def normalize_browsers(requested: list[str] | None) -> list[str]:
    browsers = requested or ["chromium", "firefox", "webkit"]
    duplicates = sorted({browser for browser in browsers if browsers.count(browser) > 1})
    if duplicates:
        raise SystemExit("duplicate browser request: " + ", ".join(duplicates))
    return browsers


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    report_dir = validate_report_dir(args.report_dir)
    artifact_root, model_path, wav_path, lib_dir = resolve_inputs(args)
    browsers = normalize_browsers(args.browser)

    native = {"ok": True, "skipped": True, "physical_device_claim": False}
    if not args.skip_native:
        native = run_native(model_path, wav_path, lib_dir)

    browser_results: list[dict[str, Any]] = []
    comparisons: list[dict[str, Any]] = []
    if not args.skip_browsers:
        with serve_parity(artifact_root, wav_path) as url:
            for browser in browsers:
                result = run_browser(url, browser, args.timeout_ms)
                browser_results.append(result)
                if native.get("ok") is True and result.get("ok") is True:
                    comparison = compare_segments(native, result)
                else:
                    comparison = {"ok": False, "reason": "native or browser failed"}
                comparison["browser"] = browser
                comparisons.append(comparison)

    all_ok = full_matrix_gate_ok(
        native=native,
        browser_results=browser_results,
        comparisons=comparisons,
        requested_browsers=browsers,
        skip_native=args.skip_native,
        skip_browsers=args.skip_browsers,
    )
    payload = {
        "ok": all_ok,
        "full_matrix_gate": all_ok,
        "partial_diagnostics": args.skip_native
        or args.skip_browsers
        or set(browsers) != {"chromium", "firefox", "webkit"},
        "physical_device_claim": False,
        "config": CONFIG,
        "artifact_root": str(artifact_root),
        "model_path": str(model_path),
        "model_sha256": sha256_file(model_path),
        "wav_path": str(wav_path),
        "wav_sha256": sha256_file(wav_path),
        "native": native,
        "browsers": browser_results,
        "comparisons": comparisons,
        "segment_tolerance_samples": SEGMENT_TOLERANCE_SAMPLES,
        "accept_p95_limit_ms": ACCEPT_P95_LIMIT_MS,
    }
    write_json(report_dir / "report.json", payload)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

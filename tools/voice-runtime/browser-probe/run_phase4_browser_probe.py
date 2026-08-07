#!/usr/bin/env python3
"""Run Phase 4 sherpa-onnx WASM probes inside dedicated browser workers."""

from __future__ import annotations

import argparse
import contextlib
import json
import mimetypes
import os
import socket
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

ARTIFACT_ENV = "AURORA_VOICE_P4_ARTIFACT_ROOT"
VAD_ASR_BUILD = Path("builds/wasm-vad-asr/bin")
VAD_ASR_SOURCE = Path("sources/extracted/sherpa-onnx-1.13.4/wasm/vad-asr")
MOONSHINE_TEST_WAV = Path(
    "models/extracted/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27/test_wavs/0.wav"
)
REQUIRED_ARTIFACTS = (
    VAD_ASR_BUILD / "sherpa-onnx-wasm-main-vad-asr.js",
    VAD_ASR_BUILD / "sherpa-onnx-wasm-main-vad-asr.wasm",
    VAD_ASR_BUILD / "sherpa-onnx-wasm-main-vad-asr.data",
    VAD_ASR_SOURCE / "sherpa-onnx-vad.js",
    VAD_ASR_SOURCE / "sherpa-onnx-asr.js",
    MOONSHINE_TEST_WAV,
)

INDEX_HTML = """<!doctype html>
<meta charset="utf-8">
<title>Aurora Phase 4 Browser Voice Probe</title>
<script>
globalThis.runAuroraPhase4VoiceProbe = (timeoutMs = 120000) => new Promise((resolve, reject) => {
  const worker = new Worker('/probe-worker.js');
  const started = performance.now();
  const progress = [];
  globalThis.__auroraPhase4ProbeProgress = progress;
  let ticks = 0;
  let maxLagMs = 0;
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - last - 25);
    last = now;
    ticks += 1;
  }, 25);
  const timeout = setTimeout(() => {
    clearInterval(ticker);
    worker.terminate();
    reject(new Error(`worker timed out with progress ${JSON.stringify(progress)}`));
  }, timeoutMs);
  worker.onmessage = (event) => {
    if (event.data && event.data.type === 'progress') {
      progress.push({ label: event.data.label, elapsedMs: performance.now() - started });
      return;
    }
    if (event.data && event.data.type === 'result') {
      clearTimeout(timeout);
      clearInterval(ticker);
      worker.terminate();
      resolve({
        ...event.data.result,
        mainThread: {
          elapsedMs: performance.now() - started,
          intervalTicks: ticks,
          maxIntervalLagMs: maxLagMs,
        },
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
        progress,
      });
    }
  };
  worker.onerror = (event) => {
    clearTimeout(timeout);
    clearInterval(ticker);
    worker.terminate();
    reject(new Error(event.message || 'worker error'));
  };
  worker.postMessage({ type: 'run' });
});
</script>
"""

WORKER_JS = r"""
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

async function loadProbeWav() {
  const response = await fetch(
    '/artifacts/models/extracted/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27/test_wavs/0.wav'
  );
  if (!response.ok) {
    throw new Error(`Failed to load probe WAV: ${response.status}`);
  }
  const view = new DataView(await response.arrayBuffer());
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    throw new Error('Probe WAV is not RIFF/WAVE');
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataBytes = 0;
  while (offset + 8 <= view.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkData = offset + 8;
    if (chunkId === 0x666d7420) {
      const audioFormat = view.getUint16(chunkData, true);
      channels = view.getUint16(chunkData + 2, true);
      sampleRate = view.getUint32(chunkData + 4, true);
      bitsPerSample = view.getUint16(chunkData + 14, true);
      if (audioFormat !== 1 || channels < 1 || bitsPerSample !== 16) {
        throw new Error(`Unsupported probe WAV format ${audioFormat}/${channels}/${bitsPerSample}`);
      }
    } else if (chunkId === 0x64617461) {
      dataOffset = chunkData;
      dataBytes = chunkSize;
    }
    offset = chunkData + chunkSize + (chunkSize % 2);
  }
  if (!sampleRate || !dataOffset || !dataBytes) {
    throw new Error('Probe WAV is missing fmt or data chunks');
  }
  const frames = dataBytes / (channels * 2);
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let mixed = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      mixed += view.getInt16(dataOffset + (frame * channels + channel) * 2, true) / 32768;
    }
    samples[frame] = mixed / channels;
  }
  return { sampleRate, samples };
}

function runVad(Module, probe) {
  const vad = createVad(Module, {
    sileroVad: {
      model: '/silero_vad.onnx',
      threshold: 0.5,
      minSilenceDuration: 0.25,
      minSpeechDuration: 0.1,
      maxSpeechDuration: 5,
      windowSize: 512,
    },
    tenVad: {
      model: '',
      threshold: 0.5,
      minSilenceDuration: 0.25,
      minSpeechDuration: 0.1,
      maxSpeechDuration: 5,
      windowSize: 256,
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    bufferSizeInSeconds: 10,
  });
  const chunk = 512;
  let detectedDuringAccept = false;
  for (let offset = 0; offset < probe.samples.length; offset += chunk) {
    vad.acceptWaveform(probe.samples.slice(offset, offset + chunk));
    detectedDuringAccept = detectedDuringAccept || vad.isDetected();
  }
  vad.flush();
  const segments = [];
  while (!vad.isEmpty()) {
    const segment = vad.front();
    segments.push({ start: segment.start, samples: segment.samples.length });
    vad.pop();
  }
  vad.free();
  return { ok: segments.length > 0, detectedDuringAccept, sampleRate: probe.sampleRate, segments };
}

function runAsr(Module, probe) {
  const recognizer = new OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      moonshine: {
        preprocessor: '',
        encoder: '/moonshine-encoder.ort',
        uncachedDecoder: '',
        cachedDecoder: '',
        mergedDecoder: '/moonshine-merged-decoder.ort',
      },
      tokens: '/tokens.txt',
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      modelType: 'moonshine',
      modelingUnit: '',
      bpeVocab: '',
      tokensBuf: '',
    },
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
    hotwordsFile: '',
    hotwordsScore: 1.5,
  }, Module);
  const stream = recognizer.createStream();
  stream.acceptWaveform(probe.sampleRate, probe.samples);
  const started = performance.now();
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  const decodeMs = performance.now() - started;
  stream.free();
  recognizer.free();
  return {
    ok: typeof result.text === 'string',
    text: result.text || '',
    decodeMs,
  };
}

async function runProbe() {
  postProgress('start');
  const ready = waitForRuntime();
  postProgress('import-runtime');
  importScripts(
    '/artifacts/builds/wasm-vad-asr/bin/sherpa-onnx-wasm-main-vad-asr.js',
    '/artifacts/sources/extracted/sherpa-onnx-1.13.4/wasm/vad-asr/sherpa-onnx-vad.js',
    '/artifacts/sources/extracted/sherpa-onnx-1.13.4/wasm/vad-asr/sherpa-onnx-asr.js'
  );
  postProgress('await-runtime');
  await ready;
  postProgress('load-wav');
  const probe = await loadProbeWav();
  postProgress('run-vad');
  const vad = runVad(self.Module, probe);
  postProgress('run-asr');
  const asr = runAsr(self.Module, probe);
  postProgress('complete');
  return {
    ok: vad.ok && asr.ok,
    vad,
    asr,
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
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : '',
      },
    });
  }
};
"""


class ProbeError(RuntimeError):
    """Raised when the browser probe cannot be configured."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--artifact-root",
        type=Path,
        default=artifact_root_default(),
        required=artifact_root_default() is None,
        help=f"Phase 4 artifact root. May also be supplied with {ARTIFACT_ENV}.",
    )
    parser.add_argument("--report-json", type=Path)
    parser.add_argument(
        "--browser",
        action="append",
        choices=("chromium", "firefox", "webkit"),
        help="Browser to run. Repeatable. Defaults to all cached Playwright browsers.",
    )
    parser.add_argument("--timeout-ms", type=int, default=120000)
    return parser


def artifact_root_default() -> Path | None:
    value = os.environ.get(ARTIFACT_ENV)
    return Path(value) if value else None


def validate_artifact_root(root: Path) -> list[str]:
    missing = [str(path) for path in REQUIRED_ARTIFACTS if not (root / path).is_file()]
    return missing


def find_free_port() -> int:
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class ProbeRequestHandler(BaseHTTPRequestHandler):
    server: ProbeServer

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return

    def end_headers(self) -> None:
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path in ("/", "/index.html"):
            self._send_bytes(INDEX_HTML.encode("utf-8"), "text/html; charset=utf-8")
            return
        if path == "/probe-worker.js":
            self._send_bytes(WORKER_JS.encode("utf-8"), "text/javascript; charset=utf-8")
            return
        if path.startswith("/artifacts/"):
            relative = Path(path.removeprefix("/artifacts/"))
            self._send_artifact(relative)
            return
        if path.startswith("/bin/"):
            relative = VAD_ASR_BUILD / Path(path).name
            self._send_artifact(relative)
            return
        if path in (
            "/sherpa-onnx-wasm-main-vad-asr.js",
            "/sherpa-onnx-wasm-main-vad-asr.wasm",
            "/sherpa-onnx-wasm-main-vad-asr.data",
        ):
            relative = VAD_ASR_BUILD / Path(path).name
            self._send_artifact(relative)
            return
        self.send_error(HTTPStatus.NOT_FOUND, "not found")

    def _send_artifact(self, relative: Path) -> None:
        if relative.is_absolute() or ".." in relative.parts:
            self.send_error(HTTPStatus.BAD_REQUEST, "bad artifact path")
            return
        artifact_path = (self.server.artifact_root / relative).resolve()
        try:
            artifact_path.relative_to(self.server.artifact_root)
        except ValueError:
            self.send_error(HTTPStatus.BAD_REQUEST, "bad artifact path")
            return
        if not artifact_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "artifact not found")
            return
        content_type = mimetypes.guess_type(str(artifact_path))[0]
        if artifact_path.suffix == ".wasm":
            content_type = "application/wasm"
        elif artifact_path.suffix == ".data":
            content_type = "application/octet-stream"
        elif artifact_path.suffix == ".js":
            content_type = "text/javascript"
        self._send_bytes(artifact_path.read_bytes(), content_type or "application/octet-stream")

    def _send_bytes(self, payload: bytes, content_type: str) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class ProbeServer(ThreadingHTTPServer):
    def __init__(self, server_address: tuple[str, int], artifact_root: Path):
        super().__init__(server_address, ProbeRequestHandler)
        self.artifact_root = artifact_root.resolve()


@contextlib.contextmanager
def serve_probe(artifact_root: Path):
    server = ProbeServer(("127.0.0.1", find_free_port()), artifact_root)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def run_browser_probe(url: str, browser_name: str, timeout_ms: int) -> dict[str, Any]:
    try:
        from playwright.sync_api import (
            Error as PlaywrightError,
            TimeoutError as PlaywrightTimeoutError,
            sync_playwright,
        )
    except ImportError as exc:
        return {"browser": browser_name, "ok": False, "withheld": True, "reason": str(exc)}

    started = time.monotonic()
    try:
        with sync_playwright() as playwright:
            browser_type = getattr(playwright, browser_name)
            browser = browser_type.launch(headless=True)
            try:
                page = browser.new_page()
                browser_logs: list[str] = []
                page.on("console", lambda msg: browser_logs.append(f"console:{msg.type}:{msg.text}"))
                page.on("pageerror", lambda exc: browser_logs.append(f"pageerror:{exc}"))
                page.on(
                    "requestfailed",
                    lambda request: browser_logs.append(
                        f"requestfailed:{request.url}:{request.failure or ''}"
                    ),
                )
                page.set_default_timeout(timeout_ms)
                page.goto(url, wait_until="load", timeout=timeout_ms)
                result = page.evaluate(
                    """(timeoutMs) => Promise.race([
                        runAuroraPhase4VoiceProbe(timeoutMs),
                        new Promise((resolve) => setTimeout(() => resolve({
                            ok: false,
                            error: `browser probe timed out after ${timeoutMs}ms`,
                            progress: globalThis.__auroraPhase4ProbeProgress || [],
                        }), timeoutMs)),
                    ])""",
                    timeout_ms,
                )
                result["browserLogs"] = browser_logs[-40:]
            finally:
                browser.close()
        return {
            "browser": browser_name,
            "ok": bool(result.get("ok")),
            "withheld": not bool(result.get("ok")),
            "elapsedMs": round((time.monotonic() - started) * 1000, 2),
            "result": result,
        }
    except (PlaywrightError, PlaywrightTimeoutError, Exception) as exc:
        return {
            "browser": browser_name,
            "ok": False,
            "withheld": True,
            "elapsedMs": round((time.monotonic() - started) * 1000, 2),
            "reason": str(exc),
        }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    artifact_root = args.artifact_root.resolve()
    missing = validate_artifact_root(artifact_root)
    if missing:
        payload = {"ok": False, "stage": "setup", "missing": missing}
        if args.report_json:
            write_json(args.report_json, payload)
        print(json.dumps(payload, indent=2, sort_keys=True), file=sys.stderr)
        return 2

    browsers = args.browser or ["chromium", "firefox", "webkit"]
    with serve_probe(artifact_root) as url:
        results = [run_browser_probe(url, browser, args.timeout_ms) for browser in browsers]

    payload = {
        "ok": any(item.get("ok") is True for item in results),
        "all_requested_ok": all(item.get("ok") is True for item in results),
        "artifact_root": str(artifact_root),
        "browsers": results,
    }
    if args.report_json:
        write_json(args.report_json, payload)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

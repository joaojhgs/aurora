# @aurora/voice-web

Thin browser host contract for Aurora local voice workers.

This package defines safe browser boundaries for foreground audio capture, worker-owned inference, and browser-backed model storage. It does not request microphone access, run WASM inference, render UI, or promote any voice capability by default.

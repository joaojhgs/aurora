# Raven benchmark evidence schema

Raven benchmark outputs are generated evidence and belong under ignored
`.artifacts/pockettts/w0-raven/**`, not in source control.

Minimum runtime JSON accepted by `raven_gate.py benchmark`:

```json
{
  "evidence_kind": "measured",
  "first_audio_ms": 250,
  "audio_duration_ms": 10000,
  "generation_ms": 9000,
  "peak_memory_mb": 512,
  "download_bytes": 70254592,
  "cancelled_stale_audio": false,
  "device": "Pixel 8 / Android 16",
  "browser_or_runtime": "Android WebView 142.0.7444.60",
  "thermal": "nominal, no sustained throttling over 10 utterances",
  "source_commit": "1de0f10",
  "artifact_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

For P0.10, absence of a real browser/mobile runtime report must be recorded as
`blocked`, not as a pass.
Fixture or synthetic metrics may validate report shape only; they are never
release evidence.

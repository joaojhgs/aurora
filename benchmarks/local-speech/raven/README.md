# Raven benchmark evidence schema

Raven benchmark outputs are generated evidence and belong under ignored
`.artifacts/pockettts/w0-raven/**`, not in source control.

Minimum runtime JSON accepted by `raven_gate.py benchmark`:

```json
{
  "first_audio_ms": 250,
  "audio_duration_ms": 10000,
  "generation_ms": 9000,
  "peak_memory_mb": 512,
  "download_bytes": 70254592,
  "cancelled_stale_audio": false,
  "device": "example-device",
  "browser_or_runtime": "example-runtime",
  "thermal": "not-measured"
}
```

For P0.10, absence of a real browser/mobile runtime report must be recorded as
`blocked`, not as a pass.

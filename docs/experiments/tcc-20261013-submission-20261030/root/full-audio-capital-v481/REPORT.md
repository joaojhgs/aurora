# V481 private raw-artifact exporter

The source-only helper is `export-raw.py` (SHA-256 `04f338308bdc9ac8d43c05ab425e2ab78799a4c2b35c8ec117c2995a1860cfdc`). It is intended to run on the personal desktop, where its fixed input root is `/home/developer/projects/aurora/.git/aurora-audio-candidate-v481`; that directory is absent from this coding-worker checkout, so the helper was not run and no archive or receipt is claimed.

The allowlist includes the named candidate/manifests/repair/launch records, runtime launch/terminal/retirement/resource/provider-binding/version records, pilot result and TTS output, `runtime/voice-stages*`, plus only the WAV selected by `candidate-manifest.json`'s `wavPath`. Missing required records fail closed. Before export, the helper applies the prior V477 private-fixture byte scan. It excludes configuration, databases, backend logs and credentials. On the personal desktop, it creates the ZIP exclusively with mode 0600, records each member's byte count and SHA-256, creates the receipt exclusively, and emits `AURORA_V481_EXPORT` with bounded receipt metadata.

Root should perform the sole authorized execution on the personal desktop and verify the resulting ZIP/receipt there. This handoff does not claim that V481 inputs exist here, that export succeeded, or that any model/run evidence was independently revalidated.

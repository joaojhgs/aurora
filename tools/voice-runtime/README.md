# Phase 4 native voice runtime manifest

This directory contains the source/model allowlist used by the Phase 4 native
voice runtime decision gate. The validator is intentionally stricter than the
older W0 candidate gates: release artifacts must have exact URLs, versions or
commits, SHA-256 digests, byte sizes, license evidence, and a non-placeholder
status before they can be selected.

```bash
python tools/voice-runtime/validate_phase4_manifest.py
```

Generated build outputs, downloaded model weights, and reports stay under
ignored artifact directories.

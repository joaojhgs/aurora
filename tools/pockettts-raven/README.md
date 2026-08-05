# PocketTTS-Raven W0 conversion gate

This directory contains non-production preparation and verification tooling for
the W0 Raven conversion/provenance spike. It records immutable upstream inputs,
checks pack manifests, inventories static Raven assumptions, and emits bounded
run reports under ignored `.artifacts/pockettts/w0-raven/`.

The tools do not commit model weights, converted graphs, benchmark reports, or
sibling-project files.

## Commands

```bash
python tools/pockettts-raven/raven_gate.py manifest \
  tests/fixtures/local_speech/raven/pinned_raven_manifest.json

python tools/pockettts-raven/raven_gate.py provenance \
  --manifest tests/fixtures/local_speech/raven/pinned_raven_manifest.json \
  --sibling /home/developer/projects/sperandiodev \
  --upstream .artifacts/pockettts/w0-raven/source/pocket-tts-raven \
  --output .artifacts/pockettts/w0-raven/provenance.json

python tools/pockettts-raven/raven_gate.py conversion \
  --manifest tests/fixtures/local_speech/raven/pinned_raven_manifest.json \
  --pack english_2026-04 --dry-run \
  --output .artifacts/pockettts/w0-raven/conversion-english-dry-run.json
```

Run without `--dry-run` only when immutable source assets exist locally. Missing
weights or ONNX graphs are reported as first-failure evidence rather than
silently skipped.

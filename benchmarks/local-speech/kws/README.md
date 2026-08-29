# Aurora KWS Feasibility Harness

Phase 0-only foreground wakeword feasibility harness.

Generated models, audio, and reports belong under ignored
`.artifacts/pockettts/w0-kws/`. This directory contains only deterministic
source, fixtures, and tests.

## Commands

```bash
python benchmarks/local-speech/kws/kws_benchmark.py manifest
python benchmarks/local-speech/kws/kws_benchmark.py smoke --engine sherpa
python benchmarks/local-speech/kws/trained_pack_parity.py decide
node benchmarks/local-speech/kws/browser_frontend_absence.mjs
python -m unittest discover -s benchmarks/local-speech/kws/tests
```

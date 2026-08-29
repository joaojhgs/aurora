# Isolated Wakeword Training Tool

Non-production Phase 0 project for OpenWakeWord-compatible training/export
feasibility. It is intentionally outside Aurora's root dependency graph.

Generated models, datasets, synthesized audio, and reports must stay under
`.artifacts/pockettts/w0-kws/`.

```bash
cd tools/wakeword-training
uv sync --locked
uv run --locked aurora-wakeword-training inspect
uv run --locked aurora-wakeword-training smoke-python-import
uv run --locked aurora-wakeword-training write-feasibility-configs
uv sync --locked --extra runtime-smoke --extra livekit-train-voxcpm
```

The legacy `plan` command writes a non-executable scaffold only. The
reproducible W0 path is `write-feasibility-configs`, which writes ignored
LiveKit 0.2.1 YAML configs and a runbook to
`.artifacts/pockettts/w0-kws/reports/livekit-w0-feasibility-runbook.json`.
The lockfile is the source of truth for the training tool dependency graph,
including the exact runtime smoke NumPy pin.

After running the generated LiveKit commands, validate each exported ONNX with
the complete OpenWakeWord frontend:

```bash
uv run --locked aurora-wakeword-training validate-export \
  --model ../../.artifacts/pockettts/w0-kws/livekit-run/en-output/aurora_en_hey_aurora_test/aurora_en_hey_aurora_test.onnx \
  --positive-dir ../../.artifacts/pockettts/w0-kws/livekit-run/en-output/aurora_en_hey_aurora_test/positive_test \
  --negative-dir ../../.artifacts/pockettts/w0-kws/livekit-run/en-output/aurora_en_hey_aurora_test/negative_test \
  --label en

uv run --locked aurora-wakeword-training validate-export \
  --model ../../.artifacts/pockettts/w0-kws/livekit-run/pt-output/aurora_pt_ola_aurora_one_clip/aurora_pt_ola_aurora_one_clip.onnx \
  --positive-dir ../../.artifacts/pockettts/w0-kws/livekit-run/pt-output/aurora_pt_ola_aurora_one_clip/positive_test \
  --negative-dir ../../.artifacts/pockettts/w0-kws/livekit-run/pt-output/aurora_pt_ola_aurora_one_clip/negative_test \
  --label pt
```

`validate-export` is an integration gate, not a permissive smoke test. It exits
nonzero even when an ONNX export loads and scores, because W0 lacks corpus
FAR/FRR and Python/browser parity. The W0 evidence expects EN scores not to
separate positives from negatives and PT to show high false positives.
TypeScript trained-pack import must remain absent until complete Python/browser
mel, embedding, and classifier frame-score parity exists.

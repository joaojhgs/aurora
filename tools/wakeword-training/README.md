# Isolated Wakeword Training Tool

Non-production Phase 0 project for OpenWakeWord-compatible training/export
feasibility. It is intentionally outside Aurora's root dependency graph.

Generated models, datasets, synthesized audio, and reports must stay under
`.artifacts/pockettts/w0-kws/`.

```bash
cd tools/wakeword-training
uv sync
uv run aurora-wakeword-training inspect
uv run aurora-wakeword-training plan --language en --phrase "hey aurora"
uv run aurora-wakeword-training plan --language pt --phrase "ola aurora"
uv run aurora-wakeword-training smoke-python-import
```

The `plan` command writes an ignored training config scaffold. It does not run
GPU/data-heavy training.

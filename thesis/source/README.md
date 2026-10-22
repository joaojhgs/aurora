# Preserved production source

**Status: Current bounded check.** This directory makes the measured Python production source reconstructable without depending on an agent's private snapshot directory. It does not supply the complete environment, model-license inventory, hardware admission or experiment launcher.

The [source lock](production-lock-v1.json) records all400 source/config/contract files, their bytes and SHA-256, and full base revision `cbac78fe3fb2b73100bfaa9dc198fb6bff689840`. Of those files,388 match that Git revision. The [18,557-byte overlay](production-overlay-v1.patch) reproduces the remaining12 files. These are the preserved production changes used by the existing runs; creating this package did not alter production files or any active experiment.

The [reconstruction receipt](../validation/source-reconstruction-v740.json) records an actual offline Git patch check/application to a temporary collection of the12 base files, followed by exact output hash checks. No repository, worktree, agent, model or service was created. It proves reconstruction given the named base revision, rather than availability of that revision from an external remote.

For an idle authorized checkout containing the named base revision, the manual source preparation commands are:

```bash
git rev-parse HEAD
git apply --check thesis/source/production-overlay-v1.patch
git apply thesis/source/production-overlay-v1.patch
uv run --no-sync python thesis/verify_source.py --source . --output /tmp/aurora-source-check.json
```

Apply the overlay only when preparing the base source. If the source already contains it, run the checker directly. Keep active experiments and existing dirty work intact. The checker reads the selected tree; it does not checkout, reset, patch or stage files. Choose a fresh output receipt. Source files retain their ordinary repository paths; dependencies and model weights are not embedded in this overlay.

The [actual checker receipt](../validation/source-verification-v740.json) records400 matching files against the retained measured source, exit0 and zero new measurements. The script and its helper hashes, command, duration and exact lock/overlay bindings are retained. Its scope does not establish a runnable fresh environment or runtime/model equivalence.

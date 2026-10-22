# Data and results audit —17October2026

This is the distinct owner-authorized audit for Task `task_c626834bf1c6`, Dispatch `ctx_dda469327d6f`, original Run `run_e6054e76e9fc`. Scope is only `thesis/audit/20261017-data-and-results/`. Root retains execution/goal/resource ownership; the original monitor alone writes methodology. No commit, push, publication, new agent, model load, benchmark, device test or application-network request was performed.

- [Consolidated results](consolidated-results.md): named cohorts, allocation/outcomes, separate reported/recomputed metrics, backend/boundary identities, controls and mobile coverage.
- [Machine cohort inventory](cohort-inventory.json): complete primary/coverage entries and historical control objects, exact source references and unknowns.
- [Missing-data impact](missing-data-impact.md) and [classifications](missing-data-classification.json): recovered versus unlocated, scientific limits and optional-artifact clarification.
- [Copy/checksum/source/dedup manifest](copy-checksum-source-dedup-manifest.json): actual50,106,693unique imported bytes, canonical archive references, all source/member hashes and admissions.
- [V491 reconciliation](smoke/v491-reconciliation.json): original one-condition900localCPU allocation, distinct from nine-cell typedV317.
- [Recovered C06 observations](smoke/recovered-c06-observations.json): four complete progress-selected measured rows, final denominator UNKNOWN.
- [Request identity ledger](smoke/request-identity-ledger.json) and [native handler metrics](smoke/native-handler-metrics.json): populations remain distinct; joined/exported views add no requests.
- [Single saved-data smoke receipt](smoke/smoke-receipt.json) and [validation](smoke/validation.json): exit0, zero new measurements, all seven audio summaries/quantiles reconciled and no duplicated request identities.
- `final-completion-receipt.json` and `artifact-checksums.json`: final deliverable checks, limitations, Task/Dispatch and Root handoff; checksums exclude their own circular self-reference.

## Reproduce only from saved inputs

The saved-data entrypoint uses Python3.11 and the standard library. Its source SHA in the actual smoke receipt is `a7402b13c078bf1d9edb3fe3a1b460ebd1c28e05972bb156c0ad9316e57b3f8c`. The one execution in this dispatch was:

```sh
nice -n 15 ionice -c 3 uv run --no-project --python 3.11 python thesis/audit/20261017-data-and-results/analyze_saved_data.py --output smoke
```

The output directory must not already exist. A later authorized reproduction may choose a new directory **inside this audit folder**. The reader resolves content-addressed retained inputs and verifies each used object's saved SHA/bytes. It imports no Aurora application code, runs no SUT, loads no model and subtracts no cross-host clocks. `organize_results.py` renders the existing `smoke/` analysis into the current reports; it is report organization, not a second experiment or analysis smoke.

`acquire_*.py` and `export_personal_timing_packet.py` are retained provenance tools. Do not rerun acquisition or full archive hashes automatically. The Personal exporter was executed once by Root in its own approved window; the actual Root packet/operation/source-custody receipts bind that execution. Full raw Personal archives remain there; only selected historical fields are imported locally.

The128MiB initial import budget was sufficient. Import uses temporary files, fsync and atomic destination replacement, content hashes for deduplication, low-priority commands,4MiB/s paced bulk reads and a2GiB free-space floor. No duplicate huge archive/model copy was made. Existing canonical evidence and all active files/processes stayed read-only. The finite K1 snapshot is 2026-10-17T22:15:24.539734+00:00,135measured+15warmups, explicitly INCOMPLETE; current later live progress is not inferred from it.

Reports are an evidence-bounded scientific audit, not human author approval or publication. The owner's optional-artifact clarification supersedes any universal per-request-proof acceptance inference. [Canonical methodology read-only source](../../methodology/owner-requirements-20261017-9b03f764.md) was copied and hashed for provenance; this audit does not modify it or create a competing plan.

# Existing worker CPU V737 result sealing

**Status: Partial feature.** This is the source-reviewed, guarded finalizer for the existing frozen V737 campaign on `code-worker`. Its real terminal admission, single archive audit and saved publication remain future work. It does not start or stop a workload, reproduce inference, or replace the [portable CPU setup/launcher](../python-cpu-v1/README.md).

Root owns this action. Preserve the existing campaign, condition manifest, all raw cases and the source file. Wait for controller3038114 and backend3038148 to finish naturally and for their matching durable terminal and summary to exist. The finalizer also requires their absence, the unchanged `acbdc1d3827502513237220fcc3bf60cc3a007b7dc246b1a4b21b1a0ef8ce5fc` condition, input/source/harness pins, the existing global CPU reservation free and sufficient disk. It neither acquires a desktop GPU reservation nor makes a claim about another host's database.

Only after reconciling that terminal, from the existing repository:

```bash
uv run --no-sync python thesis/harness/worker-cpu-v737/post_terminal.py \
  --execute-finalization
```

Default invocation refuses before filesystem work. An existing export or retirement receipt also refuses: reconcile its actual outcome instead of running the audit again. The export is `worker-padded900-prep-v737/export-v762` under the retained handoff directory; retirement is recorded in its `runtime/retirement-v762.json`. These paths refer to this one already-running campaign.

The finalizer preserves all measured incorrect, failed, interrupted and timeout cases, unattempted counts and15 separately excluded warmups. It audits archived transcript/answer/ID predicates, saved PCM outputs, raw/summary denominators and Type7 populations once. Native spans pair within their actual process, clock, correlation and span identity. The frozen CPU observer emits decimal-string timestamps and no native case label: the parser uses the unique actual correlation-to-attempt mapping and leaves the native case label null, with an explicit missing count. Exact handler metrics remain separate and warmups stay out of measured quantiles. Queue, first token, streamed first audio and playback remain unknown.

Original files stay intact. Private configurations, fixture-bearing controller code, environments, databases, backups and raw backend logs are withheld; known sensitive values are used in memory for redaction, with source/export hashes retained. No weights are copied. The archive and its audit receipt remain available even if later publication cannot proceed.

Publication uses the existing `docs/experiments/tcc-20261013-submission-20261030/root/worker-cpu-padded-local900-v737` report directory. New files are written exclusively. The ZIP must fit40MB and the destination must retain actual archive/metadata bytes plus80MB reserve. Storage or publication trouble requires custody reconciliation from the saved audit receipt, without deletion, changed thresholds or another audit.

The [source custody and reviews](SOURCE-CUSTODY-v764.json) retain the original source findings and their closure. One [default refusal](../../validation/cpu-finalizer-default-guard-v763.json) and one [small parser main-flow check](../../validation/cpu-finalizer-parser-main-v764.json) passed with no models, services, measurements or real archive audit. The parser check used synthetic boundaries matching the actual observer format. Neither check claims a completed campaign,900-case seal, native result or full-surface acceptance.

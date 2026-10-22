# Completed local-only main session 1

Actual cell1 completed at 2026-10-14T08:26:50.206878+00:00, child exit0, elapsed 3301.369 seconds after its300-second baseline. It produced105 correct replies: five excluded warmups and100 measured. Failed, timed-out, cancelled and infeasible measured requests are all zero. [Strict receipt](result.json) validates105 ordered provider captures and their actual messages/settings/input fingerprints.

[Raw records](requests.jsonl), [provider captures](requests.jsonl.provider-inputs.jsonl), [1Hz resources](resources.jsonl), [settings](request-settings.json), [summary](summary.json) and redacted process logs retain this completed cell. Local Supervisor returned; its internal thread cleanup remains unverified in the retained [cleanup sidecar](requests.jsonl.cleanup.json), so this is not an all-thread-reaped claim.

Success-only Type7 quantiles in milliseconds: p50 30492.342810, p90 34627.554536, p95 36737.924277; n_success=100/n_total=100, warmups excluded. These are one loaded session's raw results. The planned three-session pooled n300 comparison, API/mesh differences and full campaign acceptance remain pending. No native/mobile/cross-region or causal-speedup result is inferred.

The same existing campaign has advanced to API cell2 baseline. No cell or pilot was rerun to obtain this snapshot. Original stdout/stderr remain private; [redaction receipts](log-redaction.json) hash originals and exported logs.

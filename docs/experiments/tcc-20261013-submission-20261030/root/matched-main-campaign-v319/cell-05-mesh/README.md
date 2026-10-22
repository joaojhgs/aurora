# Matched main session 2: mesh

The existing campaign completed this cell at 2026-10-14T12:48:33.381881+00:00 with child exit0 and validated105-request/provider-capture receipts. Actual report records contain five excluded correct warmups and100 correct measured replies, all with one completion, matching request/correlation IDs and consistent ordinals. Zero measured failures, timeouts, cancellations or infeasibility. Each request uses a fresh conversation within this one study process epoch.

[Raw redacted reply records](mesh-records.jsonl), [provider captures](provider-inputs.jsonl), [1Hz resources](resources.jsonl), [settings](request-settings.json), [summary](summary.json), [result](result.json), [report receipt](private-report-receipt.json) and redacted logs retain this closed cell. Full original report/logs remain private with hashes. Actual requester-to-typed-completion durations are retained; no monotonic timestamps are fabricated. Captures associate by ordered_serial_count, with null request_ordinal preserved.

Successful reply Type7 milliseconds: p50=35104.5, p90=41006.0, p95=42095.35. n_success100/n_total100, one loaded mesh session. Pooledn300 per route remains unfinished. Resources cover the total host; background attribution is unknown.

[Cleanup](cleanup-receipt.json): five reported-owned detached groups reaped; compose-down command succeeded. Final container reaping remains unverified without inspection; no all-host/process/thread claim. [Next restoration](next-autogen-cleanup.json) and [finalization](finalization.json) retain actual results.

The original driver advanced to session2 local-only cell06 baseline. No source/model/test replay was performed for this export. Independent artifact review is pending.

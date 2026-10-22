# Matched main session 2: API

The existing campaign completed this second API session at 2026-10-14T11:39:15.053469+00:00 with child exit0. Its existing validator passed105 request rows and105 matching provider captures, joining by actual request ordinals. Five correct warmups are excluded, and100 measured replies are correct; no measured failures, timeouts, cancellations or infeasibility.

[Raw requests](requests.jsonl), [provider captures](requests.jsonl.provider-inputs.jsonl), [1Hz resources](resources.jsonl), [settings](request-settings.json), [summary](summary.json), [result](result.json) and redacted process logs retain the actual cell. Source logs remain private; [redaction receipts](log-redaction.json) retain original hashes. [Cleanup](requests.jsonl.cleanup.json) records Supervisor return with internal threads unverified; no all-thread-reaped claim.

Successful reply Type7 milliseconds: p50=31975.320043, p90=36250.76030560001, p95=37587.2728986. n_success100/n_total100, one loaded session. Across accepted sessions API now has200 measured replies; the prescribed third API session and pooled n300 per route remain unfinished. Resource counters are total-host observations with unknown background attribution.

The original driver advanced to mesh session2 cell05 baseline. No first-epoch cell, model pilot or test suite was replayed for this export.

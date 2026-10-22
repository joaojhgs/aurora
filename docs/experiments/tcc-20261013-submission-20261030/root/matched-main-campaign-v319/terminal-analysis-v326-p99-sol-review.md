# V326 exact descriptive-p99 delta review

2026-10-14 UTC. **APPROVE / PASS, source only.** Actual native Sol reviewer result for Root relay; no Orca dispatch identity or external approval claim.

Exact hashes independently checked:

- Approved V325 base analyze.v325-approved.py: `8910de00b1f4918a2cd925681a83c4d8967839b6c716d42028b82c0d25284408`.
- Candidate analyze.py: `42c42917b30df199c27476bcf66ae8abbf638157b39e25f3a11828e1326c5ed8`.
- analyze-v326-p99.patch: `fbecb7fd7d2673b8d4973f815b2793966d168d2ef4f14f4006e55f25042020fe`.
- Author REPORT.md: `6f6febc2952b6e9807b554f9f90dff49e3b2527829310eb6b17217eb6c7935d7`.

The actual direct source diff matches the supplied patch. It only adds 99 to the shared QUANTILES tuple, adds the Markdown p99 output column, and qualifies p90/p95 as primary and p50/p99 as secondary. The existing Type 7 helper consequently computes p99 from the same successful measured observations for pooled/per-session summaries and descriptive block differences; it introduces no samples or alternate formula. Markdown header, separator and generated row each contain seven columns.

Matching validators, source pins, model/options, provider-capture checks, raw counts, five-warmup exclusion, denominator handling, terminal/full-cohort eligibility and lifecycle are unchanged. Existing stable_p99_claim=false and causal/regional/mobile/clean-host claim exclusions remain intact. Text explicitly qualifies p99 as descriptive across the observed sessions, without stable-tail, precision or causal-speedup claims. No material issue found in this literal delta.

No analyzer/exporter/test/data replay/model/build/service/network/device execution occurred. Only read-only source/hash/diff inspection and this sole owned private report write were performed. The live campaign, source/index, other work, goals/ledger/vault and orchestration were untouched. This is source approval only, not a completed-campaign, n=300, actual p99 result, stable-tail or whole-goal acceptance claim; earlier bounded review limits remain.

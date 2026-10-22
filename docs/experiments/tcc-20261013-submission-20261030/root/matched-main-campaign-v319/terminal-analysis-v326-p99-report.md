# V326 matched-input gate and quantile report

Private source-only analyzer candidate. Approved V325 baseline: `analyze.v325-approved.py`, SHA256 `8910de00b1f4918a2cd925681a83c4d8967839b6c716d42028b82c0d25284408`. Candidate `analyze.py` SHA256: `42c42917b30df199c27476bcf66ae8abbf638157b39e25f3a11828e1326c5ed8`. V326 delta patch SHA256: `fbecb7fd7d2673b8d4973f815b2793966d168d2ef4f14f4006e55f25042020fe`.

The prior matching gate could not accept a valid campaign because it compared random per-cell config hashes and required absent parent config/workload values. The corrected gate preserves per-cell config hashes as provenance and leaves missing parent values null/unknown. It reuses the hash-verified archived campaign validator for 105 ordered provider captures per cell and checks the pinned model, source, provider-input fingerprints, and Local/API raw workload SHA256. Mesh task matching is anchored by captured message/provider-input fingerprints.

Per-route successful-request quantiles use the existing archived Type 7 helper. p90 and p95 are primary; p50 and p99 are secondary. p99 is descriptive only across the three observed sessions and is not a stable-tail, precision, or causal claim. Existing denominators, failure history, session ranges, matched-block differences, and full-campaign eligibility gates remain unchanged.

No analyzer, campaign, test, service, model, network, browser, or device command was run. Root owns review and any post-terminal invocation; the live campaign remains untouched.

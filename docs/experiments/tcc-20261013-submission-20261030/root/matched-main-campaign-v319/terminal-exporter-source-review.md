# V320 bounded independent exporter source review

Date: 2026-10-14 UTC. Verdict: REQUEST_CHANGES for the exact frozen source below. Actual native Sol reviewer result for Root relay; not an Orca dispatch identity or external approval.

Reviewed exporter SHA256 `38fcc89eadfeec67bc35930503b0a5cf45c714beb66bc6cf66833b387dc6f87f`; author REPORT.md SHA256 `5b0924a364458a7fb5f29e10ca676b4b467029bf5e059da2c7ceb1343bfbfa89`. Scope is terminal export correctness and redaction only. No exporter, application, test, build, model, network, or device execution occurred. Live campaign and canonical source/index were untouched. This report is the sole owned write.

## Three necessary corrections

1. **Mesh raw rows and summaries cannot be exported.** `matched-main-export-v320/export.py:395` passes already-encoded JSONL bytes into `json_once`, whose line 75 JSON serialization rejects bytes. The caught TypeError marks every actual mesh report unavailable and skips its summary. Use the existing `write_once` for this byte payload; retain JSONL and its hash.
2. **Finalized cell failure can be reported as completed.** `export.py:361` chooses earlier cell/result.json ahead of the terminal campaign results by_index entry. The maintained campaign runner writes result.json before mesh finalization; its later owned-autogen check can change status to autogen_cleanup_unexpected_delta, retained in final campaign results/attempts/finalization. Prefer the terminal indexed result for final status, falling back to the earlier cell file only if absent. Preserve earlier provenance separately if needed.
3. **Workload hash is manufactured from absent data.** `export.py:116` hashes manifest.get('workload'), but this actual campaign manifest has no workload field. This produces a valid-looking SHA256 of JSON null, not a workload fingerprint. Retain unknown/null explicitly, or use an actual retained declared workload fingerprint with provenance. Do not substitute the effective provider-input hash for the workload hash.

Root independently identified the same findings. These are concrete paths in the current campaign/exporter, not additional edge scenarios.

## Final correction-only verdict — 2026-10-14 UTC

**APPROVE / PASS, source only**, for corrected exporter SHA256 `34ccb4fd3ebac585813a043e53c7e0db8f59b85936f336e4ad8626bffc7c766e` and author REPORT.md SHA256 `635f932c6e7c05725d853ad1cbe2b6ac2d05745cac2e9451ca0863fcac42d2c5`. All three findings above are closed: encoded mesh JSONL now uses byte-safe exclusive `write_once`; indexed terminal campaign results determine final cell status, with the earlier file only a fallback; absent/null workload remains null instead of receiving SHA256(JSON null).

Reversing only those three source substitutions in memory reconstructs the previously reviewed `38fcc89eadfeec67bc35930503b0a5cf45c714beb66bc6cf66833b387dc6f87f` bytes. No other exporter behavior changed. This was filesystem/hash inspection, not exporter/application/test execution. The original REQUEST_CHANGES is retained as failed-source history. Prior bounded positive scope and all limitations below still apply: per-session analysis only, no inferred pooled n=300, no successful-export or campaign-completion claim, and no live campaign/source/index mutation. Root owns the single post-terminal export and any separate pooled route analysis.

## Bounded positive assessment and limits

The corrected manifest return is connected. Export-time owner-current requirements and separately named historical authorization provenance are distinguished. Terminal-only admission, exclusive output creation, source snapshot verification and per-file hashes preserve the private campaign. Full Playwright reports and stdout/stderr are withheld; allowed local/API raw records are content-redacted by their fixed writer schema, while mesh attachments are projected without message/session/request identifiers or raw errors. Source snapshots are restricted to declared source paths. No additional credential/log exposure was found in this bounded actual-source review.

Local/API analysis uses the exact archived helper, whose current SHA256 is `2648b5579c487e15936bf2eafd70ae8b63db5567915ff4c1c1b318989da2a646`. Its per-group/session counts retain warmups, exclusions, failures/timeouts/cancellations/infeasibility and conditional successful-latency Type 7 p50/p90/p95. Mesh analysis remains per cell: measured observed rows form its denominator, failures remain counted, five warmups are separate, and successful observed durations alone enter Type 7. Missing/unattempted cells do not become synthetic request samples. The exporter does not pool the three sessions or establish n=300, stable tails, clean-host performance, mobile acceptance, or campaign success. Subsequent pooled analysis needs its own explicit denominators and session scope.

Maintained campaign runner SHA256 `c372126ca09f5f0f184f59fc7e2874f7f009125b210b1cc7ba4b96ce9141658f` supplies authoritative terminal statuses and already validates completed-cell 105 rows, 5/100 split, ordered provider captures and frozen inputs before advancing. Source approval of an exporter is not execution or successful export evidence. Root owns the three minimal fixes, exact source revalidation and the single post-terminal export; no campaign/model replay is requested.

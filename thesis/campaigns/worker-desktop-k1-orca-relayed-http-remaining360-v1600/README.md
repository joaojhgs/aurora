# K1 remaining requests: first 360 source preparation

Status: Source prepared only. No launch, model load, network request or new measurement.

This continues the retained K1 full-audio condition: worker CPU STT and LLM, with Piper TTS on Personal through the existing Orca HTTP route. The original 180 attempts (179 correct and one transport failure) remain unchanged. This first new session covers condition indices 181–540, with 15 additional excluded warmups. Indices 541–900 require a separate future admission. K3’s remaining 184 requests retain execution priority.

The retained audio, models, local CPU options, decoding, correctness, service algorithms and endpoint binding are unchanged. The old K1 startup changed only its local token field; the draft references the exact existing private configuration used during its measurements (211f086c…), without copying credentials. Safe error class/errno diagnostics reuse the reviewed V1590 helper; successful HTTP exchanges are unchanged.

The existing allocation proposes two eight-hour sessions within a versioned 20-hour cumulative cap. Each prepared session reserves 300 seconds for setup and 180 seconds for shutdown: 28,320 seconds for the condition and an outer stop bound of 28,620 seconds measured from controller entry. Admission and the ordinary warmup gate check provider lifetime and observed Type7 p95 with 20% margin. All old setup, condition and shutdown time now totals 10,027.780472366 seconds; this includes 31.136751280 seconds beyond the condition-only duration in the earlier allocation. The old frozen cap and results are unchanged.

The new provider identity, manifest, deadline and fresh resources are deliberately unbound. The draft cannot serve as actual admission. The current K3 provider/reservation is neither reused nor extended. Root must first obtain working control, reconcile existing ownership, bind the actual compatible provider/source/model/config/resources and existing credentials, freeze a new manifest and conduct the normal local/remote native warmup gate. There is no automatic second session, retry, percentile pooling or replay of prior measured indices.

Files:

- `condition-draft-v1600.json`: prospective exact inputs, accounting, unbound provider fields.
- `SOURCE-MANIFEST.json`: 12 source/input files with parent/current hashes.
- `SOURCE-DELTA.patch`: bounded count, namespace, accounting, admission and failure-metadata changes.
- `STATIC-VALIDATION.json`: nine Python files parsed, nine unchanged-function/diagnostic checks, exact scientific-field comparison; no runtime acceptance.
- `EPOCH-LINEAGE.json`: parent references and explicit condition indices.

Canonical requester sources: `thesis/harness/distributed-k1-http-remaining360-v1600/`. Original monitor review is requested only for this concrete delta. No current provider or frozen source was modified.

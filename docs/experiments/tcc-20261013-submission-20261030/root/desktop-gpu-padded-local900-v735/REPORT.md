# Matching padded-input desktop LocalBus condition

**Status: Current bounded check.** Actually launched on `personal.skyron-server` at 2026-10-15 22:00:59 UTC, controller3295193/backend3295224. Both were present at22:01:44, with three correct excluded warmups and zero measured requests. This is startup/warmup evidence, not a completed900-case result.

The run retains the qualified padded input, real production STT → Assistant → Piper TTS and strict transcript/answer/correlation/audio predicates from the sealed [HTTP condition](../desktop-gpu-padded-http900-v692/REPORT.md). The measured caller is typed LocalBus with a system principal/default priority50; the matching Supervisor graph includes an idle authenticated loopback Gateway. It does not measure end-user HTTP authentication or isolate pure protocol overhead. Actual STT/TTS remain CPU; the declared RX7600 Vulkan LLM setup must pass the fifteen normal warmups' native/provider/25-of-25-offload gate before measured1.

Frozen manifest SHA: `be108882b3024b33545f1484da00a56dccc5993e5c441b3eb3854102e7f14ac5`. Controller SHA: `fb7390e5111351833f782a504da3f914cf4e8b5775027cb93f0a4e8f595f5100`. Sol's finite delta approval SHA: `69e57e228a1b659f57ad0f3bcb5a60c0d58db1f0e11c623bd8ee47d0f5dc01da`. Raw root is `/tmp/aurora-root-padded-local900-v735`; source snapshot and six backend versions remain pinned. Admission verified418 file bindings and a fresh worker archive-filesystem observation, with positive120MB admission. Subsequent custody requires the actual archive size plus80MB reserve on the worker. Desktop source-volume space is observed; raw writes use the admitted separate `/tmp` volume.

The preceding V719 attempt, controller3293376 at21:55:49, exited naturally in0.006s with `existing_gateway_fixture_key_unavailable_or_ambiguous`. Root's outer launcher omitted the required existing fixture environment. No backend, model, warmup or measured request started. Its `/tmp/aurora-root-padded-local900-v689` manifest/runtime remain intact and the new manifest binds that failure. The corrected launcher passes the same one existing configuration fixture key to both required variables without printing it or changing credentials, grants or security. The fresh root/destination and launch wiring were the only reviewed changes; no model-quality inference or extra pilot was made.

Fifteen excluded warmups and900 measured requests remain frozen. Request cap180s, condition cap12,600s and outer cap12,780s; outer deadline2026-10-16 01:33:59 UTC. The matching [worker CPU condition](../worker-cpu-padded-local900-v734/REPORT.md) runs on disjoint hardware. No measured cross-device traffic is admitted before required comparable performance seals. Microphone/playback/Android rendering are separate affected-cell gates.

At natural terminal, retain raw cases, audio, stage/resource records and all outcome denominators, then perform one owned retirement/export/audit. Type7 p90/p95 are pending. Canonical portable setup/launch packaging is still a [partial feature](../../../../../thesis/README.md).

## Terminal update —2026-10-15 22:51 UTC

The controller ended22:50:20.981352Z after274 measured attempts:273correct,0incorrect,1interrupted,0timeouts,626unattempted;15 excluded warmups were correct. Both original PIDs were absent in the22:51:26 observation. The controller raised `FileNotFoundError` while measuring raw-artifact bytes for the changing `runtime/data/aurora.db-wal`, then cancelled its backend; the case summary retains `CancelledError`. No model-quality conclusion is drawn. The frozen source, manifest and raw records remain unchanged. Exact lock/database retirement and one partial archive/outcome/Type7 audit are pending; current summary quantiles are provisional. A separate minimal collector repair passed a deterministic source-only race check; it has not been launched. This partial condition will not be topped up or pooled silently.

The one saved-archive audit passed22:54:14Z:604members,10064090B ZIP SHA`1ef1dbd55dde983aea97852dadbeebd7f5540285655a0cbbd447b73b5784db33`. It reconciled all274 outcomes,288 valid outputWAVs including15warmups, original DB unchanged and both original PIDs absent/locks free. Type7 completed-only N273 p9010441.4039382ms/p9510628.3076392ms; all-attempt N274 p9010439.9133493ms/p9510625.74374005ms includes the interrupted duration and is a separately labelled distribution. This partial is not a900-case seal. Original raw/archive remain on desktop; worker saved-copy custody is pending. The [explicit compatible continuation](../desktop-gpu-padded-local900-v745/REPORT.md) retains every prior outcome and supplies626 remaining attempts with new IDs/manifest/warmups, rather than rewriting this partial or replaying900.

## Saved native-stage analysis

A separate actual saved-data analysis completed with exit0 and zero new measurements; the closed ZIP/outcome audit was not repeated. `analysis-v749/ANALYSIS-RECEIPT.json` binds source`b8fc433bae6e941bd8829df1fa65a5df42af94f2a45d1f3e7174aca8767a7932`, independent source approval and exact JSON/CSV outputs. It covers all274 attempted measured cases, including the interrupted overall case. All five exact handlers have274 valid completed spans, zero missing/multiple/invalid boundaries; completed spans do not turn the interrupted overall attempt into a success.

| Exact handler | N | Type7 p90ms | Type7 p95ms |
| --- | ---: | ---: | ---: |
| STT model invocation |274|3371.9605781|3443.82581585|
| STT service |274|3382.5907134|3469.7932463|
| LLM model stream |274|275.7507879|289.19386405|
| TTS model invocation |274|1676.4884798|1764.5427721|
| TTS service |274|1677.2884401|1765.2813636|

Metrics use paired spans within the original process/clock, grouped by exact handler. Wrapper/model timings overlap and must not be added or subtracted as independent quantiles. Native operation/attempt IDs are present for STT/TTS model spans and absent for service wrappers/LLM; request/correlation/case/span IDs retain their distinct meanings. Queue delay, first token, first streamed audio and playback remain unknown, not zero.

Worker custody completed2026-10-15 23:17:12.923439Z: allfive saved export files verified once by exact size/SHA,10981579B total. `WORKER-CUSTODY-RECEIPT.json` SHA256`782a653d10ccd3cc9f358af4868d72dce8f816b9f5de0e20609e88f90de7d534`; `EVIDENCE-LOCATION.json` identifies the local ZIP, metadata and preserved desktop originals. No ZIP/outcome audit was repeated for transport.

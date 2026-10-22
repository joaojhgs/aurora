# V409 correction-only private desktop observer source review

2026-10-14 UTC. **APPROVE / PASS, source only**, for the two essential F1/F2 corrections. Actual existing native Sol reviewer result for Root relay, with no additional worker/orchestration. Exact corrected observer.py SHA256 `784cc4bffc0d6824bbe378d17a7f632d587ca0a315896b048b2ebef727082df5`; README.md SHA256 `e85c88a0c8f356cc5dc869a11db60c9c970b3abf0ebac28ec24e39b81d7a30ae`. The original failed review/report remains unchanged and retained.

Read-only source review only: no imports/tests/application/model/build/service/network/device execution, no measured-source/index/goal/ledger/vault/campaign changes. This new private report is the sole owned write. Root owns any subsequent isolated integration/validation; live CPU campaign and desktop resource owners were preserved.

## F1 closed within the actual supported seam

observe now requires the actual SpeechLifecycleObservationV1 instance, rejects arbitrary Mapping/duck-typed model_dump objects, and counts rejected events. The existing source constructor validates finite event/stage/outcome/reason/clock metadata and bounded IDs/timestamps/counts before delivering it. The new span boundary validates fixed stage/event/outcome/reason values, safe bounded identifiers and a nonnegative integer monotonic timestamp; arbitrary raw outcome/reason values cannot pass into its JSON rows. Valid supported inputs therefore have the intended typed scalar payload; field projection no longer accepts uncontrolled nested arbitrary mappings.

DTO callback serialization/rejection failures are counted, and ordinary existing emit_speech_lifecycle isolates callback exceptions from speech work. This conclusion is limited to the actual validated DTO delivery seam and concrete private wrapper, not a claim that arbitrary callers can encode secrets as supposed identifiers or bypass their own provenance obligations. Caller IDs/labels must remain actual declared bindings, not raw content.

## F2 closed for the concrete recorder/wrapper

async_span protects both start and final record attempts with exception isolation. Capacity/closed-file/validation/IO failures no longer prevent yield/provider invocation or replace a propagating provider exception or asyncio.CancelledError. The body result/error/cancellation handling remains intact, with completed/failed/canceled outcomes and generated span identity. Recorder rejection/write/capacity errors remain incomplete-capture facts rather than provider-failure outcomes.

close now attempts owned descriptor close in finally after fsync, counts fsync/close OSErrors, marks the recorder closed and returns explicit capture_complete=false whenever write/rejection/flush counters are nonzero. It does not replace an owner's existing measured exception with these ordinary recorder IO errors. No provider retry, lifecycle/admission/auth change or new sampling behavior is introduced.

## Preserved coverage limits

Exclusive mode-0600 opt-in file, explicit host pseudonym, bounded event/byte caps and process/clock distinctions remain. trace_id stays null, unsupported joins and queue/tool/playback/render metrics remain explicit unknowns, and handler/provider labels require actual caller resolution. Source event timestamps/boot IDs are distinct from receiver receipt clocks. The wrapper interval still includes initial recorder overhead before the call; it is not inferred pure backend time, and cross-process/wall-versus-monotonic subtraction remains invalid.

No integration/runtime/metric acceptance, desktop GPU selection or GPU workload, CPU/GPU pooled comparison, cross-device readiness or whole-goal claim follows. This closes only the original two essential source defects under the documented seams. Root owns later source/GPU readiness gates and validation; no CPU model replay, expanded audit/matrix or new criteria are requested. Stop slice.

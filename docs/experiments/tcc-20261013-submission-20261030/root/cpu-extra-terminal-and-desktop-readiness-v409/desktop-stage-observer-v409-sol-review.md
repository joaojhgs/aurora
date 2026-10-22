# V409 bounded private desktop stage observer source review

2026-10-14 UTC. **REQUEST_CHANGES before desktop integration**, limited to two concrete essential fixes below. Actual native Sol retained-data/source reviewer result for Root relay; no competing worker or orchestration. Read-only source inspection only, no imports/application/tests/build/model/service/network/device/live-campaign execution or source changes. This report is the sole owned write. Measured CPU sources/campaign, desktop build, all WIP/index/goals/ledger/vault remain untouched.

Exact inspected anchors:

- Private observer.py: `a0324b478ca9c33d2000e09b864e1742fe2c06928d36dde86b0e575a7648dc68`.
- Private README.md: `35be0f9c0a9eb0209018c14fd9cd2eb3aa99a845e8b8df215504823d782a47c2`.
- app/shared/speech_lifecycle_observer.py: `774570be169f2f4cee0744d18a85045323797fd6fe7f84d92f24fb9aa8111076`.
- app/shared/contracts/models/speech_runtime.py: `1f7ea66c9a4619439130a6a200647b49a1df5b5b8cd17490c5aab0a371e88d94`.

## F1 — values are not constrained by the advertised redaction/schema boundary

`observer.py:75-86` accepts arbitrary mappings or any object exposing model_dump, then filters field names without checking values against SpeechLifecycleObservationV1. Thus an accepted mapping can put arbitrary text/nested credential data into outcome, reason_code or another allowlisted field, or label an arbitrary timestamp with a made-up clock domain. No contract validation rejects it before persistence. The existing actual DTO instead constrains event/stage/outcome/reason/clock to finite literals, IDs/revisions to bounded patterns and timestamps/counts to defined numeric representations.

`record_span` validates IDs/stage/event but writes caller-supplied outcome/reason_code and a stringified monotonic_ns without corresponding finite/type validation. A Python annotation alone does not constrain those inputs. This contradicts the private recorder's content-free/no-exception-string promise and can fabricate malformed timing records. Require the actual DTO or equivalent validation for observe, and fixed outcome/reason/nonnegative integer-time checks for the private span primitive. Keep arbitrary messages/exceptions/nested values out; count rejected observations as incomplete capture rather than allowing raw values into JSONL. This is value-boundary repair, not a new metrics schema or test matrix.

## F2 — observation failures can alter actual measured/provider behavior

`async_span:230` calls record_span before reaching yield. A capacity/file/serialization/validation failure therefore prevents the actual provider body from running. Its final record_span (`:258-273`) can throw while the provider exception or asyncio.CancelledError is propagating, replacing that actual error/cancellation with observer failure. `_write` deliberately raises for closed/capped/error cases and JSON encoding failures are not included in write_error_count. `close:203-205` also runs fsync before close with no finally; flush failure can leave the owned descriptor open and mask an owner's existing failure when close is used in finally.

The existing canonical observer protocol explicitly says callbacks must not control speech work; emit_speech_lifecycle catches observer exceptions to preserve that boundary. The private async wrapper lacks this protection. Make its observation attempts passive/best-effort with explicit capture-error accounting, preserving the body result, original provider exception and cancellation. Ensure the owned file descriptor is closed even if flush fails, with honest incomplete status rather than accidental provider-outcome replacement. No provider retry, admission change or model execution is requested.

## Bounded positive scope and missing metrics

The file is opt-in/unimported and exclusively created mode 0600, with explicit host pseudonym and event/byte caps. No engine is inferred from configured provider settings. Typed source speech events carry their own monotonic timestamp, clock domain and per-process boot_id; receiver stamps correctly describe callback receipt and are not substitutes for source time. Wrapper spans use the caller's Python monotonic clock and actual caller bindings. Their interval includes start-recording overhead before yield, so it must be described as an instrumented wrapper interval rather than inferred pure backend execution time; no cross-process subtraction is valid.

trace_id is always null, including wrapped calls. That is an honest unsupported correlation dimension, not evidence of a linked end-to-end trace. Optional actual caller trace binding could be supplied if subsequently required, but no trace should be invented or silently inferred from timestamps. DTO absence of request/session/handler/provider binding is correctly explicit, and queue/first-token/tool/playback/render/DB stage completeness is not established by this candidate. Missing metrics and these documented limits are acceptable for this bounded recorder; they are not additional blockers or a demand for broad instrumentation.

Verdict applies only to the two private source files and their stated existing seams. It does not establish desktop GPU selection, metric acceptance, any workload/campaign pass, all-stage timing, CPU/GPU comparability or cross-device readiness. Root owns minimal corrections and later integration/validation after existing source/resource gates. No unchanged CPU benchmark replay or extra audit/matrix is recommended; stop slice.

# V248 exact empty-think normalization source review

Verdict: **REQUEST CHANGES for one minimal source-flow correction.** The captured single-empty-block nonstream repair and focused regression are sound, but the streaming main normalizes the final value twice, violating the stated one-block scope and permitting return/event/history disagreement. This review is confined to the two owned diffs; no incremental stream redesign, broader edge matrix or feature/aesthetic review is requested.

## Required correction: normalize once per final path

`app/services/orchestrator/service.py:1978` now removes one leading empty block into publish_text. The streaming finalizer persists/emits that one-pass closure value (:2027–2051), and `_process_streaming_input` returns it at :2057. Its caller `_process_input` then applies the same count=1 substitution again at :1683, before returning the response at :1788.

Consequently the streamed return has two normalization passes while terminal event/history have one. A leading pair of empty blocks demonstrates the difference directly from this connected source flow: one remains in stored/emitted text, but the second pass removes it from returned text. This is a source-contract counterexample, not an executed new sample or a request for a new test matrix. Because the candidate expressly strips only ONE leading empty block and preserves the remaining body, the duplicate pass should not be retained.

Minimal correction: apply the outer normalization only to the nonstream result, since the streaming function already normalizes its final result, or otherwise ensure a single shared normalization result is used by return/history/event. Do not alter production permissions/models/prompts, relax the pilot predicate or redesign incremental streaming. Root owns any source amendment and exact amended hash receipt.

## Confirmed captured-case behavior

The new regex is anchored at the beginning, matches lowercase `<think>`/`</think>` only when the enclosed text consists solely of spaces/tabs/CR/LF, and removes only surrounding leading/separator whitespace with that empty block. It does not match nonempty reasoning, later body tags or arbitrary answer content. For the retained public case `<think>\n\n</think>\n\nORBIT`, the nonstream insertion is before assistant persistence, response publication/TTS and return, so all three reviewed final boundaries receive ORBIT. User prompt, task success predicate, source/session/request/correlation metadata, models/settings, typed bus topics and auth ownership are unchanged by the owned diff.

The modified persistence test invokes actual `_process_input` with a graph mock returning the captured string, rather than only testing regex substitution. It checks ORBIT return, actual typed assistant DB-save payload, response event text, preserved request/correlation metadata, event correlation, principal and mesh=false. The existing user/persistence ownership assertions remain. This is a meaningful nonstream boundary regression, not a real-model/runtime PASS or stream regression proof. Tests were read only.

Terminal streaming persistence/completion normalization is source-supported, but delta tags and active TTS incremental buffers are unchanged. No incremental hidden-thought rendering/audio sanitization or full streaming contract acceptance is claimed; the requested narrow final-only scope remains explicit.

## Exact reviewed anchors and limits

| File | Independently verified SHA-256 |
| --- | --- |
| app/services/orchestrator/service.py | `36592a325e223e3e7b1788bdf3051dd6f795e941e9ffe3b60329bbd226d868e0` |
| tests/unit/orchestrator/test_session_persistence.py | `3e171573ddac0d2eaed0f244207bd4934fcd6efb74fbca1997c409f058624390` |

Read the exact two-path Git diff and surrounding final/persistence flow in the existing V237 worktree. Only this private report under canonical Root .git was written. No source/index/goal/vault changes, tests/build/services/devices/network/CI, commits/push or recursive agents. No ownership conflict/resource exhaustion; three-minute bounded review completed at this single correction. V247 actual capture attribution is Root-provided, not a new reviewer run or general model success. Root owns the targeted unit check and one affected local/API main under the global lock after amendment/approval. Native independent Sol evidence is relayed through the unchanged original Orca run/monitor without fabricated dispatch or external approval.

## 2026-10-14 — exact nonstream-guard closure

Final delta verdict: **APPROVE corrected source SHA-256 `0b77092091946b94130945b3bfb670a922a209b846d5ffe30e23f75b52f982f3`; the sole V248 finding is closed.** Test source remains exactly `3e171573ddac0d2eaed0f244207bd4934fcd6efb74fbca1997c409f058624390`.

Independently verified the outer substitution is now guarded by `if not stream`, so only nonstream graph output is normalized there. Streaming still normalizes once in its own final publish_text and returns that same value; its finalizer persistence/event and outer return therefore no longer differ through a second substitution. No additional review criteria, edge cases or tests were introduced. The original captured-case/source-only and incremental-stream limitations above remain.

Root reports the initial four-test module passed before this guard and owns the final targeted module and affected real LocalBus/API main. No reviewer test or runtime PASS is asserted. Only this dated delta was appended to the same private report; no script/source/index/goal/vault changes or executions occurred. Ninety-second closure cap honored, no conflicts/resource exhaustion. Approval is of the exact source correction, not full platform/model/route acceptance.

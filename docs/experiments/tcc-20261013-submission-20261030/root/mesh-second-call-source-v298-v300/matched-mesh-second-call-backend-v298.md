# Matched mesh second-call backend source check (V298)

## Result

The second-call mismatch remains **unknown**. The existing receipt proves that
the first browser WebRTC mesh attempt completed exactly, while the second
completed through a fallback in 156 ms without matching the expected response.
The retained backend log has no safe per-call failure discriminator. The
available source explains fallback behavior but does not establish why the
second call differed. No source fix is justified by this evidence.

## Retained evidence

- Receipt: `.git/aurora-handoff-import-20261006/matched-readiness-v296-mesh/safe-measurement-receipt.json`
  SHA-256 `56daf50f93c0db616b8c93312dd6cc4bd4d35f1adae1e75549021467bb1fe4c1`.
- Python service log: `.git/aurora-handoff-import-20261006/matched-readiness-v296-mesh/artifacts/python-service.log`
  SHA-256 `c71b3eee71a14f8f34938468d384668edbb84da6404a310cf1e2f5de06198db9`.
- The two receipt rows have one completion each. The first is `completed_exact`,
  `exactResponse=true`, `completionKind=fallback`, and took 42,207 ms. The
  second is `completed_mismatch`, `exactResponse=false`, `completionKind=fallback`,
  and took 156 ms. Both have a null error code. The receipt also records one
  provider-input hash match for the first provider invocation; it does not
  establish a second provider invocation.
- A fixed-marker scan of the retained service log found no stream execution or
  failure, non-stream inference, RPC error/timeout, service error, route denial,
  or ORBIT event marker. This establishes only that this log has no such
  searchable discriminator; it does not prove those events did not occur under
  another log shape.

## Source boundary

- In `app/services/gateway/webrtc/rpc.py:1640-1683`, stream inference uses
  `stream_request` when available. If that API is unavailable or reports a
  recognized transport-unavailable error, the handler takes the non-streaming
  fallback.
- `app/services/gateway/webrtc/rpc.py:1920-1980` converts that fallback into
  one final chunk and EOF. This is consistent with the receipt's fallback
  classification, but does not explain the second response mismatch.
- `app/services/gateway/webrtc/rpc.py:721-745` rejects duplicate *active* RPC
  IDs and removes the ID from its active map when the call ends. This is not a
  completed-request or session-level deduplication contract.
- `app/services/gateway/webrtc/rtc_client.py:4860-4921` creates a fresh UUID
  for each outbound call and returns `None` on timeout or send error.
  `rtc_client.py:6080-6100` resolves a pending result only for its matching ID
  and peer. These paths do not identify the cause of the recorded mismatch.

## Limit and next action

Do not infer an authorization, route, cache, session, or model fault from this
receipt. Root may use a future already-authorized main-flow run to capture the
existing fixed error/category and completion correlation at the failing
second-call boundary. This report adds no instrumentation or test request and
makes no runtime acceptance claim beyond the two retained receipt rows.

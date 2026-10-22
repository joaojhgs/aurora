# V839 K2 bounded review corrections

## Outcome

Prepared `k2_composition.py` and a private copy of the reviewed V819
`stage_adapter.py`. The composition calls worker-local STT only through the
typed Supervisor message bus, sends its actual transcript to the real
Gateway's `Orchestrator.ExternalUserInput`, then sends the actual returned
assistant text to the real Gateway `TTS.Synthesize` contract. It validates
strict transcript and reply word predicates, response identifiers, WAV format
and PCM validity. It returns private audio bytes separately and keeps text and
audio payload out of metadata. No runtime, service, model, test, or network
operation was performed.

V839 applies only the two output-check corrections requested by the V837
review: returned WAV validation failures are translated to a TTS-stage
failure through the partial-record path, and the response channel count plus
decoded WAV header are both required to be mono. The actual TTS response
metadata is stored before validation, preserving prior STT/Assistant stages.
The production input-WAV check retains its separate input-stage classification.
Review basis: `.git/aurora-handoff-import-20261006/distributed-k2-composition-review-v837/SOL-REVIEW.md`, SHA-256 `38832b501422df0515b1fbca99297d4f4d26a76a60354d317bf97201e43ed784`.

The caller supplies the frozen expected local STT model and remote Assistant
provider/model; the function rejects self-reported identity mismatches. This
is only a response identity check. Actual provider implementation/settings and
remote TTS model identity still require independent backend/provider receipts
and configuration freeze.

## Production route semantics checked

- `OrchestratorService.process_external_input` returns an
  `OrchestratorResponse` containing the graph result, request/session/correlation
  IDs, and metadata; exceptions are converted into an error response with
  `metadata.error=true` (`app/services/orchestrator/service.py:655-727`). The
  route therefore returns an actual answer contract rather than an ACK. The
  candidate rejects error metadata, graph `END`, empty text, and mismatched IDs.
- The non-streaming path runs the configured orchestration graph, publishes its
  completion event, and may request TTS (`service.py:1521-1865`). Its decision
  uses the remote runtime's automatic-readback configuration. It does not use
  `client_tts_playback` to suppress that non-streaming request. The candidate
  requires a separately verified false effective setting and returned
  `tts_status="skipped"` before issuing its explicit TTS HTTP stage.
- The Gateway's typed handler dispatches through the registered handler and
  serializes the returned model (`app/services/gateway/route_generator.py:1010-1048`).
  Relevant contracts are `TranscribeAudioRequest/Response`,
  `OrchestratorProcessRequest/Response`, and `TTSSynthesizeRequest/Response`.
- `TTSSynthesizeRequest` has no request/session/correlation fields
  (`app/shared/contracts/models/tts.py:174-203`). Consequently the candidate
  retains the Gateway response correlation separately and does not fabricate
  request-level TTS IDs.

## Source references

- V802 local-STT/typed-bus and local Assistant runner pattern:
  `.git/aurora-handoff-import-20261006/distributed-k1-http-prep-v802/runner.py`,
  SHA-256 `45d2c3f4df7353c2fc162c6986d125096b64216a76575a8a1d5bae4e5c154b0f`.
- V819 reviewed HTTP adapter copied into this private directory:
  `.git/aurora-handoff-import-20261006/distributed-k2k3-http-prep-v819/stage_adapter.py`,
  SHA-256 `204ea4d6b48571ab7ba0add0310a3dadd87b5e1e2afdc172634185755c9bb02c`.
- Production source inspected: `app/services/orchestrator/service.py`, SHA-256
  `0b77092091946b94130945b3bfb670a922a209b846d5ffe30e23f75b52f982f3`;
  `app/services/gateway/route_generator.py`, SHA-256
  `40ccde0e90273842ccdedb331f63e8cb979b22bc9d3d5ce2caaab1a2bbdd9a83`.
- Contract source inspected: `app/shared/contracts/models/orchestrator.py`,
  SHA-256 `cf7f048c0678f298141a59b031be420772b83e649ec2910053d4f372cfaf2df9`;
  `stt.py`, SHA-256 `3c56b2d5a5435a971465ac5b132d8b5d78d18cfe02506813631a4b67e401c703`;
  `tts.py`, SHA-256 `e6ca2ebe21b928506be0bf8c3bf88eb9ad3f582b0aae80bba361c326b2bde744`.

## Remaining admission

This implementation is one-case K2 composition only. Root must integrate it
with the existing 15-warmup/900-measured runner and preserve case-level partial
failures. A future freeze must bind the exact remote Assistant/TTS endpoints,
the existing API-key identity without exposing its value, actual remote
provider/model settings and receiver-side stage/correlation records, and the
remote effective automatic-TTS setting. Existing V430 response telemetry
provides a Gateway response `X-Correlation-ID` only when the established
telemetry environment binding is enabled; the receiver gate must prove that
binding. K3 remote-STT composition is not implemented by this slice.

Validation: Python AST parse only; no module import, test, service, network,
model, or runtime execution. V839 files and hashes:

- `k2_composition.py` — recorded in the Root handoff after AST validation.
- `stage_adapter.py` — unchanged copied V819 SHA-256
  `204ea4d6b48571ab7ba0add0310a3dadd87b5e1e2afdc172634185755c9bb02c`.

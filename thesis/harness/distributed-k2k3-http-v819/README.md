# Distributed K2/K3 HTTP stage adapter (source preparation only)

`stage_adapter.py` provides one typed, authenticated Gateway HTTP stage call.
It is deliberately not a campaign runner: it does not choose or discover an
endpoint, start a service, perform local inference, chain stages, or establish
acceptance. A future condition must supply each stage's exact frozen endpoint
and SHA-256 binding and the already approved API key through the existing
process environment.

The existing typed contracts provide the stage requests/responses:

- STT: `TranscribeAudioRequest` -> `TranscribeAudioResponse` at
  `/api/Transcription/Transcribe`.
- Assistant: `OrchestratorProcessRequest` -> `OrchestratorResponse` at
  `/api/Orchestrator/ExternalUserInput`.
- TTS: `TTSSynthesizeRequest` -> `TTSSynthesizeResponse` at
  `/api/TTS/Synthesize`.

The intended future compositions are K2 (real local STT, then this adapter for
assistant and TTS) and K3 (this adapter for STT, assistant, and TTS). The
caller must pass the actual captured audio to the STT contract and the actual
typed assistant result to TTS. No transcript or reply is synthesized by this
module. `server_correlation_id` is retained as a distinct response-side
identifier; local request/session/correlation values are reported separately
from request payload fields when present. Each call has its own monotonic
duration and payload byte/hash facts.

An `http_timeout`, `request_timeout`, `transport_ambiguous`, redirect, invalid
binding, missing server correlation, or invalid typed response is marked
`stop_campaign=True`. The timed-out/ambiguous call may still be running at the
receiver, so the caller must not start another case. Explicit non-timeout HTTP
status failures are terminal stage failures (`stop_campaign=False`); callers
still must not retry a request. Redirects and ambient proxies are disabled.
Response bodies are size-bounded and never included in errors or metadata.

This source-only adapter is not yet wired into the full K2/K3 runner, local
STT bus path, stage-by-stage receiver proof, 15-warmup gate, 900-measured
controller, or frozen condition manifests. Endpoint hashes, provider identity,
model/config bindings, real receiver correlations, source equivalence, and
resource/retirement admission must be independently supplied and verified
before any future execution. No runtime or acceptance claim is made here.

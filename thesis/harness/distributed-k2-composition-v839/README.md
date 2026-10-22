# K2 composition candidate (private source only)

`k2_composition.py` composes one real K2 case: the worker's `Supervisor.bus`
handles typed local transcription; the existing stage adapter sends the actual
transcript through the production `Orchestrator.ExternalUserInput` HTTP
contract; then the actual returned assistant text is sent to production
`TTS.Synthesize` HTTP and the received WAV is decoded and checked. There are
no retries, direct service calls, mock answers, transcript substitution, or
synthetic stage results. Failures carry a safe partial stage record for the
owning runner to persist.

The remote Assistant service must have its effective
`ui.assistant.automatic_tts_readback` setting independently frozen and proven
false before the caller sets `remote_auto_tts_readback_disabled=True`. The
production `ExternalUserInput` non-stream path can request local server TTS
when that setting is enabled; `client_tts_playback=True` alone does not disable
that non-stream behavior. The returned metadata is also required to say
`tts_status="skipped"` before this composition issues its separate remote TTS
request. This prevents silently overlapping server and client TTS.

The output record contains only identifiers, stage timings, hashes, sizes,
finite status/correctness fields, and no transcript/reply/audio content. The
validated WAV bytes are returned separately to the future runner for private
artifact persistence. TTS's typed request has no caller request/session ID
fields; its server `X-Correlation-ID` is preserved separately by the adapter.
The caller supplies frozen expected identities for local STT and remote
Assistant provider/model; returned STT and Assistant metadata must match them.
Remote TTS identity still requires its independent receiver-side binding.
The returned TTS stage metadata is recorded before decoding/validation so an
invalid WAV failure retains preceding stages and actual TTS response facts.
Synthesized output must be mono PCM16 WAV; response channels and WAV header
must both equal one.

This is one-case composition code, not a campaign runner or completed K2
condition. It does not implement the K2 15+900 controller, independent remote
provider/receiver gate, actual remote model/config identity, native-span join,
or condition freeze/admission. The supplied remote endpoints and their exact
hashes must come from separate Root admission. No K3 wiring is claimed here.

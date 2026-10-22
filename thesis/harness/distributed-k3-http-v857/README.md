# V851 distributed K3 source bundle

This is a private, unlaunched source candidate for one cumulative remote
condition: the code-worker submits the fixed WAV through the authenticated
Gateway HTTP `Transcription.Transcribe`, then sends the returned transcript to
`Orchestrator.ExternalUserInput`, then submits that exact Assistant reply to
`TTS.Synthesize`. All three stages use independently admitted exact endpoint
bindings and server-side receiver identities. No local STT, LLM, or TTS result
is accepted as a substitute.

The existing three-key input, exact normalized transcript/Paris predicates,
15 excluded warmups, 900 measured requests, 180-second request limit,
57,600-second condition cap, no retry behavior, write-once attempt artifacts,
and partial-quality accounting are preserved. Automatic server TTS must be
frozen disabled before the explicit TTS request. The output must be a valid,
non-silent mono PCM WAV. This source preparation is not a run or acceptance.

## Receiver proof required before measured request 1

`receiver_proof.py` consumes the 15 successful requester warmup attempts, the
retained receiver V430 spans and actual provider-binding rows, and three
separately admitted receiver identity receipts (`stt`, `assistant`, `tts`).
It requires 45 distinct request-to-native-span joins, actual receiver PIDs,
own-process monotonic boundaries, model/config file hashes, and actual
constructor/provider bindings. The STT identity is the server engine and
weights; the request's `model_used: accurate` is only the selected route label.
For TTS it also pairs each native invocation to the actual Piper call and
canonical model/config paths.

The STT receiver identity has three additional fields:
`constructor_directory` (the exact canonical directory passed to
`WhisperModel`), `tokenizer_sha256`, and `vocabulary_sha256`. Its actual file
receipt must include that directory plus the regular pinned members
`model.bin`, `config.json`, `tokenizer.json`, and `vocabulary.txt`, each with a
canonical path and matching independent hash. The proof requires all four
member paths to be direct children of the independently admitted constructor
directory and compares the recorded constructor argument to that directory.
This preserves the weight-file identity while correctly representing the
directory-valued Faster-Whisper constructor input.

V430's Assistant `resolved_chat_model.astream` boundary supplies a native
`span_id` and correlation but no `operation_id` or `attempt_id`; those fields
remain null with the explicit source-contract reason. STT and TTS retain their
actual operation and attempt IDs. Request-body hashes identify the Gateway
request only; they are not presented as the LLM's augmented model-input hash.

After independent evidence collection, Root may assemble a private proof with
the helper's `--stt-identity`, `--assistant-identity`, and `--tts-identity`
arguments. The runner then validates that proof under its private run output
before measured request 1. The helper does not call an endpoint or launch a
service.

## Remaining launch requirements

Root must supply an independently frozen source closure/inventory, exact
effective runtime config and model files, three exact endpoint URLs plus the
existing Gateway API-key binding, three receiver identity receipts, and
resource/lock admission. The personal Gateway provider/source/config and
network route are not staged here. No credential values, model files, actual
receiver proof, service, model invocation, test, build, or network request is
included in this candidate. The copied requester-side supervisor still uses
the admitted worker runtime; only its case calls are routed to the three
remote Gateway endpoints.

The source check was Python AST parsing only. No runtime or acceptance claim
is made for this candidate.

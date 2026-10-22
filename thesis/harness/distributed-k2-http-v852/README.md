# V852 distributed K2 source bundle

This private, unlaunched bundle composes worker-local typed-bus STT with a
personal-desktop Gateway `Orchestrator.ExternalUserInput` request and explicit
Gateway `TTS.Synthesize`. It carries forward the reviewed V842 15-excluded /
900-measured runner, V839 one-case pipeline, V819 HTTP adapter, and V843
retained-Supervisor lifecycle. The new controller/bootstrap and receiver proof
assembler connect those pieces without creating endpoints, credentials, roles,
permissions, or provider changes.

The exact fixed public audio/question/answer inputs, strict transcript and
Paris predicates, request/condition limits (180 seconds / 57,600 seconds),
no-retry behavior, write-once artifacts, and original-model gates remain. The
K2 stages are real: LocalBus STT asks for route label `accurate`; the actual
worker CPU constructor/model/settings are checked separately. Assistant and
TTS are independent authenticated HTTP requests. Automatic server TTS must be
frozen disabled. Returned TTS audio must remain a valid non-silent mono PCM WAV.

## Independent remote receiver warmup proof

Before measured request 1, runner requires `AURORA_K2_REMOTE_WARMUP_PROOF`
under the private output directory. It must contain exactly 30 calls, one
Assistant and one TTS native invocation for each of the 15 successful warmups,
and bind the exact input/cohort manifest hashes and expected receiver identities.
The assistant identity has `receiver_id`, `source_sha256`, `provider_class`,
`model_sha256`, and `config_sha256`; assistant `config_sha256` must match the
frozen config binding with `automatic_tts_readback: false`. The TTS identity
uses the same identity fields with actual Piper model/config file hashes.

Assistant native spans are V430 `stage=llm`, handler
`resolved_chat_model.astream`. The proof maps that exact source boundary to
proof stage `assistant`. It preserves the actual `span_id` as `native_span_id`;
`operation_id` and `attempt_id` remain null with reason
`v430_async_span_exposes_span_id_only`. TTS remains `stage=tts`, handler
`tts.model_invoke`, and requires actual non-null operation and attempt IDs.
Both stages require their actual receiver PID, monotonic boundaries, exact
Gateway correlation, and independently verified provider identity. The
request-payload SHA binds only the corresponding Gateway request body; it is
not represented as the augmented LLM input hash.

`receiver_proof.py` is a one-shot offline assembler over the 15 requester
warmup attempt files and independently retained receiver stage rows, provider
bindings, and separate assistant/TTS identity receipts. It checks the actual
LLM constructor/model path and actual Piper model/config calls within TTS spans,
then writes the proof exclusively with mode 0600. It does not start a service
or call an endpoint. Example invocation after Root stages actual evidence:

```sh
python receiver_proof.py --attempts-dir /private/run/attempts \
  --receiver-stages /private/receiver/voice-stages.jsonl \
  --provider-bindings /private/receiver/actual-provider-bindings.jsonl \
  --assistant-identity /private/receiver/assistant-identity.json \
  --tts-identity /private/receiver/tts-identity.json \
  --candidate-manifest-sha256 <input-manifest-sha256> \
  --cohort-manifest-sha256 <cohort-manifest-sha256> \
  --expected-receivers /private/frozen-expected-receivers.json \
  --output /private/run/remote-warmup-proof.json
```

## Honest accounting and remaining admission

The runner preserves strict helper failures. If transcript or answer correctness
fails before TTS, the attempt remains a failed partial flow, and a separate
`partial_quality_incorrect` count records the failed quality predicate. It is
not relabeled as a completed incorrect full pipeline or silently omitted from
the attempted denominator.

The controller requires the staged `stage_adapter.py`, validates both `remoteReceivers` entries (`assistant` and `tts`), and independently checks the `k2_composition.py` hash against the frozen implementation pin. The controller fails closed unless Root supplies the independently frozen
source closure, actual local config/model paths, candidate/cohort manifests,
endpoint hashes, existing auth binding, actual assistant/TTS receiver
identities, and resource/lock admission. No actual endpoint, credential, model,
source-closure proof, receiver files, or launch admission is included here.
No service, model, request, test, build, device, or network operation was run.

## Provenance and source-only validation

- V842 runner source and exact localized V847 fixes: runner route-label,
  assistant span-ID proof contract, and partial-quality denominator.
- V839 one-case production pipeline and V819 reviewed HTTP adapter.
- V843 controller/bootstrap/bindings/V430 observer and resource lifecycle.
- V804 offline proof implementation pattern; V847 assembler maps the real V430
  assistant span contract rather than inventing operation/attempt identifiers.
- Python AST parsing only; not runtime validation or acceptance.

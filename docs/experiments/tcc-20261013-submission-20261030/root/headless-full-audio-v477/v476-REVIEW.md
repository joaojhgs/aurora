# V476 bounded independent prerecorded full-audio pilot source review

2026-10-15 UTC. **APPROVE the reviewed private four-file headless pilot source for one Root-owned execution.** Source/hash/stdlib AST inspection only; no imports/tests/application/models/audio/browser/build/network/device/Orca operations, canonical/index/goals/vault edits or new agents. This report is the sole owned write.

Exact inspected source SHA256:

- controller.py `85e9a4d299c455fb0e534c25378c998f15d040f00f6d1a6176977f6ec4a823fb`.
- bootstrap.py `782091f55804e6002f5422b07dca661ea43dc41e7f79b1c6c9bbe6f822965f31`.
- bindings.py `4a5e406a1a801b84615a695ae03ecd5a13a81db4eb055946524ce0b350d706f3`.
- pilot.py `9e6e7d3e9da8b2641aadfa7086e76322340f34afafa9901fd35a220081de718d`.

All four parse. No substantive main-path launch blocker found in this bounded packet.

## Actual requested pipeline, not substituted input

Controller and pilot verify the exact complete fixed WAV SHA256 `2f6361506708d0a3065a339d168c9db5412e343683dd9b4080471d8948bf82ae`; pilot also verifies mono22050Hz PCM16/nonempty source profile. The existing finite transcription boundary supplies the reviewed16k Whisper conversion. Accurate base CPU/int8 is configured; the actual finite call uses model=accurate with auto language and existing beam5/VADtrue behavior. The pilot forwards **actual stt.text** to the ordinary typed ExternalUserInput contract, then forwards **actual assistant.text** to ordinary TTS.Synthesize. Expected text is used only for explicit correctness comparison; it never replaces either result. Actual response contracts, failure flags and returned session/request/correlation IDs are inspected. All pipeline stages may complete while correctness fails, recorded as completed_correctness_failed with nonzero exit; this is not a false successful task claim.

Actual bus dispatch uses typed constants/Pydantic requests, the original Supervisor initialize/start/config subscription lifecycle and its LocalBus. The internal/system principal is the declared headless local control path, not a claim that public UI/HTTP authorization passed. Importing main performs its normal configuration setup; the pilot does not invoke its blocking main loop or startup greeting. Automatic server readback must be disabled before the one explicit synthesis. Supervisor's existing shutdown method exists. No STT/LLM replay, phrase/model ladder, mock provider, transcript correction or alternate answer path is added.

TTS success requires a real typed WAV response, strict base64 decoding and parsed nonempty monoPCM16 with matching response rate/channels; output bytes are exclusively written with hash/dimensions. It synthesizes only. It does not open microphone/playback hardware or certify physical audibility/first-audio. The transcript correctness expression compares case/whitespace-normalized strings including punctuation; a punctuation difference can honestly mark correctness false and is not silently normalized away by this source review.

## Isolation, provider observation and bounds

Controller holds both nonblocking global and desktop-GPU reservation locks, creates a fresh private runtime/config/data/env/backups/output, retains resource preflight/floor observations and caps the child at240 seconds with bounded owned-group SIGINT/TERM/KILL plus finally cleanup and terminal receipt. Flow requests share one180-second deadline beginning after service startup; the outer controller cap covers setup, work and cleanup admission. Actual retirement/resource sufficiency remain execution evidence, not a source guarantee. Original frozen source/private host config is not written. Same existing disposable fixture settings, accurate-base CPU, pinned Qwen GPU100 generation options and Piper CPU paths are retained; requested GPU layers are not proof of actual offload.

Bootstrap installs private bindings before the existing opt-in observer and pilot. Wrappers delegate the actual Whisper/Piper/LLM constructors/call once with original arguments/results, recording actual arguments and returned identities/output byte counts. Actual PiperVoiceConfig uses model_file/config_file string fields and the actual CLI returns `(bytes, sample_rate)`, matching the wrapper. Existing observer remains separate and actual missing identities/offload remain unknown until retained records exist; no old null provider is retroactively filled. Binding IO may fail admission rather than manufacture successful observation. No request content/credentials are recorded by these wrappers.

The private pilot result intentionally retains actual transcript and reply and the synthesized WAV; logs/bindings can contain private runtime paths. They must remain private and are not approved for public projection by this review. Normal exception classes/stage statuses are retained without raw exception text. Cleanup result means Supervisor returned, not all-host/internal-thread or acoustic completion proof. Final result persistence after shutdown is subject to the outer process cap; actual artifacts/completeness must be inspected by Root.

This is one non-measured personal-desktop prerecorded LocalBus STT→Assistant→TTS synthesis pilot. No Android/microphone/native/web/full-voice-surface acceptance, GPU/CPU pooling,900 cohort, full individual seal or phase-2 release follows. Root alone owns the single actual execution, actual stage/provider/offload/correctness/cleanup evidence and any necessary safe artifact projection. Stop.

## Frozen pilot WAV-validation closure

Final pilot SHA256 `8a2c2d1d709c252e29c2f53781e2873bccc0b981526aed2e620ac5458f0efc24`: **APPROVE the requested WAV-boundary correction**, superseding the provisional9e6 pilot anchor above. Inspected only the requested final synthesis-validation region: frames is assigned from the open WAV before its exact PCM-byte-count predicate uses it. The guard requires monoPCM16/uncompressed/nonempty audio, matching sample rate and exact frame bytes, with nonzero PCM content; malformed/truncated output cannot satisfy that boundary. No unbound frames reference remains there. No tests/imports/runtime, full-flow re-review or new probe by reviewer. Other source/runtime limits above remain; Root owns exact frozen-packet transfer and the one actual execution.

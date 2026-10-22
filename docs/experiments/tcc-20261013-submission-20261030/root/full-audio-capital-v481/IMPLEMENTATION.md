# V481 full-audio candidate pilot

## Candidate

`pilot.py` is a private source-only adaptation of the V476 one-attempt LocalBus WAV → production STT → production Assistant → production TTS synthesis driver. It reads its immutable acceptance inputs from the required `AURORA_CANDIDATE_MANIFEST` JSON file. The manifest must contain exactly:

```json
{
  "wavSHA256": "<64 lowercase hex characters>",
  "referenceTranscript": "<fixed expected spoken words>",
  "expectedReplyWords": ["<word>"]
}
```

The source rejects a missing manifest, an unexpected key set, malformed hash, blank reference, or reply entries that do not each normalize to exactly one word. The WAV at `AURORA_VOICE_FIXTURE_WAV` must match the declared SHA-256 and the existing mono PCM16/22,050 Hz WAV profile. The pilot records only manifest hashes and expected reply words in its result.

The full transcript check compares the production STT result with the manifest reference as an exact normalized word sequence. The Assistant receives the original STT text unchanged. The Assistant reply is checked against the manifest's exact normalized word sequence, then that same reply is sent through the real TTS synthesis contract. Normalization is limited to Unicode case folding, punctuation removal, and whitespace collapse; it does not repair or semantically reinterpret ASR output.

The pilot retains the V476 180-second single-flow cap, LocalBus typed requests, private output directory, attempt/failure/timeout denominators, output WAV validation, and physical-microphone/playback/audibility limits. Provider binding snapshots are recorded after services start and again after the chain (or on an in-flow failure before shutdown). Setup remains outside the flow timer. TTS response audio duration is recorded separately from the caller's bus-request duration.

## Source lineage and validation boundary

- Base pilot: `.git/aurora-handoff-import-20261006/headless-full-audio-v476/pilot.py`, SHA-256 `8a2c2d1d709c252e29c2f53781e2873bccc0b981526aed2e620ac5458f0efc24`.
- Candidate: this directory's `pilot.py`, SHA-256 `7079b8fb2f3e74815fb0d7e1a26823270b05b0dbb8ea418437b979e4149e676d`.
- The candidate inherits V476's correction that reads the WAV frame count before validating PCM byte length.
- No tests, imports, model calls, application startup, or runtime validation were run for this candidate. Root owns execution. This is one non-measured full-chain pilot, not a benchmark or acceptance result.

The controller must supply `AURORA_CANDIDATE_MANIFEST`, `AURORA_VOICE_FIXTURE_WAV`, `AURORA_CONFIG_FILE`, and a fresh `AURORA_OUTPUT_DIR` under this private handoff root. For observer-enabled runs it also supplies the previously reviewed observer module on `PYTHONPATH` and sets `AURORA_VOICE_TELEMETRY_V430=1`. Any clear WAV, model binding, actual STT transcript, Assistant output, valid TTS samples, and cleanup result remain to be established by Root's single authorized pilot. Physical recording, physical playback/audibility, first-token, first-audio, and playback lifecycle remain outside this driver's claims.

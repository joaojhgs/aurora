# V477 decode boundary review

Result: **no deterministic source-level WAV rate mismatch found for the V477 request**. This does not explain the observed recognition text and does not establish whether the cause is the model, audio content, or another factor.

The pilot submits the retained 193,068-byte WAV as `format="wav"`, `sample_rate=22050`, `channels=1`, and `model="accurate"`. The supplied runtime receipt identifies the file as 96,512 frames of mono PCM16 at 22,050 Hz. The request declaration therefore matches the WAV header for this run.

In `app/services/stt_transcription/service.py` (`_decode_audio_to_numpy`, around lines 1522–1568), the WAV branch reads the header rate and channels. It only resamples there when `actual_rate != sample_rate`; with this pilot's matching 22,050 Hz values, that branch is skipped. The method returns normalized float32 samples. In `transcribe_audio` (around lines 2488–2511), the finite handler separately converts decoded audio to the service's 16,000 Hz Whisper rate when the declared request rate differs from 16,000 Hz. Thus the pilot follows one expected 22,050→16,000 conversion before inference, not two conversions.

The request schema in `app/shared/contracts/models/stt.py` defines `sample_rate` as the supplied audio rate. The production WAV decoder does not reject a WAV whose header rate differs from that request field; in that different situation it first converts header-rate samples to the declared rate and the finite handler may then convert to 16 kHz. That behavior is not implicated by the V477 file/request facts above.

Source SHA-256:

- `app/services/stt_transcription/service.py`: `4723b798b2643cee262e3d1d0ad28114305c3e83c8ef5bae5becd790aac5f888`
- `app/shared/contracts/models/stt.py`: `3c56b2d5a5435a971465ac5b132d8b5d78d18cfe02506813631a4b67e401c703`
- V476 pilot source: `8a2c2d1d709c252e29c2f53781e2873bccc0b981526aed2e620ac5458f0efc24`

No audio was decoded or compared in this review, and no model, request, task, or preprocessing settings were changed. No tests, runtime, model, or device actions were run. Root remains the sole execution owner. The V477 full-chain outcome remains a correctness failure despite successful real STT, LLM, and valid TTS WAV synthesis; this source review does not authorize another attempt or a phrase/model ladder.

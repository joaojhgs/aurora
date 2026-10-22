# Retained conversation Read aloud main

This private driver extends the history-reopen-only candidate with one normal
production UI action: click **Read aloud** on the already-saved `ORBIT` reply.
It uses the exact retained-session UUID supplied through
`AURORA_RETAINED_SESSION_ID`, confirms the saved user prompt and assistant
reply through the normal history list and `DB.GetSession`/`DB.SetActiveSession`
flow, then clicks the visible control attached to that reply.

Acceptance fields require exactly one post-click `POST /api/TTS/Synthesize`,
HTTP 200, decodable `audio_data` with a valid nonempty RIFF/WAVE PCM stream,
and a normal browser media/WebAudio start and completion observed after the
click and synthesis response. The decoded WAV is retained privately as
`private/read-aloud.wav`; request/response correlation headers are restricted
to the existing safe allowlist, request text is represented by a match boolean
and body hash, and the response records hashes, byte/sample metadata, and no
base64 JSON body. Credentials and authentication bodies are not recorded.

Assistant generation, transcription, TTS request/stream, and inference writes
remain forbidden. The only permitted speech write is the single visible
Read aloud action. The driver does not create or edit a conversation and does
not claim microphone capture, physical audibility, or device output. Its one
monotonic deadline remains 90 seconds for setup, history reopen, synthesis,
playback, and capture. Failure state/screenshot capture runs before Playwright
closes.

The passive output observer follows the existing V461 typed UI main pattern.
The history and DB message checks derive from the maintained contracts in
`packages/aurora-ui/src/use-assistant-history.ts`,
`packages/aurora-ui/src/assistant-history.tsx`, and
`app/services/db/service.py`. This candidate expects Root's compatible UI
build containing the reviewed Read aloud UI change; it was not executed here.

Required environment: `AURORA_WEB_BASE_URL`, `AURORA_GATEWAY_URL`,
`AURORA_CHROMIUM_EXECUTABLE`, `AURORA_FIXTURE_USERNAME`,
`AURORA_FIXTURE_PASSWORD`, `AURORA_RETAINED_SESSION_ID`, and a fresh
`AURORA_OUTPUT_DIR`. Root owns execution against the retained copied database
and the prepared UI/backend runtime.

The history-only parent candidate is V470 `history-reopen-v470/driver.py`
(SHA-256 `b5326644fc505e74d710e3aac040b5a757a09daa716da474db858fb87d0685cf`).
This V472 adaptation has not been syntax-checked or executed; Root owns source
review and any validation.

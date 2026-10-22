# Native desktop file-audio readiness V1049

**Status: Current bounded check.** The actual current-source Tauri executable completed one excluded file-audio readiness flow at13:06:24UTC: real WAV → Whisper transcription → Qwen answer “Paris” → one explicit Piper synthesis returning valid non-silent mono PCM16 WAV. This is **zero measured performance cases**, with no p90/p95 claim. The passing readiness case is closed; no replay is required.

The native window was `tauri://localhost`, selected `main`, with mounted `desktop-local` runtime and `tauri-local` transport. The existing166568472-byte ELF SHA256 is `e156c76b676bf6566765c769d211413243f8d7f48026275465e085f4fd21a3b6`. The [summary](summary.json) binds the exact input/models/output, outcome and limitations. [Custody manifest](MANIFEST.json) records copied raw records. Existing source/app build and all earlier failures remain preserved.

Renderer total15344ms; SDK transcription3750ms, Assistant9908ms, synthesis1656ms. Actual native model spans: STT3299.899762ms, LLM1654.987615ms and TTS1641.388637ms. Keep each clock domain separate. The Assistant time includes a real5-second tool-catalog timeout; the model still answered correctly with no exposed tools. SDK correlation IDs were null; native stage correlations are retained without inventing a cross-boundary join.

The [saved accelerator excerpt](accelerator-log-excerpt.json) records RX7600/Vulkan and actual25/25layers offloaded. Whisper effectively used CPU `int8_float32`; Piper used CPU with CUDA disabled. This is a hybrid GPU/CPU pipeline, not all-GPU inference. Exact package versions, actual provider bindings and stage boundaries are retained under `runtime/`.

Input219794bytes/SHA256 `da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb`; exact62-character transcript and5-character answer passed. Automatic TTS was skipped; the one explicit synthesis returned30252bytes,22050Hz,15104frames/684.988662ms, SHA256 `bbeea54c063212336472879a0db8ad3add462b1f854c4417dd8a1c03732893c0`. Native16k conversion was not exercised.

This proves SDK file-compute inside the actual native app. Normal Assistant UI send/render/history, physical capture, audibility/playback and900-case surface performance remain separate claims. Saved controller observation13:07:39UTC shows the test owner absent after cleanup of its own children. No existing session/agent was stopped. Native UI or Android claims do not gate the separate supported headless distributed file-audio cell.

Historical failed attempts V1039/V1043/V1046 invoked no file-audio case. The final repair selected the maintained main WebView before readiness and SDK invocation; it did not change models, loosen correctness or rebuild the app. Their raw failures remain private, alongside the full successful audio/window/protocol records. Do not repeat closed CPU/local/HTTP cohorts or this passing readiness case for padding or cleaner results.

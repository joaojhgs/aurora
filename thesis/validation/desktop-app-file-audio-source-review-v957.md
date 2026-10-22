# V957 narrow desktop file-audio source closure

APPROVE — V953 R1/R2 closed for this private unintegrated source candidate. V951 and its failed review remain preserved.

R1: the actual STT call and README now use client.assistant.transcribeVoiceAudio, matching AssistantClient at SDK client.ts:1536. Existing accurate finite WAV parameters remain unchanged.

R2: synthesized output is now bounded to1MiB and checked as a complete RIFF/WAVE container with exact total length and bounded chunk/padding boundaries. It requires one fmt and one data chunk, PCM16 mono, matching sample rate/byte rate/block alignment, nonempty complete frames and at least one nonzero sample. Returned typed format/text/channel/rate/duration metadata must match the actual decoded output and requested actual reply; duration must agree with frames within2ms. Invalid audio therefore fails at synthesis instead of passing from a RIFF prefix. Existing input exact hash and actual transcript→Assistant→actual reply→TTS chain remain intact.

The added assistant.data.metadata.tts_status read matches AssistantSendMessageResult.metadata in SDK types.ts:217 and the actual sendMessage mapping. Requiring skipped before explicit synthesis closes the previously stated single-explicit-TTS result-admission dependency; README separately retains Root's effective automatic-TTS-disabled configuration admission. TTSSynthesisResponse at types.ts:201 really includes text, format, sample_rate, channels, duration_ms and audio_data used by the new validator. No schema fabrication or new SDK API is introduced.

Patch bytes are unchanged. Prior dev/source/runtime-scope positives and limitations are reused without broader review: this is not integrated/typechecked or actual Tauri/model/authorization/native-telemetry/capture/playback/history evidence. Actual installed artifact/runtime/source/models/settings/provider, owned app handle, finite outer lifecycle/resources and execution remain Root gates. Existing exact-string predicate is not silently relabeled as the older normalized-word measurement predicate. This later C06 preparation does not gate first HTTP and supplies no measured/surface acceptance.

Only assigned source/diff and exact SDK type fields were read. No imports, tests/typechecks/builds, runtime/models/browser/device/network/Orca/Git/.omx/canonical/methodology changes or agents. Only this private review report written; all other work preserved.

## Exact reviewed candidate pins

- `desktop-file-audio-e2e.ts`: `48b6fc597996536ead4439bca2024a3b3a4f5c6d1ad4c64f8a5d68f84a05c522`
- `tauri-app.patch`: `63e0c9a95eba0c6b53225770c0e43ed53b3d625458da50b3372402784062bf60`
- `README.md`: `e04e8fb45df2d3e182eabb2d419f69e9693550613bd710dde4c69b14d9d528ee`

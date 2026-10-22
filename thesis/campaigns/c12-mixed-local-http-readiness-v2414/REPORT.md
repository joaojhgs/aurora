# C12 mixed local and HTTP audio readiness

Two excluded full audio flows passed on 22 October 2026. This is readiness for a new controlled-load condition; **zero of its 900 measured requests have started**. All six earlier worker→desktop core conditions remain closed and are not repeated.

| Population | Correct / attempted | End-to-end time |
| --- | ---: | ---: |
| Desktop local user, production UserInput/Response bus entry | 1 / 1 | 15.239 s |
| Coding-worker, existing authenticated Orca-relayed HTTP | 1 / 1 | 34.400 s |

Both use the same fixed audio, Whisper base, Qwen3.5-0.8B Q4_0, Piper and effective settings. Both produced valid WAV audio and the strict reference transcript/Paris answer. Six model invocation pairs are correlated to the same desktop receiver. Native Vulkan logs identify AMD Radeon RX 7600 and actual 25/25 LLM layers offloaded; STT and Piper remain CPU stages.

Offered flows overlap for 15.203 seconds in the desktop monotonic clock. Native invocations serialize within each stage. The local STT call-to-handler delay is 3.113 seconds, including queue/scheduling/dispatch overhead; it is not claimed as pure queue time. This result establishes actual mixed requests and queueing, not parallel execution of the same model. Exactly two native TTS invocations occurred, one per flow. No single-sample percentiles, pooled historical percentiles, performance win or pure protocol-overhead claim is made.

The first excluded candidate retained its successful remote flow and failed local boundary record (`server_tts_not_suppressed`); the external-request entry was inappropriate for the local user. The corrected harness uses actual internal UserInput and its Response event, without fabricating an external caller identity. That event precedes the service's tts_status annotation, so local suppression is checked against the unchanged frozen automatic-readback=false config and actual native TTS accounting. Strict transcript, answer and valid-audio predicates are unchanged. An intervening orchestration timing rejection sent no audio and remains separate, not a model-quality failure. Source versions, failed records and sealed raw data are preserved.

The finite provider retired naturally; no Root retirement signal was needed. Worker/requester and provider actors are absent and native spans are closed. All 22 final provider files are physically archived and hash-verified on both repositories: 99,697 bytes, SHA256 `febeb16355fff56082f1336d08736fd791fbecc0dc2977dc9ce8f8cb7225159e`. Requester case/audio/resources are physically in this campaign directory. See READINESS-PASSED-v2416.json, terminal-v2417/CUSTODY.json and RESOURCE-RELEASE-v2418.json.

Next executable work is a versioned C12 campaign using this working local/HTTP flow, actual-arrival pairing and separate populations. Freeze the 900 primary measured target, companion counts, 15 excluded warmup pairs, offered/completed rate, queue/resource/native observations, source/reference mappings, finite request/session caps and durable progress before launch. Readiness does not admit those measurements automatically. Reuse closed references with explicit comparability limits; no new unloaded baseline. Root owns this main execution; existing term_1f27be31-0284-4366-bb91-30fe538cd30e solely owns phone/notebook work. The unresolved approved Waydroid binding is separately relayed; no repeat empty-list probes without changed evidence.

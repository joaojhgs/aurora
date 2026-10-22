# V802 K1 HTTP TTS source preparation

The private candidate now contains a V737-based future runner copy. It keeps local STT and `OrchestratorMethods.EXTERNAL_USER_INPUT` on the existing code-worker Supervisor/LocalBus route, replacing only local `TTSMethods.SYNTHESIZE` with the existing authenticated Gateway HTTP `POST /api/TTS/Synthesize` route. The original request text, exact correctness checks, WAV validation, 15 excluded warmups, 900 measured requests, 180-second request limit, and 57,600-second condition cap are preserved.

The HTTP adapter accepts only an explicitly admitted exact endpoint string pinned by SHA256 in a new frozen cohort manifest. Both `http` and `https` are allowed only when that hash matches; no scheme/host is guessed, credentials in the URL are rejected, redirects are rejected, and the existing API key remains process-environment-only. The summary records the endpoint digest, never the endpoint or credential. The adapter returns the actual `X-Correlation-ID` separately from LocalBus correlations. Remote failures, timeouts, and ambiguous transport errors stop the campaign before another request because an in-flight remote synthesis cannot be ruled out.

The new warmup gate first reuses the inherited local STT/LLM provider and correctness checks without requiring local Piper spans. It then waits, bounded by one request deadline, for a Root-produced proof under the private output directory. The proof must bind all 15 warmup attempt IDs to returned server correlation IDs and receiver-native TTS span correlations, and prove the actual receiver PID/source, Piper provider, exact model/config hashes, hardware digest, CPU selection, and sample rate against the frozen cohort's `remoteTtsReceiver` binding. Proof hash is retained in the summary. The proof contract is documented in `README.md`.

Source files:

- `runner.py`: private V737-derived copy, current SHA `45d2c3f4df7353c2fc162c6986d125096b64216a76575a8a1d5bae4e5c154b0f` (input V737 runner SHA `d17a7dcb9aa2c57aaf8c83f2fb15505da9bfd73572f73cb9ebd841eb425c62e3`); changed for remote TTS, endpoint-manifest binding, unique V802 case IDs, and the fail-closed receiver warmup gate.
- `tts_http_adapter.py`: current SHA `81a44fb0180fe540c087ba1f81410e07f51f6c6d96eee2eeffb49f471da2e49c`; permits HTTP or HTTPS only under the exact independently frozen endpoint-string hash.
- `README.md`: proof/launch interface SHA `cfbd652455367d7dbed571bb34dc82f611553504a459f9f7629bd4e5431f9d30`.
- `tts_http_adapter.v802-original.py` and `REPORT-v802-original.md`: retained pre-revision artifacts.

This is private source preparation only, not an integrated or launch-ready condition. The current V737 frozen runner/manifest remain unchanged. Required future Root-owned pieces are a new controller/bootstrap/source inventory and cohort manifest, exact endpoint/auth launch binding, and the independent receiver proof gathered from the existing approved desktop TTS runtime. No endpoint, key, provider receipt, source-equivalence proof, or execution admission was supplied here. No runtime, import, test, build, model, network, device, or service action was performed.

Root integration correction: HTTP408/504 now retain their status and use `http_timeout`, so the existing runner timeout denominator classifies them correctly. Source-only correction; no runtime or HTTP call.

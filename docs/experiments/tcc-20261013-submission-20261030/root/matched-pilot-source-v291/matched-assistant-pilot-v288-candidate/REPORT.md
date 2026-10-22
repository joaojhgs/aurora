# Matched Assistant readiness-pilot candidate — V288

## Candidate scope

Private source-only successor to V286 for the maintained `scripts/experiments/assistant_local_api_pilot.py`; the V286 files remain frozen. V288 prepares one bounded same-host comparison using the existing typed Assistant request and history check.

- Baseline script SHA256: `857730e1aee69c854718e5302da3bf010a9aa10ed9befd139437605b25356c3e`
- Candidate script SHA256: `26adfada706eeb82e0c74e19a22f2107b04a4dcb6ba5cedb5c79a5a9f3fab9ba`.
- Candidate patch SHA256: `ce72aa1f806392a6f38dc5d16337600259c9fa460e637ac5e71dbd1995d15dbb`.
- Only source file proposed for integration: `scripts/experiments/assistant_local_api_pilot.py`.

The candidate adds configurable measured requests per route (1–10) and excluded warmups per route (0–5), enforces at most 10 attempts total, and caps the two-condition matched run at 600 seconds. Every attempt receives fresh product session/request/correlation IDs and keeps the existing typed response, exact-answer, persisted-history, immutable JSONL, and cleanup behavior. `--pilot-route both` sequentially starts two fresh thread-mode Supervisors: the local-only condition disables Gateway and sends through LocalBus; the API condition enables Gateway, checks the real announced/generated POST route before its first model request, then uses the authenticated localhost API. Both use the same pinned Qwen artifact (expected SHA256 `57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf`), llama-cpp-python `0.3.19`, model options, prompt/task, deadline, and fresh session per request. Each condition has its own isolated temporary database/config and a corresponding route-specific immutable request, manifest, cleanup, and provider-fingerprint artifact.

For each real `ChatLlamaCpp._create_message_dicts` call, a private wrapper calls the original implementation unchanged, verifies that its immediate caller is the maintained `_generate` or `_stream` method in `chat_llama_cpp.py`, and hashes the final provider message dictionaries together with that call's already-validated provider params (including tool schemas when present). The fixed prompt timestamp is limited to `chatbot.datetime` in this private experiment process. Artifacts contain only request IDs, route/warmup booleans, call counts, and SHA256 values; they do not store message, prompt, tool, answer, or error text. Unsupported caller shape or serialization produces an uncaptured marker; comparison eligibility fails closed. The combined summary requires exact model artifact/options and task matches plus complete, equal measured provider-input fingerprint sequences across conditions.

The experimental config keeps ToolingService disabled for both conditions, as in the existing pilot. This is an exact-answer/no-tool task; the captured provider params still prove the effective tool-schema input (including its absence). This candidate makes no tool-enabled behavior claim. Bus requests retain the existing `origin=internal`, `principal_id=system` call; the API path retains the existing API-key SYSTEM identity. No auth or permission behavior is changed.

## Important limits

This is an implementation candidate, not validation evidence. It has not been parsed, tested, or run. Root must source-review the private monkeypatch seam and then perform one bounded pilot only after integration. A successful <=10-request pilot is readiness/descriptive evidence, not the Section 25 main estimate. The Section 25 main remains five excluded warmups and 100 measured requests in each of three independently restarted/reserved sessions (`n=300` per condition), after the pilot establishes runtime and required resources are reserved.

The two condition outputs are separate files named from the requested output with `-local-only` and `-api`; the third combined artifact records only equality/readiness booleans. The matched run is constrained to thread-mode LocalBus/API on this host. It is not mesh, process-mode comparison, cross-region, voice, or a TCC benchmark acceptance claim. The separate run configs necessarily differ in Gateway enablement and ephemeral API settings; the explicit model-options, artifact, task, and actual provider-input hashes are the comparison controls.

# Matched Assistant pilot candidate V290

## Frozen inputs and artifacts

- Maintained driver baseline SHA256: `857730e1aee69c854718e5302da3bf010a9aa10ed9befd139437605b25356c3e` (`scripts/experiments/assistant_local_api_pilot.py`).
- Candidate driver SHA256: `0531b8ec0e3217e7453471dd1d4d1cef532a2bc217a71581ede2ba013b4ed53e`.
- New shared hook SHA256: `7cdbc4dfb931e6db4774f2ec857535103c4ca3e9d9462f26e2e80bcd5297bace`.
- Combined patch: `candidate.patch`; SHA256 `8c6ebd209a02be01ddc18d85a83e47f63ddbcf7786ddcb8f9aaf9dbf95dc4502`.
- This is a private candidate only. Canonical source was not edited and no test, model, service, network, or pilot execution was performed.

## Candidate behavior

The maintained driver gains explicit `--pilot-route local-only|api`; its default remains unset so existing shared-warmup/bus-plus-API behavior and gateway-only diagnostics remain unchanged. Each candidate invocation runs one condition and is intended to be started as a separate process with a fresh Supervisor and temporary runtime/database. `local-only` disables Gateway and does not wait on Gateway health. `api` uses the existing authenticated localhost API and requires the announced Orchestrator service plus generated POST route before any model request. The driver accepts 1–10 measured and 0–5 excluded warmups per condition, with at most 10 attempts per condition and a 600-second invocation cap. The paired caller must apply one 600-second outer deadline across both separate condition processes.

Both conditions retain the exact existing ORBIT request, response/correlation/exact-answer checks, persisted-history check, API-key/principal behavior, llama.cpp options and pinned Qwen model. Each invocation has a fresh temporary config/database. Only the private experiment's `chatbot.datetime` is fixed to `2026-10-14T12:00:00+00:00`; no global clock or production code is changed. Tooling remains disabled as in the existing pilot, so this does not claim tool-enabled behavior.

The new `assistant_matched_input_hook.py` uses the existing measurement-hook environment contract (`AURORA_ASSISTANT_MEASUREMENT_HOOK_PATH`, `...FIXED_TIME`, and `...OUTPUT`) and `install()` entry point. The maintained hosted-peer script already loads such a module from its Python `sitecustomize`; this candidate does not edit that runner. For the local/API pilot, the driver loads the same hook before Supervisor initialization. The hook wraps `ChatLlamaCpp._create_message_dicts`, invokes the original unchanged, and verifies the immediate caller is `_generate` or `_stream` in the installed `chat_llama_cpp.py`. It hashes only the final converted message dictionaries and already-validated provider params, including tool schemas. The output file is created exclusively with mode `0600`, append-only, and fsynced per provider call. It contains ordinals, capture booleans, and hashes only.

The driver marks each sequential attempt with a request ordinal through the hook's process-global serial capture, not a ContextVar. It requires exactly one captured provider invocation for each request and verifies invocation ordinals match the request-record sequence. Missing calls, multiple calls, unexpected caller frames, or unserializable inputs fail closed as `context_unverified`; no prompt, message, tool schema, answer, or raw error is stored. Root can compare the per-request provider-input hash sequences from the separate condition artifacts and only treat them as matched when counts and ordinals align.

## Limits and handoff

This is not measurement evidence or a TCC result. Source review should confirm the provider call shape and candidate integration before Root starts one bounded pilot. Root should launch `local-only` and `api` in separate fresh processes, use one outer 600-second deadline for the pair, and compare only their hash/count artifacts after both cleanups. No additional test matrix or unit fixture is proposed.

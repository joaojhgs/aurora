# Matched Assistant readiness-pilot candidate — V286

## Candidate

Private source-only candidate for the maintained `scripts/experiments/assistant_local_api_pilot.py`.

- Baseline SHA256: `857730e1aee69c854718e5302da3bf010a9aa10ed9befd139437605b25356c3e`
- Candidate SHA256: `3f0b393ceaee89496228e72632d62ab1e03430675cce62d4d6566209992005b7`
- Patch SHA256: `311c685a096e520925cb5242e8d64e1a1c031d34da85056f18e8e364f8ef7685`
- Owned candidate files: `assistant_local_api_pilot.py`, `candidate.patch`, and this report in this directory only.

The candidate adds `--measured-per-route` (1–10) and `--warmups-per-route` (0–5), rejects a matched invocation above 10 total requests, caps matched route work at 600 seconds, and records the configured counts. Each attempt already creates a fresh product session/request/correlation ID, checks the typed reply and persisted user/assistant history, writes each result incrementally, and leaves cleanup/failure handling in the maintained Supervisor path. The default matched invocation is two route warmups plus one measured request per route; it differs from the prior one-shared-warmup diagnostic and must be reviewed as an intentional pilot configuration change.

The maintained route pair is a Python LocalBus request and a localhost authenticated Gateway API request through the same initialized Supervisor and configured model/options. The LocalBus request bypasses the Gateway request path, but the Gateway service remains enabled in that shared process. This candidate therefore does **not** establish an environment with Gateway disabled for the local-only condition; meeting a strict Gateway-off L0 comparison would require a condition-level lifecycle/configuration change beyond this small extension.

## Material limitation: resolved model input is not fingerprinted

The existing driver fingerprints the model artifact, configuration, fixed workload, and source. It does not fingerprint the actual resolved model input/context/toolset for each request. The production Orchestrator builds its graph input in `app/services/orchestrator/graph.py`; `app/services/orchestrator/agents/chatbot.py` separately obtains tools from ToolingService, binds them, adds memory-derived context, and includes current time in its system prompt before invoking the provider. The script's input/task hash and config hash cannot prove those resolved prompt/tool inputs were identical across LocalBus/API requests or repeats.

I did not add a production hook or monkeypatch provider internals. Before using this candidate for matched claims, Root must either supply an existing supported test-only hook that hashes the exact provider-bound message/tool structures without storing content, or explicitly retain input-context equivalence as unverified and limit the pilot's claim accordingly. A mere hash of the fixed user prompt/model config is insufficient.

## Scope and validation status

This is preparation only. No tests, runtime, model, service, build, device, or benchmark was executed. The candidate is not an acceptance result and should not be used as `n=300` evidence. Root should review the count semantics and resolve the two stated match limitations before selecting the single bounded pilot. The unchanged underlying production request, route, authorization, exact-answer, history, and cleanup contracts are retained.

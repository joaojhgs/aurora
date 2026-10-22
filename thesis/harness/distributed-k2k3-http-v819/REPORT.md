# V819 K2/K3 HTTP source-preparation report

## Result

Added `stage_adapter.py`, a small typed one-request Gateway adapter reusable
for K2 remote Assistant/TTS and K3 remote STT/Assistant/TTS. It accepts an
explicit endpoint plus its independently frozen SHA-256, enforces the
contract-specific route path, uses the existing API key environment binding,
disables redirects/proxies, parses the existing response contract, and
returns separate local payload identifiers and receiver `X-Correlation-ID`.
It includes per-stage monotonic duration and request/response byte/hash
metadata without copying payload content. Timeout and ambiguous transport
errors are fail-stop; no retries are implemented.

This is an adapter slice only. K2 local STT dispatch and K2/K3 orchestration,
case ownership, per-stage provider proof, warmup gate, and 900-request
controller remain unwired. It does not prove any remote route, model, account,
receiver, or performance condition.

## Grounding

- V692 full-HTTP runner: `.git/aurora-handoff-import-20261006/qualified-http900-writevolume-v692/candidate/runner.py`, SHA-256 `e0a388b96a7478ceb8aeccda9c0559c27a431c6c9b929a57526e39c6a9c1bace`. Its existing three route paths and typed Gateway request/response handling informed this adapter.
- V802 K1 runner: `.git/aurora-handoff-import-20261006/distributed-k1-http-prep-v802/runner.py`, SHA-256 `45d2c3f4df7353c2fc162c6986d125096b64216a76575a8a1d5bae4e5c154b0f`.
- V802 K1 TTS adapter: `.git/aurora-handoff-import-20261006/distributed-k1-http-prep-v802/tts_http_adapter.py`, SHA-256 `81a44fb0180fe540c087ba1f81410e07f51f6c6d96eee2eeffb49f471da2e49c`.
- Contract DTOs are in `app/shared/contracts/models/stt.py` (`TranscribeAudioRequest/Response`), `orchestrator.py` (`OrchestratorProcessRequest/Response`), and `tts.py` (`TTSSynthesizeRequest/Response`).

## Verification and remaining gap

Only syntax/AST validation is appropriate for this source-only preparation;
no imports, services, requests, models, tests, or campaign execution were run.
Root must review and integrate the adapter into a future distinct K2/K3
runner, bind exact endpoint URL hashes from independent admission, retain
actual server correlation IDs and receiver-side provider/stage receipts, and
apply the existing timeout/ambiguity stop rule. The response DTOs may carry
the actual assistant text and synthesized audio needed by the caller; this
module itself does not log or serialize those values into metadata.

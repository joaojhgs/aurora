# V268 independent exact process API source review

Verdict: **APPROVE exact private five-file candidate, source only.** No material blocking source finding was identified within the bounded discovery/readiness/shutdown delta. This is not an actual route/API/authentication/model fix or a runtime pass; the retained404 cause remains unclassified until new actual evidence is captured.

## Discovery and the single cold request

The two added GET call sites are fixed literals `/api/services/Orchestrator` and `/api/routes`. Actual fastapi_app.py:348–369 returns module/method announcement details, and :402–421 returns services containing service name and generated route-path lists. Actual BaseService:107 parses the short method name from the typed method ID, so the ExternalUserInput announcement predicate matches the real schema. RouteGenerator:1156 registers dynamically generated routes with methods=[POST]; its get_routes_by_service (:1172–1178) returns those generated paths. Thus presence of the exact path `/api/Orchestrator/ExternalUserInput` in that projection supports the fixed POST label; the candidate does not infer an arbitrary verb from an unrelated endpoint.

The projection writes only fixed snapshot-status categories, nullable booleans, a finite missing-boundary enum, fixed schema ID and POST/null. It does not retain discovery bodies, schemas, errors, URL/IPs, auth credentials or source content. Existing private namespace/exclusive capture and immutable manifest handling remain. HTTP/error cases are conservative unavailable/missing facts, not an auth-policy change or invented cause.

The route-readiness decision uses one monotonic35-second deadline, wait_for with the remaining budget and capped sleeps. This35-second phase follows the existing health phase; it is not a35-second bound on the whole Supervisor startup. The to_thread worker's in-flight GET cannot be forcibly cancelled by wait_for and may finish after the decision deadline, subject to its socket timeouts. Its discarded result cannot create a late ready decision or model POST. No instantaneous thread cancellation/universal network wall-time guarantee is claimed.

Only gateway_only executes the new wait. It requires service present, the external/both ExternalUserInput announcement and the exact generated route before calling the unchanged attempt once with warmup=False. If missing/unavailable at the cap, the candidate writes readiness facts, preserves the finite unavailable run/failure status and makes no Assistant/model request. Existing request_count then distinguishes zero actual attempts from the configured one-request target. Default thread/full-pilot and public-reply-diagnostic branches remain unchanged. No route exposure, permission, auth identity, prompt/model/settings, correlation or history success predicate is altered.

## Shutdown and two focused assertions

Supervisor's process shutdown now awaits asyncio.to_thread(process_launcher.stop_all, timeout=10.0), so blocking child waits no longer starve the parent event loop. Parent bus.stop remains after that await; worker exceptions propagate through the same surrounding lifecycle/error handling. ProcessLauncher now snapshots insertion keys in reverse order, stopping Gateway/Orchestrator before their earlier DB/Config dependencies. Original terminate, per-child timeout, kill escalation, wait/error handling and owned-handle targeting remain unchanged. This does not create an overall shutdown deadline or prove every child stopped; the pilot's actual cleanup facts and external bounded runner still decide that.

The added Supervisor test invokes the actual shutdown method, records thread IDs and checks child-stop10.0 before bus-stop; it would reject the former on-loop behavior. The added ProcessLauncher test invokes actual stop_all with a recording replacement for stop_service and verifies reverse startup order. It adds no live processes or matrix. Both tests were read only; no result is inferred from their presence.

## Exact independently verified candidate hashes

| File | SHA-256 |
| --- | --- |
| scripts/experiments/assistant_local_api_pilot.py | `857730e1aee69c854718e5302da3bf010a9aa10ed9befd139437605b25356c3e` |
| app/services/supervisor.py | `4ac2b5578fa8b3759bf30e7dfe8c68364e3453eba5020663dc3be670b838a7d8` |
| app/shared/services/process_launcher.py | `c6e102416d03b092d5ac33ef50caa5dc4f5448daf480606a0026f72e16a4eef3` |
| tests/unit/services/test_supervisor.py | `b9138279d6d98e53a8ada9f2c53bddc36cf5cb806fe69a453608a8e935061813` |
| tests/unit/app/services/test_process_launcher_signal_lifecycle.py | `22972439f515a1d1288233b745e1ed38a789e961c9be86a76b005d0905245f79` |

Private candidate.patch SHA-256 `66b3cab7d156b70de5750e56d1b6fd9379397f2d18781332db0ce1039e15dc38`; author REPORT.md SHA-256 `3ac01dff20bcd50790655dd5426943d4b9f477ed08930302af5e2d5919de8f1a`. Read the exact patch and candidate files, checked the necessary actual schemas/route/lifecycle source and independently computed hashes. Review approval is of these private bytes, not a claimed canonical integration or unchanged shared tree.

## Scope and handoff

Only this new private review report was written; earlier closed reviews were not amended. No tests/AST/Ruff/build/model/Redis/services/network/device/runtime execution, canonical source/index/goal/ledger/vault changes, commits/push, new task/session/agent/Run or competing orchestration. No ownership conflict/resource exhaustion; four-minute cap honored. Root owns exact integration, the two targeted checks and one existing gateway-only process main, retaining truthful missing/passed/failed/incomplete facts and final cleanup sidecar. Native independent Sol result is relayed through original run_e6054e76e9fc / dispatch ctx_37b4d0a3c14f without fabricated authority or runtime acceptance.

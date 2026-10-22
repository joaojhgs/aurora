# V272 independent exact live-router source review

2026-10-14 UTC. **APPROVE, source-only**, for the exact two-file candidate below. No material blocker found in the bounded late-announcement/live-POST slice.

| Anchor | SHA256 |
|---|---|
| Canonical app/services/gateway/fastapi_app.py base | b23a104a42ade26781aa995ef3ac232e755f5de2bd78278764247758a0ea4efb |
| Private candidate app/services/gateway/fastapi_app.py | 319469ee90ab706eaf5066bcde9f3f65b69b2894a4054c4bfe07190b25f6e94b |
| Private new tests/unit/gateway/test_fastapi_dynamic_routes.py | b614fa92186ee74d0979b23c05041930ff90f67a92c246171c1a9d094478f76b |
| candidate.patch | e95f65f8e80783a666d0de7c91d910c7f6bd3666193d1f9b72743bae095c49c2 |
| Author REPORT.md | 2c225fbebe6263a48bd69492debc2c52cf828c2eaf43b614c9e47a969a6dc21c |

Verified the actual canonical base hash and private candidate hashes. Read the patch, both candidate files, the necessary existing RouteGenerator/RegistryAggregator seams, and relevant Gateway/testing guidance. Only this private report is written. No tests, imports of application code, builds, services, network, devices, source/index edits, commits, goals/ledger/vault writes, or recursive delegation.

## Concrete source assessment

Candidate fastapi_app.py:170–173 gives RouteGenerator the actual live `app.router` before generator startup and removes the detached APIRouter plus one-time include. Existing registry startup and generator initial generation remain in their original order. The app-level authentication middleware, GatewayAuth configuration/dependency installation, CORS, static infrastructure routes, lifecycle shutdown, bus object and request_timeout remain untouched.

The existing RouteGenerator.start (:683 onward) subscribes to registry changes, performs initial generation and marks initialization; its _on_registry_change (:701 onward) regenerates after later announcements. _regenerate_routes (:706 onward) still obtains only the registry's existing external methods and uses the existing method-aware typed/auth handler and `self._router.add_api_route(..., methods=["POST"])` (:1153 onward). Pointing that target at the live application is the direct missing wiring: later additions now reach the ASGI route table, rather than only the detached generator router/catalog. No auth bypass, exposure change, service-method bypass, literal topic, payload change, permission change or request timeout change is introduced.

The new regression exercises the connected boundary, rather than only examining the route catalog. It starts the actual FastAPI application and a real process-mode RegistryAggregator with an initially empty registry; invokes the subscribed typed SERVICE_ANNOUNCE callback; announces the canonical Orchestrator ExternalUserInput method with real request/response schemas and feature metadata; observes catalog presence; then sends an authenticated ASGI POST to the actual generated path. Its status/body and single-spy-request assertions require actual typed dispatch to OrchestratorMethods.EXTERNAL_USER_INPUT with the supplied text. The original detached router cannot serve that post-startup addition, so the HTTP success assertions detect the reported wiring failure. The same app/auth configuration is used for both catalog and POST, without a dependency or routing override.

The bus is a spy returning a typed OrchestratorResponse, not a real Redis bus or model. The regression's source supports late route registration and dispatch coverage only. Its finally block performs app shutdown, including registry task/subscription cleanup. The monkeypatch preserves/restores the pre-test global Gateway auth dependency; it does not bypass authentication.

## Limits and bounded handoff

No runtime pass is asserted. V270's retained catalog-present/POST404 and clean eight-child shutdown are Root observations; this review identifies and approves the source repair without converting earlier failures into success. Root owns the one focused regression and one fixed gateway-only process API main. Existing parent/model success need not be replayed for this wiring check. OpenAPI refresh, departure/orphan behavior and broader auth/route matrices were explicitly outside this review. The already-closed mesh main candidate and other lanes are unchanged by this verdict. This is the actual native fallback review, for Root's relay through the original Orca coordination surface, with no competing run or authority claim.

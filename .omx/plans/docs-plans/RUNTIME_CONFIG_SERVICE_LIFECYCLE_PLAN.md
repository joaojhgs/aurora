# Runtime Config Service Lifecycle Plan

## Goal

Make runtime config changes authoritative across all deployment modes:

- ConfigService is the only runtime writer/source of config truth.
- Services receive precise config-change events.
- Services that actively depend on changed config reload, restart internal components, or deactivate.
- `services.<service>.enabled=false` disconnects that service from the runtime contract surface even if its container/process remains alive.
- Gateway reflects active service availability in its registry, health, and external API routes.
- Tilt can still use config for developer convenience, but runtime correctness must not depend on Tiltfile refreshes.

## Current Findings

- Gateway is explicitly subscribed to `Config.Updated` and can hot-toggle some internal components.
- Runtime `Config.Set services.gateway.webrtc.enabled=false` stops Gateway WebRTC.
- Runtime `Config.Set services.gateway.webrtc.enabled=true` starts Gateway WebRTC again.
- Runtime `Config.Set services.auth.enabled=false` does not deactivate Auth, remove its bus handlers, remove its Gateway routes, or disable Gateway auth middleware.
- Most services implement `reload()` but are not subscribed to `Config.Updated`.
- `Config.Updated` payloads are decoded incorrectly in process mode, so services see `key_path=None` and `affected_sections=[]`.
- Config persistence is unsafe because `ConfigManager.save_config()` attempts to JSON-serialize Pydantic values such as `SecretStr` and `AnyUrl`.
- ConfigService subscribes to its own config updates and reloads from disk after writes, which currently produces repeated JSON decode failures when persistence is broken.
- There is no general active/inactive runtime state in `BaseService`.
- There is no general "enabled=false means unsubscribe contracts and publish Gateway departure" mechanism.

## Important Clarification: Enabled Paths Already Exist

Most optional/runtime services already have generated typed enabled paths:

- `ConfigKeys.services.auth.enabled`
- `ConfigKeys.services.gateway.enabled`
- `ConfigKeys.services.tts.enabled`
- `ConfigKeys.services.scheduler.enabled`
- `ConfigKeys.services.tooling.enabled`
- `ConfigKeys.services.orchestrator.enabled`
- `ConfigKeys.services.db.enabled`
- `ConfigKeys.services.config.enabled`
- `ConfigKeys.services.stt.coordinator.enabled`
- `ConfigKeys.services.stt.transcription.enabled`
- `ConfigKeys.services.stt.wakeword.enabled`

So the missing work is not primarily adding schema keys. The missing work is:

- Define which of those keys are lifecycle-authoritative.
- Map each service module name to its enabled path in one canonical place.
- Teach `BaseService` to enforce that mapping at startup and on config changes.
- Decide policy for infrastructure services like Config and DB, which may have enabled paths but may not be safely disableable in every deployment profile.

## Phase 0: Stabilize ConfigService Persistence

1. Fix `ConfigManager.save_config()` serialization.
   - Convert the whole config tree into JSON-safe primitives before writing.
   - Prefer Pydantic `model_dump(mode="json")` or equivalent structured conversion.
   - Ensure `SecretStr`, `AnyUrl`, enums, paths, and `None` values serialize safely.
   - Avoid ad hoc string handling.

2. Make config writes atomic.
   - Serialize to a temporary file in the same directory.
   - Flush and fsync the temp file.
   - Atomically replace the real config file.
   - Preserve the old file if serialization fails.

3. Stop ConfigService from reloading from disk on its own `Config.Updated` events.
   - ConfigService already owns in-memory truth after `set()`.
   - Its self-reload is unnecessary and currently turns persistence problems into runtime failures.
   - Either do not subscribe ConfigService to its own update event, or ignore self-originated updates.

4. Add persistence tests.
   - Set a normal boolean value with secrets present elsewhere in config.
   - Assert `config.json` remains valid JSON.
   - Restart/reload `ConfigManager` and confirm values load.
   - Assert failed serialization cannot truncate or corrupt the previous file.

## Phase 1: Fix Config Event Payloads

5. Normalize `ConfigChangedEvent` decoding in `BaseService`.
   - BullMQ delivers payloads as dicts.
   - Thread mode may deliver Pydantic objects.
   - `BaseService._subscribe_to_config_changes()` should validate payloads with `ConfigChangedEvent.model_validate(...)`.

6. Preserve exact key path and affected sections.
   - For `services.gateway.webrtc.enabled`, subscribers should receive:
     - `key_path="services.gateway.webrtc.enabled"`
     - `affected_sections=["services", "services.gateway", "services.gateway.webrtc", "services.gateway.webrtc.enabled"]`

7. Pass richer event context into services.
   - Keep backward-compatible `reload(config_section)` if needed.
   - Add a richer hook such as `reload_config(event: ConfigChangedEvent)` or pass both `key_path` and `affected_sections`.
   - This avoids every service having to reconstruct information from a lossy section string.

8. Add event decoding tests.
   - Dict payload from BullMQ.
   - Pydantic payload from LocalBus.
   - Confirm reload receives the correct key path and sections.

## Phase 2: Make BaseService Actually Subscribe

9. Move config subscription into `BaseService.start()`.
   - Call `_subscribe_to_config_changes()` once for every service unless explicitly disabled.
   - Add an idempotency guard to prevent duplicate subscriptions.

10. Remove redundant manual subscription calls.
   - Gateway currently calls `_subscribe_to_config_changes()` itself.
   - ConfigService currently calls it too.
   - Keep only intentional opt-outs or special handling.

11. Add subscription tests.
   - Create a test service subclass.
   - Publish `Config.Updated`.
   - Assert `reload()` or the richer hook is called exactly once.
   - Assert duplicate start/reload paths do not duplicate subscriptions.

## Phase 3: Introduce Service Runtime State

12. Add explicit runtime states to `BaseService`.
   - Suggested states:
     - `created`
     - `starting`
     - `active`
     - `inactive`
     - `stopping`
     - `stopped`
     - `failed`

13. Define state semantics.
   - `active`: contracts are subscribed and reachable, service is announced to Gateway.
   - `inactive`: process/container may still live, but contracts are unsubscribed and not announced.
   - `stopped`: process lifecycle shutdown path has completed.

14. Add a canonical service-enabled mapping.
   - Use the existing generated config paths.
   - Example mapping:
     - `Auth` -> `ConfigKeys.services.auth.enabled`
     - `Gateway` -> `ConfigKeys.services.gateway.enabled`
     - `Tooling` -> `ConfigKeys.services.tooling.enabled`
     - `Scheduler` -> `ConfigKeys.services.scheduler.enabled`
     - `TTS` -> `ConfigKeys.services.tts.enabled`
     - `Orchestrator` -> `ConfigKeys.services.orchestrator.enabled`
     - `STTCoordinator` -> `ConfigKeys.services.stt.coordinator.enabled`
     - `WakeWord` -> `ConfigKeys.services.stt.wakeword.enabled`
     - `Transcription` -> `ConfigKeys.services.stt.transcription.enabled`

15. Decide policy for infrastructure services.
   - `Config` and `DB` have enabled paths, but disabling them may make the system unable to recover.
   - Define whether their enabled flags mean:
     - fully lifecycle-authoritative,
     - external exposure only,
     - ignored in process mode,
     - or rejected by validation when trying to disable them.

16. Read enabled state on startup.
   - If enabled: activate normally.
   - If disabled: do not subscribe contracts, do not run active loops, do not announce to Gateway, enter `inactive`.

## Phase 4: Contract Activation And Deactivation

17. Track all bus subscriptions created by `BaseService`.
   - Store `(topic, handler)` for every auto-subscribed contract.
   - Store config-change subscription separately.
   - Use `bus.unsubscribe(topic, handler)` during deactivation.

18. Implement `BaseService.activate()`.
   - Subscribe contract handlers.
   - Call service active hook.
   - Publish `Gateway.ServiceAnnounce`.
   - Start periodic announcement loop.
   - Mark state `active`.

19. Implement `BaseService.deactivate(reason)`.
   - Stop periodic announcement loop.
   - Publish `Gateway.ServiceDepart`.
   - Unsubscribe all contract handlers.
   - Call service deactivation hook.
   - Mark state `inactive`.

20. Separate process shutdown from runtime deactivation.
   - `deactivate()` is config-driven runtime dormancy.
   - `stop()` is process/container shutdown.
   - `stop()` should call `deactivate()` first if currently active, then run full shutdown cleanup.

21. Add contract reachability tests.
   - Active service request succeeds.
   - Disable service via config event.
   - Request no longer reaches handler.
   - Re-enable service.
   - Request succeeds again.

## Phase 5: Service-Specific Reload Semantics

22. Classify config keys per service.
   - Lazy read: no reload needed.
   - Hot update: update in-memory values.
   - Component restart: restart subcomponent only.
   - Service deactivate/reactivate: enabled flag.

23. Gateway service behavior.
   - `services.gateway.enabled=false`: stop HTTP server, WebRTC, mesh, registry components.
   - `services.gateway.webrtc.enabled`: start/stop WebRTC.
   - `services.gateway.mesh_network.enabled`: start/stop mesh and restore bus cleanly.
   - `services.auth.enabled`: update Gateway auth middleware behavior or rebuild/restart the HTTP app.

24. Auth service behavior.
   - `services.auth.enabled=false`: deactivate Auth contracts and publish departure.
   - `services.auth.audit_enabled`: hot update.
   - Token/session settings: hot update or manager restart, depending on implementation.

25. DB service behavior.
   - Decide whether `services.db.enabled=false` is supported.
   - If supported: deactivate DB contracts and publish departure.
   - DB path/schema changes should require service restart or explicit migration flow.

26. Tooling service behavior.
   - `services.tooling.enabled=false`: deactivate Tooling contracts.
   - `services.tooling.mcp.enabled`: reload MCP client/tools.
   - Plugin toggles: hot reload tools.

27. Scheduler service behavior.
   - `services.scheduler.enabled=false`: deactivate contracts and stop scheduler loops.
   - Job definition changes: reload scheduled jobs.

28. Orchestrator service behavior.
   - `services.orchestrator.enabled=false`: deactivate contracts.
   - LLM provider/model changes: restart model/graph components.
   - Credential changes: hot reload where possible.

29. TTS and STT behavior.
   - Top-level enabled false: deactivate contracts and stop background/audio loops.
   - Model/device changes: restart component.
   - Runtime flags such as wakeword, ambient transcription, and multi-turn: hot update.

## Phase 6: Gateway Registry Correctness

30. Treat `Gateway.ServiceDepart` as authoritative.
   - Remove the service immediately.
   - Regenerate routes.
   - Update health counts.

31. Ensure inactive services do not reannounce.
   - Periodic re-announcement loop must only run in `active` state.
   - Deactivated services must not publish announcements.

32. Add stale service expiry as a safety net.
   - If a process dies without departure, remove it after a timeout.
   - This should complement, not replace, explicit departure.

33. Add Gateway registry tests.
   - Auth active: Auth routes present.
   - Auth disabled: Auth routes removed.
   - Auth re-enabled: Auth routes return.
   - Health service count changes accordingly.

## Phase 7: ConfigService Update API Improvements

34. Make `Config.Set` return useful metadata.
   - `success`
   - `key_path`
   - `old_value`
   - `new_value`
   - `affected_sections`
   - `persisted`
   - `error`

35. Add batch updates.
   - Update multiple config keys atomically.
   - Save once.
   - Publish one batch event.
   - Prevent reload storms when enabling a profile like Gateway + WebRTC + Mesh.

36. Add origin/correlation metadata.
   - Include `origin_service`, `source`, and `correlation_id`.
   - Let services ignore self-originated events where appropriate.

## Phase 8: Tilt Boundary Cleanup

37. Keep Tiltfile config gating as developer UX only.
   - Tilt can skip starting disabled containers initially.
   - Tilt can stop containers for convenience.
   - Runtime correctness must still work without Tilt reload.

38. Document the two layers clearly.
   - Tilt initial container selection: dev convenience.
   - ConfigService runtime activation/deactivation: production/distributed correctness.

39. Add a no-Tilt runtime test path.
   - Use Docker Compose or direct process-mode services.
   - Mutate config via `Config.Set`.
   - Assert runtime deactivation works without Tiltfile reload.

## Phase 9: Integration Tests

40. Add process-mode integration tests with Redis.
   - Start Config, Gateway, Auth, and one simple service.
   - Verify baseline routes.
   - Set `services.auth.enabled=false`.
   - Assert Auth container/process remains alive.
   - Assert Auth service state becomes inactive.
   - Assert Auth contract requests no longer succeed.
   - Assert Gateway route count drops.
   - Re-enable and assert recovery.

41. Add Gateway component reload tests.
   - Toggle WebRTC false/true.
   - Assert WebRTC stops/starts.
   - Toggle mesh false/true.
   - Assert MeshBus is installed/removed safely.

42. Add ConfigService persistence integration tests.
   - Set several keys through ConfigService.
   - Validate config file remains valid JSON.
   - Restart ConfigService.
   - Confirm values persist.

## Phase 10: Observability

43. Add clear service lifecycle logs.
   - `Auth deactivated by config: services.auth.enabled=false`
   - `Auth unsubscribed 40 contract handlers`
   - `Auth announced departure to Gateway`
   - `Gateway removed Auth routes`

44. Add service runtime status contract.
   - Current state.
   - Enabled config value.
   - Contract count.
   - Last config event processed.
   - Last announcement/departure time.

45. Add protected Gateway registry diagnostics.
   - Active services.
   - Instance IDs.
   - Route count.
   - Last announce/depart event.

## Recommended Implementation Order

1. Fix config serialization and atomic writes.
2. Fix config event decoding.
3. Make `BaseService` subscribe to config changes once.
4. Add active/inactive service state and tracked contract subscriptions.
5. Implement enabled-path activation/deactivation in `BaseService`.
6. Wire Gateway route removal via `ServiceDepart`.
7. Update Gateway auth/WebRTC/mesh reload semantics.
8. Update remaining services with explicit reload behavior.
9. Add process-mode integration tests.
10. Revisit Tiltfile behavior so it complements runtime config instead of hiding bugs.

## Highest-Risk Areas

- Config persistence corruption from `SecretStr` and other Pydantic type serialization.
- Duplicate config subscriptions causing repeated reload storms.
- BullMQ workers remaining alive after unsubscribe.
- Gateway dynamic route regeneration while requests are in flight.
- Disabling infrastructure services like Config/DB without a clear support policy.
- Periodic service re-announcement reintroducing routes for inactive services.

## Definition Of Done

A runtime `Config.Set services.auth.enabled=false` in process mode should result in:

- Auth container remains running.
- Auth service state becomes `inactive`.
- Auth contract handlers unsubscribe from BullMQ.
- Auth publishes `Gateway.ServiceDepart`.
- Gateway removes Auth from registry.
- Gateway route count drops.
- External Auth APIs disappear.
- Internal bus calls to Auth no longer succeed.
- Re-setting `services.auth.enabled=true` reverses all of the above without restarting Tilt or the container.

## End-To-End Testing Plan

This change set touches config persistence, message bus subscriptions, service lifecycle state, Gateway registry state, and live process-mode behavior. Testing must cover both isolated behavior and the full running stack.

### Test Matrix

Run tests across these execution modes:

- Unit tests with in-process fakes/mocks.
- LocalBus/thread-mode integration tests.
- BullMQ/process-mode integration tests with Redis.
- Docker Compose process-mode smoke tests.
- Tilt live-stack tests using `Config.Set`, not host `config.json` edits.

Run tests across these service categories:

- Gateway, because it owns external route exposure.
- Auth, because it is the primary optional service under test.
- Tooling/Scheduler/TTS/STT, because they exercise generic `BaseService` activation/deactivation.
- ConfigService and DB, because they need explicit infrastructure-service policy.

### Unit Tests: Config Persistence

1. Test `ConfigManager.save_config()` with generated config models containing:
   - `SecretStr`
   - `AnyUrl`
   - `None`
   - nested dict/list values
   - booleans changed by `Config.Set`

2. Verify saved config is valid JSON.

3. Verify reload after save returns the changed values.

4. Verify a failed save preserves the previous file.
   - Simulate serialization failure.
   - Assert old file contents remain valid.
   - Assert no truncated partial file is left at the config path.

5. Verify atomic write behavior.
   - Save writes through a temp file.
   - Final replacement happens only after successful serialization.

### Unit Tests: Config Events

6. Test `ConfigChangedEvent` decoding from a Pydantic payload.

7. Test `ConfigChangedEvent` decoding from a dict payload, matching BullMQ process-mode behavior.

8. Verify affected sections for a nested path.
   - Input: `services.gateway.webrtc.enabled`
   - Expected:
     - `services`
     - `services.gateway`
     - `services.gateway.webrtc`
     - `services.gateway.webrtc.enabled`

9. Verify services receive the real key path, not `None`.

10. Verify ConfigService ignores or safely handles self-originated `Config.Updated` events.

### Unit Tests: BaseService Subscription And State

11. Verify every `BaseService` subclass subscribes to config changes automatically on `start()`.

12. Verify config subscription is idempotent.
   - Calling `start()` twice must not create duplicate config handlers.

13. Verify contract subscriptions are tracked.
   - Start a test service with two contract methods.
   - Assert both `(topic, handler)` pairs are recorded.

14. Verify `deactivate()` unsubscribes contract handlers.

15. Verify `deactivate()` does not unsubscribe the service's config-change handler.
   - Inactive services must still be able to receive `enabled=true` and reactivate.

16. Verify active/inactive/stopped state transitions:
   - created -> active
   - active -> inactive
   - inactive -> active
   - active -> stopped
   - inactive -> stopped

17. Verify disabled startup behavior.
   - If `services.<service>.enabled=false` at startup, service enters `inactive`.
   - It does not subscribe contract handlers.
   - It does not publish `Gateway.ServiceAnnounce`.

### Unit Tests: Gateway Registry

18. Test `Gateway.ServiceAnnounce` adds service methods to the registry.

19. Test `Gateway.ServiceDepart` removes the service immediately.

20. Test route generation after departure.
   - Routes for that service disappear.
   - Route count decreases.

21. Test repeated announcements from the same active service update metadata without duplicating routes.

22. Test inactive service announcements are not sent.

23. Test stale service expiry.
   - If a service stops without departure, Gateway eventually removes it.

### Unit Tests: Gateway Runtime Config

24. Toggle `services.gateway.webrtc.enabled`.
   - false stops RTC client.
   - true starts RTC client.

25. Toggle `services.gateway.mesh_network.enabled`.
   - false stops mesh and restores the inner bus.
   - true starts mesh and installs MeshBus.

26. Toggle `services.gateway.enabled`.
   - false stops HTTP server and Gateway subsystems.
   - true restarts them.

27. Toggle `services.auth.enabled` while Gateway is running.
   - Gateway auth middleware behavior updates correctly.
   - Protected routes use the new auth state.

### Unit Tests: Service-Specific Reload Behavior

28. Auth:
   - `services.auth.enabled=false` deactivates contracts.
   - `services.auth.enabled=true` reactivates contracts.
   - `services.auth.audit_enabled` hot-updates without deactivation.

29. Tooling:
   - `services.tooling.enabled=false` deactivates Tooling contracts.
   - `services.tooling.mcp.enabled` reloads MCP tools only.

30. Scheduler:
   - `services.scheduler.enabled=false` deactivates contracts and stops loops.
   - Job changes reload schedules without deactivation.

31. Orchestrator:
   - `services.orchestrator.enabled=false` deactivates contracts.
   - LLM provider/model changes restart model/graph components.

32. TTS/STT:
   - Enabled flags deactivate contracts and stop background/audio loops.
   - Runtime flags hot-update without full deactivation.

33. Config/DB:
   - Test the explicitly chosen policy.
   - If disabling is rejected, assert `Config.Set` fails clearly.
   - If disabling is supported, assert deactivate/reactivate works.

### LocalBus Integration Tests

34. Start ConfigService, GatewayService, and a simple test service in one process.

35. Verify baseline service announcement and routes.

36. Publish `Config.Set services.test.enabled=false`.

37. Assert:
   - Test service enters `inactive`.
   - Contract calls no longer reach the handler.
   - Gateway receives departure.
   - Routes are removed.

38. Publish `Config.Set services.test.enabled=true`.

39. Assert:
   - Test service reactivates.
   - Contract calls work again.
   - Gateway routes return.

### BullMQ Process-Mode Integration Tests

40. Start Redis and process-mode services in test fixtures.

41. Start ConfigService, GatewayService, AuthService, and one lightweight test service.

42. Verify baseline:
   - Gateway health is healthy.
   - Registry includes active services.
   - Auth routes exist when Auth is enabled.

43. Send `Config.Set services.auth.enabled=false` through the bus.

44. Assert:
   - Auth process remains alive.
   - Auth runtime state is `inactive`.
   - Auth handlers are unsubscribed from BullMQ.
   - Internal bus request to an Auth method fails or times out predictably.
   - Gateway receives `ServiceDepart`.
   - Gateway route count drops.
   - Auth external APIs disappear.

45. Send `Config.Set services.auth.enabled=true`.

46. Assert:
   - Auth runtime state becomes `active`.
   - Auth handlers are resubscribed.
   - Gateway receives `ServiceAnnounce`.
   - Gateway route count returns.
   - Auth external APIs return.

47. Repeat the same false/true cycle twice.
   - Assert no duplicate subscriptions.
   - Assert route count is stable after each cycle.
   - Assert no worker/file-descriptor leak symptoms in logs.

### Docker Compose Smoke Tests

48. Run process-mode Compose without Tilt.

49. Verify initial health:
   - `curl http://127.0.0.1:8000/api/health`
   - expected healthy or documented degraded state.

50. Use `docker exec` into a service container to call `Config.Set`.
   - Do not edit host `config.json`.
   - Do not restart Compose.

51. Disable and re-enable Auth.

52. Assert the same contract, Gateway registry, and route behavior as the BullMQ integration tests.

53. Restart ConfigService after runtime config writes.
   - Confirm config file is valid.
   - Confirm persisted values load.

### Tilt Live-Stack Tests

54. Start `tilt up`.

55. Wait for configured services to be Ready.

56. Verify baseline:
   - `docker ps` shows expected containers running.
   - Gateway health reports expected service count and route count.
   - Gateway logs show route generation.

57. Mutate config through ConfigService only.
   - Use `docker exec aurora-gateway python -c ... ConfigAPI().aupdate_config(...)`.
   - Do not edit host `config.json`.
   - Do not rely on Tiltfile reload.

58. Disable `services.auth.enabled`.

59. Assert:
   - `aurora-auth` container remains running.
   - Auth logs show deactivation.
   - Gateway logs show `ServiceDepart`.
   - Gateway health route count drops.
   - Auth APIs disappear from Gateway registry.
   - Internal Auth bus requests no longer succeed.

60. Re-enable `services.auth.enabled`.

61. Assert:
   - Auth logs show activation.
   - Gateway logs show `ServiceAnnounce`.
   - Gateway health route count returns.
   - Auth APIs reappear.

62. Toggle Gateway WebRTC and mesh.
   - `services.gateway.webrtc.enabled=false/true`
   - `services.gateway.mesh_network.enabled=false/true`
   - Assert logs show clean stop/start and no unhandled exceptions.

63. Toggle one non-Gateway service.
   - Prefer Scheduler or Tooling for a low-risk live test.
   - Assert contract routes disappear/reappear without container stop.

64. Confirm Tilt did not perform the behavior being tested.
   - No host `config.json` edit.
   - No Tiltfile reload as the trigger.
   - No service container recreate required for the runtime change to take effect.

### Failure And Recovery Tests

65. Kill a service container without sending departure.
   - Gateway should remove stale routes after timeout.

66. Restart Gateway while services are active.
   - Periodic active-only re-announcements should repopulate routes.
   - Inactive services must not reannounce.

67. Disable a service, restart Gateway, and wait.
   - Gateway must not rediscover the disabled service.

68. Disable a service, restart that service process/container.
   - It should start in `inactive` and not announce routes.

69. Corrupt config write simulation.
   - Force a save failure in tests.
   - ConfigService must keep serving the last valid in-memory config.
   - Config file on disk must remain valid.

### Regression Checks

70. Run focused unit tests for:
   - config manager
   - config interface
   - base service
   - gateway registry
   - gateway config reload
   - auth service lifecycle

71. Run service-specific test suites touched by reload changes.

72. Run formatting and lint:
   - `uv run ruff check ...`
   - `uv run ruff format --check ...`

73. Run config artifact check:
   - `make check-config-generated`

74. Run a broader unit suite before merge:
   - `make unit`

75. Run process-mode smoke test before merge if Docker is available.

### Acceptance Criteria For Testing

The implementation is not considered complete until all of these pass:

- Runtime `Config.Set` works without editing host `config.json`.
- Runtime service disablement keeps the container alive but removes service bus reachability.
- Gateway route count and external APIs reflect active services only.
- Disabled services do not reannounce after Gateway restart.
- Re-enabled services recover without container restart.
- Config writes remain valid JSON and survive ConfigService restart.
- No duplicate config subscriptions or route duplication after repeated false/true toggles.
- Tilt live-stack behavior matches Docker Compose/process-mode behavior.

# V1081 desktop-local profile integration closure

Verdict: **APPROVE bounded source closure.** No remaining concrete main-path blocker found in the requested package/onboarding/settings/store/TypeScript/Rust guards. Reviewed current nine-file bytes below against V1074 and the previously reviewed local transaction. Prior REQUEST_CHANGES reports remain preserved.

## Closed seams

- The existing native capability manifest exposes desktop.pythonFullRuntime from the same desktop+bundled_sidecar_path predicate used by native profile admission. Normal bootstrap consumes that genuine boolean; missing/malformed/unavailable metadata remains false. It supplies the explicit capability to both first-run onboarding and, now through NativeContext, the existing Settings/onboarding route. snapshot.nativeAvailable need not be fabricated. The mode-reading effect includes the capability dependency.
- The TypeScript local-node sanitizer now admits exactly Python-full with empty capability packs without membership. Its containing profile sanitizer first enforces allowPythonFull, and still rejects a home connection when membership is absent. The configured predicate remains capability-gated. This does not grant arbitrary packs, remote access, mesh membership or provider authority.
- Rust now makes the same narrow no-membership exception only for mesh-node/Python-full, actual allow_python_full and no homeConnection; enabled packs must be empty. The existing lightweight local-inference exception and normal membership validation remain intact. The new Rust regression expressly checks package denial/acceptance and rejects native-actions packs.
- secureRuntimeProfileStore now parses readback with the same package capability used for serialization. A successfully persisted local Python profile therefore no longer disappears into the empty fallback on normal load. The explicit transaction still verifies active profile, stable native identity, tier, no home, no membership and no packs, and rebuilds the runtime before application resolves. Missing durable storage and failed readback still refuse completion.
- The fresh onboarding regression now calls normal bootstrap and uses actual secure runtime store get/set boundaries with private native mocks, rather than the intentionally rejected memory-only helper. The existing direct transaction regression retains durable readback/rebuild checks. Replacing toMatchObject(undefined) with explicit toBeUndefined checks preserves the no-home/no-membership assertions. The narrow sanitizer regression now checks both capability-denied and capability-admitted shape.

The ephemeral descriptor remains unsaved until a real user invite/address is collected; saved connection sanitization stays in its existing boundary. The desktop-only package reader and local-Python transaction retain their platform guards; the mobile lightweight profile path is not widened. First-run connect/invite actions and the shared preference application path remain present.

This is source review only: no tests, imports, runtime, builds, models, network, Git, canonical plan, product, or frozen Personal data changes performed by this reviewer. Root owns the pending focused test/typecheck/native-guard results and any actual normal UI validation. No actual installed package, sidecar readiness, permission grant, normal UI send, 900 seal, or distributed-route acceptance is claimed. No new scenarios or further source panel requested.

## Exact current reviewed pins

- `apps/aurora-tauri/src/aurora-client.ts`: `9d87cab15f19343b6e0174cb835ed28d99d8ed6d8f7ca1483f7191af73fbb076`
- `apps/aurora-tauri/src/tauri-app.tsx`: `b17a9881eccb54d24bc20fd62ffcab2b43f69dbce14a9a1ca6c6f6d1be542db0`
- `apps/aurora-tauri/src/offline-profile-main.test.ts`: `eb1e2ac345424271f6f034f0a04ab7eaa3671cd555974cced240e1885502850d`
- `apps/aurora-tauri/src-tauri/src/lib.rs`: `16a837eb74ced7ddcea59337cdade5c543709fe0412b843c0543a76e7d0e2107`
- `packages/aurora-ui/src/onboarding-view.tsx`: `a46a71c92ef44a259931bc04336436ff585f7654e023e595a41feb80f194b33e`
- `packages/aurora-ui/src/runtime-profile.ts`: `c55a893eb1541714d001af27c3ec23e809e612201e2fdafe0444ccd15036a944`
- `packages/aurora-ui/tests/runtime-profile.test.ts`: `c0d77039cbd772f16d9a6c9f35762ca747964033bc8f4551fa50b9548ae440fa`
- `packages/aurora-ui/tests/onboarding-and-mesh-baseline.test.tsx`: `705220a9debc4743828b0cfcd55211b482c37dfbac8eb92bc59d34fd6c85bae5`
- `rust/crates/aurora-voice-native/src/runtime_profile.rs`: `40c25d866e95cdfe2cd9d22fcbcb6dfde8e8be2d6f8364d5e9eabc575c61a29e`

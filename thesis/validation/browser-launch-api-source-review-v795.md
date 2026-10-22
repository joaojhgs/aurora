# V795 source review — APPROVE

Reviewed 2026-10-16 UTC. Narrow V794 launch/API and namespace correction only; no material blocker remains in this delta.

The installed Playwright source receipt confirms raw --user-data-dir is rejected and launchPersistentContext(userDataDir, options) is supported. voice-flow.mjs:238 passes the fresh private profile directory through that API, retains viewport/options, and aliases the returned context for the existing bounded close at lines 687–690. Profile removal remains conditional on successful close and private, owned, non-symlink confinement (lines 692–705). Existing controller process-lineage cleanup/lock retention remains unchanged.

Driver, controller, stager and gate consistently use the new V794 runtime, case prefix, schema/cohort, archive destination and externally pinned manifest environment variable. The final hook changes only its exact active-case path and case-prefix checks (lines 293 and 319); stager now pins that corrected hook. Bootstrap, bindings and observer are byte-identical to the closed parents. Fresh-root protections preserve the prior V704 attempt. Counts, meaningful correctness/provider gates, resources, caps and ownership cleanup have no behavioral delta.

Evidence: source diffs against V789 controller/stager and V704 driver/gate/hooks; final file hashes; Python AST parsing without imports; retained installed-Playwright source receipt. No candidate execution, browser, tests, models, remote calls, live data or archive audit performed. Root still owns actual staging/external freeze, fresh resource/retirement admission and the planned 15 excluded warmup gate; this is not runtime or measurement acceptance.

Exact reviewed SHA-256:

- `voice-flow.mjs`: `aafc4b2471d01160bf86f43d1d23fd56c488e1ae37c32a3a5d9a66f2de1c2741`
- `controller.py`: `11a0f3aa4df927af88e2b94fb879dfe4ca70d5d90dfd33b4c73618536ba22676`
- `stage_freeze.py`: `d26ade387f73f4a6ad1d8bfa84bec9ff70f07da256ac8d92348d254aa1b1efd3`
- `bootstrap.py`: `9920c1d8ddc358d7e28a19b4c2ace882552f5a1ac39a14e933467521017dbec9`
- `gate.py`: `5647de41533d0b3a198b0ba95eca88717c364a995c2df5985164a08de52f945e`
- `hook/aurora_voice_telemetry_v430.py`: `9c6eccc91edb5136c95982b6b04fd770ee78ca365558fe347a25908f5818bc6d`
- `hook/bindings.py`: `d4a2ee4b9419b3be9713c55c5ffbdb3cdf29847f7a4be44e22ae64458d2471e0`
- `hook/observer.py`: `ce614d6e00bfd425a966eb3165f8b75e3269b956ef288c15f0cf31fd96e4e51a`
- `expected-provider-identity.json`: `6a73785e32a79c0d82296e7f05e2f9a44d2a727bfc73cb99f15ddbcde5d34f77`
- `REPORT.json`: `c44755184cfadeb0625bc6bd8c7003f5665941c1a24f9f2ecf6068ffea9f36a9`

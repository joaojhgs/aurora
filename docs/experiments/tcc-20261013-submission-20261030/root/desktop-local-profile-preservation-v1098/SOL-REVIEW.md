# V1094 saved local profile preservation closure

Verdict: **APPROVE source-only delta.** Compared the actual two current files against the preserved V1093 before/ copies and read only the immediate createLocalPythonProfile factory scope. No tests, builds, runtime, models, network/Orca, Git, product or plan changes performed by this reviewer.

The factory now sanitizes `existing ?? freshDefaults` rather than constructing fresh defaults while reusing only the existing ID. The existing-profile filter remains unchanged: same inspected native stablePeerId, mesh-node/Python-full, no homeConnection, no meshMembership, and empty capability packs. The package proof, desktop guard, durable storage requirement, native identity inspection, save/readback verification and runtime rebuild are unchanged. This preserves the selected matching profile's recognized label, nodeName, language and other settings through existing sanitization without admitting authority or copying settings from a different native identity. Fresh creation still uses the same random local ID and original defaults when no eligible existing profile matches.

The revised existing positive test now seeds a saved local profile with nondefault label/nodeName/primaryLanguage/voiceLanguage, retains its original object, then asserts equality after applying the transaction and verifies the rebuilt runtime retains the saved active ID. Explicit no-home/no-membership and empty-pack checks remain. That equality assertion detects the reported old literal-rebuild data loss. The separate fresh-bootstrap test remains in place; no additional scenario matrix is requested.

No remaining concrete main-path issue found in this delta. Root owns actual green focused tests/typecheck results. This approval does not alter or accept any frozen Personal run, normal UI runtime result, source/model cohort or distributed admission.

## Exact reviewed current pins

- `apps/aurora-tauri/src/aurora-client.ts`: `b54392ff9c883d061a736c5fc8d90bedfe070cda7a5a7e29f096f6bd39a92b0a`
- `apps/aurora-tauri/src/offline-profile-main.test.ts`: `e55a29949639f9883fe7d6c6ffebbbd2134b9aad21fabb26187127ef3ad5a1f8`

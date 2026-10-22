# V270 independent bounded source review

Date: 2026-10-14 UTC. Verdict: **REQUEST_CHANGES** — one demonstrated build-cache provenance blocker. The supported mesh-node main-case delta is acceptable within the source scope below; this does not approve the combined candidate for execution until the cache input omission is corrected.

Reviewed the private REPORT and exactly three candidate files, comparing each against the matching current canonical base. No tests, builds, services, browser, network, device, index/source edits, commits, goal/ledger/vault writes, or recursive delegation. Only this private report is owned and written by this reviewer. Root owns integration and runtime validation; the actual native fallback result is relayed by Root through the original Orca run/monitor.

## Exact anchors

| File | Canonical base SHA256 | Private candidate SHA256 |
|---|---|---|
| scripts/hosted_peer_e2e.sh | 8c1d7aba3021f9c12a19ee936a0360bc206b45b29a4b446a54371d4a8e21ee0a | 8b14893117ce068a84024e5286418675c6feab29f94ceae336b7c7e37ad12c2d |
| tests/e2e/hosted_peer/hosted-peer-live-shell.spec.ts | 55bd43c825efd2dc8c2efb8129468a77c9186ce464a69d7cb731309158364021 | a257aa79f03423fa412ffa53099f124910c248a3c3591924e9e3688de0891b2b |
| tests/e2e/hosted_peer/hosted-peer-live-helpers.ts | b62d26194ecc687713c6342e113e86d1d8a277dc1fce861f2a99ed4164d465b0 | fc1a89f4925ea419f3eb14b68568a95b04d5a8375fbf1ff512f81e199a35b6cd |

Author REPORT.md SHA256: `d98474291f4ae71be62e4ca318db35909727e378d8396bf97cd309c4a37716b6`.

## Required minimal correction

**F1 — cache fingerprint omits actual imported source and effective public build settings.** Candidate hosted_peer_e2e.sh:119–150 hashes apps/packages, five listed root/dependency files, Node/pnpm versions and only environment keys prefixed NEXT_PUBLIC_. Actual apps/aurora-web/next.config.mjs:1 imports `scripts/aurora-version.mjs`, and :7–8 injects its result as NEXT_PUBLIC_AURORA_VERSION_LABEL when the public override is absent. That helper reads root `VERSION` at scripts/aurora-version.mjs:23–24 and honors `AURORA_VERSION_LABEL` at :62–65. None of those three inputs is included in this fingerprint. Changing VERSION, the imported helper, or AURORA_VERSION_LABEL alone leaves the key unchanged while changing the actual fresh-build public configuration. The matching success-marker branch at candidate :159–165 can therefore serve an older build and claim an exact current-input cache hit.

Include at least root VERSION, scripts/aurora-version.mjs and the effective version-setting input in the digest, or freeze the resolved public version explicitly before hashing/building. Preserve the existing isolated dist path and success-marker requirement. This is a concrete imported-input omission, not a request for an expanded cache matrix or broad dependency audit.

## Accepted bounded main-flow observations

- Helper :96–106 clicks the actual visible “Make this device available” radio before Continue, then uses the existing invite/profile flow and requires the existing local-data-writable projection. The actual onboarding mapping is packages/aurora-ui/src/onboarding-view.tsx:1161 (mesh-node/lightweight-ts); this candidate does not inject a profile, identity, key, default role, environment role, or query override.
- Existing real pending pairing/code matching, authenticated administrative peer approval, browser Approve & pair, open WebRTC diagnostics and authorized status remain in helper :109–170. The optional flag is selected only by this Assistant main case; other helper callers retain their default behavior.
- The readiness assertion is grounded: apps/aurora-web/app/aurora-client.ts:452 restricts effective services to mesh-node; :568 projects writable only for enabled services. browser-mesh-node-services.ts:150 onward requires durable credentials, persistent backend and envelope-crypto construction before successful composition. mesh-client.tsx:36 exposes the existing boolean. This source path is stronger than merely choosing a role; actual storage/crypto/runtime success remains to be executed by Root.
- Spec :186–191 requires the actual history list to expose its empty state or conversation buttons before submit. assistant-history.tsx:159–165 selects error/loading before empty/rows. It does not treat unavailable or initial empty-loading text as successful readiness.
- The exact one-new-sent-message ORBIT predicate, correlated final backend completion, request/model budget, selected saved conversation and New conversation/reopen checks remain intact. Provider-processing and browser-visible timing labels retain their stated non-comparability to CLI latency.
- Cache hit requires an exact full marker and standalone server/static/public paths; marker is published only after the successful build and asset copies. The owned content-derived dist path preserves the ordinary preview. Runtime credentials/config/data remain under scratch paths; child-only environment injection, owned process/container cleanup and scratch deletion are unchanged. No new credentials are written into the cache by this delta. This source observation is not certification that arbitrary retained Next output/traces are content-redacted.

## Limits and handoff

This explicitly selected mesh-node case is a different supported-role flow. It does **not** establish a fix or acceptance for V261 remote-console history. No build cache, pairing/storage readiness, ORBIT result, persisted history, cleanup, model or full platform pass was executed here. No guarantee that a cold build/startup fits the Root runtime cap. Process-mode API POST404 is a separate lane and no cause is inferred here. Stop after the single cache-input correction and bounded exact-delta review; Root owns focused checks and the one real mesh main.

## Final correction-only delta — 2026-10-14 UTC

**APPROVE, source-only, for the corrected exact three-file candidate.** F1 is closed. Corrected hosted_peer_e2e.sh:141–156 adds the content and explicit present/absent identity of VERSION and scripts/aurora-version.mjs, and presence/value of AURORA_VERSION_LABEL, to the existing digest. These are the specific previously omitted imported-source/public-configuration inputs. Removing only this added block reconstructs the original reviewed shell hash `8b14893117ce068a84024e5286418675c6feab29f94ceae336b7c7e37ad12c2d`, proving the correction is confined to that block. The other two exact candidate hashes remain unchanged.

Final reviewed SHA256 anchors:

- scripts/hosted_peer_e2e.sh: `36d9e2907d9f19590f3552d2ea2aefad27cdb6f2c09d8e2cdfac748dccf0a267`.
- tests/e2e/hosted_peer/hosted-peer-live-shell.spec.ts: `a257aa79f03423fa412ffa53099f124910c248a3c3591924e9e3688de0891b2b`.
- tests/e2e/hosted_peer/hosted-peer-live-helpers.ts: `fc1a89f4925ea419f3eb14b68568a95b04d5a8375fbf1ff512f81e199a35b6cd`.
- Corrected author REPORT.md: `ceafafdc8ebe7b40a38df77c5ecad2d997db91725e08b160ff2af3d5814f9a10`.

No new scan, cache matrix, tests/build/runtime execution or source/index changes. All prior limits remain: the mesh-node main and cache reuse require Root's actual runtime check; V261 remote-console history and the separate process API404 are not repaired or accepted by this verdict. Root alone integrates and executes.

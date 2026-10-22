# V279 independent bounded source review

2026-10-14 UTC. **REQUEST_CHANGES — one focused regression-coverage gap; production dependency separation is source-sound within this slice.**

Read the private REPORT, exact patch and six candidate files, compared canonical hashes with all six declared bases, and checked only the existing history/encryption/scope seams needed to assess the change. No tests, builds, services, network, browser/devices, canonical/index/goal/ledger/vault writes, commits, or recursive delegation. Only this private report is written. Root owns integration and executable validation.

## Exact candidate anchors

| Candidate source path | SHA256 |
|---|---|
| apps/aurora-web/app/assistant-client.tsx | 9d5571da7fc21b99921ae7601b3cf1cd993e730581d014e19f8201162066bb96 |
| packages/aurora-ui/src/assistant-view-types.ts | 3f129d205313eece70b3bb594f568f0511a2c38c43339d3ccf275b0e32db6dc2 |
| packages/aurora-ui/src/assistant-view.tsx | d244100fdd1db1a996f304b2555821807f6c1aa973d6660ef27ff762780033bb |
| packages/aurora-ui/src/use-assistant-view-coordination.ts | 6f2d63c3ae30dd9447e939a4caf2e4bffc3925613c44446fd33a74057cc33196 |
| packages/aurora-ui/src/assistant-history-persistence.ts | 218fa713cc246a16549d0c205b393e9d37c9c35c833282383f4789c971a83493 |
| packages/aurora-ui/tests/native-assistant-view.test.tsx | 5c26bab5e1cee386f578c5cf8fdcea86a0800385e2ede34d78bc485638548a2b |

REPORT.md SHA256: `fb8c848b40a0efa6deb4df8caa77df1f59a8b3e9d35399c273f3064e5c9d212e`.
candidate.patch SHA256: `cac4ec4050fde40a5bee3dca4c36bfa33141c9f2cc714ccb17b02584a529eaaa`.
All declared bases match current canonical files: client `73e9e16c...`, view-types `72e14582...`, view `36e54790...`, coordination `edfafa31...`, persistence `9736ce8a...`, mounted test `33cffb42...` (full hashes retained in the reviewed author REPORT).

## Source-positive assessment

assistant-client.tsx:61–74 derives explicit history from the same runtime-owned localData session/crypto and its own profileId/localNodeId, only when the existing writable projection is true. It does not manufacture an inference provider, key, role, grant, runtime flag, model, API/provider database fallback or alternate identity. The prior localAssistant inference/tool prerequisites remain unchanged.

The optional prop reaches the shared view and coordination hook. Omitted/undefined retains the existing localAssistant-derived path; explicit null disables history; supplied history goes through the same scoped resolver. The factored resolver retains connected-device-only selection, conversation list/messages API checks, decrypt capability and nonempty scope IDs. Native and other callers omitting the prop preserve the original behavior.

The write path is unchanged: session profile/node must equal history scope; existing conversation ownership is checked; plaintext is envelope-encrypted before serialized local-data writes. Existing crypto AAD uses profile/node/record identity. Existing read/decrypt checks and history generation/ref/auth-scope invalidation remain in use-assistant-history.ts and assistant-history-crypto.ts, unchanged. The hook memo includes the explicit dependency object, so replacement goes into the existing history initialization/invalidation path. This separation resolves the demonstrated source coupling without relaxing permission or storage gates. It does not identify which former inference prerequisite was false in the retained failed main.

## Required focused correction

**F1 — the mounted regression does not exercise new completion persistence or reopen.** In native-assistant-view.test.tsx:55–63, the final answer and conversation are inserted by `seedConversation` before rendering. At :99–107 the completion event is marked `persisted: true`. The subsequent assertions check rendered text, one bubble and the selected pre-seeded row; there is no new-turn repository write assertion and no UI New conversation/select/reopen action. Setting localAssistant:null makes this a meaningful explicit-dependency loading/event regression, but it is not the requested event/client-save/reopen seam and cannot detect that persistence stops working when local inference dependencies are unavailable.

Add or adapt one mounted connected completion case with localAssistant:null and explicit owned history, requiring a fresh encrypted saved turn and reopening it through the existing conversation UI. Use the actual client-save path rather than pre-seeding the completed answer or declaring it already persisted. Keep the existing native assignment coverage if needed; no broader auth/route/edge matrix is requested. Update the author report to distinguish pre-seeded native-history loading from the newly exercised save/reopen path.

## Limits and handoff

No actual inference, persistent browser IndexedDB, WebRTC/service, core lifecycle or model acceptance is claimed from this unit source review. V261 remote-console has no runtime-owned data/crypto; that gap remains outside this fix. Existing reply/API/shutdown/parent evidence remains closed without borrowing it as proof of this changed persistence seam. After the single test correction, Root owns targeted UI validation/typecheck and one affected real WebRTC save/reopen main. This is actual native independent review for Root's original Orca relay, not external/OCR approval or a competing run.

## Final source-only closure — 2026-10-14 UTC

**APPROVE the exact production-source change, with unit-load-only coverage and fresh-save/reopen runtime validation still pending.** Root explicitly selects the actual maintained real Auth/WebRTC/SDK/Python main, rather than expanding unit fixtures, as the required fresh prompt → client encrypted write → New conversation → saved-row selection → restored answer validation. This closes the earlier requirement to add a new unit case as a launch condition; it does not assert that the retained unit case tests fresh saving, nor that runtime acceptance has already passed.

All five production candidate files and the existing mounted test remain byte-identical to the six exact hashes listed above (independently rehashed). The unchanged test hash is `5c26bab5e1cee386f578c5cf8fdcea86a0800385e2ede34d78bc485638548a2b`; it provides seeded history loading/event coverage with localAssistant:null only. The author now states that limited claim. Corrected author REPORT.md SHA256: `a2fcc1e4733693fab419158756a02b2705352520b38138350c46dd79821a8efd`. Patch remains `cac4ec4050fde40a5bee3dca4c36bfa33141c9f2cc714ccb17b02584a529eaaa`.

No concrete production blocker was found in the completed bounded source review. Existing profile/node ownership, crypto/AAD, generation/auth-scope invalidation and connected-device gates remain intact. Runtime-save/reopen acceptance requires the full existing real main to pass; a unit pass or earlier mesh reply alone cannot satisfy it. Root owns the existing focused load test, typechecks and one actual affected full main. No further source scan, test execution or fixture expansion by this reviewer. All platform/runtime/remote-console limits above remain.

## V280 exact typing correction — 2026-10-14 UTC

**APPROVE this source-only typing delta.** Root's first UI typecheck failed TS2345; neither the seeded unit nor main had run. The normalizer input now uses `Pick<LightweightAssistantDependencies, 'localData' | 'envelopeCrypto' | 'scope'> | null | undefined`, matching the original optional/null fields forwarded from the old localAssistant path. Its connected-device check, presence/conversation API/decrypt/scope guards, strict `LocalAssistantHistoryDependencies | null` return, explicit strict public prop and omitted/null behavior are unchanged. The normalizer accepts possibly unavailable inputs and returns a ready dependency only after the same guards; it does not weaken storage/permission/runtime validation.

Corrected assistant-history-persistence.ts SHA256: `4d45d97df625cbac62fdc6c774144f98bcf86e7c8b1341a26d5efd019a077f75`. Replacing only that input annotation with the previous annotation reproduces prior candidate `218fa713cc246a16549d0c205b393e9d37c9c35c833282383f4789c971a83493`. All other five full candidate hashes listed above were rehashed and remain identical. Updated patch SHA256: `f8c3e3b95f28433e6a013921381ccebbeb6284ed9a9791b74782ca5bf3c9704d`. Updated REPORT.md SHA256: `b857c85141e95f0ef805de636b5373654a83db81b932f39b4d9b07b0318e8911`.

No typecheck/test/runtime was executed by this reviewer. Approval is for the exact annotation fix, not an asserted typecheck pass. Root owns the same typecheck, one load-only case and actual full WebRTC fresh-write/reopen validation. Earlier runtime gaps and unit-load-only limitations remain.

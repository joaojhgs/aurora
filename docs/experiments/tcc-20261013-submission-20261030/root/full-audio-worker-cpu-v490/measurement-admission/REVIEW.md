# V491 CPU cap source delta

**APPROVE, source only.** Exact diff against approved V485 changes only CONDITION_CAP_SECONDS to 57600 and validates that the hash-verified full manifest's measurementPlan.conditionOverallCapSeconds agrees. Malformed/mismatching plans fail before attempts. Counts remain 15 excluded warmups plus 900 measured, with unchanged 180-second request cap, actual-result predicates and recording/cleanup logic.

Runner SHA256: `e3348ca0c064679f1c88e7bdc8fdec0942fda24b43fe7fdba2fa9f924d7d7dd9`.

Root's reported single CPU readiness duration is a planning basis, not stable-tail evidence or proof that all 915 requests will fit. 915 × 49.633587315 × 1.25 = approximately 56768.4 seconds, below the rounded finite 57600-second cap. Root must wire the separate CPU source/config/manifest and an outer controller budget covering setup/condition/cleanup; this delta does not itself establish that integration or any runtime sample count.

Source diff and stdlib AST only. No imports/tests/runtime/models/network/devices; only this report written. Prior passed checks remain closed.


## CPU launcher integration closure — 2026-10-15

**APPROVE, source only**, for the exact integrated CPU packet below. No sample execution or 900-completion claim.

| File | Reviewed SHA256 |
| --- | --- |
| runner.py | `e3348ca0c064679f1c88e7bdc8fdec0942fda24b43fe7fdba2fa9f924d7d7dd9` |
| controller.py | `d2d4b6bb288edda83e519df92f317e31c826fba1a9cc9ae17b191917ce5d1eb6` |
| bootstrap.py | `f89af97e1589486802c797cf02355348199a7f4b343273691d6244ba979b1679` |

Reviewed only path/hash/cap integration and owned cleanup. Source points to the immutable CPU490 snapshot; config/data/output are fresh private491 paths. The existing actual-working CPU483 Piper executable is explicitly selected for both TTS configuration paths; model content remains separately pinned. The declared shared487 environment/library/NLTK paths are consistent with the provided CPU setup handoff. No source/model mutation or package installation occurs in these launchers.

Controller asserts full CPU frozen-manifest SHA256 364832a627e2f45b4b1c2b80ca05739f809132a28ff26511f0eda5e30f89127a, mapped frozen source/model SHA256 values and exact three-key pilot-input hash; actual CPU Llama option dictionary must equal the manifest constructor settings. Bootstrap asserts all six backend package versions before running the491 runner and installs existing binding/observer hooks once. The runner hash remains the already approved e3348ca0c064679f1c88e7bdc8fdec0942fda24b43fe7fdba2fa9f924d7d7dd9.

Counts/caps agree: 15 excluded warmups, 900 planned measured, 180-second flow, 57600-second condition, 57840-second external controller; condition cap is also checked against measurementPlan. Extra external budget is finite rather than a guaranteed completion allowance. Exclusive global build lock and SIGTERM/finally plus owned child process-group INT/TERM/KILL waits are preserved. Resource guards can terminate incomplete work honestly. Added /proc/stat is raw host CPU context, not per-request CPU attribution. Terminal outcome reads measured denominators from summary or progress and records actual child returncode/presence; a Supervisor return does not certify all internal threads reaped.

Only source/stdlib AST checks; no imports/tests/runtime/model/device/network calls or canonical/index/goals/ledger/vault mutation. No rereading model content. Root owns actual environment/symlink/asset assertions at launch, execution and final counts. This approval does not extend to HTTP, hardware playback, aggregate goal completion or CPU/GPU pooling.

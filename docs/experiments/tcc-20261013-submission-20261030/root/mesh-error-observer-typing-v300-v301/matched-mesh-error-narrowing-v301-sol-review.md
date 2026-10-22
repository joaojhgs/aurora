# V301 literal null-error branch closure

2026-10-14 UTC. **APPROVE, source-only.** Independently diffed canonical bridge against the frozen approved backup. The only changes remove the later failed/transport_lost branch's `const code = update.error?.code` and set its errorCode directly to unknown. The earlier any-update.error branch already records the real typed code/status/message hash and breaks; consequently this later branch has a null error and its prior code projection could only yield unknown. The literal change preserves behavior and avoids the narrowed-never TypeScript access.

Final bridge SHA256: `213de9ff068097abb3b54cc643409f2873ab6a10c56195ae915025cafec094eb`.
Frozen approved backup SHA256: `b4253ce9d9cd3d868e4a5e78c011dd838ec67671070932349b6545ed9b1a249e`, at `.git/aurora-handoff-import-20261006/mesh-error-narrowing-v301/before-browser-shell-runtime.tsx`.

Normal typed-error capture, earlier elapsed timestamp, integer status guard, hash-only projection, exact successful terminal/ORBIT/ID predicates and request limits are unchanged. No whole-file audit, tests/compiler/build/services/models/network/device actions, source/index/goal/ledger/vault changes, commits or agents. Only this private report is written.

Root reports V300 failed during Next typecheck with zero requests; that retained result is not an inference failure. Source approval does not claim a fresh compiler/runtime pass. Root owns its current direct web typecheck and one corrected capped diagnostic, with repeated-request cause and MAIN acceptance still open. No additional unit/matrix or unchanged-gate replay is requested.

# V291b exact lint-only source addendum

2026-10-14 UTC. **APPROVE, source-only.** Earlier V291 review is frozen; all its runtime/comparison/privacy/cap limitations remain.

Independently compared the two final canonical files against the approved private V291 files. The driver changes only the nested capture_started/hook-present/end_request-not-one checks into one short-circuit and condition. The same flags and hook call are evaluated in the same order, and provider_capture_invalid is set in the same cases. The hook changes only `_ACTIVE_REQUEST_ORDINAL != request_ordinal` to `request_ordinal != _ACTIVE_REQUEST_ORDINAL`; these are the same int-or-None ordinal values. Both literal lint deltas preserve behavior.

Final reviewed SHA256:

- scripts/experiments/assistant_local_api_pilot.py: `de351707df153a38c0b8d0fb5a2df411895c5e63868b32ae1f3ab5864552c93c` (approved private predecessor `443ea840263c4b24f38f51dc611f328da748080ba01babbaa61fa377888680cb`).
- scripts/experiments/assistant_matched_input_hook.py: `1e342abe17092ac6b237564f51c31344e60f84fde8c1d1636b8876bd33a1f622` (approved private predecessor `7cdbc4dfb931e6db4774f2ec857535103c4ca3e9d9462f26e2e80bcd5297bace`).

Root reports its syntax/embedded-AST/bash/Ruff checks passed; this reviewer ran none. Wrapper must reference this actual V291b report and matching review SHA before launch. The filename-only update does not change the earlier reviewed fixed TZ,600s-per-condition cap, private artifacts, serial ownership or preservation requirements. No whole-file rereview, tests/services/models/network/source/index/goal/ledger/vault mutation or delegation; only this new private report is written. Actual matched pilot results/context equality remain unverified, not inferred from lint/source approval.

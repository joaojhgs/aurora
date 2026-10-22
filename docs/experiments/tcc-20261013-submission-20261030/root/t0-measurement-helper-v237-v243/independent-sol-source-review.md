# V237 independent measurement-instrumentation source review

Verdict: **REQUEST CHANGES for two material schema/measurement gaps.** This is a bounded source review of only the two new files in `/home/developer/projects/aurora/.artifacts/implementation/aurora-study-measurement-v237`; no code/tests/lint/benchmark/build/network/device run was performed. No actual samples, route/mobile acceptance, telemetry, production route driver, scientific conclusion or successful inference is claimed.

Owner-authoritative basis: `/home/developer/Documents/Obsidian Vault Origin/5-full-notes/faculdade/tcc/future-work-test-requirements.md`, Sections16/18/20/25, independently hashed SHA-256 `a2615d9a744f4f5413ab9fee70b0a6928266d203682b8d7814eb2b5798d440d5`. Section25 prescribes Type7 on successful-request latencies, primary p90/p95 and secondary p50, separately visible n_success/n_total and all failed/infeasible outcomes with fixed deadlines/censoring. Sections16/20 require matched settings and redacted/pseudonymous retained artifacts. Execution authorization remains with original Root; no thesis application/submission, company Claude, commits/push/new PR or competing execution is authorized by this review.

## F1 — unrestricted nested content passes the claimed redacted record schema

High confidence, material privacy/schema defect. In `scripts/experiments/assistant_measurement_records.py:135–148`, predicate_id is checked only for correct_success and incorrect_answer. For every non-answer outcome the validator checks only predicate_passed=None and never constrains predicate_id's type or contents. A otherwise-valid failure record with predicate_id set to an object containing raw prompt/history/credential keys therefore passes the exact top-level-field check and every later check. `write_jsonl_once` :181–195 serializes that nested object unchanged into the retained raw artifact. This is a direct source path, not an executed demonstration or a claim that anyone supplied private data.

The issue matters because validate_record's docstring claims a content-redacted record and Section20 forbids credentials/raw prompts/private history in redacted exports. Exact top-level keys are insufficient when an allowed field admits arbitrary nested JSON. `tests/unit/tools/test_assistant_measurement_records.py:156–157` rejects an extra top-level prompt field but does not cover this accepted path. Error/exclusion metadata also currently accept arbitrary strings (:150–162); the latter is emitted verbatim as summary keys (:263–287), so descriptive raw error/request text must not be used as those categories.

Required bounded correction: validate predicate_id on every outcome as null or a declared non-sensitive identifier, never an arbitrary JSON value; enforce/document the non-sensitive categorical/identifier boundary for metadata copied to raw/exported output rather than equating exact keys with redaction. Reject raw diagnostic objects/text at this helper boundary. One focused schema/redaction regression covering the non-answer path is sufficient; no production privacy framework or broad log audit is requested.

## F2 — timeout censoring and fixed-deadline matching are not enforced

High confidence, material measurement-validity gap. `assistant_measurement_records.py:127–133` permits deadline_ms=None for every outcome, including timeout. Thus the helper accepts a timed-out request with no censoring deadline or missingness reason. Its summary :288–290 retains timeout counts under a censoring label but cannot establish the censoring bound when the raw field is absent. Section18 explicitly requires right-censored deadlines and Section25 fixed deadlines; a count alone is not that evidence.

Additionally, group identity :23–34/:230–246 includes the config hash but no check relates an observed deadline to that hash or requires a consistent declared budget within the group. Two records with identical grouping labels/hashes and different deadline_ms are pooled. The supplied mixed-outcome test helper :56 uses a1000ms deadline only for timeout and None for other outcomes, so its single-group fixture does not demonstrate a fixed-budget matched condition. Different fixed timeout budgets change completion rates and which latencies survive into the successful-only quantiles, even with the same model/workload labels.

Required bounded correction: retain a known positive planned deadline for observed timeouts, and enforce a consistent declared deadline for a matched condition (or validate it against the caller's frozen workload/config manifest and explicitly represent legitimate missingness). Keep timeout elapsed/censoring evidence available in the retained raw data; do not relabel absent bounds as observed censoring. Update the one mixed-outcome fixture to represent the fixed budget and reject mismatching/missing timeout bounds. No new route driver, survival-analysis implementation or sampling matrix is requested.

## Sound portions and honest scope

The Type7 implementation :220–228 uses h=(n-1)p and correct linear interpolation; the four-value p50/p90/p95 expectations are mathematically correct. Quantiles are clearly labelled as conditional on correct_success, with n_success latency sample size and null quantiles when no successes. Correct_success requires a nonempty declared predicate identifier, predicate_passed=True and no error category; it never derives correctness from a nonempty response. Actual predicate execution remains caller-owned and is not established by a supplied boolean.

Grouping keeps different workload/model/config/source/route/surface/session/host labels separate. It does not itself prove those hashes correspond to actual run inputs or authorize a cross-route matched-effect claim. Incorrect answers, failures, timeouts, cancellation and infeasibility remain in the eligible completion-rate denominator. n_total separately includes measured excluded records; exclusions and warmups are retained/count-labelled, and explicit predeclared exclusion metadata is required. The eligible denominator is not a success-only denominator. No finite speedup is manufactured for infeasible cases. These features remain useful after the two corrections; the helper is a subset of future instrumentation, not Section20's complete experiment schema or statistical analysis package.

Exclusive JSONL creation, stable serialization, fsync and returned SHA-256 protect against replacement/append through this writer. The source and tests do not prove filesystem-level immutability against other writers; no broader storage/race audit was performed. Tests are meaningful source fixtures for quantiles, mixed outcomes, model-group separation and write-once behavior, but were only read, never executed.

## Exact reviewed hashes and handoff

| File | Independently verified SHA-256 |
| --- | --- |
| scripts/experiments/assistant_measurement_records.py | `e624cbf04b61a636e2ac643d7be0b84af20f1f5c479f1935fd10ffcd6ec0c38b` |
| tests/unit/tools/test_assistant_measurement_records.py | `c0c31d23f7348e81962a431eb82a1e78761b6d49a7d2092deb028e41ae0c0021` |

Only this one private report under canonical Root `.git/aurora-handoff-import-20261006/` was written, outside the candidate index. No candidate/canonical source, index/worktree, goal/ledger or vault/monitor document was changed; no commit/push, agent/worker/task/Run, recursive delegation or execution was created. No ownership conflict/resource exhaustion; eight-minute cap honored. Root alone owns serial correction and focused tests before any bounded pilot. Native independent Sol fallback result is relayed by Root through the original Orca run/monitor without invented dispatch or external authority. Stop at these two concrete findings; prior feature reviews stay closed.

## 2026-10-14 — bounded F1/F2 delta review

Delta verdict: **APPROVE the corrected two-file source candidate; F1 and F2 are closed.** This replaces the initial REQUEST CHANGES for those two demonstrated findings only. No new edges, route/schema breadth or earlier feature reviews were opened.

Independently verified corrected hashes:

| File | SHA-256 |
| --- | --- |
| scripts/experiments/assistant_measurement_records.py | `b728a8ec83ccbc527110f5835a9b048262de1c07418fa1c0ac2f61a42d2db099` |
| tests/unit/tools/test_assistant_measurement_records.py | `724e0bd92fe11926194b4ccd35fdf59df7985c692a6d766d6f5531a21efb8a31` |

F1: predicate_id is now checked on every outcome as null or a bounded versioned identifier (:158–167), so the demonstrated non-answer nested raw object cannot reach the writer. Error and exclusion reasons now use finite declared categories (:49–65/:184/:194); summary exclusion keys cannot carry arbitrary request/error text. The focused fixture rejects nested prompt content on a failure and a raw error-category string. This closes the identified schema path; meaningful identifiers and caller-supplied source/model/pseudonym facts still require honest, approved inputs, rather than a blanket privacy/content certification.

F2: deadline_ms is now required to be finite and positive for all records (:145–156), including timeout. summarize_group requires one fixed planned deadline across the matched group's records (:280–282), so summarize_records cannot silently pool differing budgets within a group. Raw records retain that budget alongside elapsed timestamps; the fixture now supplies 1000ms for every outcome and checks rejection of a timeout without its bound and differing group budgets (:133–136). The existing failure-inclusive denominator and successful-request Type7 quantiles remain intact. These changes close the missing-bound/mixed-budget finding without claiming correctness execution, survival estimation or a measured result.

The tests were read only. Root owns its sole targeted validation; no reviewer PASS is inferred. The original authoritative requirements hash and all remaining instrument-only/source-review limitations above remain applicable. No helper/test execution, test/lint/build/network/device activity, candidate/source/index/goal/vault edits or commits occurred; only this delta was appended to the same private report. No conflicts/resource exhaustion; four-minute delta cap honored. No actual samples, driver/route/mobile acceptance, telemetry, scientific result, thesis application/submission or external approval is established.

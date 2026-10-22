# V497 final four-finding source closure

Verdict: **APPROVE the exact corrected launcher sources, source only.** The original REVIEW.md REQUEST CHANGES remains preserved for superseded bytes.

| File | Final reviewed SHA256 |
| --- | --- |
| controller.py | `e9ec599e04abb77730817f1200e23664a67f06b4350280c8758902833c763f8e` |
| bootstrap.py | `7a3b4434d9cfaa3ea0ba157e6363c331895c1d40140d8062f136c97204a0cf00` |
| README.md | `46bec15fdf528a8c2cc13f641ee43cae2a56394cc90219cac0b0ea0326a5f1fe` |

1. Shared environment/interpreter: fixed. _admit_python_environment admits the separately frozen absolute shared environment, requires its exact bin/python path, resolves the interpreter link to the declared canonical regular executable and hashes that target. The old campaign-root-only/non-symlink restriction no longer rejects a normal interpreter link. General campaign source/config/hook/output confinement remains. **Actual required manifest field names are venvPath, interpreterPath, resolvedInterpreterPath, resolvedInterpreterSHA256**; Root's prepared manifest must use these source/README names, rather than abbreviated pythonPath terminology in a handoff.

2. Required observation bindings: fixed. observer.py and aurora_voice_telemetry_v430.py are mandatory exact-path harness bindings, are required to exist during preflight, and enter the same actual byte-size/SHA validation loop as other pinned harness sources. Bootstrap is unchanged, so existing installation and six-package checks remain as reviewed.

3. Independent manifest admission: fixed. AURORA_HTTP_V497_EXPECTED_FROZEN_SHA256 is required to be a valid lowercase SHA256 and compared with current full-manifest bytes BEFORE json.loads and manifest-dependent environment admission. Only this matching hash is forwarded to the child. Root retains responsibility for supplying the independently approved value, not deriving a new value on the fly after launch admission.

4. Frozen config custody: fixed. The pinned input config is read/verified, then copied using exclusive creation into runtime/config.json, fsynced, mode0600 and compared byte-for-byte. Only this private runtime copy is passed as AURORA_CONFIG_FILE. Normal migration/normalization can now persist without modifying the frozen input, while HTTP493's existing runtime pre/post/drift guards remain unchanged.

Deployment is explicitly resolved in README: controller ROOT and HTTP493 RUNNER paths must be mirrored exactly on the desktop. This is an unexecuted future preparation dependency, not an alternate-path alias. Source output containment remains compatible at those paths. Counts/caps/locks and owned cleanup logic remain unchanged by these four fixes: 15 excluded warmups/900 planned measured/180-second flow/12600-second condition/12780-second outer controller. Root must retain post-seal actual resource/environment/source/manifest admission and actual outcomes; source approval does not certify a future launch, successful request, completed condition, all-thread cleanup, whole-GPU or cross-device readiness. Public health remains availability rather than independent authentication proof.

Validation: correction-only source inspection and stdlib AST parse of controller/bootstrap; exact hashes above. No candidate imports/tests/runtime/apps/models/build/device/network/remote calls, new agents, active campaign reads/edits or canonical/index/goals/ledger/vault changes. Only this new final report written. No added review criteria or extra cases requested; stop at closure.


## Root-identified same-cohort launch binding — latest overall verdict

**REQUEST CHANGES for the current e9ec controller; the four original findings above remain closed.** Root identified and this reviewer confirms a directly relevant missing binding: the new env.update omits V485's GGML_VK_VISIBLE_DEVICES='1' and OMP_NUM_THREADS/OPENBLAS_NUM_THREADS/MKL_NUM_THREADS='2'. The ordinary controller shell does not inherit V485 child environment, so n_gpu_layers alone cannot bind the same GPU selection or math-library thread limits. The new controller also lacks V485's prelaunch RX7600 device0x7480/8GiB identity assertion and receipt; periodic AMD counters do not replace that binding. Restore those exact explicit environment values and the same identity guard/receipt, or require an independently frozen equivalent binding before child launch. No new runtime probe/test or expanded matrix is requested. This is a material same-setup/cohort omission rather than a request for general device hardening. No future execution approved until this exact source correction is closed.

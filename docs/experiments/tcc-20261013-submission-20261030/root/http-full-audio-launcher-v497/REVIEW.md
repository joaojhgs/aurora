# V497 future HTTP launcher source review

Verdict: **REQUEST CHANGES — four material integration/admission issues.** This is source only; no HTTP, process, application, model, device, build or test execution.

| Reviewed file | SHA256 |
| --- | --- |
| controller.py | `608dff9fac417bd013114ac7e2f34f1d22d301819e251dea9d8ba205bd0c33b8` |
| bootstrap.py | `7a3b4434d9cfaa3ea0ba157e6363c331895c1d40140d8062f136c97204a0cf00` |
| README.md | `cc558ecfc5a516adc8fc05e017ac1053c8c2b1f3ba256aa916833d91b676537c` |

Unchanged approved HTTP493 interface is runner SHA256 43cc4f3152f1675e14641fedcc30a4071f1185ce8ae7edfd211271bc0fbffd51; its prior effective-key finding remains closed.

1. **Declared shared Python environment cannot pass this admission** — controller.py:21 fixes ENV_ROOT under ROOT, :203–220 routes its directory and bin/python through _private_path, and :39–62 rejects any symlink component. Normal uv/venv bin/python interpreter symlinks are therefore rejected; the declared already-admitted read-only desktop environment outside ROOT is also rejected. This requires a duplicate/full environment or nonstandard interpreter layout unnecessarily. Bind the exact existing environment and resolved interpreter explicitly in the approved manifest/admission, verifying those exact paths/identity while preserving campaign source/config/output confinement. Do not generally relax all symlink/path guards or copy dependencies/caches just to satisfy this check. Actual environment resolution is Root-owned, not remotely probed here.

2. **Mandatory observer files are not mandatory hash bindings** — controller.py:139–151 requires runner/controller/bootstrap/bindings only in expected_harness_paths. hook/observer.py is existence-checked (:214) but may be absent from frozen harness hashes. hook/aurora_voice_telemetry_v430.py is neither a required pin nor preflight existence check, although bootstrap imports it and installs it before running the condition. Require both exact observer files in the expected harness bindings and preflight paths. This is necessary to bind the actual telemetry implementation and avoid a missing-module startup failure; it requests no new telemetry fields.

3. **Frozen manifest is trusted using its own newly computed digest** — controller.py:232–237 computes frozen_hash from current FROZEN bytes without comparing an independent expected admission SHA; :329 passes that same computed hash to the child. The runner consequently checks transport self-consistency but cannot detect substitution of the whole plan/assets/harness/config reference since approval. Require Root's externally frozen expected SHA and assert it before trusting/parsing the manifest. This can also bind the exact approved runner/hook/environment plan; do not describe self-hashing as that independent freeze.

4. **Normal startup mutates the supposedly immutable frozen launch input** — controller.py:312 sets AURORA_CONFIG_FILE directly to INPUT/launch-config.json. Existing ConfigManager normal startup persists language normalization and secret migration; the V482/V484 retained failures already demonstrated those writes, and HTTP493 intentionally accommodates them. This will modify a pinned input rather than retaining its exact original bytes. Verify and retain the frozen input, then write its byte-identical starting content to a fresh private runtime/config.json and point the child at that runtime copy. Let HTTP493 retain its pre/post config hashes and later drift guards normally. No production config, migration or auth change is needed.

## Supported seams and deployment handoff

The intended counts/caps agree with HTTP493: 15 excluded warmups, 900 planned measured, 180-second flow, 12600-second condition and 12780-second outer controller. Exclusive global/GPU locks, owned process-group INT/TERM/KILL waits, SIGTERM-to-finally, finite resource sampling/stop floors and terminal returncode/presence evidence are present. Provider/source/model/audio hash loops and exact constructor-option comparison are present, subject to the independent manifest binding above. No new account/grants/auth bypass or task/result substitution is introduced; only an existing fixture environment key is passed, with no key receipt.

Absolute ROOT and RUNNER currently name the coding-worker handoff namespace. A deployment that preserves those exact paths on the desktop can satisfy the runner's PRIVATE_ROOT/output-containment interface; a deployment only into .git/aurora-http-audio-* cannot launch these unchanged scripts. Root must freeze one actual deployment map and ensure controller/bootstrap/runner/output paths agree. This is a concrete preparation dependency, not a request for another path framework or an automatic assertion that identical-path deployment is impossible. No desktop transfer or source mutation is authorized by this report.

Bootstrap still installs existing hooks and verifies six actual package versions before dispatching to the exact HTTP493 path. Source approval here cannot claim actual library identity/loaded modules or outcome counts; later actual receipts remain required. Public health readiness is availability, not standalone authentication proof. Full raw logs remain private. Supervisor return/process-parent absence must not be promoted to all-thread/host cleanup acceptance.

Read the three files and referenced approved HTTP493 interface; stdlib AST parsed controller/bootstrap. No imports/tests/runtime/network/remote/model/device commands, active campaign inspection/change, new agents, canonical/index/goals/ledger/vault mutation or commits. Only this report written. Stop after these four connected fixes; no extra matrix or product behavior criteria requested.

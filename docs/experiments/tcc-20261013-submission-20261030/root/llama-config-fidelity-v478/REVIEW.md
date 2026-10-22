# V478 bounded independent typed Llama option-fidelity source review

2026-10-15 UTC. **APPROVE exact five-file source correction.** Source/hash/diff inspection only; no imports/tests/runtime/models/build/network/device/Orca operations, canonical/index/goals/vault writes or agents. This report is the sole owned write.

All five preserved preimages match before.json. Actual current deltas exactly match the five supplied per-file .diff artifacts, including restored unrelated schema formatting. Reviewed final SHA256:

- app/services/config/config_schema.json `558cf9641fcb050c60768c845ddb94558e6a1fe4656547a2e3efc638850969af`.
- app/shared/config/models.py `00fb3ef21b4477f8d02cd1d47c702edadae982608ff4a28f72609a0e83f3f59f`.
- app/shared/config/keys.py `c14fb6252fa88e337b1a27d2fd20976ad98b4a59ef8a75065f9afac7de08d269`.
- app/services/config/config_defaults.json `1ddb323235b97b1211bcfbf97ca0b6167f2a42a48b76e7fa0db9dda3767939a8`.
- tests/unit/orchestrator/test_llama_configured_options_product.py `55fa269116be506b86b8a02bfde184b6620fe9486bbbe72602785c628d0be2ff`.

## Connected configuration correction

The schema now explicitly declares seed, n_threads and verbose only in existing local llama_cpp.options. Generated Options3 retains those values instead of silently dropping them as undeclared fields. Generated keys address exactly those same three paths. Defaults preserve actual current ChatLlamaCpp wrapper defaults: seed=-1 and verbose=false; n_threads remains omitted/None for automatic selection rather than introducing a fixed thread count. Bounds permit the declared seed42/thread2 case. No provider/model/route/permission or unrelated option changes occur.

The actual production chatbot path reads typed Llama options and model_dumps exclude_unset/exclude_none before constructing ChatLlamaCpp. Explicit seed42/n_threads2/verbose=true therefore now survives that exact filtering. The wrapper already has these fields and forwards them to its backend; no inference implementation or native guard was changed. This is faithful propagation of declared configuration, not a new execution override or claim that configured values prove actual GPU offload.

The single added regression validates a real typed Orchestrator config, performs the same option dump, constructs actual ChatLlamaCpp against the existing controlled backend constructor, and checks backend seed/thread/verbose plus wrapper fields. It exercises both previously lossy typing and real wrapper forwarding, beyond merely checking generated attributes. Reviewer did not run it. Root owns the one targeted test/lint/generation evidence; no additional test matrix or model replay is requested.

## Evidence boundaries

The prior V477 constructor observation is evidence that those historical actual options were missing; this patch does not retroactively turn null values or missing offload logs into positive evidence, repair prior STT correctness, or establish seeded reproducibility for already measured datasets. New declared-vs-actual constructor bindings and actual offload remain future runtime checks if separately authorized. Prior failed raw records and all unrelated WIP stay preserved. No audio/main/900-cohort/full-voice/platform or phase-2 acceptance is implied. No material source blocker found; stop.

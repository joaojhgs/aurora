# Preserve declared Llama execution settings

The full-audio pilot exposed a real configuration boundary defect: the declared seed42, CPUthreadcount2 and model-loading verbosity were absent from the actual model-constructor options. The schema accepted additional keys while typed generated options inherited extra=ignore. That silently discarded these existing wrapper settings.

The schema now declares seed, n_threads and verbose explicitly. Regenerated models, keys and defaults retain explicit values. Existing behavior when unset is preserved: random seed-1, automatic threads and no verbose logging. No inference/provider/model/permission behavior is changed beyond honoring these explicit settings.

One regression passes a real typed Orchestrator config through the production option dump into the actual ChatLlamaCpp wrapper against the existing controlled backend constructor. Backend seed42/threads2/verbositytrue are asserted. Root targeted1testPASS32.78s (outer38.635418s, cap150/global lock); RuffPASS; generatorEXIT0. Independent Sol exactfive-file sourceAPP bbc89368fbc0bef3d6f6fe2b9669808dc219be917a9ea72599a158a3cd63423d. All preexisting WIP preimages/diffs retained privately; source copies and hashes included here. No commit/push.

This fix was made after the pilot runtime retired. It does not change its failed transcription/result, prove runtime GPU offload, establish settings in historical cohorts, admit another audio retry, or satisfy any900-request/fullindividual/cross-device gate. New explicit constructor/runtime evidence remains required when the next valid condition is admitted.

Documentation check: make check-docs EXIT2/2.279865s. It reports861 generated/report artifacts under the owner-requested experimental evidence tree (including23 new-package paths) and one older broken campaign.py link in matched-main-campaign-v319/runner-report.md. Raw project-doc evidence is explicitly owner-required; no records moved/deleted and no checker weakened. This repository-wide documentation gate is not clean.

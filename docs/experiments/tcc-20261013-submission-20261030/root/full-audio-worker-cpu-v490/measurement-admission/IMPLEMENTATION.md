# V491 CPU full-audio campaign runner

This is a private source-only CPU campaign candidate based on the reviewed V485 runner. It changes only the overall condition cap and adds a fail-closed consistency check that the frozen cohort manifest declares that same cap at `measurementPlan.conditionOverallCapSeconds`.

The retained CPU490 one-flow readiness run completed all strict transcript, Assistant, and TTS predicates in 49.633587315 seconds. The bounded capacity estimate is `915 remaining flows × 49.633587315 s × 1.25 = 56,768.4 s`; the candidate rounds that up to 57,600 seconds (16 hours). It retains 15 excluded warmups, 900 measured requests, and the existing 180-second per-request deadline. No model, algorithm, predicate, denominator, hook, or source behavior is changed.

Provenance: base V485 `runner.py` SHA-256 `30d3b91918277bb85ed4c5e8649a488ee7d6e665122b70be53c5a190eab05297`; candidate runner SHA-256 `e3348ca0c064679f1c88e7bdc8fdec0942fda24b43fe7fdba2fa9f924d7d7dd9`. This has not been executed or tested. Root owns independent review, CPU manifest freeze after readiness admission, and any later campaign launch. The previous desktop-GPU campaign remains separate; this runner's source does not establish a frozen CPU cohort or measured results.

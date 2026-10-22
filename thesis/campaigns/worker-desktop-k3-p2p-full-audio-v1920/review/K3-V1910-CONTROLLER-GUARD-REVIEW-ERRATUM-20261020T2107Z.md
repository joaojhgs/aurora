# K3 V1910 controller guard: review erratum and bounded recovery

The prospective core review missed a material inherited controller guard. Its no-material-blocker result is superseded for this controller binding check. The closed STT composition/runner/proof and V1911 provider delta findings are unchanged; this is not a new full source audit.

Run run_e6054e76e9fc; Task task_d7ea336050cf; Dispatch ctx_37b4d0a3c14f. Root notification msg_2d22f5dc0421 at2026-10-20T21:06:07Z. Monitor independently observed exact requester controller3057025/start130875311 and finalizer3057027/start130875313 missing at21:05:59.873603Z, copier3057026/start130875313 live, zero retained case records and awaiting_progress. No liveness/retry inferred from a timeout.

The saved requester-controller.private.log records ValueError independent_remote_receiver_bindings_missing at controller.py157. Direct source context confirms set(receivers) != {"assistant","tts"} rejects the correct new STT+Assistant+TTS manifest. This check is before backend CELL creation, as Root independently reconciled; no backend/control-launch/progress/case, no requester warmup/audio/measured request. This is a harness preflight error, not model/transcription quality failure or missing host/owner authority.

The earlier review treated the controller's mechanical equivalence to K2 as sufficient and missed that its two-stage assumption no longer fits K3. That was my review error. Root already identified the precise cause and owns the minimal correction; no provider restart, another baseline, unchanged test suite or broad review matrix is justified.

Preserve V1915 conditionb7cefab662f5c199408dc5e8ae8ecbd6516d3f294845d4f08762ddb7264217a3 and its controller/finalizer failure receipts physically under thesis/. Root alone will reconcile/retire the exact owned zero-case copier, update the controller to validate and bind all3receiver peers, and freeze a linked replacement requester with a new source/condition hash. Do not alter old frozen files or replay requests that never occurred. Existing provider161159/161160 stays reserved within its original deadline; all preparation/recovery time remains charged to the original condition/provider caps.

The linked requester may perform the already authorized finite main admission,15fresh excluded full-audio warmups,45remote native joins/90call rows/new GPU proof and then900measured when admitted. No extra review gate is required by this erratum. Actual launch/admission remain unverified at this observation.

Original core review: K3-V1910-CUMULATIVE-STT-DELTA-REVIEW-CLOSED-20261020T2056Z.md SHA9756ecd80bdccb542e48e4ad3d7a08dfadd7160892453d7e5d8d612fe3297a30. This erratum preserves that report and the failure history instead of overwriting it.

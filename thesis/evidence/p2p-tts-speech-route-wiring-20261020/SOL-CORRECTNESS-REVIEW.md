# P2P TTS runtime speech wiring: bounded correctness review PASS

Requested by original Root in msg_6d0b01ddade8, same Run run_e6054e76e9fc; existing monitor Task task_d7ea336050cf/Dispatch ctx_37b4d0a3c14f. ONE concrete implementation review of the exact PRODUCT-FIX.diff, its three production files, the associated regression and saved verification. No source edits, new test run, model/audio call, extra worker or broad review by monitor. This is not live P2P acceptance.

## Result

No blocking correctness finding in the requested diff. The implementation addresses the observed staticNone method constraint while retaining typed speech binding and normal authority boundaries. The earlier scope opinion is closed and this concrete review is now closed too; another unchanged review or general suite is not indicated.

## Evidence and reasoning

- app/shared/services/base_service.py:1194/:1226/:1381: one hook supplies constraints to both receiver binding validation and announcedMethodInfo. Existing requirement-digest and capability-revision checks remain; non-WebRTC semantics remain as before. The base hook preserves other methods' static contracts. The patch does not alter grants, identity-source authority, required permissions or peer selection.
- app/services/tts/service.py:589/:739: the new cache is per service instance and bound to actual provider object plus voice revision. It is populated from the existing guarded runtime projection, which requires finite/raw synthesis, two successful current matching health observations, public ready standard voices, exact normalized languages, actual mesh identity and unchanged model identity/capabilities. Failed current projection clears the cache; provider/revision changes make the getter returnNone. Each returned constraint is deep-copied instead of mutating global method contracts. Stage capability and constraint construction use the same model/language/voice snapshot.
- app/services/gateway/registry_aggregator.py:185/:276: the thread-mode reload preserves announced per-topic runtime speech constraints and stage capabilities together under the existing registry lock; copies are detached. Subsequent service announcements continue to replace the runtime snapshot through the existing registry revision/digest path. No new authorization evaluator or hard-codedPiper/English capability is introduced.
- tests/unit/tts/test_runtime_speech_announcement.py:116 exercises an actual TTS ServiceAnnouncement into RegistryAggregator, then thread refresh and matching receiver binding. It checks changed voice revision rejection and current failed-health metadata withdrawal. This regression covers the observed boundary instead of merely checking the new helper return value.

Root's saved VERIFICATION.json records36passed/0failed across exactly the three named targeted suites in39.21seconds, with Ruff checks passing. The reviewed production/test hashes equal that record. These are Root's executable checks; the monitor did not rerun them or expand the test matrix. Relevant shared/service/gateway/contract guides were read. GitNexus is not callable in this session, so direct exact-diff/source evidence was used without a repository-wide rebuild.

## Remaining acceptance, not another review gate

Root should finish custody and normally retire the old unadmitted provider within its existing finite deadline, then stage/freeze the corrected source for BOTH requester and provider. Record the actually loaded corrected source paths/hashes, actual ready catalogue and matching non-null typed speech route. Complete15ordinary excluded full audio→STT→LLM→TTS→valid-audio warmups with exact peer/provider/native model joins before900measured. Preserve actualICE/path and resource evidence, failed setup/warmup history, unchanged effective models/workload and all closed HTTP/CPU/GPU cohorts.

The reviewed unit result cannot establish real remote model execution, route/ICE topology or sample completion. P2P measured remains0until actual receipts arrive. No old900 replay or additional review is required by this review; any further check must follow a concrete new source change or observed failure. Android's owning-host observer/binding issue stays separate.

## Exact reviewed versions

- `app/shared/services/base_service.py` — 69281bytes; SHA256`39702090d31044081ecd4425c7f04858397337ae83b3425612766db783c560ec`.
- `app/services/tts/service.py` — 228651bytes; SHA256`96f916131756a5ec2a27f606c719d4c360a9d6d52890a266b59ef3193f14b07e`.
- `app/services/gateway/registry_aggregator.py` — 27485bytes; SHA256`10d555a1486fb2c804cbb97539878fcb8cf2a6c314e123ca9149215f3a66b98e`.
- `tests/unit/tts/test_runtime_speech_announcement.py` — 15103bytes; SHA256`5cb4d99379ed9456aaa8028e8c367ae929404c1de4c7b6ce8075b3e03a0fac18`.
- `thesis/evidence/p2p-tts-speech-route-wiring-20261020/SCOPE.json` — 883bytes; SHA256`54009b3168186253075b5f49b9645050fb304854e8fb16910855b76bd1709f74`.
- `thesis/evidence/p2p-tts-speech-route-wiring-20261020/PRODUCT-FIX.diff` — 11432bytes; SHA256`acd2180c5937a497308b64e342b6b081f717c2bcf9fec28584c0ef6e41f56f48`.
- `thesis/evidence/p2p-tts-speech-route-wiring-20261020/VERIFICATION.json` — 1188bytes; SHA256`1ea3f8e9596b031f8d0ffcaeed843472cf23f3e83d8d458eaa0c4690ea610abc`.

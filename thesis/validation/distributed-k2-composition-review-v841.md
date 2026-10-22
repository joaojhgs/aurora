# V841 K2 output-validation closure — APPROVE (partial source)

2026-10-16 UTC. Both V837 findings are closed in the exact V839 delta.

The TTS response metadata is retained in the existing record before validation. _check_wav failures are caught, relabeled synthesized_wav_invalid/profile_invalid and raised through fail("tts", ...), retaining the earlier STT/Assistant and received-TTS evidence in partial_record. The response must report channels=1 and the decoded header is independently validated against mono. Successful completion is marked only after those checks.

Exact reviewed k2_composition.py SHA-256: 08be1fa730d6e49ccf4bd491539b4b8edb5b3476eb7f8f7db9656db5e7b3a053.
Base V834 SHA-256: 164e85998de0c963fcce15141e2a0a525d95882c97fcfef1a2cdb39df444ce60.

Only the two requested changed seams were inspected, with a Python AST parse without import. Prior V837 review/history is preserved and other positive findings remain closed. No runtime, tests, models, network, services, browser/device/Orca, Git or source edits occurred.

Approval is for this partial one-case K2 composition source. Owning persistence/accounting/controller, exact runtime/config/model/endpoints and source admission, native receiver correlations/provider evidence, actual 15 warmups and 900-measured acceptance remain separate future Root gates. No K3 or distributed runtime result is claimed.

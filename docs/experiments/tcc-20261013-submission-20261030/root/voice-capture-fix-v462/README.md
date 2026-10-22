# Focused browser capture fix V462

Capture now becomes listening after microphone startup succeeds, with duplicate-start and lifecycle ownership preserved. Normal stop accepts queued PCM through the processor acknowledgement or the original bounded release deadline, then drains and flushes. This addresses source-level main-flow defects; it does not establish the cause of the earlier voice mismatch or a successful voice runtime.

Root ran the two affected test files: UI 6 passed, worklet 26 passed. Voice runtime typecheck passed; final UI typecheck passed in 48.526733 seconds. The first UI fixture lacked focus and a later new mock lacked complete session fields; these test-only issues were corrected, the observed failures retained, and only affected checks rerun. Sol approved the final exact four-file source (report 44d7e50b…). No models, phrases, acceptance criteria, permissions or timeout bounds changed. Prior source preimages and candidate remain preserved in the handoff directory. No commit or push occurred.

Only a changed production browser build and one next voice main are authorized by this checkpoint. The original CPU extra cohort and typed GPU cohorts remain sealed separately; full GPU voice/surface acceptance and cross-device barrier remain open/closed respectively. Raw file hashes and validation/review receipts are in manifest.json.

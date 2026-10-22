# V462 bounded independent capture-readiness source review

2026-10-15 UTC. **APPROVE the reviewed production-source fix and two focused regression sources**, including Root's test-only foreground-fixture correction. No imports/tests/browser/runtime/models/build/network/device/Orca operations, source/index/goals/vault edits or agents by reviewer. This private report is the sole owned write. Root alone owns targeted tests/typechecks and later actual acceptance.

## Exact reviewed identity

- packages/aurora-ui/src/use-assistant-browser-capture.ts: `cef59aa2f2ddbc0774099ebcce27e92159734d9028ad56e09bf3ecb8efe57fd5`.
- packages/aurora-ui/src/use-assistant-browser-capture.test.ts, final inspected Root focus-fixture correction: `d6edf4e4a2575db378eadfcf366cd781982796b060a79a489b91163b802243fe`.
- packages/aurora-voice-web/src/audio-worklet-source.ts: `af88cb9a88bdc8887ac6edfcd26f4dc6bb59d75bec84a5da3418c9453b6bc643`.
- packages/aurora-voice-web/tests/audio-worklet-source.test.ts: `53a3e4898f59606a736b572d77699fa4c8fdb9d8967d86eab8d9d7245e41c274`.
- Original four-file candidate.patch: `3738dc42a83fee6548d255c07b6160645c2f726e7d3ccc17e01b860d6ade0772`; IMPLEMENTATION.md `a3135aecf3883e849dc22c199e5a26fcb10a45868156fd41445d9fd744296ad8`; SOURCE.md `6c067130162d08b5121d6d149a90d6a0d65c2bad8794f2dcdd4e3ff1bf1b396b`.

All production/worklet-test hashes match integration.json. Its original UI-test hash b208317f… is superseded by the explicitly inspected test-only focus spy/try-finally restoration above; the original patch/integration record is historical, not silently treated as that final test's identity.

## Main source findings and correction

The documented preimage exposed listening before awaited runtime.start and marked stopping before processor acknowledgement while the message handler rejected audio under that flag. Independently inspected unchanged runtime.ts `c8d9da…` confirms session_started only follows worker acknowledgement, completed PCM start and current-session assertion. Unchanged processor `ed33c998…` posts audio before stopped acknowledgement/port close. These are source-supported readiness/tail windows, **not proof of the observed voice8 recognition cause**.

The controller no longer advertises listening during initial idle/requesting startup. Only a current successful runtime.start or its genuine session_started event establishes listening. It keeps original foreground eligibility, owns pending startup through the existing settlement/token state, rejects duplicate starts, invalidates/cancels pending startup on lifecycle loss, and prevents stale completion from restoring listening. Startup settlement resolves on success/failure/stale cancellation; existing turn settlement still owns complete/abandon/cancel. No permission, capture eligibility, speech route, model, phrase or acceptance predicate is relaxed.

Normal worklet stop requests acknowledgement while still accepting audio. Because both audio and acknowledgement are handled through the existing serialized message chain, earlier queued PCM can reach the assembler before acceptance closes. Successful acknowledgement is followed by chain drain, stopping, cleanup and flush. A missing/failed acknowledgement retains the original bounded resource-release race (maximum250ms), after which acceptance closes and existing cleanup/finally/flush behavior applies. Cancel/fail-closed paths still immediately reject/cancel audio and release resources. No timeout increase, alternate model or provider retry is introduced. No material startup/cancel/drain blocker found in this connected scope.

## Regression scope and honest validation

The delayed-start regression exercises the real controller: idle during pending start, one actual start despite duplicate request, then listening only after success. Root's sole correction mocks document.hasFocus=true for this eligible scenario and restores it in finally; it does not bypass product eligibility. The stop regression uses the actual worklet source, posts nonzero PCM before a controlled stopped acknowledgement and checks a retained frame plus track/context release. These are two relevant main regressions, not a new matrix. Root reports the first jsdom-focus fixture failure separately; reviewer did not execute or upgrade any test result.

Source approval does not establish fixed capture fidelity, correct transcription, full voice/UI/audio outcome, measured samples, physical microphone/audibility, native/mobile acceptance or full GPU/phase2 release. Prior failed evidence remains retained. No additional cases or broad review required; stop.

## Exact final test-type correction

**APPROVE unchanged product fix with final UI regression SHA256 `599f004438d7fdd2f444cb40944e1a8769acb70e891b747798ebf9926430ab74`.** It supersedes the d6edf4e4 test snapshot above. The new regression now derives StartedSession from Awaited<ReturnType<AuroraBrowserVoiceRuntimeInstance['start']>> and resolves its delayed promise with all actual session fields (sessionId, ownerId, generation, startedAtMs and foregroundOnly). The delayed-start/duplicate-start/listening assertions and focus spy/restoration remain unchanged. This is a test typing correction, not an eligibility/production/lifecycle behavior change; the other three reviewed hashes remain the final anchors above.

Root reports prior UI6/worklet26/voice-web-typecheck passes and the subsequent UI type failure are preserved, with only the affected UI file and UI typecheck being rerun. Reviewer did not execute or infer the pending result. No new source walk, tests, matrix or runtime acceptance criterion added. Source verdict remains APPROVE; stop.

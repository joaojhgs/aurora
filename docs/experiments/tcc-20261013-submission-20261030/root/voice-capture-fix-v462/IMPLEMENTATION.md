# Browser voice capture readiness candidate

This private candidate contains only the four assigned files. It does not modify the canonical worktree.

## Changes

- `packages/aurora-ui/src/use-assistant-browser-capture.ts` leaves capture status `idle` and keeps the existing focused-microphone request message while runtime startup is pending. It marks the capture `listening` after a current start succeeds, while retaining the existing `session_started` event path. The existing settlement token/state prevents duplicate starts and gives pending startup lifecycle cancellation ownership; a late start is cancelled and cannot restore `listening`.
- `packages/aurora-voice-web/src/audio-worklet-source.ts` requests processor stop while audio messages are still accepted. It drains the serialized messages through a successful stop acknowledgement, then disables acceptance and flushes the assembler. A missing acknowledgement still stops acceptance at the existing bounded resource-release deadline (maximum 250 ms); cleanup and cancel behavior remain unchanged.
- Each corresponding test file adds one focused regression: delayed startup is not shown as listening (and duplicate start is rejected), and a worklet audio message queued before the stop acknowledgement is retained.

## Hashes

Original preimage SHA-256 values:

- `use-assistant-browser-capture.ts`: `f6d1d6e2f1d6d164e446271917bc8534f0e283be58a40ddabf845e4a66e069cd`
- `use-assistant-browser-capture.test.ts`: `6963cbafc185b075b4e857235d26b4d98db1bd599bf6c3f39b9552f3a3d4759b`
- `audio-worklet-source.ts`: `cd249ff9fc569da31c2cd2b1f556a8f1f779fc5b2cf36a786ace3632d686ed6c`
- `audio-worklet-source.test.ts`: `4d4e56aa07fe3cd79acd7472e7d0f126bf944eadf3b9373800063e9717b210c0`

Candidate SHA-256 values:

- `use-assistant-browser-capture.ts`: `cef59aa2f2ddbc0774099ebcce27e92159734d9028ad56e09bf3ecb8efe57fd5`
- `use-assistant-browser-capture.test.ts`: `b208317f0c4fb081fafb7c0e85c1508610058e17830369519100fc8ce7b9c8ae`
- `audio-worklet-source.ts`: `af88cb9a88bdc8887ac6edfcd26f4dc6bb59d75bec84a5da3418c9453b6bc643`
- `audio-worklet-source.test.ts`: `53a3e4898f59606a736b572d77699fa4c8fdb9d8967d86eab8d9d7245e41c274`
- Combined patch: `3738dc42a83fee6548d255c07b6160645c2f726e7d3ccc17e01b860d6ade0772`

## Validation boundary

No tests, builds, or runtime checks were run. Root should apply/review the candidate and run the two named test files plus the existing focused UI and voice-web typechecks. The cause of the earlier captured-audio timing was not proven by this source correction; the changes repair the deterministic startup-state and queued-stop-message behavior only.

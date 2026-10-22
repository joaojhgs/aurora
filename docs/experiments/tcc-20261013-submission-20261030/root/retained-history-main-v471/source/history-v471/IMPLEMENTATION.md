# Retained Assistant history reopen driver

This private driver exercises one already-persisted typed conversation through
the maintained Aurora web UI. It performs normal gateway setup and normal
username/password login, opens Assistant history, selects the unique row for
the fixed prompt, and checks that the exact prompt and `ORBIT` reply are
rendered after selection. `AURORA_RETAINED_SESSION_ID` is required and must
match the session found in the authenticated `DB.ListSessions` response.

The driver does not create a conversation or submit a prompt. It fails if it
observes an Assistant, transcription, or TTS write. It records only safe
request/response headers, DB session request fields, response hashes/sizes,
fixed result booleans, and bounded in-context failure state. DB response bodies
are inspected transiently to verify the selected session and its messages;
only hashes, byte counts, and fixed match booleans are retained. Output
directories and files are created exclusively with private permissions.

The complete setup and history flow has one 90-second monotonic deadline.
Failure-page state and screenshot capture run before Playwright closes, with
three- and five-second limits respectively. This is a source candidate only;
the browser flow was not executed here and no runtime result is claimed.

The UI contracts were checked in `packages/aurora-ui/src/use-assistant-history.ts`
(`loadPersistedConversation`, `activatePersistedSession`, and
`openPersistedSession`), `packages/aurora-ui/src/assistant-history.tsx`
(`Assistant conversation list`), and `app/services/db/service.py`
(`_session_message` returns `role` and `content`; `get_session` returns
`session` plus `messages`). The normal conversation title is derived from the
initial prompt in `packages/aurora-ui/src/assistant-history-model.ts`.

The driver was adapted from the retained V461 production-UI driver
(`typed-product-main-v461/driver.py`, SHA-256
`fd744d6aaffb9302c0c0e9b9c2b7607c456bffa1e56d8c86c3a5ecc3136a1bf9`) and uses
the in-context failure-capture pattern from V466
(`startup-primary-v466/driver.py`, SHA-256
`964fa5af79f363c2040ba2d500d301d6e1e9fdfdefe4d3357aa6fdfe1741f5d6`).

Required environment values are `AURORA_WEB_BASE_URL`, `AURORA_GATEWAY_URL`,
`AURORA_CHROMIUM_EXECUTABLE`, `AURORA_FIXTURE_USERNAME`,
`AURORA_FIXTURE_PASSWORD`, `AURORA_RETAINED_SESSION_ID`, and a fresh
`AURORA_OUTPUT_DIR`. Credentials are read from the environment and never
written to result files. Root owns any execution against the retained copied
database and existing compatible build.

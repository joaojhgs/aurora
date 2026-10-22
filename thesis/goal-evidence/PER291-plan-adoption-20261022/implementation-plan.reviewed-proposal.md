# Transcript Library — implementation plan

**Issue:** PER-291 / PER-288 Stage 3
**Status:** Plan only. Production UI work is not authorized by this deliverable.

## Start gate and current truth

The Stage 1 transcript schema/repository and Stage 2 capture/configuration source are present in the current stack and have received bounded source review. The complete Stage 2 capture/configuration device and architecture acceptance gate is still pending. Implementation starts only after the parent records that gate as accepted for the applicable authorized surfaces, including the required Android capture journey. Current active validation excludes iOS; this does not create a new Apple-host execution gate here. Continuous background transcription on iOS remains unsupported, and any future Apple runtime claim still requires the existing Apple workflow. A passing component test or source review is not a substitute. This plan does not declare PER-286 or PER-291 accepted.

The current UI has no transcript-library view. The Android native service can admit `ambient` and `notification` capture, create a profile/node-scoped session, append encrypted segments, and finalize or recover sessions. Its exposed status gives aggregate capture mode and capability/permission/storage facts, but no session ID. The Android admission path currently writes null model-provenance values and `not_requested` diarization. The library must present those facts as unavailable/not performed; it must not infer the active session from mode alone or invent speaker/model details.

## Product structure

Add a **Transcripts** view inside the existing **This device** local-data area, adjacent to the existing local conversation history in `MemoryView` / `LocalDataMemoryPanel`. Reuse the existing local-data provider, cards, fields, empty states, alerts, and navigation conventions. Use the existing Memory navigation target and internal Transcripts collection/detail selection; no new top-level URL or navigation registry entry is required. Do not create a second archive store or route remote peer records into this view. If the local backend cannot open the current profile/node archive, show a recoverable local-data state instead of an empty library.

The view has two selectable collections:

- **Ambient** groups sessions by the device-local calendar day derived from `startedAtMs`, newest day first. Each session is a timeline item. When diarization evidence exists, render only the supplied speaker turns and supplied labels; group adjacent segments with the same stored speaker ID, without merging nonadjacent turns. Treat `pending` as identification in progress, with all unattributed segments shown without speaker headings. With `partial`, retain known speakers and visibly mark unassigned turns; with `not_requested` or `unavailable`, render a flat chronological transcript without speaker headings.
- **Manual recordings** groups by the individual notification-start/stop session. Show its start, end when present, elapsed session interval, and lifecycle. A notification start creates the session boundary; a stop/failure/restart does not merge it with another session.

The capture mode is the only accepted grouping discriminator: `ambient` versus `notification`. Do not equate the saved background-transcription preference with a recording. Do not add record/start/stop controls to the library; explain that recording preferences live in Voice settings and that a manual recording is controlled by the native notification action.

## Contract mapping

| UI information/action | Source of truth | Rendering/behavior |
| --- | --- | --- |
| Profile and local device scope | `LocalDataProviderValue.scope` (`profileId`, `localNodeId`) | Clear cached view data on either value changing. Never show another profile/node’s rows during loading or after a failed switch. The account boundary is the OS user’s local Aurora data plus this saved profile/node scope; do not invent an account ID. |
| Ambient/manual grouping | `TranscriptSessionRecord.captureMode` | `ambient` uses day timeline; `notification` uses one card per session. |
| Start/end/duration | Session `startedAtMs`, `endedAtMs`; segment `startAtMs`, `endAtMs` | Use localized device time, with full accessible date/time. Duration is the session interval, not the sum of speech segments. Keep segment order by sequence and show segment times only when available. |
| Lifecycle and interruption | `lifecycle`, `terminalReason`, timestamps | `active` is not proof that capture is presently running. Show “Recording” only after a future contract can bind runtime status to the exact session; current aggregate status has no session ID. Completed/interrupted/failed remain distinct. Map known reasons to plain action-oriented copy and keep unknown reason codes out of user-facing text. |
| Transcript text | `TranscriptSegmentRecord.textEnvelope` and exact local-data AAD (`aurora_transcript_segments`, `text_envelope_json`, record/profile/node identity) | Text remains encrypted at rest. Read it only through an authorized, scoped decryption facade. Never read a made-up plaintext `text` field or expose keys to components. |
| Speaker information | Session `diarizationState`; segment `speakerId`, `speakerLabel` | Show only stored values. `partial` does not imply missing labels can be guessed. No correction control until a separate annotation API stores corrections independently from original segment evidence. |
| Model/language provenance | Session `language`, `modelProvenance.{provider,modelId,version}` | Show only non-null stored values. Current Android writer records null model provenance; render “Not available” or omit the row. Do not derive a model from settings or provider status. |
| Search and filters | `listSessions({limit,cursor})`, `listSegments(sessionId,{limit,afterSequence})`; existing SDK transcript search | Preserve the `(createdAtMs,id)` session cursor and per-session `afterSequence`. The accepted `searchLocalData(session, options)` already pages transcript sessions and segments and returns `sessionId` plus segment `sequence`; select `domains: ["transcripts"]` and the current profile/node `scope`. It remains bounded by scan/result/decrypt budgets, so do not promise exhaustive results. Exact mode/date/lifecycle filters and a resumable budget/continuation result remain the named library-search follow-up; filtering only a loaded page is not an archive-wide filter. |
| Delete one recording | `deleteSession(sessionId)`; returned `deletedSegments` | Confirm that deleting a recording also deletes its transcript segments. Bind deletion to the current profile/node scope; keep the row until the repository confirms deletion. |
| Retention and expiry | Session `expiresAtMs`; `deleteExpiredSessions(nowMs,limit)` | Show the expiry date and that expired recordings are removed. On archive open, run bounded expiry deletion batches (repository maximum 1,000 sessions per call; total archive cap 5,000), then refresh. If cleanup cannot complete, report that old items may remain and do not present an empty-state success. |
| Whole-archive backup | `LocalDataSession.exportV1()` | Keep existing encrypted whole-scope backup separate from “Export recording.” V1 includes encrypted envelopes and is not a per-recording readable export. |
| Current capture capability | Android `AndroidBackgroundTranscriptionStatus` / `resolveBackgroundTranscriptionState` | Only use to show device-level availability/permission/storage guidance. It has no session identity, so it cannot mark an individual row as currently recording. |

## Required follow-up capabilities before the affected controls ship

1. **Scoped content access:** add an approved UI-facing decrypt facade to `LocalDataProvider` (or its typed transcript facade), bound to the active backend session and profile/node AAD. The provider currently exposes a session and repositories but no `EnvelopeCryptoPort`/authorized transcript decrypt operation. Until this exists, the library may show metadata only; it must not display encrypted envelope JSON as text.
2. **Finish the library-search contract:** reuse the accepted paged `searchLocalData` transcript domain and existing stable `sessionId`/segment sequence. The first-page and missing-parent-identity defects were repaired at `739f848d953486f0be417c97430a509fe8b4730d` and are not open work. Add exact mode/date/lifecycle filters plus explicit exhaustion/continuation semantics for the library. Current `LocalDataSearchOptions` has no such filters or cursor, and `LocalDataSearchResponse` has no continuation token. Current defaults scan at most 1,000 segment records; configurable bounds are 5,000 segment records, 200 results, 64 KiB per decrypted record and 512 KiB total decrypted content, with at most the canonical 5,000 archive sessions. These limits do not guarantee exhaustive results. Preserve scope/AAD authorization and cancellation; never rerun or replace the accepted paging repair as new implementation.
3. **Per-recording readable export:** define a user-initiated, scoped export operation that decrypts only the selected session and presents the plaintext consequence before file creation. Do not repurpose whole-scope V1 backup or send transcripts to a peer/cloud service. Until the operation is approved, omit this action and retain the existing whole-archive backup as a separately named action.
4. **Speaker correction:** add a distinct local annotation record/operation if correction is approved. It must not mutate `speakerId`, `speakerLabel`, confidence, or original transcript text in the captured segment. Until then, speaker labels are read-only.
5. **Exact live-session association:** if the product needs a row-level recording badge, extend the native status boundary to identify the session under the existing native authority. Current status reports mode but not session ID; the UI must not correlate by mode alone.
6. **Truthful Android provenance:** populate provider/model/version only from the exact admitted native STT binding used for the session. Until then retain nullable values and render provenance as unavailable.

These are named follow-ups, not reasons to weaken privacy or fabricate a UI state. Any per-profile or profile-switch operation remains bound to the active `profileId` and `localNodeId`; records are not shared with remote peers.

## State and interaction behavior

- **Loading:** skeleton rows within the selected collection; announce loading through a polite live region. Preserve the selected tab and search text during same-scope refresh.
- **Empty:** distinguish “No ambient transcripts” from “No manual recordings.” If current capability is unavailable, show the capability state separately; do not imply that the user recorded and lost content.
- **Ready:** paginated session list, selected session detail, transcript segments loaded in bounded pages. Virtualize long lists while preserving keyboard and screen-reader semantics.
- **Partial content:** if some segment pages or decryption fail, retain already loaded content, identify the affected session, and offer retry. Never replace a decryption error with “No transcript.”
- **Interrupted/failed:** show stored lifecycle and safe reason-specific recovery guidance. A process restart is an interrupted session, not a completed recording. The existing local-data open paths call `recoverActiveSessions`; render the resulting repository lifecycle, not a locally guessed status.
- **Storage/capability error:** use the existing local-data storage health and product error mapping. Keep previously loaded rows only if their scope still matches; otherwise clear them. Retry must reopen/reload the same scope.
- **Permission revoked:** show the saved session as interrupted when native records that terminal state. Device-level permission status may show how to restore permission for future capture; it does not rewrite the saved session.
- **Retention:** show the recorded expiry date. Expired rows disappear only after confirmed bounded repository deletion. If another batch remains, continue the bounded cleanup and show a non-success state until it finishes.
- **Delete:** use an accessible confirmation dialog naming the selected recording and that its saved transcript is deleted too. Do not offer delete for an `active` session: deletion during capture needs a separately approved stop/finalize/delete coordination boundary; the viewer does not stop capture. On cancel, preserve state. On success, move focus to the next row or collection heading; on failure, retain the record and show a safe retry message.
- **Export:** keep disabled/absent until the selected-session export follow-up is approved and implemented. If later enabled, explicitly state that a readable text file leaves encrypted storage and remains under the user’s control; require an explicit action and never include raw audio.

## Component and state boundaries

- `LocalDataProvider` / `LocalDataContext` remains the owner of local backend readiness, profile/node scope, storage health, and reopen. Extend only with an authorized transcript-content operation when the follow-up API is ready; components do not receive raw encryption keys.
- Add `useTranscriptLibrary` beside `useLocalConversations`. It owns scoped session/segment cursors, request cancellation/generation, search/filter state, deletion confirmation, bounded expiry cleanup, and stale-response rejection when profile/node scope changes.
- Add `TranscriptLibraryPanel`, `TranscriptSessionList`, `TranscriptSessionDetail`, `TranscriptSegmentList`, and a small `TranscriptPrivacyNotice` under `packages/aurora-ui/src/local-data/`. Use shared Aurora UI controls, existing card/empty/error patterns, semantic lists and dialogs. Keep day grouping and notification interval grouping as separate view helpers over the same typed records.
- Mount the panel as a sibling to local conversation history in `LocalDataMemoryPanel`/`MemoryView`; keep the existing navigation entry and do not create a second storage/provider lifecycle.
- Device-level capture settings/status remain owned by the existing Voice settings policy hook. The library may link to those settings but may not write policy or start/stop native capture.

## Layout, accessibility, and copy

Use a two-pane list/detail layout on wide screens and a single-column list-to-detail navigation on narrow screens. Preserve back navigation and selected-session context. Do not require hover. Keep controls reachable with keyboard, visible focus, logical heading order, labelled search and filters, accessible pagination, and focus restoration after dialog close/delete. Announce loading, result count, and deletion completion without repeating every transcript update. Respect reduced-motion preferences; use no motion to communicate lifecycle. Ensure text zoom and narrow layouts do not clip timestamps or controls.

Production copy describes user outcomes, not storage internals. Say transcripts are saved on this device and are not shared; say no audio is stored only where the capture contract confirms it. Explain retention duration, interruption, and delete consequences plainly. Avoid saying a transcript is searchable, exportable, diarized, live, or complete unless the corresponding stored/API state proves it.

## Bounded implementation sequence

1. **Gate confirmation:** Root records Stage 2 acceptance and exact supported surfaces. Resolve any row-level live-session requirement and the scoped decryption facade before rendering transcript text.
2. **Repository/state hook:** add cursor-based session and segment pagination, mode/date/lifecycle filters, scope cancellation, bounded expiry cleanup, and lifecycle/status copy. Adapt the accepted paged transcript search and stable session/segment references; add only the named exact-filter and budget/continuation follow-up.
3. **Read-only library:** mount ambient and notification collections, detail view, empty/loading/partial/interrupted/storage states, local-only and retention disclosure. Keep delete/search/export/correction controls unavailable until their mapped operation is ready.
4. **Safe actions:** enable scoped delete after cascade confirmation. Add separately reviewed selected-record text export only after its decryption/export boundary exists. Add speaker annotation only under the separate immutable-evidence API.
5. **Aesthetics and platform completion:** source-level UI review followed by fresh desktop and Android runtime checks; Apple-host/iOS evidence requires an Apple host. Do not label a surface accepted from a shared React test alone.

## Surface and capture matrix

Resolve every surface through `getAuroraSurfaceProfile` and the existing local-data provider; physical platform and saved runtime role remain separate. No ad hoc transport check or compile-time role flag is introduced. Viewing requires a ready archive in the current scope, independently of capture capability.

| Surface | Future local archive journey | Capture limitation / screenshot state |
| --- | --- | --- |
| Desktop local | Existing scoped local backend; list, detail, delete | Do not infer Android recording capability. Wide list/detail, interrupted detail and keyboard focus. |
| Desktop thin | Current-device archive only when its local provider is ready; no remote transcript feed | Show unavailable capture guidance from current capability facts. Wide/narrow local or unavailable state. |
| Web thin | Existing browser-local backend, with its actual persistence/storage-health disclosure | No claim of native background recording. Narrow list/detail or local-data unavailable state. |
| Android | Current scoped native archive | Native notification start/stop and ambient capability come from the separate native capture owner. Phone portrait/landscape and interrupted detail. |
| iOS | Current scoped archive when native local-data support opens successfully | Continuous background transcription is unsupported; do not promise it. Phone/tablet and capability-unavailable state. Packaged runtime review requires macOS/Xcode through the existing workflow. |

The future screenshot set is limited to the representative states above, plus keyboard-open narrow detail, empty and one partial/error state. Collect these after a separately authorized viewer implementation. Final aesthetic approval remains reserved to the source Astra session; this plan/source review does not grant it.

## Small future validation set

1. Repository-backed component flow with one ambient session and two notification sessions: correct day/interval grouping, exact order, times, and terminal state.
2. Diarization fixture with `partial` evidence plus a no-diarization session: only known labels render; unassigned turns remain unlabelled and deterministic.
3. Scoped search/pagination flow with a result beyond the first page: stable `sessionId`/sequence navigation, cancellation on scope switch, no cross-profile content.
4. Delete/retention flow: confirmation, cascade counts, bounded expiry batches, and failure retains the item without claiming deletion.
5. Accessible responsive review of wide and narrow layouts: keyboard through search/list/detail/dialog, focus restoration, screen-reader names/status, zoom, and reduced motion.
6. After the start gate, one local archive journey on desktop local, desktop thin and web thin, plus one Android notification-recording journey from native start through archive display/deletion. iOS remains explicitly pending until an Apple-host runtime journey exists.

This is a focused main-flow set, not a combinatorial platform/use-case matrix. Broader device reliability, permission revocation, storage failure recovery, and Apple-host validation remain release gates owned by the parent.

## Non-goals

- Production UI implementation in this task; this deliverable is the plan only.
- Capturing or playing raw audio, automatic transcript sharing, cloud/peer search, or cross-peer SQL.
- Invented diarization/speaker identity/model provenance, editing captured transcript evidence, or marking recording from a saved preference.
- A new capture workflow in the library, new storage system, or parallel settings policy.
- Treating source review or local component tests as device/architecture acceptance.

## Source basis and review limits

Reviewed current source: `packages/aurora-sdk/src/local-data/records.zod.ts`, `repositories.ts`, `memory-backend.ts`, `search.ts`, `export-v1.ts`; `packages/aurora-ui/src/local-data/local-data-provider.tsx`, `local-data-context.ts`, `use-local-conversations.ts`, `storage-health-view.tsx`; `packages/aurora-ui/src/memory-view.tsx`, `native-speech-policy.ts`; `packages/aurora-sdk/src/background-transcription.ts`; `apps/aurora-tauri/src-tauri/src/local_data_native.rs`, `native_transcription_archive.rs`; and Android `AuroraRuntimeForegroundService.kt`.

The receiving checkout has no `.omx/specs/` directory, so this plan uses the authoritative PER-291 intake and current implementation contracts rather than claiming a review of absent UI refinement specs or mockups. Source review establishes available fields and behavior only; the parent still owns gate acceptance and platform validation; the source Astra session retains final aesthetic approval.

## 20 October 2026 source reconciliation (local proposal)

This local proposal preserves the previously committed/reviewed plan and its published draft unchanged. It corrects the stale first-page/parent-session search claim using the already accepted PER-289 search checkpoint and current identical search source. Twelve of15 original pinned sources are unchanged. The three changed sources are search, the native policy port/sharing controls, and centralized surface flags; current changes preserve archive scope/record/status ownership. The current status type still has no session ID, so no row-level recording claim or new screen is introduced.

Existing search checks, SDK typecheck/build and source approval remain closed; no test, build, screenshot or device run was repeated for this proposal. The exact source/evidence map is `CURRENT-CONTRACT-EVIDENCE.json` beside this proposal. The original Stage 2 capture/config acceptance, original linked-delivery/QA-then-architecture/tracker gates, and separate viewer implementation authorization remain open. Source Astra retains final aesthetic authority for any later authorized viewer. No task/aggregate completion, current PR update, commit/push or external publication is claimed.

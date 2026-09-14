# Ambient Transcription

Aurora's local transcript archive stores bounded, encrypted transcript metadata and
segments for explicitly enabled capture modes. It does not write audio or plaintext
transcript text to disk.

## Privacy-first defaults

Background transcription is disabled by default. The persisted node policy contains
only user preference (`enabled`, capture modes, retention days, and language). Runtime
capability is discovered separately, and the effective state is enabled only when the
preference and the current platform capability both allow it.

Ambient capture should be enabled only with the required consent and visible product
indicator. Operators must follow local recording and workplace-consent requirements.

## Archive contract

Each transcript has a profile and local-node scope, capture mode (`ambient` or
`notification`), lifecycle, retention deadline, language, model provenance, and
diarization state. Segments are ordered by a per-session sequence and contain an
encrypted `textEnvelope`; retries with the same segment ID and identical payload are
idempotent, while conflicting replays are rejected.

The local SDK exposes the same typed repository through memory, IndexedDB, SQLite-WASM
with OPFS, and the Tauri SQLite bridge. Opening a store recovers active sessions as
`interrupted` after an unclean exit. Finalization is idempotent, retention deletes
expired sessions with their segments, and deleting a session cascades to its segments.

Exports/imports include encrypted envelopes, session metadata, ordered segments,
counts, and collection hashes. Search returns metadata without decryption unless the
caller supplies an authorized envelope crypto port; decrypted search uses transcript
segment AAD bound to the profile, local node, record ID, and table/field identity.

## Configuration

The V2 node configuration persists the following safe default:

```json
{
  "backgroundTranscription": {
    "version": 1,
    "enabled": false,
    "ambient": false,
    "notification": false,
    "retentionDays": 30,
    "language": null
  }
}
```

Capability and effective-state values are runtime-only and are never persisted in
the node configuration document.

## Related code

- SDK contract and repositories: `packages/aurora-sdk/src/local-data/`
- SQLite migration: `packages/aurora-sdk/src/local-data/migrations/sqlite/0004_transcripts.sql`
- Browser SQLite worker: `packages/aurora-ui/src/local-data/browser-sqlite-worker.ts`
- Tauri native bridge: `apps/aurora-tauri/src-tauri/src/local_data_native.rs`

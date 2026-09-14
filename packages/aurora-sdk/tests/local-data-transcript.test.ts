import { describe, expect, it } from 'vitest'

import { MemoryLocalDataBackend } from '../src/local-data/index.js'
import { transcriptSegmentFixture, transcriptSessionFixture } from './fixtures/local-data-fixtures.js'

const scope = { profileId: 'profile-1', localNodeId: 'node-1' }

describe('local transcript archive', () => {
  it('is ordered, replay-safe, scoped, and cascade-deletable', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    await expect(session.transcripts.createSession(transcriptSessionFixture())).resolves.toMatchObject({ lifecycle: 'active' })

    const segment = transcriptSegmentFixture()
    await expect(session.transcripts.appendSegment(segment)).resolves.toEqual({ appended: true, record: segment })
    await expect(session.transcripts.appendSegment(segment)).resolves.toEqual({ appended: false, record: segment })
    await expect(session.transcripts.appendSegment({ ...segment, speakerLabel: 'Speaker 1' })).rejects.toMatchObject({ code: 'invalid_record' })
    await expect(session.transcripts.appendSegment({ ...segment, id: 'transcript-segment-2', sequence: 0 })).rejects.toMatchObject({ code: 'invalid_record' })

    await expect(session.transcripts.listSegments(segment.sessionId)).resolves.toEqual([segment])
    await expect(session.recoverActiveTranscripts(1800)).resolves.toEqual({ interrupted: 1 })
    await expect(session.transcripts.getSession(segment.sessionId)).resolves.toMatchObject({
      lifecycle: 'interrupted',
      endedAtMs: 1800,
      terminalReason: 'process_restart'
    })
    await expect(session.transcripts.deleteSession(segment.sessionId)).resolves.toEqual({ deleted: true, deletedSegments: 1 })
    await expect(session.transcripts.deleteSession(segment.sessionId)).resolves.toEqual({ deleted: false, deletedSegments: 0 })
  })

  it('finalizes idempotently, applies retention, and round-trips encrypted records', async () => {
    const source = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const sessionRecord = transcriptSessionFixture({ id: 'transcript-session-export', expiresAtMs: 2000 })
    const segment = transcriptSegmentFixture({ id: 'transcript-segment-export', sessionId: sessionRecord.id })
    await source.transcripts.createSession(sessionRecord)
    await source.transcripts.appendSegment(segment)
    await expect(source.transcripts.finalizeSession(sessionRecord.id, 'completed', 1800, 'capture_stopped')).resolves.toMatchObject({
      lifecycle: 'completed',
      endedAtMs: 1800
    })
    await expect(source.transcripts.finalizeSession(sessionRecord.id, 'completed', 1800, 'capture_stopped')).resolves.toMatchObject({ lifecycle: 'completed' })
    await expect(source.transcripts.finalizeSession(sessionRecord.id, 'failed', 1800, 'different')).rejects.toMatchObject({ code: 'session_closed' })

    const document = await source.exportV1()
    expect(document.records.transcriptSessions).toEqual([{
      ...sessionRecord,
      lifecycle: 'completed',
      endedAtMs: 1800,
      terminalReason: 'capture_stopped'
    }])
    expect(document.records.transcriptSegments).toEqual([segment])
    expect(JSON.stringify(document)).toContain('ciphertextAndTagB64Url')
    expect(JSON.stringify(document)).not.toContain('plain transcript')

    const destination = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    await expect(destination.importV1(document)).resolves.toMatchObject({ imported: true, recordCounts: { transcriptSessions: 1, transcriptSegments: 1 } })
    await expect(destination.transcripts.listSegments(sessionRecord.id)).resolves.toEqual([segment])
    await expect(destination.transcripts.deleteExpiredSessions(2000, 10)).resolves.toEqual({ deletedSessions: 1, deletedSegments: 1 })
  })
})

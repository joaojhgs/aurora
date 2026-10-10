import { describe, expect, it } from 'vitest'

import {
  LocalDataError,
  MemoryLocalDataBackend,
  assertJsonSafety,
  parseLocalDataExportV1,
  parseTranscriptSegmentRecord,
  type EncryptedDataEnvelopeV1,
  type EnvelopeCryptoPort,
  type LocalDataKeyPurpose,
  type TranscriptSessionRecord,
  type TranscriptSegmentRecord
} from '../src/local-data/index.js'
import { searchLocalData } from '../src/local-data/search.js'

const scope = { profileId: 'profile-1', localNodeId: 'node-1' }

const envelope: EncryptedDataEnvelopeV1 = {
  version: 1,
  algorithm: 'AES-GCM-256',
  keyId: 'key-local-structured-data-1',
  nonceB64Url: 'AAAAAAAAAAAAAAAA',
  ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
  createdAtMs: 1_100
}

function sessionRecord(overrides: Partial<TranscriptSessionRecord> = {}): TranscriptSessionRecord {
  return {
    id: 'transcript-1',
    profileId: scope.profileId,
    localNodeId: scope.localNodeId,
    captureMode: 'ambient',
    createdAtMs: 1_000,
    startedAtMs: 1_000,
    endedAtMs: null,
    lifecycle: 'active',
    terminalReason: null,
    expiresAtMs: 5_000,
    language: null,
    modelProvenance: { provider: null, modelId: null, version: null },
    diarizationState: 'not_requested',
    ...overrides
  }
}

function segmentRecord(overrides: Partial<TranscriptSegmentRecord> = {}): TranscriptSegmentRecord {
  return {
    id: 'transcript-1-0',
    sessionId: 'transcript-1',
    sequence: 0,
    startAtMs: 1_100,
    endAtMs: 1_250,
    textEnvelope: envelope,
    confidence: null,
    speakerId: null,
    speakerLabel: null,
    createdAtMs: 1_300,
    ...overrides
  }
}

describe('local-data transcript archive', () => {
  it('keeps sessions separate, appends idempotently in sequence order, and finalizes once', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    await session.transcripts.createSession(sessionRecord())
    const first = segmentRecord()
    const second = segmentRecord({ id: 'transcript-1-1', sequence: 1, startAtMs: 1_250, endAtMs: 1_400, confidence: 0.73 })

    expect(parseTranscriptSegmentRecord(second).confidence).toBe(0.73)
    expect(() => assertJsonSafety({ confidence: 0.73 }, 'json.object')).toThrow()
    expect(() => parseTranscriptSegmentRecord(segmentRecord({ confidence: -0 }))).toThrow()

    await expect(session.transcripts.appendSegment(first)).resolves.toEqual({ appended: true, record: first })
    await expect(session.transcripts.appendSegment(first)).resolves.toEqual({ appended: false, record: first })
    await expect(session.transaction(async (repositories) => {
      await repositories.transcripts.appendSegment(second)
      throw new Error('rollback transcript segment')
    })).rejects.toThrow('rollback transcript segment')
    await expect(session.transcripts.listSegments('transcript-1')).resolves.toEqual([first])
    await session.transcripts.appendSegment(second)
    await expect(session.transcripts.listSegments('transcript-1', { afterSequence: 0 })).resolves.toEqual([second])
    await expect(session.conversations.listConversations()).resolves.toEqual([])

    const final = {
      sessionId: 'transcript-1',
      lifecycle: 'completed' as const,
      endedAtMs: 1_500,
      terminalReason: 'capture_complete'
    }
    await expect(session.transcripts.finalizeSession(final)).resolves.toMatchObject({ lifecycle: 'completed', endedAtMs: 1_500 })
    await expect(session.transcripts.finalizeSession(final)).resolves.toMatchObject({ terminalReason: 'capture_complete' })
    await expect(session.transcripts.appendSegment(first)).resolves.toEqual({ appended: false, record: first })
    await expect(session.transcripts.appendSegment(segmentRecord({ id: 'late', sequence: 2 }))).rejects.toMatchObject({ code: 'session_closed' })

    const exported = await session.exportV1()
    const reopened = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    await reopened.importV1(exported)
    await expect(reopened.transcripts.listSegments('transcript-1')).resolves.toEqual([first, second])
  })

  it('recovers active sessions as interrupted and cascades bounded retention deletion', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    await session.transcripts.createSession(sessionRecord({ id: 'expired', expiresAtMs: 2_000 }))
    await session.transcripts.createSession(sessionRecord({ id: 'kept', expiresAtMs: null }))
    await session.transcripts.appendSegment(segmentRecord({ id: 'expired-segment', sessionId: 'expired' }))
    await session.transcripts.appendSegment(segmentRecord({ id: 'kept-segment', sessionId: 'kept' }))

    await expect(session.transcripts.recoverActiveSessions(900, 'process_restart')).resolves.toEqual({ interrupted: 2 })
    await expect(session.transcripts.getSession('expired')).resolves.toMatchObject({ lifecycle: 'interrupted', endedAtMs: 1_000 })
    await expect(session.transcripts.deleteExpiredSessions(2_000, 1)).resolves.toEqual({ deletedSessions: 1, deletedSegments: 1 })
    await expect(session.transcripts.listSegments('expired')).resolves.toEqual([])
    await expect(session.transcripts.listSegments('kept')).resolves.toHaveLength(1)
    await expect(session.transcripts.deleteExpiredSessions(2_000, 0)).rejects.toMatchObject({ code: 'invalid_record' })
  })

  it('searches only authorized transcript text with native-compatible AAD and keeps legacy exports readable', async () => {
    const backend = new MemoryLocalDataBackend()
    const session = await backend.open(scope.profileId, scope.localNodeId)
    await session.transcripts.createSession(sessionRecord())
    await session.transcripts.appendSegment(segmentRecord())
    const crypto = new TranscriptSearchCrypto()

    const metadata = await searchLocalData(session, { scope, query: 'ambient', nowMs: 1_400, domains: ['transcripts'] })
    expect(metadata.summary.contentSearchAuthorized).toBe(false)
    expect(metadata.results).toMatchObject([{ domain: 'transcripts', id: 'transcript-1-0', sessionId: 'transcript-1', matchField: 'metadata' }])
    expect(JSON.stringify(metadata.results)).not.toContain('private spoken phrase')

    const content = await searchLocalData(session, {
      scope,
      query: 'spoken phrase',
      nowMs: 1_400,
      domains: ['transcripts'],
      maxScanRecords: 1,
      decrypt: { crypto, authorized: true }
    })
    expect(content.results).toMatchObject([{ domain: 'transcripts', id: 'transcript-1-0', sessionId: 'transcript-1', matchField: 'decrypted_content', matchedTextPreview: 'private spoken phrase' }])
    expect(content.summary).toMatchObject({ scannedRecords: 1, decryptedRecords: 1 })
    expect(JSON.parse(new TextDecoder().decode(crypto.aad[0] ?? new Uint8Array()))).toEqual({
      envelopeVersion: 1,
      field: 'text_envelope_json',
      localNodeId: scope.localNodeId,
      profileId: scope.profileId,
      recordId: 'transcript-1-0',
      table: 'aurora_transcript_segments'
    })

    const exported = await session.exportV1()
    expect(exported.records.transcriptSessions).toHaveLength(1)
    expect(exported.records.transcriptSegments).toHaveLength(1)
    const imported = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    await imported.importV1(exported)
    await expect(imported.transcripts.listSessions()).resolves.toHaveLength(1)
    const legacy = structuredClone(exported) as Record<string, unknown>
    const records = legacy.records as Record<string, unknown>
    delete records.transcriptSessions
    delete records.transcriptSegments
    const counts = legacy.recordCounts as Record<string, unknown>
    delete counts.transcriptSessions
    delete counts.transcriptSegments
    const hashes = legacy.collectionHashes as Record<string, unknown>
    delete hashes.transcriptSessions
    delete hashes.transcriptSegments
    expect(parseLocalDataExportV1(legacy).records.transcriptSessions).toEqual([])
    expect(parseLocalDataExportV1(legacy).records.transcriptSegments).toEqual([])
  })

  it('finds and identifies transcript segments beyond the first session page', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    for (let index = 0; index < 500; index += 1) {
      const id = `recent-${String(index).padStart(3, '0')}`
      await session.transcripts.createSession(sessionRecord({ id, createdAtMs: 2_000 + index, startedAtMs: 2_000 + index }))
    }
    await session.transcripts.createSession(sessionRecord({ id: 'older-recording', createdAtMs: 1_000, startedAtMs: 1_000 }))
    await session.transcripts.appendSegment(segmentRecord({ id: 'older-recording-segment', sessionId: 'older-recording' }))

    const response = await searchLocalData(session, {
      scope,
      query: 'older-recording-segment',
      nowMs: 1_400,
      domains: ['transcripts']
    })

    expect(response.results).toMatchObject([{
      domain: 'transcripts',
      id: 'older-recording-segment',
      sessionId: 'older-recording',
      sequence: 0,
      matchField: 'metadata'
    }])
  })

  it('rejects cross-scope and conflicting sequence writes without altering the archive', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    await expect(session.transcripts.createSession(sessionRecord({ profileId: 'profile-2' }))).rejects.toMatchObject({
      code: 'identity_mismatch'
    })
    await session.transcripts.createSession(sessionRecord())
    await session.transcripts.appendSegment(segmentRecord())
    await expect(session.transcripts.appendSegment(segmentRecord({ id: 'different-id' }))).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'duplicate_transcript_sequence' }
    })
    await expect(session.transcripts.finalizeSession({
      sessionId: 'transcript-1',
      lifecycle: 'failed',
      endedAtMs: 1_500,
      terminalReason: 'different_terminal'
    })).resolves.toBeDefined()
    await expect(session.transcripts.finalizeSession({
      sessionId: 'transcript-1',
      lifecycle: 'completed',
      endedAtMs: 1_600,
      terminalReason: 'late_completion'
    })).rejects.toBeInstanceOf(LocalDataError)
    await expect(session.transcripts.listSegments('transcript-1')).resolves.toHaveLength(1)
  })
})

class TranscriptSearchCrypto implements EnvelopeCryptoPort {
  readonly aad: Uint8Array[] = []

  async encrypt(_keyPurpose: LocalDataKeyPurpose, _plaintext: Uint8Array, _aad: Uint8Array): Promise<EncryptedDataEnvelopeV1> {
    return envelope
  }

  async decrypt(_envelope: EncryptedDataEnvelopeV1, aad: Uint8Array): Promise<Uint8Array> {
    this.aad.push(new Uint8Array(aad))
    return new TextEncoder().encode('private spoken phrase')
  }

  async rotateKey(_keyPurpose: LocalDataKeyPurpose): Promise<{ previousKeyId: string; newKeyId: string }> {
    return { previousKeyId: 'old', newKeyId: 'new' }
  }
}

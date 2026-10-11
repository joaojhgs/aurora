import { describe, expect, it } from 'vitest'

import { resolveBackgroundTranscriptionState, type BackgroundTranscriptionFacts } from '../src/background-transcription.js'
import {
  emptyAuroraNodeConfigDocumentV2,
  migrateAuroraNodeConfigDocumentV2,
  sanitizeAuroraNodeConfigDocumentV2,
  updateAuroraNodeConfigDocumentV2,
  AuroraNodeConfigRevisionConflictError
} from '../src/node-config.js'

const ready: BackgroundTranscriptionFacts = {
  capability: 'supported', permission: 'granted', foreground: true,
  sttAvailable: true, archiveAvailable: true, captureMode: null
}

describe('background transcription policy and current facts', () => {
  it('defaults older V2 and V1 documents off without changing their observed revision', () => {
    const current = emptyAuroraNodeConfigDocumentV2(100)
    const { backgroundTranscription: omitted, ...oldV2 } = current
    expect(omitted.enabled).toBe(false)
    expect(migrateAuroraNodeConfigDocumentV2(oldV2, 200)).toEqual(current)
    expect(migrateAuroraNodeConfigDocumentV2({ version: 0 }, 200).backgroundTranscription).toEqual(omitted)
    expect(resolveBackgroundTranscriptionState(current, { ...ready, captureMode: 'ambient' })).toMatchObject({
      ambientRequested: false, recording: false, reason: 'disabled'
    })
  })

  it('saves requested ambient policy with CAS while requiring actual capture, consent and storage', () => {
    const current = emptyAuroraNodeConfigDocumentV2(100)
    const draft = { ...current, backgroundTranscription: {
      ...current.backgroundTranscription, enabled: true, ambient: true, retentionDays: 14
    } }
    const saved = updateAuroraNodeConfigDocumentV2(current, draft, 1, 200).document
    expect(saved.revision).toBe(2)
    expect(saved.backgroundTranscription.retentionDays).toBe(14)
    expect(() => updateAuroraNodeConfigDocumentV2(saved, draft, 1, 300)).toThrow(AuroraNodeConfigRevisionConflictError)
    expect(resolveBackgroundTranscriptionState(saved, ready)).toMatchObject({ ambientRequested: true, recording: false })
    expect(resolveBackgroundTranscriptionState(saved, { ...ready, captureMode: 'ambient' })).toMatchObject({ recording: true })
    expect(resolveBackgroundTranscriptionState(saved, { ...ready, permission: 'denied', captureMode: 'ambient' })).toMatchObject({ recording: false, reason: 'permission_denied' })
    expect(resolveBackgroundTranscriptionState(saved, { ...ready, archiveAvailable: false, captureMode: 'ambient' })).toMatchObject({ recording: false, reason: 'storage_unavailable' })
  })

  it('keeps unsupported continuous capture separate from a retained preference', () => {
    const current = emptyAuroraNodeConfigDocumentV2(100)
    current.backgroundTranscription = { ...current.backgroundTranscription, enabled: true, ambient: true }
    expect(resolveBackgroundTranscriptionState(current, { ...ready, capability: 'foreground_only', captureMode: 'ambient' })).toMatchObject({
      ambientRequested: true, capability: 'foreground_only', canStartAmbient: false, recording: false, reason: 'unsupported'
    })
    expect(resolveBackgroundTranscriptionState(current, { ...ready, capability: 'foreground_only', foreground: false, captureMode: 'ambient' })).toMatchObject({ recording: false, reason: 'unsupported' })
    current.backgroundTranscription = { ...current.backgroundTranscription, ambient: false, notification: true }
    expect(resolveBackgroundTranscriptionState(current, { ...ready, capability: 'foreground_only', captureMode: 'notification' })).toMatchObject({ canStartNotification: true, recording: true })
    expect(resolveBackgroundTranscriptionState(current, { ...ready, capability: 'foreground_only', foreground: false, captureMode: 'notification' })).toMatchObject({ recording: false, reason: 'foreground_required' })
  })

  it('rejects invalid or runtime-shaped saved policies', () => {
    const current = emptyAuroraNodeConfigDocumentV2(100)
    for (const invalid of [{ retentionDays: 0 }, { retentionDays: 1.5 }, { enabled: 'true' }, { language: 'x'.repeat(65) }, { recording: true }]) {
      expect(() => sanitizeAuroraNodeConfigDocumentV2({ ...current, backgroundTranscription: { ...current.backgroundTranscription, ...invalid } })).toThrow()
    }
  })
})

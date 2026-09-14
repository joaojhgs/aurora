import type {
  ConversationMessageRecord,
  ConversationRecord,
  EncryptedDataEnvelopeV1,
  LightweightMemoryRecord,
  LocalAuditRecord,
  LocalToolStateRecord,
  PeerGrantMetadataRecord,
  TranscriptSegmentRecord,
  TranscriptSessionRecord
} from '../../src/local-data/index.js'

export const envelopeFixture: EncryptedDataEnvelopeV1 = Object.freeze({
  version: 1,
  algorithm: 'AES-GCM-256',
  keyId: 'key-local-structured-data-1',
  nonceB64Url: 'AAAAAAAAAAAAAAAA',
  ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
  createdAtMs: 1000
})

export function conversationFixture(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'conversation-1',
    profileId: 'profile-1',
    localNodeId: 'node-1',
    titleEnvelope: envelopeFixture,
    createdAtMs: 1000,
    updatedAtMs: 1100,
    archivedAtMs: null,
    ...overrides
  }
}

export function messageFixture(overrides: Partial<ConversationMessageRecord> = {}): ConversationMessageRecord {
  return {
    id: 'message-1',
    conversationId: 'conversation-1',
    sequence: 0,
    role: 'user',
    contentEnvelope: envelopeFixture,
    toolEnvelope: null,
    status: 'complete',
    createdAtMs: 1200,
    ...overrides
  }
}

export function memoryFixture(overrides: Partial<LightweightMemoryRecord> = {}): LightweightMemoryRecord {
  return {
    id: 'memory-1',
    profileId: 'profile-1',
    localNodeId: 'node-1',
    namespace: 'notes',
    payloadEnvelope: envelopeFixture,
    sourceType: 'conversation',
    sourceId: 'conversation-1',
    createdAtMs: 1300,
    updatedAtMs: 1400,
    expiresAtMs: null,
    ...overrides
  }
}

export function localToolStateFixture(overrides: Partial<LocalToolStateRecord> = {}): LocalToolStateRecord {
  return {
    profileId: 'profile-1',
    localNodeId: 'node-1',
    toolContractId: 'aurora.local.native.share_text.v1',
    descriptorJson: { name: 'Share text', input_schema: { type: 'object' } },
    descriptorHash: 'a'.repeat(64),
    enabled: false,
    settingsEnvelope: envelopeFixture,
    revision: 0,
    updatedAtMs: 1500,
    ...overrides
  }
}

export function peerGrantFixture(overrides: Partial<PeerGrantMetadataRecord> = {}): PeerGrantMetadataRecord {
  return {
    grantId: 'grant-1',
    profileId: 'profile-1',
    localNodeId: 'node-1',
    claimantPeerId: 'peer-1',
    tokenId: 'token-1',
    scopeEnvelope: envelopeFixture,
    revision: 0,
    createdAtMs: 1600,
    expiresAtMs: null,
    revokedAtMs: null,
    ...overrides
  }
}

export function auditFixture(overrides: Partial<LocalAuditRecord> = {}): LocalAuditRecord {
  return {
    id: 'audit-1',
    profileId: 'profile-1',
    localNodeId: 'node-1',
    peerId: 'peer-1',
    action: 'grant.check',
    decision: 'allow',
    resultStatus: 'complete',
    connectionEpoch: 'epoch-1',
    methodId: null,
    toolContractId: 'aurora.local.native.share_text.v1',
    correlationId: 'corr-1',
    redactedDetailJson: { secretsRedacted: true },
    createdAtMs: 1700,
    ...overrides
  }
}

export function transcriptSessionFixture(overrides: Partial<TranscriptSessionRecord> = {}): TranscriptSessionRecord {
  return {
    id: 'transcript-session-1',
    profileId: 'profile-1',
    localNodeId: 'node-1',
    captureMode: 'ambient',
    createdAtMs: 1000,
    startedAtMs: 1000,
    endedAtMs: null,
    lifecycle: 'active',
    terminalReason: null,
    expiresAtMs: 10_000,
    language: 'en-US',
    modelProvenance: { provider: 'local', modelId: 'aurora-stt', version: '1' },
    diarizationState: 'not_requested',
    ...overrides
  }
}

export function transcriptSegmentFixture(overrides: Partial<TranscriptSegmentRecord> = {}): TranscriptSegmentRecord {
  return {
    id: 'transcript-segment-1',
    sessionId: 'transcript-session-1',
    sequence: 0,
    startAtMs: 1000,
    endAtMs: 1500,
    textEnvelope: envelopeFixture,
    confidence: 0.95,
    speakerId: null,
    speakerLabel: null,
    createdAtMs: 1500,
    ...overrides
  }
}

import { describe, expect, it } from 'vitest'
import {
  buildLocalDataExportV1,
  localDataMigrationManifest,
  type ConversationMessageRecord,
  type ConversationRecord,
  type EncryptedDataEnvelopeV1,
  type LightweightMemoryRecord,
  type LocalAuditRecord,
  type LocalToolStateRecord,
  type PeerGrantMetadataRecord
} from '@aurora/client/local-data'

import {
  BrowserIndexedDbLocalDataBackend,
  BrowserIndexedDbLocalDataSession,
  deriveBrowserLocalDataDatabaseName,
  type StoredBrowserLocalDataDocument
} from './browser-indexeddb'
import {
  MapBrowserLocalDataDocumentStore,
  MapBrowserStorageLeaseStore
} from './__tests__/local-data-test-helpers'

const envelopeFixture: EncryptedDataEnvelopeV1 = Object.freeze({
  version: 1,
  algorithm: 'AES-GCM-256',
  keyId: 'key-local-structured-data-1',
  nonceB64Url: 'AAAAAAAAAAAAAAAA',
  ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
  createdAtMs: 1000
})

describe('BrowserIndexedDbLocalDataBackend', () => {
  it('opens fresh storage, reopens persisted records, and upgrades empty older state', async () => {
    const store = new MapBrowserLocalDataDocumentStore()
    const leases = new MapBrowserStorageLeaseStore()
    const first = await openSession(store, leases)
    await first.memory.upsertMemoryItem(memoryFixture())
    await expect(first.exportV1()).resolves.toMatchObject({
      sourceBackend: 'indexeddb',
      schemaVersion: localDataMigrationManifest.latestVersion,
      recordCounts: { memoryItems: 1 }
    })
    await first.close()

    const reopened = await openSession(store, leases)
    await expect(reopened.memory.listMemoryItems()).resolves.toEqual([memoryFixture()])
    await reopened.close()

    const oldEmpty = new MapBrowserLocalDataDocumentStore({
      formatVersion: 1,
      profileId: 'profile-1',
      localNodeId: 'node-1',
      schemaVersion: 1,
      migrationLedger: [],
      records: emptyRecords()
    })
    const upgraded = await openSession(oldEmpty, leases, 'owner-upgrade')
    expect((await upgraded.exportV1()).schemaVersion).toBe(localDataMigrationManifest.latestVersion)
    await upgraded.close()
  })

  it('stores all repository fixtures, sorts reads, and exposes no arbitrary SQL API', async () => {
    const session = await openSession()

    expect(Object.keys(session).join(' ').toLowerCase()).not.toContain('sql')
    await session.conversations.upsertConversation(conversationFixture({ id: 'conversation-2', updatedAtMs: 1200 }))
    await session.conversations.upsertConversation(conversationFixture())
    await session.conversations.appendMessage(messageFixture({ id: 'message-2', sequence: 1 }))
    await session.conversations.appendMessage(messageFixture({ id: 'message-1', sequence: 0 }))
    await session.memory.upsertMemoryItem(memoryFixture())
    await session.localTools.upsertLocalToolState(localToolStateFixture())
    await session.peerGrants.upsertPeerGrant(peerGrantFixture())
    await session.localAudit.appendAudit(auditFixture())

    await expect(session.conversations.listConversations()).resolves.toEqual([
      conversationFixture({ id: 'conversation-2', updatedAtMs: 1200 }),
      conversationFixture()
    ])
    await expect(session.conversations.listMessages('conversation-1')).resolves.toEqual([
      messageFixture({ id: 'message-1', sequence: 0 }),
      messageFixture({ id: 'message-2', sequence: 1 })
    ])
    await expect(session.memory.listMemoryItems('notes')).resolves.toEqual([memoryFixture()])
    await expect(session.localTools.listLocalToolStates()).resolves.toEqual([localToolStateFixture()])
    await expect(session.peerGrants.listPeerGrants()).resolves.toEqual([peerGrantFixture()])
    await expect(session.localAudit.listAudit()).resolves.toEqual([auditFixture()])
  })

  it('rolls back failed transactions and rejects leaked transaction repositories', async () => {
    const session = await openSession()
    await session.conversations.upsertConversation(conversationFixture())

    await expect(session.transaction(async (repositories) => {
      await repositories.memory.upsertMemoryItem(memoryFixture({ id: 'memory-rollback' }))
      throw new Error('rollback current transaction')
    })).rejects.toThrow(/rollback current transaction/u)
    await expect(session.memory.listMemoryItems()).resolves.toEqual([])

    let leaked: typeof session | undefined
    await session.transaction(async (repositories) => {
      leaked = repositories as typeof session
      await repositories.memory.upsertMemoryItem(memoryFixture({ id: 'memory-committed' }))
    })
    await expect(leaked?.memory.upsertMemoryItem(memoryFixture({ id: 'memory-leaked' }))).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { boundaryId: 'transaction.scope', validation: 'redacted' }
    })
  })

  it('verifies export/import hashes and rejects tamper, future schema, FK, and identity failures without mutation', async () => {
    const session = await openSession()
    await session.conversations.upsertConversation(conversationFixture())
    await session.conversations.appendMessage(messageFixture())
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-original' }))
    const exported = await session.exportV1()

    await expect(session.importV1({
      ...exported,
      recordCounts: { ...exported.recordCounts, memoryItems: 99 }
    })).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'record_count_mismatch' }
    })
    await expect(session.importV1({ ...exported, schemaVersion: localDataMigrationManifest.latestVersion + 1 })).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'future_schema' }
    })
    await expect(session.importV1(buildLocalDataExportV1({
      sourceBackend: 'memory',
      schemaVersion: exported.schemaVersion,
      profileId: exported.profileId,
      localNodeId: exported.localNodeId,
      exportedAtMs: exported.exportedAtMs,
      records: { ...exported.records, messages: [messageFixture({ conversationId: 'missing-conversation' })] }
    }))).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'message_conversation_missing' }
    })
    await expect(session.importV1(buildLocalDataExportV1({
      sourceBackend: 'memory',
      schemaVersion: exported.schemaVersion,
      profileId: 'profile-2',
      localNodeId: exported.localNodeId,
      exportedAtMs: exported.exportedAtMs,
      records: {
        ...emptyRecords(),
        memoryItems: [memoryFixture({ id: 'memory-bad', profileId: 'profile-2' })]
      }
    }))).rejects.toMatchObject({ code: 'identity_mismatch' })
    await expect(session.memory.listMemoryItems()).resolves.toEqual([memoryFixture({ id: 'memory-original' })])
  })

  it('clears durable records and rejects hostile IDs or oversized values', async () => {
    const session = await openSession()
    await session.memory.upsertMemoryItem(memoryFixture())
    await session.clear()
    await expect(session.memory.listMemoryItems()).resolves.toEqual([])
    await expect(session.memory.upsertMemoryItem(memoryFixture({ id: '../python/service.db' }))).rejects.toMatchObject({
      code: 'invalid_record'
    })
    await expect(session.localTools.upsertLocalToolState(localToolStateFixture({
      descriptorJson: { unsafe: 'x'.repeat(70 * 1024) }
    }))).rejects.toMatchObject({
      code: 'invalid_record'
    })
  })

  it('rejects future stored versions, different-node data, and partial upgrades without mutation', async () => {
    const nonempty = {
      ...storedDocument('profile-1', 'node-1'),
      records: { ...emptyRecords(), memoryItems: [memoryFixture()] }
    }
    await expect(openSession(new MapBrowserLocalDataDocumentStore({
      ...nonempty,
      schemaVersion: localDataMigrationManifest.latestVersion + 1
    }))).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'future_schema' }
    })
    await expect(openSession(new MapBrowserLocalDataDocumentStore({
      ...nonempty,
      records: { ...emptyRecords(), memoryItems: [memoryFixture({ localNodeId: 'node-2' })] }
    }), undefined, 'owner-2')).rejects.toMatchObject({
      code: 'identity_mismatch',
      metadata: { reason: 'local_node_owner_mismatch' }
    })
    await expect(openSession(new MapBrowserLocalDataDocumentStore({
      ...nonempty,
      schemaVersion: 1,
      migrationLedger: [storedDocument('profile-1', 'node-1').migrationLedger[0] ?? { version: 1, checksum: 'a'.repeat(64) }]
    }), undefined, 'owner-3')).rejects.toMatchObject({
      code: 'migration_integrity',
      metadata: { reason: 'partial_upgrade_requires_reset' }
    })
  })

  it('shares one physical document across profiles for the same local node while preserving scoped records', async () => {
    const leases = new MapBrowserStorageLeaseStore()
    const store = new MapBrowserLocalDataDocumentStore()
    const first = await openSession(store, leases, 'owner-1', 'profile-1', 'node-1')
    await first.conversations.upsertConversation(conversationFixture({ id: 'conversation-profile-1' }))
    await first.conversations.appendMessage(messageFixture({ id: 'message-profile-1', conversationId: 'conversation-profile-1' }))
    await first.memory.upsertMemoryItem(memoryFixture({ id: 'memory-profile-1' }))
    await first.close()

    const second = await openSession(store, leases, 'owner-2', 'profile-2', 'node-1')
    await expect(second.memory.listMemoryItems()).resolves.toEqual([])
    await second.conversations.upsertConversation(conversationFixture({
      id: 'conversation-profile-2',
      profileId: 'profile-2'
    }))
    await second.conversations.appendMessage(messageFixture({
      id: 'message-profile-2',
      conversationId: 'conversation-profile-2'
    }))
    await second.memory.upsertMemoryItem(memoryFixture({
      id: 'memory-profile-2',
      profileId: 'profile-2'
    }))
    const exportedSecond = await second.exportV1()
    expect(exportedSecond.recordCounts).toMatchObject({ conversations: 1, messages: 1, memoryItems: 1 })
    await second.clear()
    await expect(second.memory.listMemoryItems()).resolves.toEqual([])
    await second.close()

    const reopenedFirst = await openSession(store, leases, 'owner-3', 'profile-1', 'node-1')
    await expect(reopenedFirst.memory.listMemoryItems()).resolves.toEqual([memoryFixture({ id: 'memory-profile-1' })])
    await expect(reopenedFirst.conversations.listMessages('conversation-profile-2')).resolves.toEqual([])
    await reopenedFirst.close()
  })

  it('rejects same-node different-profile global ID collisions without changing the first profile records', async () => {
    const leases = new MapBrowserStorageLeaseStore()
    const store = new MapBrowserLocalDataDocumentStore()
    const first = await openSession(store, leases, 'owner-1', 'profile-1', 'node-1')
    await first.conversations.upsertConversation(conversationFixture())
    await first.conversations.appendMessage(messageFixture())
    await first.memory.upsertMemoryItem(memoryFixture())
    await first.localTools.upsertLocalToolState(localToolStateFixture())
    await first.peerGrants.upsertPeerGrant(peerGrantFixture())
    await first.localAudit.appendAudit(auditFixture())
    const firstExportBefore = await first.exportV1()
    await first.close()

    const second = await openSession(store, leases, 'owner-2', 'profile-2', 'node-1')
    await expect(second.conversations.upsertConversation(conversationFixture({ profileId: 'profile-2' }))).rejects.toMatchObject({
      code: 'identity_mismatch',
      metadata: { reason: 'profile_scope_collision' }
    })
    await second.conversations.upsertConversation(conversationFixture({ id: 'conversation-profile-2', profileId: 'profile-2' }))
    await expect(second.conversations.appendMessage(messageFixture({
      conversationId: 'conversation-profile-2'
    }))).rejects.toMatchObject({
      code: 'identity_mismatch',
      metadata: { reason: 'profile_scope_collision' }
    })
    await expect(second.memory.upsertMemoryItem(memoryFixture({ profileId: 'profile-2' }))).rejects.toMatchObject({
      code: 'identity_mismatch',
      metadata: { reason: 'profile_scope_collision' }
    })
    await second.localTools.upsertLocalToolState(localToolStateFixture({ profileId: 'profile-2', enabled: true }))
    await expect(second.peerGrants.upsertPeerGrant(peerGrantFixture({ profileId: 'profile-2' }))).rejects.toMatchObject({
      code: 'identity_mismatch',
      metadata: { reason: 'profile_scope_collision' }
    })
    await expect(second.localAudit.appendAudit(auditFixture({ profileId: 'profile-2' }))).rejects.toMatchObject({
      code: 'identity_mismatch',
      metadata: { reason: 'profile_scope_collision' }
    })
    await expect(second.importV1(buildLocalDataExportV1({
      sourceBackend: 'memory',
      schemaVersion: localDataMigrationManifest.latestVersion,
      profileId: 'profile-2',
      localNodeId: 'node-1',
      exportedAtMs: 2000,
      records: {
        ...emptyRecords(),
        memoryItems: [memoryFixture({ profileId: 'profile-2' })]
      }
    }))).rejects.toMatchObject({
      code: 'identity_mismatch',
      metadata: { reason: 'profile_scope_collision' }
    })
    const secondExport = await second.exportV1()
    expect(secondExport.recordCounts).toMatchObject({
      conversations: 1,
      messages: 0,
      memoryItems: 0,
      localToolStates: 1,
      peerGrantMetadata: 0,
      localAudit: 0
    })
    await second.close()

    const reopenedFirst = await openSession(store, leases, 'owner-3', 'profile-1', 'node-1')
    expect(await reopenedFirst.exportV1()).toMatchObject({
      records: firstExportBefore.records,
      collectionHashes: firstExportBefore.collectionHashes,
      recordCounts: firstExportBefore.recordCounts
    })
    await reopenedFirst.close()
  })

  it('contends same stable identity across different profiles and isolates distinct identities', async () => {
    const leases = new MapBrowserStorageLeaseStore()
    const store = new MapBrowserLocalDataDocumentStore()
    const first = await openSession(store, leases, 'owner-1', 'profile-1', 'node-1')
    await expect(openSession(store, leases, 'owner-2', 'profile-2', 'node-1')).rejects.toMatchObject({
      code: 'unsupported_backend',
      metadata: { reason: 'owner_exists' }
    })
    const distinct = await openSession(new MapBrowserLocalDataDocumentStore(), leases, 'owner-3', 'profile-2', 'node-2')

    await distinct.memory.upsertMemoryItem(memoryFixture({ id: 'memory-node-2', profileId: 'profile-2', localNodeId: 'node-2' }))
    await expect(first.memory.listMemoryItems()).resolves.toEqual([])
    await expect(distinct.memory.listMemoryItems()).resolves.toHaveLength(1)
    await first.close()
    await distinct.close()
  })

  it('fails writes after lease ownership is lost instead of opening a writable fallback', async () => {
    let now = 1_000
    const leases = new MapBrowserStorageLeaseStore()
    const store = new MapBrowserLocalDataDocumentStore()
    const first = await openSession(store, leases, 'owner-1', 'profile-1', 'node-1', () => now, 100)
    now = 1_200
    const second = await openSession(store, leases, 'owner-2', 'profile-1', 'node-1', () => now, 100)

    await expect(first.memory.upsertMemoryItem(memoryFixture({ id: 'memory-lost' }))).rejects.toMatchObject({
      code: 'unsupported_backend',
      metadata: { reason: 'lease_lost' }
    })
    await second.memory.upsertMemoryItem(memoryFixture({ id: 'memory-owner-2' }))
    await expect(second.memory.listMemoryItems()).resolves.toEqual([memoryFixture({ id: 'memory-owner-2' })])
    await second.close()
  })

  it('derives the physical database name from origin and local-node identity only', () => {
    expect(deriveBrowserLocalDataDatabaseName('https://aurora.example.test/a', 'node-1'))
      .toBe(deriveBrowserLocalDataDatabaseName('https://aurora.example.test/b', 'node-1'))
    expect(deriveBrowserLocalDataDatabaseName('https://aurora.example.test', 'node-1'))
      .not.toContain('profile')
  })
})

async function openSession(
  store: MapBrowserLocalDataDocumentStore = new MapBrowserLocalDataDocumentStore(),
  leases: MapBrowserStorageLeaseStore = new MapBrowserStorageLeaseStore(),
  ownerId = 'owner-1',
  profileId = 'profile-1',
  localNodeId = 'node-1',
  nowMs: () => number = () => 10_000,
  leaseDurationMs = 5_000,
): Promise<BrowserIndexedDbLocalDataSession> {
  const backend = new BrowserIndexedDbLocalDataBackend({
    origin: 'https://aurora.example.test',
    documentStore: store,
    leaseStore: leases,
    locks: null,
    ownerId,
    nowMs,
    leaseDurationMs
  })
  return await backend.open(profileId, localNodeId) as BrowserIndexedDbLocalDataSession
}

function storedDocument(profileId: string, localNodeId: string): StoredBrowserLocalDataDocument {
  return {
    formatVersion: 1,
    profileId,
    localNodeId,
    schemaVersion: localDataMigrationManifest.latestVersion,
    migrationLedger: localDataMigrationManifest.migrations.map((migration) => ({
      version: migration.version,
      checksum: migration.checksum
    })),
    records: emptyRecords()
  }
}

function emptyRecords(): StoredBrowserLocalDataDocument['records'] {
  return {
    conversations: [],
    messages: [],
    memoryItems: [],
    localToolStates: [],
    peerGrantMetadata: [],
    localAudit: []
  }
}

function conversationFixture(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
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

function messageFixture(overrides: Partial<ConversationMessageRecord> = {}): ConversationMessageRecord {
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

function memoryFixture(overrides: Partial<LightweightMemoryRecord> = {}): LightweightMemoryRecord {
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

function localToolStateFixture(overrides: Partial<LocalToolStateRecord> = {}): LocalToolStateRecord {
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

function peerGrantFixture(overrides: Partial<PeerGrantMetadataRecord> = {}): PeerGrantMetadataRecord {
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

function auditFixture(overrides: Partial<LocalAuditRecord> = {}): LocalAuditRecord {
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

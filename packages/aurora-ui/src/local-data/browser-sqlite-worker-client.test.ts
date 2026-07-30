import { describe, expect, it, vi } from 'vitest'

import {
  localDataMigrationManifest,
  LocalDataError,
  MemoryLocalDataBackend,
  type ConversationMessageRecord,
  type ConversationRecord,
  type LightweightMemoryRecord,
  type LocalAuditRecord,
  type LocalDataBackend,
  type LocalDataSession,
  type LocalToolStateRecord,
  type PeerGrantMetadataRecord
} from '@aurora/client/local-data'

import { createLocalDataBackend } from './create-local-data-backend.js'
import { browserSqliteMigrationSql, BrowserSqliteLocalDataBackend, BrowserSqliteWorkerClient, type BrowserSqliteProtocolWorker } from './browser-sqlite-worker-client.js'
import { sha256Hex } from './browser-sqlite-opfs.js'
import type { BrowserSqliteOwnership, BrowserSqliteOwnershipLock } from './browser-sqlite-opfs.js'
import type { BrowserSqliteRepositoryOperation, BrowserSqliteWorkerRequest, BrowserSqliteWorkerResponse } from './browser-sqlite-worker.js'

describe('browser sqlite worker client backend', () => {
  it('ships migration SQL bytes that match the immutable SDK manifest', () => {
    for (const migration of localDataMigrationManifest.migrations) {
      const sql = browserSqliteMigrationSql.find((entry) => entry.version === migration.version)?.sql
      expect(sql).toBeDefined()
      expect(sha256Hex(sql ?? '')).toBe(migration.checksum)
      expect(sha256Hex(`${sql ?? ''} `)).not.toBe(migration.checksum)
    }
  })

  it('stores repository fixtures through the private typed worker protocol', async () => {
    installBrowserStorageProbe()
    const fakeWorker = new MemoryProtocolWorker()
    const backend = new BrowserSqliteLocalDataBackend({
      createWorker: () => fakeWorker,
      lock: new GrantedLock(),
      timeoutMs: 1000,
      wasmAssetUrl: 'http://127.0.0.1/sqlite3.wasm'
    })
    const session = await backend.open('profile-1', 'node-1')

    await session.conversations.upsertConversation(conversationFixture())
    await session.conversations.appendMessage(messageFixture())
    await session.memory.upsertMemoryItem(memoryFixture())
    await session.localTools.upsertLocalToolState(localToolStateFixture())
    await session.peerGrants.upsertPeerGrant(peerGrantFixture())
    await session.localAudit.appendAudit(auditFixture())

    await expect(session.conversations.listConversations()).resolves.toEqual([conversationFixture()])
    await expect(session.conversations.listMessages('conversation-1')).resolves.toEqual([messageFixture()])
    await expect(session.memory.listMemoryItems('notes')).resolves.toEqual([memoryFixture()])
    await expect(session.localTools.listLocalToolStates()).resolves.toEqual([localToolStateFixture()])
    await expect(session.peerGrants.listPeerGrants()).resolves.toEqual([peerGrantFixture()])
    await expect(session.localAudit.listAudit()).resolves.toEqual([auditFixture()])
    expect(JSON.stringify(fakeWorker.messages).toLowerCase()).not.toContain('select ')
    await backend.close()
  })

  it('forwards observable delete repository operations through the typed worker protocol', async () => {
    installBrowserStorageProbe()
    const fakeWorker = new MemoryProtocolWorker()
    const backend = new BrowserSqliteLocalDataBackend({
      createWorker: () => fakeWorker,
      lock: new GrantedLock(),
      timeoutMs: 1000,
      wasmAssetUrl: 'http://127.0.0.1/sqlite3.wasm'
    })
    const session = await backend.open('profile-1', 'node-1')
    await session.conversations.upsertConversation(conversationFixture())
    await session.conversations.appendMessage(messageFixture({ id: 'message-1', sequence: 0 }))
    await session.conversations.appendMessage(messageFixture({ id: 'message-2', sequence: 1 }))
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-old', expiresAtMs: 900 }))
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-a', expiresAtMs: 1000 }))
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-b', expiresAtMs: 1000 }))
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-live', expiresAtMs: null }))

    await expect(session.conversations.deleteConversation('conversation-1')).resolves.toEqual({
      deleted: true,
      deletedMessages: 2
    })
    await expect(session.conversations.listMessages('conversation-1')).resolves.toEqual([])
    await expect(session.memory.deleteMemoryItem('memory-live')).resolves.toEqual({ deleted: true })
    await expect(session.memory.deleteExpiredMemoryItems({ profileId: 'profile-1', localNodeId: 'node-1' }, 1000, 2)).resolves.toEqual({ deleted: 2 })
    await expect(session.memory.listMemoryItems()).resolves.toEqual([
      memoryFixture({ id: 'memory-b', expiresAtMs: 1000 })
    ])
    expect(fakeWorker.messages.filter((message) => message.command === 'repo').map((message) => message.operation.kind)).toContain('conversations.deleteConversation')
    expect(fakeWorker.messages.filter((message) => message.command === 'repo').map((message) => message.operation.kind)).toContain('memory.deleteExpiredMemoryItems')
    await backend.close()
  })

  it('rolls back failed transactions and rejects oversized worker messages', async () => {
    installBrowserStorageProbe()
    const backend = new BrowserSqliteLocalDataBackend({
      createWorker: () => new MemoryProtocolWorker(),
      lock: new GrantedLock(),
      timeoutMs: 1000,
      wasmAssetUrl: 'http://127.0.0.1/sqlite3.wasm'
    })
    const session = await backend.open('profile-1', 'node-1')
    await expect(session.transaction(async (repositories) => {
      await repositories.memory.upsertMemoryItem(memoryFixture({ id: 'memory-rollback' }))
      throw new Error('rollback')
    })).rejects.toThrow(/rollback/u)
    await expect(session.memory.listMemoryItems()).resolves.toEqual([])

    const directClient = new BrowserSqliteWorkerClient(new MemoryProtocolWorker(), {
      timeoutMs: 1000,
      ownership: { key: 'owned', ownerId: 'owner-1', release: async () => undefined }
    })
    await expect(directClient.repositoryOperation({
      kind: 'memory.upsertMemoryItem',
      record: {
        ...memoryFixture(),
        payloadEnvelope: {
          ...envelopeFixture,
          ciphertextAndTagB64Url: 'A'.repeat(3 * 1024 * 1024)
        }
      }
    } as BrowserSqliteRepositoryOperation)).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'message_too_large' }
    })
    await backend.close()
  })

  it('selects the injected IndexedDB backend when SQLite probing fails without deleting source data', async () => {
    installBrowserStorageProbe()
    const health: unknown[] = []
    const indexedDbBackend = new MemoryLocalDataBackend()
    const backend = await createLocalDataBackend('profile-1', 'node-1', {
      indexedDbBackend,
      lock: new DeniedLock(),
      createWorker: () => new MemoryProtocolWorker(),
      wasmAssetUrl: 'http://127.0.0.1/sqlite3.wasm',
      onStorageHealth: (status) => health.push(status)
    })

    expect(backend).toBe(indexedDbBackend)
    expect(health).toEqual([{
      selectedBackend: 'memory',
      sqliteAttempted: true,
      sqliteAvailable: false,
      fallbackReason: 'ownership_unavailable'
    }])
    const session = await backend.open('profile-1', 'node-1')
    await session.memory.upsertMemoryItem(memoryFixture())
    await expect(session.memory.listMemoryItems()).resolves.toEqual([memoryFixture()])
  })
})

function installBrowserStorageProbe(): void {
  vi.stubGlobal('location', {
    href: 'http://127.0.0.1/',
    origin: 'http://127.0.0.1'
  })
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({}),
      persist: async () => true
    }
  })
}

class GrantedLock implements BrowserSqliteOwnershipLock {
  async acquire(key: string): Promise<BrowserSqliteOwnership> {
    return { key, ownerId: 'owner-1', release: async () => undefined }
  }
}

class DeniedLock implements BrowserSqliteOwnershipLock {
  async acquire(): Promise<BrowserSqliteOwnership> {
    throw new Error('busy')
  }
}

class MemoryProtocolWorker implements BrowserSqliteProtocolWorker {
  onmessage: ((event: MessageEvent<BrowserSqliteWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly messages: BrowserSqliteWorkerRequest[] = []
  private backend: LocalDataBackend = new MemoryLocalDataBackend()
  private session: LocalDataSession | null = null
  private snapshot: Awaited<ReturnType<LocalDataSession['exportV1']>> | null = null

  postMessage(message: BrowserSqliteWorkerRequest): void {
    this.messages.push(message)
    void this.handle(message).then(
      (value) => this.onmessage?.({ data: { id: message.id, result: { ok: true, value } } } as MessageEvent<BrowserSqliteWorkerResponse>),
      (error: unknown) => this.onmessage?.({ data: { id: message.id, result: { ok: false, error: redact(error) } } } as MessageEvent<BrowserSqliteWorkerResponse>)
    )
  }

  terminate(): void {}

  private async handle(message: BrowserSqliteWorkerRequest): Promise<unknown> {
    switch (message.command) {
      case 'open':
        this.session = await this.backend.open(message.profileId, message.localNodeId)
        return { kind: 'sqlite-wasm-opfs', persistent: true, sqlite: true, profileId: message.profileId, schemaVersion: 3, migrationState: 'idle' }
      case 'status':
        return { kind: 'sqlite-wasm-opfs', persistent: true, sqlite: true, profileId: this.session?.profileId ?? null, schemaVersion: 3, migrationState: 'idle' }
      case 'close':
        await this.session?.close()
        return { closed: true }
      case 'beginTransaction':
        this.snapshot = await this.requireSession().exportV1()
        return { txId: message.txId }
      case 'commitTransaction':
        this.snapshot = null
        return { committed: true }
      case 'rollbackTransaction':
        if (this.snapshot !== null) await this.requireSession().importV1(this.snapshot)
        this.snapshot = null
        return { rolledBack: true }
      case 'repo':
        return await this.runRepositoryOperation(message.operation)
      case 'exportV1':
        return await this.requireSession().exportV1()
      case 'importV1':
        return await this.requireSession().importV1(message.document)
      case 'cancel':
        return { cancelled: true }
      default:
        throw new LocalDataError('invalid_record', 'Unsupported command', { reason: 'unknown_command' })
    }
  }

  private async runRepositoryOperation(operation: BrowserSqliteRepositoryOperation): Promise<unknown> {
    const session = this.requireSession()
    switch (operation.kind) {
      case 'conversations.upsertConversation':
        return await session.conversations.upsertConversation(operation.record)
      case 'conversations.appendMessage':
        return await session.conversations.appendMessage(operation.record)
      case 'conversations.deleteConversation':
        return await session.conversations.deleteConversation(operation.conversationId)
      case 'conversations.listConversations':
        return await session.conversations.listConversations()
      case 'conversations.listMessages':
        return await session.conversations.listMessages(operation.conversationId)
      case 'memory.upsertMemoryItem':
        return await session.memory.upsertMemoryItem(operation.record)
      case 'memory.deleteMemoryItem':
        return await session.memory.deleteMemoryItem(operation.memoryItemId)
      case 'memory.deleteExpiredMemoryItems':
        return await session.memory.deleteExpiredMemoryItems(operation.scope, operation.nowMs, operation.limit)
      case 'memory.listMemoryItems':
        return await session.memory.listMemoryItems(operation.namespace)
      case 'localTools.upsertLocalToolState':
        return await session.localTools.upsertLocalToolState(operation.record)
      case 'localTools.listLocalToolStates':
        return await session.localTools.listLocalToolStates()
      case 'peerGrants.upsertPeerGrant':
        return await session.peerGrants.upsertPeerGrant(operation.record)
      case 'peerGrants.listPeerGrants':
        return await session.peerGrants.listPeerGrants()
      case 'localAudit.appendAudit':
        return await session.localAudit.appendAudit(operation.record)
      case 'localAudit.listAudit':
        return await session.localAudit.listAudit()
    }
  }

  private requireSession(): LocalDataSession {
    if (this.session === null) throw new LocalDataError('session_closed', 'session closed')
    return this.session
  }
}

function redact(error: unknown): { code: string; message: string; metadata?: { reason?: string } } {
  if (error instanceof LocalDataError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.metadata?.reason === undefined ? {} : { metadata: { reason: error.metadata.reason } })
    }
  }
  return { code: 'unsupported_backend', message: 'failed' }
}

const envelopeFixture = Object.freeze({
  version: 1 as const,
  algorithm: 'AES-GCM-256' as const,
  keyId: 'key-local-structured-data-1',
  nonceB64Url: 'AAAAAAAAAAAAAAAA',
  ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
  createdAtMs: 1000
})

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
    role: 'user' as const,
    contentEnvelope: envelopeFixture,
    toolEnvelope: null,
    status: 'complete' as const,
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

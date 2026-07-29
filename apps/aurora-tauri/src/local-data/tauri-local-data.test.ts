import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildEnvelopeAad,
  type ConversationMessageRecord,
  type ConversationRecord,
  type LightweightMemoryRecord,
  type LocalAuditRecord,
  type LocalDataRepositories,
  type LocalToolStateRecord,
  type PeerGrantMetadataRecord
} from '../../../../packages/aurora-sdk/src/local-data/index.js'

import { TauriEnvelopeCryptoPort } from './tauri-envelope-crypto.js'
import { TauriSqliteLocalDataBackend } from './tauri-sqlite-backend.js'

type RepositoryOperation =
  | { readonly kind: 'conversations.upsertConversation'; readonly record: ConversationRecord }
  | { readonly kind: 'conversations.appendMessage'; readonly record: ConversationMessageRecord }
  | { readonly kind: 'conversations.deleteConversation'; readonly conversationId: string }
  | { readonly kind: 'conversations.listConversations'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'conversations.listMessages'; readonly profileId: string; readonly localNodeId: string; readonly conversationId: string }
  | { readonly kind: 'memory.upsertMemoryItem'; readonly record: LightweightMemoryRecord }
  | { readonly kind: 'memory.deleteMemoryItem'; readonly memoryItemId: string }
  | { readonly kind: 'memory.deleteExpiredMemoryItems'; readonly nowMs: number; readonly limit: number }
  | { readonly kind: 'memory.listMemoryItems'; readonly profileId: string; readonly localNodeId: string; readonly namespace?: string }
  | { readonly kind: 'localTools.upsertLocalToolState'; readonly record: LocalToolStateRecord }
  | { readonly kind: 'localTools.listLocalToolStates'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'peerGrants.upsertPeerGrant'; readonly record: PeerGrantMetadataRecord }
  | { readonly kind: 'peerGrants.listPeerGrants'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'localAudit.appendAudit'; readonly record: LocalAuditRecord }
  | { readonly kind: 'localAudit.listAudit'; readonly profileId: string; readonly localNodeId: string }

type FakeTauriLocalDataSnapshot = {
  readonly conversations: ConversationRecord[]
  readonly messages: ConversationMessageRecord[]
  readonly memory: LightweightMemoryRecord[]
  readonly tools: LocalToolStateRecord[]
  readonly grants: PeerGrantMetadataRecord[]
  readonly audit: LocalAuditRecord[]
}

describe('Tauri local data adapter', () => {
  it('opens native local storage and stores scoped records through typed repository commands', async () => {
    const bridge = new FakeTauriLocalDataBridge()
    const backend = new TauriSqliteLocalDataBackend({ invokeCommand: bridge.invoke })
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
    await expect(backend.open('profile-2', 'node-1')).rejects.toMatchObject({ code: 'identity_mismatch' })

    expect(bridge.calls.map((call) => call.command)).toEqual([
      'aurora_local_data_open',
      'aurora_local_data_repository_operation',
      'aurora_local_data_repository_operation',
      'aurora_local_data_repository_operation',
      'aurora_local_data_repository_operation',
      'aurora_local_data_repository_operation',
      'aurora_local_data_repository_operation',
      'aurora_local_data_repository_operation',
      'aurora_local_data_repository_operation',
      'aurora_local_data_repository_operation',
      'aurora_local_data_repository_operation',
      'aurora_local_data_repository_operation',
      'aurora_local_data_repository_operation'
    ])
    expect(JSON.stringify(bridge.calls)).not.toMatch(/"sql"|rawSql|executeSql|sqlite:|python/iu)
    await backend.close()
    expect(bridge.closed).toBe(true)
  })

  it('rolls back failed transactions and rejects foreign profile records', async () => {
    const bridge = new FakeTauriLocalDataBridge()
    const session = await new TauriSqliteLocalDataBackend({ invokeCommand: bridge.invoke }).open('profile-1', 'node-1')
    await expect(session.transaction(async (repositories) => {
      await repositories.memory.upsertMemoryItem(memoryFixture({ id: 'rollback-memory' }))
      throw new Error('rollback')
    })).rejects.toThrow(/rollback/u)
    await expect(session.memory.listMemoryItems()).resolves.toEqual([])
    await expect(session.memory.upsertMemoryItem(memoryFixture({ profileId: 'profile-2' }))).rejects.toMatchObject({ code: 'identity_mismatch' })
  })

  it('deletes conversations with scoped cascade counts and keeps foreign-profile rows', async () => {
    const bridge = new FakeTauriLocalDataBridge()
    const session = await new TauriSqliteLocalDataBackend({ invokeCommand: bridge.invoke }).open('profile-1', 'node-1')
    await session.conversations.upsertConversation(conversationFixture())
    await session.conversations.appendMessage(messageFixture({ id: 'message-1', sequence: 0 }))
    await session.conversations.appendMessage(messageFixture({ id: 'message-2', sequence: 1 }))
    bridge.seedForeignProfile({
      conversations: [conversationFixture({ id: 'conversation-foreign', profileId: 'profile-2' })],
      messages: [messageFixture({ id: 'message-foreign', conversationId: 'conversation-foreign' })]
    })

    await expect(session.conversations.deleteConversation('conversation-foreign')).resolves.toEqual({ deleted: false, deletedMessages: 0 })
    await expect(session.conversations.deleteConversation('conversation-1')).resolves.toEqual({ deleted: true, deletedMessages: 2 })
    await expect(session.conversations.listConversations()).resolves.toEqual([])
    expect(bridge.foreignRecords()).toMatchObject({
      conversations: [conversationFixture({ id: 'conversation-foreign', profileId: 'profile-2' })],
      messages: [messageFixture({ id: 'message-foreign', conversationId: 'conversation-foreign' })]
    })
  })

  it('deletes memory through scoped item and deterministic bounded expiry operations', async () => {
    const bridge = new FakeTauriLocalDataBridge()
    const session = await new TauriSqliteLocalDataBackend({ invokeCommand: bridge.invoke }).open('profile-1', 'node-1')
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-live', expiresAtMs: null }))
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-b', expiresAtMs: 500 }))
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-a', expiresAtMs: 500 }))
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-later', expiresAtMs: 900 }))
    bridge.seedForeignProfile({ memory: [memoryFixture({ id: 'memory-foreign', profileId: 'profile-2', expiresAtMs: 1 })] })

    await expect(session.memory.deleteMemoryItem('memory-foreign')).resolves.toEqual({ deleted: false })
    await expect(session.memory.deleteMemoryItem('memory-live')).resolves.toEqual({ deleted: true })
    await expect(session.memory.deleteExpiredMemoryItems(1000, 2)).resolves.toEqual({ deleted: 2 })
    await expect(session.memory.listMemoryItems()).resolves.toEqual([memoryFixture({ id: 'memory-later', expiresAtMs: 900 })])
    expect(bridge.deletedMemoryIds).toEqual(['memory-live', 'memory-a', 'memory-b'])
    expect(bridge.foreignRecords().memory).toEqual([memoryFixture({ id: 'memory-foreign', profileId: 'profile-2', expiresAtMs: 1 })])
  })

  it('rejects malformed expired-memory deletes before mutation', async () => {
    const bridge = new FakeTauriLocalDataBridge()
    const session = await new TauriSqliteLocalDataBackend({ invokeCommand: bridge.invoke }).open('profile-1', 'node-1')
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-expired', expiresAtMs: 1 }))
    const before = await session.memory.listMemoryItems()

    for (const [nowMs, limit] of [
      [Number.NaN, 1],
      [Number.POSITIVE_INFINITY, 1],
      [-1, 1],
      [1.5, 1],
      [1000, 0],
      [1000, Number.MAX_SAFE_INTEGER + 1]
    ] as const) {
      await expect(session.memory.deleteExpiredMemoryItems(nowMs, limit)).rejects.toMatchObject({ code: 'invalid_record' })
      await expect(session.memory.listMemoryItems()).resolves.toEqual(before)
    }
  })

  it('serializes operations, rejects nested transactions, and expires leaked transaction repositories', async () => {
    const bridge = new FakeTauriLocalDataBridge()
    const session = await new TauriSqliteLocalDataBackend({ invokeCommand: bridge.invoke }).open('profile-1', 'node-1')
    const leaked: { repositories?: LocalDataRepositories } = {}
    await expect(session.transaction(async (repositories) => {
      leaked.repositories = repositories
      await expect(session.transaction(async () => undefined)).rejects.toMatchObject({ code: 'invalid_record' })
      await repositories.memory.upsertMemoryItem(memoryFixture({ id: 'tx-memory' }))
    })).resolves.toBeUndefined()
    if (leaked.repositories === undefined) throw new Error('transaction repositories were not captured')
    await expect(leaked.repositories.memory.upsertMemoryItem(memoryFixture({ id: 'late-memory' }))).rejects.toMatchObject({ code: 'invalid_record' })
    await expect(session.memory.listMemoryItems()).resolves.toEqual([memoryFixture({ id: 'tx-memory' })])
    expect(bridge.calls.filter((call) => call.command === 'aurora_local_data_transaction_begin')).toHaveLength(1)
    const txOperation = bridge.calls.find((call) => call.command === 'aurora_local_data_repository_operation' && JSON.stringify(call.args).includes('tx-00000000000000000000000000000001'))
    expect(txOperation).toBeDefined()
  })

  it('keeps SQL and native crypto private to the local-data adapter', () => {
    const repoRoot = resolve(process.cwd(), '../..')
    const sourceRoot = resolve(process.cwd(), 'src/local-data')
    const offenders: string[] = []
    const directInvokeOffenders: string[] = []
    for (const file of walk(sourceRoot)) {
      const rel = relative(process.cwd(), file)
      const source = readFileSync(file, 'utf8')
      if (source.includes('@tauri-apps/plugin-sql')) offenders.push(rel)
      if (source.includes('@tauri-apps/api/core') && rel !== 'src/local-data/tauri-local-data-invoke.ts') directInvokeOffenders.push(rel)
      if (/executeSql|rawSql|python.*db/iu.test(source)) offenders.push(rel)
      for (const match of source.matchAll(/sqlite:[^'"`\s]+/giu)) {
        offenders.push(`${rel}:${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
    expect(directInvokeOffenders).toEqual([])
    const config = readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8')
    expect(config).toContain('"sqlite:aurora-lightweight.db"')
    expect(config).not.toContain('sqlite:aurora.db')
    for (const capabilityFile of [
      'aurora-main.json',
      'aurora-thin.json',
      'aurora-android-thin.json',
      'aurora-ios-thin.json',
      'aurora-ios-baseline.json'
    ]) {
      const capability = readFileSync(resolve(process.cwd(), `src-tauri/capabilities/${capabilityFile}`), 'utf8')
      expect(capability).not.toMatch(/sql:allow-(?:load|select|execute|close)/u)
      expect(capability).toContain('aurora-local-data-storage')
      expect(capability).toContain('aurora-local-data-envelope-crypto')
    }
    const manifestSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/src/lib.rs'), 'utf8')
    const nativeSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/src/local_data_native.rs'), 'utf8')
    expect(manifestSource).not.toContain('add_migrations(LOCAL_DATA_DB_URL, local_data_sql_migrations())')
    expect(nativeSource).toContain('migration.sql')
    expect(nativeSource).toContain('migration.ledger_sql')
    expect(nativeSource).toContain('BEGIN IMMEDIATE;')
    expect(readFileSync(resolve(process.cwd(), 'src-tauri/permissions/aurora-local-data-storage.toml'), 'utf8')).toContain('Raw SQL strings are never accepted from the WebView')
    expect(readFileSync(resolve(process.cwd(), 'src-tauri/permissions/aurora-local-data-envelope-crypto.toml'), 'utf8')).toContain('os_protected_opaque_to_webview')
    expect(manifestSource).not.toMatch(/native.*capabilit.*local_data_envelope/iu)
  })

  it('invokes only narrow native envelope commands and validates shared envelope output', async () => {
    const aad = buildEnvelopeAad({
      table: 'aurora_memory_items',
      recordId: 'memory-1',
      field: 'payloadEnvelope',
      profileId: 'profile-1',
      localNodeId: 'node-1'
    })
    const calls: Array<{ command: string; args: Record<string, unknown> }> = []
    const port = new TauriEnvelopeCryptoPort({
      profileId: 'profile-1',
      localNodeId: 'node-1',
      invokeCommand: async (command, args) => {
        calls.push({ command, args })
        if (command === 'aurora_local_data_envelope_decrypt') return { plaintextB64Url: 'c2VjcmV0' }
        if (command === 'aurora_local_data_envelope_rotate') return { previousKeyId: 'old', newKeyId: 'new' }
        return envelopeFixture
      }
    })

    await expect(port.encrypt('local-structured-data', new TextEncoder().encode('secret'), aad)).resolves.toEqual(envelopeFixture)
    await expect(port.decrypt(envelopeFixture, aad).then((bytes) => Array.from(bytes))).resolves.toEqual(Array.from(new TextEncoder().encode('secret')))
    await expect(port.rotateKey('local-structured-data')).resolves.toEqual({ previousKeyId: 'old', newKeyId: 'new' })
    expect(calls.map((call) => call.command)).toEqual([
      'aurora_local_data_envelope_encrypt',
      'aurora_local_data_envelope_decrypt',
      'aurora_local_data_envelope_rotate'
    ])
    expect(JSON.stringify(calls)).not.toContain('rawKey')
  })

  it('wires Android Keystore and iOS Keychain envelope crypto without raw key output', () => {
    const repoRoot = resolve(process.cwd(), '../..')
    const kotlin = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativePlugin.kt'), 'utf8')
    const swiftPlugin = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraNativePlugin.swift'), 'utf8')
    const swiftStorage = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraThinPeerStorage.swift'), 'utf8')

    for (const command of ['localDataEnvelopeEncrypt', 'localDataEnvelopeDecrypt', 'localDataEnvelopeRotate']) {
      expect(kotlin).toContain(`fun ${command}`)
      expect(swiftPlugin).toContain(`func ${command}`)
    }
    expect(kotlin).toContain('AES/GCM/NoPadding')
    expect(kotlin).toContain('setKeySize(256)')
    expect(kotlin).toContain('cipher.updateAAD')
    expect(kotlin).toContain('LOCAL_DATA_ENVELOPE_KEY_PREFIX')
    expect(swiftStorage).toContain('AES.GCM.seal')
    expect(swiftStorage).toContain('AES.GCM.open')
    expect(swiftStorage).toContain('kSecAttrAccessibleWhenUnlockedThisDeviceOnly')
    expect(swiftStorage).toContain('aurora.local-data-envelope.')
    expect(readFileSync(resolve(process.cwd(), 'src-tauri/permissions/aurora-local-data-envelope-crypto.toml'), 'utf8')).toContain('os_protected_opaque_to_webview')
    expect(`${kotlin}\n${swiftStorage}`).not.toMatch(/rawKey|keyBytes|plaintextKey/u)
  })
})

class FakeTauriLocalDataBridge {
  calls: Array<{ command: string; args: Record<string, unknown> }> = []
  closed = false
  private profileId: string | null = null
  private localNodeId: string | null = null
  private conversations: ConversationRecord[] = []
  private messages: ConversationMessageRecord[] = []
  private memory: LightweightMemoryRecord[] = []
  private tools: LocalToolStateRecord[] = []
  private grants: PeerGrantMetadataRecord[] = []
  private audit: LocalAuditRecord[] = []
  private snapshot: FakeTauriLocalDataSnapshot | null = null
  private activeTxId: string | null = null
  private txCounter = 0
  readonly deletedMemoryIds: string[] = []

  readonly invoke = async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    this.calls.push({ command, args })
    if (command === 'aurora_local_data_open') {
      const request = (args.request ?? {}) as { profileId?: string; localNodeId?: string }
      if (this.profileId !== null && (this.profileId !== request.profileId || this.localNodeId !== request.localNodeId)) {
        throw { code: 'identity_mismatch' }
      }
      this.profileId = request.profileId ?? null
      this.localNodeId = request.localNodeId ?? null
      return this.status('applied')
    }
    if (command === 'aurora_local_data_close') {
      this.closed = true
      return this.status('idle')
    }
    if (command === 'aurora_local_data_transaction_begin') {
      if (this.activeTxId !== null) throw { code: 'invalid_record', detail: { reason: 'nested_transaction' } }
      this.txCounter += 1
      this.activeTxId = `tx-${String(this.txCounter).padStart(32, '0')}`
      this.snapshot = structuredClone({
        conversations: this.conversations,
        messages: this.messages,
        memory: this.memory,
        tools: this.tools,
        grants: this.grants,
        audit: this.audit
      })
      return { txId: this.activeTxId, begun: true }
    }
    if (command === 'aurora_local_data_transaction_commit') {
      this.assertTx(args)
      this.activeTxId = null
      this.snapshot = null
      return { committed: true }
    }
    if (command === 'aurora_local_data_transaction_rollback') {
      this.assertTx(args)
      if (this.snapshot !== null) Object.assign(this, this.snapshot)
      this.activeTxId = null
      this.snapshot = null
      return { rolledBack: true }
    }
    if (command === 'aurora_local_data_repository_operation') {
      const request = (args.request ?? {}) as { txId?: string; operation?: RepositoryOperation }
      if (request.txId !== undefined) this.assertTx(args)
      else if (this.activeTxId !== null) throw { code: 'invalid_record', detail: { reason: 'transaction_active' } }
      return this.repositoryOperation(request.operation)
    }
    return this.status('applied')
  }

  private status(migrationState: 'idle' | 'applied') {
    return {
      kind: 'sqlite-tauri',
      persistent: true,
      sqlite: true,
      profileId: this.profileId,
      localNodeId: this.localNodeId,
      schemaVersion: 3,
      migrationState
    }
  }

  private repositoryOperation(operation: RepositoryOperation | undefined): unknown {
    if (operation === undefined) throw new Error('missing operation')
    switch (operation.kind) {
      case 'conversations.upsertConversation':
        this.assertScope(operation.record)
        upsert(this.conversations, operation.record)
        return null
      case 'conversations.appendMessage':
        upsert(this.messages, operation.record)
        return null
      case 'conversations.deleteConversation': {
        const conversation = this.conversations.find((record) =>
          record.id === operation.conversationId
          && record.profileId === this.profileId
          && record.localNodeId === this.localNodeId
        )
        if (conversation === undefined) return { deleted: false, deletedMessages: 0 }
        const beforeMessages = this.messages.length
        this.conversations = this.conversations.filter((record) => record.id !== operation.conversationId)
        this.messages = this.messages.filter((record) => record.conversationId !== operation.conversationId)
        return { deleted: true, deletedMessages: beforeMessages - this.messages.length }
      }
      case 'conversations.listConversations':
        this.assertScope(operation)
        return this.conversations.filter((record) => record.profileId === this.profileId && record.localNodeId === this.localNodeId)
      case 'conversations.listMessages':
        this.assertScope(operation)
        if (!this.conversations.some((record) => record.id === operation.conversationId && record.profileId === this.profileId && record.localNodeId === this.localNodeId)) return []
        return this.messages.filter((record) => record.conversationId === operation.conversationId)
      case 'memory.upsertMemoryItem':
        this.assertScope(operation.record)
        upsert(this.memory, operation.record)
        return null
      case 'memory.deleteMemoryItem': {
        const before = this.memory.length
        this.memory = this.memory.filter((record) =>
          record.id !== operation.memoryItemId
          || record.profileId !== this.profileId
          || record.localNodeId !== this.localNodeId
        )
        if (this.memory.length !== before) this.deletedMemoryIds.push(operation.memoryItemId)
        return { deleted: this.memory.length !== before }
      }
      case 'memory.deleteExpiredMemoryItems': {
        const cutoffMs = requireDeleteNowMs(operation.nowMs)
        const limit = requireDeleteLimit(operation.limit)
        const expiredIds = this.memory
          .filter((record) =>
            record.profileId === this.profileId
            && record.localNodeId === this.localNodeId
            && record.expiresAtMs !== null
            && record.expiresAtMs <= cutoffMs
          )
          .sort((a, b) => (a.expiresAtMs ?? 0) - (b.expiresAtMs ?? 0) || a.id.localeCompare(b.id))
          .slice(0, limit)
          .map((record) => record.id)
        const expiredIdSet = new Set(expiredIds)
        this.memory = this.memory.filter((record) => !expiredIdSet.has(record.id))
        this.deletedMemoryIds.push(...expiredIds)
        return { deleted: expiredIds.length }
      }
      case 'memory.listMemoryItems':
        this.assertScope(operation)
        return this.memory.filter((record) =>
          record.profileId === this.profileId
          && record.localNodeId === this.localNodeId
          && (operation.namespace === undefined || record.namespace === operation.namespace)
        )
      case 'localTools.upsertLocalToolState':
        this.assertScope(operation.record)
        upsert(this.tools, operation.record)
        return null
      case 'localTools.listLocalToolStates':
        this.assertScope(operation)
        return this.tools
      case 'peerGrants.upsertPeerGrant':
        this.assertScope(operation.record)
        upsert(this.grants, operation.record)
        return null
      case 'peerGrants.listPeerGrants':
        this.assertScope(operation)
        return this.grants
      case 'localAudit.appendAudit':
        this.assertScope(operation.record)
        this.audit.unshift(operation.record)
        return null
      case 'localAudit.listAudit':
        this.assertScope(operation)
        return this.audit
    }
  }

  private assertScope(value: { profileId: string; localNodeId: string }): void {
    if (value.profileId !== this.profileId || value.localNodeId !== this.localNodeId) throw { code: 'identity_mismatch' }
  }

  seedForeignProfile(records: Partial<FakeTauriLocalDataSnapshot>): void {
    this.conversations.push(...(records.conversations ?? []))
    this.messages.push(...(records.messages ?? []))
    this.memory.push(...(records.memory ?? []))
  }

  foreignRecords(): Pick<FakeTauriLocalDataSnapshot, 'conversations' | 'messages' | 'memory'> {
    return {
      conversations: this.conversations.filter((record) => record.profileId !== this.profileId || record.localNodeId !== this.localNodeId),
      messages: this.messages.filter((message) => {
        const conversation = this.conversations.find((record) => record.id === message.conversationId)
        return conversation !== undefined && (conversation.profileId !== this.profileId || conversation.localNodeId !== this.localNodeId)
      }),
      memory: this.memory.filter((record) => record.profileId !== this.profileId || record.localNodeId !== this.localNodeId)
    }
  }

  private assertTx(args: Record<string, unknown>): void {
    const request = (args.request ?? {}) as { txId?: string }
    if (request.txId === undefined || request.txId !== this.activeTxId) throw { code: 'invalid_record', detail: { reason: 'forged_transaction' } }
  }
}

const envelopeFixture = {
  version: 1,
  algorithm: 'AES-GCM-256',
  keyId: localDataEnvelopeKeyId('profile-1', 'node-1', 1),
  nonceB64Url: 'MTIzNDU2Nzg5MDEy',
  ciphertextAndTagB64Url: 'Y2lwaGVydGV4dC1hbmQtdGFn',
  createdAtMs: 1000
} as const

function localDataEnvelopeKeyId(profileId: string, localNodeId: string, version: number): string {
  return `aurora.local-data-envelope.v1.${sha256Hex(profileId)}.${sha256Hex(localNodeId)}.local-structured-data.k${version}`
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function conversationFixture(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return { id: 'conversation-1', profileId: 'profile-1', localNodeId: 'node-1', titleEnvelope: null, createdAtMs: 1, updatedAtMs: 2, archivedAtMs: null, ...overrides }
}
function messageFixture(overrides: Partial<ConversationMessageRecord> = {}): ConversationMessageRecord {
  return { id: 'message-1', conversationId: 'conversation-1', sequence: 0, role: 'user', contentEnvelope: null, toolEnvelope: null, status: 'complete', createdAtMs: 3, ...overrides }
}
function memoryFixture(overrides: Partial<LightweightMemoryRecord> = {}): LightweightMemoryRecord {
  return { id: 'memory-1', profileId: 'profile-1', localNodeId: 'node-1', namespace: 'notes', payloadEnvelope: envelopeFixture, sourceType: null, sourceId: null, createdAtMs: 4, updatedAtMs: 5, expiresAtMs: null, ...overrides }
}
function localToolStateFixture(overrides: Partial<LocalToolStateRecord> = {}): LocalToolStateRecord {
  return { profileId: 'profile-1', localNodeId: 'node-1', toolContractId: 'Tooling.Search', descriptorJson: { id: 'Tooling.Search' }, descriptorHash: 'a'.repeat(64), enabled: true, settingsEnvelope: null, revision: 1, updatedAtMs: 6, ...overrides }
}
function peerGrantFixture(overrides: Partial<PeerGrantMetadataRecord> = {}): PeerGrantMetadataRecord {
  return { grantId: 'grant-1', profileId: 'profile-1', localNodeId: 'node-1', claimantPeerId: 'peer-1', tokenId: 'token-1', scopeEnvelope: envelopeFixture, revision: 1, createdAtMs: 7, expiresAtMs: null, revokedAtMs: null, ...overrides }
}
function auditFixture(overrides: Partial<LocalAuditRecord> = {}): LocalAuditRecord {
  return { id: 'audit-1', profileId: 'profile-1', localNodeId: 'node-1', peerId: null, action: 'read', decision: 'allow', resultStatus: 'success', connectionEpoch: null, methodId: null, toolContractId: null, correlationId: null, redactedDetailJson: {}, createdAtMs: 8, ...overrides }
}

function upsert<T extends { id?: string; grantId?: string; toolContractId?: string }>(records: T[], next: T): void {
  const id = next.id ?? next.grantId ?? next.toolContractId
  const index = records.findIndex((record) => (record.id ?? record.grantId ?? record.toolContractId) === id)
  if (index === -1) records.push(next)
  else records[index] = next
}

function requireDeleteNowMs(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw { code: 'invalid_record', detail: { reason: 'delete_now_ms' } }
  return nowMs
}

function requireDeleteLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw { code: 'invalid_record', detail: { reason: 'delete_limit' } }
  return limit
}

function walk(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...walk(path))
    else if (/\.(?:ts|tsx)$/u.test(entry) && !/\.test\.(?:ts|tsx)$/u.test(entry)) files.push(path)
  }
  return files
}

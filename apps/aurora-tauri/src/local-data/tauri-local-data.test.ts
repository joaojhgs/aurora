import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildEnvelopeAad,
  type ConversationMessageRecord,
  type ConversationListQuery,
  type ConversationRecord,
  type LightweightMemoryRecord,
  type LocalAuditRecord,
  type LocalDataRepositories,
  type LocalToolStateRecord,
  type MessageListQuery,
  type PeerGrantMetadataRecord,
  type TranscriptSessionRecord,
  type TranscriptSegmentRecord
} from '../../../../packages/aurora-sdk/src/local-data/index.js'

import { TauriEnvelopeCryptoPort } from './tauri-envelope-crypto.js'
import { TauriSqliteLocalDataBackend } from './tauri-sqlite-backend.js'

type RepositoryOperation =
  | { readonly kind: 'conversations.upsertConversation'; readonly record: ConversationRecord }
  | { readonly kind: 'conversations.appendMessage'; readonly record: ConversationMessageRecord }
  | { readonly kind: 'conversations.deleteConversation'; readonly conversationId: string }
  | { readonly kind: 'conversations.getConversation'; readonly profileId: string; readonly localNodeId: string; readonly conversationId: string }
  | { readonly kind: 'conversations.getMessage'; readonly profileId: string; readonly localNodeId: string; readonly conversationId: string; readonly messageId: string }
  | { readonly kind: 'conversations.listConversations'; readonly profileId: string; readonly localNodeId: string; readonly options?: ConversationListQuery }
  | { readonly kind: 'conversations.listMessageCounts'; readonly profileId: string; readonly localNodeId: string; readonly conversationIds?: readonly string[] }
  | { readonly kind: 'conversations.listFirstUserMessages'; readonly profileId: string; readonly localNodeId: string; readonly conversationIds?: readonly string[] }
  | { readonly kind: 'conversations.listMessages'; readonly profileId: string; readonly localNodeId: string; readonly conversationId: string; readonly options?: MessageListQuery }
  | { readonly kind: 'conversations.getLatestMessageSequence'; readonly profileId: string; readonly localNodeId: string; readonly conversationId: string }
  | { readonly kind: 'memory.upsertMemoryItem'; readonly record: LightweightMemoryRecord }
  | { readonly kind: 'memory.deleteMemoryItem'; readonly memoryItemId: string }
  | { readonly kind: 'memory.deleteExpiredMemoryItems'; readonly profileId: string; readonly localNodeId: string; readonly nowMs: number; readonly limit: number }
  | { readonly kind: 'memory.listMemoryItems'; readonly profileId: string; readonly localNodeId: string; readonly namespace?: string }
  | { readonly kind: 'localTools.upsertLocalToolState'; readonly record: LocalToolStateRecord }
  | { readonly kind: 'localTools.listLocalToolStates'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'peerGrants.upsertPeerGrant'; readonly record: PeerGrantMetadataRecord }
  | { readonly kind: 'peerGrants.listPeerGrants'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'localAudit.appendAudit'; readonly record: LocalAuditRecord }
  | { readonly kind: 'localAudit.listAudit'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'transcripts.createSession'; readonly record: TranscriptSessionRecord }
  | { readonly kind: 'transcripts.startSession'; readonly profileId: string; readonly localNodeId: string; readonly sessionId: string; readonly startedAtMs: number }
  | { readonly kind: 'transcripts.appendSegment'; readonly record: TranscriptSegmentRecord }
  | { readonly kind: 'transcripts.getSession'; readonly profileId: string; readonly localNodeId: string; readonly sessionId: string }
  | { readonly kind: 'transcripts.listSessions'; readonly profileId: string; readonly localNodeId: string; readonly options?: { limit?: number; cursor?: { createdAtMs: number; id: string } } }
  | { readonly kind: 'transcripts.listSegments'; readonly profileId: string; readonly localNodeId: string; readonly sessionId: string; readonly options?: { limit?: number; afterSequence?: number } }
  | { readonly kind: 'transcripts.finalizeSession'; readonly profileId: string; readonly localNodeId: string; readonly input: { sessionId: string; lifecycle: 'completed' | 'interrupted' | 'failed'; endedAtMs: number; terminalReason: string } }
  | { readonly kind: 'transcripts.recoverActiveSessions'; readonly profileId: string; readonly localNodeId: string; readonly nowMs: number; readonly terminalReason?: string }
  | { readonly kind: 'transcripts.deleteSession'; readonly profileId: string; readonly localNodeId: string; readonly sessionId: string }
  | { readonly kind: 'transcripts.deleteExpiredSessions'; readonly profileId: string; readonly localNodeId: string; readonly nowMs: number; readonly limit: number }

type FakeTauriLocalDataSnapshot = {
  readonly conversations: ConversationRecord[]
  readonly messages: ConversationMessageRecord[]
  readonly memory: LightweightMemoryRecord[]
  readonly tools: LocalToolStateRecord[]
  readonly grants: PeerGrantMetadataRecord[]
  readonly audit: LocalAuditRecord[]
  readonly transcriptSessions: TranscriptSessionRecord[]
  readonly transcriptSegments: TranscriptSegmentRecord[]
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
    await expect(session.conversations.listFirstUserMessages()).resolves.toEqual({ 'conversation-1': messageFixture() })
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

  it('routes transcript archive operations through scoped native commands with immutable retry semantics', async () => {
    const bridge = new FakeTauriLocalDataBridge()
    const session = await new TauriSqliteLocalDataBackend({ invokeCommand: bridge.invoke }).open('profile-1', 'node-1')
    const archive = transcriptSessionFixture()
    const segment = transcriptSegmentFixture()
    await expect(session.transcripts.createSession(archive)).resolves.toEqual(archive)
    await expect(session.transcripts.appendSegment(segment)).resolves.toEqual({ appended: true, record: segment })
    await expect(session.transcripts.finalizeSession({ sessionId: archive.id, lifecycle: 'completed', endedAtMs: 1200, terminalReason: 'finished' })).resolves.toMatchObject({ lifecycle: 'completed' })
    await expect(session.transcripts.appendSegment(segment)).resolves.toEqual({ appended: false, record: segment })
    await expect(session.transcripts.appendSegment(transcriptSegmentFixture({ id: 'segment-2', sequence: 1 }))).rejects.toMatchObject({ code: 'invalid_record' })
    await expect(session.transcripts.listSegments(archive.id)).resolves.toEqual([segment])
    const operationCalls = bridge.calls
      .filter((call) => call.command === 'aurora_local_data_repository_operation')
      .map((call) => (call.args.request as { operation: RepositoryOperation }).operation.kind)
    expect(operationCalls).toEqual([
      'transcripts.createSession', 'transcripts.appendSegment', 'transcripts.finalizeSession',
      'transcripts.appendSegment', 'transcripts.appendSegment', 'transcripts.listSegments'
    ])
    await session.close()
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
    await expect(session.memory.deleteExpiredMemoryItems({ profileId: 'profile-2', localNodeId: 'node-1' }, 1000, 2)).rejects.toMatchObject({ code: 'identity_mismatch' })
    await expect(session.memory.deleteExpiredMemoryItems({ profileId: 'profile-1', localNodeId: 'node-2' }, 1000, 2)).rejects.toMatchObject({ code: 'identity_mismatch' })
    await expect(session.memory.deleteExpiredMemoryItems({ profileId: 'profile-1', localNodeId: 'node-1' }, 1000, 2)).resolves.toEqual({ deleted: 2 })
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
      await expect(session.memory.deleteExpiredMemoryItems({ profileId: 'profile-1', localNodeId: 'node-1' }, nowMs, limit)).rejects.toMatchObject({ code: 'invalid_record' })
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
    const localDataPermission = readFileSync(resolve(process.cwd(), 'src-tauri/permissions/aurora-local-data-storage.toml'), 'utf8')
    expect(localDataPermission).toContain('Raw SQL strings are never accepted from the WebView')
    expect(localDataPermission).toContain('aurora_local_data_inspect_identity')
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
    const kotlinCrypto = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativeLocalData.kt'), 'utf8')
    const kotlinVoice = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraRuntimeForegroundService.kt'), 'utf8')
    const androidAudio = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/src/android_audio.rs'), 'utf8')
    const nativeLocalData = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/src/local_data_native.rs'), 'utf8')
    const swiftPlugin = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraNativePlugin.swift'), 'utf8')
    const swiftStorage = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraThinPeerStorage.swift'), 'utf8')

    for (const command of ['localDataEnvelopeEncrypt', 'localDataEnvelopeDecrypt', 'localDataEnvelopeRotate']) {
      expect(kotlin).toContain(`fun ${command}`)
      expect(swiftPlugin).toContain(`func ${command}`)
    }
    expect(kotlinCrypto).toContain('AES/GCM/NoPadding')
    expect(kotlinCrypto).toContain('setKeySize(256)')
    expect(kotlinCrypto).toContain('cipher.updateAAD')
    expect(kotlinCrypto).toContain('LOCAL_DATA_KEY_PREFIX')
    expect(kotlin).toContain('AuroraLocalDataEnvelopeCrypto.encrypt(')
    expect(kotlin).toContain('AuroraLocalDataEnvelopeCrypto.decrypt(')
    expect(kotlin).toContain('AuroraLocalDataEnvelopeCrypto.rotate(')
    expect(kotlinVoice).toContain('AuroraLocalDataEnvelopeCrypto.encryptMessageText(')
    expect(kotlinVoice).toContain('nativeSession.persistBackgroundTurn(')
    expect(kotlinVoice).toContain('appConfigDir = applicationInfo.dataDir')
    expect(androidAudio).toContain('persist_native_voice_turn_at_path(database_path, request)')
    expect(androidAudio).toContain('local_data_db_path_from_app_config_dir')
    expect(androidAudio).not.toContain('ANDROID_LOCAL_DATA_PATH')
    expect(androidAudio).not.toContain('install_local_data_path')
    expect(nativeLocalData).toContain('fn persist_native_voice_turn(')
    expect(nativeLocalData).toContain('LOCAL_DATA_DATABASE_NAME')
    expect(kotlin).not.toContain('private fun localDataEnvelopeKey(')
    expect(swiftStorage).toContain('AES.GCM.seal')
    expect(swiftStorage).toContain('AES.GCM.open')
    expect(swiftStorage).toContain('kSecAttrAccessibleWhenUnlockedThisDeviceOnly')
    expect(swiftStorage).toContain('aurora.local-data-envelope.')
    expect(readFileSync(resolve(process.cwd(), 'src-tauri/permissions/aurora-local-data-envelope-crypto.toml'), 'utf8')).toContain('os_protected_opaque_to_webview')
    expect(`${kotlin}\n${kotlinCrypto}\n${swiftStorage}`).not.toMatch(/rawKey|keyBytes|plaintextKey/u)
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
  private transcriptSessions: TranscriptSessionRecord[] = []
  private transcriptSegments: TranscriptSegmentRecord[] = []
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
        audit: this.audit,
        transcriptSessions: this.transcriptSessions,
        transcriptSegments: this.transcriptSegments
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
      case 'conversations.getConversation':
        this.assertScope(operation)
        return this.conversations.find((record) => record.id === operation.conversationId && record.profileId === this.profileId && record.localNodeId === this.localNodeId) ?? null
      case 'conversations.getMessage':
        this.assertScope(operation)
        return this.messages.find((message) => message.id === operation.messageId && message.conversationId === operation.conversationId && this.conversations.some((conversation) => conversation.id === message.conversationId && conversation.profileId === this.profileId && conversation.localNodeId === this.localNodeId)) ?? null
      case 'conversations.listConversations': {
        this.assertScope(operation)
        const options = operation.options ?? {}
        return this.conversations.filter((record) => record.profileId === this.profileId && record.localNodeId === this.localNodeId && (options.includeArchived !== false || record.archivedAtMs === null) && (options.cursor === undefined || record.updatedAtMs < options.cursor.updatedAtMs || (record.updatedAtMs === options.cursor.updatedAtMs && record.id > options.cursor.id))).sort((a, b) => b.updatedAtMs - a.updatedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, options.limit)
      }
      case 'conversations.listMessageCounts': {
        this.assertScope(operation)
        const ids = operation.conversationIds === undefined ? null : new Set(operation.conversationIds)
        const counts: Record<string, number> = {}
        for (const record of this.messages) {
          if ((ids === null || ids.has(record.conversationId)) && this.conversations.some((conversation) => conversation.id === record.conversationId && conversation.profileId === this.profileId && conversation.localNodeId === this.localNodeId)) {
            counts[record.conversationId] = (counts[record.conversationId] ?? 0) + 1
          }
        }
        return counts
      }
      case 'conversations.listFirstUserMessages': {
        this.assertScope(operation)
        const ids = operation.conversationIds === undefined ? null : new Set(operation.conversationIds)
        const firstByConversation = new Map<string, ConversationMessageRecord>()
        for (const record of this.messages) {
          if (record.role !== 'user' || (ids !== null && !ids.has(record.conversationId)) || !this.conversations.some((conversation) => conversation.id === record.conversationId && conversation.profileId === this.profileId && conversation.localNodeId === this.localNodeId)) continue
          const current = firstByConversation.get(record.conversationId)
          if (current === undefined || record.sequence < current.sequence || (record.sequence === current.sequence && record.id < current.id)) firstByConversation.set(record.conversationId, record)
        }
        return Object.fromEntries(firstByConversation)
      }
      case 'conversations.listMessages':
        this.assertScope(operation)
        if (!this.conversations.some((record) => record.id === operation.conversationId && record.profileId === this.profileId && record.localNodeId === this.localNodeId)) return []
        {
          const options = operation.options ?? {}
          const rows = this.messages.filter((record) => record.conversationId === operation.conversationId && (options.beforeSequence === undefined || record.sequence < options.beforeSequence) && (options.afterSequence === undefined || record.sequence > options.afterSequence)).sort((a, b) => (options.direction === 'desc' ? b.sequence - a.sequence : a.sequence - b.sequence) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          return options.limit === undefined ? rows : rows.slice(0, options.limit)
        }
      case 'conversations.getLatestMessageSequence':
        this.assertScope(operation)
        return this.messages.filter((record) => record.conversationId === operation.conversationId).reduce<number | null>((latest, record) => latest === null || record.sequence > latest ? record.sequence : latest, null)
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
        this.assertScope(operation)
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
      case 'transcripts.createSession':
        this.assertScope(operation.record)
        if (operation.record.lifecycle !== 'active') throw { code: 'invalid_record' }
        this.transcriptSessions.push(operation.record)
        return operation.record
      case 'transcripts.startSession': {
        this.assertScope(operation)
        const index = this.transcriptSessions.findIndex((record) => record.id === operation.sessionId && record.profileId === this.profileId && record.localNodeId === this.localNodeId)
        const prior = this.transcriptSessions[index]
        if (prior === undefined || prior.lifecycle !== 'active') throw { code: 'invalid_record' }
        const updated = { ...prior, startedAtMs: Math.min(prior.startedAtMs, operation.startedAtMs) }
        this.transcriptSessions[index] = updated
        return updated
      }
      case 'transcripts.appendSegment': {
        const parent = this.transcriptSessions.find((record) => record.id === operation.record.sessionId && record.profileId === this.profileId && record.localNodeId === this.localNodeId)
        if (parent === undefined) throw { code: 'invalid_record' }
        const prior = this.transcriptSegments.find((record) => record.id === operation.record.id)
        if (prior !== undefined) {
          if (JSON.stringify(prior) === JSON.stringify(operation.record)) return { appended: false, record: prior }
          throw { code: 'invalid_record' }
        }
        if (parent.lifecycle !== 'active') throw { code: 'invalid_record' }
        if (this.transcriptSegments.some((record) => record.sessionId === operation.record.sessionId && record.sequence === operation.record.sequence)) throw { code: 'invalid_record' }
        this.transcriptSegments.push(operation.record)
        return { appended: true, record: operation.record }
      }
      case 'transcripts.getSession':
        this.assertScope(operation)
        return this.transcriptSessions.find((record) => record.id === operation.sessionId && record.profileId === this.profileId && record.localNodeId === this.localNodeId) ?? null
      case 'transcripts.listSessions':
        this.assertScope(operation)
        return this.transcriptSessions.filter((record) => record.profileId === this.profileId && record.localNodeId === this.localNodeId)
          .sort((a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id))
          .filter((record) => operation.options?.cursor === undefined || record.createdAtMs < operation.options.cursor.createdAtMs || (record.createdAtMs === operation.options.cursor.createdAtMs && record.id > operation.options.cursor.id))
          .slice(0, operation.options?.limit ?? 100)
      case 'transcripts.listSegments':
        this.assertScope(operation)
        return this.transcriptSegments.filter((record) => record.sessionId === operation.sessionId && (operation.options?.afterSequence === undefined || record.sequence > operation.options.afterSequence))
          .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)).slice(0, operation.options?.limit ?? 500)
      case 'transcripts.finalizeSession': {
        this.assertScope(operation)
        const index = this.transcriptSessions.findIndex((record) => record.id === operation.input.sessionId && record.profileId === this.profileId && record.localNodeId === this.localNodeId)
        const prior = this.transcriptSessions[index]
        if (prior === undefined) throw { code: 'invalid_record' }
        const updated: TranscriptSessionRecord = { ...prior, lifecycle: operation.input.lifecycle, endedAtMs: operation.input.endedAtMs, terminalReason: operation.input.terminalReason }
        this.transcriptSessions[index] = updated
        return updated
      }
      case 'transcripts.recoverActiveSessions':
        this.assertScope(operation)
        return { interrupted: 0 }
      case 'transcripts.deleteSession': {
        this.assertScope(operation)
        const prior = this.transcriptSessions.find((record) => record.id === operation.sessionId && record.profileId === this.profileId && record.localNodeId === this.localNodeId)
        if (prior === undefined) return { deleted: false, deletedSegments: 0 }
        this.transcriptSessions = this.transcriptSessions.filter((record) => record !== prior)
        const before = this.transcriptSegments.length
        this.transcriptSegments = this.transcriptSegments.filter((record) => record.sessionId !== prior.id)
        return { deleted: true, deletedSegments: before - this.transcriptSegments.length }
      }
      case 'transcripts.deleteExpiredSessions':
        this.assertScope(operation)
        return { deletedSessions: 0, deletedSegments: 0 }
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
function transcriptSessionFixture(overrides: Partial<TranscriptSessionRecord> = {}): TranscriptSessionRecord {
  return {
    id: 'transcript-1', profileId: 'profile-1', localNodeId: 'node-1', captureMode: 'ambient',
    createdAtMs: 1000, startedAtMs: 1000, endedAtMs: null, lifecycle: 'active', terminalReason: null,
    expiresAtMs: 86_401_000, language: 'en', modelProvenance: { provider: 'local', modelId: 'stt-small', version: null },
    diarizationState: 'not_requested', ...overrides
  }
}
function transcriptSegmentFixture(overrides: Partial<TranscriptSegmentRecord> = {}): TranscriptSegmentRecord {
  return {
    id: 'segment-1', sessionId: 'transcript-1', sequence: 0, startAtMs: 1001, endAtMs: 1100,
    textEnvelope: envelopeFixture, confidence: 0.9, speakerId: null, speakerLabel: null, createdAtMs: 1100, ...overrides
  }
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

describe('native history query forwarding', () => {
  it('rejects unsafe query arguments before invoking Tauri', async () => {
    const calls: string[] = []
    const backend = new TauriSqliteLocalDataBackend({ invokeCommand: async (command) => { calls.push(command); return { kind: 'sqlite-tauri', persistent: true, sqlite: true, profileId: 'profile-1', schemaVersion: 3, migrationState: 'idle' } } })
    const session = await backend.open('profile-1', 'node-1')
    for (const query of [
      { limit: 0 },
      { limit: Number.MAX_SAFE_INTEGER + 1 },
      { limit: -1 },
      { limit: 1.5 },
      { includeArchived: 'yes' },
      { cursor: { updatedAtMs: -1, id: 'conversation-1' } },
      { cursor: { updatedAtMs: 1, id: 'bad id' } }
    ]) await expect(session.conversations.listConversations(query as never)).rejects.toMatchObject({ code: 'invalid_record' })
    await expect(session.conversations.listMessageCounts(Array.from({ length: 501 }, (_, index) => `conversation-${index}`))).rejects.toMatchObject({ metadata: { reason: 'conversation_id_set_limit' } })
    await expect(session.conversations.listMessages('conversation-1', { beforeSequence: 1, afterSequence: 2 })).rejects.toMatchObject({ metadata: { reason: 'ambiguous_message_cursor' } })
    expect(calls).toEqual(['aurora_local_data_open'])
  })

  it('forwards positive history operations and preserves structured versus unknown errors', async () => {
    const bridge = new FakeTauriLocalDataBridge()
    const session = await new TauriSqliteLocalDataBackend({ invokeCommand: bridge.invoke }).open('profile-1', 'node-1')
    await session.conversations.getConversation('conversation-1')
    await session.conversations.getMessage('conversation-1', 'message-1')
    await session.conversations.getLatestMessageSequence('conversation-1')
    await session.conversations.listMessageCounts(['conversation-1', 'conversation-1'])
    await session.conversations.listFirstUserMessages([])
    await session.conversations.listConversations({ limit: 2, includeArchived: false, cursor: { updatedAtMs: 10, id: 'conversation-0' } })
    await session.conversations.listMessages('conversation-1', { limit: 2, beforeSequence: 10, direction: 'desc' })
    const operations = bridge.calls.filter((call) => call.command === 'aurora_local_data_repository_operation').map((call) => (call.args.request as { operation: unknown }).operation as Record<string, unknown>)
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'conversations.getConversation', profileId: 'profile-1', localNodeId: 'node-1' }),
      expect.objectContaining({ kind: 'conversations.getMessage', profileId: 'profile-1', localNodeId: 'node-1' }),
      expect.objectContaining({ kind: 'conversations.getLatestMessageSequence', profileId: 'profile-1', localNodeId: 'node-1' }),
      expect.objectContaining({ kind: 'conversations.listMessageCounts', conversationIds: ['conversation-1', 'conversation-1'] }),
      expect.objectContaining({ kind: 'conversations.listFirstUserMessages', conversationIds: [] }),
      expect.objectContaining({ kind: 'conversations.listConversations', options: { limit: 2, includeArchived: false, cursor: { updatedAtMs: 10, id: 'conversation-0' } } }),
      expect.objectContaining({ kind: 'conversations.listMessages', options: { limit: 2, beforeSequence: 10, direction: 'desc' } })
    ]))

    const known = { code: 'invalid_record', message: 'duplicate', detail: { reason: 'duplicate_message_id' } }
    const unknown = { code: 'invalid_record', message: 'other', detail: { reason: 'other_reason' } }
    const knownBridge = new TauriSqliteLocalDataBackend({ invokeCommand: async (command) => command === 'aurora_local_data_open' ? { kind: 'sqlite-tauri', persistent: true, sqlite: true, profileId: 'profile-1', schemaVersion: 3, migrationState: 'idle' } : Promise.reject(known) })
    const knownSession = await knownBridge.open('profile-1', 'node-1')
    await expect(knownSession.conversations.getConversation('conversation-1')).rejects.toMatchObject({ metadata: { reason: 'duplicate_message_id' } })
    const unknownBridge = new TauriSqliteLocalDataBackend({ invokeCommand: async (command) => command === 'aurora_local_data_open' ? { kind: 'sqlite-tauri', persistent: true, sqlite: true, profileId: 'profile-1', schemaVersion: 3, migrationState: 'idle' } : Promise.reject(unknown) })
    const unknownSession = await unknownBridge.open('profile-1', 'node-1')
    await expect(unknownSession.conversations.getConversation('conversation-1')).rejects.toBe(unknown)
    const generic = { code: 'local_data_error', message: 'generic' }
    const genericBridge = new TauriSqliteLocalDataBackend({ invokeCommand: async (command) => command === 'aurora_local_data_open' ? { kind: 'sqlite-tauri', persistent: true, sqlite: true, profileId: 'profile-1', schemaVersion: 3, migrationState: 'idle' } : Promise.reject(generic) })
    const genericSession = await genericBridge.open('profile-1', 'node-1')
    await expect(genericSession.conversations.getConversation('conversation-1')).rejects.toBe(generic)
  })
})

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

import {
  LocalDataError,
  localDataMigrationManifest,
  localDataIdSchema,
  parseLocalDataExportV1,
  type LocalDataBackend,
  type LocalDataBackendKind,
  type LocalDataExportV1,
  type LocalDataImportResult,
  type LocalDataRecordCounts,
  type LocalDataCollectionHashes,
  type LocalDataSession
} from '@aurora/client/local-data'

export type BrowserTransferableBackendKind = Extract<LocalDataBackendKind, 'sqlite-wasm-opfs' | 'indexeddb'>

export interface BrowserLocalDataBackendPointer {
  readonly version: 1
  readonly profileId: string
  readonly localNodeId: string
  readonly schemaVersion: number
  readonly selectedBackend: BrowserTransferableBackendKind
  readonly committedAtMs: number
}

export interface BrowserLocalDataBackendPointerStore {
  read(profileId: string, localNodeId: string): Promise<BrowserLocalDataBackendPointer | null>
  write(pointer: BrowserLocalDataBackendPointer): Promise<void>
  delete?(profileId: string, localNodeId: string): Promise<void>
}

export interface BrowserBackendTransferOptions {
  readonly profileId: string
  readonly localNodeId: string
  readonly sourceBackend: LocalDataBackend
  readonly targetBackend: LocalDataBackend
  readonly reopenTargetBackend: () => LocalDataBackend
  readonly pointerStore: BrowserLocalDataBackendPointerStore
  readonly nowMs?: () => number
}

export interface BrowserBackendTransferResult {
  readonly committedBackend: BrowserTransferableBackendKind
  readonly sourceBackend: LocalDataBackendKind
  readonly recordCounts: LocalDataRecordCounts
  readonly collectionHashes: LocalDataCollectionHashes
}

export class LocalStorageBrowserLocalDataBackendPointerStore implements BrowserLocalDataBackendPointerStore {
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>> | undefined
  private readonly keyPrefix: string

  constructor(options: { readonly storage?: Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>; readonly keyPrefix?: string } = {}) {
    this.storage = options.storage ?? globalThis.localStorage
    this.keyPrefix = options.keyPrefix ?? 'aurora.localData.backendPointer'
  }

  async read(profileId: string, localNodeId: string): Promise<BrowserLocalDataBackendPointer | null> {
    const storage = this.requireStorage()
    const raw = accessPointerStorage(() => storage.getItem(pointerKey(this.keyPrefix, profileId, localNodeId)))
    if (raw === null) return null
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw invalidPointer('pointer_json')
    }
    return parsePointer(value, profileId, localNodeId)
  }

  async write(pointer: BrowserLocalDataBackendPointer): Promise<void> {
    const storage = this.requireStorage()
    accessPointerStorage(() => storage.setItem(
      pointerKey(this.keyPrefix, pointer.profileId, pointer.localNodeId),
      JSON.stringify(parsePointer(pointer, pointer.profileId, pointer.localNodeId))
    ))
  }

  async delete(profileId: string, localNodeId: string): Promise<void> {
    const storage = this.requireStorage()
    if (typeof storage.removeItem !== 'function') {
      throw new LocalDataError('unsupported_backend', 'Browser local data selection cleanup is unavailable', { reason: 'pointer_store_unavailable' })
    }
    accessPointerStorage(() => storage.removeItem!(pointerKey(this.keyPrefix, profileId, localNodeId)))
  }

  private requireStorage(): Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>> {
    if (this.storage === undefined) {
      throw new LocalDataError('unsupported_backend', 'Browser local data selection is unavailable', { reason: 'pointer_store_unavailable' })
    }
    return this.storage
  }
}

function accessPointerStorage<T>(operation: () => T): T {
  try {
    return operation()
  } catch {
    throw new LocalDataError('unsupported_backend', 'Browser local data selection is unavailable', {
      reason: 'pointer_store_access_failed'
    })
  }
}

export async function commitBrowserLocalDataBackendPointer(
  pointerStore: BrowserLocalDataBackendPointerStore,
  input: {
    readonly profileId: string
    readonly localNodeId: string
    readonly selectedBackend: BrowserTransferableBackendKind
    readonly nowMs?: () => number
  }
): Promise<BrowserLocalDataBackendPointer> {
  const pointer: BrowserLocalDataBackendPointer = {
    version: 1,
    profileId: input.profileId,
    localNodeId: input.localNodeId,
    schemaVersion: localDataMigrationManifest.latestVersion,
    selectedBackend: input.selectedBackend,
    committedAtMs: (input.nowMs ?? (() => Date.now()))()
  }
  await pointerStore.write(pointer)
  return pointer
}

export async function transferBrowserLocalDataBackend(options: BrowserBackendTransferOptions): Promise<BrowserBackendTransferResult> {
  const sourceSession = await options.sourceBackend.open(options.profileId, options.localNodeId)
  const sourceExport = validateTransferDocument(
    await sourceSession.exportV1(),
    options.profileId,
    options.localNodeId,
    options.sourceBackend.kind
  )

  let targetSession: LocalDataSession | null = null
  let reopenedBackend: LocalDataBackend | null = null
  try {
    targetSession = await options.targetBackend.open(options.profileId, options.localNodeId)
    const importResult = await targetSession.importV1(sourceExport)
    assertImportMatchesExport(importResult, sourceExport)
    await options.targetBackend.close()
    targetSession = null

    reopenedBackend = options.reopenTargetBackend()
    const reopenedSession = await reopenedBackend.open(options.profileId, options.localNodeId)
    const reopenedExport = validateTransferDocument(
      await reopenedSession.exportV1(),
      options.profileId,
      options.localNodeId,
      reopenedBackend.kind
    )
    assertExportEquivalent(sourceExport, reopenedExport)

    const committedBackend = asTransferableBackendKind(reopenedBackend.kind)
    await commitBrowserLocalDataBackendPointer(options.pointerStore, {
      profileId: options.profileId,
      localNodeId: options.localNodeId,
      selectedBackend: committedBackend,
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs })
    })
    return {
      committedBackend,
      sourceBackend: options.sourceBackend.kind,
      recordCounts: reopenedExport.recordCounts,
      collectionHashes: reopenedExport.collectionHashes
    }
  } catch (error) {
    throw error
  } finally {
    await targetSession?.close().catch(() => undefined)
    await reopenedBackend?.close().catch(() => undefined)
  }
}

export function validateBrowserLocalDataBackendPointer(
  value: unknown,
  profileId: string,
  localNodeId: string
): BrowserLocalDataBackendPointer {
  return parsePointer(value, profileId, localNodeId)
}

function validateTransferDocument(
  document: LocalDataExportV1,
  profileId: string,
  localNodeId: string,
  expectedSourceBackend: LocalDataBackendKind
): LocalDataExportV1 {
  const parsed = parseLocalDataExportV1(document)
  if (parsed.profileId !== profileId || parsed.localNodeId !== localNodeId) {
    throw new LocalDataError('identity_mismatch', 'Local data export identity does not match the transfer request')
  }
  if (parsed.sourceBackend !== expectedSourceBackend) {
    throw new LocalDataError('invalid_record', 'Local data export source does not match the transfer request', { reason: 'source_backend_mismatch' })
  }
  if (parsed.schemaVersion > localDataMigrationManifest.latestVersion) {
    throw new LocalDataError('invalid_record', 'Local data export schema is newer than this application', { reason: 'future_schema' })
  }
  return parsed
}

function assertImportMatchesExport(importResult: LocalDataImportResult, sourceExport: LocalDataExportV1): void {
  if (
    JSON.stringify(importResult.recordCounts) !== JSON.stringify(sourceExport.recordCounts)
    || JSON.stringify(importResult.collectionHashes) !== JSON.stringify(sourceExport.collectionHashes)
  ) {
    throw new LocalDataError('migration_integrity', 'Local data import summary does not match exported records', { reason: 'import_summary_mismatch' })
  }
}

function assertExportEquivalent(sourceExport: LocalDataExportV1, reopenedExport: LocalDataExportV1): void {
  if (
    reopenedExport.profileId !== sourceExport.profileId
    || reopenedExport.localNodeId !== sourceExport.localNodeId
    || reopenedExport.schemaVersion !== sourceExport.schemaVersion
    || JSON.stringify(reopenedExport.recordCounts) !== JSON.stringify(sourceExport.recordCounts)
    || JSON.stringify(reopenedExport.collectionHashes) !== JSON.stringify(sourceExport.collectionHashes)
    || JSON.stringify(reopenedExport.records) !== JSON.stringify(sourceExport.records)
  ) {
    throw new LocalDataError('migration_integrity', 'Local data target did not reopen with copied records', { reason: 'reopen_export_mismatch' })
  }
}

function parsePointer(value: unknown, profileId: string, localNodeId: string): BrowserLocalDataBackendPointer {
  if (value === null || typeof value !== 'object') throw invalidPointer('pointer_shape')
  const record = value as Partial<BrowserLocalDataBackendPointer>
  if (record.version !== 1) throw invalidPointer('pointer_version')
  if (!isLocalDataId(record.profileId) || !isLocalDataId(record.localNodeId)) throw invalidPointer('pointer_identity')
  if (record.profileId !== profileId || record.localNodeId !== localNodeId) throw invalidPointer('pointer_identity')
  if (record.schemaVersion !== localDataMigrationManifest.latestVersion) throw invalidPointer('pointer_schema')
  if (record.selectedBackend !== 'sqlite-wasm-opfs' && record.selectedBackend !== 'indexeddb') throw invalidPointer('pointer_backend')
  if (
    typeof record.committedAtMs !== 'number'
    || !Number.isSafeInteger(record.committedAtMs)
    || record.committedAtMs < 0
  ) throw invalidPointer('pointer_timestamp')
  return {
    version: 1,
    profileId,
    localNodeId,
    schemaVersion: record.schemaVersion,
    selectedBackend: record.selectedBackend,
    committedAtMs: record.committedAtMs
  }
}

function invalidPointer(reason: string): LocalDataError {
  return new LocalDataError('invalid_record', 'Browser local data selection is invalid', { reason })
}

function isLocalDataId(value: unknown): value is string {
  return localDataIdSchema.safeParse(value).success
}

function asTransferableBackendKind(kind: LocalDataBackendKind): BrowserTransferableBackendKind {
  if (kind === 'sqlite-wasm-opfs' || kind === 'indexeddb') return kind
  throw new LocalDataError('unsupported_backend', 'Local data backend cannot be selected in the browser', { reason: 'unsupported_pointer_backend' })
}

export function deriveBrowserLocalDataBackendPointerKey(prefix: string, profileId: string, localNodeId: string): string {
  return `${prefix}:${encodeURIComponent(profileId)}:${encodeURIComponent(localNodeId)}`
}

function pointerKey(prefix: string, profileId: string, localNodeId: string): string {
  return deriveBrowserLocalDataBackendPointerKey(prefix, profileId, localNodeId)
}

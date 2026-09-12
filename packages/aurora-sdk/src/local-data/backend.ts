export type LocalDataBackendKind = 'sqlite-wasm-opfs' | 'sqlite-tauri' | 'indexeddb' | 'memory'
export type LocalDataMigrationState = 'idle' | 'running' | 'failed'

export interface LocalDataBackendStatus {
  kind: LocalDataBackendKind
  persistent: boolean
  sqlite: boolean
  profileId: string | null
  schemaVersion: number | null
  migrationState: LocalDataMigrationState
  degradedReason?: string
}

export type LocalDataErrorCode =
  | 'invalid_record'
  | 'session_closed'
  | 'unsupported_backend'
  | 'migration_integrity'
  | 'migration_order'
  | 'identity_mismatch'
  | 'memory_session_only'

export interface LocalDataErrorMetadata {
  readonly boundaryId?: string
  readonly validation?: 'redacted'
  readonly issues?: Array<{ readonly code: string; readonly path: string }>
  readonly reason?: string
}

export class LocalDataError extends Error {
  readonly code: LocalDataErrorCode
  readonly metadata: LocalDataErrorMetadata | undefined

  constructor(code: LocalDataErrorCode, message: string, metadata?: LocalDataErrorMetadata) {
    super(message)
    this.name = 'LocalDataError'
    this.code = code
    this.metadata = metadata
  }
}

export interface LocalDataBackend {
  readonly kind: LocalDataBackendKind
  readonly persistent: boolean
  readonly sqlite: boolean
  open(profileId: string, localNodeId: string): Promise<import('./session.js').LocalDataSession>
  status(): Promise<LocalDataBackendStatus>
  close(): Promise<void>
}

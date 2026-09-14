import { LocalDataError } from './backend.js'
import type { LocalDataExportV1, LocalDataImportResult } from './export-v1.js'
import type { LocalDataRepositories } from './repositories.js'

export interface LocalDataSession extends LocalDataRepositories {
  readonly profileId: string
  readonly localNodeId: string
  readonly schemaVersion: number
  transaction<T>(work: (repositories: LocalDataRepositories) => Promise<T>): Promise<T>
  exportV1(): Promise<LocalDataExportV1>
  importV1(document: LocalDataExportV1): Promise<LocalDataImportResult>
  /** Mark sessions still active after an unclean process exit as interrupted. */
  recoverActiveTranscripts(nowMs: number, terminalReason?: string): Promise<import('./repositories.js').TranscriptRecoveryResult>
  close(): Promise<void>
}

export function assertOpen(closed: boolean): void {
  if (closed) throw new LocalDataError('session_closed', 'Local data session is closed')
}

import type { AuroraClient } from './client.js'
import { routePath } from './descriptors.js'
import type { JsonObject } from './types.js'
import type { AuroraResponse } from './transport.js'

export const BACKUP_METHODS = {
  create: 'Backup.Create',
  list: 'Backup.List',
  verify: 'Backup.Verify',
  restore: 'Backup.Restore',
  rollback: 'Backup.Rollback',
  healthCheck: 'Backup.HealthCheck'
} as const

export type BackupComponentName = 'config' | 'db' | 'rag' | 'models'
export type BackupComponentStatus = 'included' | 'skipped' | 'unavailable' | 'unsupported'
export type BackupOperationStatus = 'ok' | 'denied' | 'failed' | 'unsupported' | 'not_found'
export type BackupStorageKind = 'local' | 's3' | 'gcs' | 'azure' | 'custom'
export type BackupEncryptionMode = 'none' | 'passphrase' | 'age' | 'kms' | 'external'

export interface BackupStorageTarget {
  kind: BackupStorageKind
  uri?: string | null
  encryption: BackupEncryptionMode
  key_ref?: string | null
  credential_ref?: string | null
  metadata: JsonObject
}

export interface BackupComponentResult {
  component: BackupComponentName
  status: BackupComponentStatus
  item_count?: number | null
  bytes?: number | null
  fingerprint?: string | null
  redacted: boolean
  message?: string | null
}

export interface BackupServiceImpact {
  service: string
  action: 'quiesce' | 'restart' | 'reload' | 'manual' | 'none'
  required: boolean
  reason: string
}

export interface BackupImpactPlan {
  admin_critical: boolean
  requires_quiesce: boolean
  requires_restart: boolean
  affected_services: BackupServiceImpact[]
  warnings: string[]
}

export interface BackupManifestSummary {
  backup_id: string
  created_at: string
  status: BackupOperationStatus
  storage: BackupStorageTarget
  components: BackupComponentResult[]
  manifest_digest: string
  schema_version: string
  encrypted: boolean
  secrets_redacted: boolean
  audit_receipt?: string | null
}

export interface BackupCreateRequest {
  storage?: BackupStorageTarget
  components?: BackupComponentName[]
  reason: string
  include_personal_data?: boolean
  correlation_id?: string | null
}

export interface BackupCreateResponse {
  status: BackupOperationStatus
  backup: BackupManifestSummary | null
  audit_receipt: string
  message?: string | null
}

export interface BackupListRequest {
  limit?: number
  offset?: number
  include_failed?: boolean
}

export interface BackupListResponse {
  backups: BackupManifestSummary[]
  total: number
  secrets_redacted: boolean
}

export interface BackupVerifyRequest {
  backup_id: string
  storage?: BackupStorageTarget | null
}

export interface BackupVerifyResponse {
  status: BackupOperationStatus
  backup_id: string
  verified: boolean
  manifest_digest?: string | null
  components: BackupComponentResult[]
  message?: string | null
}

export interface BackupRestoreRequest {
  backup_id: string
  storage?: BackupStorageTarget | null
  components?: BackupComponentName[] | null
  dry_run?: boolean
  reason: string
  create_rollback?: boolean
  correlation_id?: string | null
}

export interface BackupRestoreResponse {
  status: BackupOperationStatus
  backup_id: string
  restored: boolean
  rollback_backup_id?: string | null
  impact_plan: BackupImpactPlan
  audit_receipt: string
  message?: string | null
}

export interface BackupRollbackRequest {
  rollback_backup_id: string
  reason: string
  dry_run?: boolean
  correlation_id?: string | null
}

export interface BackupRollbackResponse {
  status: BackupOperationStatus
  rollback_backup_id: string
  rolled_back: boolean
  impact_plan: BackupImpactPlan
  audit_receipt: string
  message?: string | null
}

type BackupAdminPayload =
  | BackupCreateRequest
  | BackupVerifyRequest
  | BackupRestoreRequest
  | BackupRollbackRequest

export class BackupClient {
  constructor(private readonly client: AuroraClient) {}

  list(request: BackupListRequest = {}): Promise<AuroraResponse<BackupListResponse>> {
    return this.client.requestResult<BackupListResponse, BackupListRequest>(
      BACKUP_METHODS.list,
      request,
      { path: routePath('Backup', 'List') }
    )
  }

  create(request: BackupCreateRequest): Promise<AuroraResponse<BackupCreateResponse>> {
    return this.adminExecute<BackupCreateResponse>(BACKUP_METHODS.create, request, request.reason)
  }

  verify(request: BackupVerifyRequest, reason: string): Promise<AuroraResponse<BackupVerifyResponse>> {
    return this.adminExecute<BackupVerifyResponse>(BACKUP_METHODS.verify, request, reason)
  }

  restore(request: BackupRestoreRequest): Promise<AuroraResponse<BackupRestoreResponse>> {
    return this.adminExecute<BackupRestoreResponse>(BACKUP_METHODS.restore, request, request.reason)
  }

  rollback(request: BackupRollbackRequest): Promise<AuroraResponse<BackupRollbackResponse>> {
    return this.adminExecute<BackupRollbackResponse>(BACKUP_METHODS.rollback, request, request.reason)
  }

  private adminExecute<TData>(
    methodId: string,
    payload: BackupAdminPayload,
    reason: string
  ): Promise<AuroraResponse<TData>> {
    return this.client.result(async () => {
      const result = await this.client.admin.execute<TData>({
        methodId,
        payload: payload as unknown as JsonObject,
        reason,
        reauthConfirmed: true,
        affectedResources: ['admin.backups'],
        path: pathForBackupMethod(methodId)
      })
      return result.data
    })
  }
}

function pathForBackupMethod(methodId: string): string {
  const method = methodId.split('.')[1] ?? methodId
  return routePath('Backup', method)
}

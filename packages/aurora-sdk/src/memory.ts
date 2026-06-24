import type { AuroraClient } from './client.js'
import { routePath } from './descriptors.js'
import type { AuroraResponse } from './transport.js'
import type { JsonValue, PrivacyClass } from './types.js'

export const DB_METHODS = {
  getMessages: 'DB.GetMessages',
  ragDelete: 'DB.RAGDelete',
  ragListNamespaces: 'DB.RAGListNamespaces',
  ragSearchRemote: 'DB.RAGSearchRemote',
  ragGetProvenance: 'DB.RAGGetProvenance',
  ragExportNamespace: 'DB.RAGExportNamespace',
  ragImportNamespace: 'DB.RAGImportNamespace'
} as const

export type RAGPolicyDecision = 'allowed' | 'denied' | 'unavailable' | 'conflict'
export type RAGNamespaceAvailability = 'available' | 'unavailable' | 'stale' | 'denied'
export type RAGSharingMode = 'remote_query' | 'export_import' | 'one_way_sync' | 'never'
export type RAGPrivacyClass = 'public' | 'internal' | 'personal' | 'sensitive' | 'secret'

export interface MeshAddressSelectorLike {
  peer_id?: string | null
  provider_id?: string | null
  service_instance_id?: string | null
  resource_namespace?: string | null
  [key: string]: JsonValue | undefined
}

export interface DBGetMessagesRequest {
  limit?: number
  offset?: number
  role?: string | null
  message_type?: string | null
  mesh_selector?: MeshAddressSelectorLike | null
}

export interface DBGetMessagesResponse {
  messages: Array<Record<string, JsonValue>>
  total: number
  has_more: boolean
}

export interface DBRAGNamespacePolicy {
  sharing_mode: RAGSharingMode
  privacy_class: RAGPrivacyClass
  allowed_operations: string[]
  explicit_selector_required: boolean
  export_supported: boolean
  import_supported: boolean
  delete_supported: boolean
  requires_admin_approval: boolean
  denial_reason: string | null
}

export interface DBRAGNamespaceInfo {
  namespace: string
  source_peer_id: string
  owner_peer_id: string
  provider_peer_id: string | null
  availability: RAGNamespaceAvailability
  policy: DBRAGNamespacePolicy
  record_count: number | null
  embedding_model: string | null
  schema_version: string
  freshness: string | null
}

export interface DBRAGListNamespacesRequest {
  include_remote?: boolean
  include_unavailable?: boolean
  namespace_prefix?: string | null
  mesh_selector?: MeshAddressSelectorLike | null
}

export interface DBRAGListNamespacesResponse {
  namespaces: DBRAGNamespaceInfo[]
}

export interface DBRAGProvenance {
  source_peer_id: string
  owner_peer_id: string
  namespace: string
  record_id: string
  origin_principal_id: string
  created_at: string
  updated_at: string
  schema_version: string
  policy_decision_id: string
  correlation_id: string
  imported_at: string | null
  import_operation_id: string | null
  tombstone: boolean
  deleted_at: string | null
  deleted_by: string | null
  delete_reason: string | null
}

export interface DBRAGProvenanceItem {
  key: string
  value: JsonValue
  namespace: string
  search_score: number | null
  provenance: DBRAGProvenance
  redacted: boolean
  redaction_reasons: string[]
}

export interface DBRAGSearchRemoteRequest {
  namespace: string
  query: string
  limit?: number
  offset?: number
  mesh_selector?: MeshAddressSelectorLike | null
  caller_peer_id?: string | null
  caller_principal_id?: string | null
  policy_decision_id?: string | null
  correlation_id?: string | null
}

export interface DBRAGSearchRemoteResponse {
  decision: RAGPolicyDecision
  items: DBRAGProvenanceItem[]
  denial_reason: string | null
  policy_decision_id: string
  correlation_id: string
}

export interface DBRAGGetProvenanceRequest {
  namespace: string
  key: string
  mesh_selector?: MeshAddressSelectorLike | null
  correlation_id?: string | null
}

export interface DBRAGGetProvenanceResponse {
  provenance: DBRAGProvenance | null
  decision: RAGPolicyDecision
  denial_reason: string | null
}

export interface DBRAGExportRecord {
  key: string
  value: JsonValue
  provenance: DBRAGProvenance
  redacted: boolean
  redaction_reasons: string[]
}

export interface DBRAGExportNamespaceRequest {
  namespace: string
  limit?: number
  offset?: number
  include_tombstones?: boolean
  caller_principal_id?: string | null
  policy_decision_id?: string | null
  correlation_id?: string | null
  mesh_selector?: MeshAddressSelectorLike | null
}

export interface DBRAGExportNamespaceResponse {
  decision: RAGPolicyDecision
  namespace: string
  source_peer_id: string
  owner_peer_id: string
  schema_version: string
  records: DBRAGExportRecord[]
  tombstone_count: number
  denial_reason: string | null
  policy_decision_id: string
  correlation_id: string
}

export interface DBRAGImportNamespaceRequest {
  source_namespace: string
  target_namespace: string
  records: DBRAGExportRecord[]
  source_peer_id: string
  owner_peer_id: string
  allow_owner_overwrite?: boolean
  caller_principal_id?: string | null
  policy_decision_id?: string | null
  correlation_id?: string | null
  mesh_selector?: MeshAddressSelectorLike | null
}

export interface DBRAGImportNamespaceResponse {
  decision: RAGPolicyDecision
  imported_count: number
  skipped_count: number
  target_namespace: string
  import_operation_id: string
  denial_reason: string | null
  policy_decision_id: string
  correlation_id: string
}

export interface DBRAGDeleteRequest {
  namespace: string
  key: string
  mesh_selector?: MeshAddressSelectorLike | null
}

export interface NormalizedConversation {
  id: string
  role: string
  content: string
  messageType: string
  createdAt: string | null
  privacyClass: PrivacyClass
  source: string
}

export function normalizeConversationMessage(message: Record<string, JsonValue>): NormalizedConversation {
  return {
    id: primitiveToString(message.id ?? message.message_id ?? message.key ?? 'message'),
    role: primitiveToString(message.role ?? 'unknown'),
    content: primitiveToString(message.content ?? message.text ?? message.value ?? ''),
    messageType: primitiveToString(message.message_type ?? message.type ?? 'TEXT'),
    createdAt: primitiveToNullableString(message.created_at ?? message.timestamp ?? null),
    privacyClass: normalizePrivacyClass(message.privacy_class),
    source: primitiveToString(message.source ?? 'DB.GetMessages')
  }
}

export function normalizeRagPrivacyClass(value: RAGPrivacyClass): PrivacyClass {
  if (value === 'internal') return 'sensitive'
  return value
}

export class MemoryClient {
  constructor(private readonly client: AuroraClient) {}

  listMessages(request: DBGetMessagesRequest = {}): Promise<AuroraResponse<DBGetMessagesResponse>> {
    return this.client.requestResult<DBGetMessagesResponse, DBGetMessagesRequest>(
      DB_METHODS.getMessages,
      request,
      { path: routePath('DB', 'GetMessages') }
    )
  }

  listNamespaces(request: DBRAGListNamespacesRequest = {}): Promise<AuroraResponse<DBRAGListNamespacesResponse>> {
    return this.client.requestResult<DBRAGListNamespacesResponse, DBRAGListNamespacesRequest>(
      DB_METHODS.ragListNamespaces,
      request,
      { path: routePath('DB', 'RAGListNamespaces') }
    )
  }

  search(request: DBRAGSearchRemoteRequest): Promise<AuroraResponse<DBRAGSearchRemoteResponse>> {
    return this.client.requestResult<DBRAGSearchRemoteResponse, DBRAGSearchRemoteRequest>(
      DB_METHODS.ragSearchRemote,
      request,
      { path: routePath('DB', 'RAGSearchRemote') }
    )
  }

  getProvenance(request: DBRAGGetProvenanceRequest): Promise<AuroraResponse<DBRAGGetProvenanceResponse>> {
    return this.client.requestResult<DBRAGGetProvenanceResponse, DBRAGGetProvenanceRequest>(
      DB_METHODS.ragGetProvenance,
      request,
      { path: routePath('DB', 'RAGGetProvenance') }
    )
  }

  exportNamespace(request: DBRAGExportNamespaceRequest): Promise<AuroraResponse<DBRAGExportNamespaceResponse>> {
    return this.client.requestResult<DBRAGExportNamespaceResponse, DBRAGExportNamespaceRequest>(
      DB_METHODS.ragExportNamespace,
      request,
      { path: routePath('DB', 'RAGExportNamespace') }
    )
  }

  importNamespace(request: DBRAGImportNamespaceRequest): Promise<AuroraResponse<DBRAGImportNamespaceResponse>> {
    return this.client.requestResult<DBRAGImportNamespaceResponse, DBRAGImportNamespaceRequest>(
      DB_METHODS.ragImportNamespace,
      request,
      { path: routePath('DB', 'RAGImportNamespace') }
    )
  }

  deleteRecord(request: DBRAGDeleteRequest): Promise<AuroraResponse<unknown>> {
    return this.client.requestResult<unknown, DBRAGDeleteRequest>(
      DB_METHODS.ragDelete,
      request,
      { path: routePath('DB', 'RAGDelete') }
    )
  }
}

function normalizePrivacyClass(value: JsonValue | undefined): PrivacyClass {
  if (
    value === 'public' ||
    value === 'personal' ||
    value === 'sensitive' ||
    value === 'secret' ||
    value === 'raw-audio' ||
    value === 'credential' ||
    value === 'admin-critical'
  ) {
    return value
  }
  if (value === 'internal') return 'sensitive'
  return 'personal'
}

function primitiveToString(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return ''
  return JSON.stringify(value)
}

function primitiveToNullableString(value: JsonValue | undefined): string | null {
  const text = primitiveToString(value)
  return text || null
}

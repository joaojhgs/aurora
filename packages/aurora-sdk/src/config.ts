import { CONFIG_METHODS, routePath } from './descriptors.js'
import type { AdminActionClient } from './admin.js'
import type { AuroraResponse } from './transport.js'
import type { JsonObject, JsonValue } from './types.js'

export interface ConfigGetRequest {
  section?: string | null
}

export interface ConfigGetResponse {
  config: JsonObject
}

export interface ConfigSetRequest {
  key_path: string
  value: JsonValue
}

export interface ConfigSetResponse {
  success: boolean
  previous_value?: JsonValue | undefined
  error?: string | null | undefined
  [key: string]: JsonValue | undefined
}

export interface ConfigValidateRequest {
  section?: string | null
}

export interface ConfigValidateResponse {
  errors: string[]
}

export interface ConfigSchemaMetadataRequest {
  section?: string | null
  include_values?: boolean
}

export interface ConfigFieldMetadata {
  key_path: string
  title?: string | null
  description: string
  type: string
  default?: JsonValue | undefined
  current_value?: JsonValue | undefined
  source_layer: string
  secret: boolean
  reload_required: boolean
  restart_required: boolean
  affected_services: string[]
  constraints: JsonObject
  choices?: JsonValue[] | null
}

export interface ConfigSchemaMetadataResponse {
  fields: ConfigFieldMetadata[]
  secrets_redacted: boolean
}

export interface ConfigChange {
  key_path: string
  value: JsonValue
}

export interface ConfigDiffPreviewRequest {
  changes: ConfigChange[]
}

export interface ConfigDiffEntry {
  key_path: string
  old_value?: JsonValue | undefined
  new_value?: JsonValue | undefined
  changed: boolean
  source_layer: string
  secret: boolean
  reload_required: boolean
  restart_required: boolean
  affected_services: string[]
}

export interface ConfigDiffPreviewResponse {
  valid: boolean
  diffs: ConfigDiffEntry[]
  errors: string[]
  secrets_redacted: boolean
}

export interface ConfigVersionHistoryRequest {
  key_path?: string | null
  limit?: number
}

export interface ConfigVersionEntry {
  version_id: string
  timestamp: string
  key_path: string
  old_value?: JsonValue | undefined
  new_value?: JsonValue | undefined
  affected_sections: string[]
  secret: boolean
}

export interface ConfigVersionHistoryResponse {
  versions: ConfigVersionEntry[]
  secrets_redacted: boolean
}

export interface ConfigRollbackRequest {
  version_id: string
}

export interface ConfigRollbackResponse {
  success: boolean
  version_id?: string | null
  key_path?: string | null
  rolled_back_to?: JsonValue | undefined
  affected_sections: string[]
  error?: string | null
  secrets_redacted: boolean
}

export interface ConfigReloadImpactRequest {
  key_paths?: string[]
  changes?: ConfigChange[]
}

export interface ConfigReloadImpactEntry {
  key_path: string
  reload_required: boolean
  restart_required: boolean
  affected_services: string[]
  reason: string
}

export interface ConfigReloadImpactResponse {
  impacts: ConfigReloadImpactEntry[]
}

export interface ConfigControllerClient {
  request<TData = unknown, TPayload = unknown>(
    method: string,
    payload?: TPayload,
    options?: { path?: string; httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; timeoutMs?: number; headers?: Record<string, string> }
  ): Promise<TData>
  requestResult<TData = unknown, TPayload = unknown>(
    method: string,
    payload?: TPayload,
    options?: { path?: string; httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; timeoutMs?: number; headers?: Record<string, string> }
  ): Promise<AuroraResponse<TData>>
  readonly admin: AdminActionClient
}

export class ConfigClient {
  constructor(private readonly client: ConfigControllerClient) {}

  get(request: ConfigGetRequest = {}): Promise<AuroraResponse<ConfigGetResponse>> {
    return this.client.requestResult<ConfigGetResponse, ConfigGetRequest>(
      CONFIG_METHODS.get,
      request,
      { path: routePath('Config', 'Get') }
    )
  }

  validate(request: ConfigValidateRequest = {}): Promise<AuroraResponse<ConfigValidateResponse>> {
    return this.client.requestResult<ConfigValidateResponse, ConfigValidateRequest>(
      CONFIG_METHODS.validate,
      request,
      { path: routePath('Config', 'Validate') }
    )
  }

  getSchemaMetadata(request: ConfigSchemaMetadataRequest = {}): Promise<AuroraResponse<ConfigSchemaMetadataResponse>> {
    return this.client.requestResult<ConfigSchemaMetadataResponse, ConfigSchemaMetadataRequest>(
      CONFIG_METHODS.getSchemaMetadata,
      request,
      { path: routePath('Config', 'GetSchemaMetadata') }
    )
  }

  previewDiff(request: ConfigDiffPreviewRequest): Promise<AuroraResponse<ConfigDiffPreviewResponse>> {
    return this.client.requestResult<ConfigDiffPreviewResponse, ConfigDiffPreviewRequest>(
      CONFIG_METHODS.previewDiff,
      request,
      { path: routePath('Config', 'PreviewDiff') }
    )
  }

  getVersionHistory(request: ConfigVersionHistoryRequest = {}): Promise<AuroraResponse<ConfigVersionHistoryResponse>> {
    return this.client.requestResult<ConfigVersionHistoryResponse, ConfigVersionHistoryRequest>(
      CONFIG_METHODS.getVersionHistory,
      request,
      { path: routePath('Config', 'GetVersionHistory') }
    )
  }

  previewReloadImpact(request: ConfigReloadImpactRequest): Promise<AuroraResponse<ConfigReloadImpactResponse>> {
    return this.client.requestResult<ConfigReloadImpactResponse, ConfigReloadImpactRequest>(
      CONFIG_METHODS.previewReloadImpact,
      request,
      { path: routePath('Config', 'PreviewReloadImpact') }
    )
  }

  applyChange(input: { change: ConfigChange; reason: string; reauthConfirmed: boolean; phrase?: string }): Promise<{
    draft: Awaited<ReturnType<AdminActionClient['draft']>>
    confirmation: Awaited<ReturnType<AdminActionClient['confirm']>>
    data: ConfigSetResponse
  }> {
    const request: Parameters<AdminActionClient['execute']>[0] = {
      methodId: CONFIG_METHODS.set,
      payload: { key_path: input.change.key_path, value: input.change.value },
      reason: input.reason,
      reauthConfirmed: input.reauthConfirmed,
      affectedResources: [input.change.key_path]
    }
    if (input.phrase !== undefined) request.phrase = input.phrase
    return this.client.admin.execute<ConfigSetResponse>(request)
  }

  rollback(input: { versionId: string; reason: string; reauthConfirmed: boolean; phrase?: string }): Promise<{
    draft: Awaited<ReturnType<AdminActionClient['draft']>>
    confirmation: Awaited<ReturnType<AdminActionClient['confirm']>>
    data: ConfigRollbackResponse
  }> {
    const request: Parameters<AdminActionClient['execute']>[0] = {
      methodId: CONFIG_METHODS.rollback,
      payload: { version_id: input.versionId },
      reason: input.reason,
      reauthConfirmed: input.reauthConfirmed,
      affectedResources: [input.versionId]
    }
    if (input.phrase !== undefined) request.phrase = input.phrase
    return this.client.admin.execute<ConfigRollbackResponse>(request)
  }
}

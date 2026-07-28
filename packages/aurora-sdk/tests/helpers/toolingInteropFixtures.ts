import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  ToolingGetExportCatalogResponse,
  ToolingProjectionToolInfo
} from '../../src/index.js'

export interface ToolingInteropVector {
  schema: 'aurora.tooling.interop.vectors.v1'
  stable_peer_id: string
  percent_encoded_stable_peer_id: string
  provider_service_instance_id: string
  method_ids: Record<string, string>
  positive: Array<{
    case: string
    tool_contract_id: string
    percent_encoded_tool_contract_id: string
    global_tool_id: string
    schema_hash: string
    reordered_schema_hash?: string
    tool: ToolingProjectionToolInfo
    reordered_tool?: ToolingProjectionToolInfo
  }>
  projection: {
    authority_revision: ToolingGetExportCatalogResponse['authority_revision']
    projection_digest: string
    projection_revision: string
    page_hash: string
    page_index: number
    page_size: number
    final_checksum: string
    retirements: ToolingGetExportCatalogResponse['retirements']
    blocked_tools: Array<{
      missing_permissions: string[]
      reason_code: 'recipient_missing_tool_permissions'
      tool_case: string
    }>
  }
  negative: Array<{
    case: string
    path: string
    patch: Record<string, unknown>
    expected_category: string
  }>
  current_dependency_gaps: string[]
}

export function loadToolingInteropVectors(): ToolingInteropVector {
  const fixturePath = resolveRepoFixturePath('tests/fixtures/tooling_interop/canonical_identity_digest_vectors.json')
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as ToolingInteropVector
}

export function buildToolingInteropProjectionPage(
  vectors = loadToolingInteropVectors()
): ToolingGetExportCatalogResponse {
  const toolsByCase = new Map(vectors.positive.map((entry) => [entry.case, entry.tool]))
  const blockedTools = vectors.projection.blocked_tools.map((entry) => {
    const tool = toolsByCase.get(entry.tool_case)
    if (!tool) throw new Error(`Missing Tooling interop tool fixture: ${entry.tool_case}`)
    return {
      missing_permissions: entry.missing_permissions,
      reason_code: entry.reason_code,
      tool
    }
  })
  return {
    ok: true,
    provider_peer_id: vectors.stable_peer_id,
    service_instance_id: vectors.provider_service_instance_id,
    selected_protocol_tier: 'projection_v1',
    authority_revision: vectors.projection.authority_revision,
    projection_revision: vectors.projection.projection_revision,
    projection_digest: vectors.projection.projection_digest,
    page_index: vectors.projection.page_index,
    page_size: vectors.projection.page_size,
    page_hash: vectors.projection.page_hash,
    tools: vectors.positive.map((entry) => entry.tool),
    blocked_tools: blockedTools,
    retirements: vectors.projection.retirements,
    complete: true,
    next_cursor: null,
    total_count: vectors.positive.length,
    final_checksum: vectors.projection.final_checksum
  }
}

function resolveRepoFixturePath(relativePath: string): string {
  let current = dirname(fileURLToPath(import.meta.url))
  for (let index = 0; index < 8; index += 1) {
    const candidate = resolve(current, relativePath)
    if (existsSync(candidate)) return candidate
    current = dirname(current)
  }
  throw new Error(`Unable to locate ${relativePath}`)
}

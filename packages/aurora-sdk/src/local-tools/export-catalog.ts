import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

import type {
  ToolingExportCatalogCompletePage,
  ToolingExportCatalogPartialPage,
  ToolingGetExportCatalogRequest,
  ToolingGetExportCatalogResponse,
  ToolingProjectionAuthorityRevision,
  ToolingProjectionBlockedTool,
  ToolingProjectionRetirement,
  ToolingProjectionToolInfo
} from '../types.js'
import { hasPermission } from '../permissions.js'
import { base64UrlDecode, base64UrlEncode, bytesToUtf8, concatBytes, utf8ToBytes } from '../webrtc/encoding.js'
import { canonicalJson, canonicalJsonSha256Hex } from './canonical-json.js'

export interface LocalToolProjectionContext {
  readonly recipientPeerId: string
  readonly recipientPermissions: readonly string[]
  readonly authorityRevision: ToolingProjectionAuthorityRevision
  readonly providerEnabled: boolean
  readonly serviceExported: boolean
  readonly discoveryExported: boolean
  readonly executionExported: boolean
}

export interface LocalToolExportDecisionPort {
  isShared(tool: ToolingProjectionToolInfo, context: LocalToolProjectionContext): boolean
}

export interface LocalToolExportCatalogOptions {
  readonly providerPeerId: string
  readonly serviceInstanceId: string
  readonly tools: readonly ToolingProjectionToolInfo[]
  readonly context: LocalToolProjectionContext
  readonly exportDecision?: LocalToolExportDecisionPort
  readonly retirements?: readonly ToolingProjectionRetirement[]
  readonly cursorSecret?: Uint8Array | string
  readonly cursorTtlSeconds?: number
  readonly nowSeconds?: () => number
  readonly nonce?: () => string
}

interface ProjectionCursor {
  readonly recipient_peer_id: string
  readonly provider_peer_id: string
  readonly protocol_tier: string
  readonly projection_revision: string
  readonly projection_digest: string
  readonly page_size: number
  readonly next_offset: number
  readonly page_index: number
  readonly expires_at: number
  readonly nonce: string
}

export class LocalToolProjectionError extends Error {
  readonly reasonCode: string

  constructor(reasonCode: string, message = reasonCode) {
    super(message)
    this.name = 'LocalToolProjectionError'
    this.reasonCode = reasonCode
  }
}

export function buildLocalToolExportCatalogPage(
  request: ToolingGetExportCatalogRequest,
  options: LocalToolExportCatalogOptions
): ToolingGetExportCatalogResponse {
  const pageSize = request.page_size ?? 100
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 256) {
    throw new LocalToolProjectionError('invalid_page_size')
  }
  const candidates = options.tools.map((tool) => normalizeProjectionToolAuthority(tool, options.providerPeerId, options.serviceInstanceId))
  const visible = buildVisibleProjection(candidates, options.context, options.exportDecision)
  const blockedTools = buildBlockedProjection(candidates, options.context, options.exportDecision)
  const retirements = [...(options.retirements ?? [])].sort((left, right) => left.global_tool_id.localeCompare(right.global_tool_id))
  const digest = computeProjectionChecksum(visible, retirements, blockedTools)
  const projectionRevision = canonicalJsonSha256Hex(options.context.authorityRevision)
  const entries: Array<{ kind: 'tool'; item: ToolingProjectionToolInfo } | { kind: 'blocked'; item: ToolingProjectionBlockedTool } | { kind: 'retirement'; item: ToolingProjectionRetirement }> = [
    ...visible.map((item) => ({ kind: 'tool' as const, item })),
    ...blockedTools.map((item) => ({ kind: 'blocked' as const, item })),
    ...retirements.map((item) => ({ kind: 'retirement' as const, item }))
  ].sort((left, right) => {
    const leftId = left.kind === 'blocked' ? left.item.tool.global_tool_id : left.item.global_tool_id
    const rightId = right.kind === 'blocked' ? right.item.tool.global_tool_id : right.item.global_tool_id
    return leftId.localeCompare(rightId) || left.kind.localeCompare(right.kind)
  })

  let offset = 0
  let pageIndex = 0
  if (request.cursor) {
    const cursor = decodeProjectionCursor(request.cursor, requireCursorSecret(options.cursorSecret), Math.floor(options.nowSeconds?.() ?? Date.now() / 1000))
    const expected = [
      options.context.recipientPeerId,
      options.providerPeerId,
      request.protocol_tier ?? 'projection_v1',
      projectionRevision,
      digest,
      pageSize
    ]
    const actual = [
      cursor.recipient_peer_id,
      cursor.provider_peer_id,
      cursor.protocol_tier,
      cursor.projection_revision,
      cursor.projection_digest,
      cursor.page_size
    ]
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new LocalToolProjectionError('projection_restart_required')
    offset = cursor.next_offset
    pageIndex = cursor.page_index
  }

  const pageEntries = entries.slice(offset, offset + pageSize)
  const nextOffset = offset + pageEntries.length
  const complete = nextOffset >= entries.length
  const base = {
    ok: true,
    provider_peer_id: options.providerPeerId,
    service_instance_id: options.serviceInstanceId,
    selected_protocol_tier: 'projection_v1' as const,
    authority_revision: options.context.authorityRevision,
    projection_revision: projectionRevision,
    projection_digest: digest,
    page_index: pageIndex,
    page_size: pageSize,
    page_hash: '0'.repeat(64),
    tools: pageEntries.filter((entry): entry is { kind: 'tool'; item: ToolingProjectionToolInfo } => entry.kind === 'tool').map((entry) => entry.item),
    blocked_tools: pageEntries.filter((entry): entry is { kind: 'blocked'; item: ToolingProjectionBlockedTool } => entry.kind === 'blocked').map((entry) => entry.item),
    retirements: pageEntries.filter((entry): entry is { kind: 'retirement'; item: ToolingProjectionRetirement } => entry.kind === 'retirement').map((entry) => entry.item)
  }
  const response: ToolingGetExportCatalogResponse = complete
    ? {
        ...base,
        complete: true,
        next_cursor: null,
        total_count: visible.length + blockedTools.length,
        final_checksum: digest
      } satisfies ToolingExportCatalogCompletePage
    : {
        ...base,
        complete: false,
        next_cursor: encodeProjectionCursor({
          recipient_peer_id: options.context.recipientPeerId,
          provider_peer_id: options.providerPeerId,
          protocol_tier: request.protocol_tier ?? 'projection_v1',
          projection_revision: projectionRevision,
          projection_digest: digest,
          page_size: pageSize,
          next_offset: nextOffset,
          page_index: pageIndex + 1,
          expires_at: Math.floor(options.nowSeconds?.() ?? Date.now() / 1000) + (options.cursorTtlSeconds ?? 300),
          nonce: options.nonce?.() ?? Math.random().toString(16).slice(2)
        }, requireCursorSecret(options.cursorSecret))
      } satisfies ToolingExportCatalogPartialPage
  return { ...response, page_hash: computeProjectionPageHash(response) } as ToolingGetExportCatalogResponse
}

export function buildVisibleProjection(
  tools: readonly ToolingProjectionToolInfo[],
  context: LocalToolProjectionContext,
  exportDecision?: LocalToolExportDecisionPort
): ToolingProjectionToolInfo[] {
  if (!context.providerEnabled || !context.serviceExported || !context.discoveryExported || !context.executionExported || !context.recipientPeerId) return []
  if (!exportDecision) return []
  return tools
    .filter((tool) => tool.source_type === 'local'
      && tool.execution_location === 'local'
      && tool.exportable
      && tool.provider_peer_id !== context.recipientPeerId
      && Boolean(tool.global_tool_id)
      && Boolean(tool.share_group_id)
      && ['Tooling.GetTools', 'Tooling.ExecuteTool', ...tool.required_permissions].every((permission) => hasPermission(permission, context.recipientPermissions, 'use'))
      && exportDecision.isShared(tool, context))
    .sort((left, right) => left.global_tool_id.localeCompare(right.global_tool_id))
}

function buildBlockedProjection(
  tools: readonly ToolingProjectionToolInfo[],
  context: LocalToolProjectionContext,
  exportDecision?: LocalToolExportDecisionPort
): ToolingProjectionBlockedTool[] {
  if (!context.providerEnabled || !context.serviceExported || !context.discoveryExported || !context.executionExported || !context.recipientPeerId) return []
  if (!exportDecision) return []
  if (!hasPermission('Tooling.GetTools', context.recipientPermissions, 'use')) return []
  if (!hasPermission('Tooling.ExecuteTool', context.recipientPermissions, 'use')) return []
  return tools
    .flatMap((tool): ToolingProjectionBlockedTool[] => {
      if (
        tool.source_type !== 'local'
        || tool.execution_location !== 'local'
        || !tool.exportable
        || tool.provider_peer_id === context.recipientPeerId
        || !tool.global_tool_id
        || !tool.share_group_id
        || !exportDecision.isShared(tool, context)
      ) return []
      const missingPermissions = [...new Set(tool.required_permissions.filter((permission) => !hasPermission(permission, context.recipientPermissions, 'use')))]
        .sort((left, right) => left.localeCompare(right))
      if (missingPermissions.length === 0) return []
      return [{
        tool,
        reason_code: 'recipient_missing_tool_permissions',
        missing_permissions: missingPermissions
      }]
    })
    .sort((left, right) => left.tool.global_tool_id.localeCompare(right.tool.global_tool_id))
}

export function computeProjectionChecksum(
  tools: readonly ToolingProjectionToolInfo[],
  retirements: readonly ToolingProjectionRetirement[] = [],
  blockedTools: readonly ToolingProjectionBlockedTool[] = []
): string {
  return canonicalJsonSha256Hex({
    tools: [...tools].sort((left, right) => left.global_tool_id.localeCompare(right.global_tool_id)),
    blocked_tools: [...blockedTools].sort((left, right) => left.tool.global_tool_id.localeCompare(right.tool.global_tool_id)),
    retirements: [...retirements].sort((left, right) => left.global_tool_id.localeCompare(right.global_tool_id))
  })
}

export function computeProjectionPageHash(page: ToolingGetExportCatalogResponse): string {
  return canonicalJsonSha256Hex({
    provider_peer_id: page.provider_peer_id,
    service_instance_id: page.service_instance_id,
    selected_protocol_tier: page.selected_protocol_tier,
    authority_revision: page.authority_revision,
    projection_revision: page.projection_revision,
    projection_digest: page.projection_digest,
    page_index: page.page_index,
    page_size: page.page_size,
    tools: page.tools,
    blocked_tools: page.blocked_tools ?? [],
    retirements: page.retirements,
    complete: page.complete,
    total_count: page.complete ? page.total_count : null,
    final_checksum: page.complete ? page.final_checksum : null
  })
}

export function projectionDigest(
  tools: readonly ToolingProjectionToolInfo[],
  recipientPeerId: string,
  authorityRevision: ToolingProjectionAuthorityRevision
): string {
  return canonicalJsonSha256Hex({
    recipient_peer_id: recipientPeerId,
    authority_revision: authorityRevision,
    tools: [...tools].sort((left, right) => left.global_tool_id.localeCompare(right.global_tool_id)).map(omitNullish)
  })
}

function encodeProjectionCursor(cursor: ProjectionCursor, secret: Uint8Array | string): string {
  const raw = canonicalJson(cursor)
  const signature = hmac(sha256, secretBytes(secret), utf8ToBytes(raw))
  return base64UrlEncode(concatBytes(utf8ToBytes(raw), signature))
}

function decodeProjectionCursor(token: string, secret: Uint8Array | string, nowSeconds: number): ProjectionCursor {
  try {
    const packed = base64UrlDecode(token)
    const raw = packed.subarray(0, packed.length - 32)
    const supplied = packed.subarray(packed.length - 32)
    const expected = hmac(sha256, secretBytes(secret), raw)
    if (!constantTimeEqual(supplied, expected)) {
      throw new Error('cursor signature mismatch')
    }
    const cursor = JSON.parse(bytesToUtf8(raw)) as ProjectionCursor
    if (nowSeconds >= cursor.expires_at) throw new Error('cursor expired')
    return cursor
  } catch {
    throw new LocalToolProjectionError('projection_restart_required')
  }
}

function requireCursorSecret(secret: Uint8Array | string | undefined): Uint8Array | string {
  if (secret === undefined || (typeof secret === 'string' && secret.length < 16) || (secret instanceof Uint8Array && secret.byteLength < 16)) {
    throw new LocalToolProjectionError('projection_cursor_secret_required')
  }
  return secret
}

function secretBytes(secret: Uint8Array | string): Uint8Array {
  return typeof secret === 'string' ? utf8ToBytes(secret) : secret
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let diff = left.byteLength ^ right.byteLength
  const length = Math.max(left.byteLength, right.byteLength)
  for (let index = 0; index < length; index += 1) diff |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return diff === 0
}

export function normalizeProjectionToolAuthority(tool: ToolingProjectionToolInfo, providerPeerId: string, serviceInstanceId: string): ToolingProjectionToolInfo {
  return {
    ...tool,
    provider_peer_id: providerPeerId,
    provider_service_instance_id: serviceInstanceId,
    provenance: {
      ...tool.provenance,
      provider_peer_id: providerPeerId,
      provider_service_instance_id: serviceInstanceId
    }
  }
}

function omitNullish(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNullish)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== null && item !== undefined)
        .map(([key, item]) => [key, omitNullish(item)])
    )
  }
  return value
}

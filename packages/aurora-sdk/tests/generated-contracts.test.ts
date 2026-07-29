import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'

import {
  backendContractSchemaById,
  ToolingExecuteToolInputToolingExecuteToolRequestSchema,
  ToolingGetToolsInputToolingGetToolsRequestSchema
} from '../src/generated/index.js'

const generatedRoot = resolve(process.cwd(), 'src/generated')
const manifest = JSON.parse(readFileSync(resolve(generatedRoot, 'backend-contracts.manifest.json'), 'utf8'))
const contractSchema = JSON.parse(readFileSync(resolve(generatedRoot, 'backend-contracts.schema.json'), 'utf8'))
const providerInventory = JSON.parse(readFileSync(resolve(generatedRoot, 'tooling-local-provider-v1.json'), 'utf8'))
type ProviderMethod = { method_id: string, required_permission: string }
type ContractSchemaItem = {
  schema_id: keyof typeof backendContractSchemaById
  method_id: string
  direction: string
  model_name: string
  schema: Record<string, unknown>
  vectors: {
    positive?: { accepted: true; input: unknown; normalized: unknown }
    negative?: { accepted: false; input: unknown; issue_path: string }
    negative_cases?: { accepted: false; input: unknown; issue_path: string }[]
  }
}

const toIssuePath = (path: PropertyKey[]) =>
  path.length === 0
    ? '$'
    : `$${path
        .map((part) => `.${String(part)}`)
        .join('')}`

const normalizeJsonValue = (value: unknown): unknown =>
  value === undefined
    ? undefined
    : JSON.parse(
        JSON.stringify(value, (_key, item) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
          }
          return item
        })
      )

const walkSchemas = (schema: unknown, visit: (node: Record<string, unknown>) => void) => {
  if (Array.isArray(schema)) {
    schema.forEach((item) => walkSchemas(item, visit))
    return
  }
  if (!schema || typeof schema !== 'object') {
    return
  }
  const node = schema as Record<string, unknown>
  visit(node)
  Object.values(node).forEach((item) => walkSchemas(item, visit))
}

const collectExtraBehavior = (schema: Record<string, unknown>) => {
  const behaviors: string[] = []
  walkSchemas(schema, (node) => {
    const behavior = node['x-aurora-extra-behavior']
    if (typeof behavior === 'string') {
      behaviors.push(behavior)
    }
  })
  return behaviors.sort()
}

const jsonValueMarker = { 'x-aurora-json-value': true }

const isJsonValueDefinition = (schema: unknown): boolean => {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return false
  }
  const anyOf = (schema as Record<string, unknown>).anyOf
  if (!Array.isArray(anyOf) || anyOf.length !== 6) {
    return false
  }
  const primitiveTypes = new Set(
    anyOf
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => (item as Record<string, unknown>).type)
      .filter((item) => typeof item === 'string')
  )
  return ['string', 'number', 'boolean', 'null', 'array', 'object'].every((type) =>
    primitiveTypes.has(type)
  )
}

const resolveLocalRef = (root: unknown, ref: string): unknown => {
  if (!ref.startsWith('#/')) {
    return undefined
  }
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((current, token) => {
      if (!current || typeof current !== 'object') {
        return undefined
      }
      return (current as Record<string, unknown>)[token.replace(/~1/g, '/').replace(/~0/g, '~')]
    }, root)
}

const auroraMetadataKeys = [
  'x-aurora-extra-behavior',
  'x-aurora-projection-page-termination',
  'x-aurora-string-non-blank',
  'x-aurora-string-trimmed',
  'x-aurora-unique-string-array-normalize'
]

const collectAuroraMetadata = (
  schema: unknown,
  root: unknown = schema,
  path = '$',
  seenRefs = new Set<string>()
): string[] => {
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) =>
      collectAuroraMetadata(item, root, `${path}.${index}`, seenRefs)
    )
  }
  if (!schema || typeof schema !== 'object') {
    return []
  }
  const node = schema as Record<string, unknown>
  if (typeof node.$ref === 'string') {
    const target = resolveLocalRef(root, node.$ref)
    if (target !== undefined && !seenRefs.has(node.$ref)) {
      return collectAuroraMetadata(target, root, path, new Set([...seenRefs, node.$ref]))
    }
  }
  const own = auroraMetadataKeys
    .filter((key) => key in node)
    .map((key) => `${path}:${key}:${JSON.stringify(normalizeJsonValue(node[key]))}`)
  const nested = Object.entries(node)
    .filter(([key]) => key !== '$defs' && key !== '$schema' && !auroraMetadataKeys.includes(key))
    .flatMap(([key, item]) => collectAuroraMetadata(item, root, `${path}.${key}`, seenRefs))
  return [...own, ...nested].sort()
}

const normalizeJsonSchema = (schema: unknown, root: unknown = schema, seenRefs = new Set<string>()): unknown => {
  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeJsonSchema(item, root, seenRefs))
  }
  if (!schema || typeof schema !== 'object') {
    return schema
  }
  const node = schema as Record<string, unknown>
  if (
    Array.isArray(node.anyOf) &&
    node.anyOf.every((item) => item && typeof item === 'object' && 'const' in item)
  ) {
    const values = node.anyOf.map((item) => (item as Record<string, unknown>).const)
    return normalizeJsonSchema({
      ...node,
      anyOf: undefined,
      enum: values,
      type: values.every((item) => Number.isInteger(item)) ? 'integer' : undefined
    }, root, seenRefs)
  }
  if (node['x-aurora-json-value'] === true) {
    return jsonValueMarker
  }
  if (typeof node.$ref === 'string') {
    const target = resolveLocalRef(root, node.$ref)
    if (isJsonValueDefinition(target)) {
      return jsonValueMarker
    }
    if (target !== undefined && !seenRefs.has(node.$ref)) {
      return normalizeJsonSchema(target, root, new Set([...seenRefs, node.$ref]))
    }
  }
  const normalized: Record<string, unknown> = {}
  if (node['x-aurora-string-trimmed'] === true && node.pattern === undefined) {
    normalized.pattern = '^(?!\\s)(?:[\\s\\S]*\\S)?$'
  }
  if (node['x-aurora-string-non-blank'] === true && node.pattern === undefined) {
    normalized.pattern = '^(?=.*\\S)[\\s\\S]*$'
  }
  for (const [key, value] of Object.entries(node).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    if (value === undefined) {
      continue
    }
    if (
      [
        '$defs',
        'title',
        'description',
        'x-aurora-extra-behavior',
        'x-aurora-projection-page-termination',
        'x-aurora-string-non-blank',
        'x-aurora-string-trimmed',
        'x-aurora-unique-string-array-normalize'
      ].includes(key)
    ) {
      continue
    }
    if (key === '$schema') {
      normalized[key] = value
      continue
    }
    normalized[key] = normalizeJsonSchema(value, root, seenRefs)
  }
  if (normalized.additionalProperties === false) {
    delete normalized.additionalProperties
  }
  if (normalized.type === 'number' && normalized.multipleOf === 1) {
    normalized.type = 'integer'
    delete normalized.multipleOf
  }
  if (Array.isArray(normalized.required)) {
    normalized.required = [...normalized.required].sort()
  }
  if (Array.isArray(normalized.enum)) {
    normalized.enum = [...normalized.enum].sort()
  }
  if (
    normalized.properties &&
    typeof normalized.properties === 'object' &&
    !Array.isArray(normalized.properties) &&
    Object.keys(normalized.properties).length === 0
  ) {
    delete normalized.properties
  }
  return normalized
}

const encodeRfc3986 = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )

const canonicalToolGlobalId = (stablePeerId: string, toolContractId: string) =>
  `aurora-tool:v1:${encodeRfc3986(stablePeerId)}:Tooling:${encodeRfc3986(toolContractId)}`

const escapeAscii = (value: string): string => {
  let escaped = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    escaped += code > 0x7F ? `\\u${code.toString(16).padStart(4, '0')}` : value.charAt(index)
  }
  return escaped
}

const canonicalJson = (value: unknown, ensureAscii = false): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, ensureAscii)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => {
        const encodedKey = JSON.stringify(key)
        return `${ensureAscii ? escapeAscii(encodedKey) : encodedKey}:${canonicalJson(item, ensureAscii)}`
      })
      .join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) {
    throw new Error('Value is not JSON serializable')
  }
  return ensureAscii ? escapeAscii(encoded) : encoded
}

const sha256Json = (value: unknown, ensureAscii = false) =>
  createHash('sha256').update(canonicalJson(value, ensureAscii)).digest('hex')

const sha256ProviderJson = (value: unknown) => sha256Json(value, true)

const computeToolSchemaHash = (tool: Record<string, unknown>) =>
  sha256Json({
    args_schema: tool.args_schema,
    schema: tool.schema,
    argument_visibility: tool.argument_visibility
  })

const computeProjectionPageHash = (page: Record<string, unknown>) =>
  sha256Json({
    provider_peer_id: page.provider_peer_id,
    service_instance_id: page.service_instance_id,
    selected_protocol_tier: page.selected_protocol_tier,
    authority_revision: page.authority_revision,
    projection_revision: page.projection_revision,
    projection_digest: page.projection_digest,
    page_index: page.page_index,
    page_size: page.page_size,
    tools: page.tools,
    blocked_tools: page.blocked_tools,
    retirements: page.retirements,
    complete: page.complete,
    total_count: page.total_count,
    final_checksum: page.final_checksum
  })

const computeProjectionChecksum = (value: {
  canonical_tools: unknown[]
  canonical_blocked_tools: unknown[]
  canonical_retirements: unknown[]
}) =>
  sha256Json({
    tools: value.canonical_tools,
    blocked_tools: value.canonical_blocked_tools,
    retirements: value.canonical_retirements
  })

describe('generated backend contracts', () => {
  it('parses generated positive vectors and matches Pydantic normalization', () => {
    for (const item of contractSchema.schemas as ContractSchemaItem[]) {
      const vector = item.vectors.positive
      if (!vector) {
        continue
      }
      const schema = backendContractSchemaById[item.schema_id]
      expect(normalizeJsonValue(schema.parse(vector.input)), item.schema_id).toEqual(
        normalizeJsonValue(vector.normalized)
      )
    }
  })

  it('rejects generated negative vectors on the same paths as Pydantic', () => {
    for (const item of contractSchema.schemas as ContractSchemaItem[]) {
      const vectors = item.vectors.negative_cases ?? (item.vectors.negative ? [item.vectors.negative] : [])
      if (vectors.length === 0) {
        continue
      }
      const schema = backendContractSchemaById[item.schema_id]
      for (const vector of vectors) {
        const result = schema.safeParse(vector.input)
        expect(result.success, `${item.schema_id} ${vector.issue_path}`).toBe(false)
        if (!result.success) {
          expect(result.error.issues.map((issue) => toIssuePath(issue.path)), item.schema_id).toContain(
            vector.issue_path
          )
        }
      }
    }
  })

  it('round-trips every generated Zod schema to draft 2020-12 JSON Schema', () => {
    for (const item of contractSchema.schemas as ContractSchemaItem[]) {
      const generated = z.toJSONSchema(backendContractSchemaById[item.schema_id], {
        target: 'draft-2020-12',
        unrepresentable: 'throw',
        io: item.direction === 'input' ? 'input' : 'output'
      }) as Record<string, unknown>
      expect(generated.$schema, item.schema_id).toBe('https://json-schema.org/draft/2020-12/schema')
      expect(normalizeJsonSchema(generated), item.schema_id).toEqual(
        normalizeJsonSchema({
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          ...item.schema
        })
      )
      expect(collectAuroraMetadata(generated), item.schema_id).toEqual(
        collectAuroraMetadata({
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          ...item.schema
        })
      )
      const extraBehavior = collectExtraBehavior(item.schema)
      expect(extraBehavior, item.schema_id).toEqual(expect.arrayContaining(['strip']))
      expect(extraBehavior, item.schema_id).not.toContain('forbid')
    }
  })

  it('still strips undeclared input fields at runtime', () => {
    const execute = ToolingExecuteToolInputToolingExecuteToolRequestSchema.parse({
      tool_name: 'echo',
      arguments: { message: 'hello', unicode: 'snowman \u2603' },
      dry_run: true,
      unexpected: 'stripped'
    })

    expect(execute).toMatchObject({
      tool_name: 'echo',
      arguments: { message: 'hello', unicode: 'snowman \u2603' },
      dry_run: true,
      confirmed: false
    })
    expect(execute).not.toHaveProperty('unexpected')
  })

  it('rejects non-finite and out-of-range numeric payloads', () => {
    expect(ToolingGetToolsInputToolingGetToolsRequestSchema.parse({ top_k: 2 ** 53 - 1 }).top_k).toBe(2 ** 53 - 1)
    expect(ToolingGetToolsInputToolingGetToolsRequestSchema.safeParse({ top_k: 2 ** 53 }).success).toBe(false)
    expect(ToolingGetToolsInputToolingGetToolsRequestSchema.safeParse({ top_k: -(2 ** 53) }).success).toBe(false)
    expect(ToolingGetToolsInputToolingGetToolsRequestSchema.safeParse({ top_k: Number.NaN }).success).toBe(false)
    expect(ToolingGetToolsInputToolingGetToolsRequestSchema.safeParse({ top_k: Number.POSITIVE_INFINITY }).success).toBe(false)
  })

  it('keeps manifest and local provider identities stable', () => {
    expect(contractSchema.allowlist).toEqual([
      'Tooling.GetTools',
      'Tooling.GetExportCatalog',
      'Tooling.PrepareExecution',
      'Tooling.ExecuteTool',
    ])
    expect(manifest.generator_format_version).toBe('aurora-sdk-zod-codegen-v1')
    expect(manifest.zod_version).toBe('4.4.3')
    expect(providerInventory.provider_service_instance_id).toBe('local:aurora-sdk-local-provider-v1:Tooling')
    expect(providerInventory.methods.map((method: ProviderMethod) => method.method_id)).toEqual(contractSchema.allowlist)
    const providerMethods = Object.fromEntries(providerInventory.methods.map((method: ProviderMethod) => [method.method_id, method]))
    expect(providerMethods['Tooling.GetExportCatalog'].required_permission).toBe('Tooling.GetTools')
    expect(providerMethods['Tooling.PrepareExecution'].required_permission).toBe('Tooling.ExecuteTool')
    expect(providerInventory.canonical_digest_vectors.identity_digest.reordered_json_a).not.toEqual(
      providerInventory.canonical_digest_vectors.identity_digest.reordered_json_b
    )
    expect(providerInventory.canonical_digest_vectors.schema_digest.reordered_json_a).not.toEqual(
      providerInventory.canonical_digest_vectors.schema_digest.reordered_json_b
    )
    expect(providerInventory.canonical_digest_vectors.identity_digest.digest).toBe(
      sha256ProviderJson(providerInventory.canonical_digest_vectors.identity_digest.canonical_a)
    )
    expect(providerInventory.canonical_digest_vectors.identity_digest.digest).toBe(
      sha256ProviderJson(providerInventory.canonical_digest_vectors.identity_digest.canonical_b)
    )
    expect(providerInventory.canonical_digest_vectors.schema_digest.digest).toBe(
      sha256ProviderJson(providerInventory.canonical_digest_vectors.schema_digest.canonical_a)
    )
    expect(providerInventory.canonical_digest_vectors.schema_digest.digest).toBe(
      sha256ProviderJson(providerInventory.canonical_digest_vectors.schema_digest.canonical_b)
    )
    expect(providerInventory.methods.some((method: Record<string, unknown>) => 'tool_id' in method)).toBe(false)
    expect(providerInventory.canonical_digest_vectors.canonical_tool_identity.global_tool_id).toBe(
      canonicalToolGlobalId('peer \u2603', 'core.memory/upsert \u2603')
    )
    for (const item of providerInventory.canonical_digest_vectors.canonical_tool_identity_cases) {
      expect(item.global_tool_id).toBe(canonicalToolGlobalId(item.stable_peer_id, item.tool_contract_id))
    }
    for (const item of providerInventory.canonical_digest_vectors.canonical_digest_cases) {
      expect(item.digest).toBe(sha256ProviderJson(item.canonical_a))
      expect(item.digest).toBe(sha256ProviderJson(item.canonical_b))
    }
    const tool = providerInventory.canonical_digest_vectors.tool_schema_hash.canonical_tool
    expect(providerInventory.canonical_digest_vectors.tool_schema_hash.digest).toBe(computeToolSchemaHash(tool))
    const page = providerInventory.canonical_digest_vectors.page_hash.canonical_page
    expect(providerInventory.canonical_digest_vectors.page_hash.digest).toBe(computeProjectionPageHash(page))
    expect(providerInventory.canonical_digest_vectors.final_checksum.digest).toBe(
      computeProjectionChecksum(providerInventory.canonical_digest_vectors.final_checksum)
    )
    expect(providerInventory.canonical_digest_vectors.order_independent_final_checksum.digest).toBe(
      computeProjectionChecksum(providerInventory.canonical_digest_vectors.order_independent_final_checksum)
    )
  })
})

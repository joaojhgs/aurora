import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'

import {
  backendContractEventDescriptorByTopic,
  backendContractEventDescriptors,
  backendContractEnvelopeDescriptorByTopic,
  backendContractEnvelopeDescriptors,
  backendContractMethodDescriptorById,
  backendContractMethodDescriptors,
  backendContractSchemaById,
  GatewayExplainRouteInputRouteExplainRequestSchema,
  TTSGetCapabilitiesOutputTTSGetCapabilitiesResponseSchema,
  ToolingExecuteToolInputToolingExecuteToolRequestSchema,
  ToolingGetExportCatalogOutputToolingGetExportCatalogResponseSchema,
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
  schema_hash: string
  schema: Record<string, unknown>
  vectors: {
    positive?: { accepted: true; input: unknown; normalized: unknown }
    positive_cases?: { accepted: true; input: unknown; normalized: unknown }[]
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
  'x-aurora-projection-identity',
  'x-aurora-projection-page-termination',
  'x-aurora-bounded-nonblank-string-set-normalize',
  'x-aurora-logical-voice-array-normalize',
  'x-aurora-route-explain-no-raw-payload',
  'x-aurora-route-explain-selector-fields',
  'x-aurora-route-explain-speech-no-raw-payload',
  'x-aurora-speech-language-array-normalize',
  'x-aurora-speech-language-auto-null',
  'x-aurora-speech-language-requirement',
  'x-aurora-speech-language-string-normalize',
  'x-aurora-speech-locale-fallback',
  'x-aurora-speech-method-constraints',
  'x-aurora-string-non-blank',
  'x-aurora-string-trimmed',
  'x-aurora-tts-capabilities-invariant',
  'x-aurora-tts-create-profile-response-invariant',
  'x-aurora-tts-delete-profile-request-invariant',
  'x-aurora-tts-delete-profile-response-invariant',
  'x-aurora-tts-get-profile-response-invariant',
  'x-aurora-tts-import-chunk-request-invariant',
  'x-aurora-tts-import-chunk-response-invariant',
  'x-aurora-tts-import-start-response-invariant',
  'x-aurora-tts-audio-chunk-event-invariant',
  'x-aurora-tts-operation-id',
  'x-aurora-tts-profile-descriptor-invariant',
  'x-aurora-tts-profile-list-invariant',
  'x-aurora-tts-profile-mutation-response-invariant',
  'x-aurora-tts-update-profile-patch-invariant',
  'x-aurora-tts-voice-descriptor-invariant',
  'x-aurora-tts-voice-list-invariant',
  'x-aurora-stt-transcribe-language-shape',
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
      const resolved = normalizeJsonSchema(target, root, new Set([...seenRefs, node.$ref]))
      const siblings = Object.fromEntries(
        Object.entries(node).filter(([key, value]) => key !== '$ref' && value !== undefined)
      )
      if (Object.keys(siblings).length === 0 || !resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
        return resolved
      }
      return normalizeJsonSchema({ ...(resolved as Record<string, unknown>), ...siblings }, root, seenRefs)
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
        'x-aurora-bounded-nonblank-string-set-normalize',
        'x-aurora-logical-voice-array-normalize',
        'x-aurora-projection-identity',
        'x-aurora-projection-page-termination',
        'x-aurora-route-explain-no-raw-payload',
        'x-aurora-route-explain-selector-fields',
        'x-aurora-route-explain-speech-no-raw-payload',
        'x-aurora-speech-language-array-normalize',
        'x-aurora-speech-language-auto-null',
        'x-aurora-speech-language-requirement',
        'x-aurora-speech-language-string-normalize',
        'x-aurora-speech-locale-fallback',
        'x-aurora-speech-method-constraints',
        'x-aurora-string-non-blank',
        'x-aurora-string-trimmed',
        'x-aurora-tts-capabilities-invariant',
        'x-aurora-tts-create-profile-response-invariant',
        'x-aurora-tts-delete-profile-request-invariant',
        'x-aurora-tts-delete-profile-response-invariant',
        'x-aurora-tts-get-profile-response-invariant',
        'x-aurora-tts-import-chunk-request-invariant',
        'x-aurora-tts-import-chunk-response-invariant',
        'x-aurora-tts-import-start-response-invariant',
        'x-aurora-tts-audio-chunk-event-invariant',
        'x-aurora-tts-operation-id',
        'x-aurora-tts-profile-descriptor-invariant',
        'x-aurora-tts-profile-list-invariant',
        'x-aurora-tts-profile-mutation-response-invariant',
        'x-aurora-tts-update-profile-patch-invariant',
        'x-aurora-tts-voice-descriptor-invariant',
        'x-aurora-tts-voice-list-invariant',
        'x-aurora-stt-transcribe-language-shape',
        'x-aurora-unique-string-array-normalize'
      ].includes(key)
    ) {
      continue
    }
    if (key === 'minProperties' || key === 'maxProperties') {
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
      for (const extra of item.vectors.positive_cases ?? []) {
        expect(normalizeJsonValue(schema.parse(extra.input)), item.schema_id).toEqual(
          normalizeJsonValue(extra.normalized)
        )
      }
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
      expect(new Set(collectExtraBehavior(generated)), item.schema_id).toEqual(
        new Set(collectExtraBehavior(item.schema))
      )
    }
  })

  it('rejects RouteExplain raw payload fields without echoing submitted values', () => {
    const rawSecret = 'secret text that must not appear in issues'
    const cases = [
      {
        payload: { topic: 'TTS.Request', nested: { messages: rawSecret } },
        path: 'messages'
      },
      {
        payload: { topic: 'TTS.Request', selector: { peer_id: 'peer-1', raw_peer: rawSecret } },
        path: 'selector'
      },
      {
        payload: { topic: 'TTS.Request', speech: { input: rawSecret } },
        path: 'speech'
      }
    ]

    for (const item of cases) {
      const result = GatewayExplainRouteInputRouteExplainRequestSchema.safeParse(item.payload)
      expect(result.success, item.path).toBe(false)
      if (!result.success) {
        const issueText = JSON.stringify(result.error.issues)
        expect(issueText).toContain(item.path)
        expect(issueText).not.toContain(rawSecret)
      }
    }
  })

  it('materializes speech language requirement defaults before digesting', () => {
    const parsed = GatewayExplainRouteInputRouteExplainRequestSchema.parse({
      topic: 'TTS.Request',
      speech: {
        language_requirement: {
          mode: 'exact',
          language: 'EN'
        }
      }
    }) as {
      speech?: {
        language_requirement?: {
          auto_language_candidates?: string[]
          digest?: string | null
        } | null
      } | null
    }

    expect(parsed.speech?.language_requirement?.auto_language_candidates).toEqual([])
    expect(parsed.speech?.language_requirement?.digest).toBe(
      'a3214d460e738357e872cdb92c328bd9c44b282acf6e2ca1d0104184528d0037'
    )
  })

  it('materializes TTS capability output format defaults before readiness checks', () => {
    const parsed = TTSGetCapabilitiesOutputTTSGetCapabilitiesResponseSchema.parse({
      capabilities: {
        ready: true,
        model_status: 'ready',
        supported_language_pack_ids: ['base', 'base'],
        installed_language_pack_ids: ['base'],
        resident_language_pack_ids: ['base'],
        resident_language_packs: [{ pack_id: 'base', ready_languages: ['en'] }],
        ready_languages: ['en'],
        sample_rates: [24000, 16000, 24000],
        resident_base_model_count: 1
      }
    }) as {
      capabilities: {
        output_formats?: string[]
        sample_rates?: number[]
        supported_language_pack_ids?: string[]
      }
    }

    expect(parsed.capabilities.output_formats).toEqual(['wav', 'raw'])
    expect(parsed.capabilities.sample_rates).toEqual([16000, 24000])
    expect(parsed.capabilities.supported_language_pack_ids).toEqual(['base'])
    expect(
      TTSGetCapabilitiesOutputTTSGetCapabilitiesResponseSchema.safeParse({
        capabilities: { ready: true, model_status: 'ready' }
      }).success
    ).toBe(false)
  })

  it('normalizes exact and automatic speech language inputs like Pydantic', () => {
    const ttsSchema = backendContractSchemaById['TTS.Synthesize.input.TTSSynthesizeRequest']
    expect(ttsSchema.parse({ text: 'hello', language: ' EN ' })).toMatchObject({ language: 'en' })
    expect(ttsSchema.parse({ text: 'hello', language: '   ' })).toMatchObject({ language: null })
    expect(ttsSchema.safeParse({ text: 'hello', language: 'auto' }).success).toBe(false)
    expect(ttsSchema.safeParse({ text: 'hello', language: 'pt-BR' }).success).toBe(false)
    expect(ttsSchema.safeParse({ text: 'hello', language: 'pt_BR' }).success).toBe(false)

    const sttSchema = backendContractSchemaById['Transcription.Transcribe.input.TranscribeAudioRequest']
    expect(
      sttSchema.parse({
        audio_data: 'AA==',
        language: ' AUTO ',
        auto_language_candidates: [' EN ', 'de', 'en']
      })
    ).toMatchObject({
      language: null,
      auto_language_candidates: ['de', 'en']
    })
    expect(
      sttSchema.safeParse({
        audio_data: 'AA==',
        language: 'en',
        auto_language_candidates: ['de', 'en']
      }).success
    ).toBe(false)
  })

  it('rejects stale speech language requirement digests', () => {
    expect(
      GatewayExplainRouteInputRouteExplainRequestSchema.safeParse({
        topic: 'TTS.Request',
        speech: {
          language_requirement: {
            mode: 'exact',
            language: 'en',
            digest: '0'.repeat(64)
          }
        }
      }).success
    ).toBe(false)
  })

  it('normalizes mutation identifiers and bounded peer sets before validation', () => {
    const installSchema = backendContractSchemaById['TTS.InstallVoiceProfile.input.TTSInstallVoiceProfileRequest']
    expect(
      installSchema.parse({
        operation_id: ' operation-1 ',
        voice_id: 'standard:starter:voice'
      })
    ).toMatchObject({ operation_id: 'operation-1' })
    expect(
      installSchema.safeParse({
        operation_id: ` ${'a'.repeat(127)} `,
        voice_id: 'standard:starter:voice'
      }).success
    ).toBe(false)

    const updateSchema = backendContractSchemaById['TTS.UpdateVoiceProfile.input.TTSUpdateVoiceProfileRequest']
    expect(
      updateSchema.parse({
        operation_id: 'update-1',
        voice_id: 'standard:starter:voice',
        visibility: 'allowed_peers',
        allowed_peer_ids: ['peer-b', 'peer-a', 'peer-b']
      })
    ).toMatchObject({ allowed_peer_ids: ['peer-a', 'peer-b'] })
    expect(
      updateSchema.safeParse({
        operation_id: 'update-1',
        voice_id: 'standard:starter:voice',
        visibility: 'private',
        allowed_peer_ids: ['peer-a']
      }).success
    ).toBe(false)
  })

  it('enforces clone-only create and delete response identities', () => {
    const cloneVoice = 'clone:123e4567-e89b-42d3-a456-426614174000'
    const standardVoice = 'standard:starter:voice'
    const createSchema = backendContractSchemaById['TTS.CreateVoiceProfile.output.TTSCreateVoiceProfileResponse']
    const deleteSchema = backendContractSchemaById['TTS.DeleteVoiceProfile.output.TTSDeleteVoiceProfileResponse']

    expect(
      createSchema.safeParse({ status: 'created', voice_id: cloneVoice, revision: 'revision-1' }).success
    ).toBe(true)
    expect(
      createSchema.safeParse({ status: 'created', voice_id: standardVoice, revision: 'revision-1' }).success
    ).toBe(false)
    expect(
      createSchema.safeParse({ status: 'created', voice_id: cloneVoice, revision: null }).success
    ).toBe(false)
    expect(
      deleteSchema.safeParse({ status: 'deleted', voice_id: cloneVoice, revision: 'revision-2' }).success
    ).toBe(true)
    expect(
      deleteSchema.safeParse({ status: 'deleted', voice_id: standardVoice, revision: 'revision-2' }).success
    ).toBe(false)
    expect(
      deleteSchema.safeParse({ status: 'deleted', voice_id: cloneVoice, revision: null }).success
    ).toBe(false)
  })

  it('enforces TTS profile descriptor invariants', () => {
    const schema = backendContractSchemaById['TTS.GetVoiceProfile.output.TTSGetVoiceProfileResponse']
    const profile = {
      voice_id: 'clone:123e4567-e89b-42d3-a456-426614174000',
      kind: 'cloned',
      display_name: 'Clone',
      revision: 'revision-1'
    }
    expect(schema.safeParse({ found: true, profile }).success).toBe(true)
    expect(schema.safeParse({ found: false, profile }).success).toBe(false)
    expect(
      schema.safeParse({
        found: true,
        profile: { ...profile, kind: 'standard' }
      }).success
    ).toBe(false)
  })

  it('rejects malformed, empty, oversized, and hash-mismatched voice import chunks', () => {
    const schema = backendContractSchemaById['TTS.VoiceImportChunk.input.TTSVoiceImportChunkRequest']
    const toBase64 = (value: Uint8Array): string => {
      let binary = ''
      for (const byte of value) binary += String.fromCharCode(byte)
      return btoa(binary)
    }
    const bytes = new TextEncoder().encode('hello')
    const valid = {
      operation_id: 'chunk-1',
      upload_id: 'upload-1',
      sequence: 0,
      chunk_data: toBase64(bytes),
      chunk_sha256: createHash('sha256').update(bytes).digest('hex')
    }

    expect(schema.safeParse(valid).success).toBe(true)
    expect(schema.safeParse({ ...valid, chunk_data: '!!!!' }).success).toBe(false)
    expect(schema.safeParse({ ...valid, chunk_data: '' }).success).toBe(false)
    expect(schema.safeParse({ ...valid, chunk_sha256: '0'.repeat(64) }).success).toBe(false)
    const oversized = new Uint8Array(49_153)
    expect(
      schema.safeParse({
        ...valid,
        chunk_data: toBase64(oversized),
        chunk_sha256: createHash('sha256').update(oversized).digest('hex')
      }).success
    ).toBe(false)
  })

  it('accepts STT audio chunk binary-format fields as strings', () => {
    for (const schemaId of [
      'WakeWord.ProcessAudio.input.STTAudioChunk',
      'Transcription.ProcessAudio.input.STTAudioChunk'
    ] as const) {
      const parsed = backendContractSchemaById[schemaId].parse({
        data: '\u0000normal UTF-8 text',
        channels: 1,
        sample_rate: 16000
      })
      expect(parsed).toMatchObject({
        data: '\u0000normal UTF-8 text',
        format: 'pcm_s16le'
      })
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

  it('matches Pydantic Unicode code-point bounds at the projection boundary', () => {
    const providerPeerId = '😀'.repeat(100)
    const page = {
      ok: true,
      reason_code: null,
      provider_peer_id: providerPeerId,
      service_instance_id: `remote:${providerPeerId}:Tooling`,
      selected_protocol_tier: 'projection_v1',
      authority_revision: {
        catalog_revision: 1,
        export_policy_revision: 1,
        auth_grant_revision: 1,
        manifest_revision: 1,
        switch_revision: 1,
        protocol_revision: 1
      },
      projection_revision: 'unicode-boundary',
      projection_digest: '1'.repeat(64),
      page_index: 0,
      page_size: 1,
      page_hash: '2'.repeat(64),
      tools: [],
      blocked_tools: [],
      retirements: [],
      next_cursor: null,
      complete: true,
      total_count: 0,
      final_checksum: '3'.repeat(64)
    }

    expect(
      ToolingGetExportCatalogOutputToolingGetExportCatalogResponseSchema.safeParse(page).success
    ).toBe(true)
    expect(
      ToolingGetExportCatalogOutputToolingGetExportCatalogResponseSchema.safeParse({
        ...page,
        provider_peer_id: 'a'.repeat(161),
        service_instance_id: `remote:${'a'.repeat(161)}:Tooling`
      }).success
    ).toBe(false)
  })

  it('matches Pydantic Unicode code-point bounds for normalized legacy IDs', () => {
    const item = (contractSchema.schemas as ContractSchemaItem[]).find(
      (candidate) =>
        candidate.method_id === 'Tooling.GetTools'
        && candidate.direction === 'output'
        && candidate.model_name === 'ToolingGetToolsResponse'
    )
    expect(item?.vectors.positive).toBeDefined()

    const input = structuredClone(item!.vectors.positive!.input) as {
      tools: Array<Record<string, unknown>>
    }
    const schema = backendContractSchemaById[item!.schema_id]
    input.tools[0]!.legacy_global_tool_ids = ['😀'.repeat(512)]
    expect(schema.safeParse(input).success).toBe(true)

    input.tools[0]!.legacy_global_tool_ids = ['😀'.repeat(513)]
    expect(schema.safeParse(input).success).toBe(false)
  })

  it('keeps manifest and local provider identities stable', () => {
    expect(contractSchema.allowlist).toEqual([
      'Tooling.GetTools',
      'Tooling.GetExportCatalog',
      'Tooling.PrepareExecution',
      'Tooling.ExecuteTool',
      'Gateway.ExplainRoute',
      'Orchestrator.ExternalUserInput',
      'Orchestrator.Interrupt',
      'TTS.GetCapabilities',
      'TTS.ListVoices',
      'TTS.ListLanguagePacks',
      'TTS.ListVoiceProfiles',
      'TTS.GetVoiceProfile',
      'TTS.UpdateVoiceProfile',
      'TTS.InstallVoiceProfile',
      'TTS.RemoveVoiceProfile',
      'TTS.SetDefaultVoice',
      'TTS.VoiceImportStart',
      'TTS.VoiceImportChunk',
      'TTS.VoiceImportEnd',
      'TTS.VoiceImportAbort',
      'TTS.CreateVoiceProfile',
      'TTS.DeleteVoiceProfile',
      'TTS.Request',
      'TTS.StreamStart',
      'TTS.StreamChunk',
      'TTS.StreamEnd',
      'TTS.Synthesize',
      'STTCoordinator.Listen',
      'STTCoordinator.StopListening',
      'STTCoordinator.CapturePrepare',
      'STTCoordinator.CaptureRelease',
      'STTCoordinator.CaptureStatus',
      'WakeWord.ProcessAudio',
      'WakeWord.Detect',
      'Transcription.ProcessAudio',
      'Transcription.Transcribe',
    ])
    expect(contractSchema.schemas).toHaveLength(76)
    expect(contractSchema.method_descriptors).toHaveLength(36)
    expect(contractSchema.event_descriptors).toHaveLength(3)
    expect(contractSchema.envelope_descriptors).toHaveLength(1)
    expect(contractSchema.tooling_provider_allowlist).toHaveLength(4)
    const descriptors = Object.fromEntries(
      contractSchema.method_descriptors.map((descriptor: Record<string, unknown>) => [
        descriptor.method_id,
        descriptor
      ])
    ) as Record<string, Record<string, unknown>>
    for (const methodId of ['TTS.StreamStart', 'TTS.StreamChunk', 'TTS.StreamEnd']) {
      expect(descriptors[methodId]?.streaming).toEqual({
        rpc_kind: 'unary',
        ordered_command_group: 'tts_text_stream',
        request_stream: false,
        response_stream: false,
        event_topic: 'TTS.AudioChunk'
      })
    }
    const eventDescriptor = backendContractEventDescriptorByTopic['TTS.AudioChunk']
    const eventSchema = contractSchema.schemas.find(
      (item: ContractSchemaItem) => item.schema_id === 'TTS.AudioChunk.event.TTSAudioChunkEvent'
    )
    expect(eventDescriptor).toEqual({
      event_topic: 'TTS.AudioChunk',
      module: 'TTS',
      name: 'AudioChunk',
      topic: 'TTS.AudioChunk',
      model: 'TTSAudioChunkEvent',
      schema_id: 'TTS.AudioChunk.event.TTSAudioChunkEvent',
      schema_hash: eventSchema?.schema_hash,
      required_permission: 'TTS.use',
      required_perms: ['TTS.use'],
      bounded: true,
      authorized: true,
      ordered_event_group: 'tts_text_stream',
      remote_raw_audio_route: false
    })
    expect(descriptors['Transcription.ProcessAudio']?.streaming).toEqual({
      rpc_kind: 'unary',
      ordered_command_group: null,
      request_stream: false,
      response_stream: false,
      event_topic: null
    })
    expect(descriptors['Orchestrator.ExternalUserInput']?.required_perms).toEqual(['Orchestrator.use'])
    expect(descriptors['Orchestrator.ExternalUserInput']?.route_path).toBe('/api/Orchestrator/ExternalUserInput')
    expect(descriptors['Orchestrator.Interrupt']?.required_perms).toEqual(['Orchestrator.use'])
    expect(backendContractEnvelopeDescriptors).toHaveLength(1)
    expect(backendContractEnvelopeDescriptorByTopic['Aurora.EventStream']).toEqual(
      contractSchema.envelope_descriptors[0]
    )
    expect(backendContractEnvelopeDescriptorByTopic['Aurora.EventStream']).toMatchObject({
      envelope_topic: 'Aurora.EventStream',
      descriptor_kind: 'sse_envelope',
      route_path: '/api/events/stream',
      required_permissions_broad: ['Gateway.manage'],
      required_permissions_scoped: ['Orchestrator.use'],
      scoped_topics: ['Orchestrator.Response', 'TTS.AudioChunk'],
      scoped_categories: ['assistant'],
      requires_correlation_id: true
    })
    expect(backendContractMethodDescriptorById).not.toHaveProperty('Aurora.EventStream')
    expect(backendContractMethodDescriptorById).not.toHaveProperty('Orchestrator.InferChat')
    expect(backendContractMethodDescriptorById).not.toHaveProperty('Orchestrator.StreamInferChat')
    expect(backendContractMethodDescriptorById).not.toHaveProperty('Gateway.ListEvents')
    for (const methodId of [
      'TTS.ListVoiceProfiles',
      'TTS.GetVoiceProfile',
      'TTS.UpdateVoiceProfile',
      'TTS.InstallVoiceProfile',
      'TTS.RemoveVoiceProfile',
      'TTS.SetDefaultVoice',
      'TTS.VoiceImportStart',
      'TTS.VoiceImportChunk',
      'TTS.VoiceImportEnd',
      'TTS.VoiceImportAbort',
      'TTS.CreateVoiceProfile',
      'TTS.DeleteVoiceProfile'
    ]) {
      expect(descriptors[methodId]?.method_type, methodId).toBe('manage')
      expect(descriptors[methodId]?.required_perms, methodId).toEqual(['TTS.manage'])
    }
    expect(manifest.generator_format_version).toBe('aurora-sdk-zod-codegen-v1')
    expect(manifest.zod_version).toBe('4.4.3')
    expect(providerInventory.provider_service_instance_id).toBe('local:aurora-sdk-local-provider-v1:Tooling')
    expect(providerInventory.methods.map((method: ProviderMethod) => method.method_id)).toEqual(contractSchema.tooling_provider_allowlist)
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

  it('keeps generated method descriptors aligned with SDK coverage and streaming metadata', () => {
    const descriptorIds = backendContractMethodDescriptors.map((descriptor) => descriptor.method_id)
    expect(descriptorIds).toEqual(contractSchema.allowlist)
    expect(new Set(descriptorIds).size).toBe(36)
    expect(Object.keys(backendContractMethodDescriptorById).sort()).toEqual([...descriptorIds].sort())

    for (const methodId of ['TTS.StreamStart', 'TTS.StreamChunk', 'TTS.StreamEnd'] as const) {
      expect(backendContractMethodDescriptorById[methodId].streaming).toEqual({
        rpc_kind: 'unary',
        ordered_command_group: 'tts_text_stream',
        request_stream: false,
        response_stream: false,
        event_topic: 'TTS.AudioChunk'
      })
    }
    for (const methodId of ['WakeWord.ProcessAudio', 'Transcription.ProcessAudio'] as const) {
      expect(backendContractMethodDescriptorById[methodId].streaming.ordered_command_group).toBeNull()
    }
    expect(backendContractMethodDescriptors.every((descriptor) => descriptor.speech_constraints === null)).toBe(true)
  })

  it('keeps generated event descriptors event-only and validates TTS audio chunks', () => {
    const eventDescriptor = backendContractEventDescriptorByTopic['TTS.AudioChunk']
    expect(backendContractEventDescriptors).toHaveLength(3)
    expect(eventDescriptor).toEqual(
      contractSchema.event_descriptors.find(
        (descriptor: Record<string, unknown>) => descriptor.event_topic === 'TTS.AudioChunk'
      )
    )
    expect(eventDescriptor.schema_id).toBe('TTS.AudioChunk.event.TTSAudioChunkEvent')
    expect(eventDescriptor.required_permission).toBe('TTS.use')
    expect(eventDescriptor.remote_raw_audio_route).toBe(false)
    expect(backendContractMethodDescriptorById).not.toHaveProperty('TTS.AudioChunk')
    expect(backendContractEventDescriptorByTopic['Orchestrator.Response']).toMatchObject({
      event_topic: 'Orchestrator.Response',
      model: 'AssistantStreamEvent',
      required_permission: 'Orchestrator.use',
      ordered_event_group: 'assistant_stream',
      remote_raw_audio_route: false
    })
    expect(backendContractEventDescriptorByTopic['Orchestrator.Interrupted']).toMatchObject({
      event_topic: 'Orchestrator.Interrupted',
      model: 'OrchestratorInterruptedEvent',
      required_permission: 'Orchestrator.use',
      ordered_event_group: 'assistant_interrupt',
      remote_raw_audio_route: false
    })

    const schema = backendContractSchemaById['TTS.AudioChunk.event.TTSAudioChunkEvent']
    expect(schema.safeParse({
      stream_id: 'stream-1',
      sequence: 1,
      source_sequence: 0,
      audio_data: '',
      format: 'raw',
      sample_rate: 0,
      channels: 1,
      duration_ms: 0,
      is_final: true,
      reason: 'completed'
    }).success).toBe(true)
    expect(schema.safeParse({
      stream_id: 'stream-1',
      sequence: 1,
      source_sequence: 0,
      audio_data: '',
      format: 'raw',
      sample_rate: 24000,
      channels: 1,
      duration_ms: 1,
      is_final: false
    }).success).toBe(false)
    expect(schema.safeParse({
      stream_id: 'stream-1',
      sequence: 2 ** 53,
      audio_data: 'AA==',
      format: 'raw',
      sample_rate: 24000,
      channels: 1,
      duration_ms: 1
    }).success).toBe(false)
    expect(schema.safeParse({
      stream_id: 'stream-1',
      sequence: 0,
      source_sequence: 2 ** 53,
      audio_data: 'AA==',
      format: 'raw',
      sample_rate: 24000,
      channels: 1,
      duration_ms: 1
    }).success).toBe(false)
    expect(schema.safeParse({
      stream_id: 'stream-1',
      sequence: 0,
      audio_data: 'AA==',
      format: 'raw',
      sample_rate: 192001,
      channels: 1,
      duration_ms: 1
    }).success).toBe(false)
    expect(schema.safeParse({
      stream_id: 'stream-1',
      sequence: 0,
      audio_data: 'AA==',
      format: 'raw',
      sample_rate: 24000,
      channels: 9,
      duration_ms: 1
    }).success).toBe(false)
  })
})

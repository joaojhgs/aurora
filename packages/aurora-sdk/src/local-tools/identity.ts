import { canonicalJsonSha256Hex } from './canonical-json.js'
import type { LocalToolDescriptorV1 } from './descriptor-v1.js'

const textEncoder = new TextEncoder()
const ID_SAFE_BYTES = new Set([
  0x2D, // -
  0x2E, // .
  0x5F, // _
  0x7E // ~
])
const HEX = '0123456789ABCDEF'

export class LocalToolIdentityError extends Error {
  readonly reasonCode: string

  constructor(reasonCode: string, message = `Invalid local tool identity: ${reasonCode}`) {
    super(message)
    this.name = 'LocalToolIdentityError'
    this.reasonCode = reasonCode
  }
}

export function percentEncodeRfc3986Utf8(value: string): string {
  assertIdentityComponent(value)
  let encoded = ''
  for (const byte of textEncoder.encode(value)) {
    if (
      (byte >= 0x30 && byte <= 0x39)
      || (byte >= 0x41 && byte <= 0x5A)
      || (byte >= 0x61 && byte <= 0x7A)
      || ID_SAFE_BYTES.has(byte)
    ) {
      encoded += String.fromCharCode(byte)
    } else {
      encoded += `%${HEX[(byte >> 4) & 0xF]}${HEX[byte & 0xF]}`
    }
  }
  return encoded
}

export function providerServiceInstanceId(stablePeerId: string): string {
  return `local:${percentEncodeRfc3986Utf8(stablePeerId)}:Tooling`
}

export function globalToolId(stablePeerId: string, toolContractId: string): string {
  return `aurora-tool:v1:${percentEncodeRfc3986Utf8(stablePeerId)}:Tooling:${percentEncodeRfc3986Utf8(toolContractId)}`
}

export const canonicalToolGlobalId = globalToolId

export function toolSchemaHash(input: {
  readonly args_schema: unknown
  readonly schema: unknown
  readonly argument_visibility: unknown
}): string {
  return canonicalJsonSha256Hex({
    args_schema: input.args_schema,
    schema: input.schema,
    argument_visibility: input.argument_visibility
  })
}

export function localToolDescriptorSchemaHash(descriptor: Pick<LocalToolDescriptorV1, 'argsSchema' | 'outputSchema' | 'argumentVisibility'>): string {
  return toolSchemaHash({
    args_schema: descriptor.argsSchema,
    schema: descriptor.outputSchema,
    argument_visibility: descriptor.argumentVisibility
  })
}

function assertIdentityComponent(value: string): void {
  if (value.length < 1 || value.length > 160) throw new LocalToolIdentityError('length')
  if (value !== value.trim()) throw new LocalToolIdentityError('not_trimmed')
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint < 0x20 || codePoint === 0x7F) throw new LocalToolIdentityError('control_character')
  }
}

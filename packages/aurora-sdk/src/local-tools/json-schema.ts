import type { JsonObject, JsonValue } from '../types.js'
import { assertCanonicalJsonValue } from './canonical-json.js'

const SUPPORTED_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems'
])

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

export class LocalToolJsonSchemaError extends Error {
  readonly reasonCode: string

  constructor(reasonCode: string, message = `Unsupported local tool JSON Schema: ${reasonCode}`) {
    super(message)
    this.name = 'LocalToolJsonSchemaError'
    this.reasonCode = reasonCode
  }
}

export function assertSupportedJsonSchema(schema: unknown, path = '$'): asserts schema is JsonObject {
  assertCanonicalJsonValue(schema)
  if (!isPlainRecord(schema)) throw new LocalToolJsonSchemaError('schema_not_object')
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYS.has(key)) throw new LocalToolJsonSchemaError(`unsupported_keyword:${path}.${key}`)
  }
  const type = schema.type
  if (type !== undefined && !(typeof type === 'string' && TYPES.has(type))) throw new LocalToolJsonSchemaError(`unsupported_type:${path}`)
  if (schema.properties !== undefined) {
    if (!isPlainRecord(schema.properties)) throw new LocalToolJsonSchemaError(`invalid_properties:${path}`)
    for (const [key, child] of Object.entries(schema.properties)) assertSupportedJsonSchema(child, `${path}.properties.${key}`)
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((item) => typeof item === 'string'))) {
    throw new LocalToolJsonSchemaError(`invalid_required:${path}`)
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new LocalToolJsonSchemaError(`unsupported_additional_properties:${path}`)
  }
  if (schema.items !== undefined) assertSupportedJsonSchema(schema.items, `${path}.items`)
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length > 256)) throw new LocalToolJsonSchemaError(`invalid_enum:${path}`)
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    const bound = schema[key]
    if (bound !== undefined && (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound < 0)) throw new LocalToolJsonSchemaError(`invalid_bound:${path}.${key}`)
  }
  for (const key of ['minimum', 'maximum'] as const) {
    if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]) || !Number.isSafeInteger(schema[key]))) {
      throw new LocalToolJsonSchemaError(`invalid_bound:${path}.${key}`)
    }
  }
}

export function validateJsonAgainstSchema(schema: JsonObject, value: JsonValue | undefined): string | null {
  try {
    assertSupportedJsonSchema(schema)
  } catch (error) {
    return error instanceof LocalToolJsonSchemaError ? error.reasonCode : 'unsupported_schema'
  }
  return validate(schema, value, '$')
}

function validate(schema: JsonObject, value: JsonValue | undefined, path: string): string | null {
  const enumValues = schema.enum
  if (Array.isArray(enumValues) && !enumValues.some((item) => item === value)) return `enum:${path}`
  if (typeof schema.type === 'string' && !matchesType(value, schema.type)) return `type:${path}`
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return `minLength:${path}`
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return `maxLength:${path}`
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `minimum:${path}`
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `maximum:${path}`
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `minItems:${path}`
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `maxItems:${path}`
    if (schema.items && isPlainRecord(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const reason = validate(schema.items, value[index], `${path}[${index}]`)
        if (reason) return reason
      }
    }
  }
  if (isPlainRecord(value)) {
    const properties = isPlainRecord(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return `required:${path}.${key}`
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) return `additionalProperties:${path}.${key}`
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key) && isPlainRecord(child)) {
        const reason = validate(child, value[key], `${path}.${key}`)
        if (reason) return reason
      }
    }
  }
  return null
}

function matchesType(value: JsonValue | undefined, type: string): boolean {
  if (type === 'null') return value === null
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return isPlainRecord(value)
  return false
}

function isPlainRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

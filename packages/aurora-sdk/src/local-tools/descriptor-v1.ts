import { z } from 'zod/v4'

import { assertCanonicalJsonValue, canonicalJsonSha256Hex } from './canonical-json.js'
import { globalToolId, localToolDescriptorSchemaHash, providerServiceInstanceId } from './identity.js'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u
const HANDLER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u
const PERMISSION_RE = /^[A-Za-z][A-Za-z0-9_:-]*(?:\.[A-Za-z][A-Za-z0-9_:-]*)+$/u
const TEXT_MAX = 2_048
const DESCRIPTION_MAX = 16_384
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const trimmedString = (max = TEXT_MAX) => z.string().min(1).max(max).refine((value) => value === value.trim(), {
  message: 'must be trimmed'
})

const descriptorId = trimmedString(160).regex(ID_RE)
const handlerId = trimmedString(160).regex(HANDLER_ID_RE)
const permissionId = trimmedString(160).regex(PERMISSION_RE)

const jsonSchemaValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.string(),
    z.number().finite().int().safe().refine((value) => !Object.is(value, -0)),
    z.array(jsonSchemaValue).max(10_000),
    z.record(z.string().min(1).max(256), jsonSchemaValue).superRefine((value, context) => {
      for (const key of Object.keys(value)) {
        if (UNSAFE_OBJECT_KEYS.has(key)) {
          context.addIssue({ code: 'custom', message: 'unsafe object key', path: [key] })
        }
      }
    })
  ])
)

const jsonSchemaObject = z.record(z.string().min(1).max(256), jsonSchemaValue)
  .refine((value) => Object.keys(value).length > 0, { message: 'schema must be a non-empty object' })
  .superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (UNSAFE_OBJECT_KEYS.has(key)) {
        context.addIssue({ code: 'custom', message: 'unsafe schema key', path: [key] })
      }
    }
    assertJsonSchemaSafe(value, context)
  })

const argumentVisibilitySchema = z.record(
  trimmedString(256),
  z.enum(['public', 'private', 'secret'])
).default({})

const nativeRequirementsSchema = z.strictObject({
  capabilityIds: z.array(descriptorId).max(128).default([]),
  osPermissions: z.array(descriptorId).max(128).default([])
})

const descriptorBaseSchema = z.strictObject({
  version: z.literal(1),
  toolContractId: descriptorId,
  localName: descriptorId,
  displayName: trimmedString(120),
  description: trimmedString(DESCRIPTION_MAX),
  argsSchema: jsonSchemaObject,
  outputSchema: jsonSchemaObject,
  argumentVisibility: argumentVisibilitySchema,
  requiredPermissions: z.array(permissionId).max(128).default([]),
  resourceScopes: z.array(descriptorId).max(128).default([]),
  safetyClass: z.enum(['standard', 'sensitive', 'dangerous']),
  privacyClass: descriptorId,
  mutating: z.boolean(),
  dataEgress: z.boolean(),
  nativeRequirements: nativeRequirementsSchema.default({ capabilityIds: [], osPermissions: [] }),
  confirmationPolicy: z.enum(['never', 'sensitive', 'always'])
})

export const localToolDescriptorV1Schema = descriptorBaseSchema.extend({
  handlerId
}).strict().superRefine(validateDescriptorPolicy)

export const remoteLocalToolDescriptorV1Schema = descriptorBaseSchema.strict().superRefine(validateDescriptorPolicy)

export type LocalToolDescriptorV1 = z.infer<typeof localToolDescriptorV1Schema>
export type RemoteLocalToolDescriptorV1 = z.infer<typeof remoteLocalToolDescriptorV1Schema>

export interface LocalToolProjectionIdentity {
  readonly providerPeerId: string
  readonly providerServiceInstanceId: string
  readonly globalToolId: string
  readonly schemaHash: string
  readonly descriptorHash: string
}

export function parseLocalToolDescriptorV1(value: unknown): LocalToolDescriptorV1 {
  return localToolDescriptorV1Schema.parse(value)
}

export function parseRemoteLocalToolDescriptorV1(value: unknown): RemoteLocalToolDescriptorV1 {
  return remoteLocalToolDescriptorV1Schema.parse(value)
}

export function publicLocalToolDescriptorV1(descriptor: LocalToolDescriptorV1): RemoteLocalToolDescriptorV1 {
  const { handlerId: _handlerId, ...publicDescriptor } = parseLocalToolDescriptorV1(descriptor)
  return parseRemoteLocalToolDescriptorV1(publicDescriptor)
}

export function localToolProjectionIdentity(stablePeerId: string, descriptor: LocalToolDescriptorV1): LocalToolProjectionIdentity {
  const normalized = parseLocalToolDescriptorV1(descriptor)
  return {
    providerPeerId: stablePeerId,
    providerServiceInstanceId: providerServiceInstanceId(stablePeerId),
    globalToolId: globalToolId(stablePeerId, normalized.toolContractId),
    schemaHash: localToolDescriptorSchemaHash(normalized),
    descriptorHash: canonicalJsonSha256Hex(publicLocalToolDescriptorV1(normalized))
  }
}

function validateDescriptorPolicy<T extends z.infer<typeof descriptorBaseSchema>>(descriptor: T, context: z.core.$RefinementCtx<T>): void {
  if (descriptor.safetyClass === 'dangerous' && descriptor.confirmationPolicy !== 'always') {
    context.addIssue({ code: 'custom', message: 'dangerous tools require always confirmation', path: ['confirmationPolicy'] })
  }
  if (descriptor.safetyClass === 'sensitive' && descriptor.confirmationPolicy === 'never') {
    context.addIssue({ code: 'custom', message: 'sensitive tools require confirmation', path: ['confirmationPolicy'] })
  }
  if (descriptor.argumentVisibility && !schemaHasProperties(descriptor.argsSchema)) {
    if (Object.keys(descriptor.argumentVisibility).length > 0) {
      context.addIssue({ code: 'custom', message: 'argument visibility requires object properties', path: ['argumentVisibility'] })
    }
  }
  const argsProperties = getSchemaProperties(descriptor.argsSchema)
  for (const key of Object.keys(descriptor.argumentVisibility ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(argsProperties, key)) {
      context.addIssue({ code: 'custom', message: 'argument visibility must reference argsSchema properties', path: ['argumentVisibility', key] })
    }
  }
}

function assertJsonSchemaSafe(value: unknown, context: z.core.$RefinementCtx<Record<string, unknown>>): void {
  try {
    assertCanonicalJsonValue(value)
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'schema is not canonical JSON safe'
    })
  }
}

function schemaHasProperties(schema: Record<string, unknown>): boolean {
  return Object.keys(getSchemaProperties(schema)).length > 0
}

function getSchemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {}
}

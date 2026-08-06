import type { z } from 'zod/v4'

import { AuroraError } from './errors.js'
import {
  backendContractMethodDescriptorById,
  backendContractSchemaById
} from './generated/backend-contracts.zod.js'
import { captureResult, type AuroraResponse } from './transport.js'
import type { AuroraTransportKind } from './types.js'
import {
  AuroraValidationError,
  parseBoundary,
  type AuroraValidationBoundaryKind
} from './validation/index.js'

type GeneratedDescriptorMap = typeof backendContractMethodDescriptorById
type GeneratedSchemaMap = typeof backendContractSchemaById

export type GeneratedBackendMethodId = keyof GeneratedDescriptorMap
export type GeneratedBackendMethodDescriptor<TMethodId extends GeneratedBackendMethodId> =
  GeneratedDescriptorMap[TMethodId]

type GeneratedInputSchemaId<TMethodId extends GeneratedBackendMethodId> = Extract<
  GeneratedBackendMethodDescriptor<TMethodId>['input_schema_id'],
  keyof GeneratedSchemaMap
>
type GeneratedOutputSchemaId<TMethodId extends GeneratedBackendMethodId> = Extract<
  GeneratedBackendMethodDescriptor<TMethodId>['output_schema_id'],
  keyof GeneratedSchemaMap
>

export type GeneratedBackendMethodInputSchema<TMethodId extends GeneratedBackendMethodId> =
  GeneratedSchemaMap[GeneratedInputSchemaId<TMethodId>]
export type GeneratedBackendMethodOutputSchema<TMethodId extends GeneratedBackendMethodId> =
  GeneratedSchemaMap[GeneratedOutputSchemaId<TMethodId>]
export type GeneratedBackendMethodInput<TMethodId extends GeneratedBackendMethodId> = z.input<
  GeneratedBackendMethodInputSchema<TMethodId>
>
export type GeneratedBackendMethodParsedInput<TMethodId extends GeneratedBackendMethodId> = z.output<
  GeneratedBackendMethodInputSchema<TMethodId>
>
export type GeneratedBackendMethodOutput<TMethodId extends GeneratedBackendMethodId> = z.output<
  GeneratedBackendMethodOutputSchema<TMethodId>
>

export interface GeneratedBackendContract<TMethodId extends GeneratedBackendMethodId> {
  readonly descriptor: GeneratedBackendMethodDescriptor<TMethodId>
  readonly inputSchema: GeneratedBackendMethodInputSchema<TMethodId>
  readonly outputSchema: GeneratedBackendMethodOutputSchema<TMethodId>
}

export function generatedBackendContract<TMethodId extends GeneratedBackendMethodId>(
  methodId: TMethodId
): GeneratedBackendContract<TMethodId> {
  const descriptor = backendContractMethodDescriptorById[methodId]
  return {
    descriptor,
    inputSchema: backendContractSchemaById[descriptor.input_schema_id],
    outputSchema: backendContractSchemaById[descriptor.output_schema_id]
  } as GeneratedBackendContract<TMethodId>
}

const GENERATED_CLIENT_BLOCKED_METHODS = new Set<GeneratedBackendMethodId>([
  'WakeWord.ProcessAudio'
])

export type GeneratedBackendClientMethodId = Exclude<
  GeneratedBackendMethodId,
  'WakeWord.ProcessAudio'
>

export interface GeneratedContractRequestOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface GeneratedContractRequester {
  readonly transport: { readonly kind: AuroraTransportKind }
  request<TData = unknown, TPayload = unknown>(
    method: string,
    payload?: TPayload,
    options?: {
      path?: string
      busTopic?: string
      timeoutMs?: number
      signal?: AbortSignal
    }
  ): Promise<TData>
}

export class GeneratedContractClient {
  constructor(private readonly client: GeneratedContractRequester) {}

  async request<TMethodId extends GeneratedBackendClientMethodId>(
    methodId: TMethodId,
    input: GeneratedBackendMethodInput<TMethodId>,
    options: GeneratedContractRequestOptions = {}
  ): Promise<GeneratedBackendMethodOutput<TMethodId>> {
    assertGeneratedClientMethod(methodId)
    const contract = generatedBackendContract(methodId)
    const payload = parseGeneratedBoundary(
      contract.descriptor.input_schema_id,
      contract.inputSchema,
      input,
      requestBoundary(this.client.transport.kind),
      methodId,
      'request'
    )
    const response = await this.client.request<unknown, typeof payload>(methodId, payload, {
      path: contract.descriptor.route_path,
      busTopic: contract.descriptor.bus_topic,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {})
    })
    return parseGeneratedBoundary(
      contract.descriptor.output_schema_id,
      contract.outputSchema,
      response,
      responseBoundary(this.client.transport.kind),
      methodId,
      'response'
    ) as GeneratedBackendMethodOutput<TMethodId>
  }

  requestResult<TMethodId extends GeneratedBackendClientMethodId>(
    methodId: TMethodId,
    input: GeneratedBackendMethodInput<TMethodId>,
    options: GeneratedContractRequestOptions = {}
  ): Promise<AuroraResponse<GeneratedBackendMethodOutput<TMethodId>>> {
    return captureResult(() => this.request(methodId, input, options), {
      method: methodId,
      busTopic: methodId,
      transport: this.client.transport.kind
    })
  }
}

function assertGeneratedClientMethod(
  methodId: GeneratedBackendMethodId
): asserts methodId is GeneratedBackendClientMethodId {
  if (GENERATED_CLIENT_BLOCKED_METHODS.has(methodId)) {
    throw new AuroraError({
      code: 'privacy_blocked',
      message: 'Continuous wake audio cannot be sent to another device.',
      method: methodId,
      busTopic: methodId
    })
  }
}

function parseGeneratedBoundary<TSchema extends z.ZodType>(
  schemaId: string,
  schema: TSchema,
  value: unknown,
  boundary: AuroraValidationBoundaryKind,
  methodId: string,
  direction: 'request' | 'response'
): z.output<TSchema> {
  try {
    return parseBoundary(schemaId, schema, value, { boundary })
  } catch (error) {
    if (!(error instanceof AuroraValidationError)) throw error
    throw new AuroraError({
      code: 'validation',
      message:
        direction === 'request'
          ? 'The request contains invalid values.'
          : 'Aurora returned an invalid response.',
      method: methodId,
      busTopic: methodId,
      detail: error.toJSON(),
      cause: error
    })
  }
}

function requestBoundary(kind: AuroraTransportKind): AuroraValidationBoundaryKind {
  if (kind === 'http') return 'http-request'
  if (kind === 'mesh') return 'webrtc-frame'
  if (kind === 'tauri-local' || kind === 'native-mobile') return 'native-bridge'
  return 'unknown'
}

function responseBoundary(kind: AuroraTransportKind): AuroraValidationBoundaryKind {
  if (kind === 'http') return 'http-response'
  if (kind === 'mesh') return 'webrtc-frame'
  if (kind === 'tauri-local' || kind === 'native-mobile') return 'native-bridge'
  return 'unknown'
}

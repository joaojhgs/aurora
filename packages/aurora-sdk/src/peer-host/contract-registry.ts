import {
  generatedBackendContract,
  type GeneratedBackendMethodId,
  type GeneratedBackendMethodOutput,
  type GeneratedBackendMethodParsedInput
} from '../generated-contracts.js'
import { parseBoundary } from '../validation/index.js'
import type { PeerHostCallContext, PeerHostEventDescriptor, PeerHostSubscribeContext, PeerHostSubscriptionHandle, PeerHostMethodDescriptor } from './types.js'

const DEFAULT_METHOD_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const TOOLING_PROVIDER_CAPABILITIES = Object.freeze(['tool_discovery', 'tool_execution'] as const)
const GENERATED_PEER_HOST_BLOCKED_METHODS = new Set<GeneratedBackendMethodId>([
  'Gateway.ExplainRoute',
  'WakeWord.ProcessAudio'
])

export type GeneratedPeerHostMethodId = Exclude<
  GeneratedBackendMethodId,
  'Gateway.ExplainRoute' | 'WakeWord.ProcessAudio'
>

export type GeneratedPeerHostMethodHandler<TMethodId extends GeneratedPeerHostMethodId> = (
  input: GeneratedBackendMethodParsedInput<TMethodId>,
  context: PeerHostCallContext
) => Promise<GeneratedBackendMethodOutput<TMethodId>> | GeneratedBackendMethodOutput<TMethodId>

export interface GeneratedPeerHostRegistrationOptions {
  readonly maxRequestBytes?: number
  readonly timeoutMs?: number
  readonly speechConstraints?: PeerHostMethodDescriptor['speechConstraints']
  readonly serviceCapabilities?: readonly string[]
  readonly serviceVersion?: string
  readonly maxConcurrent?: number
}

export class PeerHostContractRegistry {
  private readonly methods = new Map<string, PeerHostMethodDescriptor>()
  private readonly events = new Map<string, PeerHostEventDescriptor>()

  register<TInput, TOutput>(descriptor: PeerHostMethodDescriptor<TInput, TOutput>): this {
    if (this.methods.has(descriptor.methodId)) throw new Error(`duplicate peer-host method: ${descriptor.methodId}`)
    this.methods.set(descriptor.methodId, descriptor as PeerHostMethodDescriptor)
    return this
  }

  registerEvent<TEvent>(descriptor: PeerHostEventDescriptor<TEvent>): this {
    if (this.events.has(descriptor.topic)) throw new Error(`duplicate peer-host event topic: ${descriptor.topic}`)
    this.events.set(descriptor.topic, descriptor as PeerHostEventDescriptor)
    return this
  }

  get(methodId: string): PeerHostMethodDescriptor | undefined {
    return this.methods.get(methodId)
  }

  list(): PeerHostMethodDescriptor[] {
    return [...this.methods.values()].sort((left, right) => left.methodId.localeCompare(right.methodId))
  }

  getEvent(topic: string): PeerHostEventDescriptor | undefined {
    return this.events.get(topic)
  }

  listEvents(): PeerHostEventDescriptor[] {
    return [...this.events.values()].sort((left, right) => left.topic.localeCompare(right.topic))
  }

  parseInput(method: PeerHostMethodDescriptor, value: unknown): unknown {
    return parseBoundary(method.inputSchemaId, method.inputSchema, value, { boundary: 'webrtc-frame' })
  }

  parseOutput(method: PeerHostMethodDescriptor, value: unknown): unknown {
    return parseBoundary(method.outputSchemaId, method.outputSchema, value, { boundary: 'webrtc-frame' })
  }

  async dispatch(method: PeerHostMethodDescriptor, input: unknown, context: PeerHostCallContext): Promise<unknown> {
    const parsedInput = this.parseInput(method, input)
    const output = await method.handler(parsedInput, context)
    return this.parseOutput(method, output)
  }

  async openStream(method: PeerHostMethodDescriptor, input: unknown, context: PeerHostCallContext): Promise<AsyncIterable<unknown>> {
    if (!method.streamHandler) throw new Error('method is not stream-capable')
    const parsedInput = this.parseInput(method, input)
    return await method.streamHandler(parsedInput, context)
  }

  parseEventOutput(event: PeerHostEventDescriptor, value: unknown): unknown {
    return parseBoundary(event.outputSchemaId, event.outputSchema, value, { boundary: 'webrtc-frame' })
  }

  async openSubscription(event: PeerHostEventDescriptor, context: PeerHostSubscribeContext): Promise<PeerHostSubscriptionHandle | void> {
    return await event.handler(context)
  }
}

/** Build a peer-host descriptor directly from the generated backend contract. */
export function generatedPeerHostMethodDescriptor<
  TMethodId extends GeneratedPeerHostMethodId
>(
  methodId: TMethodId,
  handler: GeneratedPeerHostMethodHandler<TMethodId>,
  options: GeneratedPeerHostRegistrationOptions = {}
): PeerHostMethodDescriptor<
  GeneratedBackendMethodParsedInput<TMethodId>,
  GeneratedBackendMethodOutput<TMethodId>
> {
  assertGeneratedPeerHostMethod(methodId)
  const contract = generatedBackendContract(methodId)
  const descriptor = contract.descriptor
  if (descriptor.streaming.rpc_kind !== 'unary') {
    throw new Error(`generated peer-host method is not unary: ${methodId}`)
  }
  return {
    methodId,
    module: descriptor.module,
    name: descriptor.name,
    summary: '',
    busTopic: descriptor.bus_topic,
    exposure: descriptor.exposure,
    methodType: 'unary',
    projectionMethodType: descriptor.method_type,
    inputSchemaId: descriptor.input_schema_id,
    outputSchemaId: descriptor.output_schema_id,
    inputModel: descriptor.input_model,
    outputModel: descriptor.output_model,
    inputSchema: contract.inputSchema as unknown as PeerHostMethodDescriptor<
      GeneratedBackendMethodParsedInput<TMethodId>,
      GeneratedBackendMethodOutput<TMethodId>
    >['inputSchema'],
    outputSchema: contract.outputSchema as unknown as PeerHostMethodDescriptor<
      GeneratedBackendMethodParsedInput<TMethodId>,
      GeneratedBackendMethodOutput<TMethodId>
    >['outputSchema'],
    requiredPermissions: descriptor.required_perms,
    callableFeatureIds: descriptor.callable_feature_ids,
    speechConstraints:
      options.speechConstraints === undefined
        ? descriptor.speech_constraints
        : options.speechConstraints,
    serviceCapabilities:
      options.serviceCapabilities
      ?? (descriptor.module === 'Tooling' ? TOOLING_PROVIDER_CAPABILITIES : []),
    serviceVersion: options.serviceVersion ?? '0.0.0',
    maxConcurrent: options.maxConcurrent ?? 10,
    maxRequestBytes: options.maxRequestBytes ?? DEFAULT_METHOD_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    handler
  }
}

/** Register one generated backend method as a peer-host method. */
export function registerGeneratedPeerHostMethod<
  TMethodId extends GeneratedPeerHostMethodId
>(
  registry: PeerHostContractRegistry,
  methodId: TMethodId,
  handler: GeneratedPeerHostMethodHandler<TMethodId>,
  options: GeneratedPeerHostRegistrationOptions = {}
): PeerHostContractRegistry {
  return registry.register(generatedPeerHostMethodDescriptor(methodId, handler, options))
}

function assertGeneratedPeerHostMethod(
  methodId: GeneratedBackendMethodId
): asserts methodId is GeneratedPeerHostMethodId {
  if (!GENERATED_PEER_HOST_BLOCKED_METHODS.has(methodId)) return
  if (methodId === 'WakeWord.ProcessAudio') {
    throw new Error('continuous wake audio cannot be hosted across devices')
  }
  throw new Error('gateway route inspection cannot be registered as a peer-host service')
}

export function createToolingPeerHostRegistry(handlers: {
  getTools(input: unknown, context: PeerHostCallContext): Promise<unknown> | unknown
  getExportCatalog(input: unknown, context: PeerHostCallContext): Promise<unknown> | unknown
  prepareExecution(input: unknown, context: PeerHostCallContext): Promise<unknown> | unknown
  executeTool(input: unknown, context: PeerHostCallContext): Promise<unknown> | unknown
}): PeerHostContractRegistry {
  const registry = new PeerHostContractRegistry()
  registerGeneratedPeerHostMethod(
    registry,
    'Tooling.GetTools',
    handlers.getTools as GeneratedPeerHostMethodHandler<'Tooling.GetTools'>
  )
  registerGeneratedPeerHostMethod(
    registry,
    'Tooling.GetExportCatalog',
    handlers.getExportCatalog as GeneratedPeerHostMethodHandler<'Tooling.GetExportCatalog'>
  )
  registerGeneratedPeerHostMethod(
    registry,
    'Tooling.PrepareExecution',
    handlers.prepareExecution as GeneratedPeerHostMethodHandler<'Tooling.PrepareExecution'>
  )
  registerGeneratedPeerHostMethod(
    registry,
    'Tooling.ExecuteTool',
    handlers.executeTool as GeneratedPeerHostMethodHandler<'Tooling.ExecuteTool'>
  )
  return registry
}

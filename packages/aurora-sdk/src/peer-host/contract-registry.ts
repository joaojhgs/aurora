import {
  generatedBackendContract,
  generatedBackendEventContract,
  type GeneratedBackendEventOutput,
  type GeneratedBackendEventTopic,
  type GeneratedBackendMethodId,
  type GeneratedBackendMethodOutput,
  type GeneratedBackendMethodParsedInput
} from '../generated-contracts.js'
import { parseBoundary } from '../validation/index.js'
import type {
  PeerHostCallContext,
  PeerHostEventDescriptor,
  PeerHostEventEmissionValidator,
  PeerHostMethodDescriptor,
  PeerHostSubscribeContext,
  PeerHostSubscriptionHandle
} from './types.js'

const DEFAULT_METHOD_BYTES = 256 * 1024
const DEFAULT_EVENT_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_EVENT_STREAM_ID_LENGTH = 256
const TOOLING_PROVIDER_CAPABILITIES = Object.freeze(['tool_discovery', 'tool_execution'] as const)
const GENERATED_PEER_HOST_BLOCKED_METHODS = new Set<GeneratedBackendMethodId>([
  'Gateway.ExplainRoute',
  'WakeWord.ProcessAudio',
  'Transcription.ProcessAudio'
])

export type GeneratedPeerHostMethodId = Exclude<
  GeneratedBackendMethodId,
  'Gateway.ExplainRoute' | 'WakeWord.ProcessAudio' | 'Transcription.ProcessAudio'
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

export type GeneratedPeerHostEventHandler<TTopic extends GeneratedBackendEventTopic> = (
  context: PeerHostSubscribeContext<GeneratedBackendEventOutput<TTopic>>
) => Promise<PeerHostSubscriptionHandle | void> | PeerHostSubscriptionHandle | void

export interface GeneratedPeerHostEventRegistrationOptions {
  readonly maxTtlSeconds?: number
  readonly maxEventBytes?: number
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

/** Build an authorized peer-host event descriptor from generated contract metadata. */
export function generatedPeerHostEventDescriptor<TTopic extends GeneratedBackendEventTopic>(
  topic: TTopic,
  handler: GeneratedPeerHostEventHandler<TTopic>,
  options: GeneratedPeerHostEventRegistrationOptions = {}
): PeerHostEventDescriptor<GeneratedBackendEventOutput<TTopic>> {
  const contract = generatedBackendEventContract(topic)
  const descriptor = contract.descriptor
  if (!descriptor.authorized || !descriptor.bounded || descriptor.remote_raw_audio_route) {
    throw new Error(`generated peer-host event is not safe for remote projection: ${topic}`)
  }
  const createEmissionValidator = generatedEventEmissionValidatorFactory(topic)
  return {
    topic,
    module: descriptor.module,
    name: descriptor.name,
    outputSchemaId: descriptor.schema_id,
    outputSchema: contract.outputSchema as unknown as PeerHostEventDescriptor<
      GeneratedBackendEventOutput<TTopic>
    >['outputSchema'],
    requiredPermissions: descriptor.required_perms,
    maxTtlSeconds: options.maxTtlSeconds ?? 120,
    maxEventBytes: options.maxEventBytes ?? DEFAULT_EVENT_BYTES,
    orderedEventGroup: descriptor.ordered_event_group,
    ...(createEmissionValidator === undefined ? {} : { createEmissionValidator }),
    handler
  }
}

/** Register one generated backend event as an authorized peer-host subscription. */
export function registerGeneratedPeerHostEvent<TTopic extends GeneratedBackendEventTopic>(
  registry: PeerHostContractRegistry,
  topic: TTopic,
  handler: GeneratedPeerHostEventHandler<TTopic>,
  options: GeneratedPeerHostEventRegistrationOptions = {}
): PeerHostContractRegistry {
  return registry.registerEvent(generatedPeerHostEventDescriptor(topic, handler, options))
}

function assertGeneratedPeerHostMethod(
  methodId: GeneratedBackendMethodId
): asserts methodId is GeneratedPeerHostMethodId {
  if (!GENERATED_PEER_HOST_BLOCKED_METHODS.has(methodId)) return
  if (methodId === 'WakeWord.ProcessAudio' || methodId === 'Transcription.ProcessAudio') {
    throw new Error('continuous audio capture cannot be hosted across devices')
  }
  throw new Error('gateway route inspection cannot be registered as a peer-host service')
}

export interface ToolingPeerHostHandlers {
  readonly getTools: GeneratedPeerHostMethodHandler<'Tooling.GetTools'>
  readonly getExportCatalog: GeneratedPeerHostMethodHandler<'Tooling.GetExportCatalog'>
  readonly prepareExecution: GeneratedPeerHostMethodHandler<'Tooling.PrepareExecution'>
  readonly executeTool: GeneratedPeerHostMethodHandler<'Tooling.ExecuteTool'>
}

export function createToolingPeerHostRegistry(
  handlers: ToolingPeerHostHandlers
): PeerHostContractRegistry {
  const registry = new PeerHostContractRegistry()
  registerGeneratedPeerHostMethod(
    registry,
    'Tooling.GetTools',
    handlers.getTools
  )
  registerGeneratedPeerHostMethod(
    registry,
    'Tooling.GetExportCatalog',
    handlers.getExportCatalog
  )
  registerGeneratedPeerHostMethod(
    registry,
    'Tooling.PrepareExecution',
    handlers.prepareExecution
  )
  registerGeneratedPeerHostMethod(
    registry,
    'Tooling.ExecuteTool',
    handlers.executeTool
  )
  return registry
}

type TtsAudioSequenceState = {
  nextSequence: number
  lastSourceSequence: number | null
  final: boolean
}

function generatedEventEmissionValidatorFactory<TTopic extends GeneratedBackendEventTopic>(
  topic: TTopic
): (() => PeerHostEventEmissionValidator<GeneratedBackendEventOutput<TTopic>>) | undefined {
  if (topic !== 'TTS.AudioChunk') return undefined
  return createTtsAudioChunkEmissionValidator as () => PeerHostEventEmissionValidator<
    GeneratedBackendEventOutput<TTopic>
  >
}

function createTtsAudioChunkEmissionValidator(): PeerHostEventEmissionValidator<unknown> {
  const streams = new Map<string, TtsAudioSequenceState>()
  return (value, context) => {
    if (!isRecord(value)) throw new Error('TTS audio event must be an object')
    const streamId = value.stream_id
    const sequence = value.sequence
    const sourceSequence = value.source_sequence
    const isFinal = value.is_final
    const audioData = value.audio_data
    const durationMs = value.duration_ms
    const payloadCorrelationId = value.correlation_id
    if (
      typeof streamId !== 'string'
      || streamId.length === 0
      || streamId.length > MAX_EVENT_STREAM_ID_LENGTH
    ) {
      throw new Error('TTS audio event stream_id is not a bounded identifier')
    }
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) {
      throw new Error('TTS audio event sequence is invalid')
    }
    if (typeof isFinal !== 'boolean' || typeof audioData !== 'string') {
      throw new Error('TTS audio event terminal fields are invalid')
    }
    if (sourceSequence !== null && sourceSequence !== undefined && !Number.isSafeInteger(sourceSequence)) {
      throw new Error('TTS audio event source sequence is invalid')
    }
    if (
      context.correlationId !== undefined
      && payloadCorrelationId !== context.correlationId
    ) {
      throw new Error('TTS audio event correlation does not match payload')
    }
    const stateKey = `${context.correlationId ?? ''}\u0000${streamId}`
    const previous = streams.get(stateKey)
    const expectedSequence = previous?.nextSequence ?? 0
    if (sequence !== expectedSequence || previous?.final) {
      throw new Error('TTS audio event sequence is not monotonic')
    }
    if (isFinal) {
      if (
        audioData !== ''
        || (sourceSequence !== null && sourceSequence !== undefined)
        || durationMs !== 0
      ) {
        throw new Error('TTS audio event final marker is invalid')
      }
    } else {
      if (!Number.isSafeInteger(sourceSequence) || (sourceSequence as number) < 0) {
        throw new Error('TTS audio event source sequence is required')
      }
      const lastSourceSequence = previous?.lastSourceSequence
      if (
        lastSourceSequence === undefined || lastSourceSequence === null
          ? sourceSequence !== 0
          : sourceSequence !== lastSourceSequence && sourceSequence !== lastSourceSequence + 1
      ) {
        throw new Error('TTS audio event source sequence is not ordered')
      }
    }
    streams.set(stateKey, {
      nextSequence: (sequence as number) + 1,
      lastSourceSequence: isFinal ? (previous?.lastSourceSequence ?? null) : sourceSequence as number,
      final: isFinal
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

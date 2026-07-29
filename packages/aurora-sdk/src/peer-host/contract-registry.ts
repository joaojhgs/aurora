import { TOOLING_METHODS } from '../descriptors.js'
import {
  ToolingExecuteToolInputToolingExecuteToolRequestSchema,
  ToolingExecuteToolOutputToolingExecuteToolResponseSchema,
  ToolingGetExportCatalogInputToolingGetExportCatalogRequestSchema,
  ToolingGetExportCatalogOutputToolingGetExportCatalogResponseSchema,
  ToolingGetToolsInputToolingGetToolsRequestSchema,
  ToolingGetToolsOutputToolingGetToolsResponseSchema,
  ToolingPrepareExecutionInputToolingPrepareExecutionRequestSchema,
  ToolingPrepareExecutionOutputToolingPrepareExecutionResponseSchema
} from '../generated/backend-contracts.zod.js'
import { parseBoundary } from '../validation/index.js'
import type { PeerHostCallContext, PeerHostEventDescriptor, PeerHostSubscribeContext, PeerHostSubscriptionHandle, PeerHostMethodDescriptor } from './types.js'

const DEFAULT_METHOD_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

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

export function createToolingPeerHostRegistry(handlers: {
  getTools(input: unknown, context: PeerHostCallContext): Promise<unknown> | unknown
  getExportCatalog(input: unknown, context: PeerHostCallContext): Promise<unknown> | unknown
  prepareExecution(input: unknown, context: PeerHostCallContext): Promise<unknown> | unknown
  executeTool(input: unknown, context: PeerHostCallContext): Promise<unknown> | unknown
}): PeerHostContractRegistry {
  return new PeerHostContractRegistry()
    .register({
      methodId: 'Tooling.GetTools',
      methodType: 'unary',
      inputSchemaId: 'Tooling.GetTools.input.ToolingGetToolsRequest',
      outputSchemaId: 'Tooling.GetTools.output.ToolingGetToolsResponse',
      inputSchema: ToolingGetToolsInputToolingGetToolsRequestSchema,
      outputSchema: ToolingGetToolsOutputToolingGetToolsResponseSchema,
      requiredPermissions: ['Tooling.GetTools'],
      maxRequestBytes: DEFAULT_METHOD_BYTES,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      handler: handlers.getTools
    })
    .register({
      methodId: TOOLING_METHODS.getExportCatalog,
      methodType: 'unary',
      inputSchemaId: 'Tooling.GetExportCatalog.input.ToolingGetExportCatalogRequest',
      outputSchemaId: 'Tooling.GetExportCatalog.output.ToolingGetExportCatalogResponse',
      inputSchema: ToolingGetExportCatalogInputToolingGetExportCatalogRequestSchema,
      outputSchema: ToolingGetExportCatalogOutputToolingGetExportCatalogResponseSchema,
      requiredPermissions: ['Tooling.GetTools'],
      maxRequestBytes: DEFAULT_METHOD_BYTES,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      handler: handlers.getExportCatalog
    })
    .register({
      methodId: TOOLING_METHODS.prepareExecution,
      methodType: 'unary',
      inputSchemaId: 'Tooling.PrepareExecution.input.ToolingPrepareExecutionRequest',
      outputSchemaId: 'Tooling.PrepareExecution.output.ToolingPrepareExecutionResponse',
      inputSchema: ToolingPrepareExecutionInputToolingPrepareExecutionRequestSchema,
      outputSchema: ToolingPrepareExecutionOutputToolingPrepareExecutionResponseSchema,
      requiredPermissions: [TOOLING_METHODS.prepareExecution],
      maxRequestBytes: DEFAULT_METHOD_BYTES,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      handler: handlers.prepareExecution
    })
    .register({
      methodId: TOOLING_METHODS.executeTool,
      methodType: 'unary',
      inputSchemaId: 'Tooling.ExecuteTool.input.ToolingExecuteToolRequest',
      outputSchemaId: 'Tooling.ExecuteTool.output.ToolingExecuteToolResponse',
      inputSchema: ToolingExecuteToolInputToolingExecuteToolRequestSchema,
      outputSchema: ToolingExecuteToolOutputToolingExecuteToolResponseSchema,
      requiredPermissions: [TOOLING_METHODS.executeTool],
      maxRequestBytes: DEFAULT_METHOD_BYTES,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      handler: handlers.executeTool
    })
}

import type {
  JsonObject,
  JsonValue,
  ToolingCapabilityClass,
  ToolingProjectionToolInfo,
  ToolingSourceClass,
  ToolingTrustTier
} from '../types.js'
import type { AuthenticatedPeerContext } from '../peer-host/authority.js'
import {
  localToolProjectionIdentity,
  parseLocalToolDescriptorV1,
  publicLocalToolDescriptorV1,
  type LocalToolDescriptorV1
} from './descriptor-v1.js'
import { toolSchemaHash } from './identity.js'
import { assertSupportedJsonSchema } from './json-schema.js'

export type LocalToolHandler = (
  input: Readonly<{
    arguments: JsonObject
    signal: AbortSignal
    correlationId: string
    context: LocalToolExecutionContext
  }>
) => Promise<JsonValue | undefined> | JsonValue | undefined

export interface LocalToolExecutionContext {
  readonly callerPeerId: string
  readonly callerPrincipalId?: string | null
  readonly callerDeviceId?: string | null
  readonly authenticatedPeerContext?: AuthenticatedPeerContext | undefined
  readonly permissions: readonly string[]
  readonly methodId: string
  readonly nowMs: number
}

export type LocalToolSourceKind = 'core' | 'plugin' | 'mcp' | 'unknown'

export interface LocalToolRegistryOptions {
  readonly stablePeerId: string
  readonly providerLabel?: string | null
  readonly source?: LocalToolSourceKind
  readonly sourceId?: string | null
}

export interface LocalToolRegistration {
  readonly descriptor: LocalToolDescriptorV1
  readonly handler: LocalToolHandler
}

export interface RegisteredLocalTool {
  readonly descriptor: LocalToolDescriptorV1
  readonly publicDescriptor: Omit<LocalToolDescriptorV1, 'handlerId'>
  readonly toolInfo: ToolingProjectionToolInfo
  readonly schemaHash: string
  readonly descriptorHash: string
}

export interface LocalToolDispatchEntry extends RegisteredLocalTool {
  readonly handler: LocalToolHandler
}

export class LocalToolRegistryError extends Error {
  readonly reasonCode: string

  constructor(reasonCode: string, message = `Invalid local tool registry operation: ${reasonCode}`) {
    super(message)
    this.name = 'LocalToolRegistryError'
    this.reasonCode = reasonCode
  }
}

export class LocalToolRegistry {
  private readonly options: {
    readonly stablePeerId: string
    readonly providerLabel: string | null
    readonly source: LocalToolSourceKind
    readonly sourceId: string | null
  }
  private readonly byContractId = new Map<string, LocalToolDispatchEntry>()
  private readonly byGlobalToolId = new Map<string, LocalToolDispatchEntry>()
  private readonly byLocalName = new Map<string, LocalToolDispatchEntry>()
  private readonly byHandlerId = new Map<string, LocalToolDispatchEntry>()

  constructor(options: LocalToolRegistryOptions) {
    this.options = {
      stablePeerId: options.stablePeerId,
      providerLabel: options.providerLabel ?? null,
      source: options.source ?? 'unknown',
      sourceId: options.sourceId ?? null
    }
  }

  register(registration: LocalToolRegistration): RegisteredLocalTool {
    const descriptor = deepFreeze(structuredClone(parseLocalToolDescriptorV1(registration.descriptor)))
    assertSupportedJsonSchema(descriptor.argsSchema)
    assertSupportedJsonSchema(descriptor.outputSchema)
    const publicDescriptor = publicLocalToolDescriptorV1(descriptor)
    const identity = localToolProjectionIdentity(this.options.stablePeerId, descriptor)
    this.rejectDuplicate(this.byContractId, descriptor.toolContractId, 'duplicate_tool_contract_id')
    this.rejectDuplicate(this.byGlobalToolId, identity.globalToolId, 'duplicate_global_tool_id')
    this.rejectDuplicate(this.byLocalName, descriptor.localName, 'duplicate_local_name')
    this.rejectDuplicate(this.byHandlerId, descriptor.handlerId, 'duplicate_handler_id')
    const toolInfo = descriptorToToolInfo(removeUndefined({
      descriptor,
      stablePeerId: this.options.stablePeerId,
      providerServiceInstanceId: identity.providerServiceInstanceId,
      globalToolId: identity.globalToolId,
      providerLabel: this.options.providerLabel,
      source: this.options.source,
      sourceId: this.options.sourceId
    }))

    const entry: LocalToolDispatchEntry = {
      descriptor,
      publicDescriptor,
      handler: registration.handler,
      schemaHash: toolSchemaHash({
        args_schema: toolInfo.args_schema,
        schema: toolInfo.schema,
        argument_visibility: toolInfo.argument_visibility
      }),
      descriptorHash: identity.descriptorHash,
      toolInfo
    }
    this.byContractId.set(descriptor.toolContractId, entry)
    this.byGlobalToolId.set(identity.globalToolId, entry)
    this.byLocalName.set(descriptor.localName, entry)
    this.byHandlerId.set(descriptor.handlerId, entry)
    return projectRegisteredTool(entry)
  }

  list(): RegisteredLocalTool[] {
    return [...this.byGlobalToolId.values()]
      .sort((left, right) => left.toolInfo.global_tool_id.localeCompare(right.toolInfo.global_tool_id))
      .map(projectRegisteredTool)
  }

  publicTools(): ToolingProjectionToolInfo[] {
    return this.list().map((entry) => cloneToolInfo(entry.toolInfo))
  }

  resolvePublicId(toolNameOrId: string): RegisteredLocalTool | undefined {
    const entry = this.byGlobalToolId.get(toolNameOrId)
      ?? this.byLocalName.get(toolNameOrId)
      ?? this.byContractId.get(toolNameOrId)
    return entry ? projectRegisteredTool(entry) : undefined
  }

  resolveForDispatch(toolNameOrId: string): LocalToolDispatchEntry | undefined {
    return this.byGlobalToolId.get(toolNameOrId)
      ?? this.byLocalName.get(toolNameOrId)
      ?? this.byContractId.get(toolNameOrId)
  }

  private rejectDuplicate(map: Map<string, unknown>, key: string, reasonCode: string): void {
    if (map.has(key)) throw new LocalToolRegistryError(reasonCode)
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
  }
  return value
}

function descriptorToToolInfo(input: {
  descriptor: LocalToolDescriptorV1
  stablePeerId: string
  providerServiceInstanceId: string
  globalToolId: string
  providerLabel?: string | null
  source: LocalToolSourceKind
  sourceId?: string | null
}): ToolingProjectionToolInfo {
  const descriptor = input.descriptor
  const argumentVisibility = Object.fromEntries(
    Object.entries(descriptor.argumentVisibility).map(([key, value]) => [
      key,
      value === 'public' ? 'display' : (value === 'private' ? 'hash_only' : 'secret')
    ])
  ) as JsonObject
  return {
    name: descriptor.localName,
    local_name: descriptor.localName,
    global_tool_id: input.globalToolId,
    tool_id_scheme: 'aurora-tool',
    tool_id_version: 1,
    tool_contract_id: descriptor.toolContractId,
    share_group_id: descriptor.nativeRequirements.capabilityIds[0] ?? `local:${descriptor.toolContractId}`,
    share_group_label: descriptor.displayName,
    legacy_global_tool_ids: [],
    exportable: true,
    provider_peer_id: input.stablePeerId,
    provider_service_instance_id: input.providerServiceInstanceId,
    provider_label: input.providerLabel ?? null,
    provider_granted_permissions: null,
    provider_available: true,
    namespace: input.stablePeerId,
    display_name: descriptor.displayName,
    aliases: [],
    description: descriptor.description,
    args_schema: descriptor.argsSchema as JsonObject,
    schema: descriptor.outputSchema as JsonObject,
    argument_visibility: argumentVisibility,
    source_type: 'local',
    source: input.source,
    source_id: input.sourceId ?? input.source,
    trust_tier: safetyTrustTier(descriptor.safetyClass),
    capability_class: capabilityClass(descriptor),
    resource_scope: [...descriptor.resourceScopes],
    execution_location: 'local',
    safety_class: descriptor.safetyClass,
    risk_class: descriptor.safetyClass,
    data_egress: descriptor.dataEgress,
    mutating: descriptor.mutating,
    external: descriptor.dataEgress,
    admin: descriptor.requiredPermissions.some((permission) => permission.toLowerCase().includes('admin')),
    privacy_hints: [descriptor.privacyClass],
    required_permissions: [...descriptor.requiredPermissions].sort(),
    confirmation_required: descriptor.confirmationPolicy !== 'never',
    rate_limit_hints: null,
    provenance: {
      provider_peer_id: input.stablePeerId,
      provider_service_instance_id: input.providerServiceInstanceId,
      provider_kind: 'local',
      source: input.source,
      advertised_name: descriptor.localName,
      stable_source_id: input.sourceId ?? input.source,
      provider_tool_id: descriptor.localName
    }
  }
}

function safetyTrustTier(safetyClass: LocalToolDescriptorV1['safetyClass']): ToolingTrustTier {
  return safetyClass === 'dangerous' ? 'untrusted' : 'trusted'
}

function capabilityClass(descriptor: LocalToolDescriptorV1): ToolingCapabilityClass {
  if (descriptor.requiredPermissions.some((permission) => permission.toLowerCase().includes('admin'))) return 'admin'
  if (Object.values(descriptor.argumentVisibility).includes('secret')) return 'secrets'
  if (descriptor.dataEgress) return 'network'
  if (descriptor.mutating) return 'write'
  return 'read'
}

function projectRegisteredTool(entry: LocalToolDispatchEntry): RegisteredLocalTool {
  return {
    descriptor: { ...entry.descriptor },
    publicDescriptor: { ...entry.publicDescriptor },
    toolInfo: cloneToolInfo(entry.toolInfo),
    schemaHash: entry.schemaHash,
    descriptorHash: entry.descriptorHash
  }
}

function cloneToolInfo(tool: ToolingProjectionToolInfo): ToolingProjectionToolInfo {
  return structuredClone(tool)
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

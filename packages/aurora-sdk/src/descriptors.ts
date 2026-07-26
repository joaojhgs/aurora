import type {
  BackendInventory,
  BackendInventoryDescriptors,
  BackendInventoryMethod,
  BackendMethodTypeDescriptor,
  GatewayBuiltinRouteDescriptor,
  GeneratedMethodDescriptor,
  GetRegistryResponse,
  JsonObject,
  MethodDescriptor,
  MethodInfo
} from './types.js'

export const GATEWAY_METHODS = {
  health: 'Gateway.Health',
  getRegistry: 'Gateway.GetRegistry',
  getServices: 'Gateway.GetServices',
  getServiceHealth: 'Gateway.GetServiceHealth',
  getDeploymentTopology: 'Gateway.GetDeploymentTopology',
  getWebRTCDiagnostics: 'Gateway.GetWebRTCDiagnostics',
  getMeshStatus: 'Gateway.GetMeshStatus',
  getMeshInviteConfig: 'Gateway.GetMeshInviteConfig',
  getCapabilityGraph: 'Gateway.GetCapabilityGraph',
  getCapabilityCatalog: 'Gateway.GetCapabilityCatalog',
  explainRoute: 'Gateway.ExplainRoute',
  listEvents: 'Gateway.ListEvents',
  getSupportBundle: 'Gateway.GetSupportBundle',
  adminActionDraft: 'Gateway.AdminActionDraft',
  adminActionConfirm: 'Gateway.AdminActionConfirm'
} as const

export const AUTH_METHODS = {
  login: 'Auth.Login',
  validateToken: 'Auth.ValidateToken',
  whoAmI: 'Auth.WhoAmI',
  pairingStart: 'Auth.PairingStart',
  pairingConnect: 'Auth.PairingConnect',
  pairingExchange: 'Auth.PairingExchange',
  listPendingPairings: 'Auth.ListPendingPairings',
  pairingApprove: 'Auth.PairingApprove',
  pairingDeny: 'Auth.PairingDeny',
  meshListPeers: 'Auth.MeshListPeers',
  meshGetPeer: 'Auth.MeshGetPeer',
  meshApprovePeer: 'Auth.MeshApprovePeer',
  meshDenyPeer: 'Auth.MeshDenyPeer',
  meshUpdatePeerPermissions: 'Auth.MeshUpdatePeerPermissions',
  meshRemovePeer: 'Auth.MeshRemovePeer',
  listPrincipals: 'Auth.ListPrincipals',
  createPrincipal: 'Auth.CreatePrincipal',
  getPrincipal: 'Auth.GetPrincipal',
  updatePrincipal: 'Auth.UpdatePrincipal',
  deletePrincipal: 'Auth.DeletePrincipal',
  setPermissions: 'Auth.SetPermissions',
  patchPermissions: 'Auth.PatchPermissions',
  listTokens: 'Auth.ListTokens',
  revokeToken: 'Auth.RevokeToken',
  listDevices: 'Auth.ListDevices',
  deleteDevice: 'Auth.DeleteDevice',
  auditLog: 'Auth.AuditLog'
} as const

export const TOOLING_METHODS = {
  listCatalog: 'Tooling.GetToolCatalog',
  getStats: 'Tooling.GetStats',
  getMcpStatus: 'Tooling.GetMCPStatus',
  reloadMcpTools: 'Tooling.ReloadMCPTools',
  getSharingPolicy: 'Tooling.GetSharingPolicy',
  setSharingPolicy: 'Tooling.SetSharingPolicy',
  testSharingPolicy: 'Tooling.TestSharingPolicy',
  getExportCatalog: 'Tooling.GetExportCatalog',
  getToolExportPolicy: 'Tooling.GetToolExportPolicy',
  setToolExportDefault: 'Tooling.SetToolExportDefault',
  upsertToolGroupExportPolicy: 'Tooling.UpsertToolGroupExportPolicy',
  upsertToolExportOverride: 'Tooling.UpsertToolExportOverride',
  clearToolExportOverride: 'Tooling.ClearToolExportOverride',
  previewToolExportDecision: 'Tooling.PreviewToolExportDecision',
  prepareExecution: 'Tooling.PrepareExecution',
  requestApproval: 'Tooling.RequestApproval',
  confirmExecution: 'Tooling.ConfirmExecution',
  listApprovalGrants: 'Tooling.ListApprovalGrants',
  createApprovalGrant: 'Tooling.CreateApprovalGrant',
  revokeApprovalGrant: 'Tooling.RevokeApprovalGrant',
  evaluateApprovalGrant: 'Tooling.EvaluateApprovalGrant',
  getPolicySummary: 'Tooling.GetPolicySummary',
  listToolSources: 'Tooling.ListToolSources',
  getToolSourceDetail: 'Tooling.GetToolSourceDetail',
  setPolicyMode: 'Tooling.SetPolicyMode',
  upsertSourcePolicy: 'Tooling.UpsertSourcePolicy',
  clearSourcePolicy: 'Tooling.ClearSourcePolicy',
  upsertToolPolicyOverride: 'Tooling.UpsertToolPolicyOverride',
  clearToolPolicyOverride: 'Tooling.ClearToolPolicyOverride',
  listPendingApprovals: 'Tooling.ListPendingApprovals',
  listPolicyAuditEvents: 'Tooling.ListPolicyAuditEvents',
  getOnboardingStatus: 'Tooling.GetOnboardingStatus',
  testMcpSource: 'Tooling.TestMCPSource',
  createMcpSource: 'Tooling.CreateMCPSource',
  testPluginSource: 'Tooling.TestPluginSource',
  createPluginSource: 'Tooling.CreatePluginSource',
  executeTool: 'Tooling.ExecuteTool'
} as const

export const TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT = 'CONFIRM TOOL EXPORT POLICY CHANGE' as const

export const ORCHESTRATOR_METHODS = {
  userInput: 'Orchestrator.UserInput',
  externalUserInput: 'Orchestrator.ExternalUserInput',
  ingestContext: 'Orchestrator.IngestContext',
  listPendingToolApprovals: 'Orchestrator.ListPendingToolApprovals',
  resumeToolApproval: 'Orchestrator.ResumeToolApproval',
  interrupt: 'Orchestrator.Interrupt',
  toolResult: 'Orchestrator.ToolResult',
  response: 'Orchestrator.Response'
} as const


export const TTS_METHODS = {
  request: 'TTS.Request',
  synthesize: 'TTS.Synthesize',
  streamStart: 'TTS.StreamStart',
  streamChunk: 'TTS.StreamChunk',
  streamEnd: 'TTS.StreamEnd',
  audioChunk: 'TTS.AudioChunk',
  stop: 'TTS.Stop',
  pause: 'TTS.Pause',
  resume: 'TTS.Resume'
} as const

export const STT_METHODS = {
  listen: 'STTCoordinator.Listen',
  stopListening: 'STTCoordinator.StopListening',
  sessionStarted: 'STTCoordinator.SessionStarted',
  sessionEnded: 'STTCoordinator.SessionEnded',
  userSpeechCaptured: 'STTCoordinator.UserSpeechCaptured',
  partial: 'STTCoordinator.Partial',
  final: 'STTCoordinator.Final',
  audioLevel: 'STTCoordinator.AudioLevel'
} as const

export const WAKEWORD_METHODS = {
  processAudio: 'WakeWord.ProcessAudio',
  detect: 'WakeWord.Detect',
  control: 'WakeWord.Control'
} as const

export const AUDIO_SESSION_METHODS = {
  prepare: 'AudioSession.Prepare',
  requestConsent: 'AudioSession.RequestConsent',
  start: 'AudioSession.Start',
  stop: 'AudioSession.Stop',
  status: 'AudioSession.Status',
  events: 'AudioSession.Events',
  listEvents: 'AudioSession.ListEvents'
} as const

export const TRANSCRIPTION_METHODS = {
  transcribe: 'Transcription.Transcribe',
  processAudio: 'Transcription.ProcessAudio',
  result: 'Transcription.Result',
  control: 'Transcription.Control'
} as const

export const CONFIG_METHODS = {
  get: 'Config.Get',
  set: 'Config.Set',
  validate: 'Config.Validate',
  getSchemaMetadata: 'Config.GetSchemaMetadata',
  previewDiff: 'Config.PreviewDiff',
  getVersionHistory: 'Config.GetVersionHistory',
  rollback: 'Config.Rollback',
  commitChangeSet: 'Config.CommitChangeSet',
  previewReloadImpact: 'Config.PreviewReloadImpact'
} as const

export const ORCHESTRATOR_MODEL_METHODS = {
  getRuntime: 'Orchestrator.GetModelRuntime',
  getCatalog: 'Orchestrator.GetModelCatalog',
  getOperation: 'Orchestrator.GetModelOperation',
  importModel: 'Orchestrator.ImportModel',
  downloadModel: 'Orchestrator.DownloadModel',
  benchmarkModel: 'Orchestrator.BenchmarkModel'
} as const

export function routePath(module: string, method: string): string {
  return `/api/${encodeURIComponent(module)}/${encodeURIComponent(method)}`
}

export function methodIdentity(module: string, method: Pick<MethodInfo, 'name' | 'bus_topic'>): string {
  return method.bus_topic ?? `${module}.${method.name}`
}

export function describeRegistry(registry: GetRegistryResponse): MethodDescriptor[] {
  return registry.modules.flatMap((moduleInfo) =>
    moduleInfo.methods.map((method) => describeMethod(moduleInfo.module, method))
  )
}

export function describeMethod(module: string, method: MethodInfo): MethodDescriptor {
  const busTopic = methodIdentity(module, method)
  const availableOverHttp = method.exposure === 'external' || method.exposure === 'both'
  return {
    module,
    name: method.name,
    busTopic,
    routePath: availableOverHttp ? routePath(module, method.name) : null,
    exposure: method.exposure,
    methodType: method.method_type,
    summary: method.summary,
    inputModel: method.input_model,
    outputModel: method.output_model,
    requiredPermissions: [...method.required_perms],
    callableFeatureIds: [...(method.callable_feature_ids ?? [])],
    callableFeatures: [...(method.callable_features ?? [])],
    publicInfrastructure: method.public_infrastructure ?? false,
    inputSchema: method.input_schema ?? null,
    outputSchema: method.output_schema ?? null,
    availableOverHttp
  }
}

export function describeBackendInventory(inventory: BackendInventory): BackendInventoryDescriptors {
  const methods = describeBackendInventoryMethods(inventory)
  return {
    methods,
    gatewayBuiltins: describeGatewayBuiltins(inventory),
    methodTypes: buildBackendMethodTypes(methods)
  }
}

export function describeBackendInventoryMethods(inventory: BackendInventory): GeneratedMethodDescriptor[] {
  return inventory.methods.map((method) => describeBackendInventoryMethod(method))
}

export function describeBackendInventoryMethod(method: BackendInventoryMethod): GeneratedMethodDescriptor {
  if (!method.bus_topic) {
    throw new TypeError(`Generated backend inventory method ${method.module}.${method.name} is missing bus_topic`)
  }

  const availableOverHttp = method.exposure === 'external' || method.exposure === 'both'
  const inventoryRoutePath = method.routePath ?? method.route_path ?? null
  const descriptorRoutePath = availableOverHttp ? inventoryRoutePath ?? routePath(method.module, method.name) : null

  return {
    module: method.module,
    name: method.name,
    busTopic: method.bus_topic,
    routePath: descriptorRoutePath,
    exposure: method.exposure,
    methodType: method.method_type,
    summary: method.summary ?? '',
    inputModel: method.input_model ?? null,
    outputModel: method.output_model ?? null,
    requiredPermissions: [...method.required_perms],
    callableFeatureIds: [...(method.callable_feature_ids ?? [])],
    callableFeatures: [...(method.callable_features ?? [])],
    publicInfrastructure: method.public_infrastructure ?? false,
    inputSchema: cloneSchema(method.input_schema),
    outputSchema: cloneSchema(method.output_schema),
    availableOverHttp,
    routeKind: method.route_kind ?? (availableOverHttp ? 'dynamic' : 'internal_bus'),
    source: method.source ?? null,
    sourceFile: method.source_file ?? null
  }
}

export function describeGatewayBuiltins(inventory: BackendInventory): GatewayBuiltinRouteDescriptor[] {
  return (inventory.gateway_builtins ?? []).flatMap((route) => {
    const path = route.routePath ?? route.route_path
    if (!path) return []
    return [
      {
        name: route.name,
        routePath: path,
        httpMethods: [...route.http_methods],
        exposure: 'gateway_builtin',
        methodType: route.method_type,
        summary: route.summary ?? '',
        requiredPermissions: [...route.required_perms],
        routeKind: 'gateway_builtin'
      }
    ]
  })
}

export function buildBackendMethodTypes(
  methods: GeneratedMethodDescriptor[]
): Record<string, BackendMethodTypeDescriptor> {
  return Object.fromEntries(
    methods.map((descriptor) => [
      descriptor.busTopic,
      {
        busTopic: descriptor.busTopic,
        requestModel: descriptor.inputModel,
        responseModel: descriptor.outputModel,
        requestSchema: descriptor.inputSchema,
        responseSchema: descriptor.outputSchema,
        descriptor
      }
    ])
  )
}

function cloneSchema(schema: JsonObject | null | undefined): JsonObject | null {
  return schema ? { ...schema } : null
}

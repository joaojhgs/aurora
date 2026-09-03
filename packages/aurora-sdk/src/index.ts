export { AuroraClient, ModelRuntimeClient } from './client.js'
export {
  GeneratedContractClient,
  generatedBackendContract,
  generatedBackendEventContract
} from './generated-contracts.js'
export type {
  GeneratedBackendContract,
  GeneratedBackendEventContract,
  GeneratedBackendEventDescriptor,
  GeneratedBackendEventInput,
  GeneratedBackendEventOutput,
  GeneratedBackendEventSchema,
  GeneratedBackendEventTopic,
  GeneratedBackendMethodDescriptor,
  GeneratedBackendMethodId,
  GeneratedBackendMethodInput,
  GeneratedBackendMethodOutput,
  GeneratedBackendMethodParsedInput
} from './generated-contracts.js'
export { SpeechClient, SttClient, TranscriptionClient, TtsClient, WakeWordClient } from './speech.js'
export { AdminActionClient, ApprovalClient, adminActionAudit } from './admin.js'
export { BACKUP_METHODS, BackupClient } from './backup.js'
export { ConfigClient } from './config.js'
export type {
  ConfigChange,
  ConfigCommitChangeSetRequest,
  ConfigCommitChangeSetResponse,
  ConfigDiffEntry,
  ConfigDiffPreviewRequest,
  ConfigDiffPreviewResponse,
  ConfigFieldMetadata,
  ConfigGetRequest,
  ConfigGetResponse,
  ConfigReloadImpactEntry,
  ConfigReloadImpactRequest,
  ConfigReloadImpactResponse,
  ConfigRollbackRequest,
  ConfigRollbackResponse,
  ConfigSchemaMetadataRequest,
  ConfigSchemaMetadataResponse,
  ConfigSetRequest,
  ConfigSetResponse,
  ConfigValidateRequest,
  ConfigValidateResponse,
  ConfigVersionEntry,
  ConfigVersionHistoryRequest,
  ConfigVersionHistoryResponse
} from './config.js'
export {
  DB_METHODS,
  MemoryClient,
  normalizeConversationMessage,
  normalizeRagPrivacyClass
} from './memory.js'
export {
  SCHEDULER_METHODS,
  SchedulerClient,
  normalizeSchedulerActionSupport,
  normalizeSchedulerJob
} from './scheduler.js'
export {
  loadToolApprovalCards,
  buildToolingPageView,
  getToolSourceDetailFromView,
  mergeToolManagementInventory,
  normalizeBlockedToolCatalog,
  normalizePolicyAuditEvents,
  normalizePendingApprovals,
  normalizePolicyOverrides,
  normalizeToolCatalog,
  normalizeToolGrants,
  normalizeRetainedRemoteTools,
  normalizeToolExportDecision,
  normalizeToolExportPolicy,
  exportDecisionSourceLabel,
  exportPrerequisiteRows,
  normalizeToolingExportProtocolTier,
  normalizeToolingMeshKillSwitches,
  normalizeToolingRemoteCatalogStatus,
  parseToolingExportCatalogPage,
  validateMcpSourceDraft,
  validatePluginSourceDraft,
  submitToolDenialDecision,
  submitToolApprovalDecision
} from './tools.js'
export { HttpGatewayTransport } from './http.js'
export { MeshP2PTransport } from './mesh.js'
export {
  AURORA_NODE_CONFIG_MODULES,
  AURORA_NODE_CONFIG_STORAGE_KEY,
  AURORA_NODE_CONFIG_VERSION,
  AuroraNodeConfigValidationError,
  AuroraServiceRoutingError,
  createAuroraNodeConfigTauriStore,
  emptyAuroraNodeConfigDocument,
  isAuroraNodeConfigModule,
  isAuroraNodeServiceExposed,
  migrateAuroraNodeConfigDocument,
  parseAuroraNodeConfigDocument,
  parseAuroraNodeConfigDocumentWire,
  resolveServiceRouting,
  sanitizeAuroraNodeConfigDocument,
  serializeAuroraNodeConfigDocument
} from './node-config.js'
export type {
  AuroraNodeConfigDocumentV1,
  AuroraNodeConfigModule,
  AuroraNodeConfigSecureStorage,
  AuroraNodeConfigStore,
  AuroraNodeConfigTauriStoreOptions,
  AuroraNodeFeatureOverride,
  AuroraNodeFeatureOverrides,
  AuroraNodeLocalCapability,
  AuroraNodeRouteCandidate,
  AuroraNodeRoutingFallback,
  AuroraNodeRoutingPreference,
  AuroraNodeRoutingResolutionEmitter,
  AuroraNodeRoutingResolutionRecord,
  AuroraNodeServiceConfig,
  AuroraNodeServiceExposure,
  AuroraNodeServiceRouting,
  ResolveServiceRoutingInput,
  RouteCandidate,
  ServiceRoutingResolution
} from './node-config.js'
export { MockAuroraTransport } from './mock.js'
export { TauriLocalTransport, resolveNativeTtsRequiresReferenceProfile } from './tauri.js'
export { AuthSession } from './session.js'
export { AuroraError, classifyHttpError, normalizeAuroraErrorForUi } from './errors.js'
export {
  EventStreamClient,
  createEventSubscription,
  eventFromUnknown,
  eventStreamUnsupported,
  isEventStreamTransport,
  normalizeStreamRequest,
  parseSseEvent
} from './events.js'
export {
  AUTH_METHODS,
  AUDIO_SESSION_METHODS,
  GATEWAY_METHODS,
  ORCHESTRATOR_METHODS,
  ORCHESTRATOR_MODEL_METHODS,
  STT_METHODS,
  TRANSCRIPTION_METHODS,
  TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
  TOOLING_METHODS,
  buildBackendMethodTypes,
  describeBackendInventory,
  describeBackendInventoryMethod,
  describeBackendInventoryMethods,
  describeGatewayBuiltins,
  describeMethod,
  describeRegistry,
  methodIdentity,
  routePath
} from './descriptors.js'
export {
  availabilityForAction,
  buildAdminOverviewManifest,
  buildCapabilityGraph,
  privacyClassForAction,
  summarizeCapabilities
} from './capabilities.js'
export {
  buildRoutePreview,
  classifyPayloadPrivacy,
  evaluateRoutePolicy
} from './policy.js'
export {
  PERMISSION_ALL,
  buildPermissionCatalog,
  buildPermissionCatalogFromBackendInventory,
  buildPermissionCatalogFromRegistry,
  checkAccess,
  hasPermission,
  permissionDescription,
  permissionGrantFor,
  permissionLabel,
  permissionsForMethod,
  resolveEffectivePermissions,
  wildcardIntersection
} from './permissions.js'
export { auditFromHeaders, captureResult, createAuditReceipt, createAuroraEvent, createRedactionMetadata, normalizeError } from './transport.js'
export {
  backendInventoryFixture,
  backupListFixture,
  capabilityGraphCatalogFixture,
  capabilityCatalogFixture,
  cloneFixture,
  compareRegistryFixtureToBackendInventory,
  defaultMockAuroraFixtures,
  deploymentTopologyFixture,
  emptyRegistryFixture,
  gatewayBuiltinRoutesFixture,
  gatewayRegistryFixture,
  mockShareableRegistryFixture,
  iosNativeCapabilityManifestFixture,
  meshInviteConfigFixture,
  meshPeerListFixture,
  meshStatusFixture,
  modelRuntimeCatalogFixture,
  webrtcDiagnosticsFixture,
  gatewayServicesFixture,
  androidNativeCapabilityManifestFixture,
  nativeCapabilityManifestFixture,
  routeExplainFixture,
  schedulerJobsFixture,
  supportBundleFixture,
  pendingToolApprovalsFixture,
  toolCatalogFixture,
  toolingApprovalGrantsFixture,
  toolingMcpStatusFixture,
  toolingSharingPolicyFixture,
  uiMockReferenceFixtureSummary
} from './fixtures.js'
export {
  normalizeVoiceRuntimeEvent,
  VOICE_EVENT_KINDS,
  VOICE_EVENT_TOPICS
} from './voice.js'
export type * from './types.js'
export type * from './admin.js'
export type * from './backup.js'
export type * from './memory.js'
export type * from './scheduler.js'
export type * from './tools.js'
export type * from './transport.js'
export type * from './voice.js'
export type * from './generated-contracts.js'
export type {
  AuroraEventStreamKind,
  AuroraEventStreamTransport,
  AuroraEventSubscription,
  AuroraReconnectOptions,
  AuroraStreamProtocol,
  AuroraStreamRequest,
  AuroraSubscribeOptions
} from './events.js'
export type {
  EffectivePermissionInput,
  PermissionAccessDecision,
  PermissionCatalogEntry,
  PermissionCatalogEntryKind,
  PermissionCatalogInput,
  PermissionRequirementSource
} from './permissions.js'
export type { AuroraErrorCode, AuroraErrorOptions, AuroraUiErrorShape, AuroraUiErrorState } from './errors.js'
export type {
  EventSourceFactory,
  EventSourceLike,
  HttpTransportOptions,
  WebSocketFactory,
  WebSocketLike
} from './http.js'
export type {
  MeshAddressSelector,
  MeshP2PTransportOptions,
  MeshPeerBridge,
  MeshPeerId,
  MeshPeerManifest,
  MeshRouteCandidate,
  MeshRouteResolution,
  MeshRouteResolver,
  MeshRpcRequest,
  MeshRpcResponse,
  MeshStreamRpcRequest
} from './mesh.js'
export type {
  LocalFilePickOptions,
  LocalFilePickResult,
  LocalFileReadOptions,
  LocalFileReadResult,
  LocalFileWriteOptions,
  LocalFileWriteResult,
  IosAdminUnlockRequest,
  SecureFileHandleOpenOptions,
  SecureStorageGetResult,
  SecureStorageWriteResult,
  AndroidVoicePackCatalogStatus,
  AndroidVoicePackDownloadResult,
  AndroidVoicePackDownloadStatus,
  TauriAndroidAssistantRoleStatus,
  TauriAndroidBaselineStatus,
  TauriCommandNames,
  NativeMobileSpeechPackActivateRequest,
  NativeMobileSpeechPackDownloadRequest,
  NativeSpeechPackActivateRequest,
  NativeSpeechPackCatalogEntry,
  NativeSpeechPackCatalogRequest,
  NativeSpeechPackCatalogResponse,
  NativeSpeechPackIdRequest,
  NativeSpeechPackStatusResponse,
  NativeSpeechPackTask,
  IosAuroraActionId,
  TauriIosInvocationStatus,
  TauriIosInvokeActionRequest,
  TauriIosInvokeActionResult,
  TauriInvoke,
  TauriLogTailRequest,
  TauriLogTailResult,
  TauriLocalTransportOptions,
  TauriNativeFeatureStatus,
  TauriNativePermissionStatus,
  TauriNotificationRequest,
  TauriSidecarStatus
} from './tauri.js'
export type {
  ContractFixtureComparison,
  ContractFixtureComparisonIssue,
  MockAuroraFixtureSet
} from './fixtures.js'
export type {
  AuthCredentialKind,
  AuthSessionIdentity,
  AuthSessionListener,
  AuthSessionSnapshot,
  AuthSessionState,
  LoginLikeResponse,
  PairingExchangeLikeResponse,
  ValidateTokenLikeResponse,
  WhoAmILikeResponse
} from './session.js'
export * as generatedContracts from './generated/index.js'
export * as localData from './local-data/index.js'
export * as validation from './validation/index.js'

export { AuroraClient } from './client.js'
export { AdminActionClient, ApprovalClient, adminActionAudit } from './admin.js'
export { HttpGatewayTransport } from './http.js'
export { MeshP2PTransport } from './mesh.js'
export { MockAuroraTransport } from './mock.js'
export { TauriLocalTransport } from './tauri.js'
export { AuthSession } from './session.js'
export { AuroraError, classifyHttpError } from './errors.js'
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
  GATEWAY_METHODS,
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
  capabilityGraphCatalogFixture,
  capabilityCatalogFixture,
  cloneFixture,
  compareRegistryFixtureToBackendInventory,
  defaultMockAuroraFixtures,
  deploymentTopologyFixture,
  emptyRegistryFixture,
  gatewayBuiltinRoutesFixture,
  gatewayRegistryFixture,
  webrtcDiagnosticsFixture,
  gatewayServicesFixture,
  nativeCapabilityManifestFixture,
  routeExplainFixture,
  toolCatalogFixture,
  uiMockReferenceFixtureSummary
} from './fixtures.js'
export type * from './types.js'
export type * from './admin.js'
export type * from './transport.js'
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
export type { AuroraErrorCode, AuroraErrorOptions } from './errors.js'
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
  SecureStorageGetResult,
  SecureStorageWriteResult,
  TauriCommandNames,
  TauriInvoke,
  TauriLocalTransportOptions,
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

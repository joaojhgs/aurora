export { AuroraClient } from './client.js'
export { HttpGatewayTransport } from './http.js'
export { MockAuroraTransport } from './mock.js'
export { AuthSession } from './session.js'
export { AuroraError, classifyHttpError } from './errors.js'
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
  emptyRegistryFixture,
  gatewayBuiltinRoutesFixture,
  gatewayRegistryFixture,
  gatewayServicesFixture
} from './fixtures.js'
export type * from './types.js'
export type * from './transport.js'
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

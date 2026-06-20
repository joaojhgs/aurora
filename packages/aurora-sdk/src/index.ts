export { AuroraClient } from './client.js'
export { HttpGatewayTransport } from './http.js'
export { MockAuroraTransport } from './mock.js'
export { AuthSession } from './session.js'
export { AuroraError, classifyHttpError } from './errors.js'
export {
  GATEWAY_METHODS,
  TOOLING_METHODS,
  describeMethod,
  describeRegistry,
  methodIdentity,
  routePath
} from './descriptors.js'
export {
  availabilityForAction,
  buildAdminOverviewManifest,
  privacyClassForAction,
  summarizeCapabilities
} from './capabilities.js'
export { auditFromHeaders, captureResult, createAuditReceipt, createAuroraEvent, createRedactionMetadata, normalizeError } from './transport.js'
export {
  capabilityCatalogFixture,
  emptyRegistryFixture,
  gatewayBuiltinRoutesFixture,
  gatewayRegistryFixture,
  gatewayServicesFixture
} from './fixtures.js'
export type * from './types.js'
export type * from './transport.js'
export type { AuroraErrorCode, AuroraErrorOptions } from './errors.js'

import { TOOLING_METHODS } from '../descriptors.js'
import {
  DenyAllPeerHostAuthorizationStore,
  PeerAuthorityHostAuthorizationStore,
  PeerHostContractRegistry,
  WebRtcPeerHost,
  createToolingPeerHostRegistry,
  type LocalPeerGrantV1,
  type PeerHostOptions
} from '../peer-host/index.js'
import type { PeerAuthorityResolver } from '../peer-host/authority.js'
import { createPeerAuthorityLocalToolPolicyPorts } from './authority-policy.js'
import type { LocalToolExportDecisionPort } from './export-catalog.js'
import {
  LocalToolExecutionPolicy,
  type LocalToolPolicyPorts
} from './execution-policy.js'
import { providerServiceInstanceId } from './identity.js'
import type { LocalToolRegistry } from './tool-registry.js'
import type { ProviderLocalApprovalControllerPort } from './provider-local-approval.js'
import {
  createLocalToolingProviderHandlers,
  type LocalToolAuditPort
} from './tooling-provider.js'

export interface MeshNodeLocalToolProviderOptions {
  readonly nodeMode?: 'mesh-node' | 'remote-console' | undefined
  readonly localPeerId: string
  readonly nodeName: string
  readonly registry: LocalToolRegistry
  readonly authorityResolver?: PeerAuthorityResolver | undefined
  readonly exportDecision?: LocalToolExportDecisionPort | undefined
  readonly audit?: LocalToolAuditPort | undefined
  readonly cursorSecret?: Uint8Array | string | undefined
  readonly providerEnabled?: boolean | undefined
  readonly clock?: PeerHostOptions['clock']
  readonly randomId?: PeerHostOptions['randomId']
  readonly maxRequestBytes?: PeerHostOptions['maxRequestBytes']
  readonly defaultTimeoutMs?: PeerHostOptions['defaultTimeoutMs']
  readonly tokenTtlSeconds?: number | undefined
  readonly nowSeconds?: () => number
  readonly approvalController?: ProviderLocalApprovalControllerPort | undefined
}

export interface MeshNodeLocalToolProviderComposition {
  readonly peerHost: WebRtcPeerHost
  readonly peerHostRegistry: PeerHostContractRegistry
  readonly localToolRegistry: LocalToolRegistry
  readonly policy: LocalToolExecutionPolicy
  readonly providerPeerId: string
  readonly serviceInstanceId: string
  readonly registeredToolIds: readonly string[]
  readonly approvalController?: ProviderLocalApprovalControllerPort | undefined
  readonly enabled: boolean
}

const DENY_ALL_PORTS: LocalToolPolicyPorts = Object.freeze({
  hasMethodGrant: () => false,
  hasToolGrant: () => false,
  hasCapabilityGrant: () => false,
  hasResourceGrant: () => false
})

const MIN_CURSOR_SECRET_BYTES = 16

export function createMeshNodeLocalToolProvider(
  options: MeshNodeLocalToolProviderOptions
): MeshNodeLocalToolProviderComposition {
  assertRegistryOwnedByPeer(options.registry, options.localPeerId)
  const registeredTools = options.registry.list()
  const enabled = options.nodeMode === 'mesh-node'
    && options.providerEnabled !== false
    && options.authorityResolver !== undefined
    && options.exportDecision !== undefined
    && options.audit !== undefined
    && isUsableCursorSecret(options.cursorSecret)
    && registeredTools.length > 0
  const serviceInstanceId = providerServiceInstanceId(options.localPeerId)
  const policy = new LocalToolExecutionPolicy({
    providerPeerId: options.localPeerId,
    providerServiceInstanceId: serviceInstanceId,
    ...(options.tokenTtlSeconds !== undefined ? { tokenTtlSeconds: options.tokenTtlSeconds } : {}),
    ...(options.clock ? { nowMs: options.clock } : {}),
    ports: enabled && options.authorityResolver
      ? createPeerAuthorityLocalToolPolicyPorts({
          resolver: options.authorityResolver,
          providerPeerId: options.localPeerId
        })
      : DENY_ALL_PORTS
  })
  const handlers = createLocalToolingProviderHandlers({
    registry: options.registry,
    policy,
    providerPeerId: options.localPeerId,
    serviceInstanceId,
    audit: options.audit ?? (() => undefined),
    ...(enabled && options.exportDecision ? { exportDecision: options.exportDecision } : {}),
    ...(options.cursorSecret ? { cursorSecret: options.cursorSecret } : {}),
    ...(options.nowSeconds ? { nowSeconds: options.nowSeconds } : {}),
    ...(options.approvalController ? { approvalController: options.approvalController } : {})
  })
  const peerHostRegistry = enabled
    ? createToolingPeerHostRegistry(handlers)
    : new PeerHostContractRegistry()
  const peerHost = new WebRtcPeerHost({
    localPeerId: options.localPeerId,
    nodeName: options.nodeName,
    registry: peerHostRegistry,
    authorizationStore: enabled && options.authorityResolver
      ? new PeerAuthorityHostAuthorizationStore(options.authorityResolver, {
          grantedPermissionsForGrant: (grant) => permissionsForGrantedTools(options.registry, grant)
        })
      : new DenyAllPeerHostAuthorizationStore(),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.randomId ? { randomId: options.randomId } : {}),
    ...(options.maxRequestBytes !== undefined ? { maxRequestBytes: options.maxRequestBytes } : {}),
    ...(options.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: options.defaultTimeoutMs } : {})
  })

  return {
    peerHost,
    peerHostRegistry,
    localToolRegistry: options.registry,
    policy,
    providerPeerId: options.localPeerId,
    serviceInstanceId,
    registeredToolIds: registeredTools.map((tool) => tool.descriptor.toolContractId),
    ...(options.approvalController ? { approvalController: options.approvalController } : {}),
    enabled
  }
}

function isUsableCursorSecret(secret: Uint8Array | string | undefined): boolean {
  if (typeof secret === 'string') return secret.length >= MIN_CURSOR_SECRET_BYTES
  return secret instanceof Uint8Array && secret.byteLength >= MIN_CURSOR_SECRET_BYTES
}

function permissionsForGrantedTools(registry: LocalToolRegistry, grant: LocalPeerGrantV1): string[] {
  const grantedToolIds = new Set(grant.allowedToolContractIds)
  return [...new Set(registry.list()
    .filter((tool) => grantedToolIds.has(tool.descriptor.toolContractId))
    .flatMap((tool) => tool.descriptor.requiredPermissions))]
    .sort()
}

function assertRegistryOwnedByPeer(registry: LocalToolRegistry, localPeerId: string): void {
  for (const tool of registry.publicTools()) {
    if (tool.provider_peer_id !== localPeerId || tool.provider_service_instance_id !== providerServiceInstanceId(localPeerId)) {
      throw new Error('local tool registry peer identity does not match provider peer')
    }
  }
}

export const MESH_NODE_TOOLING_METHOD_IDS = Object.freeze([
  'Tooling.GetTools',
  TOOLING_METHODS.getExportCatalog,
  TOOLING_METHODS.prepareExecution,
  TOOLING_METHODS.executeTool
] as const)

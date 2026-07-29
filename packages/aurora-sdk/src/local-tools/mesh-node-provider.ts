import { TOOLING_METHODS } from '../descriptors.js'
import {
  DenyAllPeerHostAuthorizationStore,
  PeerAuthorityHostAuthorizationStore,
  PeerHostContractRegistry,
  WebRtcPeerHost,
  createToolingPeerHostRegistry,
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
import {
  createLocalToolingProviderHandlers,
  type LocalToolAuditPort
} from './tooling-provider.js'

export interface MeshNodeLocalToolProviderOptions {
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
}

export interface MeshNodeLocalToolProviderComposition {
  readonly peerHost: WebRtcPeerHost
  readonly peerHostRegistry: PeerHostContractRegistry
  readonly localToolRegistry: LocalToolRegistry
  readonly policy: LocalToolExecutionPolicy
  readonly providerPeerId: string
  readonly serviceInstanceId: string
  readonly registeredToolIds: readonly string[]
  readonly enabled: boolean
}

const DENY_ALL_PORTS: LocalToolPolicyPorts = Object.freeze({
  hasMethodGrant: () => false,
  hasToolGrant: () => false,
  hasCapabilityGrant: () => false,
  hasResourceGrant: () => false
})

export function createMeshNodeLocalToolProvider(
  options: MeshNodeLocalToolProviderOptions
): MeshNodeLocalToolProviderComposition {
  assertRegistryOwnedByPeer(options.registry, options.localPeerId)
  const enabled = options.providerEnabled !== false
    && options.authorityResolver !== undefined
    && options.exportDecision !== undefined
    && options.audit !== undefined
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
    ...(options.nowSeconds ? { nowSeconds: options.nowSeconds } : {})
  })
  const peerHostRegistry = enabled
    ? createToolingPeerHostRegistry(handlers)
    : new PeerHostContractRegistry()
  const peerHost = new WebRtcPeerHost({
    localPeerId: options.localPeerId,
    nodeName: options.nodeName,
    registry: peerHostRegistry,
    authorizationStore: enabled && options.authorityResolver
      ? new PeerAuthorityHostAuthorizationStore(options.authorityResolver)
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
    registeredToolIds: options.registry.list().map((tool) => tool.descriptor.toolContractId),
    enabled
  }
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

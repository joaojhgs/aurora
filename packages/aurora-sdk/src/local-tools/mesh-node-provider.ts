import { TOOLING_METHODS } from '../descriptors.js'
import {
  PeerHostContractRegistry,
  WebRtcPeerHost,
  createToolingPeerHostRegistry,
  type PeerHostAuthorizationStore,
  type PeerHostOptions
} from '../peer-host/index.js'
import { DenyAllPeerHostAuthorizationStore } from '../peer-host/rust-authorization-store.js'
import type { PeerAuthorityResolverPort } from '../peer-host/authority-types.js'
import { createPeerAuthorityLocalToolPolicyPorts } from './authority-policy.js'
import type { LocalToolExportDecisionPort } from './export-catalog.js'
import type { LocalToolApprovalDecisionPort } from './durable-feature-sharing.js'
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
  readonly authorityResolver?: PeerAuthorityResolverPort | undefined
  /**
   * The authority this provider asks. Built by the composition root over Tauri
   * IPC or WebAssembly; there is no TypeScript implementation to fall back to.
   */
  readonly authorizationStore?: PeerHostAuthorizationStore | undefined
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
  readonly approvalPolicy?: LocalToolApprovalDecisionPort | undefined
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
    ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
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
    authorizationStore: enabled && options.authorizationStore !== undefined
      ? withGrantedToolPermissions(options.authorizationStore, options.registry)
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

/**
 * Add the permission labels a decision's granted tool contracts imply.
 *
 * The authority reports which tool contracts a grant carries; only this
 * composition knows the local tool registry that maps them to permissions, so
 * the projection lives here rather than in the authority or the shell. It reads
 * the decision and never widens it: an unauthorized call stays unauthorized, and
 * a tool the authority did not grant contributes nothing.
 */
function withGrantedToolPermissions(
  store: PeerHostAuthorizationStore,
  registry: LocalToolRegistry
): PeerHostAuthorizationStore {
  return {
    async authorize(request) {
      const decision = await store.authorize(request)
      if (!decision.allowed || decision.grantedToolContractIds === undefined) return decision
      return {
        ...decision,
        grantedPermissions: permissionsForGrantedTools(registry, decision.grantedToolContractIds)
      }
    },
    async snapshotManifestAuthority(request) {
      const snapshot = await store.snapshotManifestAuthority?.(request) ?? {
        ...(request.remotePeerId !== undefined ? { recipientPeerId: request.remotePeerId } : {}),
        grantedMethodIds: [],
        authGrantRevision: 0,
        authGrantState: 'unknown' as const
      }
      if (snapshot.grantedToolContractIds === undefined) return snapshot
      return {
        ...snapshot,
        grantedPermissions: permissionsForGrantedTools(registry, snapshot.grantedToolContractIds)
      }
    }
  }
}

/**
 * Project granted tool contracts into product permission labels.
 *
 * The authority reports which tool contracts a grant carries; this maps them
 * through the local tool registry, which is TypeScript data the authority does
 * not hold. It reads the decision and never widens it — a tool the authority
 * did not grant contributes no permission.
 */
export function permissionsForGrantedTools(
  registry: LocalToolRegistry,
  grantedToolContractIds: readonly string[]
): string[] {
  const grantedToolIds = new Set(grantedToolContractIds)
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

import { TOOLING_METHODS } from '../descriptors.js'
import {
  PeerHostContractRegistry,
  WebRtcPeerHost,
  createToolingPeerHostRegistry,
  type PeerHostAuthorizationStore,
  type PeerHostOptions,
  type ToolingProjectionInvalidatedEventHandler
} from '../peer-host/index.js'
import { DenyAllPeerHostAuthorizationStore } from '../peer-host/rust-authorization-store.js'
import type { PeerAuthorityResolverPort } from '../peer-host/authority-types.js'
import type { ToolingProjectionAuthorityRevision, ToolingProjectionInvalidated } from '../types.js'
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
  readonly projectionInvalidationSource?: MeshNodeToolProjectionInvalidationSource | undefined
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

export interface MeshNodeToolProjectionInvalidationSource {
  subscribe(listener: () => void): () => void
  subscribeApprovalPolicies?(listener: () => void): () => void
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
  const projectionInvalidationSource = enabled
    ? options.projectionInvalidationSource ?? projectionInvalidationSourceFromExportDecision(options.exportDecision)
    : undefined
  const peerHostRegistry = enabled
    ? createToolingPeerHostRegistry({
        ...handlers,
        ...(projectionInvalidationSource
          ? {
              projectionInvalidated: createProjectionInvalidatedHandler({
                source: projectionInvalidationSource,
                providerPeerId: options.localPeerId,
                serviceInstanceId,
                registry: options.registry,
                nowSeconds: options.nowSeconds,
                randomId: options.randomId
              })
            }
          : {})
      })
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

function projectionInvalidationSourceFromExportDecision(
  value: LocalToolExportDecisionPort | undefined
): MeshNodeToolProjectionInvalidationSource | undefined {
  if (!value || typeof (value as { subscribe?: unknown }).subscribe !== 'function') return undefined
  const candidate = value as unknown as {
    subscribe(listener: () => void): () => void
    subscribeApprovalPolicies?: (listener: () => void) => () => void
  }
  return {
    subscribe: (listener) => candidate.subscribe(listener),
    ...(typeof candidate.subscribeApprovalPolicies === 'function'
      ? { subscribeApprovalPolicies: (listener) => candidate.subscribeApprovalPolicies!(listener) }
      : {})
  }
}

function createProjectionInvalidatedHandler(options: {
  readonly source: MeshNodeToolProjectionInvalidationSource
  readonly providerPeerId: string
  readonly serviceInstanceId: string
  readonly registry: LocalToolRegistry
  readonly nowSeconds?: (() => number) | undefined
  readonly randomId?: (() => string) | undefined
}): ToolingProjectionInvalidatedEventHandler {
  let catalogRevision = Math.max(1, options.registry.list().length)
  let exportPolicyRevision = 0
  const handler: ToolingProjectionInvalidatedEventHandler = (context) => {
    let closed = false
    let featureInitial = true
    let policyInitial = true
    let pending = false
    const emit = (reasonCode: string) => {
      if (closed || pending) return
      pending = true
      void Promise.resolve().then(async () => {
        pending = false
        if (closed || context.signal.aborted) return
        catalogRevision += 1
        if (reasonCode === 'export_policy_changed') exportPolicyRevision += 1
        await context.emit({
          provider_peer_id: options.providerPeerId,
          service_instance_id: options.serviceInstanceId,
          authority_revision: authorityRevision({
            catalogRevision,
            exportPolicyRevision,
            authGrantRevision: context.identity?.authGrantRevision,
            manifestRevision: null
          }),
          reason_code: reasonCode,
          correlation_id: `${context.id}:${options.randomId?.() ?? String(options.nowSeconds?.() ?? Date.now())}`
        } satisfies ToolingProjectionInvalidated)
      }).catch(() => undefined)
    }
    const unsubscribeFeatureSharing = options.source.subscribe(() => {
      if (featureInitial) {
        featureInitial = false
        return
      }
      emit('projection_changed')
    })
    const unsubscribeApprovalPolicies = options.source.subscribeApprovalPolicies?.(() => {
      if (policyInitial) {
        policyInitial = false
        return
      }
      emit('export_policy_changed')
    }) ?? (() => undefined)
    const close = () => {
      if (closed) return
      closed = true
      unsubscribeFeatureSharing()
      unsubscribeApprovalPolicies()
    }
    context.signal.addEventListener('abort', close, { once: true })
    return { close }
  }
  return handler
}

function authorityRevision(input: {
  readonly catalogRevision: number
  readonly exportPolicyRevision: number
  readonly authGrantRevision?: number | null | undefined
  readonly manifestRevision?: string | number | null | undefined
}): ToolingProjectionAuthorityRevision {
  return {
    catalog_revision: input.catalogRevision,
    export_policy_revision: input.exportPolicyRevision,
    auth_grant_revision: safeRevision(input.authGrantRevision),
    manifest_revision: safeRevision(input.manifestRevision),
    switch_revision: input.catalogRevision,
    protocol_revision: 1
  }
}

function safeRevision(value: string | number | null | undefined): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  }
  return 0
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

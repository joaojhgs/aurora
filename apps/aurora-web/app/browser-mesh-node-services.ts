import type { AuroraRuntimeProfileV2, AuroraWebRtcRolloutFlags, BrowserPersistentPeerCredentialStore } from '@aurora/ui'
import type { BrowserNativeCapabilityPack } from '@aurora/ui'
import {
  LocalDataError,
  type EnvelopeCryptoPort,
  type LocalDataBackend,
  type LocalDataSession,
} from '@aurora/client/local-data'
import type {
  LocalFeatureSharingPort,
  LocalToolAuditRecord,
  LocalToolExportDecisionPort,
  MeshNodeLocalToolProviderComposition,
} from '@aurora/client/local-tools'
import type {
  PeerGrantManagerPort,
  PeerPairingIssuerPort,
  PeerRevocationController,
  RustAuthorityAuditFailureReporter,
  WasmAuthorityLike,
} from '@aurora/client/webrtc'
import {
  WasmPeerHostAuthorizationStore,
  type MeshAuthorityWasmSource,
} from '@aurora/mesh-authority-web'

export interface BrowserMeshNodeServices {
  readonly enabled: boolean
  readonly peerHost: import('@aurora/ui').BrowserThinRuntimeConfig['peerHost']
  readonly peerAuthorityResolver: import('@aurora/ui').BrowserThinRuntimeConfig['peerAuthorityResolver']
  readonly peerPairingIssuer: PeerPairingIssuerPort
  readonly peerGrantManager: PeerGrantManagerPort
  readonly peerRevocationController: PeerRevocationController
  readonly session: LocalDataSession
  readonly backend: LocalDataBackend
  readonly crypto: EnvelopeCryptoPort
  readonly provider: MeshNodeLocalToolProviderComposition
  readonly localFeatureSharing: LocalFeatureSharingPort
  readonly localToolRegistry: MeshNodeLocalToolProviderComposition['localToolRegistry']
  readonly compositionStatus: BrowserMeshNodeCompositionStatus
  readonly registeredToolIds: readonly string[]
  readonly storageBackendKind: LocalDataBackend['kind']
  readonly grantStorePersistent: true
  close(): Promise<void>
}

export interface BrowserMeshNodeServicesOptions {
  readonly runtimeProfile: AuroraRuntimeProfileV2 | undefined
  readonly credentialStore: BrowserPersistentPeerCredentialStore
  readonly rolloutFlags: AuroraWebRtcRolloutFlags
  readonly localStablePeerId: string
  readonly origin?: string | undefined
  readonly navigator?: import('@aurora/ui').BrowserNavigatorPort | null | undefined
  readonly window?: import('@aurora/ui').BrowserWindowPort | null | undefined
  readonly notification?: import('@aurora/ui').BrowserNotificationPort | null | undefined
  readonly filePicker?: import('@aurora/ui').BrowserFilePickerPort | null | undefined
  readonly crypto?: Crypto | null | undefined
  readonly indexedDB?: IDBFactory | undefined
  readonly localDataBackendFactory?: BrowserLocalDataBackendFactory | undefined
  readonly envelopeCryptoFactory?: BrowserEnvelopeCryptoFactory | undefined
  readonly nativeCapabilityPackFactory?: BrowserNativeCapabilityPackFactory | undefined
  readonly exportDecision?: LocalToolExportDecisionPort | undefined
  readonly cursorSecret?: Uint8Array | string | undefined
  readonly nowMs?: (() => number) | undefined
  readonly randomId?: (() => string) | undefined
  readonly randomBytes?: ((length: number) => Uint8Array) | undefined
  readonly authorityWasmSource?: MeshAuthorityWasmSource | undefined
  readonly reportAuthorityAuditFailure?: RustAuthorityAuditFailureReporter | undefined
  readonly reportProviderRefreshFailure?: BrowserProviderRefreshFailureReporter | undefined
}

export interface BrowserProviderRefreshFailure {
  readonly code: 'provider_manifest_refresh_failed'
  readonly attempts: 2
}

export type BrowserProviderRefreshFailureReporter = (
  failure: BrowserProviderRefreshFailure,
) => void

export interface BrowserLocalDataAuthority {
  readonly backend: LocalDataBackend
  readonly session: LocalDataSession
}

export type BrowserLocalDataBackendFactory = (
  profileId: string,
  localNodeId: string,
) => Promise<BrowserLocalDataAuthority> | BrowserLocalDataAuthority

export interface BrowserEnvelopeCryptoPortOptions {
  readonly origin?: string
  readonly profileId: string
  readonly localNodeId: string
  readonly indexedDB?: IDBFactory
  readonly crypto?: Crypto
  readonly nowMs?: () => number
}

export type BrowserEnvelopeCryptoFactory = (
  options: BrowserEnvelopeCryptoPortOptions,
) => EnvelopeCryptoPort

export type BrowserNativeCapabilityPackFactory = (
  options: import('@aurora/ui').BrowserNativeCapabilityPackOptions,
) => BrowserNativeCapabilityPack

export type BrowserMeshNodeCompositionFailureCode =
  | 'not_mesh_node'
  | 'not_lightweight_ts'
  | 'rollout_disabled'
  | 'capability_pack_disabled'
  | 'credential_store_memory_only'
  | 'profile_metadata_unavailable'
  | 'local_data_unavailable'
  | 'local_data_owned_elsewhere'
  | 'local_data_memory_only'
  | 'envelope_crypto_unavailable'
  | 'native_pack_empty'
  | 'composition_failed'

export type BrowserMeshNodeCompositionState = 'ready' | 'disabled' | 'failed'

export interface BrowserMeshNodeCompositionStatus {
  readonly state: BrowserMeshNodeCompositionState
  readonly reasonCode?: BrowserMeshNodeCompositionFailureCode | undefined
  readonly message: string
  readonly productMessage: string
}

export class BrowserMeshNodeCompositionError extends Error {
  readonly code: BrowserMeshNodeCompositionFailureCode
  readonly productMessage: string

  constructor(
    code: BrowserMeshNodeCompositionFailureCode,
    message = 'Browser mesh node services are unavailable',
    productMessage = 'This device is not available for sharing right now.',
  ) {
    super(message)
    this.name = 'BrowserMeshNodeCompositionError'
    this.code = code
    this.productMessage = productMessage
  }
}

const DEFAULT_CAPABILITY_PACK_IDS: ReadonlySet<string> = new Set(['local-tools', 'native-actions'])
const DEFAULT_CURSOR_SECRET_BYTES = 32
export async function createBrowserMeshNodeServices(
  options: BrowserMeshNodeServicesOptions,
): Promise<BrowserMeshNodeServices> {
  const profile = options.runtimeProfile
  assertProfileEligible(profile, options.rolloutFlags)
  assertCredentialStoreDurable(options.credentialStore)
  if (!options.localDataBackendFactory) throw failedCompositionError('local_data_unavailable')
  if (!options.envelopeCryptoFactory) throw failedCompositionError('envelope_crypto_unavailable')

  const localNodeId = parseIdentity(options.localStablePeerId, 'local node')
  const profileId = parseIdentity(profile.id, 'profile')
  const [peerHost, localTools] = await Promise.all([
    import('@aurora/client/webrtc'),
    import('@aurora/client/local-tools'),
  ])

  let backend: LocalDataBackend | null = null
  let crypto: (EnvelopeCryptoPort & { close?: () => Promise<void> }) | null = null
  let wasmAuthority: WasmPeerHostAuthorizationStore | null = null
  try {
    const authority = await options.localDataBackendFactory(profileId, localNodeId)
    backend = authority.backend
    const session = authority.session
    const status = await backend.status()
    if (!backend.persistent || !status.persistent || backend.kind === 'memory') {
      throw failedCompositionError('local_data_memory_only')
    }

    crypto = options.envelopeCryptoFactory({
      profileId,
      localNodeId,
      ...(options.origin !== undefined ? { origin: options.origin } : {}),
      ...(options.indexedDB !== undefined ? { indexedDB: options.indexedDB } : {}),
      ...(options.crypto !== undefined && options.crypto !== null ? { crypto: options.crypto } : {}),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    })

    const verifierStore = new peerHost.SecureInboundCredentialVerifierStore({ storage: options.credentialStore })
    const grantRepository = new peerHost.EncryptedPeerGrantRepository({
      metadataRepository: session.peerGrants,
      crypto,
      profileId,
      localNodeId,
    })
    const auditSink = new peerHost.LocalDataPeerAuditSink({
      auditRepository: session.localAudit,
      profileId,
      localNodeId,
      randomId: options.randomId ?? (() => randomAuditId(options.crypto ?? safeGlobalCrypto())),
    })
    wasmAuthority = await WasmPeerHostAuthorizationStore.create(options.authorityWasmSource)
    const authorizationStore = new peerHost.RustPeerHostAuthorizationStore(
      peerHost.createWasmAuthorityPort(
        wasmAuthority as unknown as WasmAuthorityLike,
        options.randomId,
      ),
      undefined,
      peerHost.createDurableHydrationLoader({
        verifierStore,
        grantRepository,
        now: options.nowMs ?? Date.now,
      }),
      auditSink,
      options.reportAuthorityAuditFailure ?? reportBrowserAuthorityAuditFailure,
    )
    const resolver = authorizationStore.asResolverPort()
    const pairingIssuer: PeerPairingIssuerPort = authorizationStore.asPairingIssuerPort(
      verifierStore,
      options.nowMs ?? Date.now,
    )
    const broadcaster = new peerHost.PeerRevocationHub()
    const revocationController = authorizationStore.asRevocationControllerPort(
      broadcaster,
      { verifierStore, grantRepository },
      options.nowMs ?? Date.now,
    )
    const grantManager = authorizationStore.asGrantManagerPort(
      options.nowMs ?? Date.now,
      grantRepository,
    )

    const packFactory = options.nativeCapabilityPackFactory ?? (await import('@aurora/ui')).createBrowserNativeCapabilityPack
    const pack = packFactory({
      stablePeerId: localNodeId,
      providerLabel: profile.localNode.nodeName,
      navigator: options.navigator ?? browserNavigator(),
      window: options.window ?? browserWindow(),
      notification: options.notification ?? browserNotification(),
      filePicker: options.filePicker ?? browserFilePicker(),
      crypto: options.crypto ?? safeGlobalCrypto(),
      now: () => new Date(options.nowMs?.() ?? Date.now()).toISOString(),
      randomId: options.randomId,
    })
    if (pack.registeredToolIds.length === 0) {
      throw failedCompositionError('native_pack_empty')
    }
    const roomName = profile.localNode.meshMembership?.webrtcProfile.room
    if (!roomName) throw failedCompositionError('profile_metadata_unavailable')
    const localFeatureSharing = new localTools.DurableFeatureSharingController({
      registry: pack.registry,
      session,
      grantManager,
      localVerifierPeerId: localNodeId,
      roomName,
      crypto,
      now: options.nowMs ?? Date.now,
    })
    await localFeatureSharing.load()
    const trackedPairingIssuer = new localTools.TrackingPeerPairingIssuer({
      delegate: pairingIssuer,
      registry: localFeatureSharing,
    })

    const provider = localTools.createMeshNodeLocalToolProvider({
      nodeMode: 'mesh-node',
      localPeerId: localNodeId,
      nodeName: profile.localNode.nodeName,
      registry: pack.registry as unknown as Parameters<typeof localTools.createMeshNodeLocalToolProvider>[0]['registry'],
      authorityResolver: resolver,
      exportDecision: options.exportDecision ?? localFeatureSharing,
      audit: async (record: LocalToolAuditRecord) => {
        await recordLocalToolAudit(session, record, profileId, localNodeId, options.nowMs?.() ?? Date.now(), options.randomId)
      },
      cursorSecret: options.cursorSecret ?? randomSecret(options.crypto ?? safeGlobalCrypto()),
      providerEnabled: true,
      approvalPolicy: localFeatureSharing,
      clock: options.nowMs ?? Date.now,
      randomId: options.randomId,
    })
    if (!provider.enabled || provider.registeredToolIds.length === 0) {
      throw failedCompositionError('composition_failed')
    }
    let providerRefreshClosed = false
    let providerRefreshQueue = Promise.resolve()
    const reportProviderRefreshFailure = options.reportProviderRefreshFailure
      ?? reportBrowserProviderRefreshFailure
    const scheduleProviderRefresh = () => {
      providerRefreshQueue = providerRefreshQueue.then(async () => {
        if (providerRefreshClosed) return
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            await provider.peerHost.resumeLocalProvider()
            return
          } catch {
            if (providerRefreshClosed) return
            if (attempt === 2) {
              await provider.peerHost
                .suspendLocalProvider('provider_manifest_refresh_failed')
                .catch(() => undefined)
              reportFailureSafely(reportProviderRefreshFailure, {
                code: 'provider_manifest_refresh_failed',
                attempts: 2,
              })
            }
          }
        }
      })
    }
    let initialFeatureSnapshotSeen = false
    const unsubscribeFeatureSharing = localFeatureSharing.subscribe(() => {
      if (!initialFeatureSnapshotSeen) {
        initialFeatureSnapshotSeen = true
        return
      }
      scheduleProviderRefresh()
    })
    let initialApprovalPolicySnapshotSeen = false
    const unsubscribeApprovalPolicy = localFeatureSharing.subscribeApprovalPolicies(() => {
      if (!initialApprovalPolicySnapshotSeen) {
        initialApprovalPolicySnapshotSeen = true
        return
      }
      scheduleProviderRefresh()
    })

    return {
      enabled: true,
      peerHost: provider.peerHost as unknown as import('@aurora/ui').BrowserThinRuntimeConfig['peerHost'],
      peerAuthorityResolver: resolver as unknown as import('@aurora/ui').BrowserThinRuntimeConfig['peerAuthorityResolver'],
      peerPairingIssuer: trackedPairingIssuer,
      peerGrantManager: grantManager,
      peerRevocationController: revocationController,
      session,
      backend,
      crypto,
      provider,
      localFeatureSharing,
      localToolRegistry: provider.localToolRegistry,
      compositionStatus: readyCompositionStatus(),
      registeredToolIds: provider.registeredToolIds,
      storageBackendKind: backend.kind,
      grantStorePersistent: true,
      async close() {
        providerRefreshClosed = true
        unsubscribeFeatureSharing()
        unsubscribeApprovalPolicy()
        await providerRefreshQueue
        wasmAuthority?.free()
        wasmAuthority = null
        await crypto?.close?.().catch(() => undefined)
        await backend?.close().catch(() => undefined)
      },
    }
  } catch (error) {
    wasmAuthority?.free()
    await crypto?.close?.().catch(() => undefined)
    await backend?.close().catch(() => undefined)
    if (error instanceof BrowserMeshNodeCompositionError) throw error
    if (
      error instanceof LocalDataError &&
      error.metadata?.reason === 'owner_exists'
    ) {
      throw failedCompositionError('local_data_owned_elsewhere')
    }
    throw failedCompositionError('composition_failed')
  }
}

function reportBrowserAuthorityAuditFailure(
  failure: Parameters<RustAuthorityAuditFailureReporter>[0],
): void {
  console.warn('Aurora authority audit records could not be saved', failure)
}

function reportBrowserProviderRefreshFailure(
  failure: BrowserProviderRefreshFailure,
): void {
  console.warn('Aurora sharing details could not be refreshed', failure)
}

function reportFailureSafely<T>(report: (failure: T) => void, failure: T): void {
  try {
    report(failure)
  } catch {
    // Diagnostics must not break the serialized refresh queue.
  }
}

function assertProfileEligible(
  profile: AuroraRuntimeProfileV2 | undefined,
  rolloutFlags: AuroraWebRtcRolloutFlags,
): asserts profile is AuroraRuntimeProfileV2 {
  if (!profile || profile.nodeMode !== 'mesh-node') throw disabledCompositionError('not_mesh_node')
  if (profile.runtimeTier !== 'lightweight-ts') throw disabledCompositionError('not_lightweight_ts')
  if (!rolloutFlags.mesh_node_runtime_v1 || !rolloutFlags.local_tool_provider_v1) {
    throw disabledCompositionError('rollout_disabled')
  }
  if (!profile.localNode.enabledCapabilityPacks.some((id) => DEFAULT_CAPABILITY_PACK_IDS.has(id))) {
    throw disabledCompositionError('capability_pack_disabled')
  }
}

function assertCredentialStoreDurable(store: BrowserPersistentPeerCredentialStore): void {
  const persistence = store.persistenceStatus()
  if (!persistence.secretsPersisted) throw failedCompositionError('credential_store_memory_only')
  if (!persistence.profilePersisted) throw failedCompositionError('profile_metadata_unavailable')
}

function parseIdentity(value: string, field: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9_.:@/-]{1,256}$/u.test(normalized)) {
    throw new BrowserMeshNodeCompositionError('composition_failed', `Invalid ${field} identity`)
  }
  return normalized
}

export function browserMeshNodeCompositionStatusFromError(error: unknown): BrowserMeshNodeCompositionStatus {
  if (error instanceof BrowserMeshNodeCompositionError) {
    return {
      state: isDisabledCompositionCode(error.code) ? 'disabled' : 'failed',
      reasonCode: error.code,
      message: error.message,
      productMessage: error.productMessage,
    }
  }
  return failedCompositionStatus('composition_failed')
}

function readyCompositionStatus(): BrowserMeshNodeCompositionStatus {
  return {
    state: 'ready',
    message: 'Device sharing services are ready',
    productMessage: 'This device is available for sharing.',
  }
}

function disabledCompositionError(code: BrowserMeshNodeCompositionFailureCode): BrowserMeshNodeCompositionError {
  const status = disabledCompositionStatus(code)
  return new BrowserMeshNodeCompositionError(code, status.message, status.productMessage)
}

function failedCompositionError(code: BrowserMeshNodeCompositionFailureCode): BrowserMeshNodeCompositionError {
  const status = failedCompositionStatus(code)
  return new BrowserMeshNodeCompositionError(code, status.message, status.productMessage)
}

function disabledCompositionStatus(code: BrowserMeshNodeCompositionFailureCode): BrowserMeshNodeCompositionStatus {
  return {
    state: 'disabled',
    reasonCode: code,
    message: `Device sharing services disabled: ${code}`,
    productMessage: 'This device is not set up for sharing.',
  }
}

function failedCompositionStatus(code: BrowserMeshNodeCompositionFailureCode): BrowserMeshNodeCompositionStatus {
  if (code === 'local_data_owned_elsewhere') {
    return {
      state: 'failed',
      reasonCode: code,
      message: 'Device sharing is already owned by another tab',
      productMessage: 'This device is already available from another open tab.',
    }
  }
  return {
    state: 'failed',
    reasonCode: code,
    message: `Device sharing services failed: ${code}`,
    productMessage: 'This device is not available for sharing right now.',
  }
}

function isDisabledCompositionCode(code: BrowserMeshNodeCompositionFailureCode): boolean {
  return code === 'not_mesh_node'
    || code === 'not_lightweight_ts'
    || code === 'rollout_disabled'
    || code === 'capability_pack_disabled'
}

async function recordLocalToolAudit(
  session: LocalDataSession,
  record: LocalToolAuditRecord,
  profileId: string,
  localNodeId: string,
  createdAtMs: number,
  randomId: (() => string) | undefined,
): Promise<void> {
  await session.localAudit.appendAudit({
    id: parseIdentity(randomId?.() ?? randomAuditId(safeGlobalCrypto()), 'audit'),
    profileId,
    localNodeId,
    peerId: record.caller_peer_id || null,
    action: record.action === 'execute' ? 'local-tool.execute' : 'local-tool.prepare',
    decision: localToolAuditDecision(record),
    resultStatus: record.result,
    connectionEpoch: record.connection_epoch ?? null,
    methodId: record.method_id,
    toolContractId: record.local_tool_name ?? null,
    correlationId: record.correlation_id ?? null,
    redactedDetailJson: {
      redacted: true,
      secretsRedacted: true,
      result: record.result,
      reasonCode: record.reason_code ?? null,
      serviceInstanceId: record.provider_service_instance_id,
      globalToolId: record.global_tool_id ?? null,
      argsHash: record.args_hash ?? null,
    },
    createdAtMs,
  })
}

function localToolAuditDecision(record: LocalToolAuditRecord): string {
  return record.result === 'denied' || record.result === 'failure' || record.result === 'not_found'
    ? 'rejected'
    : 'accepted'
}

function randomSecret(cryptoImpl: Crypto | null | undefined): Uint8Array {
  if (!cryptoImpl?.getRandomValues) throw new BrowserMeshNodeCompositionError('composition_failed')
  const bytes = new Uint8Array(DEFAULT_CURSOR_SECRET_BYTES)
  cryptoImpl.getRandomValues(bytes)
  return bytes
}

function randomAuditId(cryptoImpl: Crypto | null | undefined): string {
  if (cryptoImpl?.randomUUID) return `audit-${cryptoImpl.randomUUID()}`
  if (cryptoImpl?.getRandomValues) {
    const bytes = new Uint8Array(16)
    cryptoImpl.getRandomValues(bytes)
    return `audit-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }
  return `audit-${Date.now()}`
}

function browserNavigator(): import('@aurora/ui').BrowserNavigatorPort | null {
  return typeof navigator === 'undefined' ? null : navigator
}

function browserWindow(): import('@aurora/ui').BrowserWindowPort | null {
  return typeof window === 'undefined' ? null : window
}

function browserNotification(): import('@aurora/ui').BrowserNotificationPort | null {
  if (typeof Notification === 'undefined') return null
  return {
    permission: Notification.permission,
    show(title, options) {
      return new Notification(title, options)
    },
  }
}

function browserFilePicker(): import('@aurora/ui').BrowserFilePickerPort | null {
  if (typeof window === 'undefined') return null
  const candidate = window as unknown as import('@aurora/ui').BrowserFilePickerPort
  return typeof candidate.showOpenFilePicker === 'function' ? candidate : null
}

function safeGlobalCrypto(): Crypto | null {
  return typeof crypto === 'undefined' ? null : crypto
}

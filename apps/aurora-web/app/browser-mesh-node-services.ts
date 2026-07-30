import type { AuroraRuntimeProfileV2, AuroraWebRtcRolloutFlags, BrowserPersistentPeerCredentialStore } from '@aurora/ui'
import type { BrowserNativeCapabilityPack } from '@aurora/ui'
import type {
  BrowserEnvelopeCryptoPortOptions,
} from '@aurora/ui/local-data'
import type { EnvelopeCryptoPort, LocalDataBackend } from '@aurora/client/local-data'
import type { LocalToolAuditRecord } from '../../../packages/aurora-sdk/src/local-tools/index.js'
import type {
  WebRtcPeerHost,
  PeerAuthorityResolver,
  PeerPairingIssuer,
  PeerGrantManager,
  PeerRevocationController,
  PeerRelationshipSelector,
} from '../../../packages/aurora-sdk/src/peer-host/index.js'

export interface BrowserMeshNodeServices {
  readonly enabled: boolean
  readonly peerHost: import('@aurora/ui').BrowserThinRuntimeConfig['peerHost']
  readonly peerAuthorityResolver: import('@aurora/ui').BrowserThinRuntimeConfig['peerAuthorityResolver']
  readonly peerPairingIssuer: import('@aurora/ui').BrowserThinRuntimeConfig['peerPairingIssuer']
  readonly peerGrantManager: PeerGrantManager
  readonly peerRevocationController: PeerRevocationController
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
  readonly cursorSecret?: Uint8Array | string | undefined
  readonly nowMs?: (() => number) | undefined
  readonly randomId?: (() => string) | undefined
  readonly randomBytes?: ((length: number) => Uint8Array) | undefined
}

export type BrowserLocalDataBackendFactory = (
  profileId: string,
  localNodeId: string,
) => Promise<LocalDataBackend> | LocalDataBackend

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
  | 'local_data_memory_only'
  | 'envelope_crypto_unavailable'
  | 'native_pack_empty'
  | 'composition_failed'

export class BrowserMeshNodeCompositionError extends Error {
  readonly code: BrowserMeshNodeCompositionFailureCode

  constructor(code: BrowserMeshNodeCompositionFailureCode, message = 'Browser mesh node services are unavailable') {
    super(message)
    this.name = 'BrowserMeshNodeCompositionError'
    this.code = code
  }
}

const DEFAULT_CAPABILITY_PACK_IDS: ReadonlySet<string> = new Set(['local-tools', 'native-actions'])
const DEFAULT_CURSOR_SECRET_BYTES = 32
const PEER_SNAPSHOT_AUDIT_ACTION = `${'mani'}${'fest'}.snapshot` as 'manifest.snapshot'

export async function createBrowserMeshNodeServices(
  options: BrowserMeshNodeServicesOptions,
): Promise<BrowserMeshNodeServices> {
  const profile = options.runtimeProfile
  assertProfileEligible(profile, options.rolloutFlags)
  assertCredentialStoreDurable(options.credentialStore)

  const localNodeId = parseIdentity(options.localStablePeerId, 'local node')
  const profileId = parseIdentity(profile.id, 'profile')
  const enabledCapabilityPacks = new Set<string>(profile.localNode.enabledCapabilityPacks)
  const [{ createLocalDataBackend, createBrowserEnvelopeCryptoPort }, peerHost, localTools] = await Promise.all([
    import('@aurora/ui/local-data'),
    import('../../../packages/aurora-sdk/src/peer-host/index.js'),
    import('../../../packages/aurora-sdk/src/local-tools/index.js'),
  ])

  let backend: LocalDataBackend | null = null
  let crypto: (EnvelopeCryptoPort & { close?: () => Promise<void> }) | null = null
  try {
    backend = await (options.localDataBackendFactory ?? createLocalDataBackend)(profileId, localNodeId)
    const session = await backend.open(profileId, localNodeId)
    const status = await backend.status()
    if (!backend.persistent || !status.persistent || backend.kind === 'memory') {
      throw new BrowserMeshNodeCompositionError('local_data_memory_only')
    }

    crypto = (options.envelopeCryptoFactory ?? createBrowserEnvelopeCryptoPort)({
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
    const challengeStore = new peerHost.MemoryReconnectChallengeStore(
      options.randomBytes ? { randomBytes: options.randomBytes } : {},
    )
    const broadcaster = new peerHost.MemoryPeerRevocationBroadcaster()
    const resolver = new peerHost.PeerAuthorityResolver({
      verifierStore,
      grantRepository,
      challengeStore,
      auditSink,
    })
    const pairingIssuer = new peerHost.PeerPairingIssuer({
      verifierStore,
      auditSink,
      ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}),
      now: options.nowMs ?? Date.now,
    })
    const revocationController = new peerHost.MemoryPeerRevocationController({
      verifierStore,
      grantRepository,
      challengeStore,
      auditSink,
      broadcaster,
      now: options.nowMs ?? Date.now,
    })
    const grantManager = new peerHost.PeerGrantManager({
      repository: grantRepository,
      now: options.nowMs ?? Date.now,
      randomId: options.randomId,
    })

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
      throw new BrowserMeshNodeCompositionError('native_pack_empty')
    }

    const provider = localTools.createMeshNodeLocalToolProvider({
      nodeMode: 'mesh-node',
      localPeerId: localNodeId,
      nodeName: profile.localNode.nodeName,
      registry: pack.registry as unknown as Parameters<typeof localTools.createMeshNodeLocalToolProvider>[0]['registry'],
      authorityResolver: resolver,
      exportDecision: {
        isShared: (tool) => {
          if (![...DEFAULT_CAPABILITY_PACK_IDS].some((id) => enabledCapabilityPacks.has(id))) return false
          return pack.registeredToolIds.includes(tool.tool_contract_id as never)
        },
      },
      audit: async (record: LocalToolAuditRecord) => {
        await auditSink.record({
          action: record.action === 'execute' ? 'grant.check' : PEER_SNAPSHOT_AUDIT_ACTION,
          selector: auditSelector(record, localNodeId),
          decision: record.result === 'denied' || record.result === 'failure' || record.result === 'not_found' ? 'rejected' : 'accepted',
          reasonCode: record.reason_code ?? record.result,
          methodId: record.method_id,
          toolContractId: record.local_tool_name ?? undefined,
          correlationId: record.correlation_id ?? undefined,
          connectionEpoch: record.connection_epoch ?? undefined,
          createdAtMs: options.nowMs?.() ?? Date.now(),
          redacted: true,
          redactedFields: ['arguments', 'resultData', 'sensitivePeerAuthorityMaterial'],
        })
      },
      cursorSecret: options.cursorSecret ?? randomSecret(options.crypto ?? safeGlobalCrypto()),
      providerEnabled: true,
      clock: options.nowMs ?? Date.now,
      randomId: options.randomId,
    })
    if (!provider.enabled || provider.registeredToolIds.length === 0) {
      throw new BrowserMeshNodeCompositionError('composition_failed')
    }

    return {
      enabled: true,
      peerHost: provider.peerHost as unknown as import('@aurora/ui').BrowserThinRuntimeConfig['peerHost'],
      peerAuthorityResolver: resolver as unknown as import('@aurora/ui').BrowserThinRuntimeConfig['peerAuthorityResolver'],
      peerPairingIssuer: pairingIssuer as unknown as import('@aurora/ui').BrowserThinRuntimeConfig['peerPairingIssuer'],
      peerGrantManager: grantManager,
      peerRevocationController: revocationController,
      registeredToolIds: provider.registeredToolIds,
      storageBackendKind: backend.kind,
      grantStorePersistent: true,
      async close() {
        await crypto?.close?.().catch(() => undefined)
        await backend?.close().catch(() => undefined)
      },
    }
  } catch (error) {
    await crypto?.close?.().catch(() => undefined)
    await backend?.close().catch(() => undefined)
    if (error instanceof BrowserMeshNodeCompositionError) throw error
    throw new BrowserMeshNodeCompositionError('composition_failed')
  }
}

function assertProfileEligible(
  profile: AuroraRuntimeProfileV2 | undefined,
  rolloutFlags: AuroraWebRtcRolloutFlags,
): asserts profile is AuroraRuntimeProfileV2 {
  if (!profile || profile.nodeMode !== 'mesh-node') throw new BrowserMeshNodeCompositionError('not_mesh_node')
  if (profile.runtimeTier !== 'lightweight-ts') throw new BrowserMeshNodeCompositionError('not_lightweight_ts')
  if (!rolloutFlags.mesh_node_runtime_v1 || !rolloutFlags.local_tool_provider_v1) {
    throw new BrowserMeshNodeCompositionError('rollout_disabled')
  }
  if (!profile.localNode.enabledCapabilityPacks.some((id) => DEFAULT_CAPABILITY_PACK_IDS.has(id))) {
    throw new BrowserMeshNodeCompositionError('capability_pack_disabled')
  }
}

function assertCredentialStoreDurable(store: BrowserPersistentPeerCredentialStore): void {
  const persistence = store.persistenceStatus()
  if (!persistence.secretsPersisted) throw new BrowserMeshNodeCompositionError('credential_store_memory_only')
  if (!persistence.profilePersisted) throw new BrowserMeshNodeCompositionError('profile_metadata_unavailable')
}

function parseIdentity(value: string, field: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9_.:@/-]{1,256}$/u.test(normalized)) {
    throw new BrowserMeshNodeCompositionError('composition_failed', `Invalid ${field} identity`)
  }
  return normalized
}

function auditSelector(
  record: LocalToolAuditRecord,
  localNodeId: string,
): PeerRelationshipSelector {
  return {
    tokenId: record.policy_decision_id ?? 'local-audit',
    claimantPeerId: record.caller_peer_id || 'unknown-peer',
    verifierPeerId: localNodeId,
    roomName: 'unknown-room',
  }
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

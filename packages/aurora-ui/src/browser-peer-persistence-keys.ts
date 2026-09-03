import { AURORA_NODE_CONFIG_STORAGE_KEY } from '@aurora/client'

export const BROWSER_PEER_VAULT_VERSION = 1
export const BROWSER_PEER_VAULT_DATABASE_NAME = 'aurora-web-thin-v1'
export const BROWSER_PEER_VAULT_OBJECT_STORE_NAME = 'vault'
export const BROWSER_PEER_VAULT_KEY_RECORD = 'internal:vault-key'
export const BROWSER_PEER_PROFILE_KEY = 'aurora.webThin.profile.v1'
export const BROWSER_PEER_MESH_PROFILES_KEY = 'aurora.webThin.meshProfiles.v1'
export const BROWSER_PEER_THIN_PROFILE_DOCUMENT_KEY = 'aurora.webThin.connectionProfiles.v1'
export const BROWSER_PEER_RUNTIME_PROFILE_DOCUMENT_KEY = 'aurora.runtimeProfiles.v2'
export const BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY = AURORA_NODE_CONFIG_STORAGE_KEY
export const BROWSER_PEER_STABLE_PEER_KEY = 'aurora.webThin.localStablePeerId.v1'
export const BROWSER_PEER_CREDENTIAL_PREFIX = 'credential:'
export const BROWSER_PEER_ROOM_PREFIX = 'room:'
export const BROWSER_PEER_INBOUND_VERIFIER_PREFIX = 'aurora.peer-host.inbound-verifier.v1'
export const BROWSER_PEER_INBOUND_VERIFIER_KEY_PREFIX = `${BROWSER_PEER_INBOUND_VERIFIER_PREFIX}:`

export const browserPeerVolatileMetadata = new Map<string, string>()

export function clearBrowserPeerProfileMetadata(options: {
  readonly metadataStorage?: Pick<Storage, 'removeItem'> | null
  readonly origin?: string
} = {}): void {
  const origin = options.origin ?? browserOrigin()
  const metadataStorage = options.metadataStorage === undefined ? browserMetadataStorage() : options.metadataStorage
  for (const key of [
    BROWSER_PEER_PROFILE_KEY,
    BROWSER_PEER_MESH_PROFILES_KEY,
    BROWSER_PEER_THIN_PROFILE_DOCUMENT_KEY,
    BROWSER_PEER_RUNTIME_PROFILE_DOCUMENT_KEY,
    BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY,
    BROWSER_PEER_STABLE_PEER_KEY,
  ]) {
    browserPeerVolatileMetadata.delete(`${origin}|${key}`)
    metadataStorage?.removeItem(key)
  }
}

function browserMetadataStorage(): Pick<Storage, 'removeItem'> | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function browserOrigin(): string {
  return typeof window === 'undefined' ? 'ssr' : window.location.origin
}

export interface PeerStorageRecord {
  readonly namespace: string
  readonly key: string
  readonly value: unknown
}

export interface PeerStorageGrant {
  readonly peerId: string
  readonly capabilityId: string
  readonly grantedAtRevision: number
}

export interface PeerStorageE2EHarness {
  readonly stablePeerId: string
  readonly records: readonly PeerStorageRecord[]
  readonly grants: readonly PeerStorageGrant[]
  writeRecord(record: PeerStorageRecord): void
  readRecord(namespace: string, key: string): unknown
  grantCapability(grant: PeerStorageGrant): void
  listPeerGrants(peerId: string): PeerStorageGrant[]
  clear(): void
}

export function createPeerStorageE2EHarness(stablePeerId: string): PeerStorageE2EHarness {
  const records = new Map<string, PeerStorageRecord>()
  const grants = new Map<string, PeerStorageGrant>()

  return {
    stablePeerId,
    get records() {
      return [...records.values()]
    },
    get grants() {
      return [...grants.values()]
    },
    writeRecord(record) {
      records.set(`${record.namespace}\0${record.key}`, { ...record })
    },
    readRecord(namespace, key) {
      return records.get(`${namespace}\0${key}`)?.value
    },
    grantCapability(grant) {
      grants.set(`${grant.peerId}\0${grant.capabilityId}`, { ...grant })
    },
    listPeerGrants(peerId) {
      return [...grants.values()].filter((grant) => grant.peerId === peerId)
    },
    clear() {
      records.clear()
      grants.clear()
    }
  }
}

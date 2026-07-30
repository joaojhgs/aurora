import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MemoryPeerGrantRepository,
  type LocalPeerGrantV1,
  type PeerAuthorityDecision,
  type PeerGrantRepository,
  type PeerGrantResolutionRequest,
  type PeerRelationshipSelector
} from '../src/peer-host/authority.js'
import {
  PeerGrantManagementError,
  PeerGrantManager,
  type PeerGrantSelection
} from '../src/peer-host/grant-management.js'

const selector: PeerRelationshipSelector = {
  tokenId: 'token-1',
  claimantPeerId: 'peer-claimant',
  verifierPeerId: 'peer-verifier',
  roomName: 'room-a'
}

const otherSelector: PeerRelationshipSelector = {
  ...selector,
  claimantPeerId: 'peer-other'
}

const selection: PeerGrantSelection = {
  allowedMethodIds: ['Tooling.GetTools', 'Tooling.ExecuteTool'],
  allowedToolContractIds: ['aurora.local.native.share_text.v1'],
  capabilityPackIds: ['native.share'],
  resourceScopes: ['document:allowed']
}

describe('PeerGrantManager', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is default-off and never turns an empty selection into a positive grant', async () => {
    const repository = new MemoryPeerGrantRepository()
    const manager = new PeerGrantManager({ repository, now: () => 1000, randomId: () => 'grant-default' })

    await expect(manager.listActiveGrants(selector)).resolves.toEqual([])
    await expect(manager.replaceGrant(selector, {})).rejects.toMatchObject({ code: 'invalid_selection' })
    await expect(repository.resolveGrant({ selector, methodId: 'Tooling.GetTools', nowMs: 1001 })).resolves.toEqual({
      allowed: false,
      reasonCode: 'grant_not_found'
    })
  })

  it('creates, lists, updates, and revokes exact peer grants with redacted summaries', async () => {
    let nowMs = 2000
    const repository = new MemoryPeerGrantRepository()
    const manager = new PeerGrantManager({ repository, now: () => nowMs, randomId: () => 'grant-created' })

    await expect(manager.replaceGrant(selector, {
      ...selection,
      allowedMethodIds: ['Tooling.ExecuteTool', 'Tooling.GetTools', 'Tooling.GetTools'],
      resourceScopes: ['document:allowed', 'document:allowed']
    })).resolves.toMatchObject({
      grantId: 'grant-created',
      allowedMethodIds: ['Tooling.ExecuteTool', 'Tooling.GetTools'],
      resourceScopes: ['document:allowed'],
      grantRevision: 1,
      sharingState: 'active',
      secretFieldsRedacted: true
    })

    const [listed] = await manager.listActiveGrants(selector)
    expect(JSON.stringify(listed)).not.toMatch(/token-1|bearer|proof|tokenHashHex|verifierKey/u)
    expect(listed).toMatchObject({ claimantPeerId: 'peer-claimant', verifierPeerId: 'peer-verifier', roomName: 'room-a' })

    nowMs = 2010
    await expect(manager.replaceGrant(selector, {
      allowedMethodIds: ['Tooling.GetTools'],
      allowedToolContractIds: ['aurora.local.native.share_text.v1']
    })).resolves.toMatchObject({
      grantId: 'grant-created',
      allowedMethodIds: ['Tooling.GetTools'],
      capabilityPackIds: [],
      resourceScopes: [],
      grantRevision: 3
    })

    await expect(repository.resolveGrant({ selector, methodId: 'Tooling.ExecuteTool', nowMs: 2011 })).resolves.toEqual({
      allowed: false,
      reasonCode: 'method_not_granted'
    })
    await expect(repository.resolveGrant({ selector, methodId: 'Tooling.GetTools', nowMs: 2011 })).resolves.toMatchObject({
      allowed: true,
      grant: { grantId: 'grant-created', grantRevision: 3 }
    })

    nowMs = 2020
    await expect(manager.revokeSharing(selector)).resolves.toEqual([
      expect.objectContaining({ grantId: 'grant-created', grantRevision: 4, revokedAtMs: 2020, sharingState: 'revoked' })
    ])
    await expect(manager.revokeSharing(selector)).resolves.toEqual([])
    await expect(manager.listActiveGrants(selector)).resolves.toEqual([])
  })

  it('honors expiry boundaries and selector isolation', async () => {
    let nowMs = 3000
    const repository = new MemoryPeerGrantRepository()
    const manager = new PeerGrantManager({
      repository,
      now: () => nowMs,
      randomId: sequentialIds('grant-expiring'),
      maxFutureExpiryMs: 1000
    })

    await expect(manager.replaceGrant(selector, { allowedMethodIds: ['Tooling.GetTools'], expiresAtMs: 3000 })).rejects.toMatchObject({ code: 'invalid_expiry' })
    await expect(manager.replaceGrant(selector, { allowedMethodIds: ['Tooling.GetTools'], expiresAtMs: 5001 })).rejects.toMatchObject({ code: 'invalid_expiry' })

    await manager.replaceGrant(selector, { allowedMethodIds: ['Tooling.GetTools'], expiresAtMs: 3500 })
    await manager.replaceGrant(otherSelector, { allowedMethodIds: ['Tooling.ExecuteTool'] })

    await expect(manager.listActiveGrants(selector)).resolves.toHaveLength(1)
    await expect(repository.resolveGrant({ selector: otherSelector, methodId: 'Tooling.GetTools', nowMs: 3001 })).resolves.toEqual({
      allowed: false,
      reasonCode: 'method_not_granted'
    })

    nowMs = 3500
    await expect(manager.listActiveGrants(selector)).resolves.toEqual([])
    await expect(repository.resolveGrant({ selector, methodId: 'Tooling.GetTools', nowMs })).resolves.toEqual({
      allowed: false,
      reasonCode: 'grant_expired'
    })
  })

  it('rejects wildcard, secret-shaped, execution-shaped, and unrestricted-path selections', async () => {
    const manager = new PeerGrantManager({
      repository: new MemoryPeerGrantRepository(),
      now: () => 4000,
      randomId: () => 'grant-invalid'
    })
    const invalid: readonly PeerGrantSelection[] = [
      { allowedMethodIds: ['*'] },
      { allowedMethodIds: ['Auth.RawBearerToken'] },
      { allowedToolContractIds: ['aurora.local.shell.exec.v1'] },
      { capabilityPackIds: ['process.spawn'] },
      { resourceScopes: ['/Users/alice/Documents'] },
      { resourceScopes: ['../secrets'] },
      { resourceScopes: ['sql:select-users'] }
    ]

    for (const item of invalid) {
      await expect(manager.replaceGrant(selector, item)).rejects.toBeInstanceOf(PeerGrantManagementError)
    }
    await expect(manager.listActiveGrants(selector)).resolves.toEqual([])
  })

  it('uses injected clock and ID dependencies deterministically', async () => {
    const repository = new MemoryPeerGrantRepository()
    const manager = new PeerGrantManager({
      repository,
      now: () => 5000,
      randomId: () => 'grant-deterministic'
    })

    await expect(manager.replaceGrant(selector, selection)).resolves.toMatchObject({
      grantId: 'grant-deterministic',
      createdAtMs: 5000,
      grantRevision: 1
    })
  })

  it('rejects before grant writes when default secure random IDs are unavailable', async () => {
    vi.stubGlobal('crypto', undefined)
    const repository = new CountingRepository()
    const manager = new PeerGrantManager({
      repository,
      now: () => 5500
    })

    await expect(manager.replaceGrant(selector, selection)).rejects.toMatchObject({
      code: 'secure_random_unavailable',
      message: 'Sharing cannot start without secure random IDs'
    })
    expect(repository.upsertCalls).toBe(0)
    expect(repository.revokeCalls).toBe(0)
  })

  it('uses getRandomValues for default grant IDs when randomUUID is unavailable', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array): Uint8Array {
        bytes.fill(0xab)
        return bytes
      }
    })
    const repository = new MemoryPeerGrantRepository()
    const manager = new PeerGrantManager({ repository, now: () => 5600 })

    await expect(manager.replaceGrant(selector, { allowedMethodIds: ['Tooling.GetTools'] })).resolves.toMatchObject({
      grantId: `grant-${'ab'.repeat(16)}`,
      grantRevision: 1
    })
  })

  it('fails closed on repository failures without leaking selector token material', async () => {
    const initial = grant({ grantRevision: 1 })
    const repository = new FailingUpsertRepository([initial])
    const manager = new PeerGrantManager({ repository, now: () => 6000, randomId: () => 'grant-failure' })

    await expect(manager.replaceGrant(selector, { allowedMethodIds: ['Tooling.ExecuteTool'] })).rejects.toMatchObject({
      code: 'repository_unavailable',
      message: 'Sharing settings are unavailable'
    })
    await expect(repository.resolveGrant({ selector, methodId: 'Tooling.GetTools', nowMs: 6001 })).resolves.toEqual({
      allowed: false,
      reasonCode: 'grant_revoked'
    })

    const listingManager = new PeerGrantManager({ repository: new FailingListRepository(), now: () => 6000 })
    await expect(listingManager.listActiveGrants(selector)).rejects.not.toThrow(/token-1/u)
  })

  it('serializes concurrent replacements and preserves monotonic revisions', async () => {
    const repository = new MemoryPeerGrantRepository()
    const manager = new PeerGrantManager({
      repository,
      now: () => 7000,
      randomId: sequentialIds('grant-concurrent')
    })

    const [first, second] = await Promise.all([
      manager.replaceGrant(selector, { allowedMethodIds: ['Tooling.GetTools'] }),
      manager.replaceGrant(selector, { allowedMethodIds: ['Tooling.ExecuteTool'] })
    ])

    expect(first.grantRevision).toBe(1)
    expect(second).toMatchObject({
      grantId: first.grantId,
      grantRevision: 3,
      allowedMethodIds: ['Tooling.ExecuteTool']
    })
    await expect(manager.listActiveGrants(selector)).resolves.toEqual([
      expect.objectContaining({ grantId: first.grantId, grantRevision: 3, allowedMethodIds: ['Tooling.ExecuteTool'] })
    ])
    await expect(repository.resolveGrant({ selector, methodId: 'Tooling.GetTools', nowMs: 7001 })).resolves.toEqual({
      allowed: false,
      reasonCode: 'method_not_granted'
    })
  })
})

function grant(patch: Partial<LocalPeerGrantV1> = {}): LocalPeerGrantV1 {
  return {
    version: 1,
    grantId: 'grant-existing',
    ...selector,
    allowedMethodIds: ['Tooling.GetTools'],
    allowedToolContractIds: [],
    capabilityPackIds: [],
    resourceScopes: [],
    createdAtMs: 1000,
    grantRevision: 1,
    ...patch
  }
}

class FailingUpsertRepository implements PeerGrantRepository {
  private readonly delegate = new MemoryPeerGrantRepository()

  constructor(grants: readonly LocalPeerGrantV1[]) {
    for (const item of grants) {
      void this.delegate.upsertGrant(item)
    }
  }

  async upsertGrant(_grant: LocalPeerGrantV1): Promise<void> {
    throw new Error('token-1 must not leak')
  }

  async resolveGrant(request: PeerGrantResolutionRequest): Promise<PeerAuthorityDecision> {
    return await this.delegate.resolveGrant(request)
  }

  async listRecipientGrants(selectorValue: PeerRelationshipSelector, nowMs: number): Promise<readonly LocalPeerGrantV1[]> {
    return await this.delegate.listRecipientGrants(selectorValue, nowMs)
  }

  async revokeGrants(selectorValue: PeerRelationshipSelector, revokedAtMs: number): Promise<readonly LocalPeerGrantV1[]> {
    return await this.delegate.revokeGrants(selectorValue, revokedAtMs)
  }
}

class CountingRepository implements PeerGrantRepository {
  upsertCalls = 0
  revokeCalls = 0

  async upsertGrant(_grant: LocalPeerGrantV1): Promise<void> {
    this.upsertCalls += 1
  }

  async resolveGrant(_request: PeerGrantResolutionRequest): Promise<PeerAuthorityDecision> {
    return { allowed: false, reasonCode: 'grant_not_found' }
  }

  async listRecipientGrants(_selectorValue: PeerRelationshipSelector, _nowMs: number): Promise<readonly LocalPeerGrantV1[]> {
    return []
  }

  async revokeGrants(_selectorValue: PeerRelationshipSelector, _revokedAtMs: number): Promise<readonly LocalPeerGrantV1[]> {
    this.revokeCalls += 1
    return []
  }
}

class FailingListRepository implements PeerGrantRepository {
  async upsertGrant(_grant: LocalPeerGrantV1): Promise<void> {
  }

  async resolveGrant(_request: PeerGrantResolutionRequest): Promise<PeerAuthorityDecision> {
    return { allowed: false, reasonCode: 'grant_store_unreadable' }
  }

  async listRecipientGrants(_selectorValue: PeerRelationshipSelector, _nowMs: number): Promise<readonly LocalPeerGrantV1[]> {
    throw new Error('token-1 must not leak')
  }

  async revokeGrants(_selectorValue: PeerRelationshipSelector, _revokedAtMs: number): Promise<readonly LocalPeerGrantV1[]> {
    throw new Error('token-1 must not leak')
  }
}

function sequentialIds(prefix: string): () => string {
  let next = 1
  return () => `${prefix}-${next++}`
}

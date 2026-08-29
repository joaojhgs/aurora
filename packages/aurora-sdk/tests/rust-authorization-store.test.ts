import { describe, expect, it, vi } from 'vitest'

import {
  MESH_AUTHORITY_COMMANDS,
  RustPeerHostAuthorizationStore,
  createDurableHydrationLoader,
  createTauriAuthorityPort,
  createWasmAuthorityPort
} from '../src/peer-host/rust-authorization-store.js'
import { SecureInboundCredentialVerifierStore } from '../src/peer-host/local-data-authority-adapters.js'
import type { PeerHostAuthorizationStore } from '../src/peer-host/types.js'

const SELECTOR = {
  tokenId: 'token-a',
  claimantPeerId: 'peer-a',
  verifierPeerId: 'peer-host',
  roomName: 'lab-room'
}

const CONTEXT = {
  selector: SELECTOR,
  transport: {
    channelBinding: 'b'.repeat(64),
    claimantSignalingPeerId: 'sig-a',
    verifierSignalingPeerId: 'sig-host'
  },
  credentialRevision: 1,
  authenticatedAtMs: 500
}

const GRANT = {
  version: 1 as const,
  grantId: 'grant-a',
  ...SELECTOR,
  allowedMethodIds: ['Tooling.GetTools'],
  allowedToolContractIds: [],
  capabilityPackIds: [],
  resourceScopes: [],
  createdAtMs: 1_000,
  grantRevision: 3
}

const VERIFIER = {
  version: 1 as const,
  ...SELECTOR,
  tokenHashHex: 'a'.repeat(64),
  createdAtMs: 1_000,
  credentialRevision: 1
}

const ISSUED = {
  tokenId: SELECTOR.tokenId,
  bearerToken: 'b'.repeat(64),
  verifier: VERIFIER
}

const AUTHORIZE_REQUEST = {
  remotePeerId: 'peer-a',
  methodId: 'Tooling.GetTools',
  requiredPermissions: [],
  identity: { callerPeerId: 'peer-a', effectivePermissions: [] },
  authenticatedPeerContext: CONTEXT,
  nowMs: 2_000
}

/** The parts of the authority a given test does not exercise. */
const unusedWasmSurface = {
  resolveGrant: async () => { throw new Error('not used') },
  issueReconnectChallenge: async () => { throw new Error('not used') },
  verifyReconnectProof: async () => { throw new Error('not used') },
  issuePairingCredential: async () => { throw new Error('not used') },
  rollbackPairingCredential: async () => undefined,
  listActiveGrants: async () => [],
  replaceGrant: async () => { throw new Error('not used') },
  revokeSharing: async () => [],
  revokePeerAuthority: async () => { throw new Error('not used') },
  drainAuditRecords: () => [],
  exportGrants: () => []
}

describe('Rust-backed peer host authorization store', () => {
  it('satisfies the PeerHostAuthorizationStore seam', () => {
    const store: PeerHostAuthorizationStore = new RustPeerHostAuthorizationStore(
      createWasmAuthorityPort({
        ...unusedWasmSurface,
        hydrate: async () => undefined,
        authorize: async () => ({ allowed: false, reasonCode: 'grant_not_found' }),
        snapshotManifestAuthority: async () => ({
          grantedMethodIds: [],
          authGrantRevision: 0,
          authGrantState: 'unknown' as const
        })
      })
    )
    expect(typeof store.authorize).toBe('function')
    expect(typeof store.snapshotManifestAuthority).toBe('function')
  })

  it('dispatches over Tauri IPC using the typed command names', async () => {
    const calls: { command: string; args: Record<string, unknown> | undefined }[] = []
    const invoke = async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args })
      if (command === MESH_AUTHORITY_COMMANDS.authorize) {
        return { allowed: true, grantRevision: 3, grantedMethodIds: ['Tooling.GetTools'] }
      }
      if (command === MESH_AUTHORITY_COMMANDS.snapshotManifest) {
        return {
          recipientPeerId: 'peer-a',
          grantedMethodIds: ['Tooling.GetTools'],
          authGrantRevision: 3,
          authGrantState: 'active'
        }
      }
      return undefined
    }

    const store = new RustPeerHostAuthorizationStore(createTauriAuthorityPort(invoke))
    await store.hydrate({ verifiers: [], grants: [GRANT] })
    const decision = await store.authorize(AUTHORIZE_REQUEST)
    const snapshot = await store.snapshotManifestAuthority({
      remotePeerId: 'peer-a',
      authenticatedPeerContext: CONTEXT,
      nowMs: 2_000
    })

    expect(decision.allowed).toBe(true)
    expect(decision.grantRevision).toBe(3)
    expect(snapshot.authGrantState).toBe('active')
    expect(calls.map((call) => call.command)).toEqual([
      'aurora_mesh_authority_hydrate',
      'aurora_mesh_authority_authorize',
      'aurora_mesh_authority_snapshot_manifest'
    ])

    // The hydrate payload must match the camelCase shape the Rust command
    // deserializes; the Rust side asserts the same shape in its own tests.
    expect(calls[0]?.args).toEqual({ request: { verifiers: [], grants: [GRANT] } })
    expect(calls[1]?.args).toEqual({ request: AUTHORIZE_REQUEST })
  })

  it('dispatches to the WebAssembly authority', async () => {
    const seen: unknown[] = []
    const store = new RustPeerHostAuthorizationStore(
      createWasmAuthorityPort({
        ...unusedWasmSurface,
        hydrate: async (verifiers, grants) => {
          seen.push({ verifiers, grants })
        },
        authorize: async (request) => {
          seen.push(request)
          return { allowed: false, reasonCode: 'selector_mismatch' }
        },
        snapshotManifestAuthority: async () => ({
          grantedMethodIds: [],
          authGrantRevision: 0,
          authGrantState: 'unknown' as const
        })
      })
    )
    await store.hydrate({ verifiers: [], grants: [GRANT] })
    const decision = await store.authorize(AUTHORIZE_REQUEST)
    expect(decision.reasonCode).toBe('selector_mismatch')
    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual({ verifiers: [], grants: [GRANT] })
  })

  it('holds no grant of its own', () => {
    const store = new RustPeerHostAuthorizationStore(
      createWasmAuthorityPort({
        ...unusedWasmSurface,
        hydrate: async () => undefined,
        authorize: async () => ({ allowed: true }),
        snapshotManifestAuthority: async () => ({
          grantedMethodIds: [],
          authGrantRevision: 0,
          authGrantState: 'unknown' as const
        })
      })
    )
    // The store is a transport for the question and the answer. Its only state
    // is the set of relationships it has already replayed into the authority —
    // selector keys, never a grant and never a decision. If a field ever holds
    // an answer, R2's "one authority" claim stops being true, so the field list
    // is pinned rather than sampled.
    expect(Object.keys(store).sort()).toEqual([
      'auditSink',
      'hydrationByRelationship',
      'loadHydration',
      'port',
      'projectPermissions',
      'reportAuditFailure'
    ])
    expect(
      (store as unknown as { hydrationByRelationship: Map<string, Promise<void>> })
        .hydrationByRelationship.size
    ).toBe(0)
  })

  it('makes concurrent authorization wait for one relationship hydration', async () => {
    let releaseHydration: ((value: { verifiers: never[]; grants: never[] }) => void) | undefined
    const loadHydration = vi.fn(
      () => new Promise<{ verifiers: never[]; grants: never[] }>((resolve) => {
        releaseHydration = resolve
      })
    )
    const hydrate = vi.fn(async () => undefined)
    const authorize = vi.fn(async () => ({ allowed: false, reasonCode: 'grant_not_found' }))
    const store = new RustPeerHostAuthorizationStore(
      createWasmAuthorityPort({
        ...unusedWasmSurface,
        hydrate,
        authorize,
        snapshotManifestAuthority: async () => ({
          grantedMethodIds: [],
          authGrantRevision: 0,
          authGrantState: 'unknown' as const
        })
      }),
      undefined,
      loadHydration
    )

    const first = store.authorize(AUTHORIZE_REQUEST)
    const second = store.authorize(AUTHORIZE_REQUEST)
    await Promise.resolve()

    expect(loadHydration).toHaveBeenCalledTimes(1)
    expect(authorize).not.toHaveBeenCalled()
    releaseHydration?.({ verifiers: [], grants: [] })
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(hydrate).toHaveBeenCalledTimes(1)
    expect(authorize).toHaveBeenCalledTimes(2)
  })

  it('retries relationship hydration after a transient load failure', async () => {
    const loadHydration = vi
      .fn()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce({ verifiers: [], grants: [] })
    const authorize = vi.fn(async () => ({ allowed: false, reasonCode: 'grant_not_found' }))
    const store = new RustPeerHostAuthorizationStore(
      createWasmAuthorityPort({
        ...unusedWasmSurface,
        hydrate: async () => undefined,
        authorize,
        snapshotManifestAuthority: async () => ({
          grantedMethodIds: [],
          authGrantRevision: 0,
          authGrantState: 'unknown' as const
        })
      }),
      undefined,
      loadHydration
    )

    await expect(store.authorize(AUTHORIZE_REQUEST)).rejects.toThrow('storage unavailable')
    await expect(store.authorize(AUTHORIZE_REQUEST)).resolves.toMatchObject({
      reasonCode: 'grant_not_found'
    })
    expect(loadHydration).toHaveBeenCalledTimes(2)
    expect(authorize).toHaveBeenCalledTimes(1)
  })

  it('persists an issued verifier before returning its bearer credential', async () => {
    const order: string[] = []
    const issuePairingCredential = vi.fn(async () => {
      order.push('authority')
      return ISSUED
    })
    const upsertVerifier = vi.fn(async () => {
      order.push('durable')
    })
    const store = new RustPeerHostAuthorizationStore(
      createWasmAuthorityPort({
        ...unusedWasmSurface,
        hydrate: async () => undefined,
        authorize: async () => ({ allowed: false }),
        snapshotManifestAuthority: async () => ({
          grantedMethodIds: [],
          authGrantRevision: 0,
          authGrantState: 'unknown' as const
        }),
        issuePairingCredential
      })
    )

    await expect(store.asPairingIssuerPort({
      getVerifier: async () => undefined,
      upsertVerifier,
      revokeVerifier: async () => undefined,
      deleteVerifier: async () => undefined
    }, () => 1_000).issue(SELECTOR)).resolves.toEqual(ISSUED)

    expect(issuePairingCredential).toHaveBeenCalledWith(SELECTOR, undefined, 1_000)
    expect(upsertVerifier).toHaveBeenCalledWith(VERIFIER)
    expect(order).toEqual(['authority', 'durable'])
  })

  it('withdraws both authority copies when issued-verifier persistence fails', async () => {
    const rollbackPairingCredential = vi.fn(async () => undefined)
    const deleteVerifier = vi.fn(async () => undefined)
    const store = new RustPeerHostAuthorizationStore(
      createWasmAuthorityPort({
        ...unusedWasmSurface,
        hydrate: async () => undefined,
        authorize: async () => ({ allowed: false }),
        snapshotManifestAuthority: async () => ({
          grantedMethodIds: [],
          authGrantRevision: 0,
          authGrantState: 'unknown' as const
        }),
        issuePairingCredential: async () => ISSUED,
        rollbackPairingCredential
      })
    )
    const issuer = store.asPairingIssuerPort({
      getVerifier: async () => undefined,
      upsertVerifier: async () => { throw new Error('durable verifier unavailable') },
      revokeVerifier: async () => undefined,
      deleteVerifier
    }, () => 1_000)

    await expect(issuer.issue(SELECTOR)).rejects.toThrow('durable verifier unavailable')
    expect(rollbackPairingCredential).toHaveBeenCalledWith(SELECTOR)
    expect(deleteVerifier).toHaveBeenCalledWith(SELECTOR)
  })

  it('removes both live and durable verifier copies on pairing rollback', async () => {
    const rollbackPairingCredential = vi.fn(async () => undefined)
    const deleteVerifier = vi.fn(async () => undefined)
    const store = new RustPeerHostAuthorizationStore(
      createWasmAuthorityPort({
        ...unusedWasmSurface,
        hydrate: async () => undefined,
        authorize: async () => ({ allowed: false }),
        snapshotManifestAuthority: async () => ({
          grantedMethodIds: [],
          authGrantRevision: 0,
          authGrantState: 'unknown' as const
        }),
        rollbackPairingCredential
      })
    )
    const issuer = store.asPairingIssuerPort({
      getVerifier: async () => undefined,
      upsertVerifier: async () => undefined,
      revokeVerifier: async () => undefined,
      deleteVerifier
    }, () => 1_000)

    await expect(issuer.rollback(SELECTOR)).resolves.toBeUndefined()
    expect(rollbackPairingCredential).toHaveBeenCalledWith(SELECTOR)
    expect(deleteVerifier).toHaveBeenCalledWith(SELECTOR)
  })

  it('persists verifier and grant revocations before notifying live subscribers', async () => {
    const order: string[] = []
    const event = {
      type: 'peer_authority_revoked_v1' as const,
      selector: SELECTOR,
      revokedGrantIds: [GRANT.grantId],
      credentialRevision: 2,
      revokedAtMs: 2_000,
      reasonCode: 'user_revoked',
      redacted: true as const
    }
    const store = new RustPeerHostAuthorizationStore(
      createWasmAuthorityPort({
        ...unusedWasmSurface,
        hydrate: async () => undefined,
        authorize: async () => ({ allowed: false }),
        snapshotManifestAuthority: async () => ({
          grantedMethodIds: [],
          authGrantRevision: 0,
          authGrantState: 'unknown' as const
        }),
        revokePeerAuthority: async () => {
          order.push('authority')
          return event
        }
      })
    )
    const publish = vi.fn(async () => { order.push('publish') })
    const revokeVerifier = vi.fn(async () => {
      order.push('verifier')
      return { ...VERIFIER, credentialRevision: 2, revokedAtMs: 2_000 }
    })
    const revokeGrants = vi.fn(async () => {
      order.push('grants')
      return [{ ...GRANT, grantRevision: 4, revokedAtMs: 2_000 }]
    })
    const controller = store.asRevocationControllerPort(
      { publish },
      {
        verifierStore: {
          getVerifier: async () => undefined,
          upsertVerifier: async () => undefined,
          revokeVerifier,
          deleteVerifier: async () => undefined
        },
        grantRepository: {
          upsertGrant: async () => undefined,
          resolveGrant: async () => ({ allowed: false }),
          listRecipientGrants: async () => [],
          revokeGrants
        }
      },
      () => 2_000
    )

    await expect(controller.revoke(SELECTOR, 'user_revoked')).resolves.toEqual(event)
    expect(revokeVerifier).toHaveBeenCalledWith(SELECTOR, 2_000)
    expect(revokeGrants).toHaveBeenCalledWith(SELECTOR, 2_000)
    expect(order[0]).toBe('authority')
    expect(order.at(-1)).toBe('publish')
  })

  it('does not broadcast a revocation whose durable write fails', async () => {
    const event = {
      type: 'peer_authority_revoked_v1' as const,
      selector: SELECTOR,
      revokedGrantIds: [],
      revokedAtMs: 2_000,
      reasonCode: 'user_revoked',
      redacted: true as const
    }
    const store = new RustPeerHostAuthorizationStore(
      createWasmAuthorityPort({
        ...unusedWasmSurface,
        hydrate: async () => undefined,
        authorize: async () => ({ allowed: false }),
        snapshotManifestAuthority: async () => ({
          grantedMethodIds: [],
          authGrantRevision: 0,
          authGrantState: 'unknown' as const
        }),
        revokePeerAuthority: async () => event
      })
    )
    const publish = vi.fn(async () => undefined)
    const revokeGrants = vi.fn(async () => [])
    const controller = store.asRevocationControllerPort(
      { publish },
      {
        verifierStore: {
          getVerifier: async () => undefined,
          upsertVerifier: async () => undefined,
          revokeVerifier: async () => { throw new Error('durable revoke unavailable') },
          deleteVerifier: async () => undefined
        },
        grantRepository: {
          upsertGrant: async () => undefined,
          resolveGrant: async () => ({ allowed: false }),
          listRecipientGrants: async () => [],
          revokeGrants
        }
      },
      () => 2_000
    )

    await expect(controller.revoke(SELECTOR, 'user_revoked')).rejects.toThrow(
      'durable revoke unavailable'
    )
    expect(publish).not.toHaveBeenCalled()
    expect(revokeGrants).not.toHaveBeenCalled()
  })

  it('cannot rehydrate a revoked credential when later grant cleanup fails', async () => {
    const secrets = new Map<string, string>()
    const verifierStore = new SecureInboundCredentialVerifierStore({
      storage: {
        getOpaqueSecret: async (key) => secrets.get(key),
        setOpaqueSecret: async (key, value) => {
          secrets.set(key, value)
        },
        deleteOpaqueSecret: async (key) => {
          secrets.delete(key)
        }
      }
    })
    await verifierStore.upsertVerifier(VERIFIER)

    const event = {
      type: 'peer_authority_revoked_v1' as const,
      selector: SELECTOR,
      revokedGrantIds: [GRANT.grantId],
      revokedAtMs: 2_000,
      reasonCode: 'user_revoked',
      redacted: true as const
    }
    const store = new RustPeerHostAuthorizationStore(
      createWasmAuthorityPort({
        ...unusedWasmSurface,
        hydrate: async () => undefined,
        authorize: async () => ({ allowed: false }),
        snapshotManifestAuthority: async () => ({
          grantedMethodIds: [],
          authGrantRevision: 0,
          authGrantState: 'unknown' as const
        }),
        revokePeerAuthority: async () => event
      })
    )
    const publish = vi.fn(async () => undefined)
    const grantRepository = {
      upsertGrant: async () => undefined,
      resolveGrant: async () => ({ allowed: false }),
      listRecipientGrants: async () => [GRANT],
      revokeGrants: async () => {
        throw new Error('grant cleanup unavailable')
      }
    }

    await expect(
      store.asRevocationControllerPort(
        { publish },
        { verifierStore, grantRepository },
        () => 2_000
      ).revoke(SELECTOR, 'user_revoked')
    ).rejects.toThrow('grant cleanup unavailable')
    expect(publish).not.toHaveBeenCalled()

    const reload = createDurableHydrationLoader({
      verifierStore,
      grantRepository,
      now: () => 2_001
    })
    await expect(reload(SELECTOR)).resolves.toEqual({
      verifiers: [],
      grants: [GRANT]
    })
  })

  it('reports audit persistence failure without changing or exposing the decision', async () => {
    const reportAuditFailure = vi.fn()
    const store = new RustPeerHostAuthorizationStore(
      createWasmAuthorityPort({
        ...unusedWasmSurface,
        hydrate: async () => undefined,
        authorize: async () => ({ allowed: false, reasonCode: 'method_not_granted' }),
        snapshotManifestAuthority: async () => ({
          grantedMethodIds: [],
          authGrantRevision: 0,
          authGrantState: 'unknown' as const
        }),
        drainAuditRecords: () => [{
          action: 'grant.check',
          selector: SELECTOR,
          decision: 'rejected',
          authorityState: 'active',
          createdAtMs: 2_000,
          redacted: true,
          redactedFields: []
        }]
      }),
      undefined,
      undefined,
      { record: async () => { throw new Error('secret audit storage path') } },
      reportAuditFailure
    )

    await expect(store.authorize(AUTHORIZE_REQUEST)).resolves.toEqual({
      allowed: false,
      reasonCode: 'method_not_granted'
    })
    expect(reportAuditFailure).toHaveBeenCalledOnce()
    expect(reportAuditFailure).toHaveBeenCalledWith({
      code: 'authority_audit_persist_failed',
      droppedRecordCount: 1
    })
    expect(JSON.stringify(reportAuditFailure.mock.calls)).not.toMatch(
      /secret|peer-a|token-a|lab-room/u
    )
  })

  it('reports audit drain failure without changing or exposing the decision', async () => {
    const reportAuditFailure = vi.fn()
    const store = new RustPeerHostAuthorizationStore(
      createWasmAuthorityPort({
        ...unusedWasmSurface,
        hydrate: async () => undefined,
        authorize: async () => ({ allowed: true, grantedMethodIds: ['Tooling.GetTools'] }),
        snapshotManifestAuthority: async () => ({
          grantedMethodIds: [],
          authGrantRevision: 0,
          authGrantState: 'unknown' as const
        }),
        drainAuditRecords: () => { throw new Error('secret authority state') }
      }),
      undefined,
      undefined,
      { record: async () => undefined },
      reportAuditFailure
    )

    await expect(store.authorize(AUTHORIZE_REQUEST)).resolves.toMatchObject({ allowed: true })
    expect(reportAuditFailure).toHaveBeenCalledWith({
      code: 'authority_audit_drain_failed'
    })
    expect(JSON.stringify(reportAuditFailure.mock.calls)).not.toMatch(
      /secret|peer-a|token-a|lab-room/u
    )
  })
})

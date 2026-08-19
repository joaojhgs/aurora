import { describe, expect, it } from 'vitest'

import {
  MESH_AUTHORITY_COMMANDS,
  RustPeerHostAuthorizationStore,
  createTauriAuthorityPort,
  createWasmAuthorityPort
} from '../src/peer-host/rust-authorization-store.js'
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

const AUTHORIZE_REQUEST = {
  remotePeerId: 'peer-a',
  methodId: 'Tooling.GetTools',
  requiredPermissions: [],
  identity: { callerPeerId: 'peer-a', effectivePermissions: [] },
  authenticatedPeerContext: CONTEXT,
  nowMs: 2_000
}

describe('Rust-backed peer host authorization store', () => {
  it('satisfies the PeerHostAuthorizationStore seam', () => {
    const store: PeerHostAuthorizationStore = new RustPeerHostAuthorizationStore(
      createWasmAuthorityPort({
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
        hydrate: async () => undefined,
        authorize: async () => ({ allowed: true }),
        snapshotManifestAuthority: async () => ({
          grantedMethodIds: [],
          authGrantRevision: 0,
          authGrantState: 'unknown' as const
        })
      })
    )
    // The store is a transport for the question and the answer. If it ever
    // grows a grant cache, R2's "one authority" claim stops being true.
    expect(Object.keys(store)).toEqual(['port'])
  })
})

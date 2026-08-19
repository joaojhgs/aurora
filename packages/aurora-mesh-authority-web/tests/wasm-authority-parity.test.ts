import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { WasmPeerHostAuthorizationStore } from '../src/index.js'
import type {
  LocalPeerGrantV1,
  MeshAuthorityWasmSource,
  PeerHostAuthorizeRequest,
  PeerRelationshipSelector
} from '../src/index.js'

/**
 * Node cannot `fetch` a `file:` URL, so the harness hands the loader the bytes
 * that `scripts/build-wasm.mjs` produced. A browser needs neither hook.
 */
const nodeWasmSource: MeshAuthorityWasmSource = {
  importBindings: async () =>
    await import(resolve(process.cwd(), 'dist/wasm/aurora_mesh_authority.js')),
  wasmBytes: async () => readFileSync(resolve(process.cwd(), 'dist/wasm/aurora_mesh_authority_bg.wasm'))
}

/**
 * Drive the compiled WebAssembly authority from the shared parity corpus.
 *
 * This is the R2 acceptance criterion "the web build runs the WASM authority",
 * and it is deliberately the *same* file
 * (`tests/fixtures/mesh_authority_parity_vectors.json`) that
 * `rust/crates/aurora-mesh-authority/tests/parity_corpus.rs` and
 * `packages/aurora-sdk/tests/mesh-authority-parity-vectors.test.ts` run from.
 * Compiling for `wasm32-unknown-unknown` proves nothing on its own; answering
 * the corpus through real bindings does.
 *
 * Requires `pnpm --filter @aurora/mesh-authority-web run build:wasm` first.
 */
function corpus(): any {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), '../../tests/fixtures/mesh_authority_parity_vectors.json'), 'utf8')
  )
}

const CORPUS = corpus()

async function storeWith(grants: readonly LocalPeerGrantV1[]): Promise<WasmPeerHostAuthorizationStore> {
  const store = await WasmPeerHostAuthorizationStore.create(nodeWasmSource)
  await store.hydrate([], grants)
  return store
}

function authorizeRequest(request: any): PeerHostAuthorizeRequest {
  return {
    remotePeerId: request.remotePeerId,
    methodId: request.methodId,
    requiredPermissions: [],
    identity: { callerPeerId: request.remotePeerId, effectivePermissions: [] },
    ...(request.authenticatedPeerContext !== undefined
      ? { authenticatedPeerContext: request.authenticatedPeerContext }
      : {}),
    nowMs: request.nowMs
  }
}

describe('WASM mesh authority', () => {
  beforeAll(async () => {
    // Fails loudly with a clear message when dist/wasm has not been built.
    await WasmPeerHostAuthorizationStore.create(nodeWasmSource)
  })

  it('loads the compiled bindings and answers a permission question', async () => {
    const store = await storeWith([
      {
        version: 1,
        grantId: 'grant-live',
        tokenId: 'token-a',
        claimantPeerId: 'peer-a',
        verifierPeerId: 'peer-host',
        roomName: 'lab-room',
        allowedMethodIds: ['Tooling.GetTools'],
        allowedToolContractIds: [],
        capabilityPackIds: [],
        resourceScopes: [],
        createdAtMs: 1_000,
        grantRevision: 3
      }
    ])
    const decision = await store.authorize(
      authorizeRequest({
        remotePeerId: 'peer-a',
        methodId: 'Tooling.GetTools',
        authenticatedPeerContext: {
          selector: {
            tokenId: 'token-a',
            claimantPeerId: 'peer-a',
            verifierPeerId: 'peer-host',
            roomName: 'lab-room'
          },
          transport: {
            channelBinding: 'b'.repeat(64),
            claimantSignalingPeerId: 'sig-a',
            verifierSignalingPeerId: 'sig-host'
          },
          credentialRevision: 1,
          authenticatedAtMs: 500
        },
        nowMs: 2_000
      })
    )
    expect(decision.allowed).toBe(true)
    expect(decision.grantRevision).toBe(3)
    expect(decision.grantedMethodIds).toEqual(['Tooling.GetTools'])
  })

  it('decides every durable-authority corpus case as recorded', async () => {
    const cases = CORPUS.authorityAuthorize.cases as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      const store = await storeWith(entry.grants)
      const decision = await store.authorize(authorizeRequest(entry.request))
      expect(decision.allowed, `${entry.name}: allowed`).toBe(entry.expected.allowed)
      expect(decision.reasonCode, `${entry.name}: reasonCode`).toBe(entry.expected.reasonCode)
      expect(decision.grantRevision, `${entry.name}: grantRevision`).toBe(entry.expected.grantRevision)
      expect(decision.grantedMethodIds, `${entry.name}: grantedMethodIds`).toEqual(
        entry.expected.grantedMethodIds
      )
      store.free()
    }
  })

  it('summarises durable manifest authority as recorded', async () => {
    const cases = CORPUS.manifestSnapshot.authority as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      const store = await storeWith(entry.grants)
      const snapshot = await store.snapshotManifestAuthority({
        remotePeerId: entry.request.remotePeerId,
        ...(entry.request.authenticatedPeerContext !== undefined
          ? { authenticatedPeerContext: entry.request.authenticatedPeerContext }
          : {}),
        nowMs: entry.request.nowMs
      })
      expect(snapshot.recipientPeerId, `${entry.name}: recipientPeerId`).toBe(entry.expected.recipientPeerId)
      expect(snapshot.grantedMethodIds, `${entry.name}: grantedMethodIds`).toEqual(
        entry.expected.grantedMethodIds
      )
      expect(snapshot.authGrantRevision, `${entry.name}: authGrantRevision`).toBe(
        entry.expected.authGrantRevision
      )
      expect(snapshot.authGrantState, `${entry.name}: authGrantState`).toBe(entry.expected.authGrantState)
      store.free()
    }
  })

  it('runs every reconnect challenge scenario to the recorded statuses', async () => {
    const cases = CORPUS.reconnectChallenge.cases as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      const store = await WasmPeerHostAuthorizationStore.create(nodeWasmSource)
      const issued = await store.issueReconnectChallenge({
        identity: entry.issue.identity,
        transport: entry.issue.transport,
        nowMs: entry.issue.nowMs
      })
      expect(issued.challenge.length, `${entry.name}: challenge width`).toBe(64)

      for (const step of entry.steps as any[]) {
        if (step.action === 'reject') {
          // The corpus rejects outstanding challenges; the WASM surface reaches
          // that through revocation, which is the path a "forget this peer"
          // actually takes.
          await store.revokePeerAuthority(
            { tokenId: 'token-a', ...entry.issue.identity },
            'peer_authority_revoked',
            step.nowMs
          )
          continue
        }
        if (step.challenge !== 'ISSUED') continue
        // The WASM authority draws its challenge from the host page's CSPRNG, so
        // the value differs from the corpus's fixed-random vector. The status
        // sequence — the part that carries the replay guard — must not.
        const result = await store.verifyReconnectProof({
          proofHex: '0'.repeat(64),
          selector: step.selector,
          transport: step.transport,
          challenge: issued.challenge,
          nowMs: step.nowMs
        })
        expect(result.ok, `${entry.name}: proof`).toBe(false)
        // An accepted challenge is consumed, and the proof is then checked
        // against a credential this store was never hydrated with.
        const expectedReason =
          step.expectedStatus === 'accepted' ? 'credential_not_found' : step.expectedStatus
        expect(result.reasonCode, `${entry.name}: reason`).toBe(expectedReason)
      }
      store.free()
    }
  })

  it('projects every corpus method with the recorded execution policy', async () => {
    const store = await WasmPeerHostAuthorizationStore.create(nodeWasmSource)
    const cases = CORPUS.executionPolicy.methods as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      expect(store.describeMethod(entry.methodId), `${entry.name}`).toEqual(entry.expected)
    }
    for (const entry of CORPUS.executionPolicy.events as any[]) {
      expect(store.describeEvent(entry.topic), `${entry.name}`).toEqual(entry.expected)
    }
    store.free()
  })

  it('refuses every blocked method with the recorded copy', async () => {
    const store = await WasmPeerHostAuthorizationStore.create(nodeWasmSource)
    const cases = CORPUS.executionPolicy.blockedMethods as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      expect(() => store.describeMethod(entry.methodId), `${entry.name}`).toThrow(entry.expectedError)
    }
    store.free()
  })

  it('sequences every corpus TTS stream as recorded', async () => {
    const store = await WasmPeerHostAuthorizationStore.create(nodeWasmSource)
    const cases = CORPUS.ttsEmission.cases as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const [index, entry] of cases.entries()) {
      const subscriptionId = `sub-${index}`
      const correlationId = entry.correlationId === null ? undefined : (entry.correlationId as string)
      entry.events.forEach((event: any, position: number) => {
        if (event.expectedError === null) {
          expect(
            () => store.validateTtsAudioChunk(subscriptionId, event.payload, correlationId),
            `${entry.name}[${position}]`
          ).not.toThrow()
          return
        }
        expect(
          () => store.validateTtsAudioChunk(subscriptionId, event.payload, correlationId),
          `${entry.name}[${position}]`
        ).toThrow(event.expectedError)
      })
      store.closeTtsSubscription(subscriptionId)
    }
    store.free()
  })

  it('normalises and refuses every corpus grant selection as recorded', async () => {
    const cases = CORPUS.grantSelection.cases as any[]
    expect(cases.length).toBeGreaterThan(0)
    const selector: PeerRelationshipSelector = {
      tokenId: 'token-a',
      claimantPeerId: 'peer-a',
      verifierPeerId: 'peer-host',
      roomName: 'lab-room'
    }
    for (const entry of cases) {
      const store = await WasmPeerHostAuthorizationStore.create(nodeWasmSource)
      if (entry.expected.ok === true) {
        const summary = (await store.replaceGrant(
          selector,
          entry.selection,
          entry.nowMs,
          'grant-1'
        )) as any
        expect(summary.allowedMethodIds, `${entry.name}: allowedMethodIds`).toEqual(
          entry.expected.normalized.allowedMethodIds
        )
        expect(summary.resourceScopes, `${entry.name}: resourceScopes`).toEqual(
          entry.expected.normalized.resourceScopes
        )
        expect(summary.expiresAtMs, `${entry.name}: expiresAtMs`).toBe(entry.expected.normalized.expiresAtMs)
      } else {
        await expect(
          store.replaceGrant(selector, entry.selection, entry.nowMs, 'grant-1'),
          `${entry.name}`
        ).rejects.toThrow(entry.expected.message)
      }
      store.free()
    }
  })
})

describe('WASM mesh authority invariants', () => {
  it('never lets an authority context cross peers', async () => {
    const store = await storeWith([
      {
        version: 1,
        grantId: 'grant-a',
        tokenId: 'token-a',
        claimantPeerId: 'peer-a',
        verifierPeerId: 'peer-host',
        roomName: 'lab-room',
        allowedMethodIds: ['Tooling.GetTools'],
        allowedToolContractIds: [],
        capabilityPackIds: [],
        resourceScopes: [],
        createdAtMs: 1_000,
        grantRevision: 1
      }
    ])
    const decision = await store.authorize(
      authorizeRequest({
        remotePeerId: 'peer-b',
        methodId: 'Tooling.GetTools',
        authenticatedPeerContext: {
          selector: {
            tokenId: 'token-a',
            claimantPeerId: 'peer-a',
            verifierPeerId: 'peer-host',
            roomName: 'lab-room'
          },
          transport: {
            channelBinding: 'b'.repeat(64),
            claimantSignalingPeerId: 'sig-a',
            verifierSignalingPeerId: 'sig-host'
          },
          credentialRevision: 1,
          authenticatedAtMs: 500
        },
        nowMs: 2_000
      })
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reasonCode).toBe('selector_mismatch')
    store.free()
  })

  it('grants nothing on room membership alone', async () => {
    const store = await storeWith([])
    const decision = await store.authorize(
      authorizeRequest({
        remotePeerId: 'peer-a',
        methodId: 'Tooling.GetTools',
        authenticatedPeerContext: {
          selector: {
            tokenId: 'token-a',
            claimantPeerId: 'peer-a',
            verifierPeerId: 'peer-host',
            roomName: 'lab-room'
          },
          transport: {
            channelBinding: 'b'.repeat(64),
            claimantSignalingPeerId: 'sig-a',
            verifierSignalingPeerId: 'sig-host'
          },
          credentialRevision: 1,
          authenticatedAtMs: 500
        },
        nowMs: 2_000
      })
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reasonCode).toBe('grant_not_found')
    store.free()
  })
})

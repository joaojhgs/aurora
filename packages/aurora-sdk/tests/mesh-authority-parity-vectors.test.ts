import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  MemoryPeerGrantRepository,
  MemoryReconnectChallengeStore,
  PeerAuthorityHostAuthorizationStore,
  PeerAuthorityResolver,
  PeerGrantManagementError,
  PeerGrantManager,
  SessionPeerHostAuthorizationStore,
  createReconnectProofForBearer,
  DenyAllInboundCredentialVerifierStore,
  MemoryInboundCredentialVerifierStore,
  generatedPeerHostEventDescriptor,
  generatedPeerHostMethodDescriptor
} from '../src/peer-host/index.js'
import type {
  AuthenticatedPeerContext,
  PeerRelationshipIdentity,
  PeerRelationshipSelector,
  ReconnectTransportAttestation
} from '../src/peer-host/index.js'
import { buildMeshReconnectProofMessage, bytesToHex, sha256Bytes, verifyReconnectProofHex } from '../src/webrtc/crypto.js'

/**
 * The shared mesh-authority parity corpus.
 *
 * This is the same file `rust/crates/aurora-mesh-authority/tests/parity_corpus.rs`
 * drives itself from. Two authorities is drift in the one layer where drift is a
 * vulnerability (R2, `docs/mesh/THIN-CLIENT-MESH-PARITY-PLAN.md`), so while both
 * exist they answer the same questions from the same file — a divergence fails
 * here or there rather than in production.
 *
 * Regenerate with `uv run python scripts/generate_mesh_authority_fixtures.py`.
 */
function corpus(): any {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), '../../tests/fixtures/mesh_authority_parity_vectors.json'), 'utf8')
  )
}

const CORPUS = corpus()

function fixedRandomBytes(byte: number): (length: number) => Uint8Array {
  return (length: number) => new Uint8Array(length).fill(byte)
}

function countingRandomBytes(): (length: number) => Uint8Array {
  let next = 1
  return (length: number) => {
    const value = next
    next += 1
    return new Uint8Array(length).fill(value)
  }
}

async function seededRepository(grants: readonly any[]): Promise<MemoryPeerGrantRepository> {
  const repository = new MemoryPeerGrantRepository()
  for (const grant of grants) await repository.upsertGrant(grant)
  return repository
}

function authorityStore(repository: MemoryPeerGrantRepository): PeerAuthorityHostAuthorizationStore {
  return new PeerAuthorityHostAuthorizationStore(
    new PeerAuthorityResolver({
      verifierStore: new MemoryInboundCredentialVerifierStore(),
      grantRepository: repository,
      challengeStore: new MemoryReconnectChallengeStore({ randomBytes: fixedRandomBytes(0x11) })
    })
  )
}

function authorizeRequest(request: any): any {
  return {
    remotePeerId: request.remotePeerId,
    methodId: request.methodId,
    requiredPermissions: [],
    identity: { callerPeerId: request.remotePeerId, effectivePermissions: [] },
    ...(request.authenticatedPeerContext !== undefined
      ? { authenticatedPeerContext: request.authenticatedPeerContext as AuthenticatedPeerContext }
      : {}),
    nowMs: request.nowMs
  }
}

function expectDecision(name: string, decision: any, expected: any): void {
  expect(decision.allowed, `${name}: allowed`).toBe(expected.allowed)
  expect(decision.reasonCode, `${name}: reasonCode`).toBe(expected.reasonCode)
  expect(decision.grantRevision, `${name}: grantRevision`).toBe(expected.grantRevision)
  expect(decision.grantedMethodIds, `${name}: grantedMethodIds`).toEqual(expected.grantedMethodIds)
}

describe('mesh authority parity corpus', () => {
  it('is the corpus the Rust authority is driven from', () => {
    expect(CORPUS.schema).toBe('aurora.mesh.authority.parity_vectors.v1')
    expect(CORPUS.synthetic).toBe(true)
  })

  it('still carries its hostile cases', () => {
    let total = 0
    let hostile = 0
    for (const section of Object.values(CORPUS)) {
      if (typeof section !== 'object' || section === null) continue
      for (const group of Object.values(section as Record<string, unknown>)) {
        if (!Array.isArray(group)) continue
        for (const entry of group) {
          if (typeof entry !== 'object' || entry === null || !('name' in entry)) continue
          total += 1
          if ((entry as { hostile?: boolean }).hostile === true) hostile += 1
        }
      }
    }
    expect(total, 'corpus case count').toBeGreaterThanOrEqual(100)
    expect(hostile, 'hostile case count').toBeGreaterThanOrEqual(60)
  })
})

describe('mesh authority parity — reconnect proof', () => {
  it('builds the transcript and proof the corpus records', async () => {
    const cases = CORPUS.reconnectProof.cases as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      const input = {
        tokenId: entry.selector.tokenId,
        challenge: entry.challenge,
        channelBinding: entry.transport.channelBinding,
        claimantPeerId: entry.selector.claimantPeerId,
        verifierPeerId: entry.selector.verifierPeerId,
        roomName: entry.selector.roomName
      }
      expect(bytesToHex(buildMeshReconnectProofMessage(input)), `${entry.name}: transcript`).toBe(
        entry.expectedMessageHex
      )
      expect(bytesToHex(await sha256Bytes(entry.bearerToken)), `${entry.name}: token hash`).toBe(
        entry.expectedTokenHashHex
      )
      expect(
        await createReconnectProofForBearer(
          entry.bearerToken,
          entry.selector as PeerRelationshipSelector,
          entry.transport as ReconnectTransportAttestation,
          entry.challenge
        ),
        `${entry.name}: proof`
      ).toBe(entry.expectedProofHex)
    }
  })

  it('accepts and refuses proofs exactly as the corpus records', async () => {
    const cases = CORPUS.reconnectProof.verify as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      const ok = await verifyReconnectProofHex(entry.tokenHashHex, entry.proofHex, {
        tokenId: entry.selector.tokenId,
        challenge: entry.challenge,
        channelBinding: entry.transport.channelBinding,
        claimantPeerId: entry.selector.claimantPeerId,
        verifierPeerId: entry.selector.verifierPeerId,
        roomName: entry.selector.roomName
      })
      expect(ok, `${entry.name}`).toBe(entry.expected)
    }
  })
})

describe('mesh authority parity — grant resolution', () => {
  it('resolves every corpus case to the recorded decision', async () => {
    const cases = CORPUS.grantResolution.cases as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      const repository = await seededRepository(entry.grants)
      const decision = await repository.resolveGrant({
        selector: entry.request.selector,
        ...(entry.request.methodId !== undefined ? { methodId: entry.request.methodId } : {}),
        ...(entry.request.toolContractId !== undefined ? { toolContractId: entry.request.toolContractId } : {}),
        ...(entry.request.capabilityPackId !== undefined
          ? { capabilityPackId: entry.request.capabilityPackId }
          : {}),
        ...(entry.request.resourceScope !== undefined ? { resourceScope: entry.request.resourceScope } : {}),
        nowMs: entry.request.nowMs
      })
      expect(decision.allowed, `${entry.name}: allowed`).toBe(entry.expected.allowed)
      expect(decision.reasonCode, `${entry.name}: reasonCode`).toBe(entry.expected.reasonCode)
      expect(decision.grant?.grantId, `${entry.name}: covering grant`).toBe(entry.expected.grantId)
    }
  })
})

describe('mesh authority parity — session authorization', () => {
  it('decides every corpus case as recorded', async () => {
    const cases = CORPUS.sessionAuthorize.cases as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      const store = new SessionPeerHostAuthorizationStore(entry.grants)
      const decision = await store.authorize(authorizeRequest(entry.request))
      expectDecision(entry.name, decision, entry.expected)
    }
  })
})

describe('mesh authority parity — durable authority authorization', () => {
  it('decides every corpus case as recorded', async () => {
    const cases = CORPUS.authorityAuthorize.cases as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      const store = authorityStore(await seededRepository(entry.grants))
      const decision = await store.authorize(authorizeRequest(entry.request))
      expectDecision(entry.name, decision, entry.expected)
    }
  })
})

describe('mesh authority parity — manifest authority snapshot', () => {
  it('summarises session grants as recorded', async () => {
    const cases = CORPUS.manifestSnapshot.session as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      const store = new SessionPeerHostAuthorizationStore(entry.grants)
      const snapshot = store.snapshotManifestAuthority({
        remotePeerId: entry.request.remotePeerId,
        ...(entry.request.authenticatedPeerContext !== undefined
          ? { authenticatedPeerContext: entry.request.authenticatedPeerContext }
          : {}),
        nowMs: entry.request.nowMs
      })
      expect(snapshot.recipientPeerId, `${entry.name}: recipientPeerId`).toBe(entry.expected.recipientPeerId)
      expect(snapshot.grantedMethodIds, `${entry.name}: grantedMethodIds`).toEqual(entry.expected.grantedMethodIds)
      expect(snapshot.authGrantRevision, `${entry.name}: authGrantRevision`).toBe(entry.expected.authGrantRevision)
      expect(snapshot.authGrantState, `${entry.name}: authGrantState`).toBe(entry.expected.authGrantState)
    }
  })

  it('summarises durable grants as recorded', async () => {
    const cases = CORPUS.manifestSnapshot.authority as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      const store = authorityStore(await seededRepository(entry.grants))
      const snapshot = await store.snapshotManifestAuthority({
        remotePeerId: entry.request.remotePeerId,
        ...(entry.request.authenticatedPeerContext !== undefined
          ? { authenticatedPeerContext: entry.request.authenticatedPeerContext as AuthenticatedPeerContext }
          : {}),
        nowMs: entry.request.nowMs
      })
      expect(snapshot.recipientPeerId, `${entry.name}: recipientPeerId`).toBe(entry.expected.recipientPeerId)
      expect(snapshot.grantedMethodIds, `${entry.name}: grantedMethodIds`).toEqual(entry.expected.grantedMethodIds)
      expect(snapshot.grantedPermissions, `${entry.name}: grantedPermissions`).toEqual(
        entry.expected.grantedPermissions
      )
      expect(snapshot.authGrantRevision, `${entry.name}: authGrantRevision`).toBe(entry.expected.authGrantRevision)
      expect(snapshot.authGrantState, `${entry.name}: authGrantState`).toBe(entry.expected.authGrantState)
    }
  })
})

describe('mesh authority parity — reconnect challenge replay guard', () => {
  it('runs every corpus scenario to the recorded statuses', async () => {
    const cases = CORPUS.reconnectChallenge.cases as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      const store = new MemoryReconnectChallengeStore({ randomBytes: fixedRandomBytes(0x11) })
      const identity = entry.issue.identity as PeerRelationshipIdentity
      const issued = await store.issueChallenge(
        identity,
        entry.issue.transport as ReconnectTransportAttestation,
        entry.issue.nowMs
      )
      expect(issued.challenge, `${entry.name}: issued challenge`).toBe(CORPUS.reconnectChallenge.challengeBytesHex)

      for (const step of entry.steps as any[]) {
        if (step.action === 'reject') {
          await store.rejectChallenges(identity, step.nowMs)
          continue
        }
        const challenge = step.challenge === 'ISSUED' ? issued.challenge : step.challenge
        const result = await store.consumeChallenge(
          challenge,
          step.selector as PeerRelationshipSelector,
          step.transport as ReconnectTransportAttestation,
          step.nowMs
        )
        expect(result.status, `${entry.name}: status`).toBe(step.expectedStatus)
      }
    }
  })
})

describe('mesh authority parity — grant selection', () => {
  it('normalises and refuses every corpus selection as recorded', async () => {
    const cases = CORPUS.grantSelection.cases as any[]
    expect(cases.length).toBeGreaterThan(0)
    const selector: PeerRelationshipSelector = {
      tokenId: 'token-a',
      claimantPeerId: 'peer-a',
      verifierPeerId: 'peer-host',
      roomName: 'lab-room'
    }

    for (const entry of cases) {
      const repository = new MemoryPeerGrantRepository()
      let grantIdCounter = 0
      const manager = new PeerGrantManager({
        repository,
        now: () => entry.nowMs,
        randomId: () => `grant-${(grantIdCounter += 1)}`
      })

      if (entry.expected.ok === true) {
        const summary = await manager.replaceGrant(selector, entry.selection)
        expect(summary.allowedMethodIds, `${entry.name}: allowedMethodIds`).toEqual(
          entry.expected.normalized.allowedMethodIds
        )
        expect(summary.allowedToolContractIds, `${entry.name}: allowedToolContractIds`).toEqual(
          entry.expected.normalized.allowedToolContractIds
        )
        expect(summary.capabilityPackIds, `${entry.name}: capabilityPackIds`).toEqual(
          entry.expected.normalized.capabilityPackIds
        )
        expect(summary.resourceScopes, `${entry.name}: resourceScopes`).toEqual(
          entry.expected.normalized.resourceScopes
        )
        expect(summary.expiresAtMs, `${entry.name}: expiresAtMs`).toBe(entry.expected.normalized.expiresAtMs)
        continue
      }

      await expect(manager.replaceGrant(selector, entry.selection), `${entry.name}`).rejects.toMatchObject({
        code: entry.expected.code,
        message: entry.expected.message
      })
    }
  })

  it('refuses a selection with a typed sharing error', async () => {
    const manager = new PeerGrantManager({ repository: new MemoryPeerGrantRepository(), now: () => 2_000 })
    await expect(
      manager.replaceGrant(
        { tokenId: 't', claimantPeerId: 'p', verifierPeerId: 'v', roomName: 'r' },
        { allowedMethodIds: [] }
      )
    ).rejects.toBeInstanceOf(PeerGrantManagementError)
  })
})

describe('mesh authority parity — execution policy', () => {
  it('projects every corpus method with the recorded limits', () => {
    const cases = CORPUS.executionPolicy.methods as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      const descriptor = generatedPeerHostMethodDescriptor(entry.methodId, async () => ({}) as never)
      const expected = entry.expected
      expect(descriptor.methodId, `${entry.name}: methodId`).toBe(expected.methodId)
      expect(descriptor.module, `${entry.name}: module`).toBe(expected.module)
      expect(descriptor.name, `${entry.name}: name`).toBe(expected.name)
      expect(descriptor.summary, `${entry.name}: summary`).toBe(expected.summary)
      expect(descriptor.busTopic, `${entry.name}: busTopic`).toBe(expected.busTopic)
      expect(descriptor.exposure, `${entry.name}: exposure`).toBe(expected.exposure)
      expect(descriptor.methodType, `${entry.name}: methodType`).toBe(expected.methodType)
      expect(descriptor.projectionMethodType, `${entry.name}: projectionMethodType`).toBe(
        expected.projectionMethodType
      )
      expect(descriptor.inputSchemaId, `${entry.name}: inputSchemaId`).toBe(expected.inputSchemaId)
      expect(descriptor.outputSchemaId, `${entry.name}: outputSchemaId`).toBe(expected.outputSchemaId)
      expect(descriptor.requiredPermissions, `${entry.name}: requiredPermissions`).toEqual(
        expected.requiredPermissions
      )
      expect(descriptor.callableFeatureIds, `${entry.name}: callableFeatureIds`).toEqual(
        expected.callableFeatureIds
      )
      expect(descriptor.serviceCapabilities, `${entry.name}: serviceCapabilities`).toEqual(
        expected.serviceCapabilities
      )
      expect(descriptor.serviceVersion, `${entry.name}: serviceVersion`).toBe(expected.serviceVersion)
      expect(descriptor.maxConcurrent, `${entry.name}: maxConcurrent`).toBe(expected.maxConcurrent)
      expect(descriptor.maxRequestBytes, `${entry.name}: maxRequestBytes`).toBe(expected.maxRequestBytes)
      expect(descriptor.timeoutMs, `${entry.name}: timeoutMs`).toBe(expected.timeoutMs)
    }
  })

  it('refuses every blocked method with the recorded copy', () => {
    const cases = CORPUS.executionPolicy.blockedMethods as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      const project = generatedPeerHostMethodDescriptor as unknown as (
        methodId: string,
        handler: () => unknown
      ) => unknown
      expect(() => project(entry.methodId, () => ({})), `${entry.name}`).toThrow(entry.expectedError)
    }
  })

  it('projects every corpus event with the recorded limits', () => {
    const cases = CORPUS.executionPolicy.events as any[]
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) {
      const descriptor = generatedPeerHostEventDescriptor(entry.topic, () => undefined)
      const expected = entry.expected
      expect(descriptor.topic, `${entry.name}: topic`).toBe(expected.topic)
      expect(descriptor.module, `${entry.name}: module`).toBe(expected.module)
      expect(descriptor.name, `${entry.name}: name`).toBe(expected.name)
      expect(descriptor.outputSchemaId, `${entry.name}: outputSchemaId`).toBe(expected.outputSchemaId)
      expect(descriptor.requiredPermissions, `${entry.name}: requiredPermissions`).toEqual(
        expected.requiredPermissions
      )
      expect(descriptor.maxTtlSeconds, `${entry.name}: maxTtlSeconds`).toBe(expected.maxTtlSeconds)
      expect(descriptor.maxEventBytes, `${entry.name}: maxEventBytes`).toBe(expected.maxEventBytes)
      expect(descriptor.orderedEventGroup, `${entry.name}: orderedEventGroup`).toBe(expected.orderedEventGroup)
    }
  })
})

describe('mesh authority parity — TTS audio chunk emission', () => {
  it('sequences every corpus stream as recorded', () => {
    const cases = CORPUS.ttsEmission.cases as any[]
    expect(cases.length).toBeGreaterThan(0)
    const factory = generatedPeerHostEventDescriptor('TTS.AudioChunk', () => undefined).createEmissionValidator
    expect(factory, 'TTS.AudioChunk carries an emission validator').toBeTypeOf('function')

    for (const entry of cases) {
      const validate = (factory as () => (event: unknown, context: { correlationId?: string }) => void)()
      const context = entry.correlationId === null ? {} : { correlationId: entry.correlationId as string }
      entry.events.forEach((event: any, index: number) => {
        if (event.expectedError === null) {
          expect(() => validate(event.payload, context), `${entry.name}[${index}]`).not.toThrow()
          return
        }
        expect(() => validate(event.payload, context), `${entry.name}[${index}]`).toThrow(event.expectedError)
      })
    }
  })
})

describe('mesh authority invariants', () => {
  it('never lets an authority context cross peers', async () => {
    const repository = await seededRepository([
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
    const store = authorityStore(repository)
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
  })

  it('grants nothing on room membership alone', async () => {
    const store = new PeerAuthorityHostAuthorizationStore(
      new PeerAuthorityResolver({
        verifierStore: new DenyAllInboundCredentialVerifierStore(),
        grantRepository: new MemoryPeerGrantRepository(),
        challengeStore: new MemoryReconnectChallengeStore({ randomBytes: fixedRandomBytes(0x11) })
      })
    )
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
  })

  it('keeps reconnect challenges single-use per peer', async () => {
    const store = new MemoryReconnectChallengeStore({ randomBytes: countingRandomBytes() })
    const transport: ReconnectTransportAttestation = {
      channelBinding: 'b'.repeat(64),
      claimantSignalingPeerId: 'sig-a',
      verifierSignalingPeerId: 'sig-host'
    }
    const identityA: PeerRelationshipIdentity = {
      claimantPeerId: 'peer-a',
      verifierPeerId: 'peer-host',
      roomName: 'lab-room'
    }
    const identityB: PeerRelationshipIdentity = { ...identityA, claimantPeerId: 'peer-b' }
    const selectorA: PeerRelationshipSelector = { tokenId: 'token-a', ...identityA }
    const selectorB: PeerRelationshipSelector = { tokenId: 'token-a', ...identityB }

    const challengeA = await store.issueChallenge(identityA, transport, 1_000)
    const challengeB = await store.issueChallenge(identityB, transport, 1_000)
    expect(challengeA.challenge).not.toBe(challengeB.challenge)

    expect((await store.consumeChallenge(challengeA.challenge, selectorB, transport, 1_100)).status).toBe(
      'selector_mismatch'
    )
    expect((await store.consumeChallenge(challengeA.challenge, selectorA, transport, 1_100)).status).toBe(
      'accepted'
    )
    expect((await store.consumeChallenge(challengeA.challenge, selectorA, transport, 1_200)).status).toBe('replay')
    expect((await store.consumeChallenge(challengeB.challenge, selectorB, transport, 1_300)).status).toBe(
      'accepted'
    )
  })
})

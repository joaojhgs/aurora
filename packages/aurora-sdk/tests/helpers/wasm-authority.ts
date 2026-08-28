import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  RustPeerHostAuthorizationStore,
  createDurableHydrationLoader,
  createWasmAuthorityPort
} from '../../src/peer-host/rust-authorization-store.js'
import type {
  AuthenticatedPeerContext,
  GrantDimensions,
  IssuedPeerBearerCredential,
  IssueReconnectChallengeRequest,
  PeerGrantManagerPort,
  PeerGrantRepository,
  LocalPeerCredentialVerifierV1,
  LocalPeerGrantV1,
  PeerAuthorityDecision,
  PeerAuthorityResolverPort,
  PeerPairingIssueOptions,
  PeerPairingIssuerPort,
  PeerRelationshipSelector,
  ReconnectChallengeRecord,
  ReconnectTransportAttestation,
  VerifyReconnectProofRequest,
  VerifyReconnectProofResult
} from '../../src/peer-host/index.js'

/**
 * The real authority, for tests that need it to actually decide.
 *
 * R2 left one authority and it is Rust. A test about the *runtime's* pairing and
 * reconnect sequencing has to be answered by something that really mints
 * credentials, really spends challenges once, and really checks proofs — so it
 * is answered by the shipped WebAssembly build rather than by a stand-in that
 * would agree with the runtime by construction.
 *
 * Requires `pnpm --filter @aurora/mesh-authority-web run build:wasm`.
 */

const WASM_DIR = resolve(
  process.cwd(),
  '../aurora-mesh-authority-web/dist/wasm'
)

interface MeshAuthorityBindings {
  hydrateVerifier(verifier: unknown): Promise<void>
  hydrateGrant(grant: unknown): Promise<void>
  issueReconnectChallenge(request: unknown): Promise<ReconnectChallengeRecord>
  verifyReconnectProof(request: unknown): Promise<VerifyReconnectProofResult>
  resolveGrant(context: unknown, dimensions: unknown, nowMs: number): Promise<PeerAuthorityDecision>
  issuePairingCredential(
    selector: unknown,
    expiresAtMs: number | undefined,
    nowMs: number
  ): Promise<IssuedPeerBearerCredential>
  rollbackPairingCredential(selector: unknown): Promise<void>
  authorize(request: unknown): Promise<never>
  snapshotManifestAuthority(request: unknown): Promise<never>
  listActiveGrants(selector: unknown, nowMs: number): Promise<never[]>
  replaceGrant(
    selector: unknown,
    selection: unknown,
    nowMs: number,
    grantId: string
  ): Promise<never>
  revokeSharing(selector: unknown, nowMs: number): Promise<never[]>
  revokePeerAuthority(
    selector: unknown,
    reasonCode: string,
    revokedAtMs: number
  ): Promise<never>
  exportGrants(selector: unknown): LocalPeerGrantV1[]
  getVerifier(
    selector: unknown,
    nowMs: number
  ): Promise<unknown>
}

export interface WasmVerifierStatus {
  found: boolean
  credentialRevision?: number
}

interface MeshAuthorityModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>
  MeshAuthority: new () => MeshAuthorityBindings
  createReconnectProofForBearer?: (
    rawBearerToken: string,
    selector: unknown,
    transport: unknown,
    challenge: string
  ) => string
}

function defaultTestGrantId(): () => string {
  let sequence = 0
  return () => `grant-${(sequence += 1)}`
}

let modulePromise: Promise<MeshAuthorityModule> | undefined

async function loadModule(): Promise<MeshAuthorityModule> {
  if (modulePromise === undefined) {
    modulePromise = (async () => {
      const bindings = (await import(
        `${WASM_DIR}/aurora_mesh_authority.js`
      )) as unknown as MeshAuthorityModule
      await bindings.default({
        module_or_path: readFileSync(`${WASM_DIR}/aurora_mesh_authority_bg.wasm`)
      })
      return bindings
    })()
  }
  return await modulePromise
}

/** A real authority, hydrated with whatever the test wants it to know. */
export interface TestAuthority {
  readonly resolver: PeerAuthorityResolverPort
  readonly pairingIssuer: PeerPairingIssuerPort
  hydrateVerifier(verifier: LocalPeerCredentialVerifierV1): Promise<void>
  hydrateGrant(grant: LocalPeerGrantV1): Promise<void>
  /** The live verifier for a relationship, as the authority holds it. */
  getVerifier(
    selector: PeerRelationshipSelector,
    nowMs: number
  ): Promise<WasmVerifierStatus>
  /**
   * Sharing settings, answered by the real authority.
   *
   * `durable` is both where existing rows are read from and where new ones are
   * written back — the same repository on both sides, exactly as the shell
   * wires it. The authority holds its rows in memory by design, so without this
   * a sharing change would not survive and an existing one would be invisible.
   */
  grantManager(now: () => number, durable?: PeerGrantRepository): PeerGrantManagerPort
  reconnectProof(
    bearerToken: string,
    selector: PeerRelationshipSelector,
    transport: ReconnectTransportAttestation,
    challenge: string
  ): Promise<string>
}

export async function createTestAuthority(
  now: () => number = () => 1_000,
  newGrantId: () => string = defaultTestGrantId()
): Promise<TestAuthority> {
  const module = await loadModule()
  const authority = new module.MeshAuthority()
  return {
    resolver: {
      async issueReconnectChallenge(
        request: IssueReconnectChallengeRequest
      ): Promise<ReconnectChallengeRecord> {
        return await authority.issueReconnectChallenge(request)
      },
      async verifyReconnectProof(
        request: VerifyReconnectProofRequest
      ): Promise<VerifyReconnectProofResult> {
        return await authority.verifyReconnectProof(request)
      },
      async resolveGrant(
        context: AuthenticatedPeerContext,
        dimensions: GrantDimensions & { readonly nowMs: number }
      ): Promise<PeerAuthorityDecision> {
        const { nowMs, ...rest } = dimensions
        return await authority.resolveGrant(context, rest, nowMs)
      }
    },
    pairingIssuer: {
      async issue(
        selector: PeerRelationshipSelector,
        options: PeerPairingIssueOptions = {}
      ): Promise<IssuedPeerBearerCredential> {
        return await authority.issuePairingCredential(selector, options.expiresAtMs, now())
      },
      async rollback(selector: PeerRelationshipSelector): Promise<void> {
        await authority.rollbackPairingCredential(selector)
      }
    },
    grantManager(now, durable) {
      return new RustPeerHostAuthorizationStore(
        createWasmAuthorityPort(
          {
            // The raw binding hydrates one row at a time and keeps its methods
            // on the prototype, so each one is bound explicitly rather than
            // spread.
            hydrate: async (verifiers, grants) => {
              for (const verifier of verifiers) await authority.hydrateVerifier(verifier)
              for (const grant of grants) await authority.hydrateGrant(grant)
            },
            authorize: async (request) => await authority.authorize(request),
            snapshotManifestAuthority: async (request) =>
              await authority.snapshotManifestAuthority(request),
            resolveGrant: async (context, dimensions, nowMs) =>
              await authority.resolveGrant(context, dimensions, nowMs),
            issueReconnectChallenge: async (request) =>
              await authority.issueReconnectChallenge(request),
            verifyReconnectProof: async (request) =>
              await authority.verifyReconnectProof(request),
            issuePairingCredential: async (selector, expiresAtMs, nowMs) =>
              await authority.issuePairingCredential(selector, expiresAtMs, nowMs),
            rollbackPairingCredential: async (selector) =>
              await authority.rollbackPairingCredential(selector),
            listActiveGrants: async (selector, nowMs) =>
              await authority.listActiveGrants(selector, nowMs),
            replaceGrant: async (selector, selection, nowMs, grantId) =>
              await authority.replaceGrant(selector, selection, nowMs, grantId),
            revokeSharing: async (selector, nowMs) =>
              await authority.revokeSharing(selector, nowMs),
            revokePeerAuthority: async (selector, reasonCode, revokedAtMs) =>
              await authority.revokePeerAuthority(selector, reasonCode, revokedAtMs),
            drainAuditRecords: () => [],
            exportGrants: (selector) => authority.exportGrants(selector)
          },
          newGrantId
        ),
        undefined,
        durable === undefined
          ? undefined
          : createDurableHydrationLoader({
              verifierStore: {
                getVerifier: async () => undefined,
                upsertVerifier: async () => undefined,
                revokeVerifier: async () => undefined,
                deleteVerifier: async () => undefined
              },
              grantRepository: durable,
              now
            })
      ).asGrantManagerPort(now, durable)
    },
    async getVerifier(selector, nowMs) {
      return verifierStatus(await authority.getVerifier(selector, nowMs))
    },
    async hydrateVerifier(verifier) {
      await authority.hydrateVerifier(verifier)
    },
    async hydrateGrant(grant) {
      await authority.hydrateGrant(grant)
    },
    async reconnectProof(bearerToken, selector, transport, challenge) {
      const compute = (await loadModule()).MeshAuthority as unknown as {
        createReconnectProofForBearer: (
          token: string,
          selector: unknown,
          transport: unknown,
          challenge: string
        ) => string
      }
      return compute.createReconnectProofForBearer(bearerToken, selector, transport, challenge)
    }
  }
}

function verifierStatus(value: unknown): WasmVerifierStatus {
  const serialized = JSON.stringify(value)
  if (/(?:tokenHashHex|rawBearerToken|verifierKey)/u.test(serialized)) {
    throw new Error('WASM verifier status exposed credential proof material')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('WASM verifier status is malformed')
  }
  const record = value as Record<string, unknown>
  if (typeof record.found !== 'boolean') throw new Error('WASM verifier status is malformed')
  if (record.credentialRevision === undefined) return { found: record.found }
  if (typeof record.credentialRevision !== 'number' || !Number.isSafeInteger(record.credentialRevision)) {
    throw new Error('WASM verifier status is malformed')
  }
  return { found: record.found, credentialRevision: record.credentialRevision }
}

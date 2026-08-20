import { computeReconnectProofHex } from '../webrtc/crypto.js'

import type { PeerRelationshipSelector, ReconnectTransportAttestation } from './authority-types.js'

/**
 * Compute the reconnect proof a claimant presents for a raw bearer token.
 *
 * This survived R2 because it is cryptography, not authority: it derives an
 * HMAC over a fixed transcript and decides nothing. The *verifier* side — which
 * challenge is live, whether it has already been spent, whether a credential
 * exists — is the authority's, and lives in Rust.
 *
 * `rust/crates/aurora-mesh-authority/src/authority.rs` carries the same
 * function, and `tests/fixtures/mesh_authority_parity_vectors.json` pins both to
 * the same vectors, so a divergence in the transcript fails a test rather than a
 * handshake.
 */
export async function createReconnectProofForBearer(
  rawBearerToken: string,
  selector: PeerRelationshipSelector,
  transport: ReconnectTransportAttestation,
  challenge: string
): Promise<string> {
  return await computeReconnectProofHex(rawBearerToken, {
    tokenId: selector.tokenId,
    challenge,
    channelBinding: transport.channelBinding,
    claimantPeerId: selector.claimantPeerId,
    verifierPeerId: selector.verifierPeerId,
    roomName: selector.roomName
  })
}

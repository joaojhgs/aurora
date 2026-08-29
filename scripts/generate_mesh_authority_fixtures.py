#!/usr/bin/env python3
"""Generate the shared mesh-authority parity corpus.

Writes ``tests/fixtures/mesh_authority_parity_vectors.json``, the one file that
``rust/crates/aurora-mesh-authority/tests/parity_corpus.rs`` and
``packages/aurora-sdk/tests/mesh-authority-parity-vectors.test.ts`` both drive
themselves from. Two authorities is drift in the one layer where drift is a
vulnerability, so while both exist they answer the same questions from the same
file or one of them fails.

Follows the precedent of ``scripts/generate_webrtc_protocol_fixtures.py``: one
JSON document, ``synthetic: true``, no real credentials, regenerated rather
than hand-edited.

The cryptographic vectors are *computed* here, so the corpus carries a third
independent implementation of the reconnect transcript. Every other expectation
is *authored* from the TypeScript source, because re-implementing the decision
logic in Python would only add a third thing to keep in step.

Usage::

    uv run python scripts/generate_mesh_authority_fixtures.py
"""

from __future__ import annotations

import hashlib
import hmac
import json
from pathlib import Path
from typing import Any

SCHEMA = "aurora.mesh.authority.parity_vectors.v1"
OUTPUT = (
    Path(__file__).resolve().parents[1]
    / "tests"
    / "fixtures"
    / "mesh_authority_parity_vectors.json"
)

RECONNECT_DOMAIN = b"aurora.mesh.reconnect-proof.v1\0"
CHALLENGE_TTL_MS = 20_000

ROOM = "lab-room"
HOST = "peer-host"
PEER_A = "peer-a"
PEER_B = "peer-b"
TOKEN_A = "token-a"
TOKEN_B = "token-b"

CHANNEL_BINDING = "b" * 64
OTHER_CHANNEL_BINDING = "c" * 64
CHALLENGE_BYTES = "1" * 64
UNISSUED_CHALLENGE = "9" * 64


def selector(token_id: str = TOKEN_A, claimant: str = PEER_A, room: str = ROOM) -> dict[str, str]:
    return {
        "tokenId": token_id,
        "claimantPeerId": claimant,
        "verifierPeerId": HOST,
        "roomName": room,
    }


def identity(claimant: str = PEER_A, room: str = ROOM) -> dict[str, str]:
    return {"claimantPeerId": claimant, "verifierPeerId": HOST, "roomName": room}


def transport(
    channel_binding: str = CHANNEL_BINDING,
    claimant_signaling: str = "sig-a",
    verifier_signaling: str = "sig-host",
) -> dict[str, str]:
    return {
        "channelBinding": channel_binding,
        "claimantSignalingPeerId": claimant_signaling,
        "verifierSignalingPeerId": verifier_signaling,
    }


def grant(
    grant_id: str,
    *,
    methods: list[str] | None = None,
    tools: list[str] | None = None,
    capabilities: list[str] | None = None,
    scopes: list[str] | None = None,
    token_id: str = TOKEN_A,
    claimant: str = PEER_A,
    room: str = ROOM,
    created_at_ms: int = 1_000,
    expires_at_ms: int | None = None,
    revoked_at_ms: int | None = None,
    revision: int = 1,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "version": 1,
        "grantId": grant_id,
        **selector(token_id, claimant, room),
        "allowedMethodIds": methods if methods is not None else [],
        "allowedToolContractIds": tools if tools is not None else [],
        "capabilityPackIds": capabilities if capabilities is not None else [],
        "resourceScopes": scopes if scopes is not None else [],
        "createdAtMs": created_at_ms,
        "grantRevision": revision,
    }
    if expires_at_ms is not None:
        record["expiresAtMs"] = expires_at_ms
    if revoked_at_ms is not None:
        record["revokedAtMs"] = revoked_at_ms
    return record


# ---------------------------------------------------------------------------
# Reconnect proof — computed, not authored
# ---------------------------------------------------------------------------


def canonical_transcript(
    *, challenge: str, channel_binding: str, claimant: str, room: str, token_id: str, verifier: str
) -> bytes:
    """Reproduce ``buildMeshReconnectProofMessage`` from ``webrtc/crypto.ts``."""
    payload = {
        "challenge": challenge,
        "channel_binding": channel_binding,
        "claimant_peer_id": claimant,
        "room_name": room,
        "token_id": token_id,
        "verifier_peer_id": verifier,
        "version": 1,
    }
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
    return RECONNECT_DOMAIN + canonical.encode("utf-8")


def reconnect_proof_case(
    name: str, *, bearer_token: str, sel: dict[str, str], tr: dict[str, str], challenge: str
) -> dict[str, Any]:
    message = canonical_transcript(
        challenge=challenge,
        channel_binding=tr["channelBinding"],
        claimant=sel["claimantPeerId"],
        room=sel["roomName"],
        token_id=sel["tokenId"],
        verifier=sel["verifierPeerId"],
    )
    token_hash = hashlib.sha256(bearer_token.encode("utf-8")).digest()
    proof = hmac.new(token_hash, message, hashlib.sha256).hexdigest()
    return {
        "name": name,
        "bearerToken": bearer_token,
        "selector": sel,
        "transport": tr,
        "challenge": challenge,
        "expectedMessageHex": message.hex(),
        "expectedTokenHashHex": token_hash.hex(),
        "expectedProofHex": proof,
    }


def reconnect_proof_section() -> dict[str, Any]:
    base = reconnect_proof_case(
        "ascii_selector",
        bearer_token="a" * 64,
        sel=selector(),
        tr=transport(),
        challenge=CHALLENGE_BYTES,
    )
    unicode_case = reconnect_proof_case(
        "non_ascii_room_is_escaped",
        bearer_token="a" * 64,
        sel=selector(room="café-\U0001f600"),
        tr=transport(),
        challenge=CHALLENGE_BYTES,
    )
    return {
        "cases": [base, unicode_case],
        "verify": [
            {
                "name": "accepts_matching_proof",
                "hostile": False,
                "tokenHashHex": base["expectedTokenHashHex"],
                "proofHex": base["expectedProofHex"],
                "selector": base["selector"],
                "transport": base["transport"],
                "challenge": base["challenge"],
                "expected": True,
            },
            {
                "name": "rejects_proof_for_another_challenge",
                "hostile": True,
                "tokenHashHex": base["expectedTokenHashHex"],
                "proofHex": base["expectedProofHex"],
                "selector": base["selector"],
                "transport": base["transport"],
                "challenge": UNISSUED_CHALLENGE,
                "expected": False,
            },
            {
                "name": "rejects_proof_bound_to_another_channel",
                "hostile": True,
                "tokenHashHex": base["expectedTokenHashHex"],
                "proofHex": base["expectedProofHex"],
                "selector": base["selector"],
                "transport": transport(channel_binding=OTHER_CHANNEL_BINDING),
                "challenge": base["challenge"],
                "expected": False,
            },
            {
                "name": "rejects_proof_replayed_for_another_peer",
                "hostile": True,
                "tokenHashHex": base["expectedTokenHashHex"],
                "proofHex": base["expectedProofHex"],
                "selector": selector(claimant=PEER_B),
                "transport": base["transport"],
                "challenge": base["challenge"],
                "expected": False,
            },
            {
                "name": "rejects_malformed_hex",
                "hostile": True,
                "tokenHashHex": base["expectedTokenHashHex"],
                "proofHex": "not-hex",
                "selector": base["selector"],
                "transport": base["transport"],
                "challenge": base["challenge"],
                "expected": False,
            },
            {
                "name": "rejects_short_proof",
                "hostile": True,
                "tokenHashHex": base["expectedTokenHashHex"],
                "proofHex": "ab" * 16,
                "selector": base["selector"],
                "transport": base["transport"],
                "challenge": base["challenge"],
                "expected": False,
            },
        ],
    }


# ---------------------------------------------------------------------------
# Grant resolution — MemoryPeerGrantRepository.resolveGrant
# ---------------------------------------------------------------------------


def grant_resolution_section() -> dict[str, Any]:
    def case(
        name: str,
        *,
        hostile: bool,
        grants: list[dict[str, Any]],
        request: dict[str, Any],
        expected: dict[str, Any],
        note: str,
    ) -> dict[str, Any]:
        return {
            "name": name,
            "hostile": hostile,
            "note": note,
            "grants": grants,
            "request": request,
            "expected": expected,
        }

    live = grant("grant-live", methods=["Tooling.GetTools"])
    return {
        "cases": [
            case(
                "method_granted",
                hostile=False,
                grants=[live],
                request={"selector": selector(), "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": True, "grantId": "grant-live"},
                note="The ordinary allow.",
            ),
            case(
                "method_not_granted",
                hostile=True,
                grants=[live],
                request={"selector": selector(), "methodId": "Tooling.ExecuteTool", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "method_not_granted"},
                note="Escalation: a grant for one method must not answer for another.",
            ),
            case(
                "grant_expired",
                hostile=True,
                grants=[grant("grant-expired", methods=["Tooling.GetTools"], expires_at_ms=1_500)],
                request={"selector": selector(), "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "grant_expired"},
                note="Expiry is evaluated against nowMs, inclusive.",
            ),
            case(
                "grant_expiring_exactly_now_is_expired",
                hostile=True,
                grants=[grant("grant-edge", methods=["Tooling.GetTools"], expires_at_ms=2_000)],
                request={"selector": selector(), "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "grant_expired"},
                note="expiresAtMs <= nowMs, not <.",
            ),
            case(
                "grant_revoked",
                hostile=True,
                grants=[grant("grant-revoked", methods=["Tooling.GetTools"], revoked_at_ms=1_500)],
                request={"selector": selector(), "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "grant_revoked"},
                note="Revoked authority denies even a covered method.",
            ),
            case(
                "grant_for_another_peer_is_invisible",
                hostile=True,
                grants=[grant("grant-b", methods=["Tooling.GetTools"], claimant=PEER_B)],
                request={"selector": selector(), "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "grant_not_found"},
                note="Invariant: authority contexts never cross peers.",
            ),
            case(
                "grant_in_another_room_is_invisible",
                hostile=True,
                grants=[grant("grant-other-room", methods=["Tooling.GetTools"], room="other-room")],
                request={"selector": selector(), "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "grant_not_found"},
                note="Invariant: room membership is not authority.",
            ),
            case(
                "grant_under_another_token_is_invisible",
                hostile=True,
                grants=[grant("grant-token-b", methods=["Tooling.GetTools"], token_id=TOKEN_B)],
                request={"selector": selector(), "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "grant_not_found"},
                note="A grant is bound to the credential it was issued against.",
            ),
            case(
                "tool_not_granted",
                hostile=True,
                grants=[live],
                request={
                    "selector": selector(),
                    "methodId": "Tooling.GetTools",
                    "toolContractId": "tool.calendar",
                    "nowMs": 2_000,
                },
                expected={"allowed": False, "reasonCode": "tool_not_granted"},
                note="Coverage is checked member by member, in declaration order.",
            ),
            case(
                "capability_not_granted",
                hostile=True,
                grants=[
                    grant("grant-tools", methods=["Tooling.GetTools"], tools=["tool.calendar"])
                ],
                request={
                    "selector": selector(),
                    "methodId": "Tooling.GetTools",
                    "toolContractId": "tool.calendar",
                    "capabilityPackId": "pack.notes",
                    "nowMs": 2_000,
                },
                expected={"allowed": False, "reasonCode": "capability_not_granted"},
                note="",
            ),
            case(
                "resource_not_granted",
                hostile=True,
                grants=[
                    grant(
                        "grant-caps",
                        methods=["Tooling.GetTools"],
                        tools=["tool.calendar"],
                        capabilities=["pack.notes"],
                    )
                ],
                request={
                    "selector": selector(),
                    "methodId": "Tooling.GetTools",
                    "toolContractId": "tool.calendar",
                    "capabilityPackId": "pack.notes",
                    "resourceScope": "notes/2024",
                    "nowMs": 2_000,
                },
                expected={"allowed": False, "reasonCode": "resource_not_granted"},
                note="",
            ),
            case(
                "full_coverage_allows",
                hostile=False,
                grants=[
                    grant(
                        "grant-full",
                        methods=["Tooling.GetTools"],
                        tools=["tool.calendar"],
                        capabilities=["pack.notes"],
                        scopes=["notes/2024"],
                    )
                ],
                request={
                    "selector": selector(),
                    "methodId": "Tooling.GetTools",
                    "toolContractId": "tool.calendar",
                    "capabilityPackId": "pack.notes",
                    "resourceScope": "notes/2024",
                    "nowMs": 2_000,
                },
                expected={"allowed": True, "grantId": "grant-full"},
                note="",
            ),
            case(
                "newest_revision_is_tried_first_then_older_covers",
                hostile=False,
                grants=[
                    grant(
                        "grant-old", methods=["Tooling.GetTools"], revision=1, created_at_ms=1_000
                    ),
                    grant("grant-new", methods=["TTS.ListVoices"], revision=2, created_at_ms=1_500),
                ],
                request={"selector": selector(), "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": True, "grantId": "grant-old"},
                note="Candidates sort by revision desc, then createdAt desc, then id asc.",
            ),
            case(
                "revoked_newest_does_not_shadow_live_older",
                hostile=True,
                grants=[
                    grant(
                        "grant-newest",
                        methods=["Tooling.GetTools"],
                        revision=3,
                        created_at_ms=1_800,
                        revoked_at_ms=1_900,
                    ),
                    grant(
                        "grant-older", methods=["Tooling.GetTools"], revision=2, created_at_ms=1_500
                    ),
                ],
                request={"selector": selector(), "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": True, "grantId": "grant-older"},
                note="A revoked candidate records its reason and keeps looking.",
            ),
            case(
                "all_candidates_revoked_reports_revoked",
                hostile=True,
                grants=[
                    grant(
                        "grant-r1", methods=["Tooling.GetTools"], revision=2, revoked_at_ms=1_500
                    ),
                    grant(
                        "grant-r2", methods=["Tooling.GetTools"], revision=1, revoked_at_ms=1_500
                    ),
                ],
                request={"selector": selector(), "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "grant_revoked"},
                note="The last blocking reason wins, not the first.",
            ),
            case(
                "no_grants_at_all",
                hostile=True,
                grants=[],
                request={"selector": selector(), "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "grant_not_found"},
                note="",
            ),
            case(
                "bare_relationship_check_allows_any_live_grant",
                hostile=False,
                grants=[live],
                request={"selector": selector(), "nowMs": 2_000},
                expected={"allowed": True, "grantId": "grant-live"},
                note="With nothing to cover, any live grant answers. Used by revocation.",
            ),
        ]
    }


# ---------------------------------------------------------------------------
# SessionPeerHostAuthorizationStore.authorize
# ---------------------------------------------------------------------------


def context(token_id: str = TOKEN_A, claimant: str = PEER_A, room: str = ROOM) -> dict[str, Any]:
    return {
        "selector": selector(token_id, claimant, room),
        "transport": transport(),
        "credentialRevision": 1,
        "authenticatedAtMs": 500,
    }


def session_authorize_section() -> dict[str, Any]:
    def case(
        name: str,
        *,
        hostile: bool,
        grants: list[dict[str, Any]],
        request: dict[str, Any],
        expected: dict[str, Any],
        note: str = "",
    ) -> dict[str, Any]:
        return {
            "name": name,
            "hostile": hostile,
            "note": note,
            "grants": grants,
            "request": request,
            "expected": expected,
        }

    return {
        "cases": [
            case(
                "allows_covered_method",
                hostile=False,
                grants=[
                    grant("grant-live", methods=["Tooling.GetTools", "TTS.ListVoices"], revision=4)
                ],
                request={"remotePeerId": PEER_A, "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={
                    "allowed": True,
                    "grantRevision": 4,
                    "grantedMethodIds": ["TTS.ListVoices", "Tooling.GetTools"],
                },
                note="grantedMethodIds is sorted and de-duplicated.",
            ),
            case(
                "de_duplicates_granted_methods",
                hostile=False,
                grants=[
                    grant(
                        "grant-dupes",
                        methods=["Tooling.GetTools", "Tooling.GetTools", "TTS.ListVoices"],
                        revision=1,
                    )
                ],
                request={"remotePeerId": PEER_A, "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={
                    "allowed": True,
                    "grantRevision": 1,
                    "grantedMethodIds": ["TTS.ListVoices", "Tooling.GetTools"],
                },
            ),
            case(
                "denies_revoked_before_checking_the_method",
                hostile=True,
                grants=[grant("grant-revoked", methods=[], revision=7, revoked_at_ms=1_500)],
                request={"remotePeerId": PEER_A, "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "grant_revoked", "grantRevision": 7},
                note="Revocation short-circuits: a revoked grant denies even for a method it never carried.",
            ),
            case(
                "denies_expired_before_checking_the_method",
                hostile=True,
                grants=[grant("grant-expired", methods=[], revision=5, expires_at_ms=1_500)],
                request={"remotePeerId": PEER_A, "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "grant_expired", "grantRevision": 5},
            ),
            case(
                "insertion_order_decides_which_grant_answers",
                hostile=True,
                grants=[
                    grant("grant-first", methods=[], revision=1, expires_at_ms=1_500),
                    grant("grant-second", methods=["Tooling.GetTools"], revision=9),
                ],
                request={"remotePeerId": PEER_A, "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "grant_expired", "grantRevision": 1},
                note=(
                    "The store returns on the first match in insertion order, so an expired "
                    "grant inserted first denies a request a later live grant would allow. "
                    "Pinned because a hash map would make it non-deterministic."
                ),
            ),
            case(
                "grant_for_another_peer_is_skipped",
                hostile=True,
                grants=[grant("grant-b", methods=["Tooling.GetTools"], claimant=PEER_B)],
                request={"remotePeerId": PEER_A, "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "grant_not_found"},
                note="Invariant: authority contexts never cross peers.",
            ),
            case(
                "grant_under_another_token_is_skipped_when_authenticated",
                hostile=True,
                grants=[grant("grant-token-b", methods=["Tooling.GetTools"], token_id=TOKEN_B)],
                request={
                    "remotePeerId": PEER_A,
                    "methodId": "Tooling.GetTools",
                    "authenticatedPeerContext": context(),
                    "nowMs": 2_000,
                },
                expected={"allowed": False, "reasonCode": "grant_not_found"},
                note="The token filter applies only when the caller proved an identity.",
            ),
            case(
                "grant_under_another_token_is_visible_without_a_context",
                hostile=True,
                grants=[
                    grant(
                        "grant-token-b", methods=["Tooling.GetTools"], token_id=TOKEN_B, revision=2
                    )
                ],
                request={"remotePeerId": PEER_A, "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={
                    "allowed": True,
                    "grantRevision": 2,
                    "grantedMethodIds": ["Tooling.GetTools"],
                },
                note=(
                    "Without an authenticated context this store filters on claimant alone. "
                    "That is why the peer host uses PeerAuthorityHostAuthorizationStore in "
                    "production and this one only inside a proven session."
                ),
            ),
            case(
                "uncovered_method_reports_no_revision",
                hostile=True,
                grants=[grant("grant-other", methods=["TTS.ListVoices"], revision=6)],
                request={"remotePeerId": PEER_A, "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "grant_not_found"},
                note=(
                    "TypeScript raises bestRevision immediately before returning an allow, so "
                    "the grant_not_found fallback never carries a revision. Pinned as written."
                ),
            ),
            case(
                "no_grants_at_all",
                hostile=True,
                grants=[],
                request={"remotePeerId": PEER_A, "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "grant_not_found"},
            ),
        ]
    }


# ---------------------------------------------------------------------------
# PeerAuthorityHostAuthorizationStore.authorize
# ---------------------------------------------------------------------------


def authority_authorize_section() -> dict[str, Any]:
    def case(
        name: str,
        *,
        hostile: bool,
        grants: list[dict[str, Any]],
        request: dict[str, Any],
        expected: dict[str, Any],
        note: str = "",
    ) -> dict[str, Any]:
        return {
            "name": name,
            "hostile": hostile,
            "note": note,
            "grants": grants,
            "request": request,
            "expected": expected,
        }

    live = grant("grant-live", methods=["Tooling.GetTools"], revision=3)
    return {
        "cases": [
            case(
                "allows_authenticated_peer_with_a_covering_grant",
                hostile=False,
                grants=[live],
                request={
                    "remotePeerId": PEER_A,
                    "methodId": "Tooling.GetTools",
                    "authenticatedPeerContext": context(),
                    "nowMs": 2_000,
                },
                expected={
                    "allowed": True,
                    "grantRevision": 3,
                    "grantedMethodIds": ["Tooling.GetTools"],
                },
            ),
            case(
                "denies_an_unauthenticated_caller",
                hostile=True,
                grants=[live],
                request={"remotePeerId": PEER_A, "methodId": "Tooling.GetTools", "nowMs": 2_000},
                expected={"allowed": False, "reasonCode": "peer_not_authenticated"},
                note="No proof, no decision — and no leak of whether a grant exists.",
            ),
            case(
                "denies_a_context_belonging_to_another_peer",
                hostile=True,
                grants=[live],
                request={
                    "remotePeerId": PEER_A,
                    "methodId": "Tooling.GetTools",
                    "authenticatedPeerContext": context(claimant=PEER_B),
                    "nowMs": 2_000,
                },
                expected={"allowed": False, "reasonCode": "selector_mismatch"},
                note=(
                    "Invariant: authority contexts never cross peers. Peer B's proven context "
                    "presented on a frame claiming to be peer A is refused before the resolver "
                    "is consulted at all."
                ),
            ),
            case(
                "denies_an_uncovered_method",
                hostile=True,
                grants=[live],
                request={
                    "remotePeerId": PEER_A,
                    "methodId": "Tooling.ExecuteTool",
                    "authenticatedPeerContext": context(),
                    "nowMs": 2_000,
                },
                expected={"allowed": False, "reasonCode": "method_not_granted"},
                note="Escalation attempt.",
            ),
            case(
                "denies_a_revoked_grant",
                hostile=True,
                grants=[grant("grant-revoked", methods=["Tooling.GetTools"], revoked_at_ms=1_500)],
                request={
                    "remotePeerId": PEER_A,
                    "methodId": "Tooling.GetTools",
                    "authenticatedPeerContext": context(),
                    "nowMs": 2_000,
                },
                expected={"allowed": False, "reasonCode": "grant_revoked"},
            ),
            case(
                "denies_a_room_the_grant_does_not_cover",
                hostile=True,
                grants=[live],
                request={
                    "remotePeerId": PEER_A,
                    "methodId": "Tooling.GetTools",
                    "authenticatedPeerContext": context(room="other-room"),
                    "nowMs": 2_000,
                },
                expected={"allowed": False, "reasonCode": "grant_not_found"},
                note="Invariant: room membership is not authority.",
            ),
        ]
    }


# ---------------------------------------------------------------------------
# Manifest authority snapshot
# ---------------------------------------------------------------------------


def manifest_snapshot_section() -> dict[str, Any]:
    return {
        "session": [
            {
                "name": "aggregates_live_grants",
                "hostile": False,
                "grants": [
                    grant("grant-a", methods=["Tooling.GetTools"], revision=2),
                    grant("grant-b", methods=["TTS.ListVoices", "Tooling.GetTools"], revision=5),
                    grant(
                        "grant-revoked",
                        methods=["Orchestrator.Interrupt"],
                        revision=9,
                        revoked_at_ms=1_500,
                    ),
                ],
                "request": {"remotePeerId": PEER_A, "nowMs": 2_000},
                "expected": {
                    "recipientPeerId": PEER_A,
                    "grantedMethodIds": ["TTS.ListVoices", "Tooling.GetTools"],
                    "authGrantRevision": 5,
                    "authGrantState": "active",
                },
                "note": "A revoked grant contributes neither a method nor a revision.",
            },
            {
                "name": "reports_unknown_with_nothing_live",
                "hostile": True,
                "grants": [
                    grant(
                        "grant-revoked",
                        methods=["Tooling.GetTools"],
                        revision=9,
                        revoked_at_ms=1_500,
                    )
                ],
                "request": {"remotePeerId": PEER_A, "nowMs": 2_000},
                "expected": {
                    "recipientPeerId": PEER_A,
                    "grantedMethodIds": [],
                    "authGrantRevision": 0,
                    "authGrantState": "unknown",
                },
            },
            {
                "name": "another_peers_grants_are_not_advertised",
                "hostile": True,
                "grants": [
                    grant("grant-b", methods=["Tooling.GetTools"], claimant=PEER_B, revision=4)
                ],
                "request": {"remotePeerId": PEER_A, "nowMs": 2_000},
                "expected": {
                    "recipientPeerId": PEER_A,
                    "grantedMethodIds": [],
                    "authGrantRevision": 0,
                    "authGrantState": "unknown",
                },
                "note": "Invariant: authority contexts never cross peers.",
            },
        ],
        "authority": [
            {
                "name": "aggregates_live_grants_for_the_proven_peer",
                "hostile": False,
                "grants": [
                    grant("grant-a", methods=["Tooling.GetTools"], revision=2),
                    grant("grant-b", methods=["TTS.ListVoices"], revision=5),
                ],
                "request": {
                    "remotePeerId": PEER_A,
                    "authenticatedPeerContext": context(),
                    "nowMs": 2_000,
                },
                "expected": {
                    "recipientPeerId": PEER_A,
                    "grantedMethodIds": ["TTS.ListVoices", "Tooling.GetTools"],
                    "grantedPermissions": [],
                    "authGrantRevision": 5,
                    "authGrantState": "active",
                },
            },
            {
                "name": "advertises_nothing_without_a_proven_identity",
                "hostile": True,
                "grants": [grant("grant-a", methods=["Tooling.GetTools"], revision=2)],
                "request": {"remotePeerId": PEER_A, "nowMs": 2_000},
                "expected": {
                    "recipientPeerId": PEER_A,
                    "grantedMethodIds": [],
                    "authGrantRevision": 0,
                    "authGrantState": "unknown",
                },
            },
            {
                "name": "advertises_nothing_when_the_context_is_another_peers",
                "hostile": True,
                "grants": [grant("grant-a", methods=["Tooling.GetTools"], revision=2)],
                "request": {
                    "remotePeerId": PEER_A,
                    "authenticatedPeerContext": context(claimant=PEER_B),
                    "nowMs": 2_000,
                },
                "expected": {
                    "recipientPeerId": PEER_A,
                    "grantedMethodIds": [],
                    "authGrantRevision": 0,
                    "authGrantState": "unknown",
                },
                "note": "Invariant: authority contexts never cross peers.",
            },
        ],
    }


# ---------------------------------------------------------------------------
# Reconnect challenge replay guard
# ---------------------------------------------------------------------------


def reconnect_challenge_section() -> dict[str, Any]:
    def step(
        *,
        challenge: str | None = None,
        sel: dict[str, str] | None = None,
        tr: dict[str, str] | None = None,
        now_ms: int,
        expected: str,
        reject_first: bool = False,
    ) -> dict[str, Any]:
        record: dict[str, Any] = {
            "action": "reject" if reject_first else "consume",
            "nowMs": now_ms,
        }
        if not reject_first:
            record["challenge"] = challenge
            record["selector"] = sel if sel is not None else selector()
            record["transport"] = tr if tr is not None else transport()
            record["expectedStatus"] = expected
        return record

    issued = {"identity": identity(), "transport": transport(), "nowMs": 1_000}
    return {
        "challengeBytesHex": CHALLENGE_BYTES,
        "ttlMs": CHALLENGE_TTL_MS,
        "cases": [
            {
                "name": "single_use_per_peer",
                "hostile": True,
                "note": (
                    "Invariant: reconnect challenges stay single-use per peer. The second "
                    "presentation of a consumed challenge is a replay, not a second chance."
                ),
                "issue": issued,
                "steps": [
                    step(challenge="ISSUED", now_ms=1_100, expected="accepted"),
                    step(challenge="ISSUED", now_ms=1_200, expected="replay"),
                    step(challenge="ISSUED", now_ms=1_300, expected="replay"),
                ],
            },
            {
                "name": "selector_mismatch_outranks_replay",
                "hostile": True,
                "note": "A consumed challenge presented by a different peer reports the mismatch, not the replay.",
                "issue": issued,
                "steps": [
                    step(challenge="ISSUED", now_ms=1_100, expected="accepted"),
                    step(
                        challenge="ISSUED",
                        sel=selector(claimant=PEER_B),
                        now_ms=1_200,
                        expected="selector_mismatch",
                    ),
                ],
            },
            {
                "name": "transport_mismatch",
                "hostile": True,
                "note": "A challenge is bound to the transport it was issued on.",
                "issue": issued,
                "steps": [
                    step(
                        challenge="ISSUED",
                        tr=transport(channel_binding=OTHER_CHANNEL_BINDING),
                        now_ms=1_100,
                        expected="transport_mismatch",
                    ),
                ],
            },
            {
                "name": "another_room_is_a_selector_mismatch",
                "hostile": True,
                "note": "Invariant: room membership is not authority.",
                "issue": issued,
                "steps": [
                    step(
                        challenge="ISSUED",
                        sel=selector(room="other-room"),
                        now_ms=1_100,
                        expected="selector_mismatch",
                    ),
                ],
            },
            {
                "name": "expires_after_exactly_twenty_seconds",
                "hostile": True,
                "note": "expiresAtMs <= nowMs, so the boundary instant is already expired.",
                "issue": issued,
                "steps": [
                    step(challenge="ISSUED", now_ms=1_000 + CHALLENGE_TTL_MS, expected="expired"),
                ],
            },
            {
                "name": "still_live_one_millisecond_before_expiry",
                "hostile": False,
                "issue": issued,
                "steps": [
                    step(
                        challenge="ISSUED", now_ms=1_000 + CHALLENGE_TTL_MS - 1, expected="accepted"
                    ),
                ],
            },
            {
                "name": "unissued_challenge_is_not_found",
                "hostile": True,
                "issue": issued,
                "steps": [
                    step(challenge=UNISSUED_CHALLENGE, now_ms=1_100, expected="not_found"),
                ],
            },
            {
                "name": "revocation_rejects_outstanding_challenges",
                "hostile": True,
                "note": "Forgetting a peer invalidates every challenge it could still answer.",
                "issue": issued,
                "steps": [
                    step(now_ms=1_050, expected="", reject_first=True),
                    step(challenge="ISSUED", now_ms=1_100, expected="rejected"),
                ],
            },
        ],
    }


# ---------------------------------------------------------------------------
# Grant selection normalization
# ---------------------------------------------------------------------------


def grant_selection_section() -> dict[str, Any]:
    def ok(
        name: str, selection: dict[str, Any], normalized: dict[str, Any], *, note: str = ""
    ) -> dict[str, Any]:
        return {
            "name": name,
            "hostile": False,
            "note": note,
            "nowMs": 2_000,
            "selection": selection,
            "expected": {"ok": True, "normalized": normalized},
        }

    def refused(
        name: str, selection: dict[str, Any], code: str, message: str, *, note: str = ""
    ) -> dict[str, Any]:
        return {
            "name": name,
            "hostile": True,
            "note": note,
            "nowMs": 2_000,
            "selection": selection,
            "expected": {"ok": False, "code": code, "message": message},
        }

    def empty_normalized(**overrides: Any) -> dict[str, Any]:
        base = {
            "allowedMethodIds": [],
            "allowedToolContractIds": [],
            "capabilityPackIds": [],
            "resourceScopes": [],
        }
        base.update(overrides)
        return base

    long_id = "m" * 257
    return {
        "cases": [
            ok(
                "sorts_and_de_duplicates",
                {"allowedMethodIds": ["TTS.ListVoices", "Tooling.GetTools", "TTS.ListVoices"]},
                empty_normalized(allowedMethodIds=["TTS.ListVoices", "Tooling.GetTools"]),
            ),
            ok(
                "trims_surrounding_whitespace",
                {"allowedMethodIds": ["  Tooling.GetTools  "]},
                empty_normalized(allowedMethodIds=["Tooling.GetTools"]),
            ),
            ok(
                "execute_tool_is_not_an_execution_word",
                {"allowedMethodIds": ["Tooling.ExecuteTool"]},
                empty_normalized(allowedMethodIds=["Tooling.ExecuteTool"]),
                note=(
                    "The execution matcher is anchored to whole separator-delimited "
                    "components, so ExecuteTool passes while shell.exec does not. Pinned "
                    "because an over-matching transliteration would silently break sharing."
                ),
            ),
            ok(
                "shell_alone_is_not_an_execution_word",
                {"allowedMethodIds": ["shell"]},
                empty_normalized(allowedMethodIds=["shell"]),
                note="`shell` is only refused as a resource scheme, not as an identifier component.",
            ),
            ok(
                "accepts_a_bounded_resource_scope",
                {"resourceScopes": ["notes/2024"]},
                empty_normalized(resourceScopes=["notes/2024"]),
            ),
            ok(
                "accepts_an_expiry_inside_the_window",
                {"allowedMethodIds": ["Tooling.GetTools"], "expiresAtMs": 2_001},
                empty_normalized(allowedMethodIds=["Tooling.GetTools"], expiresAtMs=2_001),
            ),
            refused(
                "empty_selection",
                {},
                "invalid_selection",
                "Choose at least one item to share",
                note="Sharing nothing is not a way to share.",
            ),
            refused(
                "wildcard",
                {"allowedMethodIds": ["*"]},
                "invalid_selection",
                "Invalid method selection",
                note="Escalation: a wildcard would grant everything the node can ever do.",
            ),
            refused(
                "path_traversal",
                {"resourceScopes": ["notes/../../etc"]},
                "invalid_selection",
                "Invalid resource selection",
            ),
            refused(
                "absolute_path",
                {"resourceScopes": ["/etc/passwd"]},
                "invalid_selection",
                "Invalid resource selection",
            ),
            refused(
                "home_relative_path",
                {"resourceScopes": ["~/.ssh"]},
                "invalid_selection",
                "Invalid resource selection",
            ),
            refused(
                "windows_separator",
                {"resourceScopes": ["notes\\2024"]},
                "invalid_selection",
                "Invalid resource selection",
            ),
            refused(
                "unsafe_characters",
                {"allowedMethodIds": ["Tooling GetTools"]},
                "invalid_selection",
                "Invalid method selection",
            ),
            refused(
                "secret_name_token",
                {"allowedMethodIds": ["Auth.token"]},
                "invalid_selection",
                "Invalid method selection",
                note="Names that read as secret material never become grant members.",
            ),
            refused(
                "secret_name_bearer",
                {"capabilityPackIds": ["Bearer"]},
                "invalid_selection",
                "Invalid capability selection",
            ),
            refused(
                "secret_name_private_key",
                {"capabilityPackIds": ["private-key"]},
                "invalid_selection",
                "Invalid capability selection",
            ),
            refused(
                "execution_shell_exec",
                {"allowedToolContractIds": ["shell.exec"]},
                "invalid_selection",
                "Invalid tool selection",
            ),
            refused(
                "execution_process_spawn",
                {"allowedToolContractIds": ["process.spawn"]},
                "invalid_selection",
                "Invalid tool selection",
            ),
            refused(
                "execution_sudo",
                {"allowedToolContractIds": ["sudo"]},
                "invalid_selection",
                "Invalid tool selection",
            ),
            refused(
                "execution_sh_component",
                {"allowedToolContractIds": ["bin/sh"]},
                "invalid_selection",
                "Invalid tool selection",
            ),
            refused(
                "resource_sql_scheme",
                {"resourceScopes": ["sql:users"]},
                "invalid_selection",
                "Invalid resource selection",
            ),
            refused(
                "resource_sqlite_scheme_bare",
                {"resourceScopes": ["sqlite"]},
                "invalid_selection",
                "Invalid resource selection",
            ),
            refused(
                "resource_select_word",
                {"resourceScopes": ["data.select"]},
                "invalid_selection",
                "Invalid resource selection",
            ),
            refused(
                "resource_drop_word",
                {"resourceScopes": ["notes/drop/2024"]},
                "invalid_selection",
                "Invalid resource selection",
            ),
            refused(
                "oversized_identifier",
                {"allowedMethodIds": [long_id]},
                "invalid_selection",
                "Invalid method selection",
                note="Malformed and oversized input is refused, not truncated.",
            ),
            refused(
                "too_many_items",
                {"allowedMethodIds": [f"Method.M{index}" for index in range(129)]},
                "invalid_selection",
                "Too many method selections",
            ),
            refused(
                "expiry_in_the_past",
                {"allowedMethodIds": ["Tooling.GetTools"], "expiresAtMs": 1_999},
                "invalid_expiry",
                "Sharing expiry is invalid",
            ),
            refused(
                "expiry_exactly_now",
                {"allowedMethodIds": ["Tooling.GetTools"], "expiresAtMs": 2_000},
                "invalid_expiry",
                "Sharing expiry is invalid",
            ),
            refused(
                "expiry_beyond_the_window",
                {
                    "allowedMethodIds": ["Tooling.GetTools"],
                    "expiresAtMs": 2_000 + 366 * 24 * 60 * 60 * 1000 + 1,
                },
                "invalid_expiry",
                "Sharing expiry is invalid",
            ),
        ]
    }


# ---------------------------------------------------------------------------
# Execution policy
# ---------------------------------------------------------------------------


def execution_policy_section() -> dict[str, Any]:
    return {
        "defaults": {
            "maxRequestBytes": 256 * 1024,
            "timeoutMs": 30_000,
            "maxConcurrent": 10,
            "maxEventBytes": 64 * 1024,
            "maxTtlSeconds": 120,
            "serviceVersion": "1.0.0",
            "toolingProviderCapabilities": ["tool_discovery", "tool_execution"],
        },
        "methods": [
            {
                "name": "tooling_get_tools",
                "hostile": False,
                "methodId": "Tooling.GetTools",
                "expected": {
                    "methodId": "Tooling.GetTools",
                    "module": "Tooling",
                    "name": "GetTools",
                    "summary": "",
                    "busTopic": "Tooling.GetTools",
                    "exposure": "both",
                    "methodType": "unary",
                    "projectionMethodType": "use",
                    "inputSchemaId": "Tooling.GetTools.input.ToolingGetToolsRequest",
                    "outputSchemaId": "Tooling.GetTools.output.ToolingGetToolsResponse",
                    "requiredPermissions": ["Tooling.GetTools"],
                    "callableFeatureIds": ["catalog_discovery"],
                    "serviceCapabilities": ["tool_discovery", "tool_execution"],
                    "serviceVersion": "1.0.0",
                    "maxConcurrent": 10,
                    "maxRequestBytes": 262_144,
                    "timeoutMs": 30_000,
                },
            },
            {
                "name": "tooling_execute_tool",
                "hostile": False,
                "methodId": "Tooling.ExecuteTool",
                "expected": {
                    "methodId": "Tooling.ExecuteTool",
                    "module": "Tooling",
                    "name": "ExecuteTool",
                    "summary": "",
                    "busTopic": "Tooling.ExecuteTool",
                    "exposure": "both",
                    "methodType": "unary",
                    "projectionMethodType": "use",
                    "inputSchemaId": "Tooling.ExecuteTool.input.ToolingExecuteToolRequest",
                    "outputSchemaId": "Tooling.ExecuteTool.output.ToolingExecuteToolResponse",
                    "requiredPermissions": ["Tooling.ExecuteTool"],
                    "callableFeatureIds": ["execution"],
                    "serviceCapabilities": ["tool_discovery", "tool_execution"],
                    "serviceVersion": "1.0.0",
                    "maxConcurrent": 10,
                    "maxRequestBytes": 262_144,
                    "timeoutMs": 30_000,
                },
            },
            {
                "name": "non_tooling_method_advertises_no_provider_capabilities",
                "hostile": False,
                "methodId": "TTS.ListVoices",
                "expected": {
                    "methodId": "TTS.ListVoices",
                    "module": "TTS",
                    "name": "ListVoices",
                    "summary": "",
                    "busTopic": "TTS.ListVoices",
                    "exposure": "both",
                    "methodType": "unary",
                    "projectionMethodType": "use",
                    "inputSchemaId": "TTS.ListVoices.input.TTSListVoicesRequest",
                    "outputSchemaId": "TTS.ListVoices.output.TTSListVoicesResponse",
                    "requiredPermissions": ["TTS.use"],
                    "callableFeatureIds": ["speech_voice_discovery"],
                    "serviceCapabilities": [],
                    "serviceVersion": "1.0.0",
                    "maxConcurrent": 10,
                    "maxRequestBytes": 262_144,
                    "timeoutMs": 30_000,
                },
            },
        ],
        "blockedMethods": [
            {
                "name": "gateway_route_inspection",
                "hostile": True,
                "methodId": "Gateway.ExplainRoute",
                "expectedError": "gateway route inspection cannot be registered as a peer-host service",
                "note": "Route inspection would expose the node's internal routing to a remote peer.",
            },
            {
                "name": "wake_word_audio",
                "hostile": True,
                "methodId": "WakeWord.ProcessAudio",
                "expectedError": "continuous audio capture cannot be hosted across devices",
            },
            {
                "name": "transcription_audio",
                "hostile": True,
                "methodId": "Transcription.ProcessAudio",
                "expectedError": "continuous audio capture cannot be hosted across devices",
            },
        ],
        "events": [
            {
                "name": "tts_audio_chunk",
                "hostile": False,
                "topic": "TTS.AudioChunk",
                "expected": {
                    "topic": "TTS.AudioChunk",
                    "module": "TTS",
                    "name": "AudioChunk",
                    "outputSchemaId": "TTS.AudioChunk.event.TTSAudioChunkEvent",
                    "requiredPermissions": ["TTS.use"],
                    "maxTtlSeconds": 120,
                    "maxEventBytes": 65_536,
                    "orderedEventGroup": "tts_text_stream",
                },
            }
        ],
    }


# ---------------------------------------------------------------------------
# TTS audio chunk emission validator
# ---------------------------------------------------------------------------


def tts_chunk(
    *,
    stream_id: str = "stream-1",
    sequence: int = 0,
    source_sequence: int | None = 0,
    is_final: bool = False,
    audio_data: str = "AAAA",
    duration_ms: float = 20.0,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "stream_id": stream_id,
        "sequence": sequence,
        "source_sequence": source_sequence,
        "is_final": is_final,
        "audio_data": audio_data,
        "duration_ms": duration_ms,
    }
    if correlation_id is not None:
        payload["correlation_id"] = correlation_id
    return payload


def tts_emission_section() -> dict[str, Any]:
    final = tts_chunk(sequence=2, source_sequence=None, is_final=True, audio_data="", duration_ms=0)
    return {
        "cases": [
            {
                "name": "ordered_stream_to_final",
                "hostile": False,
                "correlationId": None,
                "events": [
                    {"payload": tts_chunk(sequence=0, source_sequence=0), "expectedError": None},
                    {"payload": tts_chunk(sequence=1, source_sequence=1), "expectedError": None},
                    {"payload": final, "expectedError": None},
                ],
            },
            {
                "name": "repeated_source_sequence_is_allowed",
                "hostile": False,
                "correlationId": None,
                "events": [
                    {"payload": tts_chunk(sequence=0, source_sequence=0), "expectedError": None},
                    {"payload": tts_chunk(sequence=1, source_sequence=0), "expectedError": None},
                ],
                "note": "Two audio chunks may come from one source segment.",
            },
            {
                "name": "sequence_gap",
                "hostile": True,
                "correlationId": None,
                "events": [
                    {"payload": tts_chunk(sequence=0, source_sequence=0), "expectedError": None},
                    {
                        "payload": tts_chunk(sequence=2, source_sequence=1),
                        "expectedError": "TTS audio event sequence is not monotonic",
                    },
                ],
            },
            {
                "name": "replayed_sequence",
                "hostile": True,
                "correlationId": None,
                "events": [
                    {"payload": tts_chunk(sequence=0, source_sequence=0), "expectedError": None},
                    {
                        "payload": tts_chunk(sequence=0, source_sequence=0),
                        "expectedError": "TTS audio event sequence is not monotonic",
                    },
                ],
            },
            {
                "name": "emission_after_the_final_marker",
                "hostile": True,
                "correlationId": None,
                "events": [
                    {"payload": tts_chunk(sequence=0, source_sequence=0), "expectedError": None},
                    {
                        "payload": tts_chunk(
                            sequence=1,
                            source_sequence=None,
                            is_final=True,
                            audio_data="",
                            duration_ms=0,
                        ),
                        "expectedError": None,
                    },
                    {
                        "payload": tts_chunk(sequence=2, source_sequence=1),
                        "expectedError": "TTS audio event sequence is not monotonic",
                    },
                ],
                "note": "A closed stream cannot be reopened by the provider.",
            },
            {
                "name": "source_sequence_skips",
                "hostile": True,
                "correlationId": None,
                "events": [
                    {"payload": tts_chunk(sequence=0, source_sequence=0), "expectedError": None},
                    {
                        "payload": tts_chunk(sequence=1, source_sequence=2),
                        "expectedError": "TTS audio event source sequence is not ordered",
                    },
                ],
            },
            {
                "name": "first_source_sequence_must_be_zero",
                "hostile": True,
                "correlationId": None,
                "events": [
                    {
                        "payload": tts_chunk(sequence=0, source_sequence=1),
                        "expectedError": "TTS audio event source sequence is not ordered",
                    }
                ],
            },
            {
                "name": "non_final_chunk_without_a_source_sequence",
                "hostile": True,
                "correlationId": None,
                "events": [
                    {
                        "payload": tts_chunk(sequence=0, source_sequence=None),
                        "expectedError": "TTS audio event source sequence is required",
                    }
                ],
            },
            {
                "name": "final_marker_carrying_audio",
                "hostile": True,
                "correlationId": None,
                "events": [
                    {
                        "payload": tts_chunk(
                            sequence=0,
                            source_sequence=None,
                            is_final=True,
                            audio_data="AAAA",
                            duration_ms=0,
                        ),
                        "expectedError": "TTS audio event final marker is invalid",
                    }
                ],
            },
            {
                "name": "final_marker_with_a_duration",
                "hostile": True,
                "correlationId": None,
                "events": [
                    {
                        "payload": tts_chunk(
                            sequence=0,
                            source_sequence=None,
                            is_final=True,
                            audio_data="",
                            duration_ms=20.0,
                        ),
                        "expectedError": "TTS audio event final marker is invalid",
                    }
                ],
            },
            {
                "name": "correlation_mismatch",
                "hostile": True,
                "correlationId": "corr-1",
                "events": [
                    {
                        "payload": tts_chunk(
                            sequence=0, source_sequence=0, correlation_id="corr-2"
                        ),
                        "expectedError": "TTS audio event correlation does not match payload",
                    }
                ],
                "note": "A provider must not fan its stream into another caller's correlation.",
            },
            {
                "name": "correlation_match",
                "hostile": False,
                "correlationId": "corr-1",
                "events": [
                    {
                        "payload": tts_chunk(
                            sequence=0, source_sequence=0, correlation_id="corr-1"
                        ),
                        "expectedError": None,
                    }
                ],
            },
            {
                "name": "oversized_stream_id",
                "hostile": True,
                "correlationId": None,
                "events": [
                    {
                        "payload": tts_chunk(stream_id="s" * 257, sequence=0, source_sequence=0),
                        "expectedError": "TTS audio event stream_id is not a bounded identifier",
                    }
                ],
            },
            {
                "name": "empty_stream_id",
                "hostile": True,
                "correlationId": None,
                "events": [
                    {
                        "payload": tts_chunk(stream_id="", sequence=0, source_sequence=0),
                        "expectedError": "TTS audio event stream_id is not a bounded identifier",
                    }
                ],
            },
            {
                "name": "negative_sequence",
                "hostile": True,
                "correlationId": None,
                "events": [
                    {
                        "payload": tts_chunk(sequence=-1, source_sequence=0),
                        "expectedError": "TTS audio event sequence is invalid",
                    }
                ],
            },
            {
                "name": "fractional_sequence",
                "hostile": True,
                "correlationId": None,
                "events": [
                    {
                        "payload": {**tts_chunk(), "sequence": 0.5},
                        "expectedError": "TTS audio event sequence is invalid",
                    }
                ],
            },
            {
                "name": "boolean_is_final",
                "hostile": True,
                "correlationId": None,
                "events": [
                    {
                        "payload": {**tts_chunk(), "is_final": "yes"},
                        "expectedError": "TTS audio event terminal fields are invalid",
                    }
                ],
            },
            {
                "name": "fractional_source_sequence",
                "hostile": True,
                "correlationId": None,
                "events": [
                    {
                        "payload": {**tts_chunk(), "source_sequence": 1.5},
                        "expectedError": "TTS audio event source sequence is invalid",
                    }
                ],
            },
            {
                "name": "payload_is_not_an_object",
                "hostile": True,
                "correlationId": None,
                "events": [
                    {
                        "payload": "not-an-object",
                        "expectedError": "TTS audio event must be an object",
                    }
                ],
            },
        ]
    }


# ---------------------------------------------------------------------------


def build() -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "generated_by": "scripts/generate_mesh_authority_fixtures.py",
        "synthetic": True,
        "note": (
            "Shared parity corpus for the mesh authority. Consumed by "
            "rust/crates/aurora-mesh-authority/tests/parity_corpus.rs and "
            "packages/aurora-sdk/tests/mesh-authority-parity-vectors.test.ts. "
            "No real credentials: every token, room and peer id here is synthetic."
        ),
        "constants": {
            "reasonCodes": [
                "handler_failed",
                "lease_expired",
                "peer_authority_revoked",
                "request_cancelled",
                "request_timeout",
                "schema_validation_failed",
            ],
            "errorCodes": {
                "schemaValidationFailed": 400,
                "notAuthorized": 403,
                "requestCancelled": 499,
                "handlerFailed": 500,
                "requestTimeout": 504,
            },
            "authorityDecisionReasons": [
                "capability_not_granted",
                "credential_expired",
                "credential_not_found",
                "credential_revoked",
                "grant_expired",
                "grant_not_found",
                "grant_revoked",
                "grant_store_unreadable",
                "method_not_granted",
                "resource_not_granted",
                "tool_not_granted",
            ],
            "challengeStatuses": [
                "accepted",
                "expired",
                "not_found",
                "rejected",
                "replay",
                "selector_mismatch",
                "transport_mismatch",
            ],
            "grantManagementErrorCodes": [
                "invalid_expiry",
                "invalid_selection",
                "invalid_selector",
                "repository_unavailable",
                "secure_random_unavailable",
            ],
            "challengeTtlMs": CHALLENGE_TTL_MS,
            "maxExpiryWindowMs": 366 * 24 * 60 * 60 * 1000,
            "reconnectDomain": RECONNECT_DOMAIN.decode("utf-8"),
        },
        "reconnectProof": reconnect_proof_section(),
        "grantResolution": grant_resolution_section(),
        "sessionAuthorize": session_authorize_section(),
        "authorityAuthorize": authority_authorize_section(),
        "manifestSnapshot": manifest_snapshot_section(),
        "reconnectChallenge": reconnect_challenge_section(),
        "grantSelection": grant_selection_section(),
        "executionPolicy": execution_policy_section(),
        "ttsEmission": tts_emission_section(),
    }


def main() -> None:
    document = build()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    hostile = 0
    for section in document.values():
        if not isinstance(section, dict):
            continue
        for group in section.values():
            if isinstance(group, list):
                hostile += sum(
                    1 for case in group if isinstance(case, dict) and case.get("hostile")
                )
    print(f"wrote {OUTPUT} ({hostile} hostile cases)")


if __name__ == "__main__":
    main()

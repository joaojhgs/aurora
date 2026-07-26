#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

SECRET_PATTERNS = {
    "bearer_or_token_assignment": re.compile(
        r"(?i)(bearer\s+[a-z0-9._~+/=-]{12,}|(token|secret|password|roomSecret|room_secret)\s*[=:]\s*['\"]?[a-z0-9._~+/=-]{12,})"
    ),
    "raw_sdp": re.compile(r"(?im)^v=0\r?$|a=fingerprint:|a=ice-ufrag:|a=ice-pwd:"),
    "raw_ice_candidate": re.compile(
        r"candidate:[0-9a-zA-Z]+\s+\d+\s+(udp|tcp)\s+\d+\s+\S+\s+\d+\s+typ\s+(host|srflx|prflx|relay)"
    ),
    "raw_audio_hint": re.compile(r"(?i)(audio/(wav|mpeg|ogg)|base64audio|raw_audio|pcm16)"),
}


def load(path: Path) -> Any:
    return json.loads(path.read_text()) if path.exists() else {}


def scan_files(root: Path) -> dict[str, Any]:
    findings = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix not in {".json", ".log", ".txt"}:
            continue
        text = path.read_text(errors="ignore")
        for name, pattern in SECRET_PATTERNS.items():
            if pattern.search(text):
                findings.append({"file": str(path), "pattern": name})
    return {
        "passed": not findings,
        "findings": findings,
        "scannedFileCount": sum(
            1 for p in root.rglob("*") if p.is_file() and p.suffix in {".json", ".log", ".txt"}
        ),
    }


def candidate_pair_matches_lane(lane: str, selected_pair: dict[str, Any]) -> tuple[bool, str]:
    """Validate selected ICE-pair evidence without rewriting the reported category."""
    if selected_pair.get("selected") is not True:
        return False, "no-selected-candidate-pair"

    category = selected_pair.get("category") or "unknown"
    local_type = selected_pair.get("localCandidateType")
    remote_type = selected_pair.get("remoteCandidateType")
    candidate_types = {local_type, remote_type}
    stun_gather = selected_pair.get("stunServerReflexiveCandidate") or {}

    if lane == "direct":
        if category == "host":
            return True, "selected-host-pair"
        peer_reflexive_direct = (
            category == "prflx"
            and "prflx" in candidate_types
            and "host" in candidate_types
            and stun_gather.get("gathered") is not True
            and "relay" not in candidate_types
        )
        if peer_reflexive_direct:
            return True, "selected-peer-reflexive-host-pair-without-stun"
        return False, "direct-lane-requires-host-or-unassisted-peer-reflexive-host-pair"

    if lane == "stun":
        url_match = stun_gather.get("urlMatchesConfiguredStunServer")
        configured_server_proven = url_match is True
        single_configured_server_proven = (
            url_match is None and stun_gather.get("configuredStunServerCount") == 1
        )
        stun_gathered_via_configured_server = (
            stun_gather.get("gathered") is True
            and stun_gather.get("candidateType") == "srflx"
            and (configured_server_proven or single_configured_server_proven)
            and stun_gather.get("rawAddressRedacted") is True
        )
        selected_reflexive = bool(candidate_types & {"srflx", "prflx"})
        selected_srflx = category == "srflx" and "srflx" in candidate_types
        selected_prflx_with_stun_proof = (
            category == "prflx"
            and "prflx" in candidate_types
            and stun_gathered_via_configured_server
        )
        if selected_reflexive and (selected_srflx or selected_prflx_with_stun_proof):
            if single_configured_server_proven:
                return (
                    True,
                    "selected-reflexive-pair-with-single-configured-stun-browser-url-omitted",
                )
            return True, "selected-reflexive-pair-with-configured-stun-proof"
        return False, "stun-lane-requires-selected-reflexive-pair"

    if lane == "turn":
        if category == "relay" and "relay" in candidate_types:
            return True, "selected-relay-pair"
        return False, "turn-lane-requires-selected-relay-pair"
    return False, "unsupported-lane"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", required=True)
    parser.add_argument("--python-report", required=True)
    parser.add_argument("--browser-report", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--lane", required=True, choices=("direct", "stun", "turn"))
    args = parser.parse_args()
    artifact_dir = Path(args.artifact_dir)
    python_report = load(Path(args.python_report))
    browser_report = load(Path(args.browser_report))
    scan = scan_files(artifact_dir)
    br = browser_report.get("browserResult") or {}
    selected_pair = br.get("selectedCandidatePair") or {}
    ice = selected_pair.get("category") or "unknown"
    stun_gather = selected_pair.get("stunServerReflexiveCandidate") or {}
    path_ok, path_acceptance_reason = candidate_pair_matches_lane(args.lane, selected_pair)
    mutation = br.get("mutationEvidence") or {}
    reconnect = br.get("reconnectEvidence") or {}
    revocation = br.get("revocationEvidence") or {}
    scoped = br.get("scopedEventEvidence") or {}
    tts_event = br.get("ttsEvent")
    required_ok = (
        browser_report.get("status") == "passed"
        and scan["passed"]
        and path_ok
        and reconnect.get("authorizedWithoutSas") is True
        and mutation.get("executionCountAtMostOnce") is True
        and (mutation.get("uncertainLossWindow") or {}).get("startedAckBeforeDisconnect") is True
        and (mutation.get("uncertainLossWindow") or {}).get("disconnectBeforeResponseSettled")
        is True
        and revocation.get("routeAuthorizedAfterRevocation") is False
        and revocation.get("pendingPairingPrompts", 0) >= 1
        and scoped.get("wrongCorrelationDelivered") is False
        and scoped.get("wildcardDelivered") is False
        and (python_report.get("scopedEventEvidence") or {}).get("wildcardInterested") is False
        and bool(tts_event)
    )
    final = {
        "schema": "aurora.webrtc_interop.report.v1",
        "lane": args.lane,
        "status": "passed" if required_ok else "failed",
        "commands": {
            "lane": f"./scripts/webrtc_interop.sh {args.lane}",
            "docker": "docker compose -f docker-compose.webrtc-interop.yml up -d webrtc-interop-mqtt webrtc-interop-turn",
        },
        "laneIntent": args.lane,
        "pathCategory": ice,
        "pathCategoryAccepted": path_ok,
        "pathAcceptanceReason": path_acceptance_reason,
        "candidateProof": {
            "laneIntent": args.lane,
            "selectedPairCategory": ice,
            "selectedPairAcceptedForLane": path_ok,
            "acceptanceReason": path_acceptance_reason,
            "stunServerReflexiveCandidateGathered": stun_gather.get("gathered") is True,
            "stunServerReflexiveCandidateMatchesConfiguredServer": stun_gather.get(
                "urlMatchesConfiguredStunServer"
            ),
            "configuredStunServerCount": stun_gather.get("configuredStunServerCount"),
            "configuredStunServerEvidence": (
                "candidate-url-match"
                if stun_gather.get("urlMatchesConfiguredStunServer") is True
                else (
                    "single-configured-server-browser-url-omitted"
                    if stun_gather.get("urlMatchesConfiguredStunServer") is None
                    and stun_gather.get("configuredStunServerCount") == 1
                    else "unproven"
                )
            ),
            "statsSource": selected_pair.get("statsSource"),
            "rawAddressRedacted": selected_pair.get("rawAddressRedacted") is True,
        },
        "selectedCandidatePair": selected_pair,
        "iceCandidatePolicy": br.get("iceCandidatePolicy"),
        "httpDisabledProof": {
            "gatewayApiEnabled": python_report.get("gatewayHttpApiEnabled"),
            "gatewayHttpReachable": python_report.get("gatewayHttpReachable"),
            "browserHttpFetchCalls": (browser_report.get("browserResult") or {}).get(
                "httpFetchCalls", []
            ),
            "noHttpFetchTransportUsed": browser_report.get("noHttpFetchTransportUsed"),
        },
        "timings": {
            "pythonDurationMs": python_report.get("durationMs"),
            "browserDurationMs": browser_report.get("durationMs"),
        },
        "assertions": {
            "rtcStarted": python_report.get("rtcStarted"),
            "authorizedPeerCount": python_report.get("authenticatedPeerCount"),
            "registryReadOverDataChannel": (browser_report.get("browserResult") or {}).get(
                "registryModuleCount", 0
            )
            > 0,
            "eventOverDataChannel": bool(br.get("event")),
            "eventSentByPython": python_report.get("eventSent"),
            "ttsEventOverDataChannel": bool(tts_event),
            "ttsEventSentByPython": python_report.get("ttsEventSent"),
            "reconnectWithoutSas": reconnect.get("authorizedWithoutSas"),
            "revokedCredentialFailsClosed": revocation.get("routeAuthorizedAfterRevocation")
            is False
            and revocation.get("pendingPairingPrompts", 0) >= 1,
            "mutationAtMostOnce": mutation.get("executionCountAtMostOnce"),
            "mutationUncertainLossWindow": (mutation.get("uncertainLossWindow") or {}).get(
                "disconnectBeforeResponseSettled"
            ),
            "wrongCorrelationDelivered": scoped.get("wrongCorrelationDelivered"),
            "wildcardDelivered": scoped.get("wildcardDelivered"),
            "wildcardInterestedByPython": (python_report.get("scopedEventEvidence") or {}).get(
                "wildcardInterested"
            ),
        },
        "reconnectEvidence": reconnect,
        "revocationEvidence": revocation,
        "mutationEvidence": mutation,
        "scopedEventEvidence": {**scoped, "python": python_report.get("scopedEventEvidence")},
        "hostileCaseEvidence": {
            "live": br.get("hostileCaseEvidence"),
            "unitVectorTests": [
                "tests/unit/gateway/test_webrtc_web_thin_protocol_vectors.py",
                "tests/unit/gateway/test_webrtc_scoped_subscriptions_integration.py",
            ],
        },
        "redaction": scan,
        "pythonReport": str(Path(args.python_report)),
        "browserReport": str(Path(args.browser_report)),
        "secretsRedacted": scan["passed"],
    }
    Path(args.out).write_text(json.dumps(final, indent=2, sort_keys=True) + "\n")
    return 0 if final["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

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


def build_interop_report(
    *,
    lane: str,
    artifact_dir: Path,
    python_report: dict[str, Any],
    browser_report: dict[str, Any],
    python_report_path: Path,
    browser_report_path: Path,
) -> dict[str, Any]:
    """Build the aggregate report and enforce every release-gating proof."""
    scan = scan_files(artifact_dir)
    br = browser_report.get("browserResult") or {}
    selected_pair = br.get("selectedCandidatePair") or {}
    ice = selected_pair.get("category") or "unknown"
    stun_gather = selected_pair.get("stunServerReflexiveCandidate") or {}
    path_ok, path_acceptance_reason = candidate_pair_matches_lane(lane, selected_pair)
    mutation = br.get("mutationEvidence") or {}
    reconnect = br.get("reconnectEvidence") or {}
    revocation = br.get("revocationEvidence") or {}
    scoped = br.get("scopedEventEvidence") or {}
    tts_event = br.get("ttsEvent")
    browser_fetch_calls = br.get("httpFetchCalls")
    manifest = br.get("manifestEvidence") or {}
    error_evidence = br.get("errorEvidence") or {}
    large_rpc = br.get("largeRpcEvidence") or {}
    rpc_stream = br.get("rpcStreamEvidence") or {}
    python_large_records = python_report.get("largeRpcRecords") or []
    python_large = python_large_records[-1] if python_large_records else {}
    python_stream_records = python_report.get("streamRecords") or {}
    completed_stream = python_stream_records.get(f"g009-stream-complete-{lane}") or {}
    cancelled_stream = python_stream_records.get(f"g009-stream-cancel-{lane}") or {}
    expected_negotiation_role = "offerer" if lane in {"direct", "turn"} else "answerer"
    manifest_ok = (
        python_report.get("manifestSent") is True
        and manifest.get("peerId") == "python-gateway-g009"
        and manifest.get("serviceCount", 0) > 0
        and manifest.get("methodCount", 0) > 0
    )
    error_ok = (
        error_evidence.get("rejected") is True
        and error_evidence.get("code") == "unknown"
        and "intentional interop rpc failure" in str(error_evidence.get("message") or "").lower()
    )
    large_rpc_ok = (
        large_rpc.get("requestBytes") == 512 * 1024
        and large_rpc.get("resultBytes") == 512 * 1024
        and large_rpc.get("requestSha256") == python_large.get("request_sha256")
        and large_rpc.get("resultSha256") == large_rpc.get("expectedResultSha256")
        and large_rpc.get("resultSha256") == python_large.get("result_sha256")
        and python_large.get("request_bytes") == 512 * 1024
        and python_large.get("result_bytes") == 512 * 1024
        and large_rpc.get("sentFragmentCount", 0) > 1
        and large_rpc.get("receivedFragmentCount", 0) > 1
    )
    completed_chunks = rpc_stream.get("completedChunks") or []
    stream_ok = (
        len(completed_chunks) == 2
        and completed_stream.get("started") is True
        and completed_stream.get("completed") is True
        and completed_stream.get("cancelled") is False
        and completed_stream.get("chunk_count") == 2
        and bool(rpc_stream.get("cancelledFirstChunk"))
        and bool(rpc_stream.get("cancelledClientError"))
        and cancelled_stream.get("started") is True
        and cancelled_stream.get("completed") is False
        and cancelled_stream.get("cancelled") is True
        and cancelled_stream.get("chunk_count") == 1
        and rpc_stream.get("pythonStatus") == cancelled_stream
    )
    negotiation_ok = br.get("negotiationRole") == expected_negotiation_role
    no_http_transport = (
        browser_report.get("noHttpFetchTransportUsed") is True
        and br.get("noHttpFetchTransportUsed") is True
        and browser_fetch_calls == []
    )
    http_disabled = (
        python_report.get("gatewayHttpApiEnabled") is False
        and python_report.get("gatewayHttpReachable") is False
    )
    authorized_peer_count_after_revocation = python_report.get("authenticatedPeerCount")
    required_ok = (
        browser_report.get("status") == "passed"
        and scan["passed"]
        and path_ok
        and http_disabled
        and no_http_transport
        and negotiation_ok
        and manifest_ok
        and error_ok
        and large_rpc_ok
        and stream_ok
        and reconnect.get("authorizedWithoutSas") is True
        and mutation.get("executionCountAtMostOnce") is True
        and (mutation.get("uncertainLossWindow") or {}).get("startedAckBeforeDisconnect") is True
        and (mutation.get("uncertainLossWindow") or {}).get("disconnectBeforeResponseSettled")
        is True
        and revocation.get("routeAuthorizedAfterRevocation") is False
        and revocation.get("pendingPairingPrompts", 0) >= 1
        and authorized_peer_count_after_revocation == 0
        and scoped.get("wrongCorrelationDelivered") is False
        and scoped.get("wildcardDelivered") is False
        and (python_report.get("scopedEventEvidence") or {}).get("wildcardInterested") is False
        and bool(tts_event)
    )
    final = {
        "schema": "aurora.webrtc_interop.report.v1",
        "lane": lane,
        "status": "passed" if required_ok else "failed",
        "commands": {
            "lane": f"./scripts/webrtc_interop.sh {lane}",
            "docker": "docker compose -f docker-compose.webrtc-interop.yml up -d webrtc-interop-mqtt webrtc-interop-turn",
        },
        "laneIntent": lane,
        "pathCategory": ice,
        "pathCategoryAccepted": path_ok,
        "pathAcceptanceReason": path_acceptance_reason,
        "candidateProof": {
            "laneIntent": lane,
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
            "browserHttpFetchCalls": browser_fetch_calls,
            "noHttpFetchTransportUsed": browser_report.get("noHttpFetchTransportUsed"),
            "requiredEvidencePassed": http_disabled and no_http_transport,
        },
        "protocolInteropEvidence": {
            "expectedNegotiationRole": expected_negotiation_role,
            "observedNegotiationRole": br.get("negotiationRole"),
            "negotiationDirectionPassed": negotiation_ok,
            "manifest": manifest,
            "manifestPassed": manifest_ok,
            "error": error_evidence,
            "errorPassed": error_ok,
            "largeRpc": large_rpc,
            "pythonLargeRpc": python_large,
            "largeRpcPassed": large_rpc_ok,
            "rpcStream": rpc_stream,
            "pythonCompletedStream": completed_stream,
            "pythonCancelledStream": cancelled_stream,
            "rpcStreamPassed": stream_ok,
        },
        "timings": {
            "pythonDurationMs": python_report.get("durationMs"),
            "browserDurationMs": browser_report.get("durationMs"),
        },
        "assertions": {
            "rtcStarted": python_report.get("rtcStarted"),
            "authorizedPeerCountAfterRevocation": authorized_peer_count_after_revocation,
            "registryReadOverDataChannel": (browser_report.get("browserResult") or {}).get(
                "registryModuleCount", 0
            )
            > 0,
            "negotiationDirection": negotiation_ok,
            "manifestExchange": manifest_ok,
            "errorParity": error_ok,
            "fragmented512KiBRpc": large_rpc_ok,
            "streamCompletionAndCancel": stream_ok,
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
        "pythonReport": str(python_report_path),
        "browserReport": str(browser_report_path),
        "secretsRedacted": scan["passed"],
    }
    return final


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", required=True)
    parser.add_argument("--python-report", required=True)
    parser.add_argument("--browser-report", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--lane", required=True, choices=("direct", "stun", "turn"))
    args = parser.parse_args()
    artifact_dir = Path(args.artifact_dir)
    python_report_path = Path(args.python_report)
    browser_report_path = Path(args.browser_report)
    final = build_interop_report(
        lane=args.lane,
        artifact_dir=artifact_dir,
        python_report=load(python_report_path),
        browser_report=load(browser_report_path),
        python_report_path=python_report_path,
        browser_report_path=browser_report_path,
    )
    Path(args.out).write_text(json.dumps(final, indent=2, sort_keys=True) + "\n")
    return 0 if final["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

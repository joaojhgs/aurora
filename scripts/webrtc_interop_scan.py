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

PEER_SESSION_STATES = {
    "idle",
    "deriving-keys",
    "signaling-connecting",
    "discovering-peer",
    "negotiating",
    "channel-open",
    "pairing-required",
    "reconnect-authenticating",
    "awaiting-sas-confirmation",
    "authorized",
    "reconnecting",
    "closed",
    "failed",
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


def ac18_local_tool_provider_passed(
    python_report: dict[str, Any],
    browser_result: dict[str, Any],
) -> tuple[bool, dict[str, Any]]:
    """Validate live Python->browser local Tooling evidence when AC18 is enabled."""

    enabled = python_report.get("ac18LocalToolProviderEnabled") is True
    python_evidence = python_report.get("ac18ReverseToolEvidence") or {}
    browser_evidence = browser_result.get("ac18LocalToolProviderEvidence") or {}
    if not enabled:
        return True, {
            "enabled": False,
            "applicable": False,
            "status": "not_applicable",
            "requiredEvidencePassed": False,
            "python": python_evidence,
            "browser": browser_evidence,
        }

    expected_methods = [
        "Tooling.GetTools",
        "Tooling.PrepareExecution",
        "Tooling.ExecuteTool",
        "Tooling.ExecuteTool",
    ]
    expected_tool_contract_id = "interop.browser.echo"
    expected_local_name = "interop.browser.echo"
    expected_global_tool_id = "aurora-tool:v1:browser-g009:Tooling:interop.browser.echo"
    expected_service_instance_id = "local:browser-g009:Tooling"
    expected_provider_peer_id = "browser-g009"
    expected_caller_peer_id = "python-gateway-g009"
    forged_frame_peer_id = "forged-ac18-frame-peer"

    def is_hex64(value: Any) -> bool:
        return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None

    python_response = python_evidence.get("toolResponse") or {}
    python_negative = python_evidence.get("negativeProbe") or {}
    discovery = python_evidence.get("discoveryProbe") or {}
    prepare = python_evidence.get("prepareProbe") or {}
    execute = python_evidence.get("executeProbe") or {}
    discovered_tool = discovery.get("discoveredTool") or {}
    browser_digest = browser_evidence.get("toolResponseDataDigest")
    python_digest = python_evidence.get("toolResponseDataDigest")
    provider_lease = python_evidence.get("providerLease") or {}
    public_sequence_ok = python_evidence.get(
        "publicCallMethods"
    ) == expected_methods and python_evidence.get("publicCallCount") == len(expected_methods)
    readiness_ok = (
        python_evidence.get("peerStatus") == "negotiated"
        and python_evidence.get("toolingServiceAdvertised") is True
        and python_evidence.get("manifestAckAndLeaseReady") is True
        and provider_lease.get("available") is True
        and provider_lease.get("leaseRequired") is True
        and isinstance(provider_lease.get("connectionEpoch"), str)
        and bool(provider_lease["connectionEpoch"])
        and isinstance(provider_lease.get("availabilityRevision"), int)
    )
    discovery_ok = (
        discovery.get("method") == "Tooling.GetTools"
        and discovery.get("peerBridgeCallPath") == "PeerBridge.call"
        and discovery.get("request") == {"query": expected_local_name, "top_k": 10}
        and discovery.get("queryResultOk") is True
        and discovery.get("toolFound") is True
        and discovered_tool.get("tool_contract_id") == expected_tool_contract_id
        and discovered_tool.get("local_name") == expected_local_name
        and discovered_tool.get("name") == expected_local_name
        and discovered_tool.get("global_tool_id") == expected_global_tool_id
        and discovered_tool.get("provider_peer_id") == expected_provider_peer_id
        and discovered_tool.get("provider_service_instance_id") == expected_service_instance_id
    )
    args_schema_hash = prepare.get("argsSchemaHash")
    prepare_ok = (
        prepare.get("method") == "Tooling.PrepareExecution"
        and prepare.get("peerBridgeCallPath") == "PeerBridge.call"
        and prepare.get("queryResultOk") is True
        and prepare.get("policyAllowed") is True
        and is_hex64(args_schema_hash)
        and prepare.get("schemaHashBoundToExecution") is True
        and prepare.get("globalToolId") == expected_global_tool_id
        and prepare.get("providerServiceInstanceId") == expected_service_instance_id
        and (prepare.get("request") or {}).get("tool_name") == expected_global_tool_id
        and "expected_args_schema_hash" not in (prepare.get("request") or {})
    )
    execute_ok = (
        execute.get("method") == "Tooling.ExecuteTool"
        and execute.get("peerBridgeCallPath") == "PeerBridge.call"
        and execute.get("queryResultOk") is True
        and execute.get("expectedArgsSchemaHash") == args_schema_hash
        and (execute.get("request") or {}).get("expected_args_schema_hash") == args_schema_hash
        and (execute.get("request") or {}).get("tool_name") == expected_global_tool_id
        and execute.get("globalToolIdMatchedDiscovery") is True
    )
    positive_ok = (
        python_evidence.get("status") == "passed"
        and python_evidence.get("peerBridgeCallPath") == "PeerBridge.call"
        and python_evidence.get("privateRpcCallUsed") is False
        and python_evidence.get("manualAckUsed") is False
        and python_evidence.get("directServiceCallUsed") is False
        and python_evidence.get("httpFallbackUsed") is False
        and python_evidence.get("queryResultOk") is True
        and python_response.get("ok") is True
        and python_response.get("status") == "success"
        and python_response.get("global_tool_id") == expected_global_tool_id
        and (python_response.get("data") or {}).get("caller_peer_id") == expected_caller_peer_id
        and (python_response.get("data") or {}).get("handled_by") == expected_provider_peer_id
    )
    browser_global_tool_id = browser_evidence.get("globalToolId")
    browser_lease = browser_evidence.get("providerLeaseAtInvocation") or {}
    invocation_records = browser_evidence.get("invocationRecords") or []
    positive_invocation = next(
        (
            record
            for record in invocation_records
            if isinstance(record, dict)
            and record.get("probe_id") == browser_evidence.get("probeId")
        ),
        {},
    )
    registered_tool_ok = (
        browser_evidence.get("toolContractId") == expected_tool_contract_id
        and browser_evidence.get("localName") == expected_local_name
        and browser_global_tool_id == expected_global_tool_id
        and browser_evidence.get("providerServiceInstanceId") == expected_service_instance_id
        and is_hex64(browser_evidence.get("schemaHash"))
    )
    invocation_lease_ok = (
        browser_lease.get("available") is True
        and isinstance(browser_lease.get("connection_epoch"), str)
        and bool(browser_lease["connection_epoch"])
        and isinstance(browser_lease.get("availability_revision"), int)
        and positive_invocation.get("provider_lease") == browser_lease
    )
    browser_ok = (
        browser_evidence.get("enabled") is True
        and browser_evidence.get("authorityImplementation") in {"rust-wasm", "rust-native-tauri"}
        and registered_tool_ok
        and browser_evidence.get("positiveInvocationCount") == 1
        and browser_evidence.get("negativeInvocationCount") == 0
        and browser_evidence.get("failClosedWithoutNegativeInvocation") is True
        and positive_invocation.get("caller_peer_id") == expected_caller_peer_id
        and positive_invocation.get("method_id") == "Tooling.ExecuteTool"
        and isinstance(positive_invocation.get("permission_count"), int)
        and positive_invocation["permission_count"] > 0
        and invocation_lease_ok
        and is_hex64(browser_digest)
    )
    negative_ok = (
        python_negative.get("method") == "Tooling.ExecuteTool"
        and python_negative.get("peerBridgeCallPath") == "PeerBridge.call"
        and python_negative.get("queryResultOk") is True
        and python_negative.get("failClosedWithoutHandler") is True
        and (python_negative.get("toolResponse") or {}).get("ok") is False
        and (python_negative.get("toolResponse") or {}).get("status") == "not_found"
        and (python_negative.get("toolResponse") or {}).get("error_code") == "tool_not_found"
    )
    python_identity = python_evidence.get("identityOverride") or {}
    browser_identity = browser_evidence.get("identityOverride") or {}
    identity_override_ok = (
        (python_evidence.get("frameIdentityClaim") or {}).get("callerPeerId")
        == forged_frame_peer_id
        and (python_evidence.get("frameIdentityClaim") or {}).get("effectivePermissions") == []
        and python_identity.get("forgedFrameCallerPeerId") == forged_frame_peer_id
        and python_identity.get("forgedFrameEffectivePermissions") == []
        and python_identity.get("observedCallerPeerId") == expected_caller_peer_id
        and python_identity.get("frameCallerPeerIdOverridden") is True
        and browser_identity.get("forgedFrameCallerPeerId") == forged_frame_peer_id
        and browser_identity.get("forgedFrameEffectivePermissions") == []
        and browser_identity.get("observedCallerPeerId") == expected_caller_peer_id
        and browser_identity.get("frameCallerPeerIdOverridden") is True
        and browser_identity.get("framePermissionsOverridden") is True
    )
    audit_records = browser_evidence.get("auditRecords") or []

    def has_audit(action: str, result: str, method: str, correlation_id: str) -> bool:
        return any(
            isinstance(record, dict)
            and record.get("action") == action
            and record.get("result") == result
            and record.get("method_id") == method
            and record.get("correlation_id") == correlation_id
            and record.get("caller_peer_id") == expected_caller_peer_id
            and record.get("provider_peer_id") == expected_provider_peer_id
            and record.get("provider_service_instance_id") == expected_service_instance_id
            and record.get("connection_epoch") == browser_lease.get("connection_epoch")
            and record.get("redacted") is True
            and record.get("secrets_redacted") is True
            for record in audit_records
        )

    probe_id = browser_evidence.get("probeId")
    audit_ok = (
        isinstance(probe_id, str)
        and has_audit("prepare", "allowed", "Tooling.PrepareExecution", probe_id)
        and has_audit("execute", "success", "Tooling.ExecuteTool", probe_id)
        and has_audit(
            "execute",
            "not_found",
            "Tooling.ExecuteTool",
            f"{probe_id}-negative",
        )
    )
    digest_ok = is_hex64(python_digest) and python_digest == browser_digest
    passed = (
        public_sequence_ok
        and readiness_ok
        and discovery_ok
        and prepare_ok
        and execute_ok
        and positive_ok
        and browser_ok
        and negative_ok
        and identity_override_ok
        and audit_ok
        and digest_ok
    )
    return passed, {
        "enabled": True,
        "requiredEvidencePassed": passed,
        "publicSequencePassed": public_sequence_ok,
        "readinessPassed": readiness_ok,
        "discoveryPassed": discovery_ok,
        "preparePassed": prepare_ok,
        "executePassed": execute_ok,
        "positiveCallPassed": positive_ok,
        "registeredToolPassed": registered_tool_ok,
        "browserInvocationPassed": browser_ok,
        "invocationLeasePassed": invocation_lease_ok,
        "negativeFailClosedPassed": negative_ok,
        "identityOverridePassed": identity_override_ok,
        "auditPassed": audit_ok,
        "digestMatched": digest_ok,
        "python": python_evidence,
        "browser": browser_evidence,
    }


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
    ac18_ok, ac18_evidence = ac18_local_tool_provider_passed(python_report, br)
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
    connected_peer_count_after_revocation = python_report.get("connectedPeerCount")
    revocation_final_state = revocation.get("finalState")
    browser_final_state_after_revocation = br.get("finalStateAfterRevocation")
    revocation_final_state_valid = (
        isinstance(revocation_final_state, str)
        and revocation_final_state in PEER_SESSION_STATES
        and isinstance(browser_final_state_after_revocation, str)
        and browser_final_state_after_revocation in PEER_SESSION_STATES
        and browser_final_state_after_revocation == revocation_final_state
    )
    revocation_observation = revocation.get("observation") or {}
    python_reconnect_evidence = python_report.get("reconnectEvidence") or {}
    proof_verification_results = python_reconnect_evidence.get("proofVerificationResults") or []
    revoked_proof_rejection_observed = (
        isinstance(proof_verification_results, list) and "revoked" in proof_verification_results
    )
    revocation_prompt_required = revocation_final_state == "awaiting-sas-confirmation"
    revocation_prompt_ok = (
        not revocation_prompt_required or revocation.get("pendingPairingPrompts", 0) >= 1
    )
    revocation_timeout_elapsed_ms = revocation_observation.get("elapsedMs")
    revocation_timeout_ms = revocation_observation.get("timeoutMs")
    revocation_bounded_timeout_ok = (
        isinstance(revocation_timeout_elapsed_ms, int | float)
        and not isinstance(revocation_timeout_elapsed_ms, bool)
        and isinstance(revocation_timeout_ms, int | float)
        and not isinstance(revocation_timeout_ms, bool)
        and revocation_observation.get("timedOut") is True
        and revocation_timeout_ms > 0
        and revocation_timeout_elapsed_ms >= revocation_timeout_ms
    )
    revocation_terminal_failure_ok = (
        revocation_final_state == "failed"
        and isinstance(revocation_timeout_elapsed_ms, int | float)
        and not isinstance(revocation_timeout_elapsed_ms, bool)
        and isinstance(revocation_timeout_ms, int | float)
        and not isinstance(revocation_timeout_ms, bool)
        and revocation_observation.get("timedOut") is False
        and revocation_timeout_ms > 0
        and 0 <= revocation_timeout_elapsed_ms <= revocation_timeout_ms
    )
    revocation_bounded_observation_ok = (
        revocation_bounded_timeout_ok or revocation_terminal_failure_ok
    )
    if revocation_final_state == "authorized":
        revocation_terminal_ok = False
    elif revocation_final_state == "failed":
        revocation_terminal_ok = revocation_terminal_failure_ok
    elif revocation_prompt_required:
        revocation_terminal_ok = revocation_prompt_ok
    else:
        revocation_terminal_ok = revocation_bounded_timeout_ok
    revoked_credential_fail_closed = (
        revocation.get("routeAuthorizedAfterRevocation") is False
        and revocation_final_state_valid
        and revocation_final_state != "authorized"
        and (br.get("hostileCaseEvidence") or {}).get("failClosedObserved") is True
        and authorized_peer_count_after_revocation == 0
        and connected_peer_count_after_revocation == 0
        and revoked_proof_rejection_observed
        and revocation_terminal_ok
    )
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
        and revoked_credential_fail_closed
        and scoped.get("wrongCorrelationDelivered") is False
        and scoped.get("wildcardDelivered") is False
        and (python_report.get("scopedEventEvidence") or {}).get("wildcardInterested") is False
        and bool(tts_event)
        and ac18_ok
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
        "ac18LocalToolProviderEvidence": ac18_evidence,
        "timings": {
            "pythonDurationMs": python_report.get("durationMs"),
            "browserDurationMs": browser_report.get("durationMs"),
        },
        "assertions": {
            "rtcStarted": python_report.get("rtcStarted"),
            "authorizedPeerCountAfterRevocation": authorized_peer_count_after_revocation,
            "connectedPeerCountAfterRevocation": connected_peer_count_after_revocation,
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
            "revokedCredentialFailsClosed": revoked_credential_fail_closed,
            "revokedCredentialPromptRequired": revocation_prompt_required,
            "revokedCredentialPromptObserved": revocation.get("pendingPairingPrompts", 0) >= 1,
            "revokedCredentialBoundedTimeout": revocation_bounded_timeout_ok,
            "revokedCredentialBoundedObservation": revocation_bounded_observation_ok,
            "revokedCredentialTerminalFailure": revocation_terminal_failure_ok,
            "revokedProofRejectionObserved": revoked_proof_rejection_observed,
            "revokedCredentialFinalStateMatched": revocation_final_state_valid,
            "mutationAtMostOnce": mutation.get("executionCountAtMostOnce"),
            "mutationUncertainLossWindow": (mutation.get("uncertainLossWindow") or {}).get(
                "disconnectBeforeResponseSettled"
            ),
            "wrongCorrelationDelivered": scoped.get("wrongCorrelationDelivered"),
            "wildcardDelivered": scoped.get("wildcardDelivered"),
            "wildcardInterestedByPython": (python_report.get("scopedEventEvidence") or {}).get(
                "wildcardInterested"
            ),
            "ac18LocalToolProvider": ac18_evidence["requiredEvidencePassed"],
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

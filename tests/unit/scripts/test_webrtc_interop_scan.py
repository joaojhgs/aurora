from pathlib import Path

import pytest

from scripts.webrtc_interop_scan import (
    build_interop_report,
    candidate_pair_matches_lane,
    scan_files,
)


def _pair(
    category: str,
    local_type: str,
    remote_type: str,
    *,
    selected: bool = True,
    stun_gather: dict[str, object] | None = None,
) -> dict[str, object]:
    pair: dict[str, object] = {
        "selected": selected,
        "category": category,
        "localCandidateType": local_type,
        "remoteCandidateType": remote_type,
    }
    if stun_gather is not None:
        pair["stunServerReflexiveCandidate"] = stun_gather
    return pair


def test_direct_lane_accepts_selected_host_pair() -> None:
    accepted, reason = candidate_pair_matches_lane("direct", _pair("host", "host", "host"))

    assert accepted is True
    assert reason == "selected-host-pair"


def test_direct_lane_accepts_truthful_peer_reflexive_host_pair_without_stun() -> None:
    accepted, reason = candidate_pair_matches_lane("direct", _pair("prflx", "prflx", "host"))

    assert accepted is True
    assert reason == "selected-peer-reflexive-host-pair-without-stun"


def test_direct_lane_rejects_peer_reflexive_pair_with_stun_gather_evidence() -> None:
    accepted, _ = candidate_pair_matches_lane(
        "direct",
        _pair(
            "prflx",
            "prflx",
            "host",
            stun_gather={"gathered": True, "candidateType": "srflx"},
        ),
    )

    assert accepted is False


def test_direct_lane_rejects_pair_without_host_candidate_evidence() -> None:
    accepted, _ = candidate_pair_matches_lane("direct", _pair("prflx", "prflx", "prflx"))

    assert accepted is False


def test_stun_lane_requires_configured_stun_proof_for_peer_reflexive_pair() -> None:
    accepted, _ = candidate_pair_matches_lane("stun", _pair("prflx", "prflx", "host"))
    proven, reason = candidate_pair_matches_lane(
        "stun",
        _pair(
            "prflx",
            "prflx",
            "host",
            stun_gather={
                "gathered": True,
                "candidateType": "srflx",
                "urlMatchesConfiguredStunServer": True,
                "rawAddressRedacted": True,
            },
        ),
    )

    assert accepted is False
    assert proven is True
    assert reason == "selected-reflexive-pair-with-configured-stun-proof"


def test_stun_lane_accepts_single_configured_server_when_browser_omits_candidate_url() -> None:
    proven, reason = candidate_pair_matches_lane(
        "stun",
        _pair(
            "prflx",
            "host",
            "prflx",
            stun_gather={
                "gathered": True,
                "candidateType": "srflx",
                "configuredStunServerCount": 1,
                "rawAddressRedacted": True,
            },
        ),
    )

    assert proven is True
    assert reason == "selected-reflexive-pair-with-single-configured-stun-browser-url-omitted"


@pytest.mark.parametrize(
    "stun_gather",
    [
        {
            "gathered": True,
            "candidateType": "srflx",
            "configuredStunServerCount": 2,
            "rawAddressRedacted": True,
        },
        {
            "gathered": True,
            "candidateType": "srflx",
            "configuredStunServerCount": 1,
            "urlMatchesConfiguredStunServer": False,
            "rawAddressRedacted": True,
        },
    ],
)
def test_stun_lane_rejects_ambiguous_or_mismatched_browser_url_evidence(
    stun_gather: dict[str, object],
) -> None:
    proven, _ = candidate_pair_matches_lane(
        "stun",
        _pair("prflx", "host", "prflx", stun_gather=stun_gather),
    )

    assert proven is False


def test_turn_lane_requires_selected_relay_pair() -> None:
    host_accepted, _ = candidate_pair_matches_lane("turn", _pair("host", "host", "host"))
    relay_accepted, reason = candidate_pair_matches_lane("turn", _pair("relay", "relay", "host"))

    assert host_accepted is False
    assert relay_accepted is True
    assert reason == "selected-relay-pair"


def test_lane_rejects_unselected_candidate_pair() -> None:
    accepted, reason = candidate_pair_matches_lane(
        "direct", _pair("host", "host", "host", selected=False)
    )

    assert accepted is False
    assert reason == "no-selected-candidate-pair"


def test_unknown_lane_is_rejected_without_turn_semantics() -> None:
    accepted, reason = candidate_pair_matches_lane("unknown", _pair("relay", "relay", "host"))

    assert accepted is False
    assert reason == "unsupported-lane"


@pytest.mark.parametrize("candidate_type", ["host", "srflx", "prflx", "relay"])
def test_scan_rejects_every_raw_ice_candidate_type(tmp_path, candidate_type: str) -> None:
    artifact = tmp_path / "browser.log"
    artifact.write_text(f"candidate:1 1 udp 2122260223 192.0.2.10 54321 typ {candidate_type}\n")

    result = scan_files(tmp_path)

    assert result["passed"] is False
    assert result["findings"] == [{"file": str(artifact), "pattern": "raw_ice_candidate"}]


def _passing_reports() -> tuple[dict[str, object], dict[str, object]]:
    request_sha256 = "request-sha256"
    result_sha256 = "result-sha256"
    python_report: dict[str, object] = {
        "authenticatedPeerCount": 0,
        "connectedPeerCount": 0,
        "gatewayHttpApiEnabled": False,
        "gatewayHttpReachable": False,
        "scopedEventEvidence": {"wildcardInterested": False},
        "reconnectEvidence": {
            "revokedReconnectFailuresObserved": 1,
            "proofVerificationResults": ["accepted", "revoked"],
        },
        "manifestSent": True,
        "largeRpcRecords": [
            {
                "request_bytes": 512 * 1024,
                "result_bytes": 512 * 1024,
                "request_sha256": request_sha256,
                "result_sha256": result_sha256,
            }
        ],
        "streamRecords": {
            "g009-stream-complete-direct": {
                "started": True,
                "completed": True,
                "cancelled": False,
                "chunk_count": 2,
            },
            "g009-stream-cancel-direct": {
                "started": True,
                "completed": False,
                "cancelled": True,
                "chunk_count": 1,
            },
        },
    }
    browser_result: dict[str, object] = {
        "negotiationRole": "offerer",
        "selectedCandidatePair": _pair("host", "host", "host"),
        "manifestEvidence": {
            "peerId": "python-gateway-g009",
            "serviceCount": 2,
            "methodCount": 4,
        },
        "errorEvidence": {
            "rejected": True,
            "code": "unknown",
            "message": "intentional interop RPC failure",
        },
        "largeRpcEvidence": {
            "requestBytes": 512 * 1024,
            "requestSha256": request_sha256,
            "resultBytes": 512 * 1024,
            "resultSha256": result_sha256,
            "expectedResultSha256": result_sha256,
            "sentFragmentCount": 33,
            "receivedFragmentCount": 33,
        },
        "rpcStreamEvidence": {
            "completedChunks": [{"delta": "first"}, {"delta": "second"}],
            "cancelledFirstChunk": {"delta": "first"},
            "cancelledClientError": "Aurora request timed out",
            "pythonStatus": {
                "started": True,
                "completed": False,
                "cancelled": True,
                "chunk_count": 1,
            },
        },
        "reconnectEvidence": {"authorizedWithoutSas": True},
        "mutationEvidence": {
            "executionCountAtMostOnce": True,
            "uncertainLossWindow": {
                "startedAckBeforeDisconnect": True,
                "disconnectBeforeResponseSettled": True,
            },
        },
        "revocationEvidence": {
            "finalState": "discovering-peer",
            "routeAuthorizedAfterRevocation": False,
            "pendingPairingPrompts": 0,
            "observation": {
                "elapsedMs": 30_000,
                "timeoutMs": 30_000,
                "timedOut": True,
            },
        },
        "finalStateAfterRevocation": "discovering-peer",
        "hostileCaseEvidence": {"failClosedObserved": True},
        "scopedEventEvidence": {
            "wrongCorrelationDelivered": False,
            "wildcardDelivered": False,
        },
        "ttsEvent": {"kind": "tts.chunk"},
        "httpFetchCalls": [],
        "noHttpFetchTransportUsed": True,
    }
    browser_report: dict[str, object] = {
        "status": "passed",
        "browserResult": browser_result,
        "noHttpFetchTransportUsed": True,
    }
    return python_report, browser_report


def _enable_ac18(
    python_report: dict[str, object],
    browser_report: dict[str, object],
    *,
    authority_implementation: str = "rust-wasm",
) -> None:
    digest = "a" * 64
    python_report["ac18LocalToolProviderEnabled"] = True
    python_report["ac18ReverseToolEvidence"] = {
        "enabled": True,
        "status": "passed",
        "peerBridgeCallPath": "PeerBridge.call",
        "publicCallMethods": [
            "Tooling.GetTools",
            "Tooling.PrepareExecution",
            "Tooling.ExecuteTool",
            "Tooling.ExecuteTool",
        ],
        "publicCallCount": 4,
        "privateRpcCallUsed": False,
        "manualAckUsed": False,
        "directServiceCallUsed": False,
        "httpFallbackUsed": False,
        "peerStatus": "negotiated",
        "toolingServiceAdvertised": True,
        "manifestAckAndLeaseReady": True,
        "queryResultOk": True,
        "providerLease": {
            "connectionEpoch": "epoch-1",
            "availabilityRevision": 1,
            "available": True,
            "leaseRequired": True,
        },
        "frameIdentityClaim": {
            "callerPeerId": "forged-ac18-frame-peer",
            "effectivePermissions": [],
        },
        "discoveryProbe": {
            "method": "Tooling.GetTools",
            "peerBridgeCallPath": "PeerBridge.call",
            "request": {"query": "interop.browser.echo", "top_k": 10},
            "queryResultOk": True,
            "toolFound": True,
            "discoveredTool": {
                "tool_contract_id": "interop.browser.echo",
                "local_name": "interop.browser.echo",
                "name": "interop.browser.echo",
                "global_tool_id": ("aurora-tool:v1:browser-g009:Tooling:interop.browser.echo"),
                "provider_peer_id": "browser-g009",
                "provider_service_instance_id": "local:browser-g009:Tooling",
            },
        },
        "prepareProbe": {
            "method": "Tooling.PrepareExecution",
            "peerBridgeCallPath": "PeerBridge.call",
            "request": {
                "tool_name": ("aurora-tool:v1:browser-g009:Tooling:interop.browser.echo"),
                "arguments": {
                    "probe_id": "ac18-browser-tool-direct",
                    "message": "python-originated-direct",
                },
            },
            "queryResultOk": True,
            "policyAllowed": True,
            "argsSchemaHash": digest,
            "schemaHashBoundToExecution": True,
            "globalToolId": ("aurora-tool:v1:browser-g009:Tooling:interop.browser.echo"),
            "providerServiceInstanceId": "local:browser-g009:Tooling",
        },
        "executeProbe": {
            "method": "Tooling.ExecuteTool",
            "peerBridgeCallPath": "PeerBridge.call",
            "request": {
                "tool_name": ("aurora-tool:v1:browser-g009:Tooling:interop.browser.echo"),
                "expected_args_schema_hash": digest,
            },
            "expectedArgsSchemaHash": digest,
            "queryResultOk": True,
            "globalToolIdMatchedDiscovery": True,
        },
        "toolResponse": {
            "ok": True,
            "status": "success",
            "global_tool_id": ("aurora-tool:v1:browser-g009:Tooling:interop.browser.echo"),
            "data": {
                "probe_id": "ac18-browser-tool-direct",
                "message": "python-originated-direct:browser-local",
                "handled_by": "browser-g009",
                "caller_peer_id": "python-gateway-g009",
            },
        },
        "toolResponseDataDigest": digest,
        "identityOverride": {
            "forgedFrameCallerPeerId": "forged-ac18-frame-peer",
            "forgedFrameEffectivePermissions": [],
            "observedCallerPeerId": "python-gateway-g009",
            "frameCallerPeerIdOverridden": True,
        },
        "negativeProbe": {
            "method": "Tooling.ExecuteTool",
            "peerBridgeCallPath": "PeerBridge.call",
            "queryResultOk": True,
            "failClosedWithoutHandler": True,
            "toolResponse": {
                "ok": False,
                "status": "not_found",
                "error_code": "tool_not_found",
            },
        },
    }
    browser_result = browser_report["browserResult"]
    assert isinstance(browser_result, dict)
    browser_result["ac18LocalToolProviderEvidence"] = {
        "enabled": True,
        "authorityImplementation": authority_implementation,
        "toolContractId": "interop.browser.echo",
        "localName": "interop.browser.echo",
        "globalToolId": ("aurora-tool:v1:browser-g009:Tooling:interop.browser.echo"),
        "providerServiceInstanceId": "local:browser-g009:Tooling",
        "schemaHash": digest,
        "probeId": "ac18-browser-tool-direct",
        "invocationRecords": [
            {
                "probe_id": "ac18-browser-tool-direct",
                "caller_peer_id": "python-gateway-g009",
                "method_id": "Tooling.ExecuteTool",
                "permission_count": 2,
                "provider_lease": {
                    "available": True,
                    "connection_epoch": "epoch-1",
                    "availability_revision": 1,
                },
            }
        ],
        "positiveInvocationCount": 1,
        "negativeInvocationCount": 0,
        "failClosedWithoutNegativeInvocation": True,
        "providerLeaseAtInvocation": {
            "available": True,
            "connection_epoch": "epoch-1",
            "availability_revision": 1,
        },
        "identityOverride": {
            "forgedFrameCallerPeerId": "forged-ac18-frame-peer",
            "forgedFrameEffectivePermissions": [],
            "observedCallerPeerId": "python-gateway-g009",
            "frameCallerPeerIdOverridden": True,
            "framePermissionsOverridden": True,
        },
        "toolResponseDataDigest": digest,
        "auditRecords": [
            {
                "action": "prepare",
                "result": "allowed",
                "method_id": "Tooling.PrepareExecution",
                "correlation_id": "ac18-browser-tool-direct",
                "caller_peer_id": "python-gateway-g009",
                "provider_peer_id": "browser-g009",
                "provider_service_instance_id": "local:browser-g009:Tooling",
                "connection_epoch": "epoch-1",
                "redacted": True,
                "secrets_redacted": True,
            },
            {
                "action": "execute",
                "result": "success",
                "method_id": "Tooling.ExecuteTool",
                "correlation_id": "ac18-browser-tool-direct",
                "caller_peer_id": "python-gateway-g009",
                "provider_peer_id": "browser-g009",
                "provider_service_instance_id": "local:browser-g009:Tooling",
                "connection_epoch": "epoch-1",
                "redacted": True,
                "secrets_redacted": True,
            },
            {
                "action": "execute",
                "result": "not_found",
                "method_id": "Tooling.ExecuteTool",
                "correlation_id": "ac18-browser-tool-direct-negative",
                "caller_peer_id": "python-gateway-g009",
                "provider_peer_id": "browser-g009",
                "provider_service_instance_id": "local:browser-g009:Tooling",
                "connection_epoch": "epoch-1",
                "redacted": True,
                "secrets_redacted": True,
            },
        ],
    }


def _aggregate(
    tmp_path: Path,
    python_report: dict[str, object],
    browser_report: dict[str, object],
) -> dict[str, object]:
    return build_interop_report(
        lane="direct",
        artifact_dir=tmp_path,
        python_report=python_report,
        browser_report=browser_report,
        python_report_path=tmp_path / "python.json",
        browser_report_path=tmp_path / "browser.json",
    )


def test_aggregate_accepts_complete_http_disabled_proof(tmp_path: Path) -> None:
    python_report, browser_report = _passing_reports()

    report = _aggregate(tmp_path, python_report, browser_report)

    assert report["status"] == "passed"
    assert report["httpDisabledProof"]["requiredEvidencePassed"] is True
    assert report["protocolInteropEvidence"]["negotiationDirectionPassed"] is True
    assert report["protocolInteropEvidence"]["manifestPassed"] is True
    assert report["protocolInteropEvidence"]["errorPassed"] is True
    assert report["protocolInteropEvidence"]["largeRpcPassed"] is True
    assert report["protocolInteropEvidence"]["rpcStreamPassed"] is True
    assert report["assertions"]["authorizedPeerCountAfterRevocation"] == 0
    assert report["assertions"]["connectedPeerCountAfterRevocation"] == 0
    assert report["assertions"]["revokedCredentialFailsClosed"] is True
    assert report["assertions"]["revokedCredentialPromptRequired"] is False
    assert report["assertions"]["revokedCredentialPromptObserved"] is False
    assert report["assertions"]["revokedCredentialBoundedTimeout"] is True
    assert report["assertions"]["revokedCredentialFinalStateMatched"] is True
    assert report["ac18LocalToolProviderEvidence"] == {
        "enabled": False,
        "applicable": False,
        "status": "not_applicable",
        "requiredEvidencePassed": False,
        "python": {},
        "browser": {},
    }
    assert report["assertions"]["ac18LocalToolProvider"] is False


@pytest.mark.parametrize(
    "authority_implementation",
    ["rust-wasm", "rust-native-tauri"],
)
def test_aggregate_accepts_complete_ac18_local_tool_provider_evidence(
    tmp_path: Path,
    authority_implementation: str,
) -> None:
    python_report, browser_report = _passing_reports()
    _enable_ac18(
        python_report,
        browser_report,
        authority_implementation=authority_implementation,
    )

    report = _aggregate(tmp_path, python_report, browser_report)

    assert report["status"] == "passed"
    assert report["ac18LocalToolProviderEvidence"]["enabled"] is True
    assert report["ac18LocalToolProviderEvidence"]["requiredEvidencePassed"] is True
    assert report["ac18LocalToolProviderEvidence"]["digestMatched"] is True
    assert report["assertions"]["ac18LocalToolProvider"] is True


def test_aggregate_accepts_awaiting_sas_with_post_revocation_prompt(tmp_path: Path) -> None:
    python_report, browser_report = _passing_reports()
    browser_result = browser_report["browserResult"]
    assert isinstance(browser_result, dict)
    revocation = browser_result["revocationEvidence"]
    assert isinstance(revocation, dict)
    revocation["finalState"] = "awaiting-sas-confirmation"
    revocation["pendingPairingPrompts"] = 1
    browser_result["finalStateAfterRevocation"] = "awaiting-sas-confirmation"

    report = _aggregate(tmp_path, python_report, browser_report)

    assert report["status"] == "passed"
    assert report["assertions"]["revokedCredentialPromptRequired"] is True
    assert report["assertions"]["revokedCredentialPromptObserved"] is True


def test_aggregate_accepts_terminal_revocation_failure_within_observation_bound(
    tmp_path: Path,
) -> None:
    python_report, browser_report = _passing_reports()
    python_report["reconnectEvidence"] = {
        "revokedReconnectFailuresObserved": 0,
        "proofVerificationResults": ["accepted", "revoked"],
    }
    browser_result = browser_report["browserResult"]
    assert isinstance(browser_result, dict)
    revocation = browser_result["revocationEvidence"]
    assert isinstance(revocation, dict)
    revocation["finalState"] = "failed"
    revocation["observation"] = {
        "elapsedMs": 703,
        "timeoutMs": 45_000,
        "timedOut": False,
    }
    browser_result["finalStateAfterRevocation"] = "failed"

    report = _aggregate(tmp_path, python_report, browser_report)

    assert report["status"] == "passed"
    assert report["assertions"]["revokedCredentialFailsClosed"] is True
    assert report["assertions"]["revokedCredentialBoundedTimeout"] is False
    assert report["assertions"]["revokedCredentialBoundedObservation"] is True
    assert report["assertions"]["revokedCredentialTerminalFailure"] is True
    assert report["assertions"]["revokedProofRejectionObserved"] is True


@pytest.mark.parametrize(
    "reconnect_evidence",
    [
        {},
        {"revokedReconnectFailuresObserved": 1, "proofVerificationResults": []},
        {"revokedReconnectFailuresObserved": 1, "proofVerificationResults": ["accepted"]},
    ],
)
def test_aggregate_rejects_terminal_failure_without_revoked_proof_evidence(
    tmp_path: Path,
    reconnect_evidence: dict[str, object],
) -> None:
    python_report, browser_report = _passing_reports()
    python_report["reconnectEvidence"] = reconnect_evidence
    browser_result = browser_report["browserResult"]
    assert isinstance(browser_result, dict)
    revocation = browser_result["revocationEvidence"]
    assert isinstance(revocation, dict)
    revocation["finalState"] = "failed"
    revocation["observation"] = {
        "elapsedMs": 703,
        "timeoutMs": 45_000,
        "timedOut": False,
    }
    browser_result["finalStateAfterRevocation"] = "failed"

    report = _aggregate(tmp_path, python_report, browser_report)

    assert report["status"] == "failed"
    assert report["assertions"]["revokedCredentialFailsClosed"] is False
    assert report["assertions"]["revokedProofRejectionObserved"] is False


def test_aggregate_rejects_awaiting_sas_without_post_revocation_prompt(tmp_path: Path) -> None:
    python_report, browser_report = _passing_reports()
    browser_result = browser_report["browserResult"]
    assert isinstance(browser_result, dict)
    revocation = browser_result["revocationEvidence"]
    assert isinstance(revocation, dict)
    revocation["finalState"] = "awaiting-sas-confirmation"
    revocation["pendingPairingPrompts"] = 0
    browser_result["finalStateAfterRevocation"] = "awaiting-sas-confirmation"

    report = _aggregate(tmp_path, python_report, browser_report)

    assert report["status"] == "failed"
    assert report["assertions"]["revokedCredentialFailsClosed"] is False


def test_aggregate_rejects_authorized_revocation_state(tmp_path: Path) -> None:
    python_report, browser_report = _passing_reports()
    browser_result = browser_report["browserResult"]
    assert isinstance(browser_result, dict)
    revocation = browser_result["revocationEvidence"]
    assert isinstance(revocation, dict)
    revocation["finalState"] = "authorized"
    revocation["routeAuthorizedAfterRevocation"] = True
    browser_result["finalStateAfterRevocation"] = "authorized"

    report = _aggregate(tmp_path, python_report, browser_report)

    assert report["status"] == "failed"
    assert report["assertions"]["revokedCredentialFailsClosed"] is False


@pytest.mark.parametrize("field", ["authenticatedPeerCount", "connectedPeerCount"])
def test_aggregate_rejects_nonzero_python_peer_counts_after_revocation(
    tmp_path: Path,
    field: str,
) -> None:
    python_report, browser_report = _passing_reports()
    python_report[field] = 1

    report = _aggregate(tmp_path, python_report, browser_report)

    assert report["status"] == "failed"
    assert report["assertions"]["revokedCredentialFailsClosed"] is False


def test_aggregate_rejects_missing_hostile_fail_closed_evidence(tmp_path: Path) -> None:
    python_report, browser_report = _passing_reports()
    browser_result = browser_report["browserResult"]
    assert isinstance(browser_result, dict)
    browser_result["hostileCaseEvidence"] = {"failClosedObserved": False}

    report = _aggregate(tmp_path, python_report, browser_report)

    assert report["status"] == "failed"
    assert report["assertions"]["revokedCredentialFailsClosed"] is False


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("observation", {}),
        ("observation", {"elapsedMs": 30_000, "timeoutMs": 30_000, "timedOut": False}),
        ("observation", {"elapsedMs": 29_999, "timeoutMs": 30_000, "timedOut": True}),
        ("observation", {"elapsedMs": True, "timeoutMs": 30_000, "timedOut": True}),
        ("observation", {"elapsedMs": 30_000, "timeoutMs": False, "timedOut": True}),
        ("observation", {"elapsedMs": 30_000, "timeoutMs": 0, "timedOut": True}),
    ],
)
def test_aggregate_rejects_invalid_bounded_revocation_observation(
    tmp_path: Path,
    field: str,
    value: object,
) -> None:
    python_report, browser_report = _passing_reports()
    browser_result = browser_report["browserResult"]
    assert isinstance(browser_result, dict)
    revocation = browser_result["revocationEvidence"]
    assert isinstance(revocation, dict)
    revocation[field] = value

    report = _aggregate(tmp_path, python_report, browser_report)

    assert report["status"] == "failed"
    assert report["assertions"]["revokedCredentialFailsClosed"] is False
    assert report["assertions"]["revokedCredentialBoundedTimeout"] is False


def test_aggregate_rejects_final_state_mismatch_after_revocation(tmp_path: Path) -> None:
    python_report, browser_report = _passing_reports()
    browser_result = browser_report["browserResult"]
    assert isinstance(browser_result, dict)
    browser_result["finalStateAfterRevocation"] = "awaiting-sas-confirmation"

    report = _aggregate(tmp_path, python_report, browser_report)

    assert report["status"] == "failed"
    assert report["assertions"]["revokedCredentialFailsClosed"] is False
    assert report["assertions"]["revokedCredentialFinalStateMatched"] is False


@pytest.mark.parametrize(
    ("revocation_state", "browser_state"),
    [
        (None, "discovering-peer"),
        ("discovering-peer", None),
        ("", "discovering-peer"),
        ("discovering-peer", ""),
        ("unexpected-state", "unexpected-state"),
    ],
)
def test_aggregate_rejects_invalid_final_state_values_after_revocation(
    tmp_path: Path,
    revocation_state: object,
    browser_state: object,
) -> None:
    python_report, browser_report = _passing_reports()
    browser_result = browser_report["browserResult"]
    assert isinstance(browser_result, dict)
    revocation = browser_result["revocationEvidence"]
    assert isinstance(revocation, dict)
    if revocation_state is None:
        revocation.pop("finalState", None)
    else:
        revocation["finalState"] = revocation_state
    if browser_state is None:
        browser_result.pop("finalStateAfterRevocation", None)
    else:
        browser_result["finalStateAfterRevocation"] = browser_state

    report = _aggregate(tmp_path, python_report, browser_report)

    assert report["status"] == "failed"
    assert report["assertions"]["revokedCredentialFailsClosed"] is False
    assert report["assertions"]["revokedCredentialFinalStateMatched"] is False


@pytest.mark.parametrize(
    ("section", "field", "value"),
    [
        ("python", "peerBridgeCallPath", "_rpc_call"),
        ("python", "privateRpcCallUsed", True),
        ("python", "manualAckUsed", True),
        ("python", "directServiceCallUsed", True),
        ("python", "httpFallbackUsed", True),
        ("python", "publicCallCount", 3),
        ("python", "manifestAckAndLeaseReady", False),
        ("lease", "available", False),
        ("discovery", "toolFound", False),
        ("discovery", "method", "Tooling.ExecuteTool"),
        ("prepare", "policyAllowed", False),
        ("prepare", "schemaHashBoundToExecution", False),
        ("execute", "expectedArgsSchemaHash", "b" * 64),
        ("negative", "failClosedWithoutHandler", False),
        ("identity", "frameCallerPeerIdOverridden", False),
        ("browser", "positiveInvocationCount", 0),
        ("browser", "authorityImplementation", "session-typescript"),
        ("browser", "negativeInvocationCount", 1),
        ("browser", "globalToolId", "aurora-tool:v1:wrong"),
        ("browser", "toolResponseDataDigest", "b" * 64),
        ("browser_lease", "available", False),
        ("browser_identity", "framePermissionsOverridden", False),
        ("audit", "redacted", False),
        ("audit_negative", "result", "failure"),
    ],
)
def test_aggregate_rejects_incomplete_ac18_local_tool_provider_evidence(
    tmp_path: Path,
    section: str,
    field: str,
    value: object,
) -> None:
    python_report, browser_report = _passing_reports()
    _enable_ac18(python_report, browser_report)
    python_evidence = python_report["ac18ReverseToolEvidence"]
    assert isinstance(python_evidence, dict)
    browser_result = browser_report["browserResult"]
    assert isinstance(browser_result, dict)
    browser_evidence = browser_result["ac18LocalToolProviderEvidence"]
    assert isinstance(browser_evidence, dict)
    if section == "python":
        python_evidence[field] = value
    elif section == "lease":
        lease = python_evidence["providerLease"]
        assert isinstance(lease, dict)
        lease[field] = value
    elif section == "discovery":
        discovery = python_evidence["discoveryProbe"]
        assert isinstance(discovery, dict)
        discovery[field] = value
    elif section == "prepare":
        prepare = python_evidence["prepareProbe"]
        assert isinstance(prepare, dict)
        prepare[field] = value
    elif section == "execute":
        execute = python_evidence["executeProbe"]
        assert isinstance(execute, dict)
        execute[field] = value
    elif section == "negative":
        negative = python_evidence["negativeProbe"]
        assert isinstance(negative, dict)
        negative[field] = value
    elif section == "identity":
        identity = python_evidence["identityOverride"]
        assert isinstance(identity, dict)
        identity[field] = value
    elif section == "browser_lease":
        lease = browser_evidence["providerLeaseAtInvocation"]
        assert isinstance(lease, dict)
        lease[field] = value
    elif section == "browser_identity":
        identity = browser_evidence["identityOverride"]
        assert isinstance(identity, dict)
        identity[field] = value
    elif section == "audit":
        audits = browser_evidence["auditRecords"]
        assert isinstance(audits, list)
        audits[0][field] = value
    elif section == "audit_negative":
        audits = browser_evidence["auditRecords"]
        assert isinstance(audits, list)
        audits[-1][field] = value
    else:
        browser_evidence[field] = value

    report = _aggregate(tmp_path, python_report, browser_report)

    assert report["status"] == "failed"
    assert report["ac18LocalToolProviderEvidence"]["requiredEvidencePassed"] is False


@pytest.mark.parametrize(
    ("target", "field", "value"),
    [
        ("python", "gatewayHttpApiEnabled", True),
        ("python", "gatewayHttpReachable", True),
        ("browser", "noHttpFetchTransportUsed", False),
        ("browser_result", "noHttpFetchTransportUsed", False),
        ("browser_result", "httpFetchCalls", ["http://127.0.0.1:8000/api/registry"]),
    ],
)
def test_aggregate_rejects_incomplete_http_disabled_proof(
    tmp_path: Path,
    target: str,
    field: str,
    value: object,
) -> None:
    python_report, browser_report = _passing_reports()
    if target == "python":
        python_report[field] = value
    elif target == "browser":
        browser_report[field] = value
    else:
        browser_result = browser_report["browserResult"]
        assert isinstance(browser_result, dict)
        browser_result[field] = value

    report = _aggregate(tmp_path, python_report, browser_report)

    assert report["status"] == "failed"
    assert report["httpDisabledProof"]["requiredEvidencePassed"] is False


@pytest.mark.parametrize(
    ("target", "field", "value"),
    [
        ("browser_result", "negotiationRole", "answerer"),
        ("python", "manifestSent", False),
        ("python", "authenticatedPeerCount", 1),
        ("browser_manifest", "peerId", "unexpected-peer"),
        ("browser_manifest", "serviceCount", 0),
        ("browser_error", "rejected", False),
        ("browser_error", "code", "validation"),
        ("browser_large", "resultBytes", 1),
        ("browser_large", "sentFragmentCount", 1),
        ("browser_stream", "completedChunks", []),
        ("browser_stream_status", "chunk_count", 2),
        ("python_cancelled_stream", "cancelled", False),
    ],
)
def test_aggregate_rejects_incomplete_cross_language_protocol_evidence(
    tmp_path: Path,
    target: str,
    field: str,
    value: object,
) -> None:
    python_report, browser_report = _passing_reports()
    browser_result = browser_report["browserResult"]
    assert isinstance(browser_result, dict)
    if target == "python":
        python_report[field] = value
    elif target == "browser_result":
        browser_result[field] = value
    elif target == "browser_manifest":
        manifest = browser_result["manifestEvidence"]
        assert isinstance(manifest, dict)
        manifest[field] = value
    elif target == "browser_error":
        error_evidence = browser_result["errorEvidence"]
        assert isinstance(error_evidence, dict)
        error_evidence[field] = value
    elif target == "browser_large":
        large_rpc = browser_result["largeRpcEvidence"]
        assert isinstance(large_rpc, dict)
        large_rpc[field] = value
    elif target == "browser_stream":
        rpc_stream = browser_result["rpcStreamEvidence"]
        assert isinstance(rpc_stream, dict)
        rpc_stream[field] = value
    elif target == "browser_stream_status":
        rpc_stream = browser_result["rpcStreamEvidence"]
        assert isinstance(rpc_stream, dict)
        python_status = rpc_stream["pythonStatus"]
        assert isinstance(python_status, dict)
        python_status[field] = value
    else:
        stream_records = python_report["streamRecords"]
        assert isinstance(stream_records, dict)
        cancelled_stream = stream_records["g009-stream-cancel-direct"]
        assert isinstance(cancelled_stream, dict)
        cancelled_stream[field] = value

    report = _aggregate(tmp_path, python_report, browser_report)

    assert report["status"] == "failed"

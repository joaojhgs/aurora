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
        "gatewayHttpApiEnabled": False,
        "gatewayHttpReachable": False,
        "scopedEventEvidence": {"wildcardInterested": False},
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
            "routeAuthorizedAfterRevocation": False,
            "pendingPairingPrompts": 1,
        },
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

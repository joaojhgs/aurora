import pytest

from scripts.webrtc_interop_scan import candidate_pair_matches_lane, scan_files


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

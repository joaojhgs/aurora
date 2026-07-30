"""HTTP/WebRTC same-grants parity acceptance tests."""

from __future__ import annotations

import pytest

from tests.e2e.http_webrtc_parity.parity_harness import run_parity_harness


@pytest.mark.e2e
def test_real_python_http_and_webrtc_sessions_enforce_the_same_grants(tmp_path):
    report = run_parity_harness(tmp_path)

    assert report["status"] == "pass"
    assert report["cleanup"] == {
        "owned_processes_stopped": True,
        "temporary_state_removed": True,
    }
    assert set(report["scenario_ids"]) == {
        "PARITY-01-allowed-route",
        "PARITY-02-revoked-grant",
        "PARITY-03-unsupported",
        "PARITY-04-redaction",
    }

    allowed = report["results"]["allowed"]
    assert allowed["http"]["allowed"] is True
    assert allowed["webrtc"]["allowed"] is True
    assert allowed["http"]["reason_code"] == allowed["webrtc"]["reason_code"] == "eligible"
    assert allowed["webrtc"]["rtc_connection_id_present"] is True

    denied = report["results"]["denied"]
    assert denied["http"]["allowed"] is True
    assert denied["webrtc"]["allowed"] is True
    assert denied["http"]["reason_code"] == denied["webrtc"]["reason_code"]
    assert denied["http"]["reason_code"] in {
        "permission_denied",
        "permissions_unknown",
        "service_not_advertised",
    }

    unsupported = report["results"]["unsupported"]
    assert unsupported["http"] == {
        "allowed": False,
        "status_code": 404,
        "reason_code": "unsupported",
        "candidate_reasons": [],
        "secrets_redacted": False,
        "has_token_material": False,
    }
    assert unsupported["webrtc"]["allowed"] is False
    assert unsupported["webrtc"]["wire_type"] == "error"
    assert unsupported["webrtc"]["reason_code"] == "unsupported"
    assert unsupported["webrtc"]["rtc_connection_id_present"] is True

    redaction = report["results"]["redaction"]
    assert redaction["http"]["allowed"] is True
    assert redaction["webrtc"]["allowed"] is True
    assert redaction["http"]["secrets_redacted"] is True
    assert redaction["webrtc"]["secrets_redacted"] is True
    assert redaction["http"]["has_token_material"] is False
    assert redaction["webrtc"]["has_token_material"] is False

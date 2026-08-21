//! R3's invariants, each with a test that fails loudly.
//!
//! The acceptance criterion for workstream R3 is three claims: a backgrounded
//! phone *holds its session past the 120 s stale window*, *answers a remote
//! tool call with the same authorization decision it would make in foreground*,
//! and *drains queued frames in order on resume with no re-pairing*. Each has a
//! test here. So does every invariant the R0 boundary note says R3 carries, and
//! so does the gap between what the settled table assigns to Rust and what this
//! build actually answers — because a gap nobody can see is a gap that gets
//! claimed away.

use aurora_mesh_authority::authority::{
    AuthenticatedPeerContext, PeerRelationshipSelector, ReconnectTransportAttestation,
};
use aurora_mesh_authority::types::PeerHostAuthorizationDecision;
use aurora_mesh_session::{
    background_executable_methods, background_execution_for, execute_background_tooling_call,
    frames_served_by_rust_today, inbound_frame_ownership, is_pairing_frame, BackgroundCapability,
    BackgroundToolingProviderContext, CallOutcome, FrameOwner, InboundDisposition,
    MeshSessionError, MeshSessionRegistry, SurfaceLifecycle, INBOUND_FRAME_OWNERSHIP,
    MAX_QUEUED_FRAMES_PER_PEER, ORCHESTRATION_DEFERRED_CODE, ORCHESTRATION_DEFERRED_MESSAGE,
    ORCHESTRATION_DEFERRED_REASON, RETRY_WHEN_PEER_FOREGROUND,
};
use serde_json::{json, Value};

/// Python's `stale_peer_timeout_s`, from `app/services/config/config_schema.json`:
/// "Mark peer stale after this many seconds without pong."
const STALE_PEER_TIMEOUT_SECONDS: u64 = 120;

const PEER_A: &str = "aurora-thin-a";
const PEER_B: &str = "aurora-thin-b";

fn context_for(peer_id: &str) -> AuthenticatedPeerContext {
    AuthenticatedPeerContext {
        selector: PeerRelationshipSelector {
            token_id: format!("token-{peer_id}"),
            claimant_peer_id: peer_id.to_owned(),
            verifier_peer_id: "aurora-thin-local".to_owned(),
            room_name: "room".to_owned(),
        },
        transport: ReconnectTransportAttestation {
            channel_binding: format!("{:0>64}", peer_id.len()),
            claimant_signaling_peer_id: format!("signal-{peer_id}"),
            verifier_signaling_peer_id: "signal-local".to_owned(),
        },
        connection_epoch: Some(format!("epoch-{peer_id}")),
        credential_revision: 7,
        authenticated_at_ms: 1_000,
    }
}

fn registry_with(peers: &[&str]) -> MeshSessionRegistry {
    let mut registry = MeshSessionRegistry::new();
    for (index, peer) in peers.iter().enumerate() {
        registry
            .bind(peer, index as u64 + 1, Some(context_for(peer)))
            .expect("binding a fresh peer succeeds");
    }
    registry
}

fn call_frame(id: &str, method: &str) -> Value {
    json!({
        "type": "call",
        "id": id,
        "method": method,
        "params": { "cursor": null },
        "identity": {
            // A caller may claim anything; the authority decides.
            "callerPeerId": "someone-else",
            "effectivePermissions": ["tooling.read"],
            "authGrantRevision": 3
        }
    })
}

fn allowed() -> PeerHostAuthorizationDecision {
    PeerHostAuthorizationDecision {
        allowed: true,
        granted_method_ids: Some(vec!["Tooling.GetTools".to_owned()]),
        ..PeerHostAuthorizationDecision::default()
    }
}

fn allowed_method_with_tools(
    method: &str,
    tool_contract_ids: &[&str],
) -> PeerHostAuthorizationDecision {
    PeerHostAuthorizationDecision {
        allowed: true,
        grant_revision: Some(11),
        granted_method_ids: Some(vec![method.to_owned()]),
        granted_tool_contract_ids: Some(
            tool_contract_ids
                .iter()
                .map(|contract_id| (*contract_id).to_owned())
                .collect(),
        ),
        ..PeerHostAuthorizationDecision::default()
    }
}

fn native_context() -> BackgroundToolingProviderContext {
    BackgroundToolingProviderContext {
        provider_peer_id: "aurora-local-provider".to_owned(),
        provider_service_instance_id: "local:aurora-local-provider:Tooling".to_owned(),
        native_manifest: json!({
            "platform": "linux",
            "capabilities": {
                "aurora.nativeCapabilityManifest": true,
                "aurora.notificationsStatus": true,
                "aurora.notificationsSend": false
            },
            "secretsRedacted": true
        }),
    }
}

// ---------------------------------------------------------------------------
// Acceptance criterion 1 — holding the session past the stale window
// ---------------------------------------------------------------------------

#[test]
fn ping_is_answered_in_rust_with_the_webview_frozen() {
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);

    let disposition = registry
        .accept_inbound(PEER_A, &json!({ "type": "ping", "id": "p-1" }), 1_000)
        .expect("a bound peer may send");

    assert_eq!(
        disposition,
        InboundDisposition::Answer(vec![json!({ "type": "pong", "id": "p-1" })]),
        "a frozen webview cannot answer a ping, so Rust must"
    );
}

#[test]
fn ping_is_answered_the_same_way_in_both_lifecycles() {
    let ping = json!({ "type": "ping", "id": "p-1" });

    let mut foreground = registry_with(&[PEER_A]);
    let in_foreground = foreground
        .accept_inbound(PEER_A, &ping, 1_000)
        .expect("bound peer");

    let mut background = registry_with(&[PEER_A]);
    background.set_lifecycle(SurfaceLifecycle::Background);
    let in_background = background
        .accept_inbound(PEER_A, &ping, 1_000)
        .expect("bound peer");

    assert_eq!(
        in_foreground, in_background,
        "runtime is chosen by platform, never by lifecycle: the ping answer must not change shape \
         when the phone goes into a pocket"
    );
}

#[test]
fn a_backgrounded_session_survives_the_120_second_stale_window() {
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);

    // Python pings roughly every 15 s and marks the peer stale after 120 s
    // without a pong. Walk twice the window and answer every one of them.
    let ping_interval_seconds = 15_u64;
    let elapsed_seconds = STALE_PEER_TIMEOUT_SECONDS * 2;
    let mut answered = 0_u64;
    for second in (ping_interval_seconds..=elapsed_seconds).step_by(ping_interval_seconds as usize)
    {
        let frame = json!({ "type": "ping", "id": format!("p-{second}") });
        let disposition = registry
            .accept_inbound(PEER_A, &frame, (second * 1_000) as i64)
            .expect("bound peer");
        match disposition {
            InboundDisposition::Answer(frames) => {
                assert_eq!(frames.len(), 1);
                answered += 1;
            }
            other => panic!("a ping at {second}s was not answered in Rust: {other:?}"),
        }
    }

    assert_eq!(answered, elapsed_seconds / ping_interval_seconds);
    let session = registry.session(PEER_A).expect("session survives");
    assert_eq!(session.answered_pings(), answered);
    assert_eq!(
        session.queue_depth(),
        0,
        "a ping must never be parked; parking it is what the stale window kills"
    );
}

// ---------------------------------------------------------------------------
// Acceptance criterion 2 — the same authorization decision as in foreground
// ---------------------------------------------------------------------------

#[test]
fn an_inbound_call_is_authorized_in_both_lifecycles_before_anything_else() {
    let frame = call_frame("c-1", "Tooling.GetTools");

    let mut foreground = registry_with(&[PEER_A]);
    let InboundDisposition::Authorize(from_foreground) = foreground
        .accept_inbound(PEER_A, &frame, 5_000)
        .expect("bound peer")
    else {
        panic!("a foreground call must be authorized");
    };

    let mut background = registry_with(&[PEER_A]);
    background.set_lifecycle(SurfaceLifecycle::Background);
    let InboundDisposition::Authorize(from_background) = background
        .accept_inbound(PEER_A, &frame, 5_000)
        .expect("bound peer")
    else {
        panic!("a backgrounded call must still be authorized, not deferred on sight");
    };

    assert_eq!(
        from_foreground, from_background,
        "the question put to the authority must not depend on the lifecycle"
    );
}

#[test]
fn a_denied_call_is_denied_identically_in_the_background() {
    let frame = call_frame("c-1", "Tooling.ExecuteTool");
    let denial = PeerHostAuthorizationDecision::denied("grant_expired");

    let mut foreground = registry_with(&[PEER_A]);
    let InboundDisposition::Authorize(pending) = foreground
        .accept_inbound(PEER_A, &frame, 5_000)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };
    let foreground_answer = foreground
        .settle_call(&pending, &denial)
        .expect("bound peer");

    let mut background = registry_with(&[PEER_A]);
    background.set_lifecycle(SurfaceLifecycle::Background);
    let InboundDisposition::Authorize(pending) = background
        .accept_inbound(PEER_A, &frame, 5_000)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };
    let background_answer = background
        .settle_call(&pending, &denial)
        .expect("bound peer");

    assert_eq!(foreground_answer, background_answer);
    let CallOutcome::Denied(frame) = background_answer else {
        panic!("a denial must stay a denial in the background");
    };
    assert_eq!(frame["error"]["code"], json!(403));
    assert_eq!(frame["error"]["reason_code"], json!("grant_expired"));
    assert_eq!(
        frame["error"].get("retry_when"),
        None,
        "a denial is not retryable and must not carry a retry hint"
    );
}

#[test]
fn deferral_is_decided_after_authorization_so_it_leaks_no_grant() {
    // Two callers, one with a grant and one without, asking for the same method
    // while the webview is frozen. If the deferral were decided before
    // authorization both would hear the same thing, and the answer would tell
    // an unauthorized caller that a grant exists for someone.
    let frame = call_frame("c-1", "Tooling.ExecuteTool");
    let mut registry = registry_with(&[PEER_A, PEER_B]);
    registry.set_lifecycle(SurfaceLifecycle::Background);

    let InboundDisposition::Authorize(granted) = registry
        .accept_inbound(PEER_A, &frame, 5_000)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };
    let InboundDisposition::Authorize(ungranted) = registry
        .accept_inbound(PEER_B, &frame, 5_000)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };

    let granted_answer = registry
        .settle_call(&granted, &allowed())
        .expect("bound peer");
    let ungranted_answer = registry
        .settle_call(
            &ungranted,
            &PeerHostAuthorizationDecision::denied("no_grant"),
        )
        .expect("bound peer");

    assert!(matches!(granted_answer, CallOutcome::Deferred(_)));
    assert!(matches!(ungranted_answer, CallOutcome::Denied(_)));
    assert_ne!(granted_answer, ungranted_answer);
}

#[test]
fn an_authorized_call_needing_the_orchestrator_defers_with_the_section_6_body() {
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);
    let InboundDisposition::Authorize(pending) = registry
        .accept_inbound(PEER_A, &call_frame("c-9", "Tooling.ExecuteTool"), 5_000)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };

    let CallOutcome::Deferred(frame) = registry
        .settle_call(&pending, &allowed())
        .expect("bound peer")
    else {
        panic!("an authorized orchestration call must defer, not fail and not hang");
    };

    assert_eq!(
        frame,
        json!({
            "type": "error",
            "id": "c-9",
            "correlation_id": "c-9",
            "error": {
                "code": ORCHESTRATION_DEFERRED_CODE,
                "message": ORCHESTRATION_DEFERRED_MESSAGE,
                "reason_code": ORCHESTRATION_DEFERRED_REASON,
                "retry_when": RETRY_WHEN_PEER_FOREGROUND
            }
        }),
        "the deferral body is quoted verbatim in the boundary note, section 6"
    );
}

#[test]
fn an_authorized_call_in_the_foreground_goes_to_the_orchestrator() {
    let mut registry = registry_with(&[PEER_A]);
    let InboundDisposition::Authorize(pending) = registry
        .accept_inbound(PEER_A, &call_frame("c-2", "Tooling.ExecuteTool"), 5_000)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };

    assert_eq!(
        registry
            .settle_call(&pending, &allowed())
            .expect("bound peer"),
        CallOutcome::Orchestrate {
            call_id: "c-2".to_owned()
        },
        "nothing defers while the orchestrator is awake"
    );
}

#[test]
fn a_backgrounded_tooling_call_serves_the_bounded_native_catalog() {
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);
    let InboundDisposition::Authorize(pending) = registry
        .accept_inbound(PEER_A, &call_frame("c-tools", "Tooling.GetTools"), 5_000)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };
    let decision = allowed_method_with_tools(
        "Tooling.GetTools",
        &["aurora.local.native.get_device_status.v1"],
    );

    assert!(matches!(
        registry
            .settle_call(&pending, &decision)
            .expect("bound peer"),
        CallOutcome::Serve { .. }
    ));
    let frame = execute_background_tooling_call(&pending, &decision, &native_context())
        .expect("contract-valid catalog");

    assert_eq!(frame["type"], json!("result"));
    assert_eq!(frame["result"]["count"], json!(1));
    assert_eq!(
        frame["result"]["tools"][0]["tool_contract_id"],
        json!("aurora.local.native.get_device_status.v1")
    );
    assert_eq!(
        frame["result"]["tools"][0]["provider_peer_id"],
        json!("aurora-local-provider")
    );
}

#[test]
fn a_backgrounded_export_catalog_uses_sdk_canonical_projection_hashes() {
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);
    let InboundDisposition::Authorize(pending) = registry
        .accept_inbound(
            PEER_A,
            &call_frame("c-export", "Tooling.GetExportCatalog"),
            5_000,
        )
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };
    let decision = allowed_method_with_tools(
        "Tooling.GetExportCatalog",
        &["aurora.local.native.get_device_status.v1"],
    );

    let frame = execute_background_tooling_call(&pending, &decision, &native_context())
        .expect("contract-valid export catalog");
    let result = &frame["result"];

    assert_eq!(
        result["projection_revision"],
        json!("501c3e2c3e341b80ffaff76c566f1c36fc4369d5d0af6c5c9ab6c7b74cd317e5")
    );
    assert_eq!(
        result["projection_digest"],
        json!("9ad51599ef087b4d905ff0623c0ffd352e363fee93726e383695759dde1ca507")
    );
    assert_eq!(result["final_checksum"], result["projection_digest"]);
    assert_eq!(
        result["page_hash"],
        json!("2856a37168e7a72c218cc89a2cef471f83f97cbe04da6c31d9d82d5dc0a486fb")
    );
}

#[test]
fn a_backgrounded_execute_tool_call_rejects_ungranted_or_spoofed_tool_claims() {
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);
    let frame = json!({
        "type": "call",
        "id": "c-denied",
        "method": "Tooling.ExecuteTool",
        "params": {
            "tool_name": "aurora.local.native.get_device_status.v1",
            "arguments": {},
            "caller_peer_id": "spoofed-peer",
            "caller_permissions": ["*", "Native.GetDeviceStatus"],
        },
        "identity": {
            "callerPeerId": "spoofed-peer",
            "effectivePermissions": ["*", "Native.GetDeviceStatus"]
        }
    });
    let InboundDisposition::Authorize(pending) = registry
        .accept_inbound(PEER_A, &frame, 5_000)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };
    let decision = allowed_method_with_tools("Tooling.ExecuteTool", &[]);

    assert!(matches!(
        registry
            .settle_call(&pending, &decision)
            .expect("bound peer"),
        CallOutcome::Serve { .. }
    ));
    let answer = execute_background_tooling_call(&pending, &decision, &native_context())
        .expect("typed denial");

    assert_eq!(pending.authorize.identity.caller_peer_id, PEER_A);
    assert_eq!(answer["result"]["ok"], json!(false));
    assert_eq!(answer["result"]["status"], json!("denied"));
    assert_eq!(answer["result"]["error_code"], json!("tool_not_granted"));

    let wrong_provider = json!({
        "type": "call",
        "id": "c-wrong-provider",
        "method": "Tooling.ExecuteTool",
        "params": {
            "tool_name": "aurora-tool:v1:other-peer:Tooling:aurora.local.native.get_device_status.v1",
            "arguments": {},
        },
    });
    let InboundDisposition::Authorize(pending) = registry
        .accept_inbound(PEER_A, &wrong_provider, 5_100)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };
    let granted = allowed_method_with_tools(
        "Tooling.ExecuteTool",
        &["aurora.local.native.get_device_status.v1"],
    );
    let answer = execute_background_tooling_call(&pending, &granted, &native_context())
        .expect("typed wrong-provider denial");

    assert_eq!(answer["result"]["ok"], json!(false));
    assert_eq!(answer["result"]["status"], json!("not_found"));
    assert_eq!(answer["result"]["error_code"], json!("tool_not_found"));
}

#[test]
fn background_prepare_and_execute_validate_arguments_and_output_shape() {
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);
    let bad_args = json!({
        "type": "call",
        "id": "c-prepare",
        "method": "Tooling.PrepareExecution",
        "params": {
            "tool_name": "native.get_device_status",
            "arguments": { "extra": true },
            "approval_token": "not-accepted"
        }
    });
    let InboundDisposition::Authorize(pending) = registry
        .accept_inbound(PEER_A, &bad_args, 5_000)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };
    let decision = allowed_method_with_tools(
        "Tooling.PrepareExecution",
        &["aurora.local.native.get_device_status.v1"],
    );
    let prepared = execute_background_tooling_call(&pending, &decision, &native_context())
        .expect("typed prepare denial");
    assert_eq!(prepared["result"]["ok"], json!(false));
    assert_eq!(
        prepared["result"]["policy_decision"]["reason"],
        json!("approval_not_supported")
    );

    let execute = json!({
        "type": "call",
        "id": "c-execute",
        "method": "Tooling.ExecuteTool",
        "params": {
            "tool_name": "native.get_device_status",
            "arguments": {}
        }
    });
    let InboundDisposition::Authorize(pending) = registry
        .accept_inbound(PEER_A, &execute, 5_100)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };
    let decision = allowed_method_with_tools(
        "Tooling.ExecuteTool",
        &["aurora.local.native.get_device_status.v1"],
    );
    let successful = execute_background_tooling_call(&pending, &decision, &native_context())
        .expect("typed execution success");
    assert_eq!(successful["result"]["ok"], json!(true));
    assert_eq!(successful["result"]["status"], json!("success"));
    assert_eq!(successful["result"]["data"]["platform"], json!("linux"));
    assert_eq!(successful["result"]["data"]["online"], json!(true));
    assert_eq!(
        successful["result"]["args_hash"],
        json!("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a")
    );
    assert_eq!(
        successful["result"]["policy_decision_id"],
        json!("a4833b03832be7d4b326c53bf57893cd4697450aa2fe3caf404c98793a2c0cd5")
    );

    let invalid_context = BackgroundToolingProviderContext {
        native_manifest: json!({ "capabilities": {} }),
        ..native_context()
    };
    let failed = execute_background_tooling_call(&pending, &decision, &invalid_context)
        .expect("typed execution failure");
    assert_eq!(failed["result"]["ok"], json!(false));
    assert_eq!(failed["result"]["status"], json!("failed"));
    assert_eq!(
        failed["result"]["error_code"],
        json!("native_manifest_invalid")
    );
}

#[test]
fn deferral_is_not_eviction() {
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);
    let InboundDisposition::Authorize(pending) = registry
        .accept_inbound(PEER_A, &call_frame("c-1", "Tooling.ExecuteTool"), 5_000)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };
    let _ = registry
        .settle_call(&pending, &allowed())
        .expect("bound peer");

    // The peer stays in the roster and keeps answering ping. A caller that
    // receives a deferral must not drop the peer or re-pair.
    assert_eq!(registry.peer_ids(), vec![PEER_A.to_owned()]);
    let disposition = registry
        .accept_inbound(PEER_A, &json!({ "type": "ping", "id": "p-2" }), 6_000)
        .expect("the deferred peer is still bound");
    assert!(matches!(disposition, InboundDisposition::Answer(_)));
}

#[test]
fn the_caller_peer_id_is_the_transport_s_and_not_the_frame_s_claim() {
    let mut registry = registry_with(&[PEER_A]);
    let InboundDisposition::Authorize(pending) = registry
        .accept_inbound(PEER_A, &call_frame("c-1", "Tooling.GetTools"), 5_000)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };

    assert_eq!(pending.authorize.remote_peer_id, PEER_A);
    assert_eq!(
        pending.authorize.identity.caller_peer_id, PEER_A,
        "the frame claimed to be someone else; the authority is told who it actually arrived from"
    );
}

#[test]
fn authority_contexts_never_cross_peers() {
    let mut registry = registry_with(&[PEER_A, PEER_B]);
    registry.set_lifecycle(SurfaceLifecycle::Background);

    let InboundDisposition::Authorize(from_a) = registry
        .accept_inbound(PEER_A, &call_frame("c-1", "Tooling.GetTools"), 5_000)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };
    let InboundDisposition::Authorize(from_b) = registry
        .accept_inbound(PEER_B, &call_frame("c-2", "Tooling.GetTools"), 5_000)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };

    assert_eq!(
        from_a.authorize.authenticated_peer_context,
        Some(context_for(PEER_A))
    );
    assert_eq!(
        from_b.authorize.authenticated_peer_context,
        Some(context_for(PEER_B))
    );
    assert_ne!(
        from_a.authorize.authenticated_peer_context,
        from_b.authorize.authenticated_peer_context
    );
}

// ---------------------------------------------------------------------------
// Acceptance criterion 3 — draining in order on resume, with no re-pairing
// ---------------------------------------------------------------------------

#[test]
fn queued_frames_drain_in_arrival_order_on_resume() {
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);

    let arrivals = [
        json!({ "type": "event", "id": "e-1", "topic": "Tooling.Progress" }),
        json!({ "type": "result", "id": "r-1", "result": {} }),
        json!({ "type": "mesh_event", "id": "m-1" }),
        json!({ "type": "event", "id": "e-2", "topic": "Tooling.Progress" }),
    ];
    for (index, frame) in arrivals.iter().enumerate() {
        let disposition = registry
            .accept_inbound(PEER_A, frame, 1_000 + index as i64)
            .expect("bound peer");
        assert_eq!(
            disposition,
            InboundDisposition::Queued { depth: index + 1 },
            "a frame TypeScript owns must be parked, not dropped and not refused"
        );
    }

    let drained = registry.set_lifecycle(SurfaceLifecycle::Foreground);
    assert_eq!(registry.lifecycle(), SurfaceLifecycle::Resuming);
    assert_eq!(drained.len(), 1);
    let (peer_id, frames) = &drained[0];
    assert_eq!(peer_id, PEER_A);
    assert_eq!(
        frames
            .iter()
            .map(|queued| queued.sequence)
            .collect::<Vec<_>>(),
        vec![0, 1, 2, 3]
    );
    assert_eq!(
        frames
            .iter()
            .map(|queued| queued.frame.clone())
            .collect::<Vec<_>>(),
        arrivals.to_vec(),
        "the queue drains in arrival order, verbatim"
    );

    assert_eq!(
        registry.session(PEER_A).expect("session").queue_depth(),
        0,
        "draining empties the queue so a second resume does not replay it"
    );
    assert!(registry.finish_resume().is_empty());
    assert_eq!(registry.lifecycle(), SurfaceLifecycle::Foreground);
}

#[test]
fn resuming_queues_arrivals_until_an_acknowledged_empty_drain() {
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);
    registry
        .accept_inbound(PEER_A, &json!({ "type": "event", "id": "e-1" }), 1_000)
        .expect("bound peer");

    let drained = registry.set_lifecycle(SurfaceLifecycle::Foreground);
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].1.len(), 1);
    assert_eq!(registry.lifecycle(), SurfaceLifecycle::Resuming);

    let disposition = registry
        .accept_inbound(PEER_A, &json!({ "type": "event", "id": "e-2" }), 2_000)
        .expect("bound peer");
    assert_eq!(disposition, InboundDisposition::Queued { depth: 1 });

    let second_drain = registry.finish_resume();
    assert_eq!(second_drain.len(), 1);
    assert_eq!(second_drain[0].1.len(), 1);
    assert_eq!(second_drain[0].1[0].frame["id"], "e-2");
    assert_eq!(registry.lifecycle(), SurfaceLifecycle::Resuming);

    assert!(registry.finish_resume().is_empty());
    assert_eq!(registry.lifecycle(), SurfaceLifecycle::Foreground);

    let disposition = registry
        .accept_inbound(PEER_A, &json!({ "type": "event", "id": "e-3" }), 3_000)
        .expect("bound peer");
    assert_eq!(disposition, InboundDisposition::Dispatch);
}

#[test]
fn going_into_the_background_drains_nothing() {
    let mut registry = registry_with(&[PEER_A]);
    assert!(registry
        .set_lifecycle(SurfaceLifecycle::Background)
        .is_empty());
    assert!(registry
        .set_lifecycle(SurfaceLifecycle::Background)
        .is_empty());
}

#[test]
fn queues_never_cross_peers() {
    let mut registry = registry_with(&[PEER_A, PEER_B]);
    registry.set_lifecycle(SurfaceLifecycle::Background);

    registry
        .accept_inbound(PEER_A, &json!({ "type": "event", "id": "a-1" }), 1_000)
        .expect("bound peer");
    registry
        .accept_inbound(PEER_B, &json!({ "type": "event", "id": "b-1" }), 1_001)
        .expect("bound peer");
    registry
        .accept_inbound(PEER_A, &json!({ "type": "event", "id": "a-2" }), 1_002)
        .expect("bound peer");

    let drained = registry.drain_all();
    assert_eq!(drained.len(), 2);
    let for_a: Vec<&str> = drained[0]
        .1
        .iter()
        .filter_map(|queued| queued.frame["id"].as_str())
        .collect();
    let for_b: Vec<&str> = drained[1]
        .1
        .iter()
        .filter_map(|queued| queued.frame["id"].as_str())
        .collect();
    assert_eq!(drained[0].0, PEER_A);
    assert_eq!(for_a, vec!["a-1", "a-2"]);
    assert_eq!(drained[1].0, PEER_B);
    assert_eq!(for_b, vec!["b-1"]);
}

#[test]
fn the_queue_is_bounded_and_answers_retryably_when_it_is_full() {
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);
    for index in 0..MAX_QUEUED_FRAMES_PER_PEER {
        let frame = json!({ "type": "event", "id": format!("e-{index}") });
        assert!(matches!(
            registry
                .accept_inbound(PEER_A, &frame, 1_000)
                .expect("bound peer"),
            InboundDisposition::Queued { .. }
        ));
    }

    let overflowed = registry
        .accept_inbound(PEER_A, &json!({ "type": "event", "id": "e-over" }), 1_000)
        .expect("bound peer");
    let InboundDisposition::Overflow(Some(answer)) = overflowed else {
        panic!("an overflowing frame with an id must be answered, not silently dropped");
    };
    assert_eq!(answer["error"]["code"], json!(ORCHESTRATION_DEFERRED_CODE));
    assert_eq!(
        answer["error"]["retry_when"],
        json!(RETRY_WHEN_PEER_FOREGROUND)
    );
    assert_eq!(
        registry.session(PEER_A).expect("session").queue_depth(),
        MAX_QUEUED_FRAMES_PER_PEER,
        "overflow must not grow the queue past its bound"
    );
}

// ---------------------------------------------------------------------------
// R0 section 5 — what a backgrounded reconnect may do
// ---------------------------------------------------------------------------

#[test]
fn pairing_frames_are_never_answered_by_rust_and_never_denied() {
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);

    for frame_type in aurora_mesh_session::PAIRING_FRAME_TYPES {
        assert!(is_pairing_frame(frame_type));
        let ownership = inbound_frame_ownership(frame_type).expect("the table names it");
        assert_eq!(ownership.owner, FrameOwner::TypeScript);
        assert_eq!(ownership.background, BackgroundCapability::No);
        assert!(
            !ownership.served_by_rust_today,
            "SAS needs a human comparing a code; Rust must never answer {frame_type}"
        );

        let disposition = registry
            .accept_inbound(PEER_A, &json!({ "type": frame_type, "id": "x" }), 1_000)
            .expect("bound peer");
        assert!(
            matches!(disposition, InboundDisposition::Queued { .. }),
            "a pairing attempt at a backgrounded peer is deferred, never denied: {frame_type} \
             produced {disposition:?}"
        );
    }
}

#[test]
fn one_stable_id_holds_one_session() {
    let mut registry = registry_with(&[PEER_A]);
    let refusal = registry
        .bind(PEER_A, 99, Some(context_for(PEER_A)))
        .expect_err("a stable identity on a second transport is refused");
    assert_eq!(
        refusal,
        MeshSessionError::PeerAlreadyRegistered {
            peer_id: PEER_A.to_owned()
        }
    );
}

#[test]
fn a_backgrounded_reconnect_may_not_accept_a_new_stable_identity() {
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);

    // The same transport coming back claiming a different stable id is a
    // pairing attempt wearing a reconnect's clothes.
    let refusal = registry
        .bind(
            "aurora-thin-brand-new",
            1,
            Some(context_for("aurora-thin-brand-new")),
        )
        .expect_err("a new identity on a held connection is refused while backgrounded");
    assert_eq!(
        refusal,
        MeshSessionError::StableIdentityChangeWhileBackgrounded
    );
    assert_eq!(registry.peer_ids(), vec![PEER_A.to_owned()]);

    let refusal = registry
        .bind(
            "aurora-thin-brand-new-transport",
            99,
            Some(context_for("aurora-thin-brand-new-transport")),
        )
        .expect_err("a new identity on a new transport is also refused while backgrounded");
    assert_eq!(
        refusal,
        MeshSessionError::StableIdentityChangeWhileBackgrounded
    );
    assert_eq!(registry.peer_ids(), vec![PEER_A.to_owned()]);
}

#[test]
fn a_backgrounded_reconnect_rebinds_the_identity_it_already_holds() {
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);

    registry
        .bind(PEER_A, 1, Some(context_for(PEER_A)))
        .expect("re-presenting the same identity on the same transport is a reconnect");
    assert_eq!(registry.peer_ids(), vec![PEER_A.to_owned()]);
    assert_eq!(registry.len(), 1, "a reconnect adds no second session");
}

#[test]
fn an_unbound_peer_cannot_drive_a_session() {
    let mut registry = registry_with(&[PEER_A]);
    let refusal = registry
        .accept_inbound("aurora-thin-stranger", &json!({ "type": "ping" }), 1_000)
        .expect_err("a frame from a peer with no session is refused");
    assert_eq!(
        refusal,
        MeshSessionError::UnknownPeer {
            peer_id: "aurora-thin-stranger".to_owned()
        }
    );
}

// ---------------------------------------------------------------------------
// Runtime is chosen by platform, never by lifecycle
// ---------------------------------------------------------------------------

#[test]
fn frame_ownership_does_not_depend_on_the_lifecycle() {
    // The lookup takes a frame type and nothing else. This is the structural
    // half of the invariant; the behavioural half is that the same registry
    // type serves both lifecycles, which every other test here exercises.
    for entry in INBOUND_FRAME_OWNERSHIP {
        let looked_up = inbound_frame_ownership(entry.frame_type).expect("round trips");
        assert_eq!(&looked_up, entry);
    }
}

#[test]
fn the_same_registry_serves_both_lifecycles() {
    let mut registry = registry_with(&[PEER_A]);
    let ping = json!({ "type": "ping", "id": "p" });

    let foreground = registry.accept_inbound(PEER_A, &ping, 1).expect("bound");
    registry.set_lifecycle(SurfaceLifecycle::Background);
    let background = registry.accept_inbound(PEER_A, &ping, 2).expect("bound");
    let drained = registry.set_lifecycle(SurfaceLifecycle::Foreground);
    assert!(registry.finish_resume().is_empty());
    let resumed = registry.accept_inbound(PEER_A, &ping, 3).expect("bound");

    assert_eq!(foreground, background);
    assert_eq!(background, resumed);
    assert!(
        drained.is_empty(),
        "pings were answered, not parked, so there is nothing to replay"
    );
    assert_eq!(
        registry.session(PEER_A).expect("session").answered_pings(),
        3
    );
}

// ---------------------------------------------------------------------------
// The gap between the settled table and this build
// ---------------------------------------------------------------------------

#[test]
fn the_frame_ownership_table_matches_the_boundary_note() {
    // Section 3, row by row. A frame type missing from this list, or a row
    // whose owner moved, means the table and the note disagree.
    let expected: &[(&str, FrameOwner, BackgroundCapability)] = &[
        (
            "protocol_hello",
            FrameOwner::Rust,
            BackgroundCapability::Yes,
        ),
        ("fragment", FrameOwner::Rust, BackgroundCapability::Yes),
        ("ping", FrameOwner::Rust, BackgroundCapability::Yes),
        ("pong", FrameOwner::TypeScript, BackgroundCapability::No),
        (
            "mesh_auth_challenge_v1",
            FrameOwner::Rust,
            BackgroundCapability::Yes,
        ),
        (
            "mesh_auth_proof_v1",
            FrameOwner::Rust,
            BackgroundCapability::Yes,
        ),
        ("auth", FrameOwner::Rust, BackgroundCapability::Yes),
        ("reauth", FrameOwner::Rust, BackgroundCapability::Yes),
        (
            "pairing_v2_commit",
            FrameOwner::TypeScript,
            BackgroundCapability::No,
        ),
        (
            "pairing_v2_reveal",
            FrameOwner::TypeScript,
            BackgroundCapability::No,
        ),
        (
            "pairing_v2_terminal",
            FrameOwner::TypeScript,
            BackgroundCapability::No,
        ),
        ("call", FrameOwner::Rust, BackgroundCapability::Yes),
        ("result", FrameOwner::TypeScript, BackgroundCapability::No),
        ("error", FrameOwner::TypeScript, BackgroundCapability::No),
        ("chunk", FrameOwner::Rust, BackgroundCapability::Yes),
        ("eof", FrameOwner::Rust, BackgroundCapability::Yes),
        ("cancel", FrameOwner::Rust, BackgroundCapability::Yes),
        (
            "event",
            FrameOwner::TypeScript,
            BackgroundCapability::Partial,
        ),
        ("subscribe", FrameOwner::Rust, BackgroundCapability::Yes),
        ("unsubscribe", FrameOwner::Rust, BackgroundCapability::Yes),
        (
            "subscribed",
            FrameOwner::TypeScript,
            BackgroundCapability::No,
        ),
        (
            "subscribe_rejected",
            FrameOwner::TypeScript,
            BackgroundCapability::No,
        ),
        (
            "unsubscribed",
            FrameOwner::TypeScript,
            BackgroundCapability::No,
        ),
        ("manifest", FrameOwner::Rust, BackgroundCapability::Yes),
        (
            "manifest_request",
            FrameOwner::Rust,
            BackgroundCapability::Yes,
        ),
        ("manifest_ack", FrameOwner::Rust, BackgroundCapability::Yes),
        (
            "provider_lease",
            FrameOwner::Rust,
            BackgroundCapability::Yes,
        ),
        (
            "provider_unavailable",
            FrameOwner::Rust,
            BackgroundCapability::Yes,
        ),
        (
            "capacity_update",
            FrameOwner::Rust,
            BackgroundCapability::Yes,
        ),
        ("presence", FrameOwner::Rust, BackgroundCapability::Yes),
        (
            "presence_departed",
            FrameOwner::Rust,
            BackgroundCapability::Yes,
        ),
        (
            "mesh_peer_standby_v1",
            FrameOwner::Rust,
            BackgroundCapability::Yes,
        ),
        (
            "offer",
            FrameOwner::RustOnReconnect,
            BackgroundCapability::ReconnectOnly,
        ),
        (
            "answer",
            FrameOwner::RustOnReconnect,
            BackgroundCapability::ReconnectOnly,
        ),
        (
            "candidate",
            FrameOwner::RustOnReconnect,
            BackgroundCapability::ReconnectOnly,
        ),
        (
            "mesh_event",
            FrameOwner::TypeScript,
            BackgroundCapability::No,
        ),
    ];

    assert_eq!(INBOUND_FRAME_OWNERSHIP.len(), expected.len());
    for (frame_type, owner, background) in expected {
        let row = inbound_frame_ownership(frame_type)
            .unwrap_or_else(|| panic!("section 3 names {frame_type} but the table does not"));
        assert_eq!(row.owner, *owner, "owner drifted for {frame_type}");
        assert_eq!(
            row.background, *background,
            "background capability drifted for {frame_type}"
        );
    }
}

#[test]
fn rust_answers_exactly_the_frames_this_build_implements() {
    // The honest column. Section 3 assigns far more to Rust than this build
    // answers; the rest is still dispatched into TypeScript when it is awake
    // and parked when it is not. Widening this list without widening the
    // dispatcher, or the reverse, breaks here.
    assert_eq!(
        frames_served_by_rust_today(),
        vec!["call", "ping"],
        "R3 lands liveness and inbound call admission in Rust. Every other Rust-owned row in \
         section 3 is still handled in mesh-peer-bridge.ts and is queued, not answered, while \
         the webview is frozen."
    );
}

#[test]
fn only_the_tooling_meta_methods_have_bounded_native_background_executors() {
    assert_eq!(
        background_executable_methods(),
        vec![
            "Tooling.GetTools",
            "Tooling.GetExportCatalog",
            "Tooling.PrepareExecution",
            "Tooling.ExecuteTool",
        ]
    );
    for method in [
        "Tooling.GetTools",
        "Tooling.GetExportCatalog",
        "Tooling.PrepareExecution",
        "Tooling.ExecuteTool",
    ] {
        assert!(
            background_execution_for(method).is_some(),
            "{method} must stay wired to the bounded native background executor"
        );
    }
    for method in [
        "TTS.Request",
        "Orchestrator.ExternalUserInput",
        "Pairing.Start",
    ] {
        assert!(
            background_execution_for(method).is_none(),
            "{method} must not gain a native background executor by accident"
        );
    }
}

// ---------------------------------------------------------------------------
// Product copy stays product copy
// ---------------------------------------------------------------------------

#[test]
fn the_deferral_message_carries_no_transport_jargon() {
    // `message` is user-facing if it ever surfaces. The machine-readable part
    // is `reason_code`. See packages/aurora-ui/src/product-copy-forbidden-terms.ts.
    let message = ORCHESTRATION_DEFERRED_MESSAGE.to_lowercase();
    for forbidden in [
        "webview",
        "orchestrat",
        "frozen",
        "rust",
        "typescript",
        "peer",
        "frame",
        "webrtc",
        "datachannel",
    ] {
        assert!(
            !message.contains(forbidden),
            "product copy must not say {forbidden:?}: {ORCHESTRATION_DEFERRED_MESSAGE:?}"
        );
    }
    assert_eq!(
        ORCHESTRATION_DEFERRED_MESSAGE,
        "deferred until the device is back in use"
    );
}

#[test]
fn retry_when_is_additive_and_absent_from_the_bodies_that_predate_it() {
    use aurora_mesh_authority::types::PeerHostErrorBody;

    let timeout = serde_json::to_value(PeerHostErrorBody::request_timeout()).expect("serializes");
    assert_eq!(
        timeout,
        json!({ "code": 504, "message": "request timed out", "reason_code": "request_timeout" }),
        "adding retry_when must not change any body that does not set it"
    );

    // An older peer reading only the fields it knows still sees a well-formed
    // retryable 503.
    let deferral = aurora_mesh_session::orchestration_deferred_body();
    assert_eq!(deferral.code, 503);
    assert_eq!(deferral.reason_code, ORCHESTRATION_DEFERRED_REASON);
    assert_eq!(
        deferral.retry_when.as_deref(),
        Some(RETRY_WHEN_PEER_FOREGROUND)
    );
}

#[test]
fn the_deferral_is_not_provider_unavailable() {
    // provider_unavailable means the provider is gone and the peer should stop
    // routing to it. A deferral means the opposite: stay, and try again.
    let frame = aurora_mesh_session::orchestration_deferred_frame("c-1");
    assert_eq!(frame["type"], json!("error"));
    assert_ne!(frame["type"], json!("provider_unavailable"));
    assert_eq!(frame["correlation_id"], json!("c-1"));
}

// ---------------------------------------------------------------------------
// R0 section 5, continued — a backgrounded reconnect may not widen a grant,
// and may not replay a challenge
// ---------------------------------------------------------------------------

#[test]
fn a_backgrounded_session_cannot_widen_a_grant() {
    // "The Rust authority is asked; it is not told." A reconnect can only
    // produce a decision the existing grant already supports, so the session
    // registry must be incapable of improving on the answer it was handed. It
    // stores no grant to widen: the only authority-shaped value on a session is
    // the authenticated peer context, which is a reference to what a proof
    // established and carries no permissions of its own.
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);

    let frame = call_frame("c-1", "Tooling.ExecuteTool");
    let InboundDisposition::Authorize(pending) = registry
        .accept_inbound(PEER_A, &frame, 5_000)
        .expect("bound peer")
    else {
        panic!("expected an authorization hop");
    };

    // The caller claimed permissions in the frame. They are reported to the
    // authority as a claim and change nothing about the outcome.
    assert_eq!(
        pending.authorize.identity.effective_permissions,
        vec!["tooling.read".to_owned()]
    );
    assert!(
        pending.authorize.required_permissions.is_empty(),
        "this module never states what a method demands; the contract registry does"
    );

    for reason in ["no_grant", "grant_expired", "selector_mismatch", "revoked"] {
        let outcome = registry
            .settle_call(&pending, &PeerHostAuthorizationDecision::denied(reason))
            .expect("bound peer");
        let CallOutcome::Denied(answer) = outcome else {
            panic!("a denial must never become anything else: {reason}");
        };
        assert_eq!(answer["error"]["code"], json!(403));
        assert_eq!(answer["error"]["reason_code"], json!(reason));
    }
}

#[test]
fn a_backgrounded_session_holds_no_grant_to_leak_or_widen() {
    let registry = registry_with(&[PEER_A]);
    let session = registry.session(PEER_A).expect("session");

    // The only authority-shaped value a session exposes.
    assert_eq!(
        session.authenticated_peer_context(),
        Some(&context_for(PEER_A))
    );

    // And the diagnostic projection carries counters and identity, never a
    // permission, a method id or a grant revision.
    let snapshot = session.snapshot();
    let rendered = snapshot.to_string();
    for forbidden in [
        "grant",
        "permission",
        "allowedMethodIds",
        "grantedMethodIds",
        "tokenId",
        "capabilityPack",
    ] {
        assert!(
            !rendered.contains(forbidden),
            "a session snapshot must not carry {forbidden:?}: {rendered}"
        );
    }
}

#[test]
fn reconnect_auth_frames_are_not_answered_here_so_no_challenge_is_replayed() {
    // Section 3 puts mesh_auth_challenge_v1 and mesh_auth_proof_v1 on the Rust
    // side of the boundary, and the replay guard moves with them. This build
    // has not moved them yet: it answers neither, so it cannot answer one
    // twice. The guard itself stays under test in
    // aurora-mesh-authority/tests/parity_corpus.rs
    // (`reconnect_challenges_are_single_use_per_peer`), and this test fails the
    // moment someone starts answering the frames here without bringing the
    // guard along.
    let mut registry = registry_with(&[PEER_A]);
    registry.set_lifecycle(SurfaceLifecycle::Background);

    for frame_type in [
        "mesh_auth_challenge_v1",
        "mesh_auth_proof_v1",
        "auth",
        "reauth",
    ] {
        let row = inbound_frame_ownership(frame_type).expect("the table names it");
        assert_eq!(
            row.owner,
            FrameOwner::Rust,
            "section 3 assigns {frame_type} to Rust"
        );
        assert!(
            !row.served_by_rust_today,
            "{frame_type} is answered here now: move the single-use replay guard with it and \
             update this test"
        );

        let frame = json!({ "type": frame_type, "id": "auth-1", "challenge": "deadbeef" });
        let first = registry
            .accept_inbound(PEER_A, &frame, 1_000)
            .expect("bound peer");
        let second = registry
            .accept_inbound(PEER_A, &frame, 1_001)
            .expect("bound peer");
        assert!(
            matches!(first, InboundDisposition::Queued { .. }),
            "{frame_type} must be parked for the auth state machine, not answered: {first:?}"
        );
        assert!(
            matches!(second, InboundDisposition::Queued { .. }),
            "a repeat must also be parked, so the guard sees both: {second:?}"
        );
    }

    // Both copies reach the peer that owns the guard, in order, and neither was
    // answered from here.
    let drained = registry.drain_peer(PEER_A).expect("bound peer");
    assert_eq!(drained.len(), 8);
    assert_eq!(
        drained
            .iter()
            .map(|queued| queued.sequence)
            .collect::<Vec<_>>(),
        (0..8).collect::<Vec<u64>>()
    );
}

#[test]
fn signaling_frames_are_reconnect_only_and_first_contact_stays_in_typescript() {
    for frame_type in ["offer", "answer", "candidate"] {
        let row = inbound_frame_ownership(frame_type).expect("the table names it");
        assert_eq!(row.owner, FrameOwner::RustOnReconnect);
        assert_eq!(row.background, BackgroundCapability::ReconnectOnly);
        assert!(
            !row.served_by_rust_today,
            "signaling is not re-run from here yet; first contact needs the TypeScript auth \
             state machine and a reconnect needs a credential this build does not read"
        );
    }
}

// ---------------------------------------------------------------------------
// One Aurora in the notification shade
// ---------------------------------------------------------------------------

#[test]
fn the_first_session_takes_the_device_link_and_the_last_one_releases_it() {
    use aurora_mesh_session::{DeviceLinkAction, DeviceLinkLedger};

    let mut ledger = DeviceLinkLedger::new();
    assert!(!ledger.is_held());

    assert_eq!(ledger.sync(1), Some(DeviceLinkAction::Hold));
    assert!(ledger.is_held());

    // A second and third session are the same one hold. Taking another would
    // run the service's reference count away from the number of sessions and
    // strand the notification in the shade.
    assert_eq!(ledger.sync(2), None);
    assert_eq!(ledger.sync(3), None);
    assert_eq!(ledger.sync(2), None);
    assert!(ledger.is_held());

    assert_eq!(ledger.sync(0), Some(DeviceLinkAction::Release));
    assert!(!ledger.is_held());

    // And releasing again releases nothing, so an unbalanced call cannot drop
    // a hold that voice is relying on.
    assert_eq!(ledger.sync(0), None);
}

#[test]
fn a_flapping_session_does_not_leak_holds() {
    use aurora_mesh_session::{DeviceLinkAction, DeviceLinkLedger};

    let mut ledger = DeviceLinkLedger::new();
    let mut holds = 0_i32;
    for count in [1, 0, 1, 1, 0, 0, 1, 2, 0] {
        match ledger.sync(count) {
            Some(DeviceLinkAction::Hold) => holds += 1,
            Some(DeviceLinkAction::Release) => holds -= 1,
            None => {}
        }
        assert!(
            (0..=1).contains(&holds),
            "holds left the 0..1 range: {holds}"
        );
    }
    assert_eq!(holds, 0, "every hold was matched by exactly one release");
    assert!(!ledger.is_held());
}

#[test]
fn the_device_link_follows_the_registry_and_not_the_lifecycle() {
    use aurora_mesh_session::{DeviceLinkAction, DeviceLinkLedger};

    // Going into the background must not drop the hold: the background is
    // precisely when the process needs to stay alive to keep answering.
    let mut registry = registry_with(&[PEER_A]);
    let mut ledger = DeviceLinkLedger::new();
    assert_eq!(ledger.sync(registry.len()), Some(DeviceLinkAction::Hold));

    registry.set_lifecycle(SurfaceLifecycle::Background);
    assert_eq!(ledger.sync(registry.len()), None);
    assert!(ledger.is_held());

    registry.set_lifecycle(SurfaceLifecycle::Foreground);
    assert_eq!(ledger.sync(registry.len()), None);
    assert!(ledger.is_held());

    registry.unbind(PEER_A);
    assert_eq!(ledger.sync(registry.len()), Some(DeviceLinkAction::Release));
}

//! Session liveness and background frame serving.
//!
//! The Rust half of R3. One registry holds every peer this device has a live
//! data channel to, classifies each inbound frame against the R0 section 3
//! table, and decides one of four things: answer it here, hand it to
//! TypeScript, park it in this peer's FIFO until TypeScript wakes up, or ask
//! the authority and then serve or defer it.
//!
//! ## What the lifecycle does and does not decide
//!
//! [`SurfaceLifecycle`] says whether the webview is awake. It decides
//! **dispatch**, never **implementation**: the same Rust code classifies and
//! answers frames in both states, and a frame Rust owns is answered by Rust
//! whether the phone is in the user's hand or in their pocket. *Runtime is
//! chosen by platform, never by lifecycle.* There is no background mode that
//! swaps one stack for another, and adding one would be the regression this
//! module's tests exist to catch.
//!
//! ## Why `ping` is the headline
//!
//! Python marks a peer stale after `stale_peer_timeout_s` seconds without a
//! pong — 120 by default, described in `app/services/config/config_schema.json`
//! as "Mark peer stale after this many seconds without pong". A frozen webview
//! cannot answer inside that window, so the session dies and the peer has to be
//! rebuilt. Rust answering `ping` itself is what holds the session open.
//!
//! ## The per-peer FIFO
//!
//! Rust holds one queue per peer for frames it accepted but cannot complete
//! without TypeScript. On resume the registry enters `resuming`: it drains a
//! batch, continues queuing arrivals while TypeScript reinjects that batch, and
//! only returns to foreground after an acknowledged drain is empty. R3's
//! "drains queued frames in order on resume" is a test against this queue, not
//! an aspiration. Queues never merge: a frame parked for peer A is invisible to
//! peer B, which is the transport-side half of *authority contexts never cross
//! peers*.

use std::collections::{BTreeMap, VecDeque};

use aurora_contracts::{ids, method_by_id, normalize_generated_contract, ContractParseError};
use aurora_mesh_authority::authority::AuthenticatedPeerContext;
use aurora_mesh_authority::types::{
    PeerHostAuthorizationDecision, PeerHostAuthorizeRequest, PeerHostIdentity,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::deferral::{error_frame, not_authorized_body, orchestration_deferred_frame};
use crate::ownership::{inbound_frame_ownership, is_pairing_frame, FrameOwner};

/// How many frames one peer may park before the queue refuses more.
///
/// A queue is a courtesy to a peer whose counterpart went to sleep, not
/// storage. Past this depth the sender is answered with a retryable deferral so
/// it backs off, rather than having its frames silently dropped or the device's
/// memory grown without bound by a peer that keeps talking into the dark.
pub const MAX_QUEUED_FRAMES_PER_PEER: usize = 256;

/// Whether the webview that owns orchestration is awake.
///
/// Dispatch only. See the module docs: this never selects an implementation.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceLifecycle {
    /// The webview is running and can be handed work immediately.
    #[default]
    Foreground,
    /// The webview is frozen. Rust still owns the connection.
    Background,
    /// The webview is awake but is still acknowledging drained background work.
    Resuming,
}

impl SurfaceLifecycle {
    /// Wire spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Foreground => "foreground",
            Self::Background => "background",
            Self::Resuming => "resuming",
        }
    }

    /// True while the webview cannot be handed new work.
    #[must_use]
    pub fn is_background(self) -> bool {
        matches!(self, Self::Background | Self::Resuming)
    }
}

/// Things the registry refuses to do.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum MeshSessionError {
    /// One stable id holds one session. A stable identity presenting on a
    /// second transport is refused, matching what Python already does.
    #[error("peer {peer_id} already holds a session")]
    PeerAlreadyRegistered {
        /// The stable id that already holds a session.
        peer_id: String,
    },
    /// A reconnect binds to the stable id already in the registry. Accepting a
    /// new identity needs pairing, which needs a human (R0 section 5).
    #[error("a backgrounded reconnect may not accept a new stable identity")]
    StableIdentityChangeWhileBackgrounded,
    /// The frame named a peer with no live session.
    #[error("no session for peer {peer_id}")]
    UnknownPeer {
        /// The stable id that was named.
        peer_id: String,
    },
}

/// A frame parked for a peer whose TypeScript half is asleep.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct QueuedFrame {
    /// Wire `type` of the frame.
    pub frame_type: String,
    /// The frame verbatim, so nothing is lost across the freeze.
    pub frame: Value,
    /// Monotonic arrival order within this peer's queue.
    pub sequence: u64,
}

/// A `call` that has been accepted and now needs the authority's answer.
///
/// Carried out of [`MeshSessionRegistry::accept_inbound`] rather than decided
/// inside it, because asking the authority is an async hop the registry has no
/// business owning. The request is built identically in both lifecycles — that
/// is what makes "the same authorization decision it would make in foreground"
/// a property of the code rather than a hope.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct PendingCall {
    /// Peer the call arrived from.
    pub peer_id: String,
    /// Correlation id to answer on.
    pub call_id: String,
    /// Method the caller named.
    pub method_id: String,
    /// Wire `params` from the call frame.
    pub params: Value,
    /// The question for the authority.
    pub authorize: PeerHostAuthorizeRequest,
}

/// What the registry decided to do with one inbound frame.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InboundDisposition {
    /// Rust answers here and now with these outbound frames, in order.
    Answer(Vec<Value>),
    /// Hand it to TypeScript immediately; the webview is awake.
    Dispatch,
    /// Parked in this peer's FIFO. Reports the depth after parking.
    Queued {
        /// Frames now waiting for this peer.
        depth: usize,
    },
    /// The queue is full. Carries a retryable answer when the frame had an id
    /// to answer on, so the sender backs off instead of being ignored.
    Overflow(Option<Value>),
    /// Ask the authority, then [`MeshSessionRegistry::settle_call`].
    Authorize(Box<PendingCall>),
    /// Not a frame type the section 3 table names.
    Unknown,
}

/// What to do with a `call` once the authority has answered.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CallOutcome {
    /// The authority said no. The 403 body carries the authority's own reason,
    /// unchanged by the lifecycle.
    Denied(Value),
    /// Authorized, and Rust can complete it without the webview.
    Serve {
        /// How Rust will execute it.
        execution: BackgroundExecution,
        /// Correlation id to answer on.
        call_id: String,
    },
    /// Authorized, and the orchestrator is awake to run it. The foreground
    /// path, unchanged by R3.
    Orchestrate {
        /// Correlation id to answer on.
        call_id: String,
    },
    /// Authorized, but completing it needs the orchestrator and the
    /// orchestrator is frozen. Section 6's typed deferral, decided *after*
    /// authorization so it leaks nothing.
    Deferred(Value),
}

/// How Rust executes a call without the webview.
///
/// The enum is intentionally limited to the Tooling meta methods. Each handler
/// still projects only the one safe native status tool, and only after the
/// authority has allowed the method and exposed that tool contract id in the
/// decision. Foreground calls continue to the webview provider so the normal
/// catalog is not replaced by this bounded native subset.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackgroundExecution {
    /// `Tooling.GetTools` for the bounded native catalog.
    ToolingGetTools,
    /// `Tooling.GetExportCatalog` for the bounded native catalog.
    ToolingGetExportCatalog,
    /// `Tooling.PrepareExecution` for the bounded native catalog.
    ToolingPrepareExecution,
    /// `Tooling.ExecuteTool` for the bounded native catalog.
    ToolingExecuteTool,
}

/// Real local identity and local native state available to the background
/// executor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackgroundToolingProviderContext {
    /// Stable local peer id of this provider, never the remote recipient.
    pub provider_peer_id: String,
    /// Service instance id for the local Tooling provider.
    pub provider_service_instance_id: String,
    /// Native capability manifest produced by the platform layer.
    pub native_manifest: Value,
}

const NATIVE_GET_DEVICE_STATUS_CONTRACT_ID: &str = "aurora.local.native.get_device_status.v1";
const NATIVE_GET_DEVICE_STATUS_LOCAL_NAME: &str = "native.get_device_status";
const NATIVE_GET_DEVICE_STATUS_PERMISSION: &str = "Native.GetDeviceStatus";
const NATIVE_GET_DEVICE_STATUS_GLOBAL_FALLBACK: &str = "global:native.get_device_status";
const EMPTY_ARGS_SCHEMA_HASH: &str =
    "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

/// Methods Rust can complete without the webview, sorted.
///
/// See [`BackgroundExecution`] for the boundary around this deliberately small
/// set.
#[must_use]
pub fn background_executable_methods() -> Vec<&'static str> {
    vec![
        ids::TOOLING_GET_TOOLS,
        ids::TOOLING_GET_EXPORT_CATALOG,
        ids::TOOLING_PREPARE_EXECUTION,
        ids::TOOLING_EXECUTE_TOOL,
    ]
}

/// How Rust would execute `method_id` in the background, if it can at all.
#[must_use]
pub fn background_execution_for(method_id: &str) -> Option<BackgroundExecution> {
    match method_id {
        ids::TOOLING_GET_TOOLS => Some(BackgroundExecution::ToolingGetTools),
        ids::TOOLING_GET_EXPORT_CATALOG => Some(BackgroundExecution::ToolingGetExportCatalog),
        ids::TOOLING_PREPARE_EXECUTION => Some(BackgroundExecution::ToolingPrepareExecution),
        ids::TOOLING_EXECUTE_TOOL => Some(BackgroundExecution::ToolingExecuteTool),
        _ => None,
    }
}

/// Execute a background Tooling call against the bounded native catalog.
///
/// The caller supplies the authority decision that [`MeshSessionRegistry`]
/// already used to choose [`CallOutcome::Serve`]. This function interprets only
/// granted tool contract ids and the local native manifest; caller-supplied
/// peer ids and permission claims are ignored.
pub fn execute_background_tooling_call(
    pending: &PendingCall,
    decision: &PeerHostAuthorizationDecision,
    context: &BackgroundToolingProviderContext,
) -> Result<Value, ContractParseError> {
    let execution = background_execution_for(&pending.method_id);
    let result = match execution {
        Some(BackgroundExecution::ToolingGetTools) => tooling_get_tools(pending, decision, context),
        Some(BackgroundExecution::ToolingGetExportCatalog) => {
            tooling_get_export_catalog(pending, decision, context)
        }
        Some(BackgroundExecution::ToolingPrepareExecution) => {
            tooling_prepare_execution(pending, decision, context)
        }
        Some(BackgroundExecution::ToolingExecuteTool) => {
            tooling_execute_tool(pending, decision, context)
        }
        None => Err(ContractParseError::UnknownSchema(pending.method_id.clone())),
    }?;
    Ok(result)
}

fn tooling_get_tools(
    pending: &PendingCall,
    decision: &PeerHostAuthorizationDecision,
    context: &BackgroundToolingProviderContext,
) -> Result<Value, ContractParseError> {
    let _request = normalize_input(ids::TOOLING_GET_TOOLS, pending.params.clone())?;
    let tools = granted_tool_list(decision, context);
    result_frame(
        &pending.call_id,
        ids::TOOLING_GET_TOOLS,
        json!({
            "count": tools.len(),
            "tools": tools,
        }),
    )
}

fn tooling_get_export_catalog(
    pending: &PendingCall,
    decision: &PeerHostAuthorizationDecision,
    context: &BackgroundToolingProviderContext,
) -> Result<Value, ContractParseError> {
    let request = normalize_input(ids::TOOLING_GET_EXPORT_CATALOG, pending.params.clone())?;
    let page_size = request
        .get("page_size")
        .and_then(Value::as_u64)
        .unwrap_or(100)
        .clamp(1, 256);
    let tools = granted_tool_list(decision, context);
    let blocked_tools = Vec::<Value>::new();
    let retirements = Vec::<Value>::new();
    let authority_revision = authority_revision(decision);
    let projection_revision = sha256_hex(&authority_revision);
    let projection_digest = sha256_hex(&json!({
        "tools": tools.clone(),
        "blocked_tools": blocked_tools.clone(),
        "retirements": retirements.clone(),
    }));
    let mut output = json!({
        "ok": true,
        "provider_peer_id": context.provider_peer_id,
        "service_instance_id": context.provider_service_instance_id,
        "selected_protocol_tier": "projection_v1",
        "authority_revision": authority_revision,
        "projection_revision": projection_revision,
        "projection_digest": projection_digest,
        "page_index": 0,
        "page_size": page_size,
        "page_hash": "0".repeat(64),
        "tools": tools,
        "blocked_tools": blocked_tools,
        "retirements": retirements,
        "complete": true,
        "next_cursor": null,
        "total_count": tools.len(),
        "final_checksum": projection_digest,
    });
    let page_hash = sha256_hex(&json!({
        "provider_peer_id": output["provider_peer_id"],
        "service_instance_id": output["service_instance_id"],
        "selected_protocol_tier": output["selected_protocol_tier"],
        "authority_revision": output["authority_revision"],
        "projection_revision": output["projection_revision"],
        "projection_digest": output["projection_digest"],
        "page_index": output["page_index"],
        "page_size": output["page_size"],
        "tools": output["tools"],
        "blocked_tools": output["blocked_tools"],
        "retirements": output["retirements"],
        "complete": output["complete"],
        "total_count": output["total_count"],
        "final_checksum": output["final_checksum"],
    }));
    output["page_hash"] = json!(page_hash);
    result_frame(&pending.call_id, ids::TOOLING_GET_EXPORT_CATALOG, output)
}

fn tooling_prepare_execution(
    pending: &PendingCall,
    decision: &PeerHostAuthorizationDecision,
    context: &BackgroundToolingProviderContext,
) -> Result<Value, ContractParseError> {
    let request = normalize_input(ids::TOOLING_PREPARE_EXECUTION, pending.params.clone())?;
    let prepared = prepare_native_execution(&request, decision, context);
    result_frame(&pending.call_id, ids::TOOLING_PREPARE_EXECUTION, prepared)
}

fn tooling_execute_tool(
    pending: &PendingCall,
    decision: &PeerHostAuthorizationDecision,
    context: &BackgroundToolingProviderContext,
) -> Result<Value, ContractParseError> {
    let request = normalize_input(ids::TOOLING_EXECUTE_TOOL, pending.params.clone())?;
    let prepared = prepare_native_execution(&request, decision, context);
    if !prepared["ok"].as_bool().unwrap_or(false) {
        return result_frame(
            &pending.call_id,
            ids::TOOLING_EXECUTE_TOOL,
            denied_execute_response(&request, &prepared),
        );
    }
    if request
        .get("dry_run")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return result_frame(
            &pending.call_id,
            ids::TOOLING_EXECUTE_TOOL,
            json!({
                "ok": true,
                "data": { "dry_run": true },
                "error": null,
                "status": "dry_run",
                "error_code": null,
                "correlation_id": prepared["correlation_id"],
                "provider_peer_id": prepared["provider_peer_id"],
                "global_tool_id": prepared["global_tool_id"],
                "policy_decision_id": prepared["policy_decision"]["decision_id"],
                "display_args_preview": prepared["display_args_preview"],
                "args_hash": prepared["args_hash"],
            }),
        );
    }
    let data = match native_device_status(&context.native_manifest) {
        Ok(data) => data,
        Err(reason) => {
            return result_frame(
                &pending.call_id,
                ids::TOOLING_EXECUTE_TOOL,
                failed_execute_response(&prepared, reason),
            );
        }
    };
    result_frame(
        &pending.call_id,
        ids::TOOLING_EXECUTE_TOOL,
        json!({
            "ok": true,
            "data": data,
            "error": null,
            "status": "success",
            "error_code": null,
            "correlation_id": prepared["correlation_id"],
            "provider_peer_id": prepared["provider_peer_id"],
            "global_tool_id": prepared["global_tool_id"],
            "policy_decision_id": prepared["policy_decision"]["decision_id"],
            "display_args_preview": prepared["display_args_preview"],
            "args_hash": prepared["args_hash"],
        }),
    )
}

fn normalize_input(method_id: &str, value: Value) -> Result<Value, ContractParseError> {
    let descriptor = method_by_id(method_id)
        .ok_or_else(|| ContractParseError::UnknownSchema(method_id.to_owned()))?;
    normalize_generated_contract(descriptor.input_schema_id, value)
}

fn result_frame(
    call_id: &str,
    method_id: &str,
    output: Value,
) -> Result<Value, ContractParseError> {
    let descriptor = method_by_id(method_id)
        .ok_or_else(|| ContractParseError::UnknownSchema(method_id.to_owned()))?;
    let normalized = normalize_generated_contract(descriptor.output_schema_id, output)?;
    Ok(json!({
        "type": "result",
        "id": call_id,
        "result": normalized,
    }))
}

fn granted_tool_list(
    decision: &PeerHostAuthorizationDecision,
    context: &BackgroundToolingProviderContext,
) -> Vec<Value> {
    if !has_native_tool_contract_grant(decision) {
        return Vec::new();
    }
    vec![native_tool_info(context)]
}

fn has_native_tool_contract_grant(decision: &PeerHostAuthorizationDecision) -> bool {
    decision.allowed
        && decision
            .granted_tool_contract_ids
            .as_ref()
            .is_some_and(|ids| {
                ids.iter()
                    .any(|id| id == NATIVE_GET_DEVICE_STATUS_CONTRACT_ID)
            })
}

fn execution_allowed_for_decision(
    method_id: &str,
    decision: &PeerHostAuthorizationDecision,
) -> bool {
    decision.allowed
        && background_execution_for(method_id).is_some()
        && decision
            .granted_method_ids
            .as_ref()
            .is_some_and(|methods| methods.iter().any(|granted| granted == method_id))
}

fn native_tool_info(context: &BackgroundToolingProviderContext) -> Value {
    let global_tool_id = global_tool_id(&context.provider_peer_id);
    let args_schema = json!({
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
    });
    let output_schema = json!({
        "type": "object",
        "properties": {
            "platform": { "type": "string", "minLength": 1, "maxLength": 64 },
            "availableCapabilities": {
                "type": "array",
                "items": { "type": "string", "minLength": 1, "maxLength": 160 },
                "maxItems": 128
            },
            "online": { "type": "boolean" },
            "batteryLevel": { "type": "number", "minimum": 0, "maximum": 1 },
            "charging": { "type": "boolean" }
        },
        "required": ["platform", "availableCapabilities", "online"],
        "additionalProperties": false,
    });
    json!({
        "name": global_tool_id,
        "display_name": "Get device status",
        "namespace": "Tooling",
        "local_name": NATIVE_GET_DEVICE_STATUS_LOCAL_NAME,
        "global_tool_id": global_tool_id,
        "provider_peer_id": context.provider_peer_id,
        "provider_service_instance_id": context.provider_service_instance_id,
        "provenance": {
            "advertised_name": NATIVE_GET_DEVICE_STATUS_LOCAL_NAME,
            "provider_peer_id": context.provider_peer_id,
            "provider_service_instance_id": context.provider_service_instance_id,
            "provider_tool_id": NATIVE_GET_DEVICE_STATUS_CONTRACT_ID,
            "source": "core",
            "stable_source_id": "native.capability",
        },
        "description": "Return bounded local device availability information.",
        "legacy_global_tool_ids": [NATIVE_GET_DEVICE_STATUS_GLOBAL_FALLBACK],
        "tool_id_scheme": "aurora-tool",
        "tool_id_version": 1,
        "tool_contract_id": NATIVE_GET_DEVICE_STATUS_CONTRACT_ID,
        "provider_available": true,
        "provider_granted_permissions": [NATIVE_GET_DEVICE_STATUS_PERMISSION],
        "provider_label": "This device",
        "source": "core",
        "source_id": "native.capability",
        "source_type": "local",
        "execution_location": "local",
        "schema": output_schema,
        "args_schema": args_schema,
        "argument_visibility": {},
        "required_permissions": [NATIVE_GET_DEVICE_STATUS_PERMISSION],
        "resource_scope": [],
        "aliases": [NATIVE_GET_DEVICE_STATUS_CONTRACT_ID, NATIVE_GET_DEVICE_STATUS_LOCAL_NAME],
        "privacy_hints": [],
        "exportable": true,
        "capability_class": "device",
        "trust_tier": "trusted",
        "share_group_id": "native.status",
        "share_group_label": "Device status",
    })
}

fn prepare_native_execution(
    request: &Value,
    decision: &PeerHostAuthorizationDecision,
    context: &BackgroundToolingProviderContext,
) -> Value {
    let reason = native_prepare_denial_reason(request, decision);
    let allowed = reason.is_none();
    let tool_info = native_tool_info(context);
    let arguments = request
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let args_hash = sha256_hex(&arguments);
    let resource_selector_hash = resource_selector_hash(request);
    let route_decision_id = sha256_hex(&json!({
        "provider_peer_id": context.provider_peer_id,
        "provider_service_instance_id": context.provider_service_instance_id,
        "global_tool_id": tool_info["global_tool_id"],
        "local_tool_name": NATIVE_GET_DEVICE_STATUS_LOCAL_NAME,
        "resource_selector_hash": resource_selector_hash,
    }));
    let decision_id = sha256_hex(&json!({
        "route_decision_id": route_decision_id,
        "args_hash": args_hash,
        "approval_required": false,
    }));
    json!({
        "ok": allowed,
        "policy_decision": {
            "allowed": allowed,
            "share": allowed,
            "approval_required": false,
            "approval_mode": if allowed { "approve_all_local_safe" } else { "deny_all" },
            "decision_id": decision_id,
            "policy_rule_id": null,
            "reason": reason,
            "auto_approved_reason": if allowed { json!("local_safe_tool") } else { Value::Null },
            "effective_default": if allowed { json!("approve_all_local_safe") } else { json!("deny_all") },
            "grant_id": null,
            "grant_scope": null,
            "token_ttl_seconds": 0,
        },
        "args_hash": args_hash,
        "resource_selector_hash": resource_selector_hash,
        "route_decision_id": route_decision_id,
        "correlation_id": request.get("correlation_id").and_then(Value::as_str).unwrap_or(&route_decision_id),
        "provider_peer_id": context.provider_peer_id,
        "provider_service_instance_id": context.provider_service_instance_id,
        "global_tool_id": tool_info["global_tool_id"],
        "local_tool_name": NATIVE_GET_DEVICE_STATUS_LOCAL_NAME,
        "args_schema_hash": EMPTY_ARGS_SCHEMA_HASH,
        "source": "core",
        "source_id": "native.capability",
        "trust_tier": "trusted",
        "capability_class": "device",
        "resource_scope": [],
        "display_args_preview": {},
        "argument_visibility": {},
        "secrets_redacted": true,
    })
}

fn native_prepare_denial_reason(
    request: &Value,
    decision: &PeerHostAuthorizationDecision,
) -> Option<&'static str> {
    if !tool_name_matches(request.get("tool_name").and_then(Value::as_str)) {
        return Some("tool_not_found");
    }
    if !has_native_tool_contract_grant(decision) {
        return Some("tool_not_granted");
    }
    if request
        .get("approval_token")
        .and_then(Value::as_str)
        .is_some_and(|token| !token.is_empty())
        || request
            .get("confirmed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return Some("approval_not_supported");
    }
    if !request
        .get("arguments")
        .and_then(Value::as_object)
        .is_some_and(serde_json::Map::is_empty)
    {
        return Some("argument_schema_invalid");
    }
    if request
        .get("expected_args_schema_hash")
        .and_then(Value::as_str)
        .is_some_and(|hash| hash != EMPTY_ARGS_SCHEMA_HASH)
    {
        return Some("args_schema_hash_mismatch");
    }
    None
}

fn denied_execute_response(request: &Value, prepared: &Value) -> Value {
    let reason = prepared["policy_decision"]["reason"]
        .as_str()
        .unwrap_or("policy_denied");
    json!({
        "ok": false,
        "data": null,
        "error": if reason == "tool_not_found" { "Tool not found" } else { "Tool execution denied" },
        "status": if reason == "tool_not_found" { "not_found" } else { "denied" },
        "error_code": reason,
        "correlation_id": request.get("correlation_id").cloned().unwrap_or(Value::Null),
        "provider_peer_id": prepared["provider_peer_id"],
        "global_tool_id": prepared["global_tool_id"],
        "policy_decision_id": prepared["policy_decision"]["decision_id"],
        "display_args_preview": {},
        "args_hash": prepared["args_hash"],
    })
}

fn failed_execute_response(prepared: &Value, reason: &'static str) -> Value {
    json!({
        "ok": false,
        "data": null,
        "error": "Tool execution failed",
        "status": "failed",
        "error_code": reason,
        "correlation_id": prepared["correlation_id"],
        "provider_peer_id": prepared["provider_peer_id"],
        "global_tool_id": prepared["global_tool_id"],
        "policy_decision_id": prepared["policy_decision"]["decision_id"],
        "display_args_preview": prepared["display_args_preview"],
        "args_hash": prepared["args_hash"],
    })
}

fn native_device_status(manifest: &Value) -> Result<Value, &'static str> {
    let Some(platform) = manifest.get("platform").and_then(Value::as_str) else {
        return Err("native_manifest_invalid");
    };
    if platform.is_empty() || platform.len() > 64 {
        return Err("native_manifest_invalid");
    }
    let mut capabilities = manifest
        .get("capabilities")
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .filter_map(|(key, value)| {
                    value
                        .as_bool()
                        .filter(|available| *available)
                        .map(|_| key.clone())
                })
                .filter(|key| !key.is_empty() && key.len() <= 160)
                .take(128)
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    capabilities.sort();
    capabilities.dedup();
    let mut output = json!({
        "platform": platform,
        "availableCapabilities": capabilities,
        "online": true,
    });
    if let Some(level) = manifest.get("batteryLevel").and_then(Value::as_f64) {
        if (0.0..=1.0).contains(&level) {
            output["batteryLevel"] = json!(level);
        }
    }
    if let Some(charging) = manifest.get("charging").and_then(Value::as_bool) {
        output["charging"] = json!(charging);
    }
    Ok(output)
}

fn resource_selector_hash(request: &Value) -> String {
    let mesh = request
        .get("mesh_selector")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    sha256_hex(&json!({
        "resource_selector": request.get("resource_selector").cloned().unwrap_or_else(|| json!({})),
        "mesh_resource_namespace": mesh.get("resource_namespace").cloned().unwrap_or(Value::Null),
        "mesh_hardware_target": mesh.get("hardware_target").cloned().unwrap_or(Value::Null),
        "mesh_data_scope": mesh.get("data_scope").cloned().unwrap_or(Value::Null),
        "mesh_tool_id": mesh.get("tool_id").cloned().unwrap_or(Value::Null),
    }))
}

fn authority_revision(decision: &PeerHostAuthorizationDecision) -> Value {
    let auth_grant_revision = decision.grant_revision.unwrap_or_default().max(0);
    json!({
        "auth_grant_revision": auth_grant_revision,
        "catalog_revision": 1,
        "export_policy_revision": auth_grant_revision,
        "manifest_revision": 1,
        "protocol_revision": 1,
        "switch_revision": auth_grant_revision,
    })
}

fn tool_name_matches(tool_name: Option<&str>) -> bool {
    matches!(
        tool_name,
        Some(name)
            if name == NATIVE_GET_DEVICE_STATUS_CONTRACT_ID
                || name == NATIVE_GET_DEVICE_STATUS_LOCAL_NAME
                || name == NATIVE_GET_DEVICE_STATUS_GLOBAL_FALLBACK
                || name.starts_with("aurora-tool:v1:") && name.ends_with(":Tooling:aurora.local.native.get_device_status.v1")
    )
}

fn global_tool_id(provider_peer_id: &str) -> String {
    format!(
        "aurora-tool:v1:{}:Tooling:{}",
        percent_encode_identity_component(provider_peer_id),
        percent_encode_identity_component(NATIVE_GET_DEVICE_STATUS_CONTRACT_ID)
    )
}

fn percent_encode_identity_component(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| match *byte {
            b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z' | b'-' | b'.' | b'_' | b'~' => {
                (*byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

fn sha256_hex(value: &Value) -> String {
    let canonical = canonical_json(value);
    let digest = Sha256::digest(canonical.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(true) => "true".to_owned(),
        Value::Bool(false) => "false".to_owned(),
        Value::Number(number) => number.to_string(),
        Value::String(string) => serde_json::to_string(string).expect("json string serializes"),
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<String>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, item)| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("json key serializes"),
                        canonical_json(item)
                    ))
                    .collect::<Vec<String>>()
                    .join(",")
            )
        }
    }
}

/// One peer's live session, from the transport's point of view.
#[derive(Clone, Debug)]
pub struct MeshPeerSession {
    peer_id: String,
    connection_id: u64,
    context: Option<AuthenticatedPeerContext>,
    queue: VecDeque<QueuedFrame>,
    next_sequence: u64,
    answered_pings: u64,
    served_calls: u64,
    deferred_calls: u64,
    denied_calls: u64,
}

impl MeshPeerSession {
    /// Stable peer id this session belongs to.
    #[must_use]
    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    /// Native peer-connection handle carrying the session.
    #[must_use]
    pub fn connection_id(&self) -> u64 {
        self.connection_id
    }

    /// Frames waiting for TypeScript to wake up.
    #[must_use]
    pub fn queue_depth(&self) -> usize {
        self.queue.len()
    }

    /// Pings answered in Rust for this peer since the session opened.
    #[must_use]
    pub fn answered_pings(&self) -> u64 {
        self.answered_pings
    }

    /// The reference this session holds to what the reconnect proof established.
    ///
    /// A reference, never a grant: every authorization question still goes to
    /// the authority. The registry stores it so an inbound call can be
    /// authorized with the *right peer's* context and no other's.
    #[must_use]
    pub fn authenticated_peer_context(&self) -> Option<&AuthenticatedPeerContext> {
        self.context.as_ref()
    }

    /// A snapshot for diagnostics and the roster projection.
    #[must_use]
    pub fn snapshot(&self) -> Value {
        json!({
            "peerId": self.peer_id,
            "connectionId": self.connection_id,
            "queueDepth": self.queue.len(),
            "answeredPings": self.answered_pings,
            "servedCalls": self.served_calls,
            "deferredCalls": self.deferred_calls,
            "deniedCalls": self.denied_calls,
        })
    }
}

/// Every peer this device holds a data channel to.
///
/// Keyed by stable peer id, one session each. The registry is the transport
/// half of the boundary note's split: it knows *who am I connected to and how
/// is that connection doing*, and asks the authority everything else.
#[derive(Debug, Default)]
pub struct MeshSessionRegistry {
    sessions: BTreeMap<String, MeshPeerSession>,
    lifecycle: SurfaceLifecycle,
}

impl MeshSessionRegistry {
    /// An empty registry, foreground.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the webview is awake.
    #[must_use]
    pub fn lifecycle(&self) -> SurfaceLifecycle {
        self.lifecycle
    }

    /// How many peers hold a live session.
    #[must_use]
    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    /// True when no peer holds a session.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    /// Stable peer ids with a live session, sorted.
    #[must_use]
    pub fn peer_ids(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }

    /// One peer's session.
    #[must_use]
    pub fn session(&self, peer_id: &str) -> Option<&MeshPeerSession> {
        self.sessions.get(peer_id)
    }

    /// Register a peer's session.
    ///
    /// Refuses a stable id that already holds one. One stable id, one session.
    pub fn bind(
        &mut self,
        peer_id: &str,
        connection_id: u64,
        context: Option<AuthenticatedPeerContext>,
    ) -> Result<(), MeshSessionError> {
        if let Some(existing) = self.sessions.get(peer_id) {
            if existing.connection_id != connection_id {
                return Err(MeshSessionError::PeerAlreadyRegistered {
                    peer_id: peer_id.to_owned(),
                });
            }
        }
        // A reconnect binds to the stable id already in the registry. Minting a
        // new one is pairing, and pairing needs a human (R0 section 5).
        if self.lifecycle.is_background() && !self.sessions.contains_key(peer_id) {
            let rebinding_known_connection = self
                .sessions
                .values()
                .any(|session| session.connection_id == connection_id);
            if rebinding_known_connection {
                return Err(MeshSessionError::StableIdentityChangeWhileBackgrounded);
            }
        }
        let session = self
            .sessions
            .entry(peer_id.to_owned())
            .or_insert_with(|| MeshPeerSession {
                peer_id: peer_id.to_owned(),
                connection_id,
                context: None,
                queue: VecDeque::new(),
                next_sequence: 0,
                answered_pings: 0,
                served_calls: 0,
                deferred_calls: 0,
                denied_calls: 0,
            });
        // Refreshing the context on reconnect is allowed; widening a grant is
        // not, and cannot happen here because no grant is stored.
        if context.is_some() {
            session.context = context;
        }
        Ok(())
    }

    /// Drop a peer's session and everything parked for it.
    ///
    /// Returns whether a session was there to drop.
    pub fn unbind(&mut self, peer_id: &str) -> bool {
        self.sessions.remove(peer_id).is_some()
    }

    /// Move the surface between foreground and background.
    ///
    /// Returns the frames that were parked while the webview slept, per peer,
    /// in arrival order. Moving *into* the background parks nothing and returns
    /// nothing; moving back out enters the resuming state and returns the first
    /// drain batch. The caller must acknowledge drained batches with
    /// [`Self::finish_resume`] until it returns empty, which is the point at
    /// which new frames may dispatch directly to the webview again.
    pub fn set_lifecycle(
        &mut self,
        lifecycle: SurfaceLifecycle,
    ) -> Vec<(String, Vec<QueuedFrame>)> {
        match lifecycle {
            SurfaceLifecycle::Foreground if self.lifecycle.is_background() => {
                self.lifecycle = SurfaceLifecycle::Resuming;
                self.drain_all()
            }
            SurfaceLifecycle::Foreground => {
                self.lifecycle = SurfaceLifecycle::Foreground;
                Vec::new()
            }
            SurfaceLifecycle::Background => {
                self.lifecycle = SurfaceLifecycle::Background;
                Vec::new()
            }
            SurfaceLifecycle::Resuming => Vec::new(),
        }
    }

    /// Acknowledge that the caller has handed the last drained batch to the
    /// webview, then drain anything that arrived during that handoff.
    ///
    /// The registry stays in `resuming` while this returns frames. Only an
    /// empty acknowledged drain moves it to `foreground`, preserving arrival
    /// order across the resume boundary.
    pub fn finish_resume(&mut self) -> Vec<(String, Vec<QueuedFrame>)> {
        if self.lifecycle != SurfaceLifecycle::Resuming {
            return Vec::new();
        }
        let drained = self.drain_all();
        if drained.is_empty() {
            self.lifecycle = SurfaceLifecycle::Foreground;
        }
        drained
    }

    /// Everything parked, per peer, in arrival order, leaving the queues empty.
    ///
    /// Peers come out in stable-id order and each peer's frames come out in the
    /// order they arrived. Nothing new is dispatched for a peer until its own
    /// backlog has been handed over, which is what the ordering guarantee in
    /// section 3 asks for.
    pub fn drain_all(&mut self) -> Vec<(String, Vec<QueuedFrame>)> {
        self.sessions
            .iter_mut()
            .filter(|(_, session)| !session.queue.is_empty())
            .map(|(peer_id, session)| {
                let frames: Vec<QueuedFrame> = session.queue.drain(..).collect();
                (peer_id.clone(), frames)
            })
            .collect()
    }

    /// One peer's backlog, in arrival order, leaving its queue empty.
    pub fn drain_peer(&mut self, peer_id: &str) -> Result<Vec<QueuedFrame>, MeshSessionError> {
        let session =
            self.sessions
                .get_mut(peer_id)
                .ok_or_else(|| MeshSessionError::UnknownPeer {
                    peer_id: peer_id.to_owned(),
                })?;
        Ok(session.queue.drain(..).collect())
    }

    /// Classify one inbound frame and decide what happens to it.
    ///
    /// `now_ms` is the evaluation instant handed to the authority, so the
    /// caller owns the clock and a test can pin it.
    pub fn accept_inbound(
        &mut self,
        peer_id: &str,
        frame: &Value,
        now_ms: i64,
    ) -> Result<InboundDisposition, MeshSessionError> {
        let lifecycle = self.lifecycle;
        if !self.sessions.contains_key(peer_id) {
            return Err(MeshSessionError::UnknownPeer {
                peer_id: peer_id.to_owned(),
            });
        }
        let Some(frame_type) = frame.get("type").and_then(Value::as_str) else {
            return Ok(InboundDisposition::Unknown);
        };
        let Some(ownership) = inbound_frame_ownership(frame_type) else {
            return Ok(InboundDisposition::Unknown);
        };

        // `ping` is answered here in both lifecycles. This is the whole reason
        // a backgrounded phone keeps its session: Python's stale window is 120
        // seconds without a pong, and a frozen webview cannot answer inside it.
        if frame_type == "ping" && ownership.served_by_rust_today {
            let session = self.session_mut(peer_id)?;
            session.answered_pings += 1;
            let id = frame.get("id").and_then(Value::as_str);
            return Ok(InboundDisposition::Answer(vec![pong_frame(id)]));
        }

        // An inbound `call` is authorized before anything else is decided about
        // it, background or not. Deferring before authorizing would tell an
        // unauthorized caller that a grant exists.
        if frame_type == "call" && ownership.served_by_rust_today {
            if let Some(pending) = self.build_pending_call(peer_id, frame, now_ms) {
                return Ok(InboundDisposition::Authorize(Box::new(pending)));
            }
            return Ok(InboundDisposition::Unknown);
        }

        if !lifecycle.is_background() {
            return Ok(InboundDisposition::Dispatch);
        }

        // Backgrounded, and this frame needs someone who is asleep. Park it.
        // Pairing frames land here too: a pairing attempt arriving at a
        // backgrounded peer is deferred, never denied and never answered, so a
        // legitimate peer is not pushed into a failure path by the other
        // side's lifecycle, and no SAS exchange advances without a human.
        debug_assert!(
            !(is_pairing_frame(frame_type) && ownership.owner == FrameOwner::Rust),
            "pairing must stay TypeScript-owned"
        );
        self.enqueue(peer_id, frame_type, frame)
    }

    /// Turn the authority's answer into the frame the caller gets.
    ///
    /// Denial and deferral are both answers; neither evicts the peer, drops its
    /// lease, or costs a re-pair.
    pub fn settle_call(
        &mut self,
        pending: &PendingCall,
        decision: &PeerHostAuthorizationDecision,
    ) -> Result<CallOutcome, MeshSessionError> {
        let lifecycle = self.lifecycle;
        let session = self.session_mut(&pending.peer_id)?;
        if !decision.allowed {
            session.denied_calls += 1;
            let body = not_authorized_body(decision.reason_code.as_deref());
            return Ok(CallOutcome::Denied(error_frame(&pending.call_id, &body)));
        }
        if lifecycle.is_background()
            && background_execution_for(&pending.method_id)
                .is_some_and(|_| execution_allowed_for_decision(&pending.method_id, decision))
        {
            session.served_calls += 1;
            return Ok(CallOutcome::Serve {
                execution: background_execution_for(&pending.method_id).expect("checked above"),
                call_id: pending.call_id.clone(),
            });
        }
        if lifecycle.is_background() {
            session.deferred_calls += 1;
            return Ok(CallOutcome::Deferred(orchestration_deferred_frame(
                &pending.call_id,
            )));
        }
        // Foreground and not executable here: the orchestrator is awake, so the
        // call goes to it and nothing is answered from this module.
        Ok(CallOutcome::Orchestrate {
            call_id: pending.call_id.clone(),
        })
    }

    /// Per-peer counters, for the roster projection and the soak report.
    #[must_use]
    pub fn snapshot(&self) -> Value {
        json!({
            "lifecycle": self.lifecycle.as_str(),
            "peers": self
                .sessions
                .values()
                .map(MeshPeerSession::snapshot)
                .collect::<Vec<Value>>(),
        })
    }

    fn session_mut(&mut self, peer_id: &str) -> Result<&mut MeshPeerSession, MeshSessionError> {
        self.sessions
            .get_mut(peer_id)
            .ok_or_else(|| MeshSessionError::UnknownPeer {
                peer_id: peer_id.to_owned(),
            })
    }

    fn enqueue(
        &mut self,
        peer_id: &str,
        frame_type: &str,
        frame: &Value,
    ) -> Result<InboundDisposition, MeshSessionError> {
        let session = self.session_mut(peer_id)?;
        if session.queue.len() >= MAX_QUEUED_FRAMES_PER_PEER {
            let answer = frame
                .get("id")
                .and_then(Value::as_str)
                .map(orchestration_deferred_frame);
            return Ok(InboundDisposition::Overflow(answer));
        }
        let sequence = session.next_sequence;
        session.next_sequence += 1;
        session.queue.push_back(QueuedFrame {
            frame_type: frame_type.to_owned(),
            frame: frame.clone(),
            sequence,
        });
        Ok(InboundDisposition::Queued {
            depth: session.queue.len(),
        })
    }

    /// Build the authority question for an inbound `call`.
    ///
    /// Depends on the frame, the peer's own authenticated context and the
    /// clock, and on nothing else. In particular it does not read the
    /// lifecycle, which is what makes the decision identical in the foreground
    /// and in the background.
    fn build_pending_call(&self, peer_id: &str, frame: &Value, now_ms: i64) -> Option<PendingCall> {
        let call_id = frame.get("id").and_then(Value::as_str)?.to_owned();
        let method_id = frame.get("method").and_then(Value::as_str)?.to_owned();
        let session = self.sessions.get(peer_id)?;
        let identity = inbound_identity(frame, peer_id);
        Some(PendingCall {
            peer_id: peer_id.to_owned(),
            call_id,
            params: frame.get("params").cloned().unwrap_or_else(|| json!({})),
            authorize: PeerHostAuthorizeRequest {
                remote_peer_id: peer_id.to_owned(),
                method_id: method_id.clone(),
                // The descriptor's required permissions are the registry's to
                // supply; the authority reads them from the request, and the
                // caller fills them in from the contract registry before the
                // hop. Left empty here so this module never becomes a second
                // opinion about what a method demands.
                required_permissions: Vec::new(),
                identity,
                authenticated_peer_context: session.context.clone(),
                now_ms,
            },
            method_id,
        })
    }
}

/// The `pong` answering a `ping`, correlated when the ping carried an id.
#[must_use]
pub fn pong_frame(ping_id: Option<&str>) -> Value {
    match ping_id {
        Some(id) => json!({ "type": "pong", "id": id }),
        None => json!({ "type": "pong" }),
    }
}

/// What a `call` claims about its caller.
///
/// The claim is recorded, never believed: the authority decides, and it is
/// handed the peer id the frame actually arrived on rather than the one the
/// frame says it came from.
fn inbound_identity(frame: &Value, peer_id: &str) -> PeerHostIdentity {
    let claimed = frame.get("identity");
    PeerHostIdentity {
        caller_peer_id: peer_id.to_owned(),
        principal_id: claimed
            .and_then(|identity| identity.get("principalId"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        effective_permissions: claimed
            .and_then(|identity| identity.get("effectivePermissions"))
            .and_then(Value::as_array)
            .map(|permissions| {
                permissions
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        auth_grant_revision: claimed
            .and_then(|identity| identity.get("authGrantRevision"))
            .and_then(Value::as_i64),
        manifest_revision: claimed
            .and_then(|identity| identity.get("manifestRevision"))
            .cloned(),
    }
}

/// Whether the one Aurora foreground service is being held open for a device
/// connection, and what has to change to keep that true.
///
/// R4 built a reference-counted ledger inside the Android service, shared by
/// voice and mesh so there is one service and one entry in the notification
/// shade. R3 is its first mesh caller. This is the small piece of that
/// decision that is worth testing without an Android runtime: given how many
/// sessions are held, does this process need to take a hold, drop one, or do
/// nothing?
///
/// It is deliberately idempotent. It takes at most one hold and releases at
/// most one, so a session that flaps cannot run the service's reference count
/// away from the number of sessions that actually exist -- which would either
/// strand the notification in the shade forever or drop the hold while a
/// session is still being served.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DeviceLinkLedger {
    held: bool,
}

/// What the caller must do to the foreground service's device-link reason.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeviceLinkAction {
    /// Take the connected-device reason, starting the service if it is the first.
    Hold,
    /// Drop it, stopping the service if it was the last reason.
    Release,
}

impl DeviceLinkLedger {
    /// A ledger holding nothing.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether this process currently holds the device-link reason.
    #[must_use]
    pub fn is_held(self) -> bool {
        self.held
    }

    /// Reconcile the hold against the number of sessions being served.
    ///
    /// Returns what the caller must do, or nothing when the hold already
    /// matches reality.
    pub fn sync(&mut self, session_count: usize) -> Option<DeviceLinkAction> {
        let wanted = session_count > 0;
        if wanted == self.held {
            return None;
        }
        self.held = wanted;
        Some(if wanted {
            DeviceLinkAction::Hold
        } else {
            DeviceLinkAction::Release
        })
    }
}

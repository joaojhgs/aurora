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
//! without TypeScript. On resume the queue drains **in arrival order** before
//! any new frame is dispatched. R3's "drains queued frames in order on resume"
//! is a test against this queue, not an aspiration. Queues never merge: a
//! frame parked for peer A is invisible to peer B, which is the transport-side
//! half of *authority contexts never cross peers*.

use std::collections::{BTreeMap, VecDeque};

use aurora_mesh_authority::authority::AuthenticatedPeerContext;
use aurora_mesh_authority::types::{
    PeerHostAuthorizationDecision, PeerHostAuthorizeRequest, PeerHostIdentity,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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
}

impl SurfaceLifecycle {
    /// Wire spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Foreground => "foreground",
            Self::Background => "background",
        }
    }

    /// True while the webview cannot be handed work.
    #[must_use]
    pub fn is_background(self) -> bool {
        matches!(self, Self::Background)
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
    /// The call's `params`, carried verbatim to the native executor.
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
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackgroundExecution {
    /// Return the bounded native background tool catalog.
    GetTools,
    /// Return the recipient projection for the bounded native catalog.
    GetExportCatalog,
    /// Prepare execution for a bounded native tool without asking the webview.
    PrepareExecution,
    /// Execute a bounded native tool without asking the webview.
    ExecuteTool,
}

/// Methods Rust can complete without the webview, sorted.
///
/// Empty today. See [`BackgroundExecution`] for why, and for what changes it.
#[must_use]
pub fn background_executable_methods() -> Vec<&'static str> {
    vec![
        "Tooling.GetTools",
        "Tooling.GetExportCatalog",
        "Tooling.PrepareExecution",
        "Tooling.ExecuteTool",
    ]
}

/// How Rust would execute `method_id` in the background, if it can at all.
#[must_use]
pub fn background_execution_for(method_id: &str) -> Option<BackgroundExecution> {
    match method_id {
        "Tooling.GetTools" => Some(BackgroundExecution::GetTools),
        "Tooling.GetExportCatalog" => Some(BackgroundExecution::GetExportCatalog),
        "Tooling.PrepareExecution" => Some(BackgroundExecution::PrepareExecution),
        "Tooling.ExecuteTool" => Some(BackgroundExecution::ExecuteTool),
        _ => None,
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
    /// nothing; moving back out is what drains.
    pub fn set_lifecycle(
        &mut self,
        lifecycle: SurfaceLifecycle,
    ) -> Vec<(String, Vec<QueuedFrame>)> {
        let was_background = self.lifecycle.is_background();
        self.lifecycle = lifecycle;
        if !was_background || lifecycle.is_background() {
            return Vec::new();
        }
        self.drain_all()
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
        if lifecycle.is_background() {
            if let Some(execution) = background_execution_for(&pending.method_id) {
                session.served_calls += 1;
                return Ok(CallOutcome::Serve {
                    execution,
                    call_id: pending.call_id.clone(),
                });
            }
            session.deferred_calls += 1;
            return Ok(CallOutcome::Deferred(orchestration_deferred_frame(
                &pending.call_id,
            )));
        }
        // Foreground: the orchestrator is awake, so the call goes to it and
        // nothing is answered from this module.
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
        let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));
        let session = self.sessions.get(peer_id)?;
        let identity = inbound_identity(frame, peer_id);
        Some(PendingCall {
            peer_id: peer_id.to_owned(),
            call_id,
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
            params,
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

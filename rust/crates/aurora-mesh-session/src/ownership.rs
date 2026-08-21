//! The R0 frame-ownership table, encoded.
//!
//! `docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md` section 3 assigns every protocol
//! frame to Rust or to TypeScript with one rule: *a frame belongs to Rust if it
//! can be answered correctly with the webview frozen, and to TypeScript if
//! answering it needs a human or the orchestrator.* This module is that table
//! as data, so the assignment is checkable rather than scattered through a
//! dispatcher.
//!
//! Two columns, deliberately separate:
//!
//! * [`FrameOwnership::owner`] is the **target** ownership the boundary note
//!   settles. It does not move when an implementation catches up.
//! * [`FrameOwnership::served_by_rust_today`] is what *this* build actually
//!   answers without the webview. It is narrower than `owner`, and the gap is
//!   deliberate: R3 lands liveness and inbound call serving, while the frames
//!   whose handling still lives in `mesh-peer-bridge.ts` keep being dispatched
//!   into TypeScript when it is awake and queued when it is not.
//!
//! Keeping both means the gap is visible and a test can fail loudly when a
//! claim outruns the code, instead of the table quietly describing an
//! aspiration.

use serde::{Deserialize, Serialize};

/// Which side of the boundary a frame belongs to once R3 is complete.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FrameOwner {
    /// Answered by Rust, with the webview frozen or awake.
    Rust,
    /// Needs a human or the orchestrator, so it belongs to TypeScript.
    TypeScript,
    /// Rust on a reconnect it already holds a credential for, TypeScript on
    /// first contact. Section 5 of the boundary note is the permission
    /// envelope for the Rust half.
    RustOnReconnect,
}

/// Whether a frame can be completed while the webview is frozen.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundCapability {
    /// Completable in the background.
    Yes,
    /// Not completable in the background. Deferred, never refused: a frozen
    /// webview must not look like a peer that went away.
    No,
    /// Completable only for a reconnect, never for first contact.
    ReconnectOnly,
    /// Some instances complete and some do not; the dispatcher decides per
    /// frame. `event` is the only row: Rust emits what it sources, and events
    /// the orchestrator sources queue.
    Partial,
}

/// One row of the section 3 table.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct FrameOwnership {
    /// Wire `type` of the frame.
    pub frame_type: &'static str,
    /// Where the boundary note puts it.
    pub owner: FrameOwner,
    /// Whether it survives a frozen webview.
    pub background: BackgroundCapability,
    /// Whether *this build* answers it without the webview.
    ///
    /// Narrower than [`Self::owner`] on purpose — see the module docs.
    pub served_by_rust_today: bool,
}

/// The section 3 table, for inbound frames.
///
/// Inbound is the direction the background dispatcher sees: these are frames
/// that arrived on the data channel and need an answer or a home. Outbound
/// frames are the dispatcher's own output and are not classified here.
pub const INBOUND_FRAME_OWNERSHIP: &[FrameOwnership] = &[
    // Rust fragments, so Rust owns the negotiated result — section 4.
    row("protocol_hello", FrameOwner::Rust, BackgroundCapability::Yes, false),
    // Fragmentation and reassembly, including the 65,535-byte ceiling.
    row("fragment", FrameOwner::Rust, BackgroundCapability::Yes, false),
    // R3's headline: hold the session past Python's 120 s stale window.
    row("ping", FrameOwner::Rust, BackgroundCapability::Yes, true),
    // Resolves a liveness probe this side originated, which TypeScript holds.
    row("pong", FrameOwner::TypeScript, BackgroundCapability::No, false),
    // Reconnect proof is deterministic from a durable credential.
    row("mesh_auth_challenge_v1", FrameOwner::Rust, BackgroundCapability::Yes, false),
    // Single-use per peer; the replay guard moves with the frame.
    row("mesh_auth_proof_v1", FrameOwner::Rust, BackgroundCapability::Yes, false),
    // Credential presentation only, never credential creation.
    row("auth", FrameOwner::Rust, BackgroundCapability::Yes, false),
    row("reauth", FrameOwner::Rust, BackgroundCapability::Yes, false),
    // SAS needs a human comparing a code, so pairing never runs backgrounded.
    row("pairing_v2_commit", FrameOwner::TypeScript, BackgroundCapability::No, false),
    row("pairing_v2_reveal", FrameOwner::TypeScript, BackgroundCapability::No, false),
    row("pairing_v2_terminal", FrameOwner::TypeScript, BackgroundCapability::No, false),
    // Authorize, then serve against the local data commands or defer — section 6.
    row("call", FrameOwner::Rust, BackgroundCapability::Yes, true),
    // Resolve a pending RPC this side originated.
    row("result", FrameOwner::TypeScript, BackgroundCapability::No, false),
    row("error", FrameOwner::TypeScript, BackgroundCapability::No, false),
    // Stream framing; delivery into TypeScript resumes on thaw.
    row("chunk", FrameOwner::Rust, BackgroundCapability::Yes, false),
    row("eof", FrameOwner::Rust, BackgroundCapability::Yes, false),
    // Must reach in-flight work whatever language it runs in. Not answered
    // here today: this build starts no work of its own, so there is nothing in
    // Rust for a cancel to reach and it goes where the work is.
    row("cancel", FrameOwner::Rust, BackgroundCapability::Yes, false),
    // Fan-out to UI subscribers on the way in; Rust sources some on the way out.
    row("event", FrameOwner::TypeScript, BackgroundCapability::Partial, false),
    // Admission is an authority decision.
    row("subscribe", FrameOwner::Rust, BackgroundCapability::Yes, false),
    row("unsubscribe", FrameOwner::Rust, BackgroundCapability::Yes, false),
    row("subscribed", FrameOwner::TypeScript, BackgroundCapability::No, false),
    row("subscribe_rejected", FrameOwner::TypeScript, BackgroundCapability::No, false),
    row("unsubscribed", FrameOwner::TypeScript, BackgroundCapability::No, false),
    // Manifest content derives from the authority and the contract registry.
    row("manifest", FrameOwner::Rust, BackgroundCapability::Yes, false),
    row("manifest_request", FrameOwner::Rust, BackgroundCapability::Yes, false),
    row("manifest_ack", FrameOwner::Rust, BackgroundCapability::Yes, false),
    // Lease renewal is a timer that must survive the background.
    row("provider_lease", FrameOwner::Rust, BackgroundCapability::Yes, false),
    row("provider_unavailable", FrameOwner::Rust, BackgroundCapability::Yes, false),
    row("capacity_update", FrameOwner::Rust, BackgroundCapability::Yes, false),
    // Roster observation, projected into TypeScript for the UI.
    row("presence", FrameOwner::Rust, BackgroundCapability::Yes, false),
    row("presence_departed", FrameOwner::Rust, BackgroundCapability::Yes, false),
    // Rust on reconnect, TypeScript on first contact — section 5.
    row("offer", FrameOwner::RustOnReconnect, BackgroundCapability::ReconnectOnly, false),
    row("answer", FrameOwner::RustOnReconnect, BackgroundCapability::ReconnectOnly, false),
    row("candidate", FrameOwner::RustOnReconnect, BackgroundCapability::ReconnectOnly, false),
    row("mesh_event", FrameOwner::TypeScript, BackgroundCapability::No, false),
];

const fn row(
    frame_type: &'static str,
    owner: FrameOwner,
    background: BackgroundCapability,
    served_by_rust_today: bool,
) -> FrameOwnership {
    FrameOwnership {
        frame_type,
        owner,
        background,
        served_by_rust_today,
    }
}

/// The section 3 row for an inbound frame type, if the table names it.
///
/// The lookup takes the frame type and nothing else. It never consults the
/// surface lifecycle: *runtime is chosen by platform, never by lifecycle*, and
/// a table that could read the lifecycle would be the first place that
/// invariant rotted.
#[must_use]
pub fn inbound_frame_ownership(frame_type: &str) -> Option<FrameOwnership> {
    INBOUND_FRAME_OWNERSHIP
        .iter()
        .find(|entry| entry.frame_type == frame_type)
        .copied()
}

/// Frame types this build answers without the webview, sorted.
///
/// Exists so a test can pin the gap between the settled table and the shipped
/// dispatcher, and fail when either side moves without the other.
#[must_use]
pub fn frames_served_by_rust_today() -> Vec<&'static str> {
    let mut served: Vec<&'static str> = INBOUND_FRAME_OWNERSHIP
        .iter()
        .filter(|entry| entry.served_by_rust_today)
        .map(|entry| entry.frame_type)
        .collect();
    served.sort_unstable();
    served
}

/// Pairing frames, which never originate or complete while backgrounded.
///
/// Room membership is not authority: every peer needs its own SAS pairing and
/// explicit approval, and that needs a human. A pairing frame arriving at a
/// backgrounded peer is deferred, not denied, so a legitimate peer is not
/// pushed into a failure path by the other side's lifecycle.
pub const PAIRING_FRAME_TYPES: [&str; 3] = [
    "pairing_v2_commit",
    "pairing_v2_reveal",
    "pairing_v2_terminal",
];

/// True when the frame is part of the SAS pairing exchange.
#[must_use]
pub fn is_pairing_frame(frame_type: &str) -> bool {
    PAIRING_FRAME_TYPES.contains(&frame_type)
}

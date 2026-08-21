//! Mesh session liveness and background frame serving.
//!
//! Workstream R3. The R0 boundary note
//! (`docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md`) splits the mesh at one seam:
//! *transport, liveness, tool dispatch and authorization on the Rust side;
//! orchestration and UI in TypeScript.* This crate is the liveness and dispatch
//! half of that sentence, kept free of Tauri and of the transport so it can be
//! compiled and tested on its own.
//!
//! It answers three questions and no others:
//!
//! 1. **Who owns this frame?** [`ownership`] is the section 3 table as data,
//!    with the settled target ownership and what this build actually answers
//!    kept in separate columns so the gap between them is visible.
//! 2. **What happens to it right now?** [`session`] holds one session per peer,
//!    answers `ping` itself so the session outlives Python's 120-second stale
//!    window, authorizes inbound `call` frames, and parks everything that needs
//!    a frozen webview in that peer's FIFO.
//! 3. **What does a caller hear when the answer has to wait?** [`deferral`] is
//!    section 6's typed response: a 503 `orchestration_deferred` carrying
//!    `retry_when: "peer_foreground"`, decided *after* authorization so it
//!    leaks nothing, and distinguishable from a peer that went away so it never
//!    costs a re-pair.
//!
//! What is deliberately absent: grants, permission evaluation and every other
//! authority question, which belong to `aurora-mesh-authority` and are asked
//! through it; and the session registry's UI-facing half — roster, pairing
//! state, snapshots — which stays in TypeScript permanently.

pub mod deferral;
pub mod ownership;
pub mod session;

pub use deferral::{
    error_frame, not_authorized_body, orchestration_deferred_body, orchestration_deferred_frame,
    ORCHESTRATION_DEFERRED_CODE, ORCHESTRATION_DEFERRED_MESSAGE, ORCHESTRATION_DEFERRED_REASON,
    RETRY_WHEN_PEER_FOREGROUND,
};
pub use ownership::{
    frames_served_by_rust_today, inbound_frame_ownership, is_pairing_frame, BackgroundCapability,
    FrameOwner, FrameOwnership, INBOUND_FRAME_OWNERSHIP, PAIRING_FRAME_TYPES,
};
pub use session::{
    background_executable_methods, background_execution_for, pong_frame, BackgroundExecution,
    DeviceLinkAction, DeviceLinkLedger,
    CallOutcome, InboundDisposition, MeshPeerSession, MeshSessionError, MeshSessionRegistry,
    PendingCall, QueuedFrame, SurfaceLifecycle, MAX_QUEUED_FRAMES_PER_PEER,
};

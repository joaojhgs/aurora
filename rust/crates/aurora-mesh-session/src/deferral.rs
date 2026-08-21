//! The typed deferral response from R0 section 6.
//!
//! A backgrounded phone stays **reachable** and **serves tools**, but **defers
//! orchestration**. That deferral is a typed error body on the existing `error`
//! frame — not a timeout, not a silent drop, and not `provider_unavailable`,
//! which means something different: the provider is gone and the peer should
//! stop routing to it.
//!
//! ```jsonc
//! {
//!   "type": "error",
//!   "id": "<call id>",
//!   "correlation_id": "<call id>",
//!   "error": {
//!     "code": 503,
//!     "message": "deferred until the device is back in use",
//!     "reason_code": "orchestration_deferred",
//!     "retry_when": "peer_foreground"
//!   }
//! }
//! ```
//!
//! Three rules travel with it, and each is easy to get wrong:
//!
//! 1. **Deferral is not eviction.** The peer stays in the roster, keeps its
//!    lease, and keeps answering `ping`. A caller that receives a deferral must
//!    not drop the peer or re-pair.
//! 2. **Only orchestration defers.** A call this side can authorize and execute
//!    against the `aurora_local_data_*` commands is answered, not deferred.
//! 3. **The deferral is decided after authorization, not before.** An
//!    unauthorized call gets 403 whether foreground or background. Answering
//!    "deferred" to a caller that would have been denied leaks whether a grant
//!    exists.

use aurora_mesh_authority::types::PeerHostErrorBody;
use serde_json::{json, Value};

/// Service-unavailable, retryable by construction.
///
/// Joins the existing HTTP-shaped numeric codes in `webrtc-peer-host.ts` (400
/// validation, 403 revoked, 499 cancelled, 500 handler failure, 504 timeout).
/// It lives here rather than in the authority crate because nothing in the
/// authority defers.
pub const ORCHESTRATION_DEFERRED_CODE: u16 = 503;

/// Machine-readable reason joining the existing `reason_code` vocabulary.
pub const ORCHESTRATION_DEFERRED_REASON: &str = "orchestration_deferred";

/// The only value `retry_when` takes today.
pub const RETRY_WHEN_PEER_FOREGROUND: &str = "peer_foreground";

/// Product copy, because `message` is user-facing if it ever surfaces.
///
/// Not "orchestration deferred, webview frozen": the machine-readable part is
/// `reason_code`, and internal role names and transport jargon stay out of
/// user-facing strings. See `packages/aurora-ui/src/product-copy-forbidden-terms.ts`.
pub const ORCHESTRATION_DEFERRED_MESSAGE: &str = "deferred until the device is back in use";

/// The section 6 error body.
#[must_use]
pub fn orchestration_deferred_body() -> PeerHostErrorBody {
    PeerHostErrorBody {
        code: ORCHESTRATION_DEFERRED_CODE,
        message: ORCHESTRATION_DEFERRED_MESSAGE.to_owned(),
        reason_code: ORCHESTRATION_DEFERRED_REASON.to_owned(),
        retry_when: Some(RETRY_WHEN_PEER_FOREGROUND.to_owned()),
        error_ref: None,
        schema_id: None,
        boundary: None,
        issues: None,
    }
}

/// The whole `error` frame carrying the deferral for one call.
#[must_use]
pub fn orchestration_deferred_frame(call_id: &str) -> Value {
    error_frame(call_id, &orchestration_deferred_body())
}

/// An `error` frame wrapping any body, correlated back to the call it answers.
#[must_use]
pub fn error_frame(call_id: &str, body: &PeerHostErrorBody) -> Value {
    json!({
        "type": "error",
        "id": call_id,
        "correlation_id": call_id,
        "error": body,
    })
}

/// The 403 body a denied call gets, carrying the authority's own reason.
///
/// Identical in the foreground and in the background: rule 3 above is only
/// meaningful if the denial path does not change shape with the lifecycle.
#[must_use]
pub fn not_authorized_body(reason_code: Option<&str>) -> PeerHostErrorBody {
    PeerHostErrorBody {
        code: aurora_mesh_authority::types::error_code::NOT_AUTHORIZED,
        message: "not authorized".to_owned(),
        reason_code: reason_code.unwrap_or("not_authorized").to_owned(),
        retry_when: None,
        error_ref: None,
        schema_id: None,
        boundary: None,
        issues: None,
    }
}

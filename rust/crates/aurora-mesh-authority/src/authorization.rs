//! Port of `packages/aurora-sdk/src/peer-host/authorization.ts`.
//!
//! Three implementations of the [`PeerHostAuthorizationStore`] seam: deny
//! everything, decide from a session-local grant set, and decide through the
//! durable [`PeerAuthorityResolver`].
//!
//! ## Where TypeScript was loose
//!
//! [`SessionPeerHostAuthorizationStore`] iterates its grant map and returns on
//! the *first* match, so JavaScript's insertion-ordered `Map` is load-bearing:
//! which grant answers, and therefore which denial reason the caller sees, is a
//! function of insertion order. A Rust `HashMap` would make that
//! non-deterministic and a `BTreeMap` would silently reorder it. This port
//! keeps an insertion-ordered vector with `Map.set` semantics — replacing an
//! existing grant id keeps its position — so the decision is identical and
//! reproducible.

use crate::authority::{
    sorted_unique, AuthenticatedPeerContext, AuthorityResult, InboundCredentialVerifierStore,
    LocalPeerGrantV1, PeerAuditSink, PeerAuthorityResolver, PeerGrantRepository,
    ReconnectChallengeStore,
};
use crate::types::{
    PeerHostAuthGrantState, PeerHostAuthorizationDecision, PeerHostAuthorizationStore,
    PeerHostAuthorizeRequest, PeerHostManifestAuthorityRequest, PeerHostManifestAuthoritySnapshot,
};

/// Denial reasons this layer mints, distinct from the durable authority's.
pub mod store_reason {
    /// No authorization store is wired up.
    pub const AUTHORIZATION_STORE_UNAVAILABLE: &str = "authorization_store_unavailable";
    /// No grant covers the caller.
    pub const GRANT_NOT_FOUND: &str = "grant_not_found";
    /// A grant exists but has expired.
    pub const GRANT_EXPIRED: &str = "grant_expired";
    /// A grant exists but has been revoked.
    pub const GRANT_REVOKED: &str = "grant_revoked";
    /// The caller never proved who it is.
    pub const PEER_NOT_AUTHENTICATED: &str = "peer_not_authenticated";
    /// The proven identity is not the peer the frame claims to be from.
    pub const SELECTOR_MISMATCH: &str = "selector_mismatch";
}

/// Refuses everything. The default until a real store is wired up.
#[derive(Clone, Copy, Debug, Default)]
pub struct DenyAllPeerHostAuthorizationStore;

#[async_trait::async_trait]
impl PeerHostAuthorizationStore for DenyAllPeerHostAuthorizationStore {
    async fn authorize(
        &mut self,
        _request: &PeerHostAuthorizeRequest,
    ) -> AuthorityResult<PeerHostAuthorizationDecision> {
        Ok(PeerHostAuthorizationDecision::denied(
            store_reason::AUTHORIZATION_STORE_UNAVAILABLE,
        ))
    }
}

/// Decides from a grant set held for the lifetime of one session.
///
/// Insertion order is preserved; see the module documentation.
#[derive(Clone, Debug, Default)]
pub struct SessionPeerHostAuthorizationStore {
    grants: Vec<LocalPeerGrantV1>,
}

impl SessionPeerHostAuthorizationStore {
    /// A store seeded with `grants`, in order.
    pub fn new(grants: Vec<LocalPeerGrantV1>) -> AuthorityResult<Self> {
        let mut store = Self::default();
        for grant in grants {
            store.upsert_grant(grant)?;
        }
        Ok(store)
    }

    /// Insert or replace a grant by id, keeping its position.
    pub fn upsert_grant(&mut self, grant: LocalPeerGrantV1) -> AuthorityResult<()> {
        validate_session_grant(&grant)?;
        match self
            .grants
            .iter_mut()
            .find(|existing| existing.grant_id == grant.grant_id)
        {
            Some(existing) => *existing = grant,
            None => self.grants.push(grant),
        }
        Ok(())
    }

    /// Mark a grant revoked. Unknown ids are ignored, as in TypeScript.
    pub fn revoke_grant(&mut self, grant_id: &str, revoked_at_ms: i64) {
        if let Some(grant) = self
            .grants
            .iter_mut()
            .find(|grant| grant.grant_id == grant_id)
        {
            grant.revoked_at_ms = Some(revoked_at_ms);
        }
    }

    /// Drop every grant.
    pub fn clear(&mut self) {
        self.grants.clear();
    }
}

#[async_trait::async_trait]
impl PeerHostAuthorizationStore for SessionPeerHostAuthorizationStore {
    async fn authorize(
        &mut self,
        request: &PeerHostAuthorizeRequest,
    ) -> AuthorityResult<PeerHostAuthorizationDecision> {
        for grant in &self.grants {
            if grant.claimant_peer_id != request.remote_peer_id {
                continue;
            }
            if let Some(context) = &request.authenticated_peer_context {
                if grant.token_id != context.selector.token_id {
                    continue;
                }
            }
            if grant.revoked_at_ms.is_some_and(|at| at <= request.now_ms) {
                return Ok(PeerHostAuthorizationDecision {
                    allowed: false,
                    reason_code: Some(store_reason::GRANT_REVOKED.to_owned()),
                    grant_revision: Some(grant.grant_revision),
                    granted_method_ids: None,
                    granted_permissions: None,
                    granted_tool_contract_ids: None,
                });
            }
            if grant.expires_at_ms.is_some_and(|at| at <= request.now_ms) {
                return Ok(PeerHostAuthorizationDecision {
                    allowed: false,
                    reason_code: Some(store_reason::GRANT_EXPIRED.to_owned()),
                    grant_revision: Some(grant.grant_revision),
                    granted_method_ids: None,
                    granted_permissions: None,
                    granted_tool_contract_ids: None,
                });
            }
            if !grant.allowed_method_ids.contains(&request.method_id) {
                continue;
            }
            return Ok(PeerHostAuthorizationDecision {
                allowed: true,
                reason_code: None,
                grant_revision: Some(grant.grant_revision),
                granted_method_ids: Some(sorted_unique(&grant.allowed_method_ids)),
                granted_permissions: None,
                granted_tool_contract_ids: Some(sorted_unique(&grant.allowed_tool_contract_ids)),
            });
        }
        // TypeScript raises `bestRevision` immediately before returning an
        // allow, so its `bestRevision > 0` fallback here is unreachable and the
        // denial never carries a revision. Reproduced rather than "fixed": what
        // a denial reveals about grant state is protocol-visible, and widening
        // it is R3's call, not a port's.
        Ok(PeerHostAuthorizationDecision {
            allowed: false,
            reason_code: Some(store_reason::GRANT_NOT_FOUND.to_owned()),
            grant_revision: None,
            granted_method_ids: None,
            granted_permissions: None,
            granted_tool_contract_ids: None,
        })
    }

    async fn snapshot_manifest_authority(
        &mut self,
        request: &PeerHostManifestAuthorityRequest,
    ) -> AuthorityResult<PeerHostManifestAuthoritySnapshot> {
        let mut live: Vec<&LocalPeerGrantV1> = self
            .grants
            .iter()
            .filter(|grant| {
                if let Some(remote_peer_id) = &request.remote_peer_id {
                    if &grant.claimant_peer_id != remote_peer_id {
                        return false;
                    }
                }
                if let Some(context) = &request.authenticated_peer_context {
                    if grant.token_id != context.selector.token_id {
                        return false;
                    }
                }
                if grant.revoked_at_ms.is_some_and(|at| at <= request.now_ms) {
                    return false;
                }
                if grant.expires_at_ms.is_some_and(|at| at <= request.now_ms) {
                    return false;
                }
                true
            })
            .collect();
        live.sort_by(|left, right| crate::authority::compare_grants(left, right));

        let granted_method_ids = sorted_unique(
            &live
                .iter()
                .flat_map(|grant| grant.allowed_method_ids.clone())
                .collect::<Vec<String>>(),
        );
        let recipient_peer_id = request
            .remote_peer_id
            .clone()
            .or_else(|| live.first().map(|grant| grant.claimant_peer_id.clone()));
        let auth_grant_revision = live
            .iter()
            .fold(0_i64, |revision, grant| revision.max(grant.grant_revision));
        Ok(PeerHostManifestAuthoritySnapshot {
            recipient_peer_id,
            auth_grant_state: if granted_method_ids.is_empty() {
                PeerHostAuthGrantState::Unknown
            } else {
                PeerHostAuthGrantState::Active
            },
            granted_method_ids,
            granted_permissions: None,
            granted_tool_contract_ids: Some(sorted_unique(
                &live
                    .iter()
                    .flat_map(|grant| grant.allowed_tool_contract_ids.clone())
                    .collect::<Vec<String>>(),
            )),
            auth_grant_revision,
        })
    }
}

/// Maps a grant to the product permission labels it implies.
pub type GrantedPermissionsForGrant = Box<dyn Fn(&LocalPeerGrantV1) -> Vec<String> + Send + Sync>;

/// Decides through the durable [`PeerAuthorityResolver`].
///
/// This is the store the peer host runs against in production. Note the two
/// gates before the resolver is consulted at all: the caller must have proven
/// who it is, and the proven identity must be the peer the frame arrived from.
/// Together those are the invariant *authority contexts never cross peers* —
/// a grant held by peer A can never answer a frame from peer B, whatever the
/// frame claims.
pub struct PeerAuthorityHostAuthorizationStore<V, G, C, A>
where
    V: InboundCredentialVerifierStore,
    G: PeerGrantRepository,
    C: ReconnectChallengeStore,
    A: PeerAuditSink,
{
    resolver: PeerAuthorityResolver<V, G, C, A>,
    granted_permissions_for_grant: Option<GrantedPermissionsForGrant>,
}

impl<V, G, C, A> PeerAuthorityHostAuthorizationStore<V, G, C, A>
where
    V: InboundCredentialVerifierStore,
    G: PeerGrantRepository,
    C: ReconnectChallengeStore,
    A: PeerAuditSink,
{
    /// Wrap a resolver.
    pub fn new(resolver: PeerAuthorityResolver<V, G, C, A>) -> Self {
        Self {
            resolver,
            granted_permissions_for_grant: None,
        }
    }

    /// Wrap a resolver and derive permission labels from each grant.
    pub fn with_granted_permissions(
        resolver: PeerAuthorityResolver<V, G, C, A>,
        granted_permissions_for_grant: GrantedPermissionsForGrant,
    ) -> Self {
        Self {
            resolver,
            granted_permissions_for_grant: Some(granted_permissions_for_grant),
        }
    }

    /// Borrow the wrapped resolver.
    pub fn resolver(&self) -> &PeerAuthorityResolver<V, G, C, A> {
        &self.resolver
    }

    /// Borrow the wrapped resolver mutably.
    pub fn resolver_mut(&mut self) -> &mut PeerAuthorityResolver<V, G, C, A> {
        &mut self.resolver
    }
}

#[async_trait::async_trait]
impl<V, G, C, A> PeerHostAuthorizationStore for PeerAuthorityHostAuthorizationStore<V, G, C, A>
where
    V: InboundCredentialVerifierStore,
    G: PeerGrantRepository,
    C: ReconnectChallengeStore,
    A: PeerAuditSink,
{
    async fn authorize(
        &mut self,
        request: &PeerHostAuthorizeRequest,
    ) -> AuthorityResult<PeerHostAuthorizationDecision> {
        let Some(context) = request.authenticated_peer_context.clone() else {
            return Ok(PeerHostAuthorizationDecision::denied(
                store_reason::PEER_NOT_AUTHENTICATED,
            ));
        };
        if !context_belongs_to_peer(&context, &request.remote_peer_id) {
            return Ok(PeerHostAuthorizationDecision::denied(
                store_reason::SELECTOR_MISMATCH,
            ));
        }
        let decision = self
            .resolver
            .resolve_grant(&context, Some(&request.method_id), request.now_ms)
            .await?;
        let granted_permissions = match (&decision.grant, &self.granted_permissions_for_grant) {
            (Some(grant), Some(map)) => Some(sorted_unique(&map(grant))),
            _ => None,
        };
        Ok(PeerHostAuthorizationDecision {
            allowed: decision.allowed,
            reason_code: decision
                .reason_code
                .map(|reason| reason.as_str().to_owned()),
            grant_revision: decision.grant.as_ref().map(|grant| grant.grant_revision),
            granted_method_ids: decision
                .grant
                .as_ref()
                .map(|grant| sorted_unique(&grant.allowed_method_ids)),
            granted_permissions,
            granted_tool_contract_ids: decision
                .grant
                .as_ref()
                .map(|grant| sorted_unique(&grant.allowed_tool_contract_ids)),
        })
    }

    async fn snapshot_manifest_authority(
        &mut self,
        request: &PeerHostManifestAuthorityRequest,
    ) -> AuthorityResult<PeerHostManifestAuthoritySnapshot> {
        let Some(context) = request.authenticated_peer_context.clone() else {
            return Ok(PeerHostManifestAuthoritySnapshot {
                recipient_peer_id: request.remote_peer_id.clone(),
                granted_method_ids: Vec::new(),
                granted_permissions: None,
                granted_tool_contract_ids: None,
                auth_grant_revision: 0,
                auth_grant_state: PeerHostAuthGrantState::Unknown,
            });
        };
        if let Some(remote_peer_id) = &request.remote_peer_id {
            if &context.selector.claimant_peer_id != remote_peer_id {
                return Ok(PeerHostManifestAuthoritySnapshot {
                    recipient_peer_id: Some(remote_peer_id.clone()),
                    granted_method_ids: Vec::new(),
                    granted_permissions: None,
                    granted_tool_contract_ids: None,
                    auth_grant_revision: 0,
                    auth_grant_state: PeerHostAuthGrantState::Unknown,
                });
            }
        }
        let grants = self
            .resolver
            .snapshot_recipient_grants(&context, request.now_ms, request.correlation_id.as_deref())
            .await?;
        let mut active: Vec<&LocalPeerGrantV1> = grants
            .iter()
            .filter(|grant| {
                grant.revoked_at_ms.is_none_or(|at| at > request.now_ms)
                    && grant.expires_at_ms.is_none_or(|at| at > request.now_ms)
            })
            .collect();
        active.sort_by(|left, right| crate::authority::compare_grants(left, right));

        let granted_method_ids = sorted_unique(
            &active
                .iter()
                .flat_map(|grant| grant.allowed_method_ids.clone())
                .collect::<Vec<String>>(),
        );
        let granted_permissions = match &self.granted_permissions_for_grant {
            None => Vec::new(),
            Some(map) => sorted_unique(
                &active
                    .iter()
                    .flat_map(|grant| map(grant))
                    .collect::<Vec<String>>(),
            ),
        };
        let auth_grant_revision = active
            .iter()
            .fold(0_i64, |revision, grant| revision.max(grant.grant_revision));
        Ok(PeerHostManifestAuthoritySnapshot {
            recipient_peer_id: Some(context.selector.claimant_peer_id.clone()),
            auth_grant_state: if granted_method_ids.is_empty() {
                PeerHostAuthGrantState::Unknown
            } else {
                PeerHostAuthGrantState::Active
            },
            granted_method_ids,
            granted_permissions: Some(granted_permissions),
            granted_tool_contract_ids: Some(sorted_unique(
                &active
                    .iter()
                    .flat_map(|grant| grant.allowed_tool_contract_ids.clone())
                    .collect::<Vec<String>>(),
            )),
            auth_grant_revision,
        })
    }
}

/// Establish that a peer context belongs to the peer a frame arrived from.
///
/// Extracted so the invariant has one name and one test, rather than being an
/// inline comparison inside a decision path.
#[must_use]
pub fn context_belongs_to_peer(context: &AuthenticatedPeerContext, remote_peer_id: &str) -> bool {
    context.selector.claimant_peer_id == remote_peer_id
}

/// The `types.ts` validator for a session-held grant.
///
/// Narrower than [`crate::authority::validate_grant`]: it checks only the
/// fields the session store reads, because the `types.ts` declaration of
/// `LocalPeerGrantV1` carries only those.
fn validate_session_grant(grant: &LocalPeerGrantV1) -> AuthorityResult<()> {
    use crate::authority::AuthorityError;
    if grant.version != 1 {
        return Err(AuthorityError::UnsupportedVersion("grant"));
    }
    if grant.grant_id.is_empty() || grant.token_id.is_empty() || grant.claimant_peer_id.is_empty() {
        return Err(AuthorityError::Invalid(
            "grant identity is required".to_owned(),
        ));
    }
    if grant.created_at_ms < 0 {
        return Err(AuthorityError::Invalid("grant createdAtMs".to_owned()));
    }
    if grant.grant_revision < 0 {
        return Err(AuthorityError::Invalid("grant revision".to_owned()));
    }
    Ok(())
}

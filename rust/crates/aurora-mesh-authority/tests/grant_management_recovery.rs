use async_trait::async_trait;
use aurora_mesh_authority::authority::{
    AuthorityResult, LocalPeerGrantV1, MemoryPeerGrantRepository, PeerAuthorityDecision,
    PeerGrantRepository, PeerGrantResolutionRequest, PeerRelationshipSelector,
};
use aurora_mesh_authority::grant_management::{
    PeerGrantManagementErrorCode, PeerGrantManager, PeerGrantSelection,
};

struct FailNextUpsertRepository {
    inner: MemoryPeerGrantRepository,
    fail_next_upsert: bool,
}

#[async_trait]
impl PeerGrantRepository for FailNextUpsertRepository {
    async fn upsert_grant(&mut self, grant: LocalPeerGrantV1) -> AuthorityResult<()> {
        if self.fail_next_upsert {
            self.fail_next_upsert = false;
            return Err(aurora_mesh_authority::authority::AuthorityError::Store(
                "replacement unavailable".to_owned(),
            ));
        }
        self.inner.upsert_grant(grant).await
    }

    async fn resolve_grant(
        &self,
        request: &PeerGrantResolutionRequest,
    ) -> AuthorityResult<PeerAuthorityDecision> {
        self.inner.resolve_grant(request).await
    }

    async fn list_recipient_grants(
        &self,
        selector: &PeerRelationshipSelector,
        now_ms: i64,
    ) -> AuthorityResult<Vec<LocalPeerGrantV1>> {
        self.inner.list_recipient_grants(selector, now_ms).await
    }

    async fn revoke_grants(
        &mut self,
        selector: &PeerRelationshipSelector,
        revoked_at_ms: i64,
    ) -> AuthorityResult<Vec<LocalPeerGrantV1>> {
        self.inner.revoke_grants(selector, revoked_at_ms).await
    }
}

fn selector() -> PeerRelationshipSelector {
    PeerRelationshipSelector {
        token_id: "token-1".to_owned(),
        claimant_peer_id: "claimant-1".to_owned(),
        verifier_peer_id: "verifier-1".to_owned(),
        room_name: "room-1".to_owned(),
    }
}

fn existing_grant() -> LocalPeerGrantV1 {
    LocalPeerGrantV1 {
        version: 1,
        grant_id: "grant-1".to_owned(),
        token_id: "token-1".to_owned(),
        claimant_peer_id: "claimant-1".to_owned(),
        verifier_peer_id: "verifier-1".to_owned(),
        room_name: "room-1".to_owned(),
        allowed_method_ids: vec!["Tooling.ListTools".to_owned()],
        allowed_tool_contract_ids: Vec::new(),
        capability_pack_ids: Vec::new(),
        resource_scopes: Vec::new(),
        created_at_ms: 1_000,
        expires_at_ms: None,
        revoked_at_ms: None,
        grant_revision: 1,
    }
}

#[tokio::test]
async fn failed_replacement_restores_the_previous_live_grant() {
    let mut inner = MemoryPeerGrantRepository::new();
    inner.upsert_grant(existing_grant()).await.unwrap();
    let repository = FailNextUpsertRepository {
        inner,
        fail_next_upsert: true,
    };
    let mut manager = PeerGrantManager::new(repository);
    let replacement = PeerGrantSelection {
        allowed_method_ids: vec!["Tooling.InvokeTool".to_owned()],
        ..PeerGrantSelection::default()
    };

    let error = manager
        .replace_grant(&selector(), &replacement, 2_000)
        .await
        .unwrap_err();

    assert_eq!(
        error.code,
        PeerGrantManagementErrorCode::RepositoryUnavailable
    );
    let live = manager
        .repository()
        .list_recipient_grants(&selector(), 2_000)
        .await
        .unwrap();
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].grant_id, "grant-1");
    assert_eq!(live[0].allowed_method_ids, ["Tooling.ListTools"]);
    assert_eq!(live[0].revoked_at_ms, None);
    assert!(live[0].grant_revision > 2);
}

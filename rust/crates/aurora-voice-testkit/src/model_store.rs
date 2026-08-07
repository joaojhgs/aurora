use async_trait::async_trait;
use aurora_voice_engine::{
    apply_lifecycle_event, create_lifecycle_snapshot, file_storage_key, ActivePackIdentity,
    DownloadTask, ImmutableModelFile, InstallEvent, InstallState, LifecycleSnapshot,
    ModelPackError, ModelPackFile, ModelStore, SelectedVariant, StoreStatus, StoredFile,
    VerifiedManifest,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
struct Reservation {
    task: DownloadTask,
}

#[derive(Debug, Clone)]
pub struct InMemoryModelStore {
    bytes_available: Option<u64>,
    persistent: bool,
    now: u64,
    files: BTreeMap<String, StoredFile>,
    reservations: BTreeMap<String, Reservation>,
    lifecycles: BTreeMap<(String, String), LifecycleSnapshot>,
    active: Option<ActivePackIdentity>,
    rollback: Option<ActivePackIdentity>,
    corrupted: BTreeSet<String>,
    revoked: BTreeSet<String>,
    fail_next_persist: bool,
}

impl InMemoryModelStore {
    pub fn new(bytes_available: Option<u64>) -> Self {
        Self {
            bytes_available,
            persistent: true,
            now: 0,
            files: BTreeMap::new(),
            reservations: BTreeMap::new(),
            lifecycles: BTreeMap::new(),
            active: None,
            rollback: None,
            corrupted: BTreeSet::new(),
            revoked: BTreeSet::new(),
            fail_next_persist: false,
        }
    }

    pub fn advance(&mut self, delta: u64) {
        self.now = self.now.saturating_add(delta);
    }

    pub fn inject_persistence_failure(&mut self) {
        self.fail_next_persist = true;
    }

    pub fn mark_corrupt(&mut self, pack_id: &str) {
        self.corrupted.insert(pack_id.to_owned());
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.pack_id == pack_id)
        {
            self.active = None;
        }
    }

    pub fn revoke_pack(&mut self, pack_id: &str) {
        self.revoked.insert(pack_id.to_owned());
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.pack_id == pack_id)
        {
            self.active = None;
        }
    }

    pub fn rollback_identity(&self) -> Option<&ActivePackIdentity> {
        self.rollback.as_ref()
    }

    fn used_bytes(&self) -> u64 {
        self.files.values().map(|file| file.byte_size).sum::<u64>()
    }

    fn reserved_bytes(&self) -> u64 {
        self.reservations
            .values()
            .map(|reservation| reservation.task.expected_bytes)
            .sum::<u64>()
    }

    fn ensure_quota(&self, additional_bytes: u64) -> Result<(), ModelPackError> {
        if let Some(limit) = self.bytes_available {
            if self
                .used_bytes()
                .saturating_add(self.reserved_bytes())
                .saturating_add(additional_bytes)
                > limit
            {
                return Err(ModelPackError::QuotaExceeded);
            }
        }
        Ok(())
    }

    fn maybe_fail_persist(&mut self) -> Result<(), ModelPackError> {
        if self.fail_next_persist {
            self.fail_next_persist = false;
            Err(ModelPackError::Store {
                code: "persistence",
            })
        } else {
            Ok(())
        }
    }

    fn lifecycle_key(pack_id: &str, pack_version: &str) -> (String, String) {
        (pack_id.to_owned(), pack_version.to_owned())
    }

    fn require_not_withdrawn(&self, pack_id: &str) -> Result<(), ModelPackError> {
        if self.corrupted.contains(pack_id) {
            return Err(ModelPackError::Store { code: "corrupt" });
        }
        if self.revoked.contains(pack_id) {
            return Err(ModelPackError::Store { code: "revoked" });
        }
        Ok(())
    }
}

#[async_trait(?Send)]
impl ModelStore for InMemoryModelStore {
    async fn status(&self) -> Result<StoreStatus, ModelPackError> {
        Ok(StoreStatus {
            bytes_used: self.used_bytes(),
            bytes_reserved: self.reserved_bytes(),
            bytes_available: self.bytes_available,
            persistent: self.persistent,
        })
    }

    async fn lifecycle(
        &self,
        pack_id: &str,
        pack_version: &str,
    ) -> Result<Option<LifecycleSnapshot>, ModelPackError> {
        Ok(self
            .lifecycles
            .get(&Self::lifecycle_key(pack_id, pack_version))
            .cloned())
    }

    async fn set_lifecycle(&mut self, snapshot: LifecycleSnapshot) -> Result<(), ModelPackError> {
        self.maybe_fail_persist()?;
        self.lifecycles.insert(
            Self::lifecycle_key(&snapshot.pack_id, &snapshot.pack_version),
            snapshot,
        );
        Ok(())
    }

    async fn reserve_file(
        &mut self,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
        file: &ModelPackFile,
    ) -> Result<DownloadTask, ModelPackError> {
        if !selection.belongs_to(manifest) || !selection.file_ids().contains(&file.file_id) {
            return Err(ModelPackError::Store { code: "selection" });
        }
        self.require_not_withdrawn(&manifest.manifest().pack_id)?;
        self.ensure_quota(file.byte_size)?;
        self.maybe_fail_persist()?;
        let storage_key = file_storage_key(
            &manifest.manifest().pack_id,
            &manifest.manifest().pack_version,
            selection.variant_id(),
            &file.file_id,
        );
        let task = DownloadTask {
            storage_key: storage_key.clone(),
            pack_id: manifest.manifest().pack_id.clone(),
            pack_version: manifest.manifest().pack_version.clone(),
            file_id: file.file_id.clone(),
            url: file.url.clone(),
            expected_sha256: file.sha256.clone(),
            expected_bytes: file.byte_size,
            variant_id: selection.variant_id().to_owned(),
        };
        self.reservations
            .insert(storage_key, Reservation { task: task.clone() });
        Ok(task)
    }

    async fn resume_metadata(
        &self,
        storage_key: &str,
    ) -> Result<Option<DownloadTask>, ModelPackError> {
        Ok(self
            .reservations
            .get(storage_key)
            .map(|reservation| reservation.task.clone()))
    }

    async fn promote_file(
        &mut self,
        storage_key: &str,
        sha256: &str,
        byte_size: u64,
    ) -> Result<StoredFile, ModelPackError> {
        let reservation =
            self.reservations
                .get(storage_key)
                .cloned()
                .ok_or(ModelPackError::Store {
                    code: "reservation",
                })?;
        if reservation.task.expected_sha256 != sha256 {
            return Err(ModelPackError::Store { code: "hash" });
        }
        if reservation.task.expected_bytes != byte_size {
            return Err(ModelPackError::Store { code: "size" });
        }
        self.ensure_quota(0)?;
        self.maybe_fail_persist()?;
        let stored = StoredFile {
            storage_key: storage_key.to_owned(),
            pack_id: reservation.task.pack_id,
            pack_version: reservation.task.pack_version,
            file_id: reservation.task.file_id,
            variant_id: reservation.task.variant_id,
            sha256: sha256.to_owned(),
            byte_size,
            state: InstallState::Ready,
            stored_at: self.now,
        };
        self.files.insert(storage_key.to_owned(), stored.clone());
        self.reservations.remove(storage_key);
        Ok(stored)
    }

    async fn activate_pack(
        &mut self,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<LifecycleSnapshot, ModelPackError> {
        if !selection.belongs_to(manifest) {
            return Err(ModelPackError::Store { code: "selection" });
        }
        self.require_not_withdrawn(&manifest.manifest().pack_id)?;
        for file in manifest
            .manifest()
            .files
            .iter()
            .filter(|file| selection.file_ids().contains(&file.file_id))
            .filter(|file| !file.revocation.as_ref().is_some_and(|rev| rev.revoked))
        {
            let key = file_storage_key(
                &manifest.manifest().pack_id,
                &manifest.manifest().pack_version,
                selection.variant_id(),
                &file.file_id,
            );
            let stored = self.files.get(&key).ok_or(ModelPackError::Store {
                code: "missing_file",
            })?;
            if stored.sha256 != file.sha256 || stored.byte_size != file.byte_size {
                return Err(ModelPackError::Store { code: "corrupt" });
            }
        }

        let current_key = Self::lifecycle_key(
            &manifest.manifest().pack_id,
            &manifest.manifest().pack_version,
        );
        let current = self
            .lifecycles
            .get(&current_key)
            .cloned()
            .unwrap_or_else(|| {
                create_lifecycle_snapshot(
                    manifest.manifest().pack_id.clone(),
                    manifest.manifest().pack_version.clone(),
                    self.now,
                    InstallState::Ready,
                )
            });
        if current.state != InstallState::Ready && current.state != InstallState::Active {
            return Err(ModelPackError::Store { code: "not_ready" });
        }

        let previous_active = self.active.clone();
        let previous_lifecycles = self.lifecycles.clone();
        let previous_rollback = self.rollback.clone();
        self.maybe_fail_persist()?;

        if let Some(active) = &previous_active {
            if active.pack_id != manifest.manifest().pack_id
                || active.pack_version != manifest.manifest().pack_version
            {
                self.rollback = Some(active.clone());
                if let Some(previous) = self
                    .lifecycles
                    .get(&Self::lifecycle_key(&active.pack_id, &active.pack_version))
                    .cloned()
                {
                    let deactivated =
                        apply_lifecycle_event(&previous, InstallEvent::Deactivate, self.now, None)?;
                    self.lifecycles.insert(
                        Self::lifecycle_key(&deactivated.pack_id, &deactivated.pack_version),
                        deactivated,
                    );
                }
            }
        }

        let active = if current.state == InstallState::Active {
            current
        } else {
            apply_lifecycle_event(&current, InstallEvent::Activate, self.now, None)?
        };
        let identity = ActivePackIdentity {
            pack_id: active.pack_id.clone(),
            pack_version: active.pack_version.clone(),
            variant_id: selection.variant_id().to_owned(),
        };
        self.lifecycles.insert(current_key, active.clone());
        self.active = Some(identity);
        if self.fail_next_persist {
            self.lifecycles = previous_lifecycles;
            self.active = previous_active;
            self.rollback = previous_rollback;
            self.fail_next_persist = false;
            return Err(ModelPackError::Store {
                code: "persistence",
            });
        }
        Ok(active)
    }

    async fn rollback_active(&mut self) -> Result<Option<LifecycleSnapshot>, ModelPackError> {
        let Some(rollback) = self.rollback.clone() else {
            return Ok(None);
        };
        self.require_not_withdrawn(&rollback.pack_id)?;
        self.maybe_fail_persist()?;
        if let Some(active) = self.active.clone() {
            if let Some(snapshot) = self
                .lifecycles
                .get(&Self::lifecycle_key(&active.pack_id, &active.pack_version))
                .cloned()
            {
                let ready =
                    apply_lifecycle_event(&snapshot, InstallEvent::Deactivate, self.now, None)?;
                self.lifecycles.insert(
                    Self::lifecycle_key(&ready.pack_id, &ready.pack_version),
                    ready,
                );
            }
        }
        let snapshot = self
            .lifecycles
            .get(&Self::lifecycle_key(
                &rollback.pack_id,
                &rollback.pack_version,
            ))
            .cloned()
            .ok_or(ModelPackError::Store { code: "rollback" })?;
        let active = apply_lifecycle_event(&snapshot, InstallEvent::Activate, self.now, None)?;
        self.lifecycles.insert(
            Self::lifecycle_key(&active.pack_id, &active.pack_version),
            active.clone(),
        );
        self.active = Some(ActivePackIdentity {
            pack_id: active.pack_id.clone(),
            pack_version: active.pack_version.clone(),
            variant_id: rollback.variant_id,
        });
        self.rollback = None;
        Ok(Some(active))
    }

    async fn remove_pack(&mut self, pack_id: &str) -> Result<(), ModelPackError> {
        self.maybe_fail_persist()?;
        self.files.retain(|_, file| file.pack_id != pack_id);
        self.reservations
            .retain(|_, reservation| reservation.task.pack_id != pack_id);
        self.lifecycles
            .retain(|(id, _), _snapshot| id.as_str() != pack_id);
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.pack_id == pack_id)
        {
            self.active = None;
        }
        if self
            .rollback
            .as_ref()
            .is_some_and(|rollback| rollback.pack_id == pack_id)
        {
            self.rollback = None;
        }
        Ok(())
    }

    async fn active_pack(&self) -> Result<Option<ActivePackIdentity>, ModelPackError> {
        Ok(self.active.clone())
    }

    async fn open_immutable_file(
        &self,
        selection: &SelectedVariant,
        file_id: &str,
    ) -> Result<ImmutableModelFile, ModelPackError> {
        if !selection.file_ids().contains(file_id) {
            return Err(ModelPackError::Store { code: "selection" });
        }
        self.require_not_withdrawn(selection.pack_id())?;
        let key = file_storage_key(
            selection.pack_id(),
            selection.pack_version(),
            selection.variant_id(),
            file_id,
        );
        let file = self.files.get(&key).ok_or(ModelPackError::Store {
            code: "missing_file",
        })?;
        Ok(ImmutableModelFile {
            storage_key: file.storage_key.clone(),
            sha256: file.sha256.clone(),
            byte_size: file.byte_size,
            variant_id: file.variant_id.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_voice_engine::{
        select_verified_variant, verify_manifest, AbiRequirements, CapabilityFlags, Compatibility,
        CompressionKind, DeviceClass, EngineKind, LanguageSupport, LicenseGrant, LicenseInfo,
        ManifestSignature, ModelPackManifest, PackTask, ProcessingMetadata, Provenance,
        ResourceBudget, RuntimeGates, RuntimeSelection, RuntimeTarget, ShapeMetadata,
        SignatureVerifier, TargetArch, TargetOs, TrustPolicy,
    };

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    struct AcceptingVerifier;

    impl SignatureVerifier for AcceptingVerifier {
        fn verify(
            &self,
            _canonical_json: &str,
            signature: &aurora_voice_engine::ManifestSignature,
        ) -> Result<bool, ModelPackError> {
            Ok(signature.value == "signed")
        }
    }

    fn provenance() -> Provenance {
        Provenance {
            upstream_source: "https://example.test/source".to_owned(),
            upstream_revision: "rev1".to_owned(),
            build_recipe_sha256: HASH.to_owned(),
        }
    }

    fn license() -> LicenseInfo {
        LicenseInfo {
            identifier: "Apache-2.0".to_owned(),
            text_url: "https://example.test/license".to_owned(),
            text_sha256: HASH.to_owned(),
            commercial_use: true,
            redistribution: LicenseGrant::RedistributionAllowed,
            attribution: "Aurora".to_owned(),
        }
    }

    fn processing() -> ProcessingMetadata {
        ProcessingMetadata {
            tokenizer_sha256: None,
            operator_inventory_sha256: HASH.to_owned(),
            preprocessing_abi: "pre".to_owned(),
            postprocessing_abi: "post".to_owned(),
            shapes: ShapeMetadata {
                sample_rate_hz: 16_000,
                channels: 1,
                frame_size: 512,
                window_size: 1024,
                cache_state: vec!["hidden".to_owned()],
            },
        }
    }

    fn runtime_selection(
        target: RuntimeTarget,
        os: TargetOs,
        arch: TargetArch,
    ) -> RuntimeSelection {
        RuntimeSelection {
            target,
            os,
            arch,
            browser_features: BTreeSet::new(),
            device_memory_mb: Some(4096),
            max_download_bytes: u64::MAX,
            max_installed_bytes: u64::MAX,
            max_memory_bytes: u64::MAX,
            cpu_threads: 4,
            max_rtf_millis_per_second: 1_000,
            device_class: DeviceClass::Balanced,
            require_interoperable: false,
        }
    }

    fn selection_for(manifest: &VerifiedManifest) -> SelectedVariant {
        let result = select_verified_variant(
            manifest,
            &runtime_selection(RuntimeTarget::Desktop, TargetOs::Linux, TargetArch::X86_64),
        );
        match result {
            Ok(selection) => selection,
            Err(error) => panic!("fixture selection should resolve: {error}"),
        }
    }

    fn select_for(
        manifest: &VerifiedManifest,
        target: RuntimeTarget,
        os: TargetOs,
        arch: TargetArch,
    ) -> SelectedVariant {
        match select_verified_variant(manifest, &runtime_selection(target, os, arch)) {
            Ok(selection) => selection,
            Err(error) => panic!("fixture selection should resolve: {error}"),
        }
    }

    fn model_file(file_id: &str, hash: &str, size: u64) -> ModelPackFile {
        ModelPackFile {
            file_id: file_id.to_owned(),
            asset_id: file_id.to_owned(),
            task: PackTask::Stt,
            byte_size: size,
            sha256: hash.to_owned(),
            url: format!("/models/{file_id}"),
            compression: CompressionKind::None,
            installed_size: size,
            install_order: 0,
            dependencies: Vec::new(),
            license: license(),
            provenance: provenance(),
            processing: processing(),
            raven: None,
            revocation: None,
        }
    }

    fn variant(
        variant_id: &str,
        target: RuntimeTarget,
        os: TargetOs,
        arch: TargetArch,
        file_id: &str,
        size: u64,
    ) -> aurora_voice_engine::ModelPackVariant {
        aurora_voice_engine::ModelPackVariant {
            variant_id: variant_id.to_owned(),
            target,
            os,
            arch,
            engine: EngineKind::SherpaOnnx,
            required_browser_features: Vec::new(),
            min_device_memory_mb: None,
            runtime_gates: RuntimeGates {
                min_cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                min_device_class: DeviceClass::Low,
            },
            resource_budget: ResourceBudget {
                max_download_bytes: size,
                max_installed_bytes: size,
                max_memory_bytes: 1024,
            },
            compatibility: Compatibility {
                group_id: "group".to_owned(),
                voice_state_group_id: "voice-state".to_owned(),
                preprocessing_abi: "pre".to_owned(),
                postprocessing_abi: "post".to_owned(),
                sample_rate_hz: 16_000,
                channels: 1,
                frame_size: 512,
                interoperable: false,
            },
            file_ids: vec![file_id.to_owned()],
            abi: AbiRequirements {
                min_aurora_version: "1".to_owned(),
                min_runtime_version: "1".to_owned(),
                min_engine_version: "1".to_owned(),
                engine_source_revision: "rev".to_owned(),
                build_flags: Vec::new(),
            },
            revocation: None,
        }
    }

    fn manifest(id: &str, version: &str, hash: &str, size: u64) -> ModelPackManifest {
        ModelPackManifest {
            schema_version: 1,
            pack_id: id.to_owned(),
            pack_version: version.to_owned(),
            display_name: "Pack".to_owned(),
            tasks: vec![PackTask::Stt],
            license: license(),
            languages: vec![LanguageSupport {
                language: "en".to_owned(),
                locale: Some("en-US".to_owned()),
                fixed_language: true,
                auto_detect: false,
            }],
            capabilities: CapabilityFlags {
                streaming: true,
                cancellation: true,
            },
            provenance: provenance(),
            files: vec![model_file("model", hash, size)],
            variants: vec![variant(
                "linux",
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
                "model",
                size,
            )],
            rollback_from: None,
            supersedes_pack_id: None,
            revocation: None,
            signature: Some(ManifestSignature {
                key_id: "key".to_owned(),
                algorithm: "ed25519".to_owned(),
                value: "signed".to_owned(),
            }),
        }
    }

    fn verified(id: &str, version: &str, hash: &str, size: u64) -> VerifiedManifest {
        let result = verify_manifest(
            manifest(id, version, hash, size),
            &TrustPolicy::default(),
            Some(&AcceptingVerifier),
        );
        match result {
            Ok(verified) => verified,
            Err(error) => panic!("fixture manifest should verify: {error}"),
        }
    }

    async fn install_ready(
        store: &mut InMemoryModelStore,
        manifest: &VerifiedManifest,
    ) -> Result<(), ModelPackError> {
        let selection = selection_for(manifest);
        let file = &manifest.manifest().files[0];
        let task = store.reserve_file(manifest, &selection, file).await?;
        assert!(store.resume_metadata(&task.storage_key).await?.is_some());
        store
            .promote_file(&task.storage_key, &file.sha256, file.byte_size)
            .await?;
        store
            .set_lifecycle(create_lifecycle_snapshot(
                manifest.manifest().pack_id.clone(),
                manifest.manifest().pack_version.clone(),
                0,
                InstallState::Ready,
            ))
            .await
    }

    #[tokio::test]
    async fn quota_counts_reservations_and_promoted_files() -> Result<(), ModelPackError> {
        let manifest = verified("pack", "1", HASH, 60);
        let selection = selection_for(&manifest);
        let mut store = InMemoryModelStore::new(Some(100));
        let task = store
            .reserve_file(&manifest, &selection, &manifest.manifest().files[0])
            .await?;
        assert_eq!(store.status().await?.bytes_reserved, 60);
        assert_eq!(
            store
                .reserve_file(&manifest, &selection, &manifest.manifest().files[0])
                .await,
            Err(ModelPackError::QuotaExceeded)
        );
        store.promote_file(&task.storage_key, HASH, 60).await?;
        assert_eq!(store.status().await?.bytes_used, 60);
        Ok(())
    }

    #[tokio::test]
    async fn promote_checks_hash_size_and_keeps_reservation_on_failure(
    ) -> Result<(), ModelPackError> {
        let manifest = verified("pack", "1", HASH, 60);
        let selection = selection_for(&manifest);
        let mut store = InMemoryModelStore::new(Some(100));
        let task = store
            .reserve_file(&manifest, &selection, &manifest.manifest().files[0])
            .await?;
        assert_eq!(
            store.promote_file(&task.storage_key, HASH_B, 60).await,
            Err(ModelPackError::Store { code: "hash" })
        );
        assert!(store.resume_metadata(&task.storage_key).await?.is_some());
        Ok(())
    }

    #[tokio::test]
    async fn activation_is_atomic_and_retains_single_rollback() -> Result<(), ModelPackError> {
        let first = verified("pack-a", "1", HASH, 10);
        let second = verified("pack-b", "1", HASH_B, 10);
        let first_selection = selection_for(&first);
        let second_selection = selection_for(&second);
        let mut store = InMemoryModelStore::new(Some(100));
        install_ready(&mut store, &first).await?;
        install_ready(&mut store, &second).await?;
        store.activate_pack(&first, &first_selection).await?;
        assert_eq!(
            store.active_pack().await?.map(|active| active.pack_id),
            Some("pack-a".to_owned())
        );
        store.activate_pack(&second, &second_selection).await?;
        assert_eq!(
            store.active_pack().await?.map(|active| active.pack_id),
            Some("pack-b".to_owned())
        );
        assert_eq!(
            store
                .rollback_identity()
                .map(|identity| identity.pack_id.as_str()),
            Some("pack-a")
        );
        let rolled_back = store.rollback_active().await?;
        assert_eq!(
            rolled_back.map(|snapshot| snapshot.pack_id),
            Some("pack-a".to_owned())
        );
        assert_eq!(
            store.active_pack().await?.map(|active| active.pack_id),
            Some("pack-a".to_owned())
        );
        Ok(())
    }

    #[tokio::test]
    async fn injected_activation_failure_leaves_old_active_untouched() -> Result<(), ModelPackError>
    {
        let first = verified("pack-a", "1", HASH, 10);
        let second = verified("pack-b", "1", HASH_B, 10);
        let first_selection = selection_for(&first);
        let second_selection = selection_for(&second);
        let mut store = InMemoryModelStore::new(Some(100));
        install_ready(&mut store, &first).await?;
        install_ready(&mut store, &second).await?;
        store.activate_pack(&first, &first_selection).await?;
        store.inject_persistence_failure();
        assert_eq!(
            store.activate_pack(&second, &second_selection).await,
            Err(ModelPackError::Store {
                code: "persistence"
            })
        );
        assert_eq!(
            store.active_pack().await?.map(|active| active.pack_id),
            Some("pack-a".to_owned())
        );
        Ok(())
    }

    #[tokio::test]
    async fn corruption_and_revocation_withdraw_readiness_and_fail_closed(
    ) -> Result<(), ModelPackError> {
        let manifest = verified("pack", "1", HASH, 10);
        let selection = selection_for(&manifest);
        let mut store = InMemoryModelStore::new(Some(100));
        install_ready(&mut store, &manifest).await?;
        store.activate_pack(&manifest, &selection).await?;
        store.mark_corrupt("pack");
        assert!(store.active_pack().await?.is_none());
        assert_eq!(
            store.open_immutable_file(&selection, "model").await,
            Err(ModelPackError::Store { code: "corrupt" })
        );
        let other = verified("other", "1", HASH_B, 10);
        let other_selection = selection_for(&other);
        install_ready(&mut store, &other).await?;
        store.revoke_pack("other");
        assert_eq!(
            store.activate_pack(&other, &other_selection).await,
            Err(ModelPackError::Store { code: "revoked" })
        );
        Ok(())
    }

    #[tokio::test]
    async fn selected_variant_installs_without_requiring_other_target_files(
    ) -> Result<(), ModelPackError> {
        let mut raw = manifest("pack", "1", HASH, 10);
        raw.files = vec![
            model_file("desktop-model", HASH, 10),
            model_file("android-model", HASH_B, 20),
        ];
        raw.variants = vec![
            variant(
                "linux",
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
                "desktop-model",
                10,
            ),
            variant(
                "android",
                RuntimeTarget::Android,
                TargetOs::Android,
                TargetArch::Aarch64,
                "android-model",
                20,
            ),
        ];
        let verified = verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier))?;
        let desktop_selection = select_for(
            &verified,
            RuntimeTarget::Desktop,
            TargetOs::Linux,
            TargetArch::X86_64,
        );
        let android_selection = select_for(
            &verified,
            RuntimeTarget::Android,
            TargetOs::Android,
            TargetArch::Aarch64,
        );
        let mut store = InMemoryModelStore::new(Some(100));
        let desktop_file = &verified.manifest().files[0];
        let android_file = &verified.manifest().files[1];

        assert_eq!(
            store
                .reserve_file(&verified, &desktop_selection, android_file)
                .await,
            Err(ModelPackError::Store { code: "selection" })
        );
        let task = store
            .reserve_file(&verified, &desktop_selection, desktop_file)
            .await?;
        store
            .promote_file(
                &task.storage_key,
                &desktop_file.sha256,
                desktop_file.byte_size,
            )
            .await?;
        store
            .set_lifecycle(create_lifecycle_snapshot(
                verified.manifest().pack_id.clone(),
                verified.manifest().pack_version.clone(),
                0,
                InstallState::Ready,
            ))
            .await?;
        store.activate_pack(&verified, &desktop_selection).await?;

        assert_eq!(
            store
                .open_immutable_file(&desktop_selection, "desktop-model")
                .await?
                .variant_id,
            "linux"
        );
        assert_eq!(
            store
                .open_immutable_file(&android_selection, "android-model")
                .await,
            Err(ModelPackError::Store {
                code: "missing_file"
            })
        );
        Ok(())
    }

    #[tokio::test]
    async fn version_isolation_and_remove_are_deterministic() -> Result<(), ModelPackError> {
        let first = verified("pack", "1", HASH, 10);
        let second = verified("pack", "2", HASH_B, 10);
        let mut store = InMemoryModelStore::new(Some(100));
        install_ready(&mut store, &first).await?;
        install_ready(&mut store, &second).await?;
        assert!(store.lifecycle("pack", "1").await?.is_some());
        assert!(store.lifecycle("pack", "2").await?.is_some());
        store.remove_pack("pack").await?;
        assert!(store.lifecycle("pack", "1").await?.is_none());
        assert!(store.lifecycle("pack", "2").await?.is_none());
        Ok(())
    }

    #[test]
    fn snapshots_and_errors_do_not_expose_raw_bytes_or_secrets() {
        let status = StoreStatus {
            bytes_used: 1,
            bytes_reserved: 2,
            bytes_available: Some(3),
            persistent: true,
        };
        let rendered = format!(
            "{status:?} {} {:?}",
            ModelPackError::Store { code: "hash" },
            LicenseGrant::RedistributionAllowed
        );
        assert!(!rendered.contains("https://"));
        assert!(!rendered.contains("signed"));
        assert!(!rendered.contains(HASH));
    }
}

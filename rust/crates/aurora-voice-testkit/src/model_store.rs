use async_trait::async_trait;
use aurora_voice_engine::{
    apply_lifecycle_event, create_lifecycle_snapshot, file_storage_key, scope_matches_manifest,
    ActivePackIdentity, DownloadTask, ImmutableModelFile, InstallEvent, InstallState,
    LifecycleSnapshot, ModelPackError, ModelPackFile, ModelStore, ModelStoreScope, SelectedVariant,
    StoreStatus, StoredFile, VerifiedManifest,
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
    lifecycles: BTreeMap<(String, String, String), LifecycleSnapshot>,
    active: BTreeMap<ModelStoreScope, ActivePackIdentity>,
    rollback: BTreeMap<ModelStoreScope, ActivePackIdentity>,
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
            active: BTreeMap::new(),
            rollback: BTreeMap::new(),
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
        self.lifecycles
            .retain(|(id, _, _), _snapshot| id.as_str() != pack_id);
        self.active.retain(|_, active| active.pack_id != pack_id);
        self.rollback
            .retain(|_, rollback| rollback.pack_id != pack_id);
    }

    pub fn revoke_pack(&mut self, pack_id: &str) {
        self.revoked.insert(pack_id.to_owned());
        self.withdraw_lifecycles_for_revocation(pack_id);
        self.active.retain(|_, active| active.pack_id != pack_id);
        self.rollback
            .retain(|_, rollback| rollback.pack_id != pack_id);
    }

    pub fn rollback_identity(&self, scope: &ModelStoreScope) -> Option<&ActivePackIdentity> {
        self.rollback.get(scope)
    }

    fn used_bytes(&self) -> Result<u64, ModelPackError> {
        physical_file_bytes(&self.files)
    }

    fn reserved_bytes(&self) -> Result<u64, ModelPackError> {
        physical_reserved_bytes(&self.files, &self.reservations)
    }

    fn ensure_reservation_quota(&self, sha256: &str, byte_size: u64) -> Result<(), ModelPackError> {
        if let Some(limit) = self.bytes_available {
            if physical_total_after_reservation(&self.files, &self.reservations, sha256, byte_size)?
                > limit
            {
                return Err(ModelPackError::QuotaExceeded);
            }
        } else {
            physical_total_after_reservation(&self.files, &self.reservations, sha256, byte_size)?;
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

    fn lifecycle_key(
        pack_id: &str,
        pack_version: &str,
        variant_id: &str,
    ) -> (String, String, String) {
        (
            pack_id.to_owned(),
            pack_version.to_owned(),
            variant_id.to_owned(),
        )
    }

    fn withdraw_lifecycles_for_revocation(&mut self, pack_id: &str) {
        let keys: Vec<_> = self
            .lifecycles
            .keys()
            .filter(|(id, _, _)| id == pack_id)
            .cloned()
            .collect();
        for key in keys {
            let Some(snapshot) = self.lifecycles.get(&key).cloned() else {
                continue;
            };
            match apply_lifecycle_event(&snapshot, InstallEvent::Revoke, self.now, None) {
                Ok(revoked) => {
                    self.lifecycles.insert(key, revoked);
                }
                Err(_) => {
                    self.lifecycles.remove(&key);
                }
            }
        }
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

    fn identity(
        scope: ModelStoreScope,
        pack_id: impl Into<String>,
        pack_version: impl Into<String>,
        variant_id: impl Into<String>,
    ) -> ActivePackIdentity {
        ActivePackIdentity {
            scope,
            pack_id: pack_id.into(),
            pack_version: pack_version.into(),
            variant_id: variant_id.into(),
        }
    }

    fn same_selection(left: &ActivePackIdentity, right: &ActivePackIdentity) -> bool {
        left.pack_id == right.pack_id
            && left.pack_version == right.pack_version
            && left.variant_id == right.variant_id
    }

    fn active_ref_count_after(
        active: &BTreeMap<ModelStoreScope, ActivePackIdentity>,
        identity: &ActivePackIdentity,
    ) -> usize {
        active
            .values()
            .filter(|candidate| Self::same_selection(candidate, identity))
            .count()
    }

    fn lifecycle_for_identity(&self, identity: &ActivePackIdentity) -> Option<LifecycleSnapshot> {
        self.lifecycles
            .get(&Self::lifecycle_key(
                &identity.pack_id,
                &identity.pack_version,
                &identity.variant_id,
            ))
            .cloned()
    }
}

#[async_trait(?Send)]
impl ModelStore for InMemoryModelStore {
    async fn status(&self) -> Result<StoreStatus, ModelPackError> {
        Ok(StoreStatus {
            bytes_used: self.used_bytes()?,
            bytes_reserved: self.reserved_bytes()?,
            bytes_available: self.bytes_available,
            persistent: self.persistent,
        })
    }

    async fn lifecycle(
        &self,
        pack_id: &str,
        pack_version: &str,
        variant_id: &str,
    ) -> Result<Option<LifecycleSnapshot>, ModelPackError> {
        Ok(self
            .lifecycles
            .get(&Self::lifecycle_key(pack_id, pack_version, variant_id))
            .cloned())
    }

    async fn set_lifecycle(&mut self, snapshot: LifecycleSnapshot) -> Result<(), ModelPackError> {
        self.maybe_fail_persist()?;
        self.lifecycles.insert(
            Self::lifecycle_key(
                &snapshot.pack_id,
                &snapshot.pack_version,
                &snapshot.variant_id,
            ),
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
        let storage_key = file_storage_key(
            &manifest.manifest().pack_id,
            &manifest.manifest().pack_version,
            selection.variant_id(),
            &file.file_id,
        );
        if let Some(existing) = self.files.get(&storage_key) {
            if existing.sha256 == file.sha256 && existing.byte_size == file.byte_size {
                return Ok(DownloadTask {
                    storage_key,
                    pack_id: existing.pack_id.clone(),
                    pack_version: existing.pack_version.clone(),
                    file_id: existing.file_id.clone(),
                    url: file.url.clone(),
                    expected_sha256: file.sha256.clone(),
                    expected_bytes: file.byte_size,
                    variant_id: existing.variant_id.clone(),
                });
            }
            return Err(ModelPackError::Store { code: "corrupt" });
        }
        if let Some(existing) = self.reservations.get(&storage_key) {
            if existing.task.pack_id == manifest.manifest().pack_id
                && existing.task.pack_version == manifest.manifest().pack_version
                && existing.task.file_id == file.file_id
                && existing.task.variant_id == selection.variant_id()
                && existing.task.url == file.url
                && existing.task.expected_sha256 == file.sha256
                && existing.task.expected_bytes == file.byte_size
            {
                return Ok(existing.task.clone());
            }
            return Err(ModelPackError::Store {
                code: "reservation",
            });
        }
        self.ensure_reservation_quota(&file.sha256, file.byte_size)?;
        self.maybe_fail_persist()?;
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
        self.ensure_reservation_quota(sha256, byte_size)?;
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
        scope: ModelStoreScope,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<LifecycleSnapshot, ModelPackError> {
        if !selection.belongs_to(manifest) {
            return Err(ModelPackError::Store { code: "selection" });
        }
        scope_matches_manifest(&scope, manifest)?;
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
            selection.variant_id(),
        );
        let current = self
            .lifecycles
            .get(&current_key)
            .cloned()
            .unwrap_or_else(|| {
                create_lifecycle_snapshot(
                    manifest.manifest().pack_id.clone(),
                    manifest.manifest().pack_version.clone(),
                    selection.variant_id().to_owned(),
                    self.now,
                    InstallState::Ready,
                )
            });
        if current.state != InstallState::Ready && current.state != InstallState::Active {
            return Err(ModelPackError::Store { code: "not_ready" });
        }

        let requested_identity = Self::identity(
            scope.clone(),
            manifest.manifest().pack_id.clone(),
            manifest.manifest().pack_version.clone(),
            selection.variant_id().to_owned(),
        );
        let previous_active_for_scope = self.active.get(&scope).cloned();
        let previous_active = self.active.clone();
        let previous_lifecycles = self.lifecycles.clone();
        let previous_rollback = self.rollback.clone();
        self.maybe_fail_persist()?;

        if let Some(active) = &previous_active_for_scope {
            if !Self::same_selection(active, &requested_identity) {
                self.rollback.insert(scope.clone(), active.clone());
            }
        }
        self.active
            .insert(scope.clone(), requested_identity.clone());

        if let Some(previous) = previous_active_for_scope.as_ref() {
            if !Self::same_selection(previous, &requested_identity)
                && Self::active_ref_count_after(&self.active, previous) == 0
            {
                if let Some(snapshot) = self.lifecycle_for_identity(previous) {
                    let deactivated =
                        apply_lifecycle_event(&snapshot, InstallEvent::Deactivate, self.now, None)?;
                    self.lifecycles.insert(
                        Self::lifecycle_key(
                            &deactivated.pack_id,
                            &deactivated.pack_version,
                            &deactivated.variant_id,
                        ),
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
        self.lifecycles.insert(current_key, active.clone());
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

    async fn rollback_active(
        &mut self,
        scope: ModelStoreScope,
    ) -> Result<Option<LifecycleSnapshot>, ModelPackError> {
        let Some(rollback) = self.rollback.get(&scope).cloned() else {
            return Ok(None);
        };
        self.require_not_withdrawn(&rollback.pack_id)?;
        if rollback.scope != scope {
            return Err(ModelPackError::Store { code: "scope" });
        }
        let snapshot = self
            .lifecycles
            .get(&Self::lifecycle_key(
                &rollback.pack_id,
                &rollback.pack_version,
                &rollback.variant_id,
            ))
            .cloned()
            .ok_or(ModelPackError::Store { code: "rollback" })?;
        if snapshot.state != InstallState::Ready && snapshot.state != InstallState::Active {
            return Err(ModelPackError::Store { code: "rollback" });
        }
        let previous_active = self.active.clone();
        let previous_lifecycles = self.lifecycles.clone();
        let previous_rollback = self.rollback.clone();
        self.maybe_fail_persist()?;

        let current_active = self.active.get(&scope).cloned();
        self.active.insert(scope.clone(), rollback.clone());
        self.rollback.remove(&scope);

        if let Some(active) = current_active {
            if !Self::same_selection(&active, &rollback)
                && Self::active_ref_count_after(&self.active, &active) == 0
            {
                if let Some(snapshot) = self.lifecycle_for_identity(&active) {
                    let ready =
                        apply_lifecycle_event(&snapshot, InstallEvent::Deactivate, self.now, None)?;
                    self.lifecycles.insert(
                        Self::lifecycle_key(&ready.pack_id, &ready.pack_version, &ready.variant_id),
                        ready,
                    );
                }
            }
        }
        let active = if snapshot.state == InstallState::Active {
            snapshot
        } else {
            apply_lifecycle_event(&snapshot, InstallEvent::Activate, self.now, None)?
        };
        self.lifecycles.insert(
            Self::lifecycle_key(&active.pack_id, &active.pack_version, &active.variant_id),
            active.clone(),
        );
        if self.fail_next_persist {
            self.lifecycles = previous_lifecycles;
            self.active = previous_active;
            self.rollback = previous_rollback;
            self.fail_next_persist = false;
            return Err(ModelPackError::Store {
                code: "persistence",
            });
        }
        Ok(Some(active))
    }

    async fn remove_pack(&mut self, pack_id: &str) -> Result<(), ModelPackError> {
        self.maybe_fail_persist()?;
        self.files.retain(|_, file| file.pack_id != pack_id);
        self.reservations
            .retain(|_, reservation| reservation.task.pack_id != pack_id);
        self.lifecycles
            .retain(|(id, _, _), _snapshot| id.as_str() != pack_id);
        self.active.retain(|_, active| active.pack_id != pack_id);
        self.rollback
            .retain(|_, rollback| rollback.pack_id != pack_id);
        Ok(())
    }

    async fn active_pack(
        &self,
        scope: ModelStoreScope,
    ) -> Result<Option<ActivePackIdentity>, ModelPackError> {
        Ok(self.active.get(&scope).cloned())
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

fn physical_file_bytes(files: &BTreeMap<String, StoredFile>) -> Result<u64, ModelPackError> {
    let blobs = promoted_blob_charges(files)?;
    checked_sum(blobs.values().copied())
}

fn physical_reserved_bytes(
    files: &BTreeMap<String, StoredFile>,
    reservations: &BTreeMap<String, Reservation>,
) -> Result<u64, ModelPackError> {
    let promoted = promoted_blob_charges(files)?;
    let mut blobs = BTreeMap::<String, u64>::new();
    for reservation in reservations.values() {
        match promoted.get(&reservation.task.expected_sha256) {
            Some(existing) if *existing == reservation.task.expected_bytes => {}
            Some(_) => return Err(ModelPackError::Store { code: "corrupt" }),
            None => insert_blob_charge(
                &mut blobs,
                &reservation.task.expected_sha256,
                reservation.task.expected_bytes,
            )?,
        }
    }
    checked_sum(blobs.values().copied())
}

fn promoted_blob_charges(
    files: &BTreeMap<String, StoredFile>,
) -> Result<BTreeMap<String, u64>, ModelPackError> {
    let mut blobs = BTreeMap::<String, u64>::new();
    for file in files.values() {
        insert_blob_charge(&mut blobs, &file.sha256, file.byte_size)?;
    }
    Ok(blobs)
}

fn physical_total_after_reservation(
    files: &BTreeMap<String, StoredFile>,
    reservations: &BTreeMap<String, Reservation>,
    sha256: &str,
    byte_size: u64,
) -> Result<u64, ModelPackError> {
    let mut blobs = BTreeMap::<String, u64>::new();
    for file in files.values() {
        insert_blob_charge(&mut blobs, &file.sha256, file.byte_size)?;
    }
    for reservation in reservations.values() {
        insert_blob_charge(
            &mut blobs,
            &reservation.task.expected_sha256,
            reservation.task.expected_bytes,
        )?;
    }
    insert_blob_charge(&mut blobs, sha256, byte_size)?;
    checked_sum(blobs.values().copied())
}

fn insert_blob_charge(
    blobs: &mut BTreeMap<String, u64>,
    sha256: &str,
    byte_size: u64,
) -> Result<(), ModelPackError> {
    match blobs.get(sha256) {
        Some(existing) if *existing == byte_size => Ok(()),
        Some(_) => Err(ModelPackError::Store { code: "corrupt" }),
        None => {
            blobs.insert(sha256.to_owned(), byte_size);
            Ok(())
        }
    }
}

fn checked_sum(values: impl IntoIterator<Item = u64>) -> Result<u64, ModelPackError> {
    let mut total = 0_u64;
    for value in values {
        total = total
            .checked_add(value)
            .ok_or(ModelPackError::QuotaExceeded)?;
    }
    Ok(total)
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
    const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

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

    fn scope(task: PackTask) -> ModelStoreScope {
        ModelStoreScope::default_for_task(task)
    }

    fn model_file_for(file_id: &str, task: PackTask, hash: &str, size: u64) -> ModelPackFile {
        ModelPackFile {
            file_id: file_id.to_owned(),
            asset_id: file_id.to_owned(),
            task,
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

    fn model_file(file_id: &str, hash: &str, size: u64) -> ModelPackFile {
        model_file_for(file_id, PackTask::Stt, hash, size)
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
        manifest_for_task(id, version, PackTask::Stt, hash, size)
    }

    fn manifest_for_task(
        id: &str,
        version: &str,
        task: PackTask,
        hash: &str,
        size: u64,
    ) -> ModelPackManifest {
        ModelPackManifest {
            schema_version: 1,
            pack_id: id.to_owned(),
            pack_version: version.to_owned(),
            display_name: "Pack".to_owned(),
            tasks: vec![task],
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
            files: vec![model_file_for("model", task, hash, size)],
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
        verified_for_task(id, version, PackTask::Stt, hash, size)
    }

    fn verified_for_task(
        id: &str,
        version: &str,
        task: PackTask,
        hash: &str,
        size: u64,
    ) -> VerifiedManifest {
        let result = verify_manifest(
            manifest_for_task(id, version, task, hash, size),
            &TrustPolicy::default(),
            Some(&AcceptingVerifier),
        );
        match result {
            Ok(verified) => verified,
            Err(error) => panic!("fixture manifest should verify: {error}"),
        }
    }

    async fn install_selection_ready(
        store: &mut InMemoryModelStore,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<(), ModelPackError> {
        for file in manifest
            .manifest()
            .files
            .iter()
            .filter(|file| selection.file_ids().contains(&file.file_id))
        {
            let task = store.reserve_file(manifest, selection, file).await?;
            assert!(store.resume_metadata(&task.storage_key).await?.is_some());
            store
                .promote_file(&task.storage_key, &file.sha256, file.byte_size)
                .await?;
        }
        store
            .set_lifecycle(create_lifecycle_snapshot(
                manifest.manifest().pack_id.clone(),
                manifest.manifest().pack_version.clone(),
                selection.variant_id().to_owned(),
                0,
                InstallState::Ready,
            ))
            .await
    }

    async fn install_ready(
        store: &mut InMemoryModelStore,
        manifest: &VerifiedManifest,
    ) -> Result<(), ModelPackError> {
        let selection = selection_for(manifest);
        install_selection_ready(store, manifest, &selection).await
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
        let repeated = store
            .reserve_file(&manifest, &selection, &manifest.manifest().files[0])
            .await?;
        assert_eq!(repeated.storage_key, task.storage_key);
        assert_eq!(store.status().await?.bytes_reserved, 60);
        let changed = verified("pack", "1", HASH_B, 60);
        let changed_selection = selection_for(&changed);
        assert_eq!(
            store
                .reserve_file(&changed, &changed_selection, &changed.manifest().files[0])
                .await,
            Err(ModelPackError::Store {
                code: "reservation"
            })
        );
        store.promote_file(&task.storage_key, HASH, 60).await?;
        assert_eq!(store.status().await?.bytes_used, 60);
        Ok(())
    }

    #[tokio::test]
    async fn quota_deduplicates_physical_hashes_and_rejects_size_conflicts(
    ) -> Result<(), ModelPackError> {
        let first = verified("first", "1", HASH, 60);
        let duplicate = verified("duplicate", "1", HASH, 60);
        let conflict = verified("conflict", "1", HASH, 61);
        let first_selection = selection_for(&first);
        let duplicate_selection = selection_for(&duplicate);
        let conflict_selection = selection_for(&conflict);
        let mut store = InMemoryModelStore::new(Some(60));

        let first_task = store
            .reserve_file(&first, &first_selection, &first.manifest().files[0])
            .await?;
        assert_eq!(store.status().await?.bytes_reserved, 60);
        let duplicate_task = store
            .reserve_file(
                &duplicate,
                &duplicate_selection,
                &duplicate.manifest().files[0],
            )
            .await?;
        assert_eq!(store.status().await?.bytes_reserved, 60);
        assert_eq!(
            store
                .reserve_file(
                    &conflict,
                    &conflict_selection,
                    &conflict.manifest().files[0]
                )
                .await,
            Err(ModelPackError::Store { code: "corrupt" })
        );

        store
            .promote_file(&first_task.storage_key, HASH, 60)
            .await?;
        assert_eq!(store.status().await?.bytes_used, 60);
        assert_eq!(store.status().await?.bytes_reserved, 0);
        assert_eq!(
            store
                .reserve_file(
                    &conflict,
                    &conflict_selection,
                    &conflict.manifest().files[0]
                )
                .await,
            Err(ModelPackError::Store { code: "corrupt" })
        );
        store
            .promote_file(&duplicate_task.storage_key, HASH, 60)
            .await?;
        assert_eq!(store.status().await?.bytes_used, 60);
        Ok(())
    }

    #[tokio::test]
    async fn promoted_hash_reservation_size_conflict_fails_closed() -> Result<(), ModelPackError> {
        let first = verified("first", "1", HASH, 60);
        let conflict = verified("conflict", "1", HASH, 61);
        let conflict_selection = selection_for(&conflict);
        let conflict_file = &conflict.manifest().files[0];
        let conflict_task = DownloadTask {
            storage_key: file_storage_key(
                &conflict.manifest().pack_id,
                &conflict.manifest().pack_version,
                conflict_selection.variant_id(),
                &conflict_file.file_id,
            ),
            pack_id: conflict.manifest().pack_id.clone(),
            pack_version: conflict.manifest().pack_version.clone(),
            file_id: conflict_file.file_id.clone(),
            url: conflict_file.url.clone(),
            expected_sha256: conflict_file.sha256.clone(),
            expected_bytes: conflict_file.byte_size,
            variant_id: conflict_selection.variant_id().to_owned(),
        };
        let mut store = InMemoryModelStore::new(Some(200));
        install_ready(&mut store, &first).await?;
        store.reservations.insert(
            conflict_task.storage_key.clone(),
            Reservation {
                task: conflict_task,
            },
        );

        assert_eq!(
            store.status().await,
            Err(ModelPackError::Store { code: "corrupt" })
        );
        Ok(())
    }

    #[tokio::test]
    async fn quota_uses_checked_arithmetic_for_physical_totals() -> Result<(), ModelPackError> {
        let first = verified("first", "1", HASH, u64::MAX);
        let second = verified("second", "1", HASH_B, u64::MAX);
        let first_selection = selection_for(&first);
        let second_selection = selection_for(&second);
        let mut store = InMemoryModelStore::new(None);

        store
            .reserve_file(&first, &first_selection, &first.manifest().files[0])
            .await?;
        assert_eq!(store.status().await?.bytes_reserved, u64::MAX);
        assert_eq!(
            store
                .reserve_file(&second, &second_selection, &second.manifest().files[0])
                .await,
            Err(ModelPackError::QuotaExceeded)
        );
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
        store
            .activate_pack(scope(PackTask::Stt), &first, &first_selection)
            .await?;
        assert_eq!(
            store
                .active_pack(scope(PackTask::Stt))
                .await?
                .map(|active| active.pack_id),
            Some("pack-a".to_owned())
        );
        store
            .activate_pack(scope(PackTask::Stt), &second, &second_selection)
            .await?;
        assert_eq!(
            store
                .active_pack(scope(PackTask::Stt))
                .await?
                .map(|active| active.pack_id),
            Some("pack-b".to_owned())
        );
        assert_eq!(
            store
                .rollback_identity(&scope(PackTask::Stt))
                .map(|identity| identity.pack_id.as_str()),
            Some("pack-a")
        );
        let rolled_back = store.rollback_active(scope(PackTask::Stt)).await?;
        assert_eq!(
            rolled_back.map(|snapshot| snapshot.pack_id),
            Some("pack-a".to_owned())
        );
        assert_eq!(
            store
                .active_pack(scope(PackTask::Stt))
                .await?
                .map(|active| active.pack_id),
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
        store
            .activate_pack(scope(PackTask::Stt), &first, &first_selection)
            .await?;
        store.inject_persistence_failure();
        assert_eq!(
            store
                .activate_pack(scope(PackTask::Stt), &second, &second_selection)
                .await,
            Err(ModelPackError::Store {
                code: "persistence"
            })
        );
        assert_eq!(
            store
                .active_pack(scope(PackTask::Stt))
                .await?
                .map(|active| active.pack_id),
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
        store
            .activate_pack(scope(PackTask::Stt), &manifest, &selection)
            .await?;
        store.mark_corrupt("pack");
        assert!(store.active_pack(scope(PackTask::Stt)).await?.is_none());
        assert!(store.lifecycle("pack", "1", "linux").await?.is_none());
        assert_eq!(
            store.open_immutable_file(&selection, "model").await,
            Err(ModelPackError::Store { code: "corrupt" })
        );
        let other = verified("other", "1", HASH_B, 10);
        let other_selection = selection_for(&other);
        install_ready(&mut store, &other).await?;
        store.revoke_pack("other");
        assert_eq!(
            store
                .lifecycle("other", "1", "linux")
                .await?
                .map(|snapshot| snapshot.state),
            Some(InstallState::Revoked)
        );
        assert_eq!(
            store
                .activate_pack(scope(PackTask::Stt), &other, &other_selection)
                .await,
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
                desktop_selection.variant_id().to_owned(),
                0,
                InstallState::Ready,
            ))
            .await?;
        store
            .activate_pack(scope(PackTask::Stt), &verified, &desktop_selection)
            .await?;

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
    async fn selected_variant_requires_transitive_dependency_files() -> Result<(), ModelPackError> {
        let mut raw = manifest("pack", "1", HASH, 10);
        raw.files = vec![
            model_file_for("model", PackTask::Stt, HASH, 10),
            model_file_for("frontend", PackTask::Frontend, HASH_B, 20),
            model_file_for("tokenizer", PackTask::Tokenizer, HASH_C, 30),
        ];
        raw.files[0].dependencies = vec!["frontend".to_owned()];
        raw.files[1].dependencies = vec!["tokenizer".to_owned()];
        raw.variants[0].resource_budget.max_download_bytes = 60;
        raw.variants[0].resource_budget.max_installed_bytes = 60;
        let verified = verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier))?;
        let selection = selection_for(&verified);
        assert_eq!(
            selection
                .file_ids()
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["frontend", "model", "tokenizer"]
        );

        let mut store = InMemoryModelStore::new(Some(60));
        let root_file = verified
            .manifest()
            .files
            .iter()
            .find(|file| file.file_id == "model")
            .expect("root file");
        let task = store.reserve_file(&verified, &selection, root_file).await?;
        store
            .promote_file(&task.storage_key, &root_file.sha256, root_file.byte_size)
            .await?;
        store
            .set_lifecycle(create_lifecycle_snapshot(
                verified.manifest().pack_id.clone(),
                verified.manifest().pack_version.clone(),
                selection.variant_id().to_owned(),
                0,
                InstallState::Ready,
            ))
            .await?;
        assert_eq!(
            store
                .activate_pack(scope(PackTask::Stt), &verified, &selection)
                .await,
            Err(ModelPackError::Store {
                code: "missing_file"
            })
        );

        let mut store = InMemoryModelStore::new(Some(60));
        install_selection_ready(&mut store, &verified, &selection).await?;
        store
            .activate_pack(scope(PackTask::Stt), &verified, &selection)
            .await?;
        assert_eq!(
            store
                .open_immutable_file(&selection, "tokenizer")
                .await?
                .variant_id,
            "linux"
        );
        assert_eq!(store.status().await?.bytes_used, 60);
        Ok(())
    }

    #[tokio::test]
    async fn lifecycle_and_rollback_are_scoped_to_variant() -> Result<(), ModelPackError> {
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

        for (selection, file) in [
            (&desktop_selection, &verified.manifest().files[0]),
            (&android_selection, &verified.manifest().files[1]),
        ] {
            let task = store.reserve_file(&verified, selection, file).await?;
            store
                .promote_file(&task.storage_key, &file.sha256, file.byte_size)
                .await?;
            store
                .set_lifecycle(create_lifecycle_snapshot(
                    verified.manifest().pack_id.clone(),
                    verified.manifest().pack_version.clone(),
                    selection.variant_id().to_owned(),
                    0,
                    InstallState::Ready,
                ))
                .await?;
        }

        store
            .activate_pack(scope(PackTask::Stt), &verified, &desktop_selection)
            .await?;
        store
            .activate_pack(scope(PackTask::Stt), &verified, &android_selection)
            .await?;
        assert_eq!(
            store
                .active_pack(scope(PackTask::Stt))
                .await?
                .map(|active| active.variant_id),
            Some("android".to_owned())
        );
        assert_eq!(
            store
                .rollback_identity(&scope(PackTask::Stt))
                .map(|identity| identity.variant_id.as_str()),
            Some("linux")
        );
        assert_eq!(
            store
                .open_immutable_file(&desktop_selection, "android-model")
                .await,
            Err(ModelPackError::Store { code: "selection" })
        );
        assert_eq!(
            store
                .open_immutable_file(&android_selection, "desktop-model")
                .await,
            Err(ModelPackError::Store { code: "selection" })
        );
        let rolled_back = store.rollback_active(scope(PackTask::Stt)).await?;
        assert_eq!(
            rolled_back.map(|snapshot| snapshot.variant_id),
            Some("linux".to_owned())
        );
        assert_eq!(
            store
                .active_pack(scope(PackTask::Stt))
                .await?
                .map(|active| active.variant_id),
            Some("linux".to_owned())
        );
        assert_eq!(
            store
                .lifecycle("pack", "1", "android")
                .await?
                .map(|s| s.state),
            Some(InstallState::Ready)
        );
        assert_eq!(
            store
                .lifecycle("pack", "1", "linux")
                .await?
                .map(|s| s.state),
            Some(InstallState::Active)
        );
        Ok(())
    }

    #[tokio::test]
    async fn logical_task_scopes_are_active_concurrently_and_rollback_independently(
    ) -> Result<(), ModelPackError> {
        let kws = verified_for_task("kws-pack", "1", PackTask::Kws, HASH, 10);
        let vad = verified_for_task("vad-pack", "1", PackTask::Vad, HASH, 10);
        let stt_v1 = verified_for_task("stt-pack", "1", PackTask::Stt, HASH, 10);
        let stt_v2 = verified_for_task("stt-pack", "2", PackTask::Stt, HASH_B, 10);
        let tts_v1 = verified_for_task("tts-pack", "1", PackTask::Tts, HASH, 10);
        let tts_v2 = verified_for_task("tts-pack", "2", PackTask::Tts, HASH_B, 10);
        let mut store = InMemoryModelStore::new(Some(200));
        for manifest in [&kws, &vad, &stt_v1, &stt_v2, &tts_v1, &tts_v2] {
            install_ready(&mut store, manifest).await?;
        }

        store
            .activate_pack(scope(PackTask::Kws), &kws, &selection_for(&kws))
            .await?;
        store
            .activate_pack(scope(PackTask::Vad), &vad, &selection_for(&vad))
            .await?;
        store
            .activate_pack(scope(PackTask::Stt), &stt_v1, &selection_for(&stt_v1))
            .await?;
        store
            .activate_pack(scope(PackTask::Tts), &tts_v1, &selection_for(&tts_v1))
            .await?;

        store
            .activate_pack(scope(PackTask::Stt), &stt_v2, &selection_for(&stt_v2))
            .await?;
        store
            .activate_pack(scope(PackTask::Tts), &tts_v2, &selection_for(&tts_v2))
            .await?;
        assert_eq!(
            store
                .active_pack(scope(PackTask::Kws))
                .await?
                .map(|active| active.pack_id),
            Some("kws-pack".to_owned())
        );
        assert_eq!(
            store
                .active_pack(scope(PackTask::Vad))
                .await?
                .map(|active| active.pack_id),
            Some("vad-pack".to_owned())
        );
        assert_eq!(
            store
                .active_pack(scope(PackTask::Stt))
                .await?
                .map(|active| active.pack_version),
            Some("2".to_owned())
        );
        assert_eq!(
            store
                .active_pack(scope(PackTask::Tts))
                .await?
                .map(|active| active.pack_version),
            Some("2".to_owned())
        );

        let rolled_back = store.rollback_active(scope(PackTask::Stt)).await?;
        assert_eq!(
            rolled_back.map(|snapshot| snapshot.pack_version),
            Some("1".to_owned())
        );
        assert_eq!(
            store
                .active_pack(scope(PackTask::Stt))
                .await?
                .map(|active| active.pack_version),
            Some("1".to_owned())
        );
        assert_eq!(
            store
                .active_pack(scope(PackTask::Tts))
                .await?
                .map(|active| active.pack_version),
            Some("2".to_owned())
        );
        assert_eq!(
            store
                .rollback_identity(&scope(PackTask::Tts))
                .map(|identity| identity.pack_version.as_str()),
            Some("1")
        );
        Ok(())
    }

    #[tokio::test]
    async fn reused_selection_remains_active_until_last_scope_leaves() -> Result<(), ModelPackError>
    {
        let mut raw = manifest("shared-pack", "1", HASH, 10);
        raw.tasks = vec![PackTask::Stt, PackTask::Tts];
        raw.files = vec![
            model_file_for("stt-model", PackTask::Stt, HASH, 10),
            model_file_for("tts-model", PackTask::Tts, HASH_B, 10),
        ];
        raw.variants = vec![variant(
            "linux",
            RuntimeTarget::Desktop,
            TargetOs::Linux,
            TargetArch::X86_64,
            "stt-model",
            20,
        )];
        raw.variants[0].file_ids = vec!["stt-model".to_owned(), "tts-model".to_owned()];
        let shared = verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier))?;
        let shared_selection = selection_for(&shared);
        let other_stt = verified_for_task("other-stt", "1", PackTask::Stt, HASH, 10);
        let other_tts = verified_for_task("other-tts", "1", PackTask::Tts, HASH_B, 10);
        let mut store = InMemoryModelStore::new(Some(200));
        install_selection_ready(&mut store, &shared, &shared_selection).await?;
        install_ready(&mut store, &other_stt).await?;
        install_ready(&mut store, &other_tts).await?;

        store
            .activate_pack(scope(PackTask::Stt), &shared, &shared_selection)
            .await?;
        store
            .activate_pack(scope(PackTask::Tts), &shared, &shared_selection)
            .await?;
        store
            .activate_pack(scope(PackTask::Stt), &other_stt, &selection_for(&other_stt))
            .await?;
        assert_eq!(
            store
                .lifecycle("shared-pack", "1", "linux")
                .await?
                .map(|snapshot| snapshot.state),
            Some(InstallState::Active)
        );
        store
            .activate_pack(scope(PackTask::Tts), &other_tts, &selection_for(&other_tts))
            .await?;
        assert_eq!(
            store
                .lifecycle("shared-pack", "1", "linux")
                .await?
                .map(|snapshot| snapshot.state),
            Some(InstallState::Ready)
        );
        Ok(())
    }

    #[tokio::test]
    async fn task_mismatch_fails_without_mutation() -> Result<(), ModelPackError> {
        let stt = verified_for_task("stt-pack", "1", PackTask::Stt, HASH, 10);
        let replacement = verified_for_task("replacement", "1", PackTask::Stt, HASH_B, 10);
        let mut store = InMemoryModelStore::new(Some(100));
        install_ready(&mut store, &stt).await?;
        install_ready(&mut store, &replacement).await?;
        store
            .activate_pack(scope(PackTask::Stt), &stt, &selection_for(&stt))
            .await?;

        assert_eq!(
            store
                .activate_pack(
                    scope(PackTask::Tts),
                    &replacement,
                    &selection_for(&replacement)
                )
                .await,
            Err(ModelPackError::Store { code: "scope_task" })
        );
        assert_eq!(
            store
                .active_pack(scope(PackTask::Stt))
                .await?
                .map(|active| active.pack_id),
            Some("stt-pack".to_owned())
        );
        assert!(store.active_pack(scope(PackTask::Tts)).await?.is_none());
        assert!(store.rollback_identity(&scope(PackTask::Tts)).is_none());
        Ok(())
    }

    #[tokio::test]
    async fn revoking_one_pack_withdraws_only_affected_scoped_pointers(
    ) -> Result<(), ModelPackError> {
        let kws = verified_for_task("kws-pack", "1", PackTask::Kws, HASH, 10);
        let stt = verified_for_task("stt-pack", "1", PackTask::Stt, HASH_B, 10);
        let mut store = InMemoryModelStore::new(Some(100));
        install_ready(&mut store, &kws).await?;
        install_ready(&mut store, &stt).await?;
        store
            .activate_pack(scope(PackTask::Kws), &kws, &selection_for(&kws))
            .await?;
        store
            .activate_pack(scope(PackTask::Stt), &stt, &selection_for(&stt))
            .await?;

        store.revoke_pack("stt-pack");
        assert!(store.active_pack(scope(PackTask::Stt)).await?.is_none());
        assert_eq!(
            store
                .active_pack(scope(PackTask::Kws))
                .await?
                .map(|active| active.pack_id),
            Some("kws-pack".to_owned())
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
        assert!(store.lifecycle("pack", "1", "linux").await?.is_some());
        assert!(store.lifecycle("pack", "2", "linux").await?.is_some());
        store.remove_pack("pack").await?;
        assert!(store.lifecycle("pack", "1", "linux").await?.is_none());
        assert!(store.lifecycle("pack", "2", "linux").await?.is_none());
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

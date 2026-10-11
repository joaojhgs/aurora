//! Provision the fixed private root shared by native canonical-profile stores.
//!
//! The caller must pass the already-resolved OS-user-local Aurora application
//! data directory from trusted native bootstrap. This function does not prove
//! the path's origin, authenticate a caller, establish cross-process ownership,
//! or adopt legacy profile or policy records. It is blocking and must run
//! before stores are constructed or profile/policy requests are admitted.
//! Non-Unix targets fail closed until their directory privacy and durability
//! semantics have a reviewed implementation.

use crate::node_config_coordinator::NativeProfileAdapterError;
use std::path::{Path, PathBuf};

#[cfg(unix)]
const SETTINGS_ROOT_NAME: &str = "native-settings-v2";

/// Create and durably confirm Aurora's fixed private native-settings root.
///
/// The input is a trusted framework-resolved app-local data directory, not an
/// IPC or profile-selected path. Existing trusted ancestors are shape-checked
/// but never chmodded. Newly created directories and the final settings root
/// must have no group/other permissions on Unix. The return value is a
/// confirmed location, not a capability or proof of caller authority.
pub fn provision_native_settings_root(
    trusted_app_local_data_directory: &Path,
) -> Result<PathBuf, NativeProfileAdapterError> {
    #[cfg(unix)]
    {
        let mut create = create_private_directory;
        let mut sync = sync_real_directory;
        provision_unix_with(trusted_app_local_data_directory, &mut create, &mut sync)
    }
    #[cfg(not(unix))]
    {
        let _ = trusted_app_local_data_directory;
        Err(NativeProfileAdapterError)
    }
}

#[cfg(unix)]
fn provision_unix_with(
    base: &Path,
    create_directory: &mut impl FnMut(&Path) -> std::io::Result<()>,
    sync_directory: &mut impl FnMut(&Path) -> std::io::Result<()>,
) -> Result<PathBuf, NativeProfileAdapterError> {
    let components = validated_normal_components(base)?;
    let mut current = PathBuf::from(std::path::MAIN_SEPARATOR.to_string());
    let mut directories = vec![current.clone()];

    for component in components {
        current.push(component);
        ensure_directory(&current, false, create_directory)?;
        directories.push(current.clone());
    }

    current.push(SETTINGS_ROOT_NAME);
    ensure_directory(&current, true, create_directory)?;
    directories.push(current.clone());

    // Sync every directory from the filesystem root through the returned
    // settings directory. A failure leaves visible partial directories in
    // place; a later call rechecks and syncs the whole chain again.
    for directory in directories {
        sync_directory(&directory).map_err(|_| NativeProfileAdapterError)?;
    }

    Ok(current)
}

#[cfg(unix)]
fn validated_normal_components(
    base: &Path,
) -> Result<Vec<std::ffi::OsString>, NativeProfileAdapterError> {
    use std::os::unix::ffi::OsStrExt;

    if !base.is_absolute() {
        return Err(NativeProfileAdapterError);
    }

    // Path::components normalizes away literal `.` elements. Check the raw
    // Unix path as well so an input such as `/trusted/./child` is rejected
    // before any filesystem access. Non-UTF8 normal components remain valid.
    for component in base.as_os_str().as_bytes().split(|byte| *byte == b'/') {
        if component == b"." || component == b".." {
            return Err(NativeProfileAdapterError);
        }
    }

    let mut normal = Vec::new();
    for component in base.components() {
        match component {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(value) => normal.push(value.to_os_string()),
            std::path::Component::CurDir | std::path::Component::ParentDir => {
                return Err(NativeProfileAdapterError)
            }
            std::path::Component::Prefix(_) => return Err(NativeProfileAdapterError),
        }
    }
    if normal.is_empty() {
        return Err(NativeProfileAdapterError);
    }
    Ok(normal)
}

#[cfg(unix)]
fn ensure_directory(
    path: &Path,
    require_private: bool,
    create_directory: &mut impl FnMut(&Path) -> std::io::Result<()>,
) -> Result<(), NativeProfileAdapterError> {
    let mut must_be_private = require_private;
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => validate_directory(&metadata)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match create_directory(path) {
                Ok(()) => must_be_private = true,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    // The entry appeared after the missing-path observation.
                    // Treat it as a newly supplied directory, not as a
                    // pre-existing trusted ancestor.
                    must_be_private = true;
                }
                Err(_) => return Err(NativeProfileAdapterError),
            }
            let metadata =
                std::fs::symlink_metadata(path).map_err(|_| NativeProfileAdapterError)?;
            validate_directory(&metadata)?;
            if must_be_private && !is_private(&metadata) {
                return Err(NativeProfileAdapterError);
            }
            return Ok(());
        }
        Err(_) => return Err(NativeProfileAdapterError),
    }

    if must_be_private {
        let metadata = std::fs::symlink_metadata(path).map_err(|_| NativeProfileAdapterError)?;
        if !is_private(&metadata) {
            return Err(NativeProfileAdapterError);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn validate_directory(metadata: &std::fs::Metadata) -> Result<(), NativeProfileAdapterError> {
    if !metadata.file_type().is_dir() {
        return Err(NativeProfileAdapterError);
    }
    Ok(())
}

#[cfg(unix)]
fn is_private(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o077 == 0
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = std::fs::DirBuilder::new();
    builder.mode(0o700).create(path)
}

#[cfg(unix)]
fn sync_real_directory(path: &Path) -> std::io::Result<()> {
    use std::fs::File;

    let path_metadata = std::fs::symlink_metadata(path)?;
    if !path_metadata.file_type().is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a real directory",
        ));
    }
    let directory = File::open(path)?;
    if !directory.metadata()?.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a directory",
        ));
    }
    directory.sync_all()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::node_config::{NodeConfigOperationOwner, NodeConfigProfileNamespace};
    use crate::node_config_file::NodeConfigFilePersistence;
    use crate::runtime_profile::{
        validate_canonical_runtime_profile_document, RuntimeProfileValidationOptions,
    };
    use crate::runtime_profile_file::RuntimeProfileFilePersistence;
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::fs::PermissionsExt;

    fn mode(path: &Path) -> u32 {
        std::fs::symlink_metadata(path)
            .expect("path metadata")
            .permissions()
            .mode()
            & 0o777
    }

    #[test]
    fn creates_missing_base_and_private_root_then_rechecks_without_touching_siblings() {
        let parent = tempfile::tempdir().expect("temporary parent");
        let base = parent.path().join("new-base").join("nested-base");
        let root = provision_native_settings_root(&base).expect("provision root");
        assert_eq!(root, base.join(SETTINGS_ROOT_NAME));
        assert_eq!(mode(&parent.path().join("new-base")) & 0o077, 0);
        assert_eq!(mode(&base) & 0o077, 0);
        assert_eq!(mode(&root) & 0o077, 0);

        let existing_base = parent.path().join("existing-public-base");
        std::fs::create_dir(&existing_base).expect("existing base");
        std::fs::set_permissions(&existing_base, std::fs::Permissions::from_mode(0o755))
            .expect("set existing ancestor mode");
        let sibling = existing_base.join("legacy-profile.json");
        std::fs::write(&sibling, b"legacy bytes remain").expect("legacy sibling");
        let expected = existing_base.join(SETTINGS_ROOT_NAME);
        assert_eq!(
            provision_native_settings_root(&existing_base).expect("repeat"),
            expected
        );
        assert_eq!(
            provision_native_settings_root(&existing_base).expect("recheck"),
            expected
        );
        assert_eq!(
            mode(&existing_base),
            0o755,
            "existing ancestor is not chmodded"
        );
        assert_eq!(mode(&expected) & 0o077, 0);
        assert_eq!(
            std::fs::read(sibling).expect("legacy sibling preserved"),
            b"legacy bytes remain"
        );
    }

    #[test]
    fn provisioned_root_supports_both_real_stores_without_defaults_or_legacy_changes() {
        let parent = tempfile::tempdir().expect("temporary parent");
        let base = parent.path().join("aurora-local-data");
        let legacy_sibling = base.join("legacy-profile.json");
        std::fs::create_dir(&base).expect("app-local base");
        std::fs::write(&legacy_sibling, b"legacy bytes remain untouched").expect("legacy sibling");

        let root = provision_native_settings_root(&base).expect("provision settings root");
        assert!(
            std::fs::read_dir(&root)
                .expect("new root entries")
                .next()
                .is_none(),
            "provisioning creates no profile, policy, or default files"
        );

        let options = RuntimeProfileValidationOptions::default();
        let profile_store = RuntimeProfileFilePersistence::new(&root, options);
        assert!(profile_store
            .read_confirmed()
            .expect("confirmed absence")
            .is_none());
        assert!(
            std::fs::read_dir(&root)
                .expect("root remains empty after absent read")
                .next()
                .is_none(),
            "an absent profile read does not create defaults"
        );

        let profile_json = "{ \"version\":2,\"activeProfileId\":null,\"profiles\":[] }\n";
        let validated = validate_canonical_runtime_profile_document(profile_json, options)
            .expect("valid empty profile document");
        profile_store
            .publish(&validated)
            .expect("publish exact profile bytes");
        let reopened_profile_store = RuntimeProfileFilePersistence::new(&root, options);
        let confirmed = reopened_profile_store
            .read_confirmed()
            .expect("reopen profile store")
            .expect("profile exists");
        assert_eq!(confirmed.as_json(), profile_json);

        let first_namespace =
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                "profile-one",
                "stable-node-one",
            )
            .expect("first test-known namespace");
        let second_namespace =
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                "profile-two",
                "stable-node-two",
            )
            .expect("second test-known namespace");
        assert_ne!(first_namespace, second_namespace);

        let policy_persistence = NodeConfigFilePersistence::new(&root);
        let owner = NodeConfigOperationOwner::new(policy_persistence);
        owner
            .select_profile(Some(first_namespace))
            .expect("select first test namespace");
        let first = owner
            .load_or_initialize()
            .expect("initialize first policy document");
        assert_eq!(first.document.revision, 1);
        let mut first_draft =
            serde_json::to_value(&first.document).expect("serialize first policy");
        first_draft["revision"] = serde_json::Value::from(2);
        let first_draft = serde_json::to_string(&first_draft).expect("serialize next revision");
        owner
            .compare_and_swap(&first.context, 1, &first_draft)
            .expect("advance first namespace only");

        owner
            .select_profile(Some(second_namespace))
            .expect("select second test namespace");
        let second = owner
            .load_or_initialize()
            .expect("initialize second policy document");
        assert_eq!(second.document.revision, 1);

        let policy_root = root.join("node-config-v2");
        let first_policy = policy_root
            .join(first_namespace.storage_component())
            .join("document.json");
        let second_policy = policy_root
            .join(second_namespace.storage_component())
            .join("document.json");
        assert!(first_policy.is_file());
        assert!(second_policy.is_file());
        assert_ne!(first_policy, second_policy);
        owner
            .select_profile(Some(first_namespace))
            .expect("return to first test namespace");
        assert_eq!(
            owner
                .load_or_initialize()
                .expect("read first namespace")
                .document
                .revision,
            2,
            "first namespace retains its update"
        );
        owner
            .select_profile(Some(second_namespace))
            .expect("return to second test namespace");
        assert_eq!(
            owner
                .load_or_initialize()
                .expect("read second namespace")
                .document
                .revision,
            1,
            "second namespace remains at its independent initial revision"
        );
        assert_eq!(
            std::fs::read(root.join("runtime-profile-v2/document.json"))
                .expect("profile bytes remain exact"),
            profile_json.as_bytes()
        );
        assert_eq!(
            std::fs::read(&legacy_sibling).expect("legacy sibling unchanged"),
            b"legacy bytes remain untouched"
        );
    }

    #[test]
    fn rejects_invalid_path_syntax_before_creating_any_path() {
        let parent = tempfile::tempdir().expect("temporary parent");
        let missing = parent.path().join("must-not-be-created");
        let literal_dot = PathBuf::from(format!("{}/./child", missing.display()));
        let parent_component = PathBuf::from(format!("{}/../child", missing.display()));
        let relative = PathBuf::from(format!("relative-settings-root-{}", std::process::id()));

        for invalid in [
            PathBuf::new(),
            PathBuf::from("."),
            PathBuf::from("/"),
            relative.clone(),
            literal_dot,
            parent_component,
        ] {
            assert_eq!(
                provision_native_settings_root(&invalid),
                Err(NativeProfileAdapterError)
            );
        }
        assert!(!missing.exists(), "syntax rejection performs no creation");
        assert!(
            !relative.exists(),
            "relative rejection performs no creation"
        );
    }

    #[test]
    fn preserves_non_utf8_native_path_components() {
        let parent = tempfile::tempdir().expect("temporary parent");
        let base = parent
            .path()
            .join(OsString::from_vec(b"aurora-\xff-data".to_vec()));
        let root = provision_native_settings_root(&base).expect("non-UTF8 path accepted");
        assert_eq!(root, base.join(SETTINGS_ROOT_NAME));
        assert_eq!(mode(&root) & 0o077, 0);
    }

    #[test]
    fn rejects_bad_ancestors_and_final_roots_without_chmod_or_replacement() {
        let parent = tempfile::tempdir().expect("temporary parent");
        let regular_file = parent.path().join("regular-file");
        std::fs::write(&regular_file, b"untouched file").expect("write file");
        assert_eq!(
            provision_native_settings_root(&regular_file.join("child")),
            Err(NativeProfileAdapterError)
        );
        assert_eq!(
            std::fs::read(&regular_file).expect("file unchanged"),
            b"untouched file"
        );

        let outside = parent.path().join("outside");
        std::fs::create_dir(&outside).expect("outside directory");
        let sentinel = outside.join("sentinel");
        std::fs::write(&sentinel, b"outside bytes").expect("outside sentinel");
        let symlink_base = parent.path().join("symlink-base");
        std::os::unix::fs::symlink(&outside, &symlink_base).expect("ancestor symlink");
        assert_eq!(
            provision_native_settings_root(&symlink_base.join("child")),
            Err(NativeProfileAdapterError)
        );
        assert_eq!(
            std::fs::read(&sentinel).expect("sentinel unchanged"),
            b"outside bytes"
        );

        let existing_base = parent.path().join("existing-base");
        std::fs::create_dir(&existing_base).expect("base directory");
        let final_root = existing_base.join(SETTINGS_ROOT_NAME);
        std::fs::create_dir(&final_root).expect("preexisting root");
        std::fs::set_permissions(&final_root, std::fs::Permissions::from_mode(0o755))
            .expect("make root nonprivate");
        assert_eq!(
            provision_native_settings_root(&existing_base),
            Err(NativeProfileAdapterError)
        );
        assert_eq!(
            mode(&final_root),
            0o755,
            "invalid final root is not chmodded"
        );

        let final_symlink_base = parent.path().join("final-symlink-base");
        std::fs::create_dir(&final_symlink_base).expect("symlink base");
        let final_symlink = final_symlink_base.join(SETTINGS_ROOT_NAME);
        std::os::unix::fs::symlink(&outside, &final_symlink).expect("final symlink");
        assert_eq!(
            provision_native_settings_root(&final_symlink_base),
            Err(NativeProfileAdapterError)
        );
        assert_eq!(
            std::fs::read(&sentinel).expect("outside unchanged"),
            b"outside bytes"
        );

        let final_file_base = parent.path().join("final-file-base");
        std::fs::create_dir(&final_file_base).expect("final file base");
        let final_file = final_file_base.join(SETTINGS_ROOT_NAME);
        std::fs::write(&final_file, b"final file remains").expect("final file");
        assert_eq!(
            provision_native_settings_root(&final_file_base),
            Err(NativeProfileAdapterError)
        );
        assert_eq!(
            std::fs::read(final_file).expect("final file unchanged"),
            b"final file remains"
        );
    }

    #[test]
    fn a_directory_racing_into_a_missing_component_must_already_be_private() {
        let parent = tempfile::tempdir().expect("temporary parent");
        let raced = parent.path().join("raced-app-base");
        let mut create = |path: &Path| {
            std::fs::create_dir(path)?;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
            Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists))
        };
        let mut sync = sync_real_directory;
        assert_eq!(
            provision_unix_with(&raced, &mut create, &mut sync),
            Err(NativeProfileAdapterError)
        );
        assert_eq!(mode(&raced), 0o755, "raced entry is not repaired");
        assert!(!raced.join(SETTINGS_ROOT_NAME).exists());
    }

    #[test]
    fn create_and_sync_failures_return_no_root_and_retry_revalidates_partial_state() {
        let parent = tempfile::tempdir().expect("temporary parent");
        let base = parent.path().join("partial-app").join("data");
        let legacy_sibling = parent.path().join("legacy-profile.json");
        std::fs::write(&legacy_sibling, b"legacy create-failure bytes").expect("legacy sibling");
        let mut create_calls = 0usize;
        let mut failing_create = |path: &Path| {
            create_calls += 1;
            if create_calls == 2 {
                return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
            }
            create_private_directory(path)
        };
        let mut real_sync = sync_real_directory;
        assert_eq!(
            provision_unix_with(&base, &mut failing_create, &mut real_sync),
            Err(NativeProfileAdapterError)
        );
        assert!(parent.path().join("partial-app").is_dir());
        assert!(!base.exists());
        assert_eq!(
            std::fs::read(&legacy_sibling).expect("legacy sibling after create failure"),
            b"legacy create-failure bytes"
        );
        assert_eq!(
            provision_native_settings_root(&base).expect("retry after create failure"),
            base.join(SETTINGS_ROOT_NAME)
        );
        assert_eq!(
            std::fs::read(&legacy_sibling).expect("legacy sibling after create failure"),
            b"legacy create-failure bytes"
        );

        let sync_parent = tempfile::tempdir().expect("sync-fault parent");
        let sync_base = sync_parent.path().join("new-app").join("data");
        let sync_legacy_sibling = sync_parent.path().join("legacy-profile.json");
        std::fs::write(&sync_legacy_sibling, b"legacy parent-sync bytes")
            .expect("sync legacy sibling");
        let fail_at = sync_parent.path().join("new-app");
        let mut create = create_private_directory;
        let mut failed_once = false;
        let mut sync = |path: &Path| {
            if path == fail_at && !failed_once {
                failed_once = true;
                return Err(std::io::Error::other("injected directory sync failure"));
            }
            sync_real_directory(path)
        };
        assert_eq!(
            provision_unix_with(&sync_base, &mut create, &mut sync),
            Err(NativeProfileAdapterError)
        );
        assert!(sync_base.join(SETTINGS_ROOT_NAME).is_dir());
        assert_eq!(
            std::fs::read(&sync_legacy_sibling).expect("legacy sibling after parent sync failure"),
            b"legacy parent-sync bytes"
        );
        assert_eq!(
            provision_native_settings_root(&sync_base).expect("retry after sync failure"),
            sync_base.join(SETTINGS_ROOT_NAME)
        );
        assert_eq!(
            std::fs::read(&sync_legacy_sibling).expect("legacy sibling after parent sync failure"),
            b"legacy parent-sync bytes"
        );

        let final_sync_parent = tempfile::tempdir().expect("final-sync parent");
        let final_sync_base = final_sync_parent.path().join("app").join("data");
        let final_sync_legacy_sibling = final_sync_parent.path().join("legacy-profile.json");
        std::fs::write(&final_sync_legacy_sibling, b"legacy final-sync bytes")
            .expect("final-sync legacy sibling");
        let final_root = final_sync_base.join(SETTINGS_ROOT_NAME);
        let mut create = create_private_directory;
        let mut failed_once = false;
        let mut sync = |path: &Path| {
            if path == final_root && !failed_once {
                failed_once = true;
                return Err(std::io::Error::other("injected final sync failure"));
            }
            sync_real_directory(path)
        };
        assert_eq!(
            provision_unix_with(&final_sync_base, &mut create, &mut sync),
            Err(NativeProfileAdapterError)
        );
        assert!(final_root.is_dir(), "no rollback after visible creation");
        assert_eq!(
            std::fs::read(&final_sync_legacy_sibling)
                .expect("legacy sibling after final sync failure"),
            b"legacy final-sync bytes"
        );
        assert_eq!(
            provision_native_settings_root(&final_sync_base).expect("retry final sync"),
            final_root
        );
        assert_eq!(
            std::fs::read(&final_sync_legacy_sibling)
                .expect("legacy sibling after final sync failure"),
            b"legacy final-sync bytes"
        );
    }

    #[test]
    fn syncs_each_directory_from_filesystem_root_through_final_settings_root() {
        let parent = tempfile::tempdir().expect("temporary parent");
        let base = parent.path().join("app").join("data");
        let mut create = create_private_directory;
        let mut synced = Vec::new();
        let mut sync = |path: &Path| {
            synced.push(path.to_path_buf());
            sync_real_directory(path)
        };
        let root = provision_unix_with(&base, &mut create, &mut sync).expect("provision");
        assert_eq!(synced.first(), Some(&PathBuf::from("/")));
        assert_eq!(synced.last(), Some(&root));
        assert!(synced.contains(&base));
        assert!(synced.contains(&parent.path().to_path_buf()));
        assert_eq!(synced.len(), base.components().count() + 1);
    }

    #[test]
    fn errors_are_fixed_and_do_not_include_native_paths() {
        let parent = tempfile::tempdir().expect("temporary parent");
        let file = parent.path().join("sensitive-path-name");
        std::fs::write(&file, b"not a directory").expect("file");
        let error = provision_native_settings_root(&file).expect_err("reject file root");
        assert_eq!(error.to_string(), "native profile state is unavailable");
        assert!(!format!("{error:?}").contains("sensitive-path-name"));
    }
}

#[cfg(all(test, not(unix)))]
mod unsupported_platform_tests {
    use super::*;

    #[test]
    fn unsupported_platform_fails_before_touching_path() {
        let parent = tempfile::tempdir().expect("temporary parent");
        let base = parent.path().join("must-not-be-created");
        assert_eq!(
            provision_native_settings_root(&base),
            Err(NativeProfileAdapterError)
        );
        assert!(!base.exists());
    }
}

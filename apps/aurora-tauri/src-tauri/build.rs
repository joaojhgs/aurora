fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        link_ios_aurora_native_plugin().expect("failed to link Aurora iOS native plugin");
    }

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "aurora_request",
            "aurora_command",
            "aurora_subscribe",
            "aurora_sidecar_session",
            "aurora_sidecar_start",
            "aurora_sidecar_stop",
            "aurora_sidecar_status",
            "aurora_native_capability_manifest",
            "native_capabilities",
            "aurora_android_baseline_status",
            "aurora_android_native_plugin_payload",
            "aurora_ios_native_plugin_manifest",
            "aurora_ios_invocation_status",
            "aurora_ios_invoke_action",
            "aurora_log_tail",
            "aurora_secure_storage_get",
            "aurora_secure_storage_set",
            "aurora_secure_storage_delete",
            "aurora_local_file_read",
            "aurora_local_file_write",
            "aurora_local_file_pick",
            "aurora_secure_file_handle_open",
            "aurora_shutdown",
        ]),
    ))
    .expect("failed to build Aurora Tauri manifest");
}

#[cfg(target_os = "macos")]
fn link_ios_aurora_native_plugin() -> Result<(), Box<dyn std::error::Error>> {
    use std::path::Path;

    let source = Path::new("ios").join("AuroraNativePlugin");
    let tauri_library_path = std::env::var("DEP_TAURI_IOS_LIBRARY_PATH")?;
    let tauri_api_target = Path::new(".tauri").join("tauri-api");

    replace_directory(Path::new(&tauri_library_path), &tauri_api_target)?;
    let sdk_root = std::env::var_os("SDKROOT");
    std::env::remove_var("SDKROOT");

    swift_rs::SwiftLinker::new(
        &std::env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "10.15".into()),
    )
    .with_ios(&std::env::var("IPHONEOS_DEPLOYMENT_TARGET").unwrap_or_else(|_| "14".into()))
    .with_package("AuroraNativePlugin", source)
    .link();

    if let Some(root) = sdk_root {
        std::env::set_var("SDKROOT", root);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn link_ios_aurora_native_plugin() -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn replace_directory(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    if target.exists() {
        std::fs::remove_dir_all(target)?;
    }
    copy_directory(source, target)
}

#[cfg(target_os = "macos")]
fn copy_directory(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry.file_type()?;

        if file_type.is_dir() {
            copy_directory(&source_path, &target_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&source_path, &target_path)?;
        }
    }
    Ok(())
}

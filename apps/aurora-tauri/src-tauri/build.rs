fn main() {
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

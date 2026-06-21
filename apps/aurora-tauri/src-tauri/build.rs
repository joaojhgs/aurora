fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "aurora_request",
            "aurora_sidecar_status",
            "aurora_native_capability_manifest",
            "aurora_shutdown",
        ]),
    ))
    .expect("failed to build Aurora Tauri manifest");
}

use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=AURORA_SHERPA_ONNX_LIB_DIR");
    for variable in [
        "AURORA_SHERPA_ONNX_ANDROID_ARM64_V8A_LIB_DIR",
        "AURORA_SHERPA_ONNX_ANDROID_ARMEABI_V7A_LIB_DIR",
        "AURORA_SHERPA_ONNX_ANDROID_X86_64_LIB_DIR",
        "AURORA_SHERPA_ONNX_ANDROID_X86_LIB_DIR",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    println!("cargo:rerun-if-env-changed=AURORA_SHERPA_ONNX_LINK_KIND");

    let native_enabled = env::var_os("CARGO_FEATURE_NATIVE_VAD").is_some()
        || env::var_os("CARGO_FEATURE_NATIVE_KWS").is_some()
        || env::var_os("CARGO_FEATURE_NATIVE_STT").is_some()
        || env::var_os("CARGO_FEATURE_NATIVE_TTS").is_some();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if !native_enabled || target_arch == "wasm32" {
        return;
    }
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    let target_lib_variable = android_target_lib_variable(&target_os, &target_arch);
    let lib_dir = target_lib_variable
        .and_then(env::var_os)
        .or_else(|| env::var_os("AURORA_SHERPA_ONNX_LIB_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let target_hint = target_lib_variable
                .map(|variable| format!(" or {variable}"))
                .unwrap_or_default();
            panic!(
                "AURORA_SHERPA_ONNX_LIB_DIR{target_hint} is required when enabling a native sherpa feature"
            )
        });

    if !lib_dir.is_dir() {
        panic!("AURORA_SHERPA_ONNX_LIB_DIR must name an existing directory");
    }

    let link_kind = select_link_kind(&lib_dir, &target_os);
    let artifact = link_artifact_name(&target_os, link_kind);
    if !lib_dir.join(artifact).is_file() {
        panic!("AURORA_SHERPA_ONNX_LIB_DIR does not contain the requested sherpa-onnx C API link artifact");
    }

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!(
        "cargo:rustc-link-lib={}=sherpa-onnx-c-api",
        link_kind.rustc_name()
    );
}

fn android_target_lib_variable(target_os: &str, target_arch: &str) -> Option<&'static str> {
    if target_os != "android" {
        return None;
    }
    match target_arch {
        "aarch64" => Some("AURORA_SHERPA_ONNX_ANDROID_ARM64_V8A_LIB_DIR"),
        "arm" => Some("AURORA_SHERPA_ONNX_ANDROID_ARMEABI_V7A_LIB_DIR"),
        "x86_64" => Some("AURORA_SHERPA_ONNX_ANDROID_X86_64_LIB_DIR"),
        "x86" => Some("AURORA_SHERPA_ONNX_ANDROID_X86_LIB_DIR"),
        _ => None,
    }
}

#[derive(Clone, Copy)]
enum LinkKind {
    Dynamic,
    Static,
}

impl LinkKind {
    fn rustc_name(self) -> &'static str {
        match self {
            Self::Dynamic => "dylib",
            Self::Static => "static",
        }
    }
}

fn select_link_kind(lib_dir: &std::path::Path, target_os: &str) -> LinkKind {
    match env::var("AURORA_SHERPA_ONNX_LINK_KIND") {
        Ok(value) if value == "dynamic" => LinkKind::Dynamic,
        Ok(value) if value == "static" => LinkKind::Static,
        Ok(_) => panic!("AURORA_SHERPA_ONNX_LINK_KIND must be dynamic or static"),
        Err(env::VarError::NotPresent) => {
            if lib_dir
                .join(link_artifact_name(target_os, LinkKind::Dynamic))
                .is_file()
            {
                LinkKind::Dynamic
            } else {
                LinkKind::Static
            }
        }
        Err(env::VarError::NotUnicode(_)) => {
            panic!("AURORA_SHERPA_ONNX_LINK_KIND must be valid unicode")
        }
    }
}

fn link_artifact_name(target_os: &str, link_kind: LinkKind) -> &'static str {
    match (target_os, link_kind) {
        ("windows", _) => "sherpa-onnx-c-api.lib",
        ("macos" | "ios", LinkKind::Dynamic) => "libsherpa-onnx-c-api.dylib",
        (_, LinkKind::Dynamic) => "libsherpa-onnx-c-api.so",
        (_, LinkKind::Static) => "libsherpa-onnx-c-api.a",
    }
}

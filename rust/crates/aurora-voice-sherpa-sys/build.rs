use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=AURORA_SHERPA_ONNX_LIB_DIR");

    let native_enabled = env::var_os("CARGO_FEATURE_NATIVE_VAD").is_some();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if !native_enabled || target_arch == "wasm32" {
        return;
    }

    let lib_dir = env::var_os("AURORA_SHERPA_ONNX_LIB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            panic!("AURORA_SHERPA_ONNX_LIB_DIR is required when enabling the native-vad feature")
        });

    if !lib_dir.is_dir() {
        panic!("AURORA_SHERPA_ONNX_LIB_DIR must name an existing directory");
    }

    let dynamic_lib = lib_dir.join(dynamic_library_name());
    let static_lib = lib_dir.join(static_library_name());
    if !dynamic_lib.is_file() && !static_lib.is_file() {
        panic!("AURORA_SHERPA_ONNX_LIB_DIR does not contain the sherpa-onnx C API library");
    }

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=dylib=sherpa-onnx-c-api");
}

fn dynamic_library_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "sherpa-onnx-c-api.dll"
    } else if cfg!(target_os = "macos") || cfg!(target_os = "ios") {
        "libsherpa-onnx-c-api.dylib"
    } else {
        "libsherpa-onnx-c-api.so"
    }
}

fn static_library_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "sherpa-onnx-c-api.lib"
    } else {
        "libsherpa-onnx-c-api.a"
    }
}

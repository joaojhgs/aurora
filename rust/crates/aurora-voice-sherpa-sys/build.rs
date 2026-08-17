use std::env;
use std::path::PathBuf;

fn main() {
    // Tauri CLI 2.11.3 forwards CARGO_-prefixed variables into the Cargo
    // process launched by its Xcode phase. Direct Cargo builds keep using the
    // canonical Aurora names; the aliases preserve that contract on iOS.
    println!("cargo:rerun-if-env-changed=AURORA_SHERPA_ONNX_LIB_DIR");
    println!("cargo:rerun-if-env-changed=CARGO_AURORA_SHERPA_ONNX_LIB_DIR");
    for variable in ANDROID_ABI_LIB_VARS {
        println!("cargo:rerun-if-env-changed={variable}");
        println!("cargo:rerun-if-env-changed=CARGO_{variable}");
    }
    println!("cargo:rerun-if-env-changed=AURORA_SHERPA_ONNX_LINK_KIND");
    println!("cargo:rerun-if-env-changed=CARGO_AURORA_SHERPA_ONNX_LINK_KIND");

    let native_enabled = env::var_os("CARGO_FEATURE_NATIVE_VAD").is_some()
        || env::var_os("CARGO_FEATURE_NATIVE_KWS").is_some()
        || env::var_os("CARGO_FEATURE_NATIVE_STT").is_some()
        || env::var_os("CARGO_FEATURE_NATIVE_TTS").is_some();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if !native_enabled || target_arch == "wasm32" {
        return;
    }
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let lib_dir = if target_os == "android" {
        let variable = android_target_lib_variable(&target_arch).unwrap_or_else(|| {
            panic!("unsupported Android target arch {target_arch} for native sherpa linking")
        });
        env_os_with_cargo_alias(variable)
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                panic!(
                    "{variable} or CARGO_{variable} is required when enabling a native sherpa feature for Android"
                )
            })
    } else {
        env_os_with_cargo_alias("AURORA_SHERPA_ONNX_LIB_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                panic!(
                    "AURORA_SHERPA_ONNX_LIB_DIR is required when enabling a native sherpa feature"
                )
            })
    };

    if !lib_dir.is_dir() {
        panic!("AURORA_SHERPA_ONNX_LIB_DIR must name an existing directory");
    }

    let link_kind = select_link_kind(&lib_dir, &target_os);
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    match link_kind {
        LinkKind::Dynamic => {
            require_link_artifact(&lib_dir, &target_os, "sherpa-onnx-c-api", link_kind);
            println!("cargo:rustc-link-lib=dylib=sherpa-onnx-c-api");
        }
        LinkKind::Static => {
            if target_os == "android" {
                panic!("Android Sherpa packaging requires the patched shared runtime");
            }
            for library in STATIC_LIBRARIES {
                require_link_artifact(&lib_dir, &target_os, library, link_kind);
                println!("cargo:rustc-link-lib=static={library}");
            }
            emit_static_platform_links(&target_os);
        }
    }
}

const STATIC_LIBRARIES: &[&str] = &[
    "sherpa-onnx-c-api",
    "sherpa-onnx-core",
    "kaldi-decoder-core",
    "sherpa-onnx-kaldifst-core",
    "sherpa-onnx-fstfar",
    "sherpa-onnx-fst",
    "kaldi-native-fbank-core",
    "kissfft-float",
    "piper_phonemize",
    "espeak-ng",
    "ucd",
    "onnxruntime",
    "ssentencepiece_core",
];

fn require_link_artifact(
    lib_dir: &std::path::Path,
    target_os: &str,
    library: &str,
    link_kind: LinkKind,
) {
    let artifact = link_artifact_name(target_os, library, link_kind);
    if !lib_dir.join(&artifact).is_file() {
        panic!("AURORA_SHERPA_ONNX_LIB_DIR is missing required link artifact {artifact}");
    }
}

fn emit_static_platform_links(target_os: &str) {
    match target_os {
        "linux" => {
            for library in ["stdc++", "m", "pthread", "dl"] {
                println!("cargo:rustc-link-lib=dylib={library}");
            }
        }
        "macos" | "ios" => {
            println!("cargo:rustc-link-lib=dylib=c++");
            println!("cargo:rustc-link-lib=framework=Foundation");
        }
        "windows" => {}
        other => panic!("static Sherpa linking is unsupported for target OS {other}"),
    }
}

const ANDROID_ABI_LIB_VARS: &[&str] = &[
    "AURORA_SHERPA_ONNX_ANDROID_ARM64_V8A_LIB_DIR",
    "AURORA_SHERPA_ONNX_ANDROID_ARMEABI_V7A_LIB_DIR",
    "AURORA_SHERPA_ONNX_ANDROID_X86_64_LIB_DIR",
    "AURORA_SHERPA_ONNX_ANDROID_X86_LIB_DIR",
];

fn env_os_with_cargo_alias(name: &str) -> Option<std::ffi::OsString> {
    env::var_os(name).or_else(|| env::var_os(format!("CARGO_{name}")))
}

fn android_target_lib_variable(target_arch: &str) -> Option<&'static str> {
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

fn select_link_kind(lib_dir: &std::path::Path, target_os: &str) -> LinkKind {
    let link_kind = env::var("AURORA_SHERPA_ONNX_LINK_KIND").or_else(|error| match error {
        env::VarError::NotPresent => env::var("CARGO_AURORA_SHERPA_ONNX_LINK_KIND"),
        other => Err(other),
    });
    match link_kind {
        Ok(value) if value == "dynamic" => LinkKind::Dynamic,
        Ok(value) if value == "static" => LinkKind::Static,
        Ok(_) => panic!("AURORA_SHERPA_ONNX_LINK_KIND must be dynamic or static"),
        Err(env::VarError::NotPresent) => {
            if lib_dir
                .join(link_artifact_name(
                    target_os,
                    "sherpa-onnx-c-api",
                    LinkKind::Dynamic,
                ))
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

fn link_artifact_name(target_os: &str, library: &str, link_kind: LinkKind) -> String {
    match (target_os, link_kind) {
        ("windows", _) => format!("{library}.lib"),
        ("macos" | "ios", LinkKind::Dynamic) => format!("lib{library}.dylib"),
        (_, LinkKind::Dynamic) => format!("lib{library}.so"),
        (_, LinkKind::Static) => format!("lib{library}.a"),
    }
}

use std::env;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

fn main() {
    // Tauri CLI 2.11.3 forwards CARGO_-prefixed variables into the Cargo
    // process launched by its Xcode phase. Direct Cargo builds keep using the
    // canonical Aurora names; the aliases preserve that contract on iOS.
    println!("cargo:rerun-if-env-changed=AURORA_SHERPA_ONNX_LIB_DIR");
    println!("cargo:rerun-if-env-changed=CARGO_AURORA_SHERPA_ONNX_LIB_DIR");
    println!("cargo:rerun-if-env-changed=AURORA_SHERPA_ONNX_INCLUDE_DIR");
    println!("cargo:rerun-if-env-changed=CARGO_AURORA_SHERPA_ONNX_INCLUDE_DIR");
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

    let include_dir = env_os_with_cargo_alias("AURORA_SHERPA_ONNX_INCLUDE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| lib_dir.join("include"));
    verify_abi_layout(&include_dir);

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

const SHERPA_HEADER: &str = "sherpa-onnx/c-api/c-api.h";
const ABI_LAYOUT_SOURCES: &[(&str, &str)] = &[
    ("src/native.rs", include_str!("src/native.rs")),
    ("src/native_kws.rs", include_str!("src/native_kws.rs")),
    ("src/native_stt.rs", include_str!("src/native_stt.rs")),
    ("src/native_tts.rs", include_str!("src/native_tts.rs")),
];

#[derive(Clone, Debug, Eq, PartialEq)]
struct AbiStruct {
    name: String,
    fields: Vec<(String, String)>,
}

fn verify_abi_layout(include_dir: &Path) {
    let header = include_dir.join(SHERPA_HEADER);
    if !header.is_file() {
        panic!("AURORA_SHERPA_ONNX_INCLUDE_DIR must contain the pinned {SHERPA_HEADER} header");
    }
    println!("cargo:rerun-if-changed={}", header.display());
    for (path, _) in ABI_LAYOUT_SOURCES {
        println!("cargo:rerun-if-changed={path}");
    }

    let layouts = parse_abi_structs();
    let probe = render_abi_probe(&layouts);
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo must set OUT_DIR"))
        .join("aurora_sherpa_abi_probe.cc");
    fs::write(&output, probe).expect("failed to write Sherpa ABI parity probe");

    let mut compiler = cc::Build::new();
    compiler
        .cpp(true)
        .cargo_metadata(false)
        .include(include_dir)
        .file(&output)
        .warnings(true)
        .warnings_into_errors(true);
    compiler
        .try_compile("aurora_sherpa_abi_probe")
        .unwrap_or_else(|_| {
            panic!("pinned Sherpa header is ABI-incompatible with Aurora's native Rust layouts")
        });
}

fn parse_abi_structs() -> Vec<AbiStruct> {
    let mut layouts = Vec::<AbiStruct>::new();
    for (source_path, source) in ABI_LAYOUT_SOURCES {
        let lines = source.lines().collect::<Vec<_>>();
        let mut index = 0;
        while index < lines.len() {
            if lines[index].trim() != "#[repr(C)]" {
                index += 1;
                continue;
            }
            index += 1;
            while index < lines.len()
                && (lines[index].trim().is_empty() || lines[index].trim().starts_with("#["))
            {
                index += 1;
            }
            let declaration = lines
                .get(index)
                .unwrap_or_else(|| panic!("unterminated repr(C) declaration in {source_path}"))
                .trim();
            let Some(name) = declaration
                .strip_prefix("struct ")
                .and_then(|value| value.strip_suffix(" {"))
            else {
                panic!("unsupported repr(C) declaration in {source_path}: {declaration}");
            };
            index += 1;
            let mut fields = Vec::new();
            while index < lines.len() && lines[index].trim() != "}" {
                let field = lines[index].trim();
                if !field.is_empty() {
                    let field = field.strip_suffix(',').unwrap_or_else(|| {
                        panic!("ABI field must end with a comma in {source_path}: {field}")
                    });
                    let (field_name, field_type) = field.split_once(':').unwrap_or_else(|| {
                        panic!("unsupported ABI field in {source_path}: {field}")
                    });
                    fields.push((field_name.trim().to_owned(), field_type.trim().to_owned()));
                }
                index += 1;
            }
            if index == lines.len() {
                panic!("unterminated ABI struct {name} in {source_path}");
            }
            let layout = AbiStruct {
                name: name.to_owned(),
                fields,
            };
            if let Some(existing) = layouts.iter().find(|existing| existing.name == layout.name) {
                if existing != &layout {
                    panic!("duplicate ABI struct {name} has inconsistent Rust layouts");
                }
            } else {
                layouts.push(layout);
            }
            index += 1;
        }
    }
    if layouts.is_empty() {
        panic!("no native Sherpa repr(C) layouts were discovered");
    }
    layouts
}

fn render_abi_probe(layouts: &[AbiStruct]) -> String {
    let mut probe = String::from(
        "#include <cstddef>\n#include <cstdint>\n#include \"sherpa-onnx/c-api/c-api.h\"\n\n",
    );
    for layout in layouts {
        probe.push_str(&format!("typedef struct AuroraMirror{} {{\n", layout.name));
        for (field, rust_type) in &layout.fields {
            probe.push_str(&format!("  {} {};\n", c_type(rust_type), field));
        }
        probe.push_str(&format!("}} AuroraMirror{};\n", layout.name));
        probe.push_str(&format!(
            "static_assert(sizeof({0}) == sizeof(AuroraMirror{0}), \"ABI sizeof mismatch: {0}\");\n",
            layout.name
        ));
        probe.push_str(&format!(
            "static_assert(alignof({0}) == alignof(AuroraMirror{0}), \"ABI align mismatch: {0}\");\n",
            layout.name
        ));
        for (field, _) in &layout.fields {
            probe.push_str(&format!(
                "static_assert(offsetof({0}, {1}) == offsetof(AuroraMirror{0}, {1}), \"ABI offset mismatch: {0}.{1}\");\n",
                layout.name, field
            ));
        }
        probe.push('\n');
    }
    probe
}

fn c_type(rust_type: &str) -> String {
    match rust_type {
        "c_int" => "std::int32_t".to_owned(),
        "c_float" => "float".to_owned(),
        "*const c_char" => "const char *".to_owned(),
        "*const c_float" => "const float *".to_owned(),
        "*mut c_float" => "float *".to_owned(),
        "*const *const c_char" => "const char *const *".to_owned(),
        nested if nested.starts_with("SherpaOnnx") => format!("AuroraMirror{nested}"),
        unsupported => panic!("unsupported Rust Sherpa ABI field type: {unsupported}"),
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

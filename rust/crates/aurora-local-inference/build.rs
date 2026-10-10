use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const SOURCE_COMMIT: &str = "b29c606e28a01b1bc8c1351026a0fa6e616bf6c4";
const SOURCE_SHA: &str = "03fb04316eb32a7b7347004a79a8dd60531c02f5a064d853fed3b53828951723";

fn main() {
    println!("cargo:rerun-if-env-changed=AURORA_LLAMA_CPP_LIB_DIR");
    println!("cargo:rerun-if-changed=native/bridge.cpp");
    println!("cargo:rerun-if-changed=native/bridge.h");
    if env::var_os("CARGO_FEATURE_NATIVE_LLAMACPP").is_none() {
        return;
    }
    let os = env::var("CARGO_CFG_TARGET_OS").expect("Cargo target OS");
    let arch = env::var("CARGO_CFG_TARGET_ARCH").expect("Cargo target architecture");
    let target = env::var("TARGET").expect("Cargo target");
    let target_env = match (os.as_str(), arch.as_str()) {
        ("android", "aarch64") => Some("AURORA_LLAMA_CPP_ANDROID_ARM64_LIB_DIR"),
        ("android", "x86_64") => Some("AURORA_LLAMA_CPP_ANDROID_X86_64_LIB_DIR"),
        _ => None,
    };
    if let Some(key) = target_env {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let root = PathBuf::from(
        target_env
            .and_then(env::var_os)
            .or_else(|| env::var_os("AURORA_LLAMA_CPP_LIB_DIR"))
            .expect(
                "Build the pinned runtime with tools/local-inference/build_llama_native.py first",
            ),
    );
    let metadata_path = root.join("aurora-llama-runtime.json");
    println!("cargo:rerun-if-changed={}", metadata_path.display());
    let metadata: serde_json::Value = serde_json::from_slice(
        &fs::read(&metadata_path).expect("Pinned runtime metadata is required"),
    )
    .expect("Invalid pinned runtime metadata");
    assert_eq!(metadata["format"], 1);
    assert_eq!(metadata["link_kind"], "static");
    assert_eq!(metadata["source"]["commit"], SOURCE_COMMIT);
    assert_eq!(metadata["source"]["version"], "0.4.1");
    assert_eq!(metadata["source"]["archive_sha256"], SOURCE_SHA);
    assert_eq!(metadata["source"]["archive_bytes"], 37_437_459_u64);
    let expected_target = match (os.as_str(), arch.as_str()) {
        ("linux", "aarch64") => "linux-aarch64",
        ("linux", "x86_64") => "linux-x86_64",
        ("android", "aarch64") => "android-arm64",
        ("android", "x86_64") => "android-x86_64",
        ("ios", "aarch64") if target.ends_with("-sim") => "ios-simulator-arm64",
        ("ios", "aarch64") => "ios-arm64",
        _ => panic!("No approved pinned llama.cpp build for this target"),
    };
    assert_eq!(
        metadata["target"], expected_target,
        "Pinned runtime target mismatch"
    );
    let hashes = metadata["file_sha256"]
        .as_object()
        .expect("Runtime file hashes are required");
    for (relative, expected) in hashes {
        let path = Path::new(relative);
        assert!(
            !path.as_os_str().is_empty()
                && path
                    .components()
                    .all(|part| matches!(part, Component::Normal(_))),
            "Runtime path must be relative"
        );
        let path = root.join(path);
        assert!(
            fs::symlink_metadata(&path)
                .expect("Missing runtime file")
                .file_type()
                .is_file(),
            "Runtime files must be regular files"
        );
        println!("cargo:rerun-if-changed={}", path.display());
        let mut file = fs::File::open(&path).expect("Runtime file is unreadable");
        let mut digest = Sha256::new();
        let mut chunk = [0_u8; 64 * 1024];
        loop {
            let count = file.read(&mut chunk).expect("Runtime file is unreadable");
            if count == 0 {
                break;
            }
            digest.update(&chunk[..count]);
        }
        assert_eq!(
            format!("{:x}", digest.finalize()),
            expected.as_str().expect("Invalid runtime digest"),
            "Runtime file checksum mismatch"
        );
    }
    let libraries = metadata["static_libraries"]
        .as_array()
        .expect("Static archive list is required");
    let link_order = [
        "llama-common",
        "llama-common-base",
        "cpp-httplib",
        "llama",
        "ggml",
        "ggml-cpu",
        "ggml-base",
    ];
    for library in link_order {
        let file = format!("lib{library}.a");
        assert!(
            hashes.contains_key(&file) && libraries.iter().any(|name| name.as_str() == Some(&file)),
            "Required pinned archive is missing: {file}"
        );
        let mut archive = fs::File::open(root.join(&file)).expect("Missing static archive");
        let mut magic = [0_u8; 8];
        archive
            .read_exact(&mut magic)
            .expect("Invalid static archive");
        assert_eq!(
            &magic, b"!<arch>\n",
            "Runtime must use real static archives"
        );
    }
    let mut bridge = cc::Build::new();
    bridge.cpp(true).std("c++17").file("native/bridge.cpp");
    for include in metadata["include_dirs"]
        .as_array()
        .expect("Include directories are required")
    {
        let relative = include.as_str().expect("Invalid include directory");
        assert!(Path::new(relative)
            .components()
            .all(|part| matches!(part, Component::Normal(_))));
        bridge.include(root.join(relative));
    }
    for header in [
        "include/llama.h",
        "include/llama-common/chat.h",
        "include/llama-common/json.h",
    ] {
        assert!(
            hashes.contains_key(header),
            "Required pinned header is missing: {header}"
        );
    }
    bridge.compile("aurora_llama_bridge");
    println!("cargo:rustc-link-search=native={}", root.display());
    for library in link_order {
        println!("cargo:rustc-link-lib=static={library}");
    }
    if os == "linux" || os == "android" {
        println!("cargo:rustc-link-lib=m");
    }
}

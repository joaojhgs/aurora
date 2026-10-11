use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, File},
    io::{Read, Seek},
    path::{Component, Path, PathBuf},
};

const SOURCE_COMMIT: &str = "b29c606e28a01b1bc8c1351026a0fa6e616bf6c4";
const SOURCE_SHA: &str = "03fb04316eb32a7b7347004a79a8dd60531c02f5a064d853fed3b53828951723";

fn main() {
    println!("cargo:rerun-if-env-changed=AURORA_LLAMA_CPP_LIB_DIR");
    println!("cargo:rerun-if-env-changed=CARGO_AURORA_LLAMA_CPP_LIB_DIR");
    println!("cargo:rerun-if-changed=native/bridge.cpp");
    println!("cargo:rerun-if-changed=native/bridge.h");
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if env::var_os("CARGO_FEATURE_NATIVE_NEEDLE2").is_some()
        && target_os == "android"
        && target_arch == "aarch64"
    {
        link_needle2_android_arm64();
    }
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
        println!("cargo:rerun-if-env-changed=CARGO_{key}");
    }
    let root = PathBuf::from(
        target_env
            .and_then(|key| env::var_os(key).or_else(|| env::var_os(format!("CARGO_{key}"))))
            .or_else(|| {
                env::var_os("AURORA_LLAMA_CPP_LIB_DIR")
                    .or_else(|| env::var_os("CARGO_AURORA_LLAMA_CPP_LIB_DIR"))
            })
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
    if env::var_os("CARGO_FEATURE_NATIVE_CACTUS").is_some() && os == "ios" {
        link_cactus_ios(&target, &root);
    }
}

const CACTUS_SOURCE_COMMIT: &str = "40a7123b0788f5b38c5fe0daa0d909b4286fe773";
const CACTUS_SOURCE_SHA: &str = "978ad5302bf3e6abedf73286efd498e475cbe977f6a021c8293ffb9f61867eb1";
const CACTUS_TELEMETRY_PATCH_SHA: &str =
    "3fcb6c58269e6523d1dc042d6db3c82ab3a3860d56849bde2689bde161fe3963";

fn link_cactus_ios(target: &str, llama_root: &Path) {
    let key = if target.ends_with("-sim") {
        "AURORA_CACTUS_IOS_SIMULATOR_ARM64_LIB_DIR"
    } else {
        "AURORA_CACTUS_IOS_ARM64_LIB_DIR"
    };
    println!("cargo:rerun-if-env-changed={key}");
    println!("cargo:rerun-if-env-changed=CARGO_{key}");
    let expected_target = if target.ends_with("-sim") {
        "ios-simulator-arm64"
    } else {
        "ios-arm64"
    };
    let explicit_root = env::var_os(key).or_else(|| env::var_os(format!("CARGO_{key}")));
    let root = explicit_root
        .map(PathBuf::from)
        .unwrap_or_else(|| llama_root.join("cactus").join(expected_target));
    let metadata_path = root.join("aurora-cactus-runtime.json");
    println!("cargo:rerun-if-changed={}", metadata_path.display());
    let metadata_file =
        fs::symlink_metadata(&metadata_path).expect("Pinned Cactus runtime metadata is required");
    assert!(
        metadata_file.file_type().is_file(),
        "Cactus metadata must be a regular file"
    );
    let metadata: serde_json::Value = serde_json::from_slice(
        &fs::read(&metadata_path).expect("Pinned Cactus runtime metadata is required"),
    )
    .expect("Invalid Cactus runtime metadata");
    assert_eq!(metadata["format"], 1);
    assert_eq!(metadata["link_kind"], "static");
    assert_eq!(metadata["source"]["commit"], CACTUS_SOURCE_COMMIT);
    assert_eq!(metadata["source"]["version"], "1.14.0");
    assert_eq!(metadata["source"]["archive_sha256"], CACTUS_SOURCE_SHA);
    assert_eq!(metadata["source"]["archive_bytes"], 14_761_497_u64);
    assert_eq!(
        metadata["telemetry_disabled"], true,
        "Cactus telemetry must be compiled out"
    );
    assert_eq!(
        metadata["telemetry_patch_sha256"],
        CACTUS_TELEMETRY_PATCH_SHA
    );
    assert_eq!(
        metadata["target"], expected_target,
        "Cactus target mismatch"
    );
    assert_eq!(metadata["deployment_target"], "13.0");
    assert_eq!(metadata["accelerate_abi"], "legacy");
    let libraries = metadata["static_libraries"]
        .as_array()
        .expect("Cactus static archive list is required");
    let hashes = metadata["file_sha256"]
        .as_object()
        .expect("Cactus archive hashes are required");
    for name in ["libcactus.a", "libcurl.a"] {
        assert!(
            libraries.iter().any(|entry| entry.as_str() == Some(name)),
            "Cactus static archive list is incomplete"
        );
        let expected = hashes
            .get(name)
            .and_then(serde_json::Value::as_str)
            .expect("Required Cactus link archive hash is missing");
        let path = root.join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        let metadata =
            fs::symlink_metadata(&path).expect("Required Cactus link archive is missing");
        assert!(
            metadata.file_type().is_file(),
            "Cactus archives must be regular files"
        );
        let mut file = File::open(&path).expect("Cactus archive is unreadable");
        let mut magic = [0_u8; 8];
        file.read_exact(&mut magic).expect("Invalid Cactus archive");
        assert_eq!(
            &magic, b"!<arch>\n",
            "Cactus runtime must contain static archives"
        );
        file.rewind().expect("Cactus archive is unreadable");
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file
                .read(&mut buffer)
                .expect("Cactus archive is unreadable");
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        assert_eq!(
            format!("{:x}", digest.finalize()),
            expected,
            "Cactus archive checksum mismatch"
        );
    }
    println!("cargo:rustc-link-search=native={}", root.display());
    println!("cargo:rustc-link-lib=static=cactus");
    println!("cargo:rustc-link-lib=static=curl");
    for framework in [
        "CoreML",
        "Foundation",
        "Accelerate",
        "Security",
        "SystemConfiguration",
        "CFNetwork",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rustc-link-lib=c++");
    println!("cargo:rustc-link-lib=pthread");
    println!("cargo:rustc-link-lib=z");
}

const NEEDLE2_REVISION: &str = "32e9e3a93b205f786929697446ae669cf0a84579";
const NEEDLE2_MODEL_SHA256: &str =
    "b43aabfcaf1a6db6acf488076eab71d823c08697c7af4521fc1d174b60ede5ba";
const NEEDLE2_LIBRARY_SHA256: &str =
    "93738ae3a9488cbc3104eb65bf49093683c26eb01b0d257e980e499d1d06a9f4";
const NEEDLE2_HEADER_SHA256: &str =
    "cb7a720eba7bc895b5bbfa5d6f6fc635906938fdc569eb2520a2c09ba06d9eed";

fn link_needle2_android_arm64() {
    const ENV_KEY: &str = "AURORA_NEEDLE2_ANDROID_ARM64_LIB_DIR";
    println!("cargo:rerun-if-env-changed={ENV_KEY}");
    println!("cargo:rerun-if-env-changed=CARGO_{ENV_KEY}");
    let root = env::var_os(ENV_KEY)
        .or_else(|| env::var_os(format!("CARGO_{ENV_KEY}")))
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("AURORA_LLAMA_CPP_ANDROID_ARM64_LIB_DIR")
                .or_else(|| env::var_os("CARGO_AURORA_LLAMA_CPP_ANDROID_ARM64_LIB_DIR"))
                .map(PathBuf::from)
                .map(|llama_root| llama_root.join("needle2").join("android-arm64"))
        })
        .expect("Stage the pinned Needle2 Android ARM64 runtime first");
    let metadata_path = root.join("aurora-needle-runtime.json");
    println!("cargo:rerun-if-changed={}", metadata_path.display());
    let metadata: serde_json::Value = serde_json::from_slice(
        &fs::read(&metadata_path).expect("Pinned Needle2 runtime metadata is required"),
    )
    .expect("Invalid pinned Needle2 runtime metadata");
    assert_eq!(metadata["format"], 1);
    assert_eq!(metadata["link_kind"], "static");
    assert_eq!(metadata["target"], "android-arm64");
    assert_eq!(metadata["source"]["publisher"], "Cactus-Compute/needle2");
    assert_eq!(metadata["source"]["commit"], NEEDLE2_REVISION);
    assert_eq!(metadata["source"]["archive_sha256"], NEEDLE2_MODEL_SHA256);
    assert_eq!(metadata["source"]["archive_bytes"], 13_737_807_u64);
    let hashes = metadata["file_sha256"]
        .as_object()
        .expect("Runtime file hashes are required");
    let expected = [
        ("libneedle.a", NEEDLE2_LIBRARY_SHA256),
        ("needle.h", NEEDLE2_HEADER_SHA256),
    ];
    for (name, digest_expected) in expected {
        let actual = hashes
            .get(name)
            .and_then(serde_json::Value::as_str)
            .expect("Required Needle2 runtime digest is missing");
        assert_eq!(actual, digest_expected, "Pinned Needle2 digest mismatch");
        let path = root.join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        let metadata = fs::symlink_metadata(&path).expect("Pinned Needle2 file is missing");
        assert!(
            metadata.file_type().is_file(),
            "Needle2 files must be regular files"
        );
        let mut file = fs::File::open(&path).expect("Pinned Needle2 file is unreadable");
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file
                .read(&mut buffer)
                .expect("Pinned Needle2 file is unreadable");
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        assert_eq!(
            format!("{:x}", digest.finalize()),
            digest_expected,
            "Pinned Needle2 checksum mismatch"
        );
    }
    assert!(
        metadata["static_libraries"]
            .as_array()
            .is_some_and(|items| items
                .iter()
                .any(|item| item.as_str() == Some("libneedle.a"))),
        "Pinned Needle2 static archive is not declared"
    );
    let mut archive = fs::File::open(root.join("libneedle.a")).expect("Pinned archive is missing");
    let mut magic = [0_u8; 8];
    archive
        .read_exact(&mut magic)
        .expect("Invalid pinned archive");
    assert_eq!(
        &magic, b"!<arch>\n",
        "Needle2 must use a real static archive"
    );
    let model = root
        .parent()
        .expect("Needle2 cache parent is required")
        .join("needle2.cact");
    let model_metadata = fs::symlink_metadata(&model).expect("Pinned Needle2 model is missing");
    assert!(
        model_metadata.file_type().is_file(),
        "Needle2 model must be a regular file"
    );
    assert_eq!(
        model_metadata.len(),
        13_737_807,
        "Pinned Needle2 model size mismatch"
    );
    println!("cargo:rerun-if-changed={}", model.display());
    let mut file = File::open(&model).expect("Pinned Needle2 model is unreadable");
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .expect("Pinned Needle2 model is unreadable");
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    assert_eq!(
        format!("{:x}", digest.finalize()),
        NEEDLE2_MODEL_SHA256,
        "Pinned Needle2 model checksum mismatch"
    );
    println!("cargo:rerun-if-env-changed=AURORA_NEEDLE2_ANDROID_ARM64_LIB_DIR");
    println!("cargo:rerun-if-env-changed=CARGO_AURORA_NEEDLE2_ANDROID_ARM64_LIB_DIR");
    let model = model
        .canonicalize()
        .expect("Pinned Needle2 model path is invalid");
    println!(
        "cargo:rustc-env=AURORA_NEEDLE2_BUNDLED_MODEL={}",
        model.display()
    );
    println!("cargo:rustc-link-search=native={}", root.display());
    println!("cargo:rustc-link-lib=static=needle");
}

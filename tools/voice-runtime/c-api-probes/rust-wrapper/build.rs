use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    let install_dir = env::var("SHERPA_ONNX_INSTALL_DIR")
        .expect("SHERPA_ONNX_INSTALL_DIR must point to the sherpa-onnx C API install");
    let install_dir = PathBuf::from(install_dir);
    let include_dir = install_dir.join("include");
    let lib_dir = install_dir.join("lib");
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let object = out_dir.join("sherpa_probe_bridge.o");
    let archive = out_dir.join("libaurora_sherpa_probe_bridge.a");

    let status = Command::new(env::var("CC").unwrap_or_else(|_| "cc".to_string()))
        .arg("-std=c11")
        .arg("-Wall")
        .arg("-Wextra")
        .arg("-Werror")
        .arg("-fPIC")
        .arg(format!("-I{}", include_dir.display()))
        .arg("-c")
        .arg("c/sherpa_probe_bridge.c")
        .arg("-o")
        .arg(&object)
        .status()
        .expect("failed to run C compiler");
    assert!(status.success(), "C bridge compilation failed");

    let status = Command::new(env::var("AR").unwrap_or_else(|_| "ar".to_string()))
        .arg("crus")
        .arg(&archive)
        .arg(&object)
        .status()
        .expect("failed to run ar");
    assert!(status.success(), "C bridge archive creation failed");

    println!("cargo:rerun-if-env-changed=SHERPA_ONNX_INSTALL_DIR");
    println!("cargo:rerun-if-env-changed=CC");
    println!("cargo:rerun-if-env-changed=AR");
    println!("cargo:rerun-if-changed=c/sherpa_probe_bridge.c");
    println!("cargo:rerun-if-changed=c/sherpa_probe_bridge.h");
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static=aurora_sherpa_probe_bridge");
    println!("cargo:rustc-link-lib=dylib=sherpa-onnx-c-api");
    if cfg!(target_os = "linux") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_dir.display());
    }
}

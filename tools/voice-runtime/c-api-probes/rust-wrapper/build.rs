fn main() {
    if let Ok(lib_dir) = std::env::var("SHERPA_ONNX_LIB_DIR") {
        println!("cargo:rustc-link-search=native={lib_dir}");
        println!("cargo:rustc-link-lib=dylib=sherpa-onnx-c-api");
    }
}

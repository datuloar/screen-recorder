fn main() {
    println!("cargo:rerun-if-changed=native/macos.swift");
    println!("cargo:rerun-if-changed=native/audio.swift");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let target = std::env::var("TARGET").unwrap();
    let arch = if target.starts_with("aarch64") {
        "arm64"
    } else {
        "x86_64"
    };
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let status = std::process::Command::new("xcrun")
        .args([
            "swiftc",
            "-emit-library",
            "-O",
            "-module-name",
            "RecorderBridge",
            "-target",
            &format!("{arch}-apple-macosx14.0"),
            "-Xlinker",
            "-install_name",
            "-Xlinker",
            "@rpath/libRecorderBridge.dylib",
            "native/macos.swift",
            "native/audio.swift",
            "-o",
        ])
        .arg(out.join("libRecorderBridge.dylib"))
        .status()
        .expect("Xcode command line tools are required");
    assert!(status.success(), "macOS recording bridge failed to compile");
    let profile_dir = out.ancestors().nth(3).expect("Cargo profile directory");
    std::fs::copy(
        out.join("libRecorderBridge.dylib"),
        profile_dir.join("libRecorderBridge.dylib"),
    )
    .expect("Copy macOS bridge beside development executable");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=dylib=RecorderBridge");
}

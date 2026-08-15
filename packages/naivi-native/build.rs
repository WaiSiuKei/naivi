fn main() {
    #[cfg(target_os = "macos")]
    {
        let src = "src/native_input/macos_helper.m";
        println!("cargo:rerun-if-changed={src}");
        cc::Build::new()
            .file(src)
            .flag("-fobjc-arc")
            .compile("naivi_native_input_macos");
    }
}

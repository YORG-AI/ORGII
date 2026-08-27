const SOURCE_FILES: &[(&str, &str)] = &[
    ("commands.rs", include_str!("../commands.rs")),
    ("discovery.rs", include_str!("../discovery.rs")),
    ("runner.rs", include_str!("../runner.rs")),
];

#[test]
fn test_runner_sources_do_not_use_panic_prone_stdio_macros() {
    for (path, source) in SOURCE_FILES {
        assert!(
            !source.contains("println!"),
            "{path} must use tracing instead of println!"
        );
        assert!(
            !source.contains("eprintln!"),
            "{path} must use tracing instead of eprintln!"
        );
    }
}

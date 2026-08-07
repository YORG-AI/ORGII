use std::fs;
use std::path::Path;

#[test]
fn protocol_package_stays_host_and_storage_independent() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let manifest = fs::read_to_string(root.join("Cargo.toml")).expect("read protocol manifest");
    let dependencies = manifest
        .split("[dependencies]")
        .nth(1)
        .and_then(|tail| tail.split("[dev-dependencies]").next())
        .expect("normal dependency section");
    let dependency_names = dependencies
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split('=').next())
        .map(str::trim)
        .collect::<Vec<_>>();
    assert_eq!(dependency_names, vec!["serde"]);

    let source = fs::read_to_string(root.join("src/lib.rs")).expect("read protocol source");
    for forbidden in [
        "tauri::",
        "rusqlite",
        "database::",
        "app_paths::",
        "orgtrack_core::",
        "claude_code",
        "cursor_ide",
        "codex::",
    ] {
        assert!(
            !source.contains(forbidden),
            "protocol source crossed independent-package boundary with {forbidden}"
        );
    }
}

use crate::validate_preview_asset_path;

#[test]
fn rejects_missing_paths() {
    let result = validate_preview_asset_path("/definitely/not/here/clip.mp4");
    assert!(
        result.is_err(),
        "missing file must not widen the asset scope"
    );
}

#[test]
fn rejects_directories() {
    let dir = std::env::temp_dir();
    let result = validate_preview_asset_path(dir.to_str().expect("utf-8 temp dir"));
    assert!(
        result.is_err(),
        "a directory must not widen the asset scope"
    );
}

#[test]
fn canonicalizes_regular_files() {
    let dir = std::env::temp_dir().join(format!("orgii-preview-asset-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let file = dir.join("clip.mp4");
    std::fs::write(&file, b"not really a video").expect("write temp file");

    let resolved = validate_preview_asset_path(file.to_str().expect("utf-8 path"))
        .expect("regular file resolves");
    assert_eq!(resolved, std::fs::canonicalize(&file).expect("canonical"));

    std::fs::remove_dir_all(&dir).ok();
}

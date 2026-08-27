//! Tests for `data:` URL parsing, extension mapping, and `persist_images` behavior.

use crate::persistence::images::{
    delete_image_files, load_image_as_data_url, media_type_to_ext, parse_data_url, persist_images,
    sha256_hex,
};
use base64::Engine;

fn make_png_data_url(content: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(content);
    format!("data:image/png;base64,{}", encoded)
}

fn make_jpeg_data_url(content: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(content);
    format!("data:image/jpeg;base64,{}", encoded)
}

// -- parse_data_url -------------------------------------------------

#[test]
fn parse_data_url_valid_png() {
    let url = "data:image/png;base64,iVBORw0KGgo=";
    let parsed = parse_data_url(url).expect("should parse");
    assert_eq!(parsed.media_type, "image/png");
    assert_eq!(parsed.payload, "iVBORw0KGgo=");
}

#[test]
fn parse_data_url_valid_jpeg() {
    let url = "data:image/jpeg;base64,/9j/4AAQ";
    let parsed = parse_data_url(url).expect("should parse");
    assert_eq!(parsed.media_type, "image/jpeg");
    assert_eq!(parsed.payload, "/9j/4AAQ");
}

#[test]
fn parse_data_url_rejects_non_data_prefix() {
    assert!(parse_data_url("https://example.com/img.png").is_none());
    assert!(parse_data_url("/home/user/img.png").is_none());
    assert!(parse_data_url("").is_none());
}

#[test]
fn parse_data_url_rejects_missing_base64_marker() {
    assert!(parse_data_url("data:image/png,rawdata").is_none());
}

#[test]
fn parse_data_url_rejects_empty_media_type() {
    assert!(parse_data_url("data:;base64,abc").is_none());
}

#[test]
fn parse_data_url_rejects_empty_payload() {
    assert!(parse_data_url("data:image/png;base64,").is_none());
}

// -- media_type_to_ext ----------------------------------------------

#[test]
fn media_type_to_ext_known_types() {
    assert_eq!(media_type_to_ext("image/jpeg"), "jpg");
    assert_eq!(media_type_to_ext("image/jpg"), "jpg");
    assert_eq!(media_type_to_ext("image/png"), "png");
    assert_eq!(media_type_to_ext("image/webp"), "webp");
    assert_eq!(media_type_to_ext("image/gif"), "gif");
}

#[test]
fn media_type_to_ext_unknown_fallback() {
    assert_eq!(media_type_to_ext("image/bmp"), "bin");
    assert_eq!(media_type_to_ext("application/octet-stream"), "bin");
}

// -- sha256_hex -----------------------------------------------------

#[test]
fn sha256_hex_deterministic() {
    let hash1 = sha256_hex(b"hello world");
    let hash2 = sha256_hex(b"hello world");
    assert_eq!(hash1, hash2);
    assert_eq!(hash1.len(), 64);
}

#[test]
fn sha256_hex_different_inputs() {
    assert_ne!(sha256_hex(b"aaa"), sha256_hex(b"bbb"));
}

// -- persist_images + load_image_as_data_url (round-trip) -----------

#[test]
fn persist_and_load_round_trip() {
    let _sandbox = test_helpers::test_env::sandbox();
    let test_bytes = b"fake-png-content-for-test";
    let data_url = make_png_data_url(test_bytes);
    let urls = vec![data_url.clone()];

    let paths = persist_images(&urls);
    assert_eq!(paths.len(), 1, "should persist one image");

    let path = &paths[0];
    assert!(
        std::path::Path::new(path).exists(),
        "file should exist on disk"
    );
    assert!(path.ends_with(".png"), "should have .png extension");

    let loaded = load_image_as_data_url(path).expect("should load back");
    assert!(loaded.starts_with("data:image/png;base64,"));

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(loaded.strip_prefix("data:image/png;base64,").unwrap())
        .expect("should decode");
    assert_eq!(decoded, test_bytes, "round-trip content mismatch");

    delete_image_files(&paths);
    assert!(
        !std::path::Path::new(path).exists(),
        "file should be deleted"
    );
}

// -- deduplication --------------------------------------------------

#[test]
fn persist_images_dedup_identical() {
    let _sandbox = test_helpers::test_env::sandbox();
    let data_url = make_png_data_url(b"dedup-test-content");
    let urls = vec![data_url.clone(), data_url.clone()];

    let paths = persist_images(&urls);
    assert_eq!(paths.len(), 2, "should return two paths");
    assert_eq!(paths[0], paths[1], "identical content → same path");

    delete_image_files(&[paths[0].clone()]);
}

#[test]
fn persist_images_different_content_different_paths() {
    let _sandbox = test_helpers::test_env::sandbox();
    let url_a = make_png_data_url(b"content-A");
    let url_b = make_png_data_url(b"content-B");
    let paths = persist_images(&[url_a, url_b]);
    assert_eq!(paths.len(), 2);
    assert_ne!(paths[0], paths[1], "different content → different paths");

    delete_image_files(&paths);
}

// -- persist_images with different media types ----------------------

#[test]
fn persist_images_jpeg_extension() {
    let _sandbox = test_helpers::test_env::sandbox();
    let data_url = make_jpeg_data_url(b"jpeg-test");
    let paths = persist_images(&[data_url]);
    assert_eq!(paths.len(), 1);
    assert!(paths[0].ends_with(".jpg"), "should have .jpg extension");
    delete_image_files(&paths);
}

// -- persist_images error handling ----------------------------------

#[test]
fn persist_images_skips_invalid_data_urls() {
    let _sandbox = test_helpers::test_env::sandbox();
    let urls = vec![
        "not-a-data-url".to_string(),
        "data:image/png;base64,".to_string(),
        "https://example.com/img.png".to_string(),
    ];
    let paths = persist_images(&urls);
    assert!(paths.is_empty(), "all invalid → empty result");
}

#[test]
fn persist_images_skips_invalid_base64() {
    let _sandbox = test_helpers::test_env::sandbox();
    let urls = vec!["data:image/png;base64,!!!not-valid-base64!!!".to_string()];
    let paths = persist_images(&urls);
    assert!(paths.is_empty(), "invalid base64 → empty result");
}

#[test]
fn persist_images_partial_success() {
    let _sandbox = test_helpers::test_env::sandbox();
    let valid = make_png_data_url(b"valid-image");
    let invalid = "data:image/png;base64,!!!bad!!!".to_string();
    let paths = persist_images(&[valid, invalid]);
    assert_eq!(paths.len(), 1, "only valid image persisted");
    delete_image_files(&paths);
}

// -- load_image_as_data_url error handling --------------------------

#[test]
fn load_image_nonexistent_returns_none() {
    assert!(load_image_as_data_url("/tmp/nonexistent-image-12345.png").is_none());
}

// -- delete_image_files error handling ------------------------------

#[test]
fn delete_image_files_ignores_nonexistent() {
    delete_image_files(&["/tmp/no-such-file-xyz.png".to_string()]);
}

#[test]
fn persist_images_empty_input() {
    let _sandbox = test_helpers::test_env::sandbox();
    let paths = persist_images(&[]);
    assert!(paths.is_empty());
}

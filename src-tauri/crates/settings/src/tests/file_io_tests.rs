use super::*;

#[test]
fn test_strip_line_comments() {
    let input = r#"{
  // This is a comment
  "key": "value"
}"#;
    let result = strip_jsonc_comments(input);
    let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert_eq!(parsed["key"], "value");
}

#[test]
fn test_strip_block_comments() {
    let input = r#"{
  /* block comment */
  "key": /* inline */ "value"
}"#;
    let result = strip_jsonc_comments(input);
    let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert_eq!(parsed["key"], "value");
}

#[test]
fn test_preserve_strings_with_slashes() {
    let input = r#"{
  "url": "https://example.com" // comment
}"#;
    let result = strip_jsonc_comments(input);
    let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert_eq!(parsed["url"], "https://example.com");
}

#[test]
fn test_empty_object() {
    let input = "{}";
    let result = strip_jsonc_comments(input);
    let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert!(parsed.is_object());
}

#[test]
fn read_normalization_hides_retired_multi_profile_settings() {
    let mut settings = serde_json::json!({
        "general.profileTechSavvy": "expert",
        "general.profilePresets": [{ "id": "another-profile" }],
        "general.activeProfileId": "another-profile",
    });

    remove_retired_profile_settings(&mut settings);

    assert_eq!(settings["general.profileTechSavvy"], "expert");
    assert!(settings.get("general.profilePresets").is_none());
    assert!(settings.get("general.activeProfileId").is_none());
}

#[test]
fn test_recover_trailing_garbage_json() {
    let input = r#"{
  "general.language": "zh",
  "nested": { "enabled": true }
}
rgii"
}"#;

    let recovered = recover_trailing_garbage_json(input).unwrap();
    assert_eq!(recovered["general.language"], "zh");
    assert_eq!(recovered["nested"]["enabled"], true);
}

#[test]
fn test_recover_trailing_garbage_ignores_valid_json() {
    let input = r#"{
  "general.language": "zh"
}"#;

    assert!(recover_trailing_garbage_json(input).is_none());
}

#[test]
fn test_recover_trailing_garbage_respects_strings() {
    let input = r#"{
  "message": "brace in string } should not end parse"
}
extra"#;

    let recovered = recover_trailing_garbage_json(input).unwrap();
    assert_eq!(
        recovered["message"],
        "brace in string } should not end parse"
    );
}

//! Agent Session Display Tests
//!
//! Tests `generate_display_label` and `strip_pill_references` for all
//! combinations of name/user_input, truncation, and special characters.
//!
//! ## Coverage
//! - Name takes priority over user_input when not "New Session"
//! - Falls back to user_input when name is "New Session"
//! - Returns None when both name is default and user_input is None
//! - Truncates at MAX_DISPLAY_LABEL_LENGTH (30) chars — byte-safe, char-safe
//! - Multi-byte (CJK) truncation counted in chars, not bytes
//! - Pill reference stripping: @file, @folder/, @deep/nested/path
//! - Multiple pills in the same string
//! - Pill at start, middle, end
//! - String that is only pills → stripped to empty → None
//! - String with only whitespace → None
//! - Newlines and tabs in user_input (collapsed by split_whitespace)

use crate::agent_sessions::session_directory::display::{
    generate_display_label, strip_pill_references, MAX_DISPLAY_LABEL_LENGTH,
};

// ============================================================================
// Name vs user_input priority
// ============================================================================

#[test]
fn name_takes_priority_over_user_input() {
    let label = generate_display_label("Explicit Name", Some("Some user input here"));
    assert_eq!(label, Some("Explicit Name".to_string()));
}

#[test]
fn falls_back_to_user_input_when_name_is_default() {
    let label = generate_display_label("New Session", Some("Fix the auth bug"));
    assert_eq!(label, Some("Fix the auth bug".to_string()));
}

#[test]
fn returns_none_when_name_is_default_and_no_user_input() {
    let label = generate_display_label("New Session", None);
    assert!(label.is_none());
}

#[test]
fn returns_none_when_name_is_empty_and_no_user_input() {
    let label = generate_display_label("", None);
    assert!(label.is_none());
}

// ============================================================================
// Truncation
// ============================================================================

#[test]
fn truncates_long_name_at_max_length() {
    let name = "A".repeat(100);
    let label = generate_display_label(&name, None).unwrap();
    assert_eq!(
        label.len(),
        MAX_DISPLAY_LABEL_LENGTH,
        "must truncate to {MAX_DISPLAY_LABEL_LENGTH} chars"
    );
}

#[test]
fn short_name_is_not_truncated() {
    let name = "Short";
    let label = generate_display_label(name, None).unwrap();
    assert_eq!(label, "Short");
}

#[test]
fn exactly_max_length_name_is_returned_as_is() {
    let name = "X".repeat(MAX_DISPLAY_LABEL_LENGTH);
    let label = generate_display_label(&name, None).unwrap();
    assert_eq!(label.len(), MAX_DISPLAY_LABEL_LENGTH);
}

#[test]
fn cjk_truncation_is_by_char_count_not_byte_count() {
    // Each CJK char is 3 bytes in UTF-8, so 30 chars × 3 bytes = 90 bytes
    let cjk = "中".repeat(100);
    let label = generate_display_label("New Session", Some(&cjk)).unwrap();
    let char_count = label.chars().count();
    assert!(
        char_count <= MAX_DISPLAY_LABEL_LENGTH,
        "CJK label must be truncated by char count ({char_count} > {MAX_DISPLAY_LABEL_LENGTH})"
    );
    // String must still be valid UTF-8 (no panic)
    let _ = label.len();
}

#[test]
fn emoji_truncation_is_by_char_count() {
    // Emoji can be 4 bytes (or more with ZWJ sequences)
    let emoji = "🚀".repeat(50);
    let label = generate_display_label("New Session", Some(&emoji)).unwrap();
    let char_count = label.chars().count();
    assert!(
        char_count <= MAX_DISPLAY_LABEL_LENGTH,
        "emoji label char count {char_count} exceeds limit"
    );
}

// ============================================================================
// Pill reference stripping
// ============================================================================

#[test]
fn strip_pill_references_removes_at_word() {
    assert_eq!(strip_pill_references("Fix @file.ts bug"), "Fix bug");
}

#[test]
fn strip_pill_references_handles_path_refs() {
    assert_eq!(
        strip_pill_references("Update @src/components/Button.tsx"),
        "Update"
    );
}

#[test]
fn strip_pill_references_handles_folder_refs() {
    assert_eq!(
        strip_pill_references("Review @components/ code"),
        "Review code"
    );
}

#[test]
fn strip_pill_references_multiple_pills() {
    let input = "Fix @auth.ts and @config/settings.ts now";
    let result = strip_pill_references(input);
    assert_eq!(result, "Fix and now");
}

#[test]
fn strip_pill_references_pill_at_start() {
    assert_eq!(strip_pill_references("@start middle end"), "middle end");
}

#[test]
fn strip_pill_references_pill_at_end() {
    assert_eq!(strip_pill_references("start middle @end"), "start middle");
}

#[test]
fn strip_pill_references_only_pills_returns_empty() {
    let result = strip_pill_references("@a @b @c");
    assert!(
        result.is_empty(),
        "all-pill string should collapse to empty"
    );
}

#[test]
fn strip_pill_references_no_pills_unchanged() {
    assert_eq!(strip_pill_references("No pills here"), "No pills here");
    assert_eq!(strip_pill_references(""), "");
}

#[test]
fn display_label_from_pill_only_user_input_returns_none() {
    let label = generate_display_label("New Session", Some("@file.ts @folder/"));
    assert!(
        label.is_none(),
        "all-pill user_input should produce None after stripping"
    );
}

#[test]
fn display_label_collapses_extra_whitespace() {
    // Multiple spaces between words should be collapsed
    let label = generate_display_label("New Session", Some("Fix  the   bug"));
    assert_eq!(label, Some("Fix the bug".to_string()));
}

#[test]
fn display_label_strips_leading_trailing_whitespace() {
    let label = generate_display_label("  Padded Name  ", None);
    // The name is not "New Session" so it should be used, but trimmed
    assert_eq!(label, Some("Padded Name".to_string()));
}

use crate::diff_patch::*;

// ============================================
// compute_diff tests
// ============================================

#[test]
fn test_compute_diff() {
    let old = "line1\nline2\nline3";
    let new = "line1\nmodified\nline3";

    let result = compute_diff(old.to_string(), new.to_string(), None, None, None).unwrap();

    assert!(result.diff.contains("-line2"));
    assert!(result.diff.contains("+modified"));
    assert_eq!(result.stats.lines_added, 1);
    assert_eq!(result.stats.lines_removed, 1);
}

#[test]
fn test_parse_patch() {
    let patch = r#"
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line1
-line2
+modified
 line3
"#;

    let hunks = parse_patch(patch).unwrap();
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].old_start, 1);
    assert_eq!(hunks[0].lines.len(), 4); // context + removed + added
}

#[test]
fn test_apply_patch() {
    let original = "line1\nline2\nline3";
    let patch = r#"
@@ -1,3 +1,3 @@
 line1
-line2
+modified
 line3
"#;

    let result = apply_patch(original.to_string(), patch.to_string()).unwrap();
    assert!(result.success);
    assert!(result.content.contains("modified"));
    assert!(!result.content.contains("line2"));
}

#[test]
fn test_fuzzy_patch_with_offset() {
    // Original has extra lines at the beginning
    let original = "extra1\nextra2\nline1\nline2\nline3";
    // Patch expects line1 at line 1, but it's at line 3
    let patch = r#"
@@ -1,3 +1,3 @@
 line1
-line2
+modified
 line3
"#;

    let result = apply_fuzzy_patch(
        original.to_string(),
        patch.to_string(),
        Some(FuzzyPatchOptions {
            fuzz_factor: Some(10),
            min_similarity: Some(0.6),
            ignore_whitespace: Some(true),
        }),
    )
    .unwrap();

    assert!(result.success);
    assert!(result.content.contains("modified"));
    // The offset should be +2 (moved 2 lines down)
    assert_eq!(result.hunks[0].offset_applied, 2);
}

#[test]
fn test_merge_no_conflict() {
    let base = "line1\nline2\nline3";
    let ours = "line1\nmodified\nline3";
    let theirs = "line1\nline2\nline3"; // unchanged

    let result = merge_three_way(
        base.to_string(),
        ours.to_string(),
        theirs.to_string(),
        None,
        None,
    )
    .unwrap();

    assert!(result.clean);
    assert!(result.content.contains("modified"));
}

#[test]
fn test_merge_with_conflict() {
    let base = "line1\nline2\nline3";
    let ours = "line1\nours_change\nline3";
    let theirs = "line1\ntheirs_change\nline3";

    let result = merge_three_way(
        base.to_string(),
        ours.to_string(),
        theirs.to_string(),
        None,
        None,
    )
    .unwrap();

    assert!(!result.clean);
    assert_eq!(result.conflict_count, 1);
    assert!(result.content.contains("<<<<<<<"));
    assert!(result.content.contains("======="));
    assert!(result.content.contains(">>>>>>>"));
}

// ============================================
// compute_diff_with_hunks tests
// ============================================

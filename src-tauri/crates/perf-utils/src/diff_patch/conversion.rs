//! Patch format conversion — custom patch syntax → unified diff
//!
//! Converts the `*** Begin Patch` / `*** Add File:` / `*** Modify File:`
//! syntax (used by some agents) into standard unified diff format,
//! including line-change statistics.

use super::types::{PatchConversionResult, PatchSegment};

fn is_hunk_marker(line: &str) -> bool {
    line.trim_start().starts_with("@@")
}

fn is_explicit_hunk_header(line: &str) -> bool {
    let mut parts = line.split_whitespace();
    matches!(parts.next(), Some("@@"))
        && parts.next().is_some_and(|part| part.starts_with('-'))
        && parts.next().is_some_and(|part| part.starts_with('+'))
}

/// Build unified diff lines for one section and return a `PatchSegment`.
fn flush_section(file_path: &str, is_add: bool, section: &mut Vec<String>) -> Option<PatchSegment> {
    let body_lines: Vec<&String> = section
        .iter()
        .filter(|line| !is_hunk_marker(line))
        .collect();
    let has_explicit_hunk_header = section.iter().any(|line| is_explicit_hunk_header(line));

    if file_path.is_empty() || (body_lines.is_empty() && !has_explicit_hunk_header) {
        section.clear();
        return None;
    }

    let mut diff_lines: Vec<String> = Vec::new();
    let mut seg_added: usize = 0;
    let mut seg_removed: usize = 0;

    if is_add {
        diff_lines.push("--- /dev/null".to_string());
        diff_lines.push(format!("+++ {}", file_path));
        diff_lines.push(format!("@@ -0,0 +1,{} @@", body_lines.len()));
    } else {
        diff_lines.push(format!("--- {}", file_path));
        diff_lines.push(format!("+++ {}", file_path));
        if !has_explicit_hunk_header {
            let add_count = body_lines.iter().filter(|l| l.starts_with('+')).count();
            let rem_count = body_lines.iter().filter(|l| l.starts_with('-')).count();
            let ctx_count = body_lines
                .iter()
                .filter(|l| !l.starts_with('+') && !l.starts_with('-'))
                .count();
            diff_lines.push(format!(
                "@@ -1,{} +1,{} @@",
                rem_count + ctx_count,
                add_count + ctx_count
            ));
        }
    }

    for line in section.iter() {
        if is_hunk_marker(line) && !is_explicit_hunk_header(line) {
            continue;
        }
        if line.starts_with('+') {
            seg_added += 1;
        } else if line.starts_with('-') {
            seg_removed += 1;
        }
        diff_lines.push(line.clone());
    }
    section.clear();

    Some(PatchSegment {
        file_path: file_path.to_string(),
        diff: diff_lines.join("\n"),
        lines_added: seg_added,
        lines_removed: seg_removed,
        is_deleted: false,
        has_explicit_hunk_header: is_add || has_explicit_hunk_header,
    })
}

/// Convert "*** Begin Patch / *** Add File: / *** Modify File:" syntax
/// into unified diff format with statistics.
pub(super) fn convert_patch_to_unified_impl(patch_text: &str) -> PatchConversionResult {
    let mut segments: Vec<PatchSegment> = Vec::new();
    let mut current_file = String::new();
    let mut is_add_file = false;
    let mut section_lines: Vec<String> = Vec::new();

    for line in patch_text.lines() {
        if let Some(rest) = line.strip_prefix("*** Add File: ").or_else(|| {
            line.strip_prefix("***  Add File: ")
                .or_else(|| line.strip_prefix("*** \tAdd File: "))
        }) {
            if let Some(seg) = flush_section(&current_file, is_add_file, &mut section_lines) {
                segments.push(seg);
            }
            current_file = rest.trim().to_string();
            is_add_file = true;
            continue;
        }
        if let Some(rest) = line
            .strip_prefix("*** Modify File: ")
            .or_else(|| line.strip_prefix("***  Modify File: "))
            .or_else(|| line.strip_prefix("*** \tModify File: "))
            .or_else(|| line.strip_prefix("*** Update File: "))
            .or_else(|| line.strip_prefix("***  Update File: "))
            .or_else(|| line.strip_prefix("*** \tUpdate File: "))
        {
            if let Some(seg) = flush_section(&current_file, is_add_file, &mut section_lines) {
                segments.push(seg);
            }
            current_file = rest.trim().to_string();
            is_add_file = false;
            continue;
        }
        // Fallback: the LLM prompt instructs the agent to use a separate
        // `delete_file` tool call instead of embedding deletes in apply_patch.
        // This branch exists only as a safety net in case the LLM ignores
        // the instruction and still emits `*** Delete File:` directives.
        if let Some(rest) = line.strip_prefix("*** Delete File: ").or_else(|| {
            line.strip_prefix("***  Delete File: ")
                .or_else(|| line.strip_prefix("*** \tDelete File: "))
        }) {
            if let Some(seg) = flush_section(&current_file, is_add_file, &mut section_lines) {
                segments.push(seg);
            }
            let deleted_path = rest.trim().to_string();
            segments.push(PatchSegment {
                diff: format!("--- {}\n+++ /dev/null", deleted_path),
                file_path: deleted_path,
                lines_added: 0,
                lines_removed: 0,
                is_deleted: true,
                has_explicit_hunk_header: false,
            });
            current_file = String::new();
            continue;
        }
        if line.starts_with("*** Begin Patch") || line.starts_with("*** End Patch") {
            continue;
        }
        if !current_file.is_empty() {
            section_lines.push(line.to_string());
        }
    }

    if let Some(seg) = flush_section(&current_file, is_add_file, &mut section_lines) {
        segments.push(seg);
    }

    let diff = segments
        .iter()
        .map(|s| s.diff.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let lines_added = segments.iter().map(|s| s.lines_added).sum();
    let lines_removed = segments.iter().map(|s| s.lines_removed).sum();
    let file_paths = segments.iter().map(|s| s.file_path.clone()).collect();

    PatchConversionResult {
        diff,
        lines_added,
        lines_removed,
        file_paths,
        segments,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_file_patch_produces_segments() {
        let patch = "\
*** Begin Patch
*** Add File: src/new_file.ts
+export const hello = \"world\";
+export const foo = \"bar\";
*** Modify File: src/existing.ts
 import React from 'react';
-const old = true;
+const updated = false;
*** End Patch";

        let result = convert_patch_to_unified_impl(patch);

        assert_eq!(result.segments.len(), 2);
        assert_eq!(
            result.file_paths,
            vec!["src/new_file.ts", "src/existing.ts"]
        );

        let seg0 = &result.segments[0];
        assert_eq!(seg0.file_path, "src/new_file.ts");
        assert_eq!(seg0.lines_added, 2);
        assert_eq!(seg0.lines_removed, 0);
        assert!(seg0.diff.contains("--- /dev/null"));
        assert!(seg0.diff.contains("+++ src/new_file.ts"));

        let seg1 = &result.segments[1];
        assert_eq!(seg1.file_path, "src/existing.ts");
        assert_eq!(seg1.lines_added, 1);
        assert_eq!(seg1.lines_removed, 1);
        assert!(seg1.diff.contains("--- src/existing.ts"));
        assert!(seg1.diff.contains("+++ src/existing.ts"));

        assert_eq!(result.lines_added, 3);
        assert_eq!(result.lines_removed, 1);
        assert!(result.diff.contains("+export const hello"));
        assert!(result.diff.contains("+const updated = false"));
    }

    #[test]
    fn single_file_patch_produces_one_segment() {
        let patch = "\
*** Begin Patch
*** Modify File: src/utils.rs
@@
 fn helper() {
-    old_impl();
+    new_impl();
 }
*** End Patch";

        let result = convert_patch_to_unified_impl(patch);

        assert_eq!(result.segments.len(), 1);
        assert_eq!(result.segments[0].file_path, "src/utils.rs");
        assert_eq!(result.segments[0].lines_added, 1);
        assert_eq!(result.segments[0].lines_removed, 1);
        assert!(!result.segments[0].has_explicit_hunk_header);
        assert!(!result.segments[0].diff.contains("\n@@\n"));
        assert_eq!(result.lines_added, 1);
        assert_eq!(result.lines_removed, 1);
    }

    #[test]
    fn explicit_hunk_header_is_preserved() {
        let patch = "\
*** Begin Patch
*** Update File: src/utils.rs
@@ -42,3 +43,3 @@
 context
-old
+new
*** End Patch";

        let result = convert_patch_to_unified_impl(patch);

        assert_eq!(result.segments.len(), 1);
        assert!(result.segments[0].has_explicit_hunk_header);
        assert!(result.segments[0].diff.contains("@@ -42,3 +43,3 @@"));
        assert!(result.diff.contains("@@ -42,3 +43,3 @@"));
        assert_eq!(result.segments[0].lines_added, 1);
        assert_eq!(result.segments[0].lines_removed, 1);
    }

    #[test]
    fn empty_patch_produces_no_segments() {
        let patch = "*** Begin Patch\n*** End Patch";
        let result = convert_patch_to_unified_impl(patch);

        assert!(result.segments.is_empty());
        assert!(result.file_paths.is_empty());
        assert_eq!(result.lines_added, 0);
        assert_eq!(result.lines_removed, 0);
        assert!(result.diff.is_empty());
    }

    #[test]
    fn empty_string_produces_no_segments() {
        let result = convert_patch_to_unified_impl("");
        assert!(result.segments.is_empty());
        assert!(result.diff.is_empty());
    }

    #[test]
    fn delete_file_produces_deleted_segment() {
        let patch = "\
*** Begin Patch
*** Add File: src/new.ts
+export const x = 1;
*** Delete File: src/old.ts
*** Modify File: src/main.ts
 import { x } from './new';
-import { y } from './old';
*** End Patch";

        let result = convert_patch_to_unified_impl(patch);

        assert_eq!(result.segments.len(), 3);
        assert_eq!(
            result.file_paths,
            vec!["src/new.ts", "src/old.ts", "src/main.ts"]
        );

        let add_seg = &result.segments[0];
        assert_eq!(add_seg.file_path, "src/new.ts");
        assert!(!add_seg.is_deleted);
        assert_eq!(add_seg.lines_added, 1);

        let del_seg = &result.segments[1];
        assert_eq!(del_seg.file_path, "src/old.ts");
        assert!(del_seg.is_deleted);
        assert_eq!(del_seg.lines_added, 0);
        assert_eq!(del_seg.lines_removed, 0);
        assert!(del_seg.diff.contains("--- src/old.ts"));
        assert!(del_seg.diff.contains("+++ /dev/null"));

        let mod_seg = &result.segments[2];
        assert_eq!(mod_seg.file_path, "src/main.ts");
        assert!(!mod_seg.is_deleted);
        assert_eq!(mod_seg.lines_removed, 1);
    }
}

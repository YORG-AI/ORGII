use super::*;
use serde_json::json;

// ============================================
// count_diff_lines
// ============================================

#[test]
fn count_diff_lines_empty() {
    assert_eq!(count_diff_lines(""), (0, 0));
}

#[test]
fn count_diff_lines_only_additions() {
    let diff = "+added line 1\n+added line 2\n+added line 3\n";
    assert_eq!(count_diff_lines(diff), (3, 0));
}

#[test]
fn count_diff_lines_only_removals() {
    let diff = "-removed 1\n-removed 2\n";
    assert_eq!(count_diff_lines(diff), (0, 2));
}

#[test]
fn count_diff_lines_mixed() {
    let diff =
        "--- a/foo.rs\n+++ b/foo.rs\n@@ -1,3 +1,4 @@\n context\n-old line\n+new line\n+extra\n";
    assert_eq!(count_diff_lines(diff), (2, 1));
}

#[test]
fn count_diff_lines_skips_header_markers() {
    let diff = "--- a/file.rs\n+++ b/file.rs\n";
    assert_eq!(count_diff_lines(diff), (0, 0));
}

#[test]
fn count_diff_lines_context_lines_ignored() {
    let diff = " context 1\n+added\n context 2\n-removed\n context 3\n";
    assert_eq!(count_diff_lines(diff), (1, 1));
}

// ============================================
// extract_edit_content
// ============================================

#[test]
fn extract_edit_content_new_string() {
    let input = json!({"new_string": "hello"});
    assert_eq!(extract_edit_content(&input), Some("hello".to_string()));
}

#[test]
fn extract_edit_content_content_field() {
    let input = json!({"content": "world"});
    assert_eq!(extract_edit_content(&input), Some("world".to_string()));
}

#[test]
fn extract_edit_content_file_text() {
    let input = json!({"file_text": "data"});
    assert_eq!(extract_edit_content(&input), Some("data".to_string()));
}

#[test]
fn extract_edit_content_empty_value_skipped() {
    let input = json!({"new_string": "", "content": "fallback"});
    assert_eq!(extract_edit_content(&input), Some("fallback".to_string()));
}

#[test]
fn extract_edit_content_no_matching_field() {
    let input = json!({"unrelated": "value"});
    assert_eq!(extract_edit_content(&input), None);
}

#[test]
fn extract_edit_content_empty_object() {
    let input = json!({});
    assert_eq!(extract_edit_content(&input), None);
}

// ============================================
// synthesize_diff
// ============================================

#[test]
fn synthesize_diff_new_file() {
    let (diff, added, removed) = synthesize_diff("src/main.rs", "", "fn main() {}\n");
    assert!(diff.contains("+++ b/src/main.rs"));
    assert!(diff.contains("+fn main() {}"));
    assert_eq!(added, 1);
    assert_eq!(removed, 0);
}

#[test]
fn synthesize_diff_replacement() {
    let (diff, added, removed) = synthesize_diff("foo.rs", "old line", "new line");
    assert!(diff.contains("-old line"));
    assert!(diff.contains("+new line"));
    assert_eq!(added, 1);
    assert_eq!(removed, 1);
}

#[test]
fn synthesize_diff_multi_line() {
    let old = "line1\nline2\n";
    let new = "line1\nline2\nline3\n";
    let (diff, added, removed) = synthesize_diff("f.txt", old, new);
    assert!(diff.contains("@@ -1,2 +1,3 @@"));
    assert_eq!(added, 1);
    assert_eq!(removed, 0);
}

#[test]
fn synthesize_diff_header_format() {
    let (diff, _, _) = synthesize_diff("path/to/file.rs", "", "content");
    assert!(diff.starts_with("--- a/path/to/file.rs\n+++ b/path/to/file.rs\n"));
}

// ============================================
// parse_markdown_todos
// ============================================

#[test]
fn parse_markdown_todos_empty() {
    let result = parse_markdown_todos("");
    assert_eq!(result, Value::Array(vec![]));
}

#[test]
fn parse_markdown_todos_checked_and_unchecked() {
    let md = "- [x] Done task\n- [ ] Pending task\n";
    let result = parse_markdown_todos(md);
    insta::assert_yaml_snapshot!("todos_checked_unchecked", result);
}

#[test]
fn parse_markdown_todos_uppercase_x() {
    let md = "- [X] Also done\n";
    let result = parse_markdown_todos(md);
    let arr = result.as_array().unwrap();
    assert_eq!(arr[0]["status"], "completed");
}

#[test]
fn parse_markdown_todos_strips_numeric_prefix() {
    let md = "- [ ] 1. First item\n- [ ] 2. Second item\n";
    let result = parse_markdown_todos(md);
    insta::assert_yaml_snapshot!("todos_numeric_prefix", result);
}

#[test]
fn parse_markdown_todos_non_numeric_prefix_preserved() {
    let md = "- [ ] abc. Not a number prefix\n";
    let result = parse_markdown_todos(md);
    insta::assert_yaml_snapshot!("todos_non_numeric_prefix", result);
}

#[test]
fn parse_markdown_todos_ignores_non_todo_lines() {
    let md = "Some text\n- [x] A task\n## Header\n- [ ] Another\n";
    let result = parse_markdown_todos(md);
    let arr = result.as_array().unwrap();
    assert_eq!(arr.len(), 2);
}

#[test]
fn parse_markdown_todos_auto_increment_ids() {
    let md = "- [ ] Task A\n- [ ] Task B\n- [ ] Task C\n";
    let result = parse_markdown_todos(md);
    insta::assert_yaml_snapshot!("todos_auto_ids", result);
}

// ============================================
// extract_tool_call_content
// ============================================

#[test]
fn extract_tool_call_content_raw_output() {
    let update = json!({
        "rawOutput": {
            "content": "result text",
            "detailedContent": "detailed info"
        }
    });
    let (content, detailed) = extract_tool_call_content(&update);
    insta::assert_yaml_snapshot!(
        "tool_call_raw_output",
        serde_json::json!({
            "content": content,
            "detailed": detailed,
        })
    );
}

#[test]
fn extract_tool_call_content_empty_raw_output() {
    let update = json!({"rawOutput": {}});
    let (content, detailed) = extract_tool_call_content(&update);
    assert!(content.is_empty());
    assert!(detailed.is_empty());
}

#[test]
fn extract_tool_call_content_no_raw_output() {
    let update = json!({"something": "else"});
    let (content, detailed) = extract_tool_call_content(&update);
    assert!(content.is_empty());
    assert!(detailed.is_empty());
}

// ============================================
// normalize_tool_result
// ============================================

#[test]
fn normalize_tool_result_shell_success() {
    let result = normalize_tool_result("Shell", "output text", "", false, None);
    insta::assert_yaml_snapshot!("norm_shell_success", result);
}

#[test]
fn normalize_tool_result_shell_error() {
    let result = normalize_tool_result("Shell", "error msg", "", true, None);
    insta::assert_yaml_snapshot!("norm_shell_error", result);
}

#[test]
fn normalize_tool_result_read_no_pending() {
    let result = normalize_tool_result("Read", "file content", "", false, None);
    insta::assert_yaml_snapshot!("norm_read_success", result);
}

#[test]
fn normalize_tool_result_unknown_tool_success() {
    let result = normalize_tool_result("CustomTool", "data", "", false, None);
    insta::assert_yaml_snapshot!("norm_unknown_success", result);
}

#[test]
fn normalize_tool_result_unknown_tool_error() {
    let result = normalize_tool_result("CustomTool", "failed", "", true, None);
    insta::assert_yaml_snapshot!("norm_unknown_error", result);
}

// ============================================
// AcpAgentAdapter::map_tool_kind (default impl)
// ============================================

struct TestAdapter;
impl AcpAgentAdapter for TestAdapter {}

#[test]
fn map_tool_kind_execute() {
    let adapter = TestAdapter;
    assert_eq!(adapter.map_tool_kind("execute", &json!({})), "Shell");
}

#[test]
fn map_tool_kind_read() {
    let adapter = TestAdapter;
    assert_eq!(adapter.map_tool_kind("read", &json!({})), "Read");
}

#[test]
fn map_tool_kind_write() {
    let adapter = TestAdapter;
    assert_eq!(adapter.map_tool_kind("write", &json!({})), "Edit");
}

#[test]
fn map_tool_kind_edit() {
    let adapter = TestAdapter;
    assert_eq!(adapter.map_tool_kind("edit", &json!({})), "Edit");
}

#[test]
fn map_tool_kind_search() {
    let adapter = TestAdapter;
    assert_eq!(adapter.map_tool_kind("search", &json!({})), "Grep");
}

#[test]
fn map_tool_kind_unknown_passthrough() {
    let adapter = TestAdapter;
    assert_eq!(
        adapter.map_tool_kind("custom_thing", &json!({})),
        "custom_thing"
    );
}

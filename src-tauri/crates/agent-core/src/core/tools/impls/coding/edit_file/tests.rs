use crate::tools::{
    impls::coding::edit_file::{
        is_notebook_path,
        strategies::{levenshtein, replace},
        EditTool,
    },
    traits::{CallContext, Tool, ToolError},
};
use serde_json::json;

#[test]
fn test_empty_old_string_error() {
    for replace_all in [false, true] {
        let error = replace("non-empty", "", "replacement", replace_all).unwrap_err();
        assert!(error.contains("must not be empty"));
    }
}

#[tokio::test]
async fn test_tool_rejects_empty_search_without_changing_file() {
    let workspace = tempfile::tempdir().unwrap();
    let file = workspace.path().join("test.txt");
    let tool = EditTool::new().with_workspace(workspace.path().to_path_buf());

    tool.execute_text(
        json!({"file_path": "test.txt", "content": "original", "old_string": "", "new_string": ""}),
        &CallContext::default(),
    )
    .await
    .unwrap();

    let error = tool
        .execute_text(
            json!({"file_path": "test.txt", "content": "partial", "old_string": "", "new_string": "x"}),
            &CallContext::default(),
        )
        .await
        .unwrap_err();

    assert!(
        matches!(error, ToolError::InvalidParams(message) if message.contains("must not be empty"))
    );
    assert_eq!(std::fs::read_to_string(file).unwrap(), "original");
}

#[test]
fn notebook_paths_are_rejected_by_plain_edit_tool() {
    assert!(is_notebook_path(std::path::Path::new("analysis.ipynb")));
    assert!(is_notebook_path(std::path::Path::new("ANALYSIS.IPYNB")));
    assert!(!is_notebook_path(std::path::Path::new("analysis.py")));
}

#[test]
fn test_simple_exact_match() {
    let content = "fn main() {\n    println!(\"hello\");\n}\n";
    let result = replace(content, "println!(\"hello\")", "println!(\"world\")", false).unwrap();
    assert!(result.contains("println!(\"world\")"));
    assert!(!result.contains("println!(\"hello\")"));
}

#[test]
fn test_line_trimmed() {
    let content = "    fn foo() {\n        bar();\n    }\n";
    // LLM sends without indentation
    let result = replace(
        content,
        "fn foo() {\n    bar();\n}",
        "fn foo() {\n    baz();\n}",
        false,
    )
    .unwrap();
    assert!(result.contains("baz()"));
}

#[test]
fn test_indentation_flexible() {
    let content = "        if true {\n            do_thing();\n        }\n";
    // LLM sends at indent 0
    let result = replace(
        content,
        "if true {\n    do_thing();\n}",
        "if true {\n    do_other();\n}",
        false,
    )
    .unwrap();
    assert!(result.contains("do_other()"));
}

#[test]
fn test_whitespace_normalized() {
    let content = "let   x  =   42;\n";
    let result = replace(content, "let x = 42;", "let x = 99;", false).unwrap();
    assert!(result.contains("let x = 99;"));
}

#[test]
fn test_trimmed_boundary() {
    let content = "fn main() {\n    hello();\n}\n";
    // LLM adds extra newlines around the search
    let result = replace(content, "\n    hello();\n", "    world();\n", false).unwrap();
    assert!(result.contains("world()"));
}

#[test]
fn test_identical_strings_error() {
    let result = replace("content", "same", "same", false);
    assert!(result.is_err());
}

#[test]
fn test_not_found_error() {
    let result = replace("fn main() {}", "nonexistent_string", "replacement", false);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Could not find"));
}

#[test]
fn test_replace_all() {
    let content = "aaa bbb aaa bbb aaa";
    let result = replace(content, "aaa", "ccc", true).unwrap();
    assert_eq!(result, "ccc bbb ccc bbb ccc");
}

#[test]
fn test_multiple_matches_error() {
    let content = "foo\nbar\nfoo\n";
    let result = replace(content, "foo", "baz", false);
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.contains("Found 2 matches"), "got: {err}");
    assert!(err.contains("replace_all"), "got: {err}");
}

#[test]
fn test_block_anchor() {
    let content = "fn process() {\n    let x = 1;\n    let y = 2;\n    let z = 3;\n}\n";
    // LLM gets first/last lines right but mangles middle
    let result = replace(
        content,
        "fn process() {\n    let xx = 1;\n    let yy = 2;\n    let zz = 3;\n}",
        "fn process() {\n    let a = 10;\n}",
        false,
    )
    .unwrap();
    assert!(result.contains("let a = 10;"));
}

#[test]
fn test_escape_normalized() {
    let content = "let msg = \"hello\\nworld\";\n";
    let result = replace(
        content,
        "let msg = \"hello\\\\nworld\";",
        "let msg = \"goodbye\";",
        false,
    )
    .unwrap();
    assert!(result.contains("goodbye"));
}

#[test]
fn test_context_aware() {
    let content = "fn a() {\n    step1();\n    step2();\n    step3();\n}\n";
    // Same line count, first/last match, >50% middle match
    let result = replace(
        content,
        "fn a() {\n    step1();\n    stepX();\n    step3();\n}",
        "fn a() {\n    new_step();\n}",
        false,
    )
    .unwrap();
    assert!(result.contains("new_step()"));
}

#[test]
fn test_levenshtein_basic() {
    assert_eq!(levenshtein("", ""), 0);
    assert_eq!(levenshtein("abc", ""), 3);
    assert_eq!(levenshtein("", "abc"), 3);
    assert_eq!(levenshtein("kitten", "sitting"), 3);
    assert_eq!(levenshtein("same", "same"), 0);
}

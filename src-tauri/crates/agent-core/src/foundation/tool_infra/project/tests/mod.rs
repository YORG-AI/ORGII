//! Tests for project module.

use project_management::projects::types::{TodoEntry, WorkItemFrontmatter};

use super::helpers::truncate_preview;
use super::{build_agent_prompt, build_project_prompt, slugify};

fn make_frontmatter(title: &str, todos: Vec<TodoEntry>) -> WorkItemFrontmatter {
    WorkItemFrontmatter {
        id: "test-id".to_string(),
        short_id: "TST-1".to_string(),
        title: title.to_string(),
        project: None,
        status: "backlog".to_string(),
        priority: "none".to_string(),
        assignee: None,
        assignee_type: None,
        labels: vec![],
        milestone: None,
        parent: None,
        stage: None,
        start_date: None,
        target_date: None,
        created_by: None,
        origin_session: None,
        created_at: "2025-01-01T00:00:00Z".to_string(),
        updated_at: "2025-01-01T00:00:00Z".to_string(),
        deleted_at: None,
        starred: false,
        todos,
        comments: vec![],
        history: vec![],
        delegations: vec![],
        handoff: None,
        linked_sessions: vec![],
        proof_of_work: None,
        orchestrator_config: None,
        orchestrator_state: None,
        follow_up_items: vec![],
        schedule: None,
        routine_source: None,
        execution_lock: None,
        close_out: None,
        work_products: vec![],
    }
}

// ============================================
// truncate_preview
// ============================================

#[test]
fn truncate_preview_returns_short_string() {
    assert_eq!(truncate_preview("hello", 100), "hello");
}

#[test]
fn truncate_preview_truncates_long_string() {
    let long = "a".repeat(200);
    let result = truncate_preview(&long, 50);
    assert_eq!(result.len(), 53); // 50 chars + "..."
    assert!(result.ends_with("..."));
}

#[test]
fn truncate_preview_handles_multibyte_chars() {
    let chinese = "你好世界测试文本这是一段中文";
    let result = truncate_preview(chinese, 10);
    assert!(result.ends_with("..."));
    assert!(result.is_char_boundary(result.len() - 3));
}

#[test]
fn truncate_preview_at_exact_limit() {
    let exact = "abcde";
    assert_eq!(truncate_preview(exact, 5), "abcde");
}

#[test]
fn truncate_preview_empty_string() {
    assert_eq!(truncate_preview("", 10), "");
}

// ============================================
// slugify
// ============================================

#[test]
fn slugify_lowercases() {
    assert_eq!(slugify("Hello World"), "hello-world");
}

#[test]
fn slugify_replaces_special_chars() {
    assert_eq!(slugify("my_project!@#$%"), "my-project");
}

#[test]
fn slugify_collapses_multiple_hyphens() {
    assert_eq!(slugify("a---b---c"), "a-b-c");
}

#[test]
fn slugify_trims_leading_trailing_hyphens() {
    assert_eq!(slugify("--hello--"), "hello");
}

#[test]
fn slugify_preserves_numbers() {
    assert_eq!(slugify("project 2024"), "project-2024");
}

#[test]
fn slugify_handles_empty_string() {
    assert_eq!(slugify(""), "");
}

#[test]
fn slugify_handles_all_special_chars() {
    assert_eq!(slugify("@#$%"), "");
}

// ============================================
// build_project_prompt
// ============================================

#[test]
fn build_project_prompt_includes_title_and_id() {
    let fm = make_frontmatter("Fix login bug", vec![]);
    let prompt = build_project_prompt("PRJ-1", &fm, "The login page crashes");
    assert!(prompt.contains("PRJ-1"));
    assert!(prompt.contains("Fix login bug"));
    assert!(prompt.contains("The login page crashes"));
    assert!(prompt.contains("Create a feature branch"));
}

#[test]
fn build_project_prompt_includes_todos_as_acceptance_criteria() {
    let todos = vec![
        TodoEntry {
            id: "t1".to_string(),
            content: "Write unit tests".to_string(),
            status: "pending".to_string(),
        },
        TodoEntry {
            id: "t2".to_string(),
            content: "Run CI".to_string(),
            status: super::helpers::TODO_STATUS_COMPLETED.to_string(),
        },
    ];
    let fm = make_frontmatter("Add tests", todos);
    let prompt = build_project_prompt("PRJ-2", &fm, "");
    assert!(prompt.contains("Acceptance Criteria"));
    assert!(prompt.contains("[ ] Write unit tests"));
    assert!(prompt.contains("[x] Run CI"));
}

// ============================================
// build_agent_prompt
// ============================================

#[test]
fn build_agent_prompt_omits_sde_instructions() {
    let fm = make_frontmatter("Review code", vec![]);
    let prompt = build_agent_prompt("PRJ-3", &fm, "Check for issues");
    assert!(prompt.contains("PRJ-3"));
    assert!(prompt.contains("Review code"));
    assert!(!prompt.contains("Create a feature branch"));
}

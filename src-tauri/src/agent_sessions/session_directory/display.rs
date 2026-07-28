//! Display label generation and text search utilities.
//!
//! Provides functions to generate user-friendly display labels for sessions
//! and to perform case-insensitive text search across session fields.

use super::types::SessionAggregateRecord;

// ============================================================================
// Display Label Generation
// ============================================================================

/// Default session name (used to detect untitled sessions)
const DEFAULT_SESSION_NAME: &str = "New Session";

/// Maximum length for display labels
pub const MAX_DISPLAY_LABEL_LENGTH: usize = 30;

/// Generate a display label for a session.
/// Returns None if no meaningful label can be generated.
pub fn generate_display_label(name: &str, user_input: Option<&str>) -> Option<String> {
    // Prefer name if it's not the default
    let raw_text = if !name.is_empty() && name != DEFAULT_SESSION_NAME {
        name.to_string()
    } else if let Some(input) = user_input {
        // Truncate user_input to ~80 chars (UTF-8 safe)
        truncate_utf8(input, 80)
    } else {
        return None;
    };

    // Strip pill references (e.g., @file.ts, @folder/)
    let stripped = strip_pill_references(&raw_text);

    // Truncate to max length (UTF-8 safe)
    let label = truncate_utf8(&stripped, MAX_DISPLAY_LABEL_LENGTH);

    if label.is_empty() {
        None
    } else {
        Some(label)
    }
}

/// Truncate a string to at most `max_chars` characters (UTF-8 safe).
fn truncate_utf8(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// Strip @-pill references from text (e.g., "@file.ts" -> "")
pub fn strip_pill_references(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '@' {
            // Skip until whitespace or end
            while let Some(&next) = chars.peek() {
                if next.is_whitespace() {
                    break;
                }
                chars.next();
            }
        } else {
            result.push(ch);
        }
    }

    // Clean up multiple spaces and trim
    result.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ============================================================================
// Text Search
// ============================================================================

/// Check if session matches a text query (case-insensitive)
pub fn matches_text_query(session: &SessionAggregateRecord, query: &str) -> bool {
    let query_lower = query.to_lowercase();

    // Search in name
    if session.name.to_lowercase().contains(&query_lower) {
        return true;
    }

    // Search in user_input
    if let Some(ref input) = session.user_input {
        if input.to_lowercase().contains(&query_lower) {
            return true;
        }
    }

    // Search in repo_name
    if let Some(ref repo_name) = session.repo_name {
        if repo_name.to_lowercase().contains(&query_lower) {
            return true;
        }
    }

    // Search in display_label
    if let Some(ref label) = session.display_label {
        if label.to_lowercase().contains(&query_lower) {
            return true;
        }
    }

    false
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::session_directory::status::is_active_status;
    use crate::agent_sessions::session_directory::types::SessionCategory;
    use core_types::key_source::KeySource;

    fn make_session(
        id: &str,
        status: &str,
        category: SessionCategory,
        key_source: KeySource,
    ) -> SessionAggregateRecord {
        let name = format!("Session {}", id);
        SessionAggregateRecord {
            session_id: id.to_string(),
            name: name.clone(),
            status: status.to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T01:00:00Z".to_string(),
            category,
            external_history_source: None,
            user_input: None,
            repo_path: None,
            repo_root_path: None,
            repo_remote_urls: None,
            storage_path: None,
            repo_name: None,
            branch: None,
            model: Some("gpt-4".to_string()),
            account_id: None,
            cli_agent_type: None,
            key_source,
            tier: None,
            pid: None,
            total_tokens: 1000,
            worktree_path: None,
            worktree_branch: None,
            base_branch: None,
            merge_status: None,
            background: false,
            org_id: None,
            project_id: None,
            project_name: None,
            project_slug: None,
            work_item_id: None,
            agent_role: None,
            is_active: is_active_status(status),
            display_label: generate_display_label(&name, None),
            parent_session_id: None,
            org_member_id: None,
            agent_org_id: None,
            agent_org_name: None,
            agent_definition_id: None,
            agent_icon_id: None,
            agent_display_name: None,
            agent_exec_mode: None,
            draft_text: None,
            reply_target_event_id: None,
            pinned: false,
            files_changed: None,
            lines_added: None,
            lines_removed: None,
            touched_files: None,
        }
    }

    // ========================================================================
    // Display Label Tests
    // ========================================================================

    #[test]
    fn test_generate_display_label_from_name() {
        let label = generate_display_label("My Custom Session", None);
        assert_eq!(label, Some("My Custom Session".to_string()));
    }

    #[test]
    fn test_generate_display_label_from_user_input() {
        let label = generate_display_label("New Session", Some("Fix the login bug"));
        assert_eq!(label, Some("Fix the login bug".to_string()));
    }

    #[test]
    fn test_generate_display_label_truncates_long_text() {
        let long_name = "A".repeat(50);
        let label = generate_display_label(&long_name, None);
        assert_eq!(
            label.as_ref().map(|s| s.len()),
            Some(MAX_DISPLAY_LABEL_LENGTH)
        );
    }

    #[test]
    fn test_generate_display_label_utf8_safe_on_multibyte_user_input() {
        let cjk = "看".repeat(40);
        let label = generate_display_label("New Session", Some(&cjk));
        assert!(label.is_some());
        let label = label.unwrap();
        assert!(
            label.chars().count() <= MAX_DISPLAY_LABEL_LENGTH,
            "label must truncate by char count, not byte index"
        );
    }

    #[test]
    fn test_generate_display_label_strips_pill_references() {
        let label = generate_display_label("New Session", Some("Fix @file.ts and @folder/ issues"));
        assert_eq!(label, Some("Fix and issues".to_string()));
    }

    #[test]
    fn test_generate_display_label_empty_returns_none() {
        let label = generate_display_label("New Session", None);
        assert!(label.is_none());
    }

    #[test]
    fn test_strip_pill_references_basic() {
        assert_eq!(strip_pill_references("Hello @world"), "Hello");
        assert_eq!(strip_pill_references("@start middle @end"), "middle");
        assert_eq!(strip_pill_references("No pills here"), "No pills here");
    }

    #[test]
    fn test_strip_pill_references_with_paths() {
        assert_eq!(strip_pill_references("Fix @src/utils.ts bug"), "Fix bug");
        assert_eq!(
            strip_pill_references("Update @components/Button.tsx"),
            "Update"
        );
    }

    // ========================================================================
    // Text Search Tests
    // ========================================================================

    #[test]
    fn test_matches_text_query_in_name() {
        let session = make_session("1", "running", SessionCategory::Cli, KeySource::OwnKey);
        // Default name from make_session is "Session {id}"
        assert!(matches_text_query(&session, "Session"));
        assert!(matches_text_query(&session, "session")); // Case insensitive
        assert!(!matches_text_query(&session, "nonexistent"));
    }

    #[test]
    fn test_matches_text_query_in_user_input() {
        let mut session = make_session("1", "running", SessionCategory::Cli, KeySource::OwnKey);
        session.user_input = Some("Fix the authentication bug".to_string());

        assert!(matches_text_query(&session, "authentication"));
        assert!(matches_text_query(&session, "AUTH")); // Case insensitive
        assert!(!matches_text_query(&session, "database"));
    }

    #[test]
    fn test_matches_text_query_in_repo_name() {
        let mut session = make_session("1", "running", SessionCategory::Cli, KeySource::OwnKey);
        session.repo_name = Some("my-awesome-project".to_string());

        assert!(matches_text_query(&session, "awesome"));
        assert!(matches_text_query(&session, "MY-AWESOME")); // Case insensitive
    }

    #[test]
    fn test_matches_text_query_in_display_label() {
        let mut session = make_session("1", "running", SessionCategory::Cli, KeySource::OwnKey);
        session.display_label = Some("Important Task".to_string());

        assert!(matches_text_query(&session, "important"));
        assert!(matches_text_query(&session, "TASK"));
    }
}

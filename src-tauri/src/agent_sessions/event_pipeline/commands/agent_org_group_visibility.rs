//! Backend-authoritative visibility boundary between the ordinary
//! Coordinator Session and the bounded Team Group projection.

use std::collections::HashSet;

use crate::agent_sessions::event_pipeline::types::SessionEvent;

fn is_authoritative_user_turn_boundary(event: &SessionEvent) -> bool {
    if !matches!(event.function_name.as_str(), "user_message" | "user") {
        return false;
    }
    let synthetic = event
        .result
        .get("syntheticUserInput")
        .and_then(serde_json::Value::as_bool)
        == Some(true);
    let authoritative_direct = event
        .result
        .get("agentOrgDirectSource")
        .and_then(serde_json::Value::as_bool)
        == Some(true);
    !synthetic || authoritative_direct
}

pub(super) fn group_root_source_event_ids(session_id: &str) -> Result<HashSet<String>, String> {
    agent_core::coordination::group_root_source_event_ids_for_session(session_id)
}

/// Removes complete GroupRoot rounds from a generic Session history. Round
/// ownership begins at the exact typed source event and ends at the next
/// authoritative user boundary; no content, timestamp, name, or reply
/// adjacency is interpreted.
pub(super) fn retain_ordinary_session_events(
    events: &mut Vec<SessionEvent>,
    group_root_source_ids: &HashSet<String>,
) {
    if events.is_empty() || group_root_source_ids.is_empty() {
        return;
    }
    let mut group_round = false;
    events.retain(|event| {
        if is_authoritative_user_turn_boundary(event) {
            group_round = group_root_source_ids.contains(&event.id);
        }
        !group_round
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::event_pipeline::types::{
        ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource,
    };

    fn event(id: &str, function_name: &str, source: EventSource) -> SessionEvent {
        SessionEvent {
            id: id.to_string(),
            chunk_id: None,
            session_id: "root-session".to_string(),
            created_at: "2026-08-30T00:00:00Z".to_string(),
            function_name: function_name.to_string(),
            ui_canonical: function_name.to_string(),
            action_type: "raw".to_string(),
            args: serde_json::json!({}),
            result: serde_json::json!({}),
            source,
            display_text: id.to_string(),
            display_status: EventDisplayStatus::Completed,
            display_variant: EventDisplayVariant::Message,
            activity_status: ActivityStatus::Agent,
            thread_id: None,
            process_id: None,
            call_id: None,
            file_path: None,
            command: None,
            is_delta: None,
            repo_id: None,
            repo_path: None,
            extracted: None,
            payload_refs: Vec::new(),
            shell_replay: None,
            shell_replay_bookmarks: None,
            last_extract_at: None,
        }
    }

    #[test]
    fn exact_group_root_round_is_removed_without_hiding_adjacent_root_rounds() {
        let mut events = vec![
            event("ordinary-1", "user_message", EventSource::User),
            event("ordinary-answer-1", "assistant", EventSource::Assistant),
            event("group-source", "user_message", EventSource::User),
            event("group-tool", "run_shell", EventSource::Assistant),
            event("group-answer", "assistant", EventSource::Assistant),
            event("ordinary-2", "user_message", EventSource::User),
            event("ordinary-answer-2", "assistant", EventSource::Assistant),
        ];

        retain_ordinary_session_events(&mut events, &HashSet::from(["group-source".to_string()]));

        assert_eq!(
            events
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "ordinary-1",
                "ordinary-answer-1",
                "ordinary-2",
                "ordinary-answer-2"
            ]
        );
    }

    #[test]
    fn exact_source_identity_not_matching_content_controls_visibility() {
        let mut same_words = event("ordinary", "user_message", EventSource::User);
        same_words.display_text = "same text".to_string();
        let mut group = event("group-source", "user_message", EventSource::User);
        group.display_text = "same text".to_string();
        let mut events = vec![same_words, group];

        retain_ordinary_session_events(&mut events, &HashSet::from(["group-source".to_string()]));

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "ordinary");
    }
}

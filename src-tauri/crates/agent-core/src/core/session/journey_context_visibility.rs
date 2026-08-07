//! Deterministic prompt-context visibility for persisted Journey messages.
//!
//! The projector is deliberately independent from SQLite and provider wire
//! formatting. Persistence supplies exact message/sequence memberships, then
//! the prompt boundary filters raw rows before they are reconstructed.

use std::collections::{BTreeMap, BTreeSet};

use crate::core::journey_lifecycle::{JourneyError, SessionJourney};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedContextMessage {
    pub message_id: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JourneyMessageMembership {
    pub message_id: String,
    pub sequence: u64,
    pub branch_id: String,
    pub task_id: Option<String>,
}

/// Return the exact persisted message IDs which may enter `viewer_branch_id`'s
/// provider prompt. Once a session has any Journey memberships, an unassigned
/// or sequence-mismatched row is denied rather than guessed from timestamps.
/// A session with no memberships is a legacy transcript and remains intact.
pub fn project_visible_message_ids(
    journey: &SessionJourney,
    viewer_branch_id: &str,
    messages: &[PersistedContextMessage],
    memberships: &[JourneyMessageMembership],
) -> Result<BTreeSet<String>, JourneyError> {
    if memberships.is_empty() {
        return Ok(messages
            .iter()
            .map(|message| message.message_id.clone())
            .collect());
    }

    let membership_by_id: BTreeMap<&str, &JourneyMessageMembership> = memberships
        .iter()
        .map(|membership| (membership.message_id.as_str(), membership))
        .collect();
    let mut visible = BTreeSet::new();
    for message in messages {
        let Some(membership) = membership_by_id.get(message.message_id.as_str()) else {
            continue;
        };
        if membership.sequence != message.sequence {
            continue;
        }
        if journey.can_browse_sequence(
            viewer_branch_id,
            &membership.branch_id,
            membership.sequence,
        )? {
            visible.insert(message.message_id.clone());
        }
    }
    Ok(visible)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, sequence: u64) -> PersistedContextMessage {
        PersistedContextMessage {
            message_id: id.into(),
            sequence,
        }
    }

    fn membership(id: &str, sequence: u64, branch_id: &str) -> JourneyMessageMembership {
        JourneyMessageMembership {
            message_id: id.into(),
            sequence,
            branch_id: branch_id.into(),
            task_id: None,
        }
    }

    fn journey() -> SessionJourney {
        let mut journey = SessionJourney::new("s", "main");
        journey
            .start_fork(
                0,
                "fork-a".into(),
                "task-a".into(),
                "分叉 A".into(),
                "anchor-10".into(),
                10,
            )
            .unwrap();
        journey.active_branch_id = "main".into();
        journey.active_task_id = None;
        journey
            .start_fork(
                1,
                "fork-b".into(),
                "task-b".into(),
                "分叉 B".into(),
                "anchor-10".into(),
                10,
            )
            .unwrap();
        journey.active_branch_id = "main".into();
        journey.active_task_id = None;
        journey
            .start_fork(
                2,
                "fork-c".into(),
                "task-c".into(),
                "分叉 C".into(),
                "anchor-11".into(),
                11,
            )
            .unwrap();
        journey
    }

    #[test]
    fn projector_enforces_exact_branch_and_anchor_visibility() {
        let journey = journey();
        let messages = [
            message("parent-anchor", 10),
            message("parent-future", 11),
            message("a-assistant", 12),
            message("b-tool", 12),
            message("c-tool", 12),
        ];
        let memberships = [
            membership("parent-anchor", 10, "main"),
            membership("parent-future", 11, "main"),
            membership("a-assistant", 12, "fork-a"),
            membership("b-tool", 12, "fork-b"),
            membership("c-tool", 12, "fork-c"),
        ];

        let main = project_visible_message_ids(&journey, "main", &messages, &memberships).unwrap();
        assert_eq!(main.len(), 5, "main sees all descendant forks");

        let child =
            project_visible_message_ids(&journey, "fork-a", &messages, &memberships).unwrap();
        assert!(child.contains("parent-anchor"));
        assert!(!child.contains("parent-future"));
        assert!(child.contains("a-assistant"));
        assert!(child.contains("b-tool"));
        assert!(!child.contains("c-tool"));
    }

    #[test]
    fn main_descendant_and_same_anchor_sibling_visibility_are_explicit() {
        let journey = journey();
        let messages = [
            message("main", 9),
            message("a", 12),
            message("b", 12),
            message("c", 12),
        ];
        let memberships = [
            membership("main", 9, "main"),
            membership("a", 12, "fork-a"),
            membership("b", 12, "fork-b"),
            membership("c", 12, "fork-c"),
        ];

        let main = project_visible_message_ids(&journey, "main", &messages, &memberships)
            .expect("main projection");
        assert_eq!(
            main,
            BTreeSet::from(["a".into(), "b".into(), "c".into(), "main".into()])
        );

        let child = project_visible_message_ids(&journey, "fork-a", &messages, &memberships)
            .expect("child projection");
        assert!(child.contains("b"), "same-anchor sibling stays visible");
        assert!(!child.contains("c"), "different-anchor sibling is denied");
    }

    #[test]
    fn projector_keeps_legacy_transcript_and_denies_mismatched_membership() {
        let journey = journey();
        let messages = [message("legacy", 1), message("bad", 2)];
        let legacy = project_visible_message_ids(&journey, "fork-a", &messages, &[]).unwrap();
        assert_eq!(legacy, BTreeSet::from(["bad".into(), "legacy".into()]));

        let denied = project_visible_message_ids(
            &journey,
            "fork-a",
            &messages,
            &[membership("bad", 3, "fork-a")],
        )
        .unwrap();
        assert!(denied.is_empty());
    }
}

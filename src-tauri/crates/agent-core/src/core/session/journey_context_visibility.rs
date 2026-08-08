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
/// Provider prompt visibility is intentionally stricter than user browsing.
/// The parent branch keeps only its own transcript prefix; closed/discarded
/// child transcripts are represented exclusively by reviewed capsules.
pub fn project_prompt_message_ids(
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
    let mut ancestor_cutoffs = BTreeMap::new();
    let mut branch_id = viewer_branch_id;
    loop {
        let branch = journey
            .branches
            .get(branch_id)
            .ok_or_else(|| JourneyError::UnknownBranch(branch_id.into()))?;
        if branch.parent_branch_id == branch.id {
            break;
        }
        ancestor_cutoffs.insert(branch.parent_branch_id.as_str(), branch.anchor_sequence);
        branch_id = branch.parent_branch_id.as_str();
    }

    let mut visible = BTreeSet::new();
    for message in messages {
        let Some(membership) = membership_by_id.get(message.message_id.as_str()) else {
            continue;
        };
        if membership.sequence != message.sequence {
            continue;
        }
        let allowed = membership.branch_id == viewer_branch_id
            || ancestor_cutoffs
                .get(membership.branch_id.as_str())
                .is_some_and(|cutoff| membership.sequence <= *cutoff);
        if allowed {
            visible.insert(message.message_id.clone());
        }
    }
    Ok(visible)
}

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
    fn provider_prompt_excludes_child_transcript_from_parent_and_preserves_child_prefix() {
        let journey = journey();
        let messages = [
            message("main-prefix", 9),
            message("parent-anchor", 10),
            message("parent-future", 11),
            message("child", 12),
            message("sibling", 12),
        ];
        let memberships = [
            membership("main-prefix", 9, "main"),
            membership("parent-anchor", 10, "main"),
            membership("parent-future", 11, "main"),
            membership("child", 12, "fork-a"),
            membership("sibling", 12, "fork-b"),
        ];

        let main = project_prompt_message_ids(&journey, "main", &messages, &memberships)
            .expect("main prompt projection");
        assert_eq!(
            main,
            BTreeSet::from([
                "main-prefix".into(),
                "parent-anchor".into(),
                "parent-future".into(),
            ])
        );

        let child = project_prompt_message_ids(&journey, "fork-a", &messages, &memberships)
            .expect("child prompt projection");
        assert_eq!(
            child,
            BTreeSet::from(["main-prefix".into(), "parent-anchor".into(), "child".into(),])
        );
    }

    #[test]
    fn nested_fork_prompt_preserves_each_ancestor_prefix_at_its_exact_cutoff() {
        let mut journey = SessionJourney::new("s", "main");
        journey
            .start_fork(
                0,
                "parent".into(),
                "parent-task".into(),
                "父分叉".into(),
                "main-anchor".into(),
                10,
            )
            .unwrap();
        journey.active_task_id = None;
        journey
            .start_fork(
                1,
                "child".into(),
                "child-task".into(),
                "子分叉".into(),
                "parent-anchor".into(),
                20,
            )
            .unwrap();
        let messages = [
            message("main-prefix", 9),
            message("main-after-parent-anchor", 11),
            message("parent-prefix", 19),
            message("parent-after-child-anchor", 21),
            message("child-message", 22),
        ];
        let memberships = [
            membership("main-prefix", 9, "main"),
            membership("main-after-parent-anchor", 11, "main"),
            membership("parent-prefix", 19, "parent"),
            membership("parent-after-child-anchor", 21, "parent"),
            membership("child-message", 22, "child"),
        ];

        let visible = project_prompt_message_ids(&journey, "child", &messages, &memberships)
            .expect("nested prompt projection");
        assert_eq!(
            visible,
            BTreeSet::from([
                "main-prefix".into(),
                "parent-prefix".into(),
                "child-message".into(),
            ])
        );
    }

    #[test]
    fn provider_prompt_keeps_legacy_transcript_and_denies_unknown_or_mismatched_rows() {
        let journey = journey();
        let messages = [message("legacy", 1), message("bad", 2)];
        let legacy = project_prompt_message_ids(&journey, "fork-a", &messages, &[]).unwrap();
        assert_eq!(legacy, BTreeSet::from(["bad".into(), "legacy".into()]));

        let denied = project_prompt_message_ids(
            &journey,
            "fork-a",
            &messages,
            &[membership("bad", 3, "fork-a")],
        )
        .unwrap();
        assert!(denied.is_empty());
        assert!(matches!(
            project_prompt_message_ids(
                &journey,
                "missing",
                &messages,
                &[membership("bad", 2, "main")]
            ),
            Err(JourneyError::UnknownBranch(_))
        ));
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

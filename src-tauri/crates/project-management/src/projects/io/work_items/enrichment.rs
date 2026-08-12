//! Enrich raw `WorkItemData` into `EnrichedWorkItem` with pre-resolved
//! labels, members, project, and milestone references.
//!
//! Enrichment is what the TypeScript frontend used to do: read every
//! work item, then walk the labels/members maps to turn ID lists into
//! display-ready objects. Doing it in Rust collapses 3 IPC calls into 1
//! and keeps the JS layer free of `Map`-construction boilerplate.
//!
//! The enrichment path takes a `&Option<String>` for the project name so a
//! single call can resolve N items without re-reading project metadata.
//! Batch commands (`batch_update_work_items`) reuse the same lookup-map
//! form.

use std::collections::HashMap;

use rusqlite::{params, OptionalExtension};

use super::super::helpers::{conn, map_db};
use super::super::projects::read_project_scoped;
use super::crud::{read_all_work_items_scoped_filtered, read_work_item_scoped};
use crate::projects::io::labels::read_labels;
use crate::projects::io::members::read_members;
use crate::projects::types::{
    EnrichedWorkItem, LabelEntry, MemberEntry, ProjectData, ResolvedLabel, ResolvedMilestone,
    ResolvedPerson, ResolvedProject, WorkItemData, WorkItemPartialUpdate, WorkItemReadBucket,
};

/// Default avatar/badge color when a member has no override. Mirrors
/// the legacy file-layer constant so the wire output is byte-identical.
const FALLBACK_MEMBER_COLOR: &str = "#6b7280";

/// Read all work items for a project with pre-resolved label / member /
/// project / milestone objects attached.
///
/// `slug` alone identifies the project; repo/workspace linkage lives in
/// the project metadata.
pub fn read_all_work_items_enriched(project_slug: &str) -> Result<Vec<EnrichedWorkItem>, String> {
    read_all_work_items_enriched_scoped(project_slug, None)
}

pub fn read_all_work_items_enriched_scoped(
    project_slug: &str,
    org_id: Option<&str>,
) -> Result<Vec<EnrichedWorkItem>, String> {
    read_all_work_items_enriched_scoped_filtered(project_slug, org_id, None)
}

pub fn read_all_work_items_enriched_scoped_filtered(
    project_slug: &str,
    org_id: Option<&str>,
    read_bucket: Option<WorkItemReadBucket>,
) -> Result<Vec<EnrichedWorkItem>, String> {
    let project = read_project_scoped(project_slug, org_id)?;
    let raw_items = read_all_work_items_scoped_filtered(project_slug, org_id, read_bucket)?;
    enrich_work_items_for_project(&project, raw_items)
}

pub(super) fn enrich_work_items_for_project(
    project: &ProjectData,
    raw_items: Vec<WorkItemData>,
) -> Result<Vec<EnrichedWorkItem>, String> {
    let labels = read_labels(&project.meta.id)?.labels;
    let members = read_members(&project.meta.id)?.members;
    let label_map = build_label_map(&labels);
    let member_map = build_member_map(&members);
    let project_name = Some(project.meta.name.clone());

    Ok(raw_items
        .into_iter()
        .map(|item| enrich_work_item(item, &label_map, &member_map, &project.slug, &project_name))
        .collect())
}

/// Apply a partial patch to a work item and return the enriched result
/// in one shot. This is the legacy-named entry point that
/// `WorkStation` / SDE Agent's `work_item.update` tool consume; the
/// non-enriched `super::update_work_item_partial` is a lower-level
/// building block kept around for callers that don't need lookup-map
/// resolution (e.g. orchestrator follow-ups).
pub fn update_work_item_partial_enriched(
    project_slug: &str,
    short_id: &str,
    updates: &WorkItemPartialUpdate,
) -> Result<EnrichedWorkItem, String> {
    let updated = super::atomic::update_work_item_partial(project_slug, short_id, updates)?;
    let (project_name, labels, members) =
        if let Some(updated_project_id) = updated.frontmatter.project.as_deref() {
            (
                Some(read_project_name_by_id(updated_project_id)?),
                read_labels(updated_project_id)?.labels,
                read_members(updated_project_id)?.members,
            )
        } else {
            (None, Vec::new(), Vec::new())
        };
    let label_map = build_label_map(&labels);
    let member_map = build_member_map(&members);

    Ok(enrich_work_item(
        updated,
        &label_map,
        &member_map,
        project_slug,
        &project_name,
    ))
}

/// Read one work item and return its enriched form.
///
/// Convenience wrapper for command-layer callers that previously had to
/// invoke `read_work_item` + manual label/member resolution; with this
/// helper they get the frontend-ready shape in one call.
pub fn read_work_item_enriched(
    project_slug: &str,
    short_id: &str,
) -> Result<EnrichedWorkItem, String> {
    read_work_item_enriched_scoped(project_slug, short_id, None)
}

pub fn read_work_item_enriched_scoped(
    project_slug: &str,
    short_id: &str,
    org_id: Option<&str>,
) -> Result<EnrichedWorkItem, String> {
    let project = read_project_scoped(project_slug, org_id)?;
    let project_id = project.meta.id.clone();
    let project_name = Some(project.meta.name);

    let labels = read_labels(&project_id)?.labels;
    let members = read_members(&project_id)?.members;
    let label_map = build_label_map(&labels);
    let member_map = build_member_map(&members);

    let raw = read_work_item_scoped(project_slug, short_id, org_id)?;
    Ok(enrich_work_item(
        raw,
        &label_map,
        &member_map,
        project_slug,
        &project_name,
    ))
}

/// Convert a raw `WorkItemData` into an `EnrichedWorkItem` using
/// pre-built lookup maps. Pure function — no IO. Crate-visible because
/// `batch_update_work_items` shares it.
pub(super) fn enrich_work_item(
    item: WorkItemData,
    label_map: &HashMap<String, &LabelEntry>,
    member_map: &HashMap<String, &MemberEntry>,
    _project_slug: &str,
    project_name: &Option<String>,
) -> EnrichedWorkItem {
    let fm = &item.frontmatter;

    let assignee = fm
        .assignee
        .as_ref()
        .map(|assignee_id| resolve_person(assignee_id, member_map));
    let created_by_person = fm
        .created_by
        .as_ref()
        .map(|created_by_id| resolve_person(created_by_id, member_map));

    let labels: Vec<ResolvedLabel> = fm
        .labels
        .iter()
        .map(|label_id| {
            if let Some(label) = label_map.get(label_id) {
                return ResolvedLabel {
                    id: label.id.clone(),
                    name: label.name.clone(),
                    color: label.color.clone(),
                };
            }

            ResolvedLabel {
                id: label_id.clone(),
                name: label_id.clone(),
                color: FALLBACK_MEMBER_COLOR.to_string(),
            }
        })
        .collect();

    let project = fm.project.as_ref().map(|project_id| ResolvedProject {
        id: project_id.clone(),
        name: project_name.clone().unwrap_or_default(),
    });

    // Milestone names live in a separate table; resolution is deferred
    // to the commands layer, so we mirror the empty-name contract here.
    let milestone = fm.milestone.as_ref().map(|ms_id| ResolvedMilestone {
        id: ms_id.clone(),
        name: String::new(),
    });

    EnrichedWorkItem {
        id: fm.id.clone(),
        short_id: fm.short_id.clone(),
        title: fm.title.clone(),
        body: item.body,
        filename: item.filename,

        status: fm.status.clone(),
        priority: fm.priority.clone(),
        starred: fm.starred,

        assignee,
        assignee_type: fm.assignee_type.clone(),
        labels,
        project,
        milestone,

        start_date: fm.start_date.clone(),
        target_date: fm.target_date.clone(),
        created_at: fm.created_at.clone(),
        updated_at: fm.updated_at.clone(),
        deleted_at: fm.deleted_at.clone(),
        created_by: fm.created_by.clone(),
        created_by_person,

        todos: fm.todos.clone(),
        comments: fm.comments.clone(),
        history: fm.history.clone(),
        handoff: fm.handoff.clone(),

        linked_sessions: fm.linked_sessions.clone(),
        proof_of_work: fm.proof_of_work.clone(),
        orchestrator_config: fm.orchestrator_config.clone(),
        orchestrator_state: fm.orchestrator_state.clone(),
        follow_up_items: fm.follow_up_items.clone(),
        schedule: fm.schedule.clone(),
        routine_source: fm.routine_source.clone(),
        execution_lock: fm.execution_lock.clone(),
        close_out: fm.close_out.clone(),
        work_products: fm.work_products.clone(),
    }
}

// ---------------------------------------------------------------------
// Lookup-map builders. Kept private because the only consumers are
// `read_all_work_items_enriched`, `update_work_item_partial_enriched`,
// and the batch ops — all of which live in this crate.
// ---------------------------------------------------------------------

fn resolve_person(id: &str, member_map: &HashMap<String, &MemberEntry>) -> ResolvedPerson {
    let member = member_map.get(id);
    ResolvedPerson {
        id: id.to_string(),
        name: member
            .map(|entry| entry.name.clone())
            .unwrap_or_else(|| id.to_string()),
        avatar: member.and_then(|entry| entry.avatar.clone()),
        color: FALLBACK_MEMBER_COLOR.to_string(),
    }
}

fn read_project_name_by_id(project_id: &str) -> Result<String, String> {
    let connection = conn()?;
    map_db(
        connection
            .query_row(
                "SELECT name FROM projects WHERE id = ?1",
                params![project_id],
                |row| row.get::<_, String>(0),
            )
            .optional(),
    )?
    .ok_or_else(|| format!("Project '{}' not found", project_id))
}

fn build_label_map(labels: &[LabelEntry]) -> HashMap<String, &LabelEntry> {
    labels
        .iter()
        .map(|entry| (entry.id.clone(), entry))
        .collect()
}

fn build_member_map(members: &[MemberEntry]) -> HashMap<String, &MemberEntry> {
    members
        .iter()
        .map(|entry| (entry.id.clone(), entry))
        .collect()
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
// Enrichment tests construct sparse updates incrementally for scenario readability.
mod tests {
    use super::*;
    use crate::projects::io::labels::write_labels;
    use crate::projects::io::members::write_members;
    use crate::projects::io::projects::write_project;
    use crate::projects::io::work_items::write_work_item;
    use crate::projects::types::{
        LabelsFile, MemberEntry, MembersFile, ProjectMeta, WorkItemFrontmatter,
    };
    use test_helpers::test_env;

    fn project_fixture(id: &str, name: &str) -> ProjectMeta {
        ProjectMeta {
            id: id.to_string(),
            name: name.to_string(),
            org_id: "personal-org".to_string(),
            status: "active".to_string(),
            priority: "none".to_string(),
            health: "no_updates".to_string(),
            lead: None,
            members: vec![],
            labels: vec![],
            linked_repos: vec![],
            start_date: None,
            target_date: None,
            created_at: String::new(),
            updated_at: String::new(),
            next_work_item_id: 1,
            work_item_prefix: "AAA".to_string(),
            work_item_prefix_custom: true,
            agent_defaults: None,
        }
    }

    fn work_item_fixture(id: &str, short_id: &str, title: &str) -> WorkItemFrontmatter {
        WorkItemFrontmatter {
            id: id.to_string(),
            short_id: short_id.to_string(),
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
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: None,
            starred: false,
            todos: vec![],
            comments: vec![],
            history: vec![],
            delegations: vec![],
            linked_sessions: vec![],
            handoff: None,
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

    fn seed_project_with_lookups() {
        write_project("demo", &project_fixture("p1", "Demo Project"), "", true).expect("project");
        write_labels(
            "p1",
            &LabelsFile {
                labels: vec![
                    LabelEntry {
                        id: "bug".into(),
                        name: "Bug".into(),
                        color: "#ff0000".into(),
                    },
                    LabelEntry {
                        id: "feat".into(),
                        name: "Feature".into(),
                        color: "#00ff00".into(),
                    },
                ],
            },
        )
        .expect("labels");
        write_members(
            "p1",
            &MembersFile {
                members: vec![MemberEntry {
                    id: "alice".into(),
                    name: "Alice Walker".into(),
                    email: Some("alice@example.com".into()),
                    avatar: Some("https://avatars.githubusercontent.com/u/1?v=4".into()),
                    github_username: Some("alice".into()),
                    last_commit_date: None,
                    active: true,
                }],
            },
        )
        .expect("members");
    }

    #[test]
    fn enrich_resolves_labels_to_full_objects() {
        let _sandbox = test_env::sandbox();
        seed_project_with_lookups();

        let mut fm = work_item_fixture("w1", "AAA-0001", "Triage");
        fm.labels = vec!["bug".into(), "feat".into()];
        write_work_item("demo", "AAA-0001", &fm, "").expect("write");

        let items = read_all_work_items_enriched("demo").expect("enriched");
        assert_eq!(items.len(), 1);
        let one = &items[0];
        assert_eq!(one.labels.len(), 2);
        assert_eq!(one.labels[0].name, "Bug");
        assert_eq!(one.labels[0].color, "#ff0000");
        assert_eq!(one.labels[1].name, "Feature");
    }

    #[test]
    fn enrich_keeps_unknown_label_ids_visible() {
        let _sandbox = test_env::sandbox();
        seed_project_with_lookups();

        let mut fm = work_item_fixture("w1", "AAA-0001", "T");
        fm.labels = vec!["bug".into(), "ghost-label".into()];
        write_work_item("demo", "AAA-0001", &fm, "").expect("write");

        let items = read_all_work_items_enriched("demo").expect("enriched");
        assert_eq!(items[0].labels.len(), 2);
        assert_eq!(items[0].labels[0].id, "bug");
        assert_eq!(items[0].labels[1].id, "ghost-label");
        assert_eq!(items[0].labels[1].name, "ghost-label");
        assert_eq!(items[0].labels[1].color, FALLBACK_MEMBER_COLOR);
    }

    #[test]
    fn enrich_resolves_assignee_and_falls_back_to_id_when_missing() {
        let _sandbox = test_env::sandbox();
        seed_project_with_lookups();

        let mut known = work_item_fixture("w1", "AAA-0001", "Known assignee");
        known.assignee = Some("alice".into());
        write_work_item("demo", "AAA-0001", &known, "").expect("known");

        let mut unknown = work_item_fixture("w2", "AAA-0002", "Unknown assignee");
        unknown.assignee = Some("ghost-user".into());
        write_work_item("demo", "AAA-0002", &unknown, "").expect("unknown");

        let items = read_all_work_items_enriched("demo").expect("enriched");
        // Sort by short_id so test isn't order-fragile vs updated_at.
        let mut by_short: Vec<_> = items.iter().collect();
        by_short.sort_by(|left, right| left.short_id.cmp(&right.short_id));

        let resolved_known = by_short[0].assignee.as_ref().expect("alice present");
        assert_eq!(resolved_known.id, "alice");
        assert_eq!(resolved_known.name, "Alice Walker");
        assert_eq!(
            resolved_known.avatar.as_deref(),
            Some("https://avatars.githubusercontent.com/u/1?v=4")
        );

        let resolved_unknown = by_short[1].assignee.as_ref().expect("ghost present");
        assert_eq!(resolved_unknown.id, "ghost-user");
        assert_eq!(
            resolved_unknown.name, "ghost-user",
            "unknown assignee falls back to id as name"
        );
    }

    #[test]
    fn enrich_attaches_owning_project_reference() {
        let _sandbox = test_env::sandbox();
        seed_project_with_lookups();

        let fm = work_item_fixture("w1", "AAA-0001", "Project test");
        write_work_item("demo", "AAA-0001", &fm, "").expect("write");

        let items = read_all_work_items_enriched("demo").expect("enriched");
        let project = items[0].project.as_ref().expect("project resolved");
        assert_eq!(project.id, "p1");
        assert_eq!(project.name, "Demo Project");
    }

    #[test]
    fn enrich_ignores_frontmatter_project_reference() {
        let _sandbox = test_env::sandbox();
        seed_project_with_lookups();

        let mut fm = work_item_fixture("w1", "AAA-0001", "Project test");
        fm.project = Some("ignored-extra-project".to_string());
        write_work_item("demo", "AAA-0001", &fm, "").expect("write");

        let items = read_all_work_items_enriched("demo").expect("enriched");
        let project = items[0].project.as_ref().expect("project resolved");
        assert_eq!(project.id, "p1");
        assert_eq!(project.name, "Demo Project");
    }

    #[test]
    fn enrich_milestone_returns_id_with_empty_name() {
        // Mirrors the legacy contract: milestone names need a separate
        // `read_milestones` lookup that the IO-layer enricher doesn't do
        // today; commands resolve them.
        let _sandbox = test_env::sandbox();
        seed_project_with_lookups();

        let mut fm = work_item_fixture("w1", "AAA-0001", "MS test");
        fm.milestone = Some("v1".into());
        write_work_item("demo", "AAA-0001", &fm, "").expect("write");

        let items = read_all_work_items_enriched("demo").expect("enriched");
        let ms = items[0].milestone.as_ref().expect("milestone");
        assert_eq!(ms.id, "v1");
        assert_eq!(ms.name, "");
    }

    #[test]
    fn read_all_enriched_unknown_project_errors() {
        let _sandbox = test_env::sandbox();
        let err = read_all_work_items_enriched("ghost").unwrap_err();
        assert!(err.contains("ghost"));
    }

    #[test]
    fn update_partial_enriched_returns_resolved_objects() {
        let _sandbox = test_env::sandbox();
        seed_project_with_lookups();

        let fm = work_item_fixture("w1", "AAA-0001", "Initial");
        write_work_item("demo", "AAA-0001", &fm, "").expect("seed");

        let mut updates = WorkItemPartialUpdate::default();
        updates.assignee = Some(Some("alice".into()));
        updates.labels = Some(vec!["bug".into()]);

        let result =
            update_work_item_partial_enriched("demo", "AAA-0001", &updates).expect("partial");
        assert_eq!(result.assignee.as_ref().unwrap().name, "Alice Walker");
        assert_eq!(result.labels.len(), 1);
        assert_eq!(result.labels[0].name, "Bug");
    }

    #[test]
    fn update_partial_enriched_resolves_updated_project_name() {
        let _sandbox = test_env::sandbox();
        seed_project_with_lookups();
        write_project("beta", &project_fixture("p2", "Beta Project"), "", true)
            .expect("beta project");

        let fm = work_item_fixture("w1", "AAA-0001", "Initial");
        write_work_item("demo", "AAA-0001", &fm, "").expect("seed");

        let mut updates = WorkItemPartialUpdate::default();
        updates.project = Some(Some("p2".into()));

        let result =
            update_work_item_partial_enriched("demo", "AAA-0001", &updates).expect("partial");
        let project = result.project.as_ref().expect("project");
        assert_eq!(project.id, "p2");
        assert_eq!(project.name, "Beta Project");
    }

    #[test]
    fn read_one_enriched_round_trips() {
        let _sandbox = test_env::sandbox();
        seed_project_with_lookups();

        let mut fm = work_item_fixture("w1", "AAA-0001", "Single");
        fm.assignee = Some("alice".into());
        fm.labels = vec!["feat".into()];
        write_work_item("demo", "AAA-0001", &fm, "body").expect("seed");

        let one = read_work_item_enriched("demo", "AAA-0001").expect("read one");
        assert_eq!(one.assignee.as_ref().unwrap().name, "Alice Walker");
        assert_eq!(one.labels[0].name, "Feature");
        assert_eq!(one.body, "body");
    }
}

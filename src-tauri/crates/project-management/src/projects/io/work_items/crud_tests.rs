//! Tests for the single-row CRUD entry points in `super`.

use super::*;
use crate::projects::io::projects::write_project;
use crate::projects::types::{
    LabelEntry, LabelsFile, OrchestratorConfig, ProjectMeta, WorkItemHistoryAction,
    WorkItemReadBucket, WorkItemSchedule,
};
use test_helpers::test_env;

fn project_fixture(id: &str, _slug: &str, name: &str) -> ProjectMeta {
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
        origin_session: None,
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

fn seed_project(slug: &str, id: &str) {
    let meta = project_fixture(id, slug, "Demo Project");
    write_project(slug, &meta, "", true).expect("seed project");
}

#[test]
fn write_then_read_round_trips_core_fields() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");

    let mut fm = work_item_fixture("w1", "AAA-0001", "First task");
    fm.priority = "high".to_string();
    fm.assignee = Some("alice".to_string());
    fm.assignee_type = Some("member".to_string());
    fm.starred = true;

    write_work_item("demo", "AAA-0001", &fm, "## Body\n\nhello").expect("write");

    let back = read_work_item("demo", "AAA-0001").expect("read");
    assert_eq!(back.frontmatter.id, "w1");
    assert_eq!(back.frontmatter.short_id, "AAA-0001");
    assert_eq!(back.frontmatter.title, "First task");
    assert_eq!(back.frontmatter.priority, "high");
    assert_eq!(back.frontmatter.assignee.as_deref(), Some("alice"));
    assert!(back.frontmatter.starred, "starred lives in extras");
    assert_eq!(back.body, "## Body\n\nhello");
    assert_eq!(back.frontmatter.project.as_deref(), Some("p1"));
    assert_eq!(back.filename, "AAA-0001");
}

#[test]
fn scheduled_candidate_read_skips_unrelated_work_item_payloads() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");

    let unrelated = work_item_fixture("w1", "AAA-0001", "Unrelated");
    write_work_item("demo", "AAA-0001", &unrelated, "large body").expect("write unrelated");

    let mut start_dated = work_item_fixture("w2", "AAA-0002", "Start dated");
    start_dated.start_date = Some("2099-01-01".to_string());
    start_dated.orchestrator_config = Some(OrchestratorConfig {
        selected_account_id: Some("account-1".to_string()),
        ..Default::default()
    });
    write_work_item("demo", "AAA-0002", &start_dated, "ignored body").expect("write start-dated");

    let mut scheduled = work_item_fixture("w3", "AAA-0003", "One shot");
    scheduled.schedule = Some(WorkItemSchedule {
        at: Some("2099-01-02T03:04:05Z".to_string()),
        cron: None,
        enabled: true,
        last_run: None,
    });
    write_work_item("demo", "AAA-0003", &scheduled, "also ignored").expect("write scheduled");

    let candidates = read_scheduled_work_item_candidates().expect("read candidates");
    assert_eq!(candidates.len(), 2);
    assert_eq!(candidates[0].project_slug, "demo");
    assert_eq!(candidates[0].short_id, "AAA-0002");
    assert_eq!(
        candidates[0]
            .orchestrator_config
            .as_ref()
            .and_then(|config| config.selected_account_id.as_deref()),
        Some("account-1")
    );
    assert_eq!(candidates[1].short_id, "AAA-0003");
    assert_eq!(
        candidates[1]
            .schedule
            .as_ref()
            .and_then(|schedule| schedule.at.as_deref()),
        Some("2099-01-02T03:04:05Z")
    );
}

#[test]
fn bucketed_reads_defer_native_completed_and_github_closed_items() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");

    for (index, status) in ["open", "in_progress", "completed", "closed"]
        .into_iter()
        .enumerate()
    {
        let short_id = format!("AAA-{:04}", index + 1);
        let mut fm = work_item_fixture(&format!("w{}", index + 1), &short_id, status);
        fm.status = status.to_string();
        write_work_item("demo", &short_id, &fm, "").expect("write fixture");
    }

    let active =
        read_all_work_items_scoped_filtered("demo", None, Some(WorkItemReadBucket::Active))
            .expect("active bucket");
    let completed =
        read_all_work_items_scoped_filtered("demo", None, Some(WorkItemReadBucket::Completed))
            .expect("completed bucket");

    let mut active_statuses = active
        .iter()
        .map(|item| item.frontmatter.status.as_str())
        .collect::<Vec<_>>();
    active_statuses.sort_unstable();
    let mut completed_statuses = completed
        .iter()
        .map(|item| item.frontmatter.status.as_str())
        .collect::<Vec<_>>();
    completed_statuses.sort_unstable();

    assert_eq!(active_statuses, ["in_progress", "open"]);
    assert_eq!(completed_statuses, ["closed", "completed"]);
}

#[test]
fn standalone_bucketed_reads_use_the_same_terminal_partition() {
    let _sandbox = test_env::sandbox();

    for (index, status) in ["open", "completed", "closed"].into_iter().enumerate() {
        let short_id = format!("ORG-{:04}", index + 1);
        let mut fm = work_item_fixture(&format!("w{}", index + 1), &short_id, status);
        fm.status = status.to_string();
        write_standalone_work_item(Some("personal-org"), &short_id, &fm, "")
            .expect("write standalone fixture");
    }

    let active =
        read_standalone_work_items_filtered(Some("personal-org"), Some(WorkItemReadBucket::Active))
            .expect("active standalone bucket");
    let completed = read_standalone_work_items_filtered(
        Some("personal-org"),
        Some(WorkItemReadBucket::Completed),
    )
    .expect("completed standalone bucket");

    assert_eq!(active.len(), 1);
    assert_eq!(active[0].frontmatter.status, "open");
    let mut completed_statuses = completed
        .iter()
        .map(|item| item.frontmatter.status.as_str())
        .collect::<Vec<_>>();
    completed_statuses.sort_unstable();
    assert_eq!(completed_statuses, ["closed", "completed"]);
}

#[test]
fn create_records_created_history_event() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");

    let fm = work_item_fixture("w1", "AAA-0001", "First task");
    write_work_item("demo", "AAA-0001", &fm, "Body").expect("write");

    let back = read_work_item("demo", "AAA-0001").expect("read");
    assert_eq!(back.frontmatter.history.len(), 1);
    assert_eq!(
        back.frontmatter.history[0].action,
        WorkItemHistoryAction::Created
    );
}

#[test]
fn delete_moves_item_to_recoverable_bin_and_restore_clears_it() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");

    let fm = work_item_fixture("w1", "AAA-0001", "First task");
    write_work_item("demo", "AAA-0001", &fm, "Body").expect("write");

    delete_work_item("demo", "AAA-0001").expect("delete");
    let deleted = read_work_item("demo", "AAA-0001").expect("read deleted");
    assert!(deleted.frontmatter.deleted_at.is_some());
    assert_eq!(
        deleted
            .frontmatter
            .history
            .last()
            .map(|event| &event.action),
        Some(&WorkItemHistoryAction::Deleted)
    );

    let restored = restore_work_item("demo", "AAA-0001").expect("restore");
    assert!(restored.frontmatter.deleted_at.is_none());
    assert_eq!(
        restored
            .frontmatter
            .history
            .last()
            .map(|event| &event.action),
        Some(&WorkItemHistoryAction::Restored)
    );
}

#[test]
fn write_then_read_derives_project_from_owning_project_id() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");

    let mut fm = work_item_fixture("w1", "AAA-0001", "Linked task");
    fm.project = Some("ignored-extra-project".to_string());
    write_work_item("demo", "AAA-0001", &fm, "").expect("write");

    let back = read_work_item("demo", "AAA-0001").expect("read");
    assert_eq!(back.frontmatter.project.as_deref(), Some("p1"));
}

#[test]
fn read_unknown_work_item_errors() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");

    let err = read_work_item("demo", "AAA-9999").unwrap_err();
    assert!(err.contains("AAA-9999"), "msg: {}", err);
}

#[test]
fn read_under_unknown_project_errors() {
    let _sandbox = test_env::sandbox();
    let err = read_work_item("ghost", "AAA-0001").unwrap_err();
    assert!(err.contains("ghost"), "msg: {}", err);
}

#[test]
fn write_replaces_label_set_each_call() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");
    // Seed labels so the FK target rows exist (we don't have FKs on
    // workitem_labels.label_id today, but tests should still mirror
    // realistic data flow).
    crate::projects::io::labels::write_labels(
        "p1",
        &LabelsFile {
            labels: vec![
                LabelEntry {
                    id: "l1".into(),
                    name: "bug".into(),
                    color: "#f00".into(),
                },
                LabelEntry {
                    id: "l2".into(),
                    name: "feat".into(),
                    color: "#0f0".into(),
                },
            ],
        },
    )
    .expect("labels");

    let mut fm = work_item_fixture("w1", "AAA-0001", "Task");
    fm.labels = vec!["l1".into(), "l2".into()];
    write_work_item("demo", "AAA-0001", &fm, "").expect("write v1");

    let v1 = read_work_item("demo", "AAA-0001").expect("read v1");
    assert_eq!(v1.frontmatter.labels.len(), 2);

    fm.labels = vec!["l2".into()];
    write_work_item("demo", "AAA-0001", &fm, "").expect("write v2");

    let v2 = read_work_item("demo", "AAA-0001").expect("read v2");
    assert_eq!(v2.frontmatter.labels, vec!["l2".to_string()]);
}

#[test]
fn extras_round_trip_carries_todos_and_comments() {
    use crate::projects::types::{CommentEntry, TodoEntry};

    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");

    let mut fm = work_item_fixture("w1", "AAA-0001", "Task");
    fm.todos = vec![TodoEntry {
        id: "t1".into(),
        content: "do thing".into(),
        status: "pending".into(),
    }];
    fm.comments = vec![CommentEntry {
        id: "c1".into(),
        author: "alice".into(),
        content: "lgtm".into(),
        created_at: "2026-01-01T00:00:00Z".into(),
        mentioned_user_ids: Vec::new(),
        ..Default::default()
    }];

    write_work_item("demo", "AAA-0001", &fm, "").expect("write");

    let back = read_work_item("demo", "AAA-0001").expect("read");
    assert_eq!(back.frontmatter.todos.len(), 1);
    assert_eq!(back.frontmatter.todos[0].content, "do thing");
    assert_eq!(back.frontmatter.comments.len(), 1);
    assert_eq!(back.frontmatter.comments[0].author, "alice");
}

#[test]
fn read_all_orders_by_updated_at_desc() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");

    let fm1 = work_item_fixture("w1", "AAA-0001", "Older");
    write_work_item("demo", "AAA-0001", &fm1, "").expect("w1");
    std::thread::sleep(std::time::Duration::from_millis(5));
    let fm2 = work_item_fixture("w2", "AAA-0002", "Newer");
    write_work_item("demo", "AAA-0002", &fm2, "").expect("w2");

    let items = read_all_work_items("demo").expect("list");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].frontmatter.id, "w2", "newest first");
    assert_eq!(items[1].frontmatter.id, "w1");
}

#[test]
fn delete_marks_row_deleted_and_preserves_durable_extras() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");

    let mut fm = work_item_fixture("w1", "AAA-0001", "Task");
    fm.starred = true;
    write_work_item("demo", "AAA-0001", &fm, "body").expect("write");

    delete_work_item("demo", "AAA-0001").expect("delete");

    let deleted = read_work_item("demo", "AAA-0001").expect("read deleted");
    assert!(deleted.frontmatter.deleted_at.is_some());
    assert!(deleted.frontmatter.starred);

    let connection = conn().expect("conn");
    let extras_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM workitem_extras WHERE work_item_id = 'w1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        extras_count, 1,
        "soft-delete should preserve durable extras"
    );
}

#[test]
fn delete_unknown_work_item_errors() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");
    let err = delete_work_item("demo", "AAA-9999").unwrap_err();
    assert!(err.contains("AAA-9999"));
}

#[test]
fn allocate_short_id_increments_counter_and_skips_used_numbers() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");

    let id1 = allocate_short_id("demo").expect("alloc 1");
    assert_eq!(id1, "AAA-0001");

    // Plant a higher-numbered work item to simulate an out-of-band
    // insert; the next allocator must skip past it.
    let fm = work_item_fixture("w-manual", "AAA-0010", "Manual");
    write_work_item("demo", "AAA-0010", &fm, "").expect("manual");
    let id2 = allocate_short_id("demo").expect("alloc 2");
    assert_eq!(
        id2, "AAA-0011",
        "should skip past max existing, not reuse AAA-0002"
    );

    let id3 = allocate_short_id("demo").expect("alloc 3");
    assert_eq!(id3, "AAA-0012");
}

#[test]
fn allocate_short_id_skips_same_prefix_across_projects() {
    let _sandbox = test_env::sandbox();
    seed_project("alpha", "pa");
    write_project("beta", &project_fixture("pb", "beta", "Beta"), "", true).expect("seed beta");

    let alpha_id = allocate_short_id("alpha").expect("alloc alpha");
    assert_eq!(alpha_id, "AAA-0001");
    let alpha_fm = work_item_fixture(&alpha_id, &alpha_id, "Alpha task");
    write_work_item("alpha", &alpha_id, &alpha_fm, "").expect("write alpha");

    let beta_id = allocate_short_id("beta").expect("alloc beta");
    assert_eq!(
        beta_id, "AAA-0002",
        "workitems.id is global, so shared prefixes must not collide across projects"
    );
    let beta_fm = work_item_fixture(&beta_id, &beta_id, "Beta task");
    write_work_item("beta", &beta_id, &beta_fm, "").expect("write beta");

    assert_eq!(read_all_work_items("alpha").expect("alpha items").len(), 1);
    assert_eq!(read_all_work_items("beta").expect("beta items").len(), 1);
}

#[test]
fn allocate_short_id_skips_same_prefix_across_orgs() {
    let _sandbox = test_env::sandbox();
    seed_project("alpha", "pa");
    let alpha_id = allocate_short_id("alpha").expect("alloc alpha");
    assert_eq!(alpha_id, "AAA-0001");
    let alpha_fm = work_item_fixture(&alpha_id, &alpha_id, "Alpha task");
    write_work_item("alpha", &alpha_id, &alpha_fm, "").expect("write alpha");

    crate::projects::io::create_project_org(&crate::projects::types::CreateProjectOrgRequest {
        name: "Other Org".to_string(),
        id: Some("other-org".to_string()),
    })
    .expect("create org");
    let mut beta = project_fixture("pb", "beta", "Beta");
    beta.org_id = "other-org".to_string();
    write_project("beta", &beta, "", true).expect("seed beta");

    let beta_id = allocate_short_id("beta").expect("alloc beta");
    assert_eq!(
        beta_id, "AAA-0002",
        "workitems.id is global, so shared prefixes must not collide across orgs"
    );
    let beta_fm = work_item_fixture(&beta_id, &beta_id, "Beta task");
    write_work_item("beta", &beta_id, &beta_fm, "").expect("write beta");
}

#[test]
fn allocate_short_id_unknown_project_errors() {
    let _sandbox = test_env::sandbox();
    let err = allocate_short_id("ghost").unwrap_err();
    assert!(err.contains("ghost"), "msg: {}", err);
}

#[test]
fn move_work_item_changes_project_id() {
    let _sandbox = test_env::sandbox();
    seed_project("alpha", "pa");
    write_project("beta", &project_fixture("pb", "beta", "Beta"), "", true).expect("seed beta");

    let fm = work_item_fixture("w1", "AAA-0001", "Migratory");
    write_work_item("alpha", "AAA-0001", &fm, "").expect("write");

    move_work_item("AAA-0001", "alpha", "beta").expect("move");

    let from_alpha = read_work_item("alpha", "AAA-0001").unwrap_err();
    assert!(from_alpha.contains("AAA-0001"));
    let in_beta = read_work_item("beta", "AAA-0001").expect("read at dest");
    assert_eq!(in_beta.frontmatter.id, "w1");
    assert_eq!(in_beta.frontmatter.project.as_deref(), Some("pb"));
}

#[test]
fn move_work_item_rejects_destination_collision() {
    let _sandbox = test_env::sandbox();
    seed_project("alpha", "pa");
    write_project("beta", &project_fixture("pb", "beta", "Beta"), "", true).expect("seed beta");

    let fm_a = work_item_fixture("w1", "AAA-0001", "from alpha");
    write_work_item("alpha", "AAA-0001", &fm_a, "").expect("write alpha");
    let fm_b = work_item_fixture("w2", "AAA-0001", "already in beta");
    write_work_item("beta", "AAA-0001", &fm_b, "").expect("write beta");

    let err = move_work_item("AAA-0001", "alpha", "beta").unwrap_err();
    assert!(err.contains("already exists"), "msg: {}", err);

    let still_at_source = read_work_item("alpha", "AAA-0001").expect("source intact");
    assert_eq!(still_at_source.frontmatter.id, "w1");
}

#[test]
fn upsert_preserves_created_at_on_second_write() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");

    let mut fm = work_item_fixture("w1", "AAA-0001", "Task");
    fm.created_at = "2026-01-01T00:00:00+00:00".to_string();
    write_work_item("demo", "AAA-0001", &fm, "").expect("write 1");

    // Don't reset created_at — we want the second write to round-trip it
    // from the wire, mirroring how the frontend always sends the existing
    // created_at back on update.
    std::thread::sleep(std::time::Duration::from_millis(5));
    write_work_item("demo", "AAA-0001", &fm, "v2").expect("write 2");

    let back = read_work_item("demo", "AAA-0001").expect("read");
    assert!(
        back.frontmatter.created_at.starts_with("2026-01-01"),
        "created_at preserved: {}",
        back.frontmatter.created_at
    );
    assert_eq!(back.body, "v2");
}

/// Whole-row writes (create / delete / restore / batch /
/// git-folder-sync) must not wipe the sync-side metadata that only the
/// atomic RMW path used to preserve — and a local whole-row edit must
/// stamp the fields it actually changed so peers' per-field resolvers
/// see it as newer.
#[test]
fn whole_row_write_preserves_sync_metadata_and_stamps_changed_fields() {
    use crate::projects::io::{apply_remote_merge, read_sync_metadata, FieldRevision};

    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");
    write_work_item(
        "demo",
        "AAA-0001",
        &work_item_fixture("w1", "AAA-0001", "Task"),
        "body",
    )
    .expect("create");

    // Simulate a prior sync: adapter watermark + external ref.
    let mut revisions = std::collections::HashMap::new();
    revisions.insert(
        "title".to_string(),
        FieldRevision {
            mtime: 1_111,
            source: "linear".to_string(),
        },
    );
    apply_remote_merge(
        "demo",
        "AAA-0001",
        revisions,
        Some(("linear".to_string(), "EXT-9".to_string())),
    )
    .expect("stamp");

    // Whole-row rewrite that changes ONLY status.
    let mut item = read_work_item("demo", "AAA-0001").expect("read");
    item.frontmatter.status = "in_progress".to_string();
    write_work_item("demo", "AAA-0001", &item.frontmatter, &item.body).expect("whole-row write");

    let metadata = read_sync_metadata("demo", "AAA-0001")
        .expect("metadata read")
        .expect("item exists");
    assert_eq!(
        metadata.field_revisions.get("title"),
        Some(&FieldRevision {
            mtime: 1_111,
            source: "linear".to_string(),
        }),
        "untouched field keeps its pre-write watermark"
    );
    let status_revision = metadata
        .field_revisions
        .get("status")
        .expect("changed field stamped");
    assert_eq!(status_revision.source, "local");
    assert!(status_revision.mtime > 1_111);
    assert_eq!(
        metadata.external_refs.get("linear").map(String::as_str),
        Some("EXT-9"),
        "external refs survive the whole-row write"
    );

    // The delete-bin round trip is the original data-loss path.
    delete_work_item("demo", "AAA-0001").expect("delete");
    restore_work_item("demo", "AAA-0001").expect("restore");
    let metadata = read_sync_metadata("demo", "AAA-0001")
        .expect("metadata read")
        .expect("item exists");
    assert_eq!(
        metadata.field_revisions.get("title"),
        Some(&FieldRevision {
            mtime: 1_111,
            source: "linear".to_string(),
        }),
        "delete + restore must not wipe watermarks"
    );
    assert_eq!(
        metadata.external_refs.get("linear").map(String::as_str),
        Some("EXT-9")
    );
}

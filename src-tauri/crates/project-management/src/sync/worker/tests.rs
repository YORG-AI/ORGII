//! These tests drive the worker logic against an in-memory DB. The
//! real worker uses `io::conn()` (which opens the on-disk
//! `projects.db`); to keep tests hermetic we go through the public
//! `push_cycle` entry point with the global pool pointed at a
//! sandboxed `ORGII_HOME` (set up by `test_env::sandbox`).

use super::*;
use crate::sync::adapter::{
    AdapterDescriptor, EntityField, FieldMap, FieldMapping, SyncAdapter, SyncContext as Ctx,
    SyncOutcome,
};
use crate::sync::adapters as registry;
use crate::sync::types::{EntityType, OutboxEntry as Entry, OutboxOp, OutboxStatus, SyncError};
use async_trait::async_trait;
use test_helpers::test_env;

fn sample_entry(slug: &str) -> Entry {
    Entry {
        id: None,
        project_slug: slug.to_string(),
        entity_type: EntityType::WorkItem,
        entity_id: "WI-1".to_string(),
        op: OutboxOp::Update,
        field_path: Some("title".to_string()),
        payload_json: r#"{"title":"hi"}"#.to_string(),
        created_at: 1_000,
        retry_count: 0,
        last_attempted_at: None,
        last_error: None,
        status: OutboxStatus::Pending,
    }
}

/// Insert a project row with the given `sync_kind`. Used by tests
/// that need adapter routing to find a binding.
fn seed_project(conn: &rusqlite::Connection, slug: &str, sync_kind: &str) {
    let sync_connection_id = (sync_kind != "none").then(|| format!("connection-{slug}"));
    seed_project_with_connection(conn, slug, sync_kind, sync_connection_id.as_deref());
}

fn seed_project_with_connection(
    conn: &rusqlite::Connection,
    slug: &str,
    sync_kind: &str,
    sync_connection_id: Option<&str>,
) {
    conn.execute(
        "INSERT INTO projects
                (id, name, slug, short_id_prefix, created_at, updated_at, sync_kind, sync_connection_id)
             VALUES (?1, ?1, ?2, 'AAA', 0, 0, ?3, ?4)",
        rusqlite::params![format!("p-{}", slug), slug, sync_kind, sync_connection_id],
    )
    .expect("seed project");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn push_cycle_marks_echo_entry_succeeded() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project(&conn, "alpha", "echo");

    let id = io::append(&conn, &sample_entry("alpha")).expect("append");
    drop(conn);

    // EchoAdapter is registered on first registry() access.
    assert!(registry::get("echo").is_some());

    let processed = push_cycle(8).await.expect("push cycle");
    assert_eq!(processed, 1);

    let conn = io::conn().expect("reopen");
    let row = io::load_by_id(&conn, id).expect("load");
    assert_eq!(row.status, OutboxStatus::Succeeded);
    assert!(row.last_error.is_none());
}

/// A project with `sync_kind='none'` (the default) should treat any
/// queued outbox row as a no-op success — opting out of sync must
/// not back the outbox up forever.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn push_cycle_no_op_for_unbound_project() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project(&conn, "beta", "none");

    let id = io::append(&conn, &sample_entry("beta")).expect("append");
    drop(conn);

    let processed = push_cycle(8).await.expect("push cycle");
    assert_eq!(processed, 1);

    let conn = io::conn().expect("reopen");
    let row = io::load_by_id(&conn, id).expect("load");
    assert_eq!(row.status, OutboxStatus::Succeeded);
}

/// Adapter routing failure path: an outbox row for a project bound
/// to an unknown adapter id (e.g. one that was uninstalled) jumps
/// straight to Abandoned because it's a permanent error.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn push_cycle_abandons_unknown_adapter() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project(&conn, "gamma", "vanished_adapter");

    let id = io::append(&conn, &sample_entry("gamma")).expect("append");
    drop(conn);

    let processed = push_cycle(8).await.expect("push cycle");
    assert_eq!(processed, 1);

    let conn = io::conn().expect("reopen");
    let row = io::load_by_id(&conn, id).expect("load");
    assert_eq!(row.status, OutboxStatus::Abandoned);
    assert!(row
        .last_error
        .as_deref()
        .unwrap_or("")
        .contains("vanished_adapter"));
}

/// Append a `merge_external` outbox row directly (mirrors what the
/// pull cycle would do) and verify the push cycle does **not**
/// claim it — they're owned by the resolver, not the push path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_external_rows_are_not_claimed_by_push_cycle() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project(&conn, "alpha", "echo");
    let mut row = sample_entry("alpha");
    row.op = OutboxOp::MergeExternal;
    let id = io::append(&conn, &row).expect("append");
    drop(conn);

    let processed = push_cycle(8).await.expect("push cycle ok");
    assert_eq!(
        processed, 0,
        "push cycle must not consume merge_external rows"
    );
    let conn = io::conn().expect("reopen");
    let loaded = io::load_by_id(&conn, id).expect("load");
    assert_eq!(loaded.status, OutboxStatus::Pending);
    assert!(loaded.last_attempted_at.is_none());
}

/// Pull cycle smoke test: a project bound to `echo` (which always
/// returns 0 changes) should still have its `sync_last_pull_at`
/// stamp advanced so the worker doesn't keep re-querying the same
/// window forever.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pull_cycle_advances_cursor_for_bound_project() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project(&conn, "alpha", "echo");
    // Sanity: cursor starts empty.
    let before = io::read_sync_cursor(&conn, "alpha").unwrap();
    assert!(before.last_pull_at.is_none());
    drop(conn);

    pull_cycle().await.expect("pull cycle");

    let conn = io::conn().expect("reopen");
    let after = io::read_sync_cursor(&conn, "alpha").unwrap();
    assert!(
        after.last_pull_at.is_some(),
        "cursor should advance after pull cycle"
    );
}

/// A project with a fresh `sync_last_webhook_at` must
/// be skipped by the pull cycle — webhook ingestion already
/// supplied the inbound changes, so polling would be wasted
/// work. The freshness gate uses
/// [`WEBHOOK_FRESHNESS_WINDOW_MS`] (10 min by default).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pull_cycle_skips_project_with_recent_webhook() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project(&conn, "alpha", "echo");
    let now = now_ms();
    conn.execute(
        "UPDATE projects SET sync_last_webhook_at = ?1 WHERE slug = 'alpha'",
        rusqlite::params![now - 60_000],
    )
    .expect("stamp webhook");
    drop(conn);

    pull_cycle().await.expect("pull cycle");

    let conn = io::conn().expect("reopen");
    let cursor = io::read_sync_cursor(&conn, "alpha").unwrap();
    assert!(
        cursor.last_pull_at.is_none(),
        "fresh-webhook project must NOT advance pull cursor"
    );
}

/// Mirror test: a project whose last webhook was *outside* the
/// freshness window falls back to polling — the gate must be
/// "fresh skips" not "any past delivery skips."
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pull_cycle_polls_project_with_stale_webhook() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project(&conn, "alpha", "echo");
    let now = now_ms();
    conn.execute(
        "UPDATE projects SET sync_last_webhook_at = ?1 WHERE slug = 'alpha'",
        rusqlite::params![now - 30 * 60_000],
    )
    .expect("stamp webhook");
    drop(conn);

    pull_cycle().await.expect("pull cycle");

    let conn = io::conn().expect("reopen");
    let cursor = io::read_sync_cursor(&conn, "alpha").unwrap();
    assert!(
        cursor.last_pull_at.is_some(),
        "stale-webhook project must fall back to polling"
    );
}

/// A runnable `import_progress` row with no cursor must drive
/// the echo adapter through page 1 → page 2 → completion across
/// two import-cycle ticks.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_cycle_walks_echo_adapter_to_completion() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project(&conn, "alpha", "echo");
    super::super::import::ensure_pending(&conn, "alpha", "echo", now_ms()).expect("ensure_pending");
    drop(conn);

    import_cycle(1).await.expect("import cycle 1");
    let conn = io::conn().expect("reopen");
    let row = super::super::import::read_status(&conn, "alpha", "echo")
        .expect("status")
        .expect("row");
    assert_eq!(row.state, super::super::types::ImportState::Running);
    assert_eq!(row.imported_count, 2);
    assert_eq!(row.page_cursor.as_deref(), Some("page2"));
    assert_eq!(row.total_hint, Some(4));
    let outbox_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM outbox_entries
                  WHERE project_slug = 'alpha' AND op = 'merge_external'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(outbox_count, 2);
    drop(conn);

    import_cycle(1).await.expect("import cycle 2");
    let conn = io::conn().expect("reopen2");
    let row = super::super::import::read_status(&conn, "alpha", "echo")
        .expect("status2")
        .expect("row2");
    assert_eq!(row.state, super::super::types::ImportState::Completed);
    assert_eq!(row.imported_count, 4);
    assert!(row.page_cursor.is_none());
    let outbox_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM outbox_entries
                  WHERE project_slug = 'alpha' AND op = 'merge_external'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(outbox_count, 4);
}

/// A row already in `completed` must be ignored by the import
/// cycle — re-attaching the adapter does not re-import.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_cycle_skips_completed_rows() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project(&conn, "alpha", "echo");
    super::super::import::ensure_pending(&conn, "alpha", "echo", now_ms()).unwrap();
    super::super::import::mark_completed(&conn, "alpha", "echo", now_ms()).unwrap();
    drop(conn);

    import_cycle(8).await.expect("import cycle");

    let conn = io::conn().expect("reopen");
    let outbox_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM outbox_entries
                  WHERE project_slug = 'alpha' AND op = 'merge_external'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(outbox_count, 0);
}

/// `max_pages_per_project = 0` is a no-op — guard rail for the
/// run-loop wiring so a misconfigured `LoopConfig` doesn't burn
/// the SQLite connection on every tick.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_cycle_respects_zero_pages_cap() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project(&conn, "alpha", "echo");
    super::super::import::ensure_pending(&conn, "alpha", "echo", now_ms()).unwrap();
    drop(conn);

    import_cycle(0).await.expect("import cycle");

    let conn = io::conn().expect("reopen");
    let row = super::super::import::read_status(&conn, "alpha", "echo")
        .expect("status")
        .expect("row");
    assert_eq!(row.state, super::super::types::ImportState::Pending);
    assert_eq!(row.imported_count, 0);
}

/// Unbound project (`sync_kind='none'`) should not appear in the
/// pull cycle's project list and its cursor must stay untouched.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pull_cycle_skips_unbound_project() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project(&conn, "beta", "none");
    drop(conn);

    pull_cycle().await.expect("pull cycle");

    let conn = io::conn().expect("reopen");
    let cursor = io::read_sync_cursor(&conn, "beta").unwrap();
    assert!(cursor.last_pull_at.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn push_cycle_handles_empty_outbox() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    drop(conn);

    let processed = push_cycle(8).await.expect("push cycle");
    assert_eq!(processed, 0);
}

/// Drives the failure path by routing through an inline failing
/// adapter. We can't swap the registry mid-process, so this test
/// exercises `finalize_failure` + the IO retry/backoff transitions
/// directly — same code path the worker uses on push errors.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn finalize_failure_walks_to_abandoned() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_outbox_table(&conn).expect("init outbox");
    let id = io::append(&conn, &sample_entry("alpha")).expect("append");
    drop(conn);

    // 5 retryable failures should walk pending → pending → … → abandoned.
    for _ in 0..5 {
        finalize_failure(id, "boom", true).await.expect("fail ok");
    }
    let conn = io::conn().expect("reopen");
    let row = io::load_by_id(&conn, id).expect("load");
    assert_eq!(row.status, OutboxStatus::Abandoned);
    assert_eq!(row.retry_count, 5);
    assert_eq!(row.last_error.as_deref(), Some("boom"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn finalize_failure_non_retryable_abandons_immediately() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_outbox_table(&conn).expect("init outbox");
    let id = io::append(&conn, &sample_entry("alpha")).expect("append");
    drop(conn);

    finalize_failure(id, "auth bad", false)
        .await
        .expect("fail ok");
    let conn = io::conn().expect("reopen");
    let row = io::load_by_id(&conn, id).expect("load");
    assert_eq!(row.status, OutboxStatus::Abandoned);
    assert_eq!(row.last_error.as_deref(), Some("auth bad"));
}

/// A locally-defined failing adapter for unit-level checks. Not
/// registered in the global registry — exists so the trait surface
/// is exercised end-to-end at compile time even before 4.2 lands a
/// real network adapter.
#[derive(Default)]
struct AlwaysFailAdapter;

static FAIL_MAP: FieldMap = FieldMap {
    mappings: &[FieldMapping {
        local: EntityField::Title,
        remote: "title",
        writable: true,
    }],
};

#[async_trait]
impl SyncAdapter for AlwaysFailAdapter {
    fn name(&self) -> &'static str {
        "always_fail"
    }
    async fn push(&self, _entry: &Entry, _ctx: &Ctx) -> crate::sync::types::SyncResult {
        Err(SyncError::Transient("simulated failure".into()))
    }
    async fn pull(
        &self,
        _project_slug: &str,
        _ctx: &Ctx,
        _since: Option<chrono::DateTime<chrono::Utc>>,
    ) -> Result<crate::sync::adapter::PullOutcome, SyncError> {
        Ok(crate::sync::adapter::PullOutcome::default())
    }
    fn entity_field_map(&self) -> &'static FieldMap {
        &FAIL_MAP
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            id: self.name().to_string(),
            label: "always-fail (test)".into(),
            requires_auth: false,
            auth_methods: Vec::new(),
            supports_webhook: false,
            supports_import: false,
        }
    }
}

#[tokio::test]
async fn always_fail_adapter_returns_transient_error() {
    let entry = Entry {
        id: Some(1),
        ..sample_entry("alpha")
    };
    let ctx = Ctx {
        adapter_id: "always_fail".into(),
        auth_token: None,
        project_slug: "alpha".into(),
        cursor_blob: None,
        config_json: None,
    };
    let err = AlwaysFailAdapter.push(&entry, &ctx).await.unwrap_err();
    assert!(err.is_retryable());
}

/// Sanity test for the `outcome` field plumbing.
#[test]
fn sync_outcome_serializes() {
    let outcome = SyncOutcome {
        external_id: Some("abc".into()),
        remote_updated_at: None,
    };
    let json = serde_json::to_string(&outcome).unwrap();
    assert!(json.contains("\"external_id\":\"abc\""));
}

// ---- merge cycle + GC ----

use crate::projects::io::{
    apply_remote_merge as md_apply, read_sync_metadata as md_read, read_work_item, write_project,
    write_work_item, FieldRevision,
};
use crate::projects::types::{ProjectMeta, WorkItemFrontmatter};
use crate::sync::adapter::ExternalChange;
use chrono::{TimeZone, Utc};
use std::collections::HashMap;

fn project_meta(slug: &str, sync_kind: Option<&str>) -> ProjectMeta {
    // ProjectMeta itself doesn't carry sync_kind — that's on the
    // `storys` row. write_project handles inserting the row;
    // we use the helper below to set sync_kind afterwards.
    let _ = sync_kind;
    ProjectMeta {
        id: format!("p_{}", slug),
        name: slug.to_string(),
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

fn wi_fm(short_id: &str, title: &str, status: &str) -> WorkItemFrontmatter {
    WorkItemFrontmatter {
        id: format!("w_{}", short_id),
        short_id: short_id.to_string(),
        title: title.to_string(),
        project: None,
        status: status.to_string(),
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

fn set_sync_kind(slug: &str, kind: &str) {
    let conn = io::conn().expect("conn");
    let sync_connection_id = (kind != "none").then(|| format!("connection-{slug}"));
    conn.execute(
        "UPDATE projects SET sync_kind = ?1, sync_connection_id = ?2 WHERE slug = ?3",
        rusqlite::params![kind, sync_connection_id, slug],
    )
    .expect("set sync_kind");
}

fn merge_entry(slug: &str, change: &ExternalChange) -> Entry {
    Entry {
        id: None,
        project_slug: slug.to_string(),
        entity_type: EntityType::WorkItem,
        entity_id: change.external_id.clone(),
        op: OutboxOp::MergeExternal,
        field_path: None,
        payload_json: serde_json::to_string(change).expect("encode change"),
        created_at: 1_000,
        retry_count: 0,
        last_attempted_at: None,
        last_error: None,
        status: OutboxStatus::Pending,
    }
}

/// Inbound merge_external row whose external_id has no local
/// binding triggers an inbound create: a fresh short_id is
/// allocated, a work item is materialized from the change.fields,
/// and the external_ref + per-field watermarks are stamped so the
/// next merge can identity-match.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_cycle_creates_local_item_for_unbound_external_id() {
    let _sandbox = test_env::sandbox();
    write_project("alpha", &project_meta("alpha", None), "", true).expect("write project");
    set_sync_kind("alpha", "echo");

    let change = ExternalChange {
        entity_type: EntityType::WorkItem,
        external_id: "ext-new".to_string(),
        local_entity_id: None,
        fields: serde_json::json!({
            "title": "Inbound title",
            "body": "Inbound body",
            "status": "todo",
            "priority": "high",
            "labels": ["bug", "p1"],
        }),
        remote_updated_at: Utc.timestamp_millis_opt(1_700_000_000_000).unwrap(),
        deleted: false,
    };
    let conn = io::conn().expect("conn");
    let id = io::append(&conn, &merge_entry("alpha", &change)).expect("append");
    drop(conn);

    let processed = merge_cycle(8).await.expect("merge cycle ok");
    assert_eq!(processed, 1);

    let conn = io::conn().expect("reopen");
    let row = io::load_by_id(&conn, id).expect("load");
    assert_eq!(row.status, OutboxStatus::Succeeded);
    assert!(
        row.last_error.is_none(),
        "create-from-remote should not record a deferral note"
    );
    drop(conn);

    // The newly-created item is reachable by external_id, the
    // payload fields landed, and the watermarks are stamped from
    // the adapter source at remote_updated_at.
    let short_id = crate::projects::io::find_by_external_ref("alpha", "echo", "ext-new")
        .expect("lookup")
        .expect("expected a freshly created local short_id");

    let wi = read_work_item("alpha", &short_id).expect("read wi");
    assert_eq!(wi.frontmatter.title, "Inbound title");
    assert_eq!(wi.body, "Inbound body");
    assert_eq!(wi.frontmatter.status, "todo");
    assert_eq!(wi.frontmatter.priority, "high");
    assert_eq!(
        wi.frontmatter.labels,
        vec!["bug".to_string(), "p1".to_string()]
    );

    let metadata = md_read("alpha", &short_id).expect("read md").unwrap();
    assert_eq!(
        metadata.external_refs.get("echo").map(String::as_str),
        Some("ext-new")
    );
    assert_eq!(metadata.field_revisions["title"].source, "echo");
    assert_eq!(metadata.field_revisions["title"].mtime, 1_700_000_000_000);
    assert_eq!(metadata.field_revisions["body"].source, "echo");
    assert_eq!(metadata.field_revisions["status"].source, "echo");
    assert_eq!(metadata.field_revisions["priority"].source, "echo");
    assert_eq!(metadata.field_revisions["labels"].source, "echo");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_cycle_uses_github_issue_number_as_the_short_id() {
    let _sandbox = test_env::sandbox();
    write_project("alpha", &project_meta("alpha", None), "", true).expect("write project");
    set_sync_kind("alpha", "github");

    let change = ExternalChange {
        entity_type: EntityType::WorkItem,
        external_id: "210".to_string(),
        local_entity_id: None,
        fields: serde_json::json!({
            "title": "GitHub issue",
            "body": "Imported from GitHub",
            "status": "open",
        }),
        remote_updated_at: Utc.timestamp_millis_opt(1_700_000_000_000).unwrap(),
        deleted: false,
    };
    let conn = io::conn().expect("conn");
    io::append(&conn, &merge_entry("alpha", &change)).expect("append");
    drop(conn);

    merge_cycle(8).await.expect("merge cycle ok");

    let short_id = crate::projects::io::find_by_external_ref("alpha", "github", "210")
        .expect("lookup")
        .expect("GitHub issue should be bound");
    assert_eq!(short_id, "210");

    let work_item = read_work_item("alpha", "210").expect("read GitHub issue");
    assert_eq!(work_item.frontmatter.short_id, "210");
    assert_eq!(work_item.frontmatter.title, "GitHub issue");
    assert_ne!(
        work_item.frontmatter.id, "210",
        "the private row id must remain distinct and globally unique"
    );
}

#[test]
fn boot_normalization_replaces_legacy_github_short_ids() {
    let _sandbox = test_env::sandbox();
    write_project("alpha", &project_meta("alpha", None), "", true).expect("write project");
    set_sync_kind("alpha", "github");
    let frontmatter = wi_fm("ORG-0210", "Legacy GitHub issue", "open");
    write_work_item("alpha", "ORG-0210", &frontmatter, "").expect("seed work item");
    md_apply(
        "alpha",
        "ORG-0210",
        HashMap::new(),
        Some(("github".to_string(), "210".to_string())),
    )
    .expect("bind GitHub issue");

    let normalized = super::identity::normalize_existing_external_short_ids()
        .expect("normalize external short ids");
    assert_eq!(normalized, 1);
    assert!(read_work_item("alpha", "ORG-0210").is_err());
    assert_eq!(
        read_work_item("alpha", "210")
            .expect("read normalized issue")
            .frontmatter
            .id,
        "w_ORG-0210",
        "renaming must not change the stable internal row id"
    );
}

/// An inbound delete for an external_id that was never seen
/// locally (created and removed remotely before our first pull)
/// is a silent no-op — the row is finalized Succeeded with no
/// breadcrumb and nothing is materialized locally.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_cycle_no_op_for_inbound_delete_with_no_binding() {
    let _sandbox = test_env::sandbox();
    write_project("alpha", &project_meta("alpha", None), "", true).expect("write project");
    set_sync_kind("alpha", "echo");

    let change = ExternalChange {
        entity_type: EntityType::WorkItem,
        external_id: "ext-ghost".to_string(),
        local_entity_id: None,
        fields: serde_json::json!({}),
        remote_updated_at: Utc.timestamp_millis_opt(1_700_000_000_000).unwrap(),
        deleted: true,
    };
    let conn = io::conn().expect("conn");
    let id = io::append(&conn, &merge_entry("alpha", &change)).expect("append");
    drop(conn);

    merge_cycle(8).await.expect("merge cycle ok");

    let conn = io::conn().expect("reopen");
    let row = io::load_by_id(&conn, id).expect("load");
    assert_eq!(row.status, OutboxStatus::Succeeded);
    assert!(row.last_error.is_none());
    drop(conn);

    // No work item was created.
    let lookup =
        crate::projects::io::find_by_external_ref("alpha", "echo", "ext-ghost").expect("lookup");
    assert!(
        lookup.is_none(),
        "no local item should exist for a no-op delete"
    );
}

/// Happy-path merge: a never-seen field on a bound work item is
/// adopted, the partial update lands on the row, the revision
/// watermark is stamped, and the external_ref is recorded so the
/// next merge can identity-match.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_cycle_adopts_remote_value_for_unsynced_field() {
    let _sandbox = test_env::sandbox();
    write_project("alpha", &project_meta("alpha", None), "", true).expect("write project");
    set_sync_kind("alpha", "echo");
    write_work_item(
        "alpha",
        "AAA-0001",
        &wi_fm("AAA-0001", "Old title", "backlog"),
        "",
    )
    .expect("write wi");

    // First merge: identity not yet bound, so the resolver looks
    // up via external_refs and finds nothing — but the test wants
    // the happy path, so we pre-bind by stamping the external_ref.
    md_apply(
        "alpha",
        "AAA-0001",
        HashMap::new(),
        Some(("echo".to_string(), "ext-1".to_string())),
    )
    .expect("pre-bind");

    let change = ExternalChange {
        entity_type: EntityType::WorkItem,
        external_id: "ext-1".to_string(),
        local_entity_id: None,
        fields: serde_json::json!({ "title": "Remote title", "status": "todo" }),
        remote_updated_at: Utc.timestamp_millis_opt(1_700_000_000_000).unwrap(),
        deleted: false,
    };
    let conn = io::conn().expect("conn");
    let id = io::append(&conn, &merge_entry("alpha", &change)).expect("append");
    drop(conn);

    let processed = merge_cycle(8).await.expect("merge cycle ok");
    assert_eq!(processed, 1);

    // The row is succeeded, the work item was updated, the
    // watermarks are stamped.
    let conn = io::conn().expect("reopen");
    let row = io::load_by_id(&conn, id).expect("load");
    assert_eq!(row.status, OutboxStatus::Succeeded);
    assert!(row.last_error.is_none());
    drop(conn);

    let wi = read_work_item("alpha", "AAA-0001").expect("read wi");
    assert_eq!(wi.frontmatter.title, "Remote title");
    assert_eq!(wi.frontmatter.status, "todo");

    let metadata = md_read("alpha", "AAA-0001").expect("read md").unwrap();
    assert_eq!(metadata.field_revisions["title"].source, "echo");
    assert_eq!(metadata.field_revisions["title"].mtime, 1_700_000_000_000);
    assert_eq!(metadata.field_revisions["status"].source, "echo");
    assert_eq!(
        metadata.external_refs.get("echo").map(String::as_str),
        Some("ext-1")
    );
}

/// Local-wins path: an inbound change with an older `remote_updated_at`
/// than the local field watermark must not overwrite the local value.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_cycle_keeps_local_when_local_revision_is_newer() {
    let _sandbox = test_env::sandbox();
    write_project("alpha", &project_meta("alpha", None), "", true).expect("write project");
    set_sync_kind("alpha", "echo");
    write_work_item(
        "alpha",
        "AAA-0001",
        &wi_fm("AAA-0001", "Local title", "todo"),
        "",
    )
    .expect("write wi");

    // Stamp a future local revision and bind external_id.
    let mut revs = HashMap::new();
    revs.insert(
        "title".to_string(),
        FieldRevision {
            mtime: 2_000_000_000_000,
            source: "local".to_string(),
        },
    );
    md_apply(
        "alpha",
        "AAA-0001",
        revs,
        Some(("echo".to_string(), "ext-1".to_string())),
    )
    .expect("pre-bind");

    let change = ExternalChange {
        entity_type: EntityType::WorkItem,
        external_id: "ext-1".to_string(),
        local_entity_id: None,
        fields: serde_json::json!({ "title": "Stale remote" }),
        remote_updated_at: Utc.timestamp_millis_opt(1_500_000_000_000).unwrap(),
        deleted: false,
    };
    let conn = io::conn().expect("conn");
    let id = io::append(&conn, &merge_entry("alpha", &change)).expect("append");
    drop(conn);

    merge_cycle(8).await.expect("merge cycle ok");

    let conn = io::conn().expect("reopen");
    let row = io::load_by_id(&conn, id).expect("load");
    assert_eq!(row.status, OutboxStatus::Succeeded);
    drop(conn);

    let wi = read_work_item("alpha", "AAA-0001").expect("read wi");
    assert_eq!(wi.frontmatter.title, "Local title", "local must win");

    let metadata = md_read("alpha", "AAA-0001").expect("read md").unwrap();
    assert_eq!(metadata.field_revisions["title"].source, "local");
    assert_eq!(metadata.field_revisions["title"].mtime, 2_000_000_000_000);
}

/// Remote-driven delete on a bound work item hard-deletes the
/// local row. The cascade on `workitems` drops `workitem_extras`
/// and `workitem_labels` along with the parent, so the
/// external_ref vanishes and `find_by_external_ref` returns None.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_cycle_applies_remote_delete() {
    let _sandbox = test_env::sandbox();
    write_project("alpha", &project_meta("alpha", None), "", true).expect("write project");
    set_sync_kind("alpha", "echo");
    write_work_item(
        "alpha",
        "AAA-0001",
        &wi_fm("AAA-0001", "Goodbye", "todo"),
        "",
    )
    .expect("write wi");
    md_apply(
        "alpha",
        "AAA-0001",
        HashMap::new(),
        Some(("echo".to_string(), "ext-1".to_string())),
    )
    .expect("bind");

    let change = ExternalChange {
        entity_type: EntityType::WorkItem,
        external_id: "ext-1".to_string(),
        local_entity_id: None,
        fields: serde_json::json!({}),
        remote_updated_at: Utc.timestamp_millis_opt(1_700_000_000_000).unwrap(),
        deleted: true,
    };
    let conn = io::conn().expect("conn");
    let id = io::append(&conn, &merge_entry("alpha", &change)).expect("append");
    drop(conn);

    merge_cycle(8).await.expect("merge cycle ok");

    let conn = io::conn().expect("reopen");
    let row = io::load_by_id(&conn, id).expect("load");
    assert_eq!(row.status, OutboxStatus::Succeeded);
    assert!(row.last_error.is_none());
    drop(conn);

    // The work item is gone (cascade drops extras + labels too)
    // and the external_ref no longer resolves.
    assert!(
        read_work_item("alpha", "AAA-0001").is_err(),
        "work item should be hard-deleted"
    );
    let lookup =
        crate::projects::io::find_by_external_ref("alpha", "echo", "ext-1").expect("lookup");
    assert!(
        lookup.is_none(),
        "external_ref should be gone via the extras cascade"
    );
}

/// GC sweep deletes succeeded outbox rows older than the retention
/// window. Younger succeeded rows and non-succeeded rows are kept.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gc_cycle_deletes_only_old_succeeded_rows() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project(&conn, "alpha", "echo");
    let now = now_ms();

    // Old succeeded — eligible.
    let mut old = sample_entry("alpha");
    old.created_at = now - OUTBOX_GC_RETENTION_MS - 1000;
    old.status = OutboxStatus::Succeeded;
    let old_id = io::append(&conn, &old).expect("append old");
    // The schema's INSERT path probably forces status='pending' on
    // append; flip to succeeded explicitly.
    conn.execute(
        "UPDATE outbox_entries SET status = 'succeeded' WHERE id = ?1",
        rusqlite::params![old_id],
    )
    .expect("flip old to succeeded");

    // Young succeeded — must be retained.
    let mut young = sample_entry("alpha");
    young.created_at = now;
    let young_id = io::append(&conn, &young).expect("append young");
    conn.execute(
        "UPDATE outbox_entries SET status = 'succeeded' WHERE id = ?1",
        rusqlite::params![young_id],
    )
    .expect("flip young to succeeded");

    // Old pending — must be retained (only succeeded is GC'd).
    let mut old_pending = sample_entry("alpha");
    old_pending.created_at = now - OUTBOX_GC_RETENTION_MS - 1000;
    let old_pending_id = io::append(&conn, &old_pending).expect("append old pending");
    drop(conn);

    gc_cycle().await.expect("gc cycle ok");

    let conn = io::conn().expect("reopen");
    assert!(
        io::load_by_id(&conn, old_id).is_err(),
        "old succeeded row should be gone"
    );
    assert!(io::load_by_id(&conn, young_id).is_ok());
    assert!(io::load_by_id(&conn, old_pending_id).is_ok());
}

// ---- event emission probe ----

use crate::sync::events::test_probe;

/// `push_cycle` should fire one `emit_status` per processed entry,
/// keyed on the entry's `project_slug` and tagged `PushCycle`. The
/// probe records every call before the AppHandle check, so this
/// test works without a Tauri runtime.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn push_cycle_emits_one_status_event_per_processed_entry() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project(&conn, "alpha", "echo");
    seed_project(&conn, "beta", "none");

    // Two rows for alpha (echo adapter accepts), one for beta
    // (`'none'` → no-op success). Both still produce an emit.
    let mut row_alpha_1 = sample_entry("alpha");
    row_alpha_1.entity_id = "WI-1".into();
    let mut row_alpha_2 = sample_entry("alpha");
    row_alpha_2.entity_id = "WI-2".into();
    let row_beta = sample_entry("beta");
    io::append(&conn, &row_alpha_1).expect("append a1");
    io::append(&conn, &row_alpha_2).expect("append a2");
    io::append(&conn, &row_beta).expect("append b");
    drop(conn);

    test_probe::reset();
    let processed = push_cycle(8).await.expect("push cycle");
    assert_eq!(processed, 3);

    let calls = test_probe::snapshot();
    assert_eq!(
        calls.len(),
        3,
        "expected one emit per processed entry; got {:?}",
        calls
    );
    for (_, trigger) in &calls {
        assert_eq!(
            *trigger,
            crate::sync::events::SyncEventTrigger::PushCycle,
            "push cycle should tag emits as PushCycle"
        );
    }
    let alpha_count = calls.iter().filter(|(slug, _)| slug == "alpha").count();
    let beta_count = calls.iter().filter(|(slug, _)| slug == "beta").count();
    assert_eq!(alpha_count, 2);
    assert_eq!(beta_count, 1);
}

/// `pull_cycle` is coalesced — exactly one `PullCycle` event per
/// bound project, no matter how many `merge_external` rows the
/// adapter produced. EchoAdapter's pull returns 0 changes, so
/// this test asserts the floor: one event for `alpha`, none for
/// `beta` (which is `'none'`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pull_cycle_emits_one_status_event_per_bound_project() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project(&conn, "alpha", "echo");
    seed_project(&conn, "beta", "none");
    drop(conn);

    test_probe::reset();
    pull_cycle().await.expect("pull cycle");

    let calls = test_probe::snapshot();
    let pull_calls: Vec<_> = calls
        .iter()
        .filter(|(_, trigger)| *trigger == crate::sync::events::SyncEventTrigger::PullCycle)
        .collect();
    assert_eq!(
        pull_calls.len(),
        1,
        "expected one PullCycle emit (for the bound project); got {:?}",
        calls
    );
    assert_eq!(pull_calls[0].0, "alpha");
    assert!(
        !calls.iter().any(|(slug, _)| slug == "beta"),
        "unbound project must not produce a PullCycle event"
    );
}

/// `merge_cycle` should fire one `MergeCycle` event per processed
/// `merge_external` row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_cycle_emits_one_status_event_per_processed_entry() {
    let _sandbox = test_env::sandbox();
    write_project("alpha", &project_meta("alpha", None), "", true).expect("write project");
    set_sync_kind("alpha", "echo");

    let change = ExternalChange {
        entity_type: EntityType::WorkItem,
        external_id: "ext-merge-emit".to_string(),
        local_entity_id: None,
        fields: serde_json::json!({ "title": "from remote" }),
        remote_updated_at: Utc.timestamp_millis_opt(1_700_000_000_000).unwrap(),
        deleted: false,
    };
    let conn = io::conn().expect("conn");
    io::append(&conn, &merge_entry("alpha", &change)).expect("append");
    drop(conn);

    test_probe::reset();
    let processed = merge_cycle(8).await.expect("merge cycle");
    assert_eq!(processed, 1);

    let calls = test_probe::snapshot();
    let merge_calls: Vec<_> = calls
        .iter()
        .filter(|(_, trigger)| *trigger == crate::sync::events::SyncEventTrigger::MergeCycle)
        .collect();
    assert_eq!(
        merge_calls.len(),
        1,
        "expected exactly one MergeCycle emit; got {:?}",
        calls
    );
    assert_eq!(merge_calls[0].0, "alpha");
}

/// When `ensure_fresh_connection_token` cannot refresh an
/// expired Linear bearer (here: the stored record has no
/// `refresh_token`, which short-circuits before any HTTP), the
/// outbox row must finalize as failed with
/// `last_error = "token refresh failed: ..."`. The worker is NOT
/// allowed to silently fall back to "no auth" — that would cause
/// the Linear adapter to surface an opaque AuthFailed error
/// instead of the precise refresh diagnostic the user needs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn push_cycle_finalizes_failure_when_token_refresh_cannot_proceed() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project(&conn, "alpha", "linear");
    let id = io::append(&conn, &sample_entry("alpha")).expect("append");
    drop(conn);

    // Stash an expired Linear OAuth bearer with NO refresh_token.
    // `oauth::ensure_fresh_connection_token` → Linear refresh
    // bails with "linear token expired but no refresh_token
    // stored" before ever touching the network — deterministic
    // and hermetic.
    let expired = super::super::connection_token_store::ConnectionTokenRecord {
        access_token: "lin_expired_bearer".to_string(),
        refresh_token: None,
        expires_at_unix: Some(Utc::now().timestamp() - 600),
        source: super::super::connection_token_store::SOURCE_OAUTH_REDIRECT.to_string(),
    };
    super::super::connection_token_store::save("connection-alpha", expired).unwrap();

    let _ = push_cycle(8).await.expect("push cycle");

    assert_refresh_failure_recorded(id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn push_cycle_reads_token_from_bound_sync_connection_id() {
    let _sandbox = test_env::sandbox();
    let conn = io::conn().expect("conn");
    crate::projects::schema::init_project_tables(&conn).expect("init");
    seed_project_with_connection(&conn, "alpha", "linear", Some("connection-shared-linear"));
    let id = io::append(&conn, &sample_entry("alpha")).expect("append");
    drop(conn);

    let expired = super::super::connection_token_store::ConnectionTokenRecord {
        access_token: "lin_expired_shared_bearer".to_string(),
        refresh_token: None,
        expires_at_unix: Some(Utc::now().timestamp() - 600),
        source: super::super::connection_token_store::SOURCE_OAUTH_REDIRECT.to_string(),
    };
    super::super::connection_token_store::save("connection-shared-linear", expired).unwrap();

    let _ = push_cycle(8).await.expect("push cycle");

    assert_refresh_failure_recorded(id);
}

fn assert_refresh_failure_recorded(outbox_id: i64) {
    let conn = io::conn().expect("reopen");
    let row = io::load_by_id(&conn, outbox_id).expect("load");
    // `finalize_failure(..., retryable=true)` walks the row through
    // backoff: status stays `Pending` until `retry_count` hits
    // `MAX_RETRY_COUNT`, then flips to `Abandoned`. After a single
    // push cycle the row must be Pending (with `retry_count=1`
    // and `last_error` set) — never silently Succeeded, never
    // stuck InFlight.
    assert!(
        matches!(row.status, OutboxStatus::Pending | OutboxStatus::Abandoned),
        "expected Pending or Abandoned after refresh failure, got {:?}",
        row.status
    );
    assert!(
        row.retry_count >= 1,
        "expected retry_count >= 1, got {}",
        row.retry_count
    );
    let last_error = row.last_error.unwrap_or_default();
    assert!(
        last_error.starts_with("token refresh failed:"),
        "expected 'token refresh failed: ...' prefix, got {:?}",
        last_error
    );
}

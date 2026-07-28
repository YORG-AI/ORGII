use rusqlite::{params, Connection, OptionalExtension};

use super::SqliteRecordStore;
use crate::canonical::{
    AgentMetadata, ArtifactQuality, AttributionPrecision, FileResourceRecord, ResourceAction,
    ResourceInteractionCaptureMethod, ResourceInteractionOutcome, ResourceInteractionRecord,
    SessionEditArtifactRecord, SessionEditKind, SessionRecord, RESOURCE_INTERACTION_SCHEMA_VERSION,
};
use crate::privacy::ORGTRACK_SCHEMA_VERSION;
use crate::store::RecordStore;

fn fixture_store() -> SqliteRecordStore<'static> {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    SqliteRecordStore::init_tables(&conn).expect("init tables");
    SqliteRecordStore::new(Box::leak(Box::new(conn)))
}

fn list_file_interactions(
    store: &SqliteRecordStore<'_>,
    repository_id: Option<&str>,
    workspace_path: &str,
    repo_relative_path: &str,
) -> Vec<ResourceInteractionRecord> {
    store
        .list_file_resource_interactions_page(
            repository_id,
            workspace_path,
            repo_relative_path,
            100,
            0,
        )
        .expect("list file interactions")
        .interactions
}

#[test]
fn init_tables_replaces_legacy_unique_source_event_index() {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    SqliteRecordStore::init_tables(&conn).expect("init current tables");
    conn.execute_batch(
        "
            DROP INDEX idx_orgtrack_core_resource_interactions_observation;
            CREATE UNIQUE INDEX idx_orgtrack_core_resource_interactions_source_event
                ON orgtrack_core_resource_interactions(
                    source,
                    source_event_id,
                    resource_id,
                    action
                )
                WHERE source_event_id IS NOT NULL;
            ",
    )
    .expect("install legacy unique index");

    SqliteRecordStore::init_tables(&conn).expect("migrate legacy index");

    let legacy_index: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1",
            ["idx_orgtrack_core_resource_interactions_source_event"],
            |row| row.get(0),
        )
        .optional()
        .expect("query legacy index");
    assert!(legacy_index.is_none());

    let observation_index: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1",
            ["idx_orgtrack_core_resource_interactions_observation"],
            |row| row.get(0),
        )
        .expect("query replacement index");
    assert!(!observation_index.to_ascii_uppercase().contains("UNIQUE"));
}

#[test]
fn init_tables_backfills_parent_identity_before_creating_parent_index() {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    conn.execute_batch(
        "CREATE TABLE orgtrack_core_sessions (
                session_id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                source_session_id TEXT NOT NULL,
                workspace_path TEXT,
                title TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT,
                completed_at TEXT,
                branch TEXT,
                payload_json TEXT NOT NULL
             );",
    )
    .expect("create legacy sessions table");
    let child = SessionRecord {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        source: "claude_code".to_string(),
        source_session_id: "child".to_string(),
        session_id: "child".to_string(),
        title: "Child".to_string(),
        status: None,
        created_at: None,
        updated_at: None,
        completed_at: None,
        workspace_path: Some("/repo".to_string()),
        branch: None,
        parent_session_id: Some("root".to_string()),
        org_member_id: None,
        collaboration_origin: None,
        metadata: AgentMetadata::default(),
    };
    let child_payload = serde_json::to_string(&child).expect("serialize child");
    conn.execute(
        "INSERT INTO orgtrack_core_sessions (
                session_id, source, source_session_id, workspace_path, title, payload_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            &child.session_id,
            &child.source,
            &child.source_session_id,
            &child.workspace_path,
            &child.title,
            child_payload
        ],
    )
    .expect("insert legacy child");

    SqliteRecordStore::init_tables(&conn).expect("migrate legacy sessions table");
    let parent: Option<String> = conn
        .query_row(
            "SELECT parent_session_id FROM orgtrack_core_sessions WHERE session_id = 'child'",
            [],
            |row| row.get(0),
        )
        .expect("query migrated parent");
    assert_eq!(parent.as_deref(), Some("root"));
}

#[test]
fn init_tables_seeds_revisions_for_existing_interactions() {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    SqliteRecordStore::init_tables(&conn).expect("initialize current schema");
    conn.execute_batch(
        "DROP TRIGGER orgtrack_core_resource_revision_insert;
             DROP TRIGGER orgtrack_core_resource_revision_delete;
             DROP TABLE orgtrack_core_resource_revisions;",
    )
    .expect("simulate pre-revision schema");
    let store = SqliteRecordStore::new(&conn);
    store
        .upsert_file_resource(&FileResourceRecord {
            schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
            resource_id: "legacy-resource".to_string(),
            repository_id: Some("legacy-repo".to_string()),
            workspace_path: "/legacy/repo".to_string(),
            repo_relative_path: "src/legacy.rs".to_string(),
            display_path: "src/legacy.rs".to_string(),
            path_hash: "legacy-hash".to_string(),
        })
        .expect("insert legacy resource");
    store
        .append_resource_interaction(&ResourceInteractionRecord {
            schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
            interaction_id: "legacy-interaction".to_string(),
            source: "cursor_ide".to_string(),
            source_session_id: Some("legacy-session".to_string()),
            source_event_id: Some("legacy-event".to_string()),
            session_id: "legacy-session".to_string(),
            turn_id: None,
            actor_id: None,
            resource_id: "legacy-resource".to_string(),
            action: ResourceAction::Read,
            outcome: ResourceInteractionOutcome::Succeeded,
            occurred_at: "2026-07-15T00:00:00Z".to_string(),
            capture_method: ResourceInteractionCaptureMethod::Hook,
            attribution_precision: AttributionPrecision::SessionOnly,
        })
        .expect("insert interaction without revision trigger");

    SqliteRecordStore::init_tables(&conn).expect("migrate revision schema");
    assert_eq!(
        SqliteRecordStore::new(&conn)
            .get_file_resource_revision(Some("legacy-repo"), "/different/worktree", "src/legacy.rs")
            .expect("query seeded revision"),
        1
    );
}

#[test]
fn edit_artifacts_are_upserted_listed_and_deleted_by_session() {
    let store = fixture_store();
    let record = SessionEditArtifactRecord {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        record_id: "edit-1".to_string(),
        source: "cursor_ide".to_string(),
        source_session_id: Some("source-1".to_string()),
        session_id: "session-1".to_string(),
        source_event_id: Some("event-1".to_string()),
        turn_id: Some("turn-1".to_string()),
        sequence_index: 1,
        timestamp: Some("2026-06-15T00:00:00Z".to_string()),
        workspace_path: Some("/repo".to_string()),
        file_path: "src/lib.rs".to_string(),
        path_hash: "hash".to_string(),
        edit_kind: SessionEditKind::Patch,
        old_start_line: Some(1),
        new_start_line: Some(1),
        start_line: Some(1),
        end_line: Some(2),
        lines_added: 2,
        lines_removed: 1,
        quality: ArtifactQuality::PatchReversible,
        metadata: AgentMetadata::default(),
    };
    store
        .upsert_edit_artifact(&record)
        .expect("upsert edit artifact");
    let records = store
        .list_edit_artifacts(Some("cursor_ide"), Some("session-1"))
        .expect("list edit artifacts");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].record_id, "edit-1");

    store
        .delete_session_artifacts("cursor_ide", "session-1")
        .expect("delete session artifacts");
    let records = store
        .list_edit_artifacts(Some("cursor_ide"), Some("session-1"))
        .expect("list edit artifacts after delete");
    assert!(records.is_empty());
}

#[test]
fn file_resource_interactions_are_idempotent_and_queryable_by_repo() {
    let store = fixture_store();
    let resource = FileResourceRecord {
        schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
        resource_id: "file-1".to_string(),
        repository_id: Some("repo-1".to_string()),
        workspace_path: "/repo/worktree".to_string(),
        repo_relative_path: "src/lib.rs".to_string(),
        display_path: "src/lib.rs".to_string(),
        path_hash: "hash-1".to_string(),
    };
    store
        .upsert_file_resource(&resource)
        .expect("upsert file resource");

    let interaction = ResourceInteractionRecord {
        schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
        interaction_id: "interaction-1".to_string(),
        source: "claude_code".to_string(),
        source_session_id: Some("source-1".to_string()),
        source_event_id: Some("tool-1".to_string()),
        session_id: "claudecodeapp-source-1".to_string(),
        turn_id: Some("turn-1".to_string()),
        actor_id: Some("agent-1".to_string()),
        resource_id: resource.resource_id.clone(),
        action: ResourceAction::Read,
        outcome: ResourceInteractionOutcome::Succeeded,
        occurred_at: "2026-07-14T00:00:00Z".to_string(),
        capture_method: ResourceInteractionCaptureMethod::Hook,
        attribution_precision: AttributionPrecision::Exact,
    };
    store
        .append_resource_interaction(&interaction)
        .expect("append interaction");
    store
        .append_resource_interaction(&interaction)
        .expect("repeat interaction is idempotent");
    assert_eq!(
        store
            .get_file_resource_revision(Some("repo-1"), "/different/worktree", "src/lib.rs")
            .expect("read durable revision"),
        1
    );

    let records =
        list_file_interactions(&store, Some("repo-1"), "/different/worktree", "src/lib.rs");
    assert_eq!(records, vec![interaction.clone()]);

    let mut stronger_observation = interaction.clone();
    stronger_observation.interaction_id = "interaction-stronger".to_string();
    stronger_observation.session_id = "claudecodeapp-child-1".to_string();
    stronger_observation.capture_method = ResourceInteractionCaptureMethod::Reconciled;
    store
        .append_resource_interaction(&stronger_observation)
        .expect("preserve stronger observation of the same source event");
    assert_eq!(
        list_file_interactions(&store, Some("repo-1"), "/different/worktree", "src/lib.rs",).len(),
        2
    );

    let mut reconciled = interaction.clone();
    reconciled.interaction_id = "interaction-2".to_string();
    reconciled.source_event_id = Some("tool-2".to_string());
    reconciled.capture_method = ResourceInteractionCaptureMethod::Reconciled;
    store
        .append_resource_interaction(&reconciled)
        .expect("append reconciled interaction");
    assert_eq!(
        store
            .delete_reconciled_resource_interactions("claude_code", "claudecodeapp-source-1")
            .expect("delete reconciled interactions"),
        1
    );
    assert_eq!(
        store
            .delete_reconciled_resource_interactions("claude_code", "claudecodeapp-child-1")
            .expect("delete child reconciled observation"),
        1
    );
    let records =
        list_file_interactions(&store, Some("repo-1"), "/different/worktree", "src/lib.rs");
    assert_eq!(records, vec![interaction]);
    assert_eq!(
        store
            .get_file_resource_revision(Some("repo-1"), "/different/worktree", "src/lib.rs")
            .expect("read revision after inserts and deletes"),
        5
    );
}

#[test]
fn file_resource_interaction_pages_keep_root_and_child_sessions_together() {
    let store = fixture_store();
    let resource = FileResourceRecord {
        schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
        resource_id: "file-page".to_string(),
        repository_id: Some("repo-page".to_string()),
        workspace_path: "/repo/page".to_string(),
        repo_relative_path: "src/page.rs".to_string(),
        display_path: "src/page.rs".to_string(),
        path_hash: "hash-page".to_string(),
    };
    store
        .upsert_file_resource(&resource)
        .expect("upsert page resource");

    for (session_id, parent_session_id) in [
        ("root-1", None),
        ("child-1", Some("root-1")),
        ("root-2", None),
        ("root-3", None),
    ] {
        store
            .upsert_session(&SessionRecord {
                schema_version: ORGTRACK_SCHEMA_VERSION,
                source: "codex_app".to_string(),
                source_session_id: session_id.to_string(),
                session_id: session_id.to_string(),
                title: session_id.to_string(),
                status: None,
                created_at: None,
                updated_at: None,
                completed_at: None,
                workspace_path: Some("/repo/page".to_string()),
                branch: None,
                parent_session_id: parent_session_id.map(str::to_string),
                org_member_id: None,
                collaboration_origin: None,
                metadata: AgentMetadata::default(),
            })
            .expect("upsert paged session");
    }

    for (interaction_id, session_id, occurred_at) in [
        ("root-1-read", "root-1", "2026-07-14T01:00:00Z"),
        ("child-1-write", "child-1", "2026-07-14T02:00:00Z"),
        ("root-2-read", "root-2", "2026-07-14T03:00:00Z"),
        ("root-3-read", "root-3", "2026-07-14T04:00:00Z"),
    ] {
        store
            .append_resource_interaction(&ResourceInteractionRecord {
                schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                interaction_id: interaction_id.to_string(),
                source: "codex_app".to_string(),
                source_session_id: Some(session_id.to_string()),
                source_event_id: Some(interaction_id.to_string()),
                session_id: session_id.to_string(),
                turn_id: None,
                actor_id: None,
                resource_id: resource.resource_id.clone(),
                action: ResourceAction::Read,
                outcome: ResourceInteractionOutcome::Succeeded,
                occurred_at: occurred_at.to_string(),
                capture_method: ResourceInteractionCaptureMethod::Hook,
                attribution_precision: AttributionPrecision::SessionOnly,
            })
            .expect("append paged interaction");
    }

    let first = store
        .list_file_resource_interactions_page(
            Some("repo-page"),
            "/different/worktree",
            "src/page.rs",
            2,
            0,
        )
        .expect("load first root page");
    assert_eq!(first.total_sessions, 3);
    assert_eq!(
        first
            .interactions
            .iter()
            .map(|record| record.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["root-3", "root-2"]
    );

    let second = store
        .list_file_resource_interactions_page(
            Some("repo-page"),
            "/different/worktree",
            "src/page.rs",
            2,
            2,
        )
        .expect("load second root page");
    assert_eq!(second.total_sessions, 3);
    assert_eq!(
        second
            .interactions
            .iter()
            .map(|record| record.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["child-1", "root-1"]
    );
}

#[test]
fn recent_hook_signals_return_newest_hook_facts_with_paths() {
    let store = fixture_store();
    let resource = FileResourceRecord {
        schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
        resource_id: "file-signal".to_string(),
        repository_id: Some("repo-1".to_string()),
        workspace_path: "/repo/worktree".to_string(),
        repo_relative_path: "src/app.rs".to_string(),
        display_path: "src/app.rs".to_string(),
        path_hash: "hash-signal".to_string(),
    };
    store
        .upsert_file_resource(&resource)
        .expect("upsert file resource");

    let base = ResourceInteractionRecord {
        schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
        interaction_id: "sig-1".to_string(),
        source: "qwen_code".to_string(),
        source_session_id: Some("qwen-1".to_string()),
        source_event_id: Some("tool-1".to_string()),
        session_id: "qwencodeapp-qwen-1".to_string(),
        turn_id: None,
        actor_id: None,
        resource_id: resource.resource_id.clone(),
        action: ResourceAction::Read,
        outcome: ResourceInteractionOutcome::Succeeded,
        occurred_at: "2026-07-14T00:00:00Z".to_string(),
        capture_method: ResourceInteractionCaptureMethod::Hook,
        attribution_precision: AttributionPrecision::SessionOnly,
    };
    let mut newer = base.clone();
    newer.interaction_id = "sig-2".to_string();
    newer.action = ResourceAction::Write;
    newer.occurred_at = "2026-07-14T01:00:00Z".to_string();
    let mut reconciled = base.clone();
    reconciled.interaction_id = "sig-3".to_string();
    reconciled.occurred_at = "2026-07-14T02:00:00Z".to_string();
    reconciled.capture_method = ResourceInteractionCaptureMethod::Reconciled;

    for record in [&base, &newer, &reconciled] {
        store
            .append_resource_interaction(record)
            .expect("append interaction");
    }

    let signals = store
        .list_recent_hook_signals(50)
        .expect("list recent hook signals");
    // Only the two hook facts, newest first; the reconciled one is excluded.
    assert_eq!(signals.len(), 2);
    assert_eq!(signals[0].action, "write");
    assert_eq!(signals[0].occurred_at, "2026-07-14T01:00:00Z");
    assert_eq!(signals[0].file_path, "src/app.rs");
    assert_eq!(signals[0].source, "qwen_code");
    assert_eq!(signals[0].capture_method, "hook");
    assert_eq!(signals[1].action, "read");
    // No session row has been reconciled yet, so there is no human title to
    // show — the UI falls back to a shortened id.
    assert_eq!(signals[0].session_title, None);

    let session_with_title = |title: &str| SessionRecord {
        schema_version: 1,
        source: "qwen_code".to_string(),
        source_session_id: "qwen-1".to_string(),
        session_id: "qwencodeapp-qwen-1".to_string(),
        title: title.to_string(),
        status: None,
        created_at: None,
        updated_at: None,
        completed_at: None,
        workspace_path: Some("/repo/worktree".to_string()),
        branch: None,
        parent_session_id: None,
        org_member_id: None,
        collaboration_origin: None,
        metadata: AgentMetadata::default(),
    };

    // A placeholder title (equal to the raw source id) is suppressed so a
    // raw id never masquerades as a name.
    store
        .upsert_session(&session_with_title("qwen-1"))
        .expect("upsert placeholder session");
    let placeholder = store
        .list_recent_hook_signals(50)
        .expect("list recent hook signals with placeholder title");
    assert_eq!(placeholder[0].session_title, None);

    // A reconciled, human-readable title resolves through the LEFT JOIN.
    store
        .upsert_session(&session_with_title("Refactor the auth flow"))
        .expect("upsert titled session");
    let titled = store
        .list_recent_hook_signals(50)
        .expect("list recent hook signals with title");
    assert_eq!(
        titled[0].session_title.as_deref(),
        Some("Refactor the auth flow")
    );
}

#[test]
fn file_resource_upsert_composes_with_outer_transaction() {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    SqliteRecordStore::init_tables(&conn).expect("init tables");
    conn.execute_batch("BEGIN IMMEDIATE")
        .expect("begin reconciliation transaction");

    let store = SqliteRecordStore::new(&conn);
    store
        .upsert_file_resource(&FileResourceRecord {
            schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
            resource_id: "nested-file-1".to_string(),
            repository_id: Some("repo-1".to_string()),
            workspace_path: "/repo/worktree".to_string(),
            repo_relative_path: "package.json".to_string(),
            display_path: "package.json".to_string(),
            path_hash: "nested-hash-1".to_string(),
        })
        .expect("upsert file resource inside outer transaction");
    conn.execute_batch("COMMIT")
        .expect("commit reconciliation transaction");

    let resource_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM orgtrack_core_resources WHERE resource_id = ?1",
            ["nested-file-1"],
            |row| row.get(0),
        )
        .expect("query resource row");
    let file_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM orgtrack_core_file_resources WHERE resource_id = ?1",
            ["nested-file-1"],
            |row| row.get(0),
        )
        .expect("query file resource row");
    assert_eq!((resource_count, file_count), (1, 1));
}

#[test]
fn interaction_import_checkpoints_change_with_fingerprint_or_parser() {
    let store = fixture_store();
    assert!(!store
        .interaction_import_is_current("claude_code", "session-1", "fingerprint-1", 1)
        .expect("query empty checkpoint"));

    store
        .mark_interaction_imported(
            "claude_code",
            "session-1",
            "fingerprint-1",
            1,
            "2026-07-14T00:00:00Z",
        )
        .expect("mark checkpoint");

    assert!(store
        .interaction_import_is_current("claude_code", "session-1", "fingerprint-1", 1)
        .expect("query matching checkpoint"));
    assert!(!store
        .interaction_import_is_current("claude_code", "session-1", "fingerprint-2", 1)
        .expect("query changed fingerprint"));
    assert!(!store
        .interaction_import_is_current("claude_code", "session-1", "fingerprint-1", 2)
        .expect("query changed parser"));
}

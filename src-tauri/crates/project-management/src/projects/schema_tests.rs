use super::*;
use rusqlite::Connection;

fn open_in_memory() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .expect("enable fks");
    conn
}

#[test]
fn init_creates_all_tables() {
    let conn = open_in_memory();
    init_project_tables(&conn).expect("init");

    let expected = [
        "project_orgs",
        "projects",
        "workitems",
        "workitem_extras",
        "workitem_labels",
        "labels",
        "milestones",
        "members",
        "routine_definitions",
        "routine_fires",
        "outbox_entries",
        "webhook_secrets",
        "import_progress",
        "linear_metadata_cache",
    ];

    for name in expected {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                [name],
                |row| row.get(0),
            )
            .expect("query");
        assert_eq!(count, 1, "table {} should exist", name);
    }
}

#[test]
fn init_drops_dead_assignment_tables() {
    let conn = open_in_memory();
    // Simulate a legacy DB that still carries the never-wired tables.
    conn.execute_batch(
        "CREATE TABLE workitem_assigned_agents (work_item_id TEXT);
             CREATE TABLE workitem_reviewers (work_item_id TEXT);",
    )
    .expect("create legacy tables");

    init_project_tables(&conn).expect("init");

    for name in ["workitem_assigned_agents", "workitem_reviewers"] {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                [name],
                |row| row.get(0),
            )
            .expect("query");
        assert_eq!(count, 0, "dead table {} should be dropped", name);
    }
}

#[test]
fn init_is_idempotent() {
    let conn = open_in_memory();
    init_project_tables(&conn).expect("first init");
    init_project_tables(&conn).expect("second init should not fail");
}

#[test]
fn legacy_workitems_schema_is_rebuilt_for_org_level_items() {
    let conn = open_in_memory();
    conn.execute_batch(
            r#"
            CREATE TABLE project_orgs (
                id TEXT PRIMARY KEY
            );
            CREATE TABLE projects (
                id TEXT PRIMARY KEY
            );
            CREATE TABLE workitems (
                id                    TEXT PRIMARY KEY,
                org_id                TEXT NOT NULL DEFAULT 'personal-org' REFERENCES project_orgs(id),
                project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                short_id              TEXT NOT NULL,
                title                 TEXT NOT NULL,
                body                  TEXT NOT NULL DEFAULT '',
                status                TEXT NOT NULL DEFAULT 'backlog',
                priority              TEXT NOT NULL DEFAULT 'none',
                assigned_human_id     TEXT,
                assignee              TEXT,
                assignee_type         TEXT,
                milestone             TEXT,
                parent                TEXT,
                start_date            TEXT,
                target_date           TEXT,
                estimate              REAL,
                order_index           INTEGER NOT NULL DEFAULT 0,
                created_at            INTEGER NOT NULL,
                updated_at            INTEGER NOT NULL,
                completed_at          INTEGER,
                deleted_at            INTEGER,
                local_version         INTEGER NOT NULL DEFAULT 0,
                collab_remote_version INTEGER
            );
            CREATE TABLE workitem_extras (
                work_item_id TEXT PRIMARY KEY REFERENCES workitems(id) ON DELETE CASCADE,
                extras_json TEXT NOT NULL DEFAULT '{}'
            );

            INSERT INTO project_orgs (id) VALUES ('org-1');
            INSERT INTO projects (id) VALUES ('project-1');
            INSERT INTO workitems (
                id, org_id, project_id, short_id, title, created_at, updated_at
            ) VALUES (
                'item-1', 'org-1', 'project-1', 'PRJ-0001', 'Existing', 1, 1
            );
            INSERT INTO workitem_extras (work_item_id) VALUES ('item-1');
            "#,
        )
        .expect("legacy fixture");

    ensure_workitems_allow_standalone_scope(&conn).expect("migrate legacy workitems");

    let project_id_not_null: i64 = conn
        .query_row(
            "SELECT \"notnull\" FROM pragma_table_info('workitems') WHERE name = 'project_id'",
            [],
            |row| row.get(0),
        )
        .expect("project_id shape");
    assert_eq!(
        project_id_not_null, 0,
        "org-level Work Items must permit a NULL project_id"
    );

    conn.execute(
        "INSERT INTO workitems (
                id, org_id, project_id, short_id, title, created_at, updated_at
             ) VALUES ('item-2', 'org-1', NULL, 'WI-0001', 'Handoff', 2, 2)",
        [],
    )
    .expect("standalone Work Item");

    let extras_preserved: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM workitem_extras WHERE work_item_id = 'item-1'",
            [],
            |row| row.get(0),
        )
        .expect("preserved child row");
    assert_eq!(extras_preserved, 1);

    conn.execute("DELETE FROM projects WHERE id = 'project-1'", [])
        .expect("delete project");
    let detached_project_id: Option<String> = conn
        .query_row(
            "SELECT project_id FROM workitems WHERE id = 'item-1'",
            [],
            |row| row.get(0),
        )
        .expect("detached Work Item");
    assert_eq!(detached_project_id, None);

    let foreign_key_violations: i64 = conn
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .expect("foreign-key check");
    assert_eq!(foreign_key_violations, 0);
}

#[test]
fn init_migrates_legacy_routine_columns_before_index_creation() {
    let conn = open_in_memory();
    conn.execute_batch(
        r#"
            CREATE TABLE routine_definitions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1,
                trigger_json TEXT NOT NULL,
                run_template_json TEXT NOT NULL,
                output_policy_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE routine_fires (
                id TEXT PRIMARY KEY,
                routine_id TEXT NOT NULL REFERENCES routine_definitions(id) ON DELETE CASCADE,
                fired_at INTEGER NOT NULL,
                status TEXT NOT NULL,
                session_id TEXT,
                agent_org_run_id TEXT
            );
            "#,
    )
    .expect("legacy routine schema");

    init_project_tables(&conn).expect("init upgrades routine_fires");

    let definition_cols: Vec<String> = conn
        .prepare("PRAGMA table_info(routine_definitions)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(
        definition_cols
            .iter()
            .any(|column| column == "output_policy_json"),
        "missing routine_definitions output_policy_json; got: {:?}",
        definition_cols
    );

    let fire_cols: Vec<String> = conn
        .prepare("PRAGMA table_info(routine_fires)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    for expected in [
        "work_item_id",
        "coalesced_into_fire_id",
        "idempotency_key",
        "started_at",
        "completed_at",
        "error",
    ] {
        assert!(
            fire_cols.iter().any(|column| column == expected),
            "missing routine_fires column {}; got: {:?}",
            expected,
            fire_cols
        );
    }

    let index_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_routine_fires_idempotency'",
                [],
                |row| row.get(0),
            )
            .expect("index query");
    assert_eq!(index_count, 1);
}

#[test]
fn project_table_pins_org_and_sync_columns() {
    let conn = open_in_memory();
    init_project_tables(&conn).expect("init");

    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(projects)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .map(Result::unwrap)
        .collect();

    for expected in [
        "org_id",
        "sync_kind",
        "sync_config_json",
        "sync_last_pull_at",
        "sync_cursor_blob",
        "sync_last_webhook_at",
        "collab_remote_version",
        "field_revisions_json",
    ] {
        assert!(
            cols.iter().any(|column| column == expected),
            "missing project column {}; got: {:?}",
            expected,
            cols
        );
    }
}

#[test]
fn init_backfills_legacy_projects_sync_columns() {
    let conn = open_in_memory();
    // Simulate a DB created before the sync surface was added to the
    // `projects` CREATE TABLE: no sync_* columns at all.
    conn.execute_batch(
        r#"
            CREATE TABLE projects (
                id                  TEXT PRIMARY KEY,
                org_id              TEXT NOT NULL DEFAULT 'personal-org',
                name                TEXT NOT NULL,
                slug                TEXT NOT NULL,
                status              TEXT NOT NULL DEFAULT 'active',
                priority            TEXT NOT NULL DEFAULT 'none',
                health              TEXT NOT NULL DEFAULT 'on_track',
                lead                TEXT,
                description         TEXT,
                short_id_prefix     TEXT NOT NULL,
                next_work_item_id   INTEGER NOT NULL DEFAULT 1,
                start_date          TEXT,
                target_date         TEXT,
                linked_repos_json   TEXT NOT NULL DEFAULT '[]',
                agent_defaults_json TEXT,
                created_at          INTEGER NOT NULL,
                updated_at          INTEGER NOT NULL,
                local_version       INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO projects (id, name, slug, short_id_prefix, created_at, updated_at)
            VALUES ('p1', 'P1', 'p1', 'AAA', 0, 0);
            "#,
    )
    .expect("legacy projects schema");

    init_project_tables(&conn).expect("init upgrades legacy projects table");

    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(projects)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    for expected in [
        "sync_kind",
        "sync_config_json",
        "sync_connection_id",
        "sync_last_pull_at",
        "sync_cursor_blob",
        "sync_last_webhook_at",
        "collab_remote_version",
        "field_revisions_json",
    ] {
        assert!(
            cols.iter().any(|column| column == expected),
            "missing backfilled projects column {}; got: {:?}",
            expected,
            cols
        );
    }

    // The exact binding query the worker runs must now succeed against
    // the upgraded legacy DB.
    let bound: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (
                     SELECT slug, sync_kind, sync_config_json, sync_connection_id, sync_last_webhook_at
                     FROM projects
                     WHERE sync_kind IS NOT NULL AND sync_kind != 'none'
                       AND sync_connection_id IS NOT NULL
                     ORDER BY slug ASC
                 )",
                [],
                |row| row.get(0),
            )
            .expect("worker binding query must run on upgraded legacy DB");
    assert_eq!(bound, 0, "no bound projects in the legacy fixture");

    // Existing rows survive the migration with the default sync_kind.
    let kind: String = conn
        .query_row(
            "SELECT sync_kind FROM projects WHERE id = 'p1'",
            [],
            |row| row.get(0),
        )
        .expect("row survives");
    assert_eq!(kind, "none");
}

#[test]
fn org_first_tables_pin_columns_and_default_personal_org() {
    let conn = open_in_memory();
    init_project_tables(&conn).expect("init");

    let org_name: String = conn
        .query_row(
            "SELECT name FROM project_orgs WHERE id = 'personal-org'",
            [],
            |row| row.get(0),
        )
        .expect("default org");
    assert_eq!(org_name, "Personal Org");

    let workitem_cols: Vec<String> = conn
        .prepare("PRAGMA table_info(workitems)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    for expected in ["org_id", "assigned_human_id"] {
        assert!(
            workitem_cols.iter().any(|column| column == expected),
            "missing workitems column {}; got: {:?}",
            expected,
            workitem_cols
        );
    }
}

/// Webhook secrets table is fresh DDL — there is no pre-existing
/// shape to migrate, but we still pin the schema so a future
/// schema-drift bug surfaces as a unit-test failure rather than a
/// runtime SQL error inside the worker.
#[test]
fn init_webhook_secrets_table_pins_columns() {
    let conn = open_in_memory();
    init_webhook_secrets_table(&conn).expect("webhook init");

    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(webhook_secrets)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    for expected in [
        "project_slug",
        "adapter_id",
        "secret_hex",
        "last_rotated_at",
    ] {
        assert!(
            cols.iter().any(|c| c == expected),
            "missing column {} in webhook_secrets; got: {:?}",
            expected,
            cols
        );
    }
}

#[test]
fn init_webhook_secrets_table_is_idempotent() {
    let conn = open_in_memory();
    init_webhook_secrets_table(&conn).expect("first init");
    init_webhook_secrets_table(&conn).expect("second init should not fail");
}

/// import_progress table column shape is pinned. The
/// worker reads each column by name; a typo / drift on either
/// side surfaces here as a unit-test failure rather than at
/// runtime in the import loop.
#[test]
fn init_import_progress_table_pins_columns() {
    let conn = open_in_memory();
    init_import_progress_table(&conn).expect("import init");

    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(import_progress)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    for expected in [
        "project_slug",
        "adapter_id",
        "state",
        "page_cursor",
        "imported_count",
        "total_hint",
        "started_at",
        "updated_at",
        "last_error",
    ] {
        assert!(
            cols.iter().any(|c| c == expected),
            "missing column {} in import_progress; got: {:?}",
            expected,
            cols
        );
    }

    let idx_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
                  WHERE type='index' AND name='idx_import_progress_state'",
            [],
            |row| row.get(0),
        )
        .expect("query");
    assert_eq!(idx_count, 1, "state index should exist");
}

#[test]
fn init_import_progress_table_is_idempotent() {
    let conn = open_in_memory();
    init_import_progress_table(&conn).expect("first init");
    init_import_progress_table(&conn).expect("second init should not fail");
}

#[test]
fn init_outbox_table_creates_indexes() {
    let conn = open_in_memory();
    init_outbox_table(&conn).expect("outbox init");

    for index_name in ["idx_outbox_status_created", "idx_outbox_project_entity"] {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name = ?1",
                [index_name],
                |row| row.get(0),
            )
            .expect("query");
        assert_eq!(count, 1, "index {} should exist", index_name);
    }
}

#[test]
fn init_outbox_table_is_idempotent() {
    let conn = open_in_memory();
    init_outbox_table(&conn).expect("first outbox init");
    init_outbox_table(&conn).expect("second outbox init should not fail");
}

#[test]
fn outbox_columns_match_phase_4_1_contract() {
    let conn = open_in_memory();
    init_outbox_table(&conn).expect("init");

    let mut stmt = conn
        .prepare("PRAGMA table_info(outbox_entries)")
        .expect("prepare pragma");
    let cols: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .map(Result::unwrap)
        .collect();

    for expected in [
        "id",
        "project_slug",
        "entity_type",
        "entity_id",
        "op",
        "field_path",
        "payload_json",
        "created_at",
        "retry_count",
        "last_attempted_at",
        "last_error",
        "status",
    ] {
        assert!(
            cols.iter().any(|c| c == expected),
            "outbox_entries should have column {}; got {:?}",
            expected,
            cols
        );
    }
}

#[test]
fn projects_db_path_lives_under_orgii_root() {
    // Sanity: the path helper points at `~/.orgii/projects/projects.db`,
    // not into `sessions.db`. This locks down the dual-pool split.
    let path = app_paths::projects_db();
    let path_str = path.to_string_lossy().to_string();
    assert!(
        path_str.ends_with("projects.db"),
        "path should end with projects.db: {}",
        path_str
    );
    assert!(
        path_str.contains("projects"),
        "path should be under projects/ dir: {}",
        path_str
    );
    assert!(
        !path_str.ends_with("sessions.db"),
        "must not collide with sessions.db: {}",
        path_str
    );
}

#[test]
fn direct_project_delete_detaches_workitems_for_tombstone_ordering() {
    let conn = open_in_memory();
    init_project_tables(&conn).expect("init");

    conn.execute(
        "INSERT INTO projects (id, name, slug, short_id_prefix, created_at, updated_at)
             VALUES ('p1', 'P1', 'p1', 'AAA', 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO workitems (id, project_id, short_id, title, created_at, updated_at)
             VALUES ('w1', 'p1', 'AAA-1', 'T', 0, 0)",
        [],
    )
    .unwrap();

    conn.execute("DELETE FROM projects WHERE id = 'p1'", [])
        .unwrap();

    let project_id: Option<String> = conn
        .query_row(
            "SELECT project_id FROM workitems WHERE id = 'w1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        project_id, None,
        "raw project tombstones detach children until their own tombstones arrive"
    );
}

/// End-to-end: with a sandboxed `ORGII_HOME`, opening the project pool
/// must (a) create `projects/projects.db` on disk, (b) populate it
/// with the project schema, and (c) leave `sessions.db` free of any
/// project tables. This is the dual-pool contract.
#[test]
fn dual_pool_split_is_physical() {
    use database::db::get_projects_connection;
    use test_helpers::test_env;

    let sandbox = test_env::sandbox();

    let projects_conn = get_projects_connection().expect("open projects.db");
    init_project_tables(&projects_conn).expect("init project schema");
    let project_tables_in_projects_db: i64 = projects_conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='table' AND name IN ('projects','workitems','labels')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        project_tables_in_projects_db, 3,
        "projects.db must hold the project schema"
    );

    // The sandbox helper primes only the sessions.db chain, never the
    // project schema, so the project tables must be absent there.
    let sessions_path = database::db::get_db_path();
    let sessions_conn = rusqlite::Connection::open(&sessions_path).expect("open sessions.db");
    let project_tables_in_sessions_db: i64 = sessions_conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='table' AND name IN ('projects','workitems','labels')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        project_tables_in_sessions_db, 0,
        "sessions.db must NOT hold project tables after the split"
    );

    let expected = sandbox.path().join("projects").join("projects.db");
    assert!(
        expected.exists(),
        "physical projects.db missing: {:?}",
        expected
    );
}

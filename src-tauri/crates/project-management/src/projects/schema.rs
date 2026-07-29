//! Schema DDL for the centralized project store.
//!
//! Local-truth tables:
//! - `project_orgs`       — ORG containers for projects and work items
//! - `projects`          — project metadata
//! - `workitems`        — work item core columns (hot path: title, status, priority, body)
//! - `workitem_extras`  — JSON blob for low-cardinality fields (todos, comments, delegation, …)
//! - `workitem_labels`  — label association (m:n)
//! - `labels`           — global label catalog (per-project, scoped via `project_id`)
//! - `milestones`       — milestone catalog (per-project)
//! - `members`          — known project members / assignees
//! - `routine_definitions` — durable automation definitions that launch agent runs
//! - `routine_fires`    — provenance for each routine occurrence
//!
//! Sync tables:
//! - `outbox_entries`   — durable replay log for external sync adapters
//! - `webhook_secrets`  — per-(slug, adapter) HMAC secrets for inbound
//!   webhook signature verification
//! - `import_progress`  — per-(slug, adapter) bulk historical import
//!   cursor + state, written by the worker's import task.
//!   One row per attached adapter; NULL row means "no import has run
//!   yet" so first attach kicks one off.
//! - `outbox_conflicts` — per-(slug, work_item) snapshot of inbound
//!   `merge_external` rows where the resolver kept-local at least
//!   one writable field whose `FieldRevision.source = "local"` lost
//!   to a fresher remote write. The resolver still applies its
//!   verdict; the conflict row is the audit + fix-up handle.
//!
//! All DDL uses `IF NOT EXISTS` so re-running is idempotent. The single
//! entry point is `init_project_tables(conn)`, called from
//! `database::db::connection::init_all_schemas`.

use rusqlite::{Connection, Result as SqliteResult};

/// Initialize all project-store tables and indexes.
///
/// Called once per physical DB path per process via the shared
/// connection pool. Safe to invoke against an existing DB.
pub fn init_project_tables(conn: &Connection) -> SqliteResult<()> {
    init_local_tables(conn)?;
    crate::team_inbox::schema::init_team_inbox_tables(conn)?;
    init_outbox_table(conn)?;
    init_webhook_secrets_table(conn)?;
    init_import_progress_table(conn)?;
    init_outbox_conflicts_table(conn)?;
    init_linear_metadata_cache_table(conn)?;
    Ok(())
}

/// HMAC secrets table for inbound webhook verification.
///
/// One row per `(project_slug, adapter_id)` pair. The secret is
/// generated locally (CSPRNG, 32 bytes hex-encoded) when the user
/// installs a webhook from the UI; the install command surfaces it
/// once for the user to paste into the remote provider's webhook
/// configuration. Subsequent inbound deliveries are verified by the
/// listener using the per-adapter signature scheme (HMAC-SHA256 over
/// the raw body), so a leaked secret only compromises that one
/// project's webhook ingestion — not the auth token, not other
/// projects.
///
/// Public so the sync layer's tests can target the table in
/// isolation. Production code calls [`init_project_tables`] which
/// includes this.
pub fn init_webhook_secrets_table(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS webhook_secrets (
            project_slug    TEXT NOT NULL,
            adapter_id      TEXT NOT NULL,
            secret_hex      TEXT NOT NULL,           -- 64 hex chars (32 bytes)
            last_rotated_at INTEGER NOT NULL,        -- unix ms
            PRIMARY KEY (project_slug, adapter_id)
        );
        "#,
    )?;
    Ok(())
}

/// Bulk historical import progress.
///
/// One row per `(project_slug, adapter_id)` capturing where the
/// background import task is in its paginated walk of the remote
/// system's full history. The row is created when an adapter is
/// attached to a project that doesn't already have a finished
/// import; the worker's import loop advances `page_cursor` after
/// each successfully applied page, stamps `imported_count`, and
/// flips `state` to `'completed'` when the adapter signals
/// pagination exhausted.
///
/// `state` values (kept as a TEXT enum mirroring the typed
/// [`super::super::sync::types::ImportState`] in Rust):
/// - `'pending'`    — row exists, no page fetched yet (between
///   attach and the worker picking it up).
/// - `'running'`    — at least one page applied; cursor points
///   at the next page to fetch.
/// - `'completed'`  — adapter returned `next_page_cursor = None`;
///   `imported_count` is final.
/// - `'cancelled'`  — user clicked Cancel from the UI; the row
///   sticks around so we don't re-import on detach/re-attach.
/// - `'failed'`     — terminal failure (`SyncError::Permanent`).
///   `last_error` carries the message; the row is **not** deleted
///   so the UI can surface "import stopped, click retry."
///
/// `total_hint` is `NULL` until the adapter supplies a count
/// (Linear's GraphQL response carries `totalCount`; GitHub's
/// `Link: …rel="last"` header gives the same signal). Surfaced
/// to the UI for the "47 / 200" progress label; the absence of
/// a hint just shows the running counter.
///
/// Public so the sync layer's tests can target the table in
/// isolation.
pub fn init_import_progress_table(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS import_progress (
            project_slug    TEXT NOT NULL,
            adapter_id      TEXT NOT NULL,
            state           TEXT NOT NULL,           -- pending|running|completed|cancelled|failed
            page_cursor     TEXT,                    -- adapter-defined opaque cursor (NULL on first page)
            imported_count  INTEGER NOT NULL DEFAULT 0,
            total_hint      INTEGER,                 -- NULL when the adapter can't supply a count
            started_at      INTEGER NOT NULL,        -- unix ms (when the row was first created)
            updated_at      INTEGER NOT NULL,        -- unix ms (when last advanced)
            last_error      TEXT,                    -- non-NULL only when state='failed'
            PRIMARY KEY (project_slug, adapter_id)
        );
        CREATE INDEX IF NOT EXISTS idx_import_progress_state
            ON import_progress(state);
        "#,
    )?;
    Ok(())
}

/// Conflict audit log for inbound merges.
///
/// One row per `merge_external` row where the resolver decided to keep
/// **local** for at least one writable field whose existing
/// `FieldRevision.source = "local"` —— meaning the user had written
/// that field locally after the last successful merge, and the inbound
/// remote update is racing against an unsynced local edit.
///
/// The resolver's per-field verdict is still applied (some fields may
/// adopt remote, others keep local). The conflict row is captured so
/// the user can:
/// - **Use local**  — re-push the local value for the conflicting
///   fields (overrides the previously-applied remote-side adoption,
///   if any), via fresh `OutboxOp::Update` rows;
/// - **Use remote** — overwrite the local value with the remote one
///   the resolver kept-local on, stamping the remote revision so the
///   next merge cycle does not re-flag this as a conflict;
/// - **Dismiss**    — accept the resolver's verdict as-is. State
///   remains whatever the resolver wrote.
///
/// Schema notes:
/// - `fields_json` is the canonical conflict payload; see
///   [`super::super::sync::conflict_log::ConflictFieldsPayload`] for
///   the typed shape.
/// - `resolved_at IS NULL` partitions open vs resolved rows; the index
///   is anchored on that fact for the "list open conflicts" query.
/// - `resolution` is `NULL` while open and one of
///   `'use_local' | 'use_remote' | 'dismissed'` afterward.
/// - `source_outbox_id` is the merge_external row that produced this
///   conflict — kept for forensics; the row is GC'd on its own
///   schedule (7d) regardless of conflict resolution status.
pub fn init_outbox_conflicts_table(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS outbox_conflicts (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            project_slug      TEXT NOT NULL,
            adapter_id        TEXT NOT NULL,
            entity_type       TEXT NOT NULL,        -- mirrors EntityType enum (work_item|...)
            entity_id         TEXT NOT NULL,        -- short_id of the local row
            external_id       TEXT NOT NULL,        -- adapter's identifier for the remote row
            fields_json       TEXT NOT NULL,        -- ConflictFieldsPayload (typed)
            detected_at       INTEGER NOT NULL,     -- unix ms when the resolver flagged it
            resolved_at       INTEGER,              -- unix ms; NULL while open
            resolution        TEXT,                 -- use_local|use_remote|dismissed when set
            source_outbox_id  INTEGER               -- merge_external row id; NULL after that row is GC'd
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_conflicts_open
            ON outbox_conflicts(project_slug, resolved_at);
        CREATE INDEX IF NOT EXISTS idx_outbox_conflicts_entity
            ON outbox_conflicts(project_slug, entity_id);
        "#,
    )?;
    Ok(())
}

pub fn init_linear_metadata_cache_table(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS linear_metadata_cache (
            connection_id TEXT NOT NULL,
            scope         TEXT NOT NULL,
            scope_id      TEXT NOT NULL,
            payload_json  TEXT NOT NULL,
            fetched_at    INTEGER NOT NULL,
            expires_at    INTEGER NOT NULL,
            PRIMARY KEY (connection_id, scope, scope_id)
        );
        CREATE INDEX IF NOT EXISTS idx_linear_metadata_cache_expires
            ON linear_metadata_cache(expires_at);
        "#,
    )?;
    Ok(())
}

/// DDL for the six local-truth tables (projects, workitems, …, members).
///
/// Split out so the sync layer's tests can target the outbox in isolation
/// without dragging in the full project schema.
fn init_local_tables(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        -- ============================================
        -- project_orgs
        -- ============================================
        CREATE TABLE IF NOT EXISTS project_orgs (
            id                  TEXT PRIMARY KEY,
            name                TEXT NOT NULL,
            slug                TEXT NOT NULL,
            org_key             TEXT NOT NULL,
            source              TEXT NOT NULL DEFAULT 'local',
            sync_provider       TEXT NOT NULL DEFAULT 'none',
            sync_config_json    TEXT,
            sync_connection_id  TEXT,
            external_org_id     TEXT,
            created_at          INTEGER NOT NULL,
            updated_at          INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_project_orgs_slug ON project_orgs(slug);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_project_orgs_key ON project_orgs(org_key);
        CREATE INDEX IF NOT EXISTS idx_project_orgs_source ON project_orgs(source);

        INSERT OR IGNORE INTO project_orgs (
            id, name, slug, org_key, source, sync_provider, created_at, updated_at
        ) VALUES (
            'personal-org', 'Personal Org', 'personal-org', 'ORG', 'local', 'none', 0, 0
        );

        -- ============================================
        -- projects
        -- ============================================
        CREATE TABLE IF NOT EXISTS projects (
            id                  TEXT PRIMARY KEY,
            org_id              TEXT NOT NULL DEFAULT 'personal-org' REFERENCES project_orgs(id) ON DELETE RESTRICT,
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
            local_version       INTEGER NOT NULL DEFAULT 0,
            sync_kind           TEXT NOT NULL DEFAULT 'none',
            sync_config_json    TEXT,
            sync_connection_id  TEXT,
            sync_last_pull_at   INTEGER,
            sync_cursor_blob    TEXT,
            sync_last_webhook_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
        CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
        CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

        -- ============================================
        -- workitems  (hot columns: indexed and queried directly)
        -- ============================================
        CREATE TABLE IF NOT EXISTS workitems (
            id                TEXT PRIMARY KEY,
            org_id            TEXT NOT NULL DEFAULT 'personal-org' REFERENCES project_orgs(id) ON DELETE RESTRICT,
            project_id          TEXT REFERENCES projects(id) ON DELETE SET NULL,
            short_id          TEXT NOT NULL,
            title             TEXT NOT NULL,
            body              TEXT NOT NULL DEFAULT '',
            status            TEXT NOT NULL DEFAULT 'backlog',
            priority          TEXT NOT NULL DEFAULT 'none',
            assigned_human_id TEXT,
            assignee          TEXT,
            assignee_type     TEXT,
            milestone         TEXT,
            parent            TEXT,
            start_date        TEXT,
            target_date       TEXT,
            estimate          REAL,
            order_index       INTEGER NOT NULL DEFAULT 0,
            created_at        INTEGER NOT NULL,
            updated_at        INTEGER NOT NULL,
            completed_at      INTEGER,
            deleted_at         INTEGER,
            local_version     INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workitems_project_short_id
            ON workitems(project_id, short_id)
            WHERE project_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workitems_standalone_short_id
            ON workitems(org_id, short_id)
            WHERE project_id IS NULL;
        CREATE INDEX IF NOT EXISTS idx_workitems_org ON workitems(org_id);
        CREATE INDEX IF NOT EXISTS idx_workitems_org_status
            ON workitems(org_id, status);
        CREATE INDEX IF NOT EXISTS idx_workitems_project_status
            ON workitems(project_id, status);
        CREATE INDEX IF NOT EXISTS idx_workitems_assigned_human ON workitems(assigned_human_id);
        CREATE INDEX IF NOT EXISTS idx_workitems_assignee ON workitems(assignee);
        CREATE INDEX IF NOT EXISTS idx_workitems_parent ON workitems(parent);
        CREATE INDEX IF NOT EXISTS idx_workitems_milestone ON workitems(milestone);
        CREATE INDEX IF NOT EXISTS idx_workitems_updated_at ON workitems(updated_at);

        -- ============================================
        -- workitem_extras  (low-cardinality JSON blob: todos, comments,
        -- delegation, orchestrator config/state, follow_ups, proof_of_work,
        -- linked_sessions, custom fields)
        -- ============================================
        CREATE TABLE IF NOT EXISTS workitem_extras (
            work_item_id  TEXT PRIMARY KEY REFERENCES workitems(id) ON DELETE CASCADE,
            extras_json   TEXT NOT NULL DEFAULT '{}'
        );
        -- ============================================
        -- workitem_labels  (m:n)
        -- ============================================
        CREATE TABLE IF NOT EXISTS workitem_labels (
            work_item_id  TEXT NOT NULL REFERENCES workitems(id) ON DELETE CASCADE,
            label_id      TEXT NOT NULL,
            PRIMARY KEY (work_item_id, label_id)
        );
        CREATE INDEX IF NOT EXISTS idx_workitem_labels_label ON workitem_labels(label_id);

        -- ============================================
        -- labels (per-project)
        -- ============================================
        CREATE TABLE IF NOT EXISTS labels (
            id            TEXT NOT NULL,
            project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name          TEXT NOT NULL,
            color         TEXT,
            description   TEXT,
            created_at    INTEGER NOT NULL,
            PRIMARY KEY (project_id, id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_project_name
            ON labels(project_id, name);

        -- ============================================
        -- milestones (per-project)
        -- ============================================
        CREATE TABLE IF NOT EXISTS milestones (
            id            TEXT NOT NULL,
            project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name          TEXT NOT NULL,
            description   TEXT,
            target_date   TEXT,
            status        TEXT NOT NULL DEFAULT 'open',
            created_at    INTEGER NOT NULL,
            PRIMARY KEY (project_id, id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_milestones_project_name
            ON milestones(project_id, name);

        -- ============================================
        -- members (per-project)
        -- ============================================
        CREATE TABLE IF NOT EXISTS members (
            id            TEXT NOT NULL,
            project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            display_name  TEXT NOT NULL,
            email         TEXT,
            avatar_url    TEXT,
            kind          TEXT NOT NULL DEFAULT 'member', -- member | agent | org
            extras_json   TEXT,
            created_at    INTEGER NOT NULL,
            PRIMARY KEY (project_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_members_project ON members(project_id);

        -- ============================================
        -- routine_definitions / routine_fires
        -- ============================================
        CREATE TABLE IF NOT EXISTS routine_definitions (
            id                       TEXT PRIMARY KEY,
            name                     TEXT NOT NULL,
            description              TEXT NOT NULL DEFAULT '',
            enabled                  INTEGER NOT NULL DEFAULT 1,
            trigger_json             TEXT NOT NULL,
            run_template_json        TEXT NOT NULL,
            output_policy_json       TEXT NOT NULL DEFAULT '{}',
            created_at               INTEGER NOT NULL,
            updated_at               INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_routine_definitions_enabled
            ON routine_definitions(enabled);
        CREATE INDEX IF NOT EXISTS idx_routine_definitions_updated_at
            ON routine_definitions(updated_at);

        CREATE TABLE IF NOT EXISTS routine_fires (
            id                  TEXT PRIMARY KEY,
            routine_id          TEXT NOT NULL REFERENCES routine_definitions(id) ON DELETE CASCADE,
            fired_at            INTEGER NOT NULL,
            status              TEXT NOT NULL,
            session_id          TEXT,
            agent_org_run_id    TEXT,
            work_item_id        TEXT,
            coalesced_into_fire_id TEXT,
            idempotency_key     TEXT,
            started_at          INTEGER,
            completed_at        INTEGER,
            error               TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_routine_fires_routine_id
            ON routine_fires(routine_id, fired_at DESC);
        CREATE INDEX IF NOT EXISTS idx_routine_fires_session
            ON routine_fires(session_id);
        "#,
    )?;
    ensure_workitems_deleted_at_column(conn)?;
    ensure_projects_sync_columns(conn)?;
    ensure_collab_sync_columns(conn)?;
    ensure_routine_definitions_durable_columns(conn)?;
    ensure_routine_fires_durable_columns(conn)?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_workitems_deleted_at ON workitems(deleted_at)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_routine_fires_work_item ON routine_fires(work_item_id)",
        [],
    )?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_fires_idempotency ON routine_fires(idempotency_key) WHERE idempotency_key IS NOT NULL",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_routine_fires_status ON routine_fires(routine_id, status, fired_at DESC)",
        [],
    )?;
    // Drop the never-wired multi-assignee tables. Zero read/write paths ever
    // existed; rebuild the schema when multi-agent assignment actually ships.
    conn.execute("DROP TABLE IF EXISTS workitem_assigned_agents", [])?;
    conn.execute("DROP TABLE IF EXISTS workitem_reviewers", [])?;
    Ok(())
}

fn ensure_workitems_deleted_at_column(conn: &Connection) -> SqliteResult<()> {
    ensure_column(conn, "workitems", "deleted_at", "INTEGER")
}

/// Backfill the project-sync columns on DBs created before they were
/// added to the `projects` CREATE TABLE.
///
/// Fresh DBs already carry these columns from the DDL above, so
/// [`ensure_column`] is a no-op for them. Older DBs that created
/// `projects` without the sync surface get the columns added here —
/// without this, the worker's pull-cycle binding query fails with
/// `no such column: sync_connection_id`.
fn ensure_projects_sync_columns(conn: &Connection) -> SqliteResult<()> {
    for (column, definition) in [
        ("sync_kind", "TEXT NOT NULL DEFAULT 'none'"),
        ("sync_config_json", "TEXT"),
        ("sync_connection_id", "TEXT"),
        ("sync_last_pull_at", "INTEGER"),
        ("sync_cursor_blob", "TEXT"),
        ("sync_last_webhook_at", "INTEGER"),
    ] {
        ensure_column(conn, "projects", column, definition)?;
    }
    Ok(())
}

/// Last server row version applied/acknowledged for the `orgii_collab`
/// provider (design §16.4). NULL for rows that never synced. Kept as a
/// dedicated column because `local_version` is the local OCC counter
/// (bumped on every local write) and `sync_cursor_blob` is the
/// project-bound adapter's pull cursor — both have incompatible
/// semantics with a remote row version.
///
/// `projects.field_revisions_json` is the project counterpart of
/// `workitem_extras.field_revisions`: a JSON map of
/// `local field name → { mtime, source }` watermarks stamped on local
/// edits and on remote-adopted fields, consumed by the collab bridge's
/// per-field project merge. NULL / absent = never stamped (whole-row
/// fallback semantics).
fn ensure_collab_sync_columns(conn: &Connection) -> SqliteResult<()> {
    ensure_column(conn, "projects", "collab_remote_version", "INTEGER")?;
    ensure_column(conn, "projects", "field_revisions_json", "TEXT")?;
    ensure_column(conn, "workitems", "collab_remote_version", "INTEGER")
}

fn ensure_routine_definitions_durable_columns(conn: &Connection) -> SqliteResult<()> {
    ensure_column(
        conn,
        "routine_definitions",
        "output_policy_json",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    ensure_column(conn, "routine_definitions", "last_evaluated_at", "INTEGER")?;
    ensure_column(conn, "routine_definitions", "next_fire_at", "INTEGER")
}

fn ensure_routine_fires_durable_columns(conn: &Connection) -> SqliteResult<()> {
    for (column, definition) in [
        ("work_item_id", "TEXT"),
        ("coalesced_into_fire_id", "TEXT"),
        ("idempotency_key", "TEXT"),
        ("started_at", "INTEGER"),
        ("completed_at", "INTEGER"),
        ("error", "TEXT"),
    ] {
        ensure_column(conn, "routine_fires", column, definition)?;
    }
    Ok(())
}

fn ensure_column(
    conn: &Connection,
    table_name: &str,
    column_name: &str,
    column_definition: &str,
) -> SqliteResult<()> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for column in columns {
        if column? == column_name {
            return Ok(());
        }
    }
    conn.execute(
        &format!("ALTER TABLE {table_name} ADD COLUMN {column_name} {column_definition}"),
        [],
    )?;
    Ok(())
}

/// DDL for the sync outbox.
///
/// The outbox is a durable replay log: every local mutation that needs
/// to reach an external system (Linear, GitHub, …) appends a row
/// here, and the worker loop in `project_management::sync::worker`
/// drains pending rows by calling the matching `SyncAdapter::push`.
///
/// Public so the sync layer's unit tests can target an in-memory DB
/// without paying for the full project schema. Production code goes
/// through [`init_project_tables`].
pub fn init_outbox_table(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS outbox_entries (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            project_slug       TEXT NOT NULL,
            entity_type        TEXT NOT NULL,                  -- work_item | project | label | milestone | member
            entity_id          TEXT NOT NULL,                  -- short_id for work items, slug for projects, …
            op                 TEXT NOT NULL,                  -- create | update | delete | merge_external
            field_path         TEXT,                           -- dotted path within entity (NULL for create/delete)
            payload_json       TEXT NOT NULL DEFAULT '{}',
            created_at         INTEGER NOT NULL,               -- unix ms
            retry_count        INTEGER NOT NULL DEFAULT 0,
            last_attempted_at  INTEGER,
            last_error         TEXT,
            status             TEXT NOT NULL DEFAULT 'pending' -- pending | in_flight | succeeded | failed | abandoned
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_status_created
            ON outbox_entries(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_outbox_project_entity
            ON outbox_entries(project_slug, entity_type, entity_id);
        "#,
    )?;
    // `org_id` discriminates orgii_collab bridge rows (design §16.8): a
    // non-NULL org_id means the row is drained/acked by the TS
    // CollabSyncEngine through the `project_collab_outbox_*` commands,
    // never by the in-process worker — both worker claim paths filter
    // `org_id IS NULL`. Legacy rows (adapter-bound projects) keep NULL.
    ensure_column(conn, "outbox_entries", "org_id", "TEXT")?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_outbox_org_status
             ON outbox_entries(org_id, status, created_at)",
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
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
}

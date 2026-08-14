//! Atomic ownership of the redesigned Agent Org private SQLite namespace.
//!
//! Old releases may recreate the retired names after a downgrade. Every new
//! process therefore retires the exact known legacy set again; there is no
//! one-time marker. Redesigned data is treated more conservatively: on a
//! manifest mismatch the namespace epoch stored in
//! `agent_org_runtime_meta` decides the outcome — an older epoch is the
//! sanctioned retire-and-recreate path for deliberate DDL changes, a newer
//! epoch (user rolled the binary back) and any unexplained mismatch fail
//! closed. Failing closed is scoped: the caller records the failure in
//! [`super::availability`] instead of failing whole sessions.db init.

use std::collections::BTreeMap;

use rusqlite::{ffi, Connection, Error as SqliteError, OptionalExtension, Result as SqliteResult};

use super::{
    agent_inbox, agent_member_interventions, agent_org_plan_approvals, agent_org_runs,
    agent_org_tasks, agent_org_watchdog,
};

/// Version of the canonical runtime namespace as a whole.
///
/// Bump this constant together with any DDL change to a runtime table.
/// A namespace whose stored epoch is older than the binary's is retired
/// and recreated (destructive by design — runtime state is rebuildable);
/// a namespace with a newer epoch fails closed so a rolled-back binary
/// never mangles data created by a newer release.
const SCHEMA_EPOCH: i64 = 1;

const SCHEMA_EPOCH_KEY: &str = "schema_epoch";

const RUNTIME_TABLES: [&str; 14] = [
    "agent_org_runtime_meta",
    "agent_org_runtime_runs",
    "agent_org_runtime_run_progress",
    "agent_org_runtime_member_materializations",
    "agent_org_runtime_initial_inputs",
    "agent_org_runtime_plan_approvals",
    "agent_org_runtime_recovery_attempts",
    "agent_org_runtime_tasks",
    "agent_org_runtime_task_events",
    "agent_org_runtime_task_schema_migrations",
    "agent_org_runtime_inbox",
    "agent_org_runtime_inbox_materializations",
    "agent_org_runtime_inbox_delivery_resolutions",
    "agent_org_runtime_member_interventions",
];

const LEGACY_TABLES: [&str; 13] = [
    "agent_org_runs",
    "agent_org_run_progress",
    "agent_org_member_materializations",
    "agent_org_initial_inputs",
    "agent_org_plan_approvals",
    "agent_org_recovery_attempts",
    "agent_org_tasks",
    "agent_org_task_events",
    "agent_org_task_run_schema_migrations",
    "agent_inbox",
    "agent_inbox_materializations",
    "agent_inbox_delivery_resolutions",
    "agent_member_interventions",
];

const RUNTIME_OBJECTS_QUERY: &str = "SELECT type, name, tbl_name, sql
     FROM sqlite_master
     WHERE sql IS NOT NULL
       AND type IN ('table', 'index', 'trigger', 'view')
       AND (name LIKE 'agent_org_runtime_%' OR tbl_name LIKE 'agent_org_runtime_%')
     ORDER BY type, name";

const DROP_LEGACY_SCHEMA: &str = "DROP TABLE IF EXISTS agent_inbox_materializations;
     DROP TABLE IF EXISTS agent_inbox_delivery_resolutions;
     DROP TABLE IF EXISTS agent_inbox;
     DROP TABLE IF EXISTS agent_org_task_events;
     DROP TABLE IF EXISTS agent_org_task_run_schema_migrations;
     DROP TABLE IF EXISTS agent_org_tasks;
     DROP TABLE IF EXISTS agent_org_plan_approvals;
     DROP TABLE IF EXISTS agent_org_recovery_attempts;
     DROP TABLE IF EXISTS agent_member_interventions;
     DROP TABLE IF EXISTS agent_org_initial_inputs;
     DROP TABLE IF EXISTS agent_org_member_materializations;
     DROP TABLE IF EXISTS agent_org_run_progress;
     DROP TABLE IF EXISTS agent_org_runs;";

/// Epoch retire path: drop the canonical runtime namespace, children before
/// FK parents (`agent_org_runtime_runs` last).
const DROP_RUNTIME_SCHEMA: &str = "DROP TABLE IF EXISTS agent_org_runtime_meta;
     DROP TABLE IF EXISTS agent_org_runtime_inbox_materializations;
     DROP TABLE IF EXISTS agent_org_runtime_inbox_delivery_resolutions;
     DROP TABLE IF EXISTS agent_org_runtime_inbox;
     DROP TABLE IF EXISTS agent_org_runtime_task_events;
     DROP TABLE IF EXISTS agent_org_runtime_task_schema_migrations;
     DROP TABLE IF EXISTS agent_org_runtime_tasks;
     DROP TABLE IF EXISTS agent_org_runtime_plan_approvals;
     DROP TABLE IF EXISTS agent_org_runtime_recovery_attempts;
     DROP TABLE IF EXISTS agent_org_runtime_member_interventions;
     DROP TABLE IF EXISTS agent_org_runtime_initial_inputs;
     DROP TABLE IF EXISTS agent_org_runtime_member_materializations;
     DROP TABLE IF EXISTS agent_org_runtime_run_progress;
     DROP TABLE IF EXISTS agent_org_runtime_runs;";

type SchemaManifest = BTreeMap<(String, String), (String, String)>;

/// What `agent_org_runtime_meta` says about the namespace's epoch.
enum EpochReading {
    /// The meta table itself does not exist: the namespace predates the
    /// epoch mechanism. Treated as epoch 0, i.e. older than every binary
    /// that carries this code.
    PreEpoch,
    /// A well-formed stored epoch.
    Epoch(i64),
    /// The meta table exists but the epoch row is missing or garbled.
    Unreadable(String),
}

/// Outcome of the namespace decision for this boot.
enum NamespaceAction {
    /// No runtime tables at all: create the namespace from scratch.
    Fresh,
    /// Manifest and epoch both match this binary: nothing to do.
    Canonical,
    /// Stored epoch is older than [`SCHEMA_EPOCH`]: sanctioned
    /// retire-and-recreate (destructive by design).
    Recreate { from_epoch: i64 },
}

pub(super) fn initialize(conn: &Connection) -> SqliteResult<()> {
    let expected = expected_manifest()?;
    let tx = database::db::begin_immediate(conn)?;
    let runtime_table_count = count_known_tables(&tx, &RUNTIME_TABLES)?;

    let action = if runtime_table_count == 0 {
        NamespaceAction::Fresh
    } else {
        decide_existing_namespace_action(&tx, &expected)?
    };

    let legacy_table_count = count_known_tables(&tx, &LEGACY_TABLES)?;
    let legacy_object_count = count_legacy_objects(&tx)?;
    if legacy_table_count > 0 {
        // Destructive by design: record what is about to be dropped so a
        // data-loss report is diagnosable after the fact. Only paid when
        // legacy tables actually exist — steady-state boots skip it.
        let dropped = count_existing_table_rows(&tx, &LEGACY_TABLES)?;
        log_destructive_table_drops("legacy_retirement", &dropped);
    }
    tx.execute_batch(DROP_LEGACY_SCHEMA)?;

    let (fresh, recreated_from_epoch) = match action {
        NamespaceAction::Fresh => {
            create_runtime_schema(&tx)?;
            (true, None)
        }
        NamespaceAction::Canonical => (false, None),
        NamespaceAction::Recreate { from_epoch } => {
            let dropped = count_existing_table_rows(&tx, &RUNTIME_TABLES)?;
            tracing::warn!(
                event = "agent_org_runtime_namespace_retired",
                from_epoch,
                to_epoch = SCHEMA_EPOCH,
                "retiring Agent Org runtime namespace from an older schema epoch; runtime state is recreated fresh"
            );
            log_destructive_table_drops("epoch_recreate", &dropped);
            tx.execute_batch(DROP_RUNTIME_SCHEMA)?;
            create_runtime_schema(&tx)?;
            (false, Some(from_epoch))
        }
    };
    verify_manifest(&tx, &expected)?;

    // Receipt self-heal is O(existing data); it only needs to run after a
    // boot that changed the namespace (fresh create, epoch recreate, or a
    // legacy retirement). Canonical no-op boots skip it entirely.
    let destructive_boot = fresh || recreated_from_epoch.is_some() || legacy_table_count > 0;
    if destructive_boot {
        agent_inbox::repair_dangling_materializations(&tx)?;
    }
    let unknown_objects = unknown_agent_org_objects(&tx)?;
    tx.commit()?;

    // Dependency normalization has its own per-run transactions. Keep it
    // outside the schema cutover transaction while preserving the historical
    // init behavior for already-canonical runtime data.
    agent_org_tasks::normalize_runtime_data(conn)?;

    if !unknown_objects.is_empty() {
        tracing::warn!(
            event = "agent_org_unknown_schema_objects_preserved",
            objects = ?unknown_objects,
            "preserved schema objects outside the exact legacy retirement registry"
        );
    }
    tracing::info!(
        event = "agent_org_runtime_namespace_initialized",
        legacy_table_count,
        legacy_object_count,
        fresh,
        recreated_from_epoch,
        schema_epoch = SCHEMA_EPOCH,
        idempotent = !destructive_boot,
        "initialized isolated Agent Org runtime schema"
    );
    Ok(())
}

/// Decide what to do with a non-empty runtime namespace.
///
/// The stored epoch is the authority whenever it is readable:
/// - epoch < binary → sanctioned retire-and-recreate (deliberate DDL
///   change; also covers pre-epoch namespaces without a meta table),
/// - epoch > binary → fail closed: the namespace was created by a newer
///   version and this rolled-back binary must not touch it,
/// - epoch == binary → the manifest must match exactly; any mismatch is
///   corruption and fails closed (scoped via `availability`),
/// - unreadable epoch row → corruption, fail closed.
fn decide_existing_namespace_action(
    conn: &Connection,
    expected: &SchemaManifest,
) -> SqliteResult<NamespaceAction> {
    let manifest_state = verify_manifest(conn, expected);
    match read_schema_epoch(conn)? {
        EpochReading::Epoch(epoch) if epoch > SCHEMA_EPOCH => Err(schema_error(format!(
            "Agent Org runtime namespace was created by a newer version \
             (schema epoch {epoch}, this binary supports {SCHEMA_EPOCH}); refusing to touch it"
        ))),
        EpochReading::Epoch(epoch) if epoch < SCHEMA_EPOCH => {
            Ok(NamespaceAction::Recreate { from_epoch: epoch })
        }
        EpochReading::PreEpoch => Ok(NamespaceAction::Recreate { from_epoch: 0 }),
        EpochReading::Epoch(_) => match manifest_state {
            Ok(()) => Ok(NamespaceAction::Canonical),
            Err(mismatch) => Err(mismatch),
        },
        EpochReading::Unreadable(detail) => Err(schema_error(format!(
            "unreadable Agent Org runtime schema epoch ({detail}); manifest {}",
            match manifest_state {
                Ok(()) => "matches".to_string(),
                Err(mismatch) => format!("mismatch: {mismatch}"),
            }
        ))),
    }
}

fn read_schema_epoch(conn: &Connection) -> SqliteResult<EpochReading> {
    let meta_exists: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master
             WHERE type='table' AND name='agent_org_runtime_meta'
         )",
        [],
        |row| row.get(0),
    )?;
    if !meta_exists {
        return Ok(EpochReading::PreEpoch);
    }
    let value: Option<String> = match conn
        .query_row(
            "SELECT value FROM agent_org_runtime_meta WHERE key=?1",
            [SCHEMA_EPOCH_KEY],
            |row| row.get(0),
        )
        .optional()
    {
        Ok(value) => value,
        // A meta table whose shape cannot even answer the query is as
        // unreadable as a missing row.
        Err(error) => return Ok(EpochReading::Unreadable(error.to_string())),
    };
    Ok(match value {
        None => EpochReading::Unreadable("schema_epoch row is missing".to_string()),
        Some(raw) => match raw.trim().parse::<i64>() {
            Ok(epoch) if epoch >= 0 => EpochReading::Epoch(epoch),
            _ => EpochReading::Unreadable(format!(
                "schema_epoch value {raw:?} is not a non-negative integer"
            )),
        },
    })
}

fn create_runtime_schema(conn: &Connection) -> SqliteResult<()> {
    create_meta_schema(conn)?;
    agent_org_runs::create_schema(conn)?;
    agent_inbox::create_schema(conn)?;
    agent_org_tasks::create_schema(conn)?;
    agent_org_plan_approvals::create_schema(conn)?;
    agent_member_interventions::create_schema(conn)?;
    agent_org_watchdog::create_schema(conn)
}

/// Namespace metadata, currently only the schema epoch. Lives inside the
/// canonical namespace (and therefore inside the manifest) so the epoch is
/// dropped and recreated together with the tables it describes.
fn create_meta_schema(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT OR REPLACE INTO agent_org_runtime_meta(key, value)
            VALUES ('{SCHEMA_EPOCH_KEY}', '{SCHEMA_EPOCH}');"
    ))
}

fn expected_manifest() -> SqliteResult<SchemaManifest> {
    let expected = Connection::open_in_memory()?;
    expected.execute_batch("PRAGMA foreign_keys=ON;")?;
    create_runtime_schema(&expected)?;
    read_manifest(&expected)
}

fn verify_manifest(conn: &Connection, expected: &SchemaManifest) -> SqliteResult<()> {
    let actual = read_manifest(conn)?;
    if &actual == expected {
        return Ok(());
    }

    let missing = expected
        .keys()
        .filter(|key| !actual.contains_key(*key))
        .cloned()
        .collect::<Vec<_>>();
    let unexpected = actual
        .keys()
        .filter(|key| !expected.contains_key(*key))
        .cloned()
        .collect::<Vec<_>>();
    let changed = expected
        .iter()
        .filter(|(key, value)| actual.get(*key).is_some_and(|item| item != *value))
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    Err(schema_error(format!(
        "unknown Agent Org runtime schema; missing={missing:?}, unexpected={unexpected:?}, changed={changed:?}"
    )))
}

fn read_manifest(conn: &Connection) -> SqliteResult<SchemaManifest> {
    let mut statement = conn.prepare(RUNTIME_OBJECTS_QUERY)?;
    let rows = statement.query_map([], |row| {
        let object_type: String = row.get(0)?;
        let name: String = row.get(1)?;
        let table_name: String = row.get(2)?;
        let sql: String = row.get(3)?;
        Ok(((object_type, name), (table_name, sql.trim().to_string())))
    })?;
    rows.collect()
}

/// Row counts for the subset of `names` that exist as tables.
///
/// Used by every destructive path (legacy retirement, epoch recreate) right
/// before its `DROP TABLE`s so the log records exactly what was destroyed.
/// Never called on steady-state boots.
fn count_existing_table_rows(
    conn: &Connection,
    names: &[&str],
) -> SqliteResult<Vec<(String, i64)>> {
    let mut counts = Vec::new();
    for name in names {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [name],
            |row| row.get(0),
        )?;
        if !exists {
            continue;
        }
        let rows: i64 =
            conn.query_row(&format!("SELECT COUNT(*) FROM \"{name}\""), [], |row| {
                row.get(0)
            })?;
        counts.push(((*name).to_string(), rows));
    }
    Ok(counts)
}

fn log_destructive_table_drops(context: &'static str, counts: &[(String, i64)]) {
    for (table, rows) in counts {
        tracing::warn!(
            event = "agent_org_destructive_table_drop",
            context,
            table = %table,
            rows,
            "dropping Agent Org table together with its rows"
        );
    }
}

fn count_known_tables(conn: &Connection, names: &[&str]) -> SqliteResult<usize> {
    let mut statement = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut count = 0;
    for row in rows {
        if names.contains(&row?.as_str()) {
            count += 1;
        }
    }
    Ok(count)
}

fn count_legacy_objects(conn: &Connection) -> SqliteResult<usize> {
    let mut statement = conn.prepare(
        "SELECT name, tbl_name FROM sqlite_master
         WHERE type IN ('table', 'index', 'trigger', 'view')",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut count = 0;
    for row in rows {
        let (name, table_name) = row?;
        if LEGACY_TABLES.contains(&name.as_str()) || LEGACY_TABLES.contains(&table_name.as_str()) {
            count += 1;
        }
    }
    Ok(count)
}

fn unknown_agent_org_objects(conn: &Connection) -> SqliteResult<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT name FROM sqlite_master
         WHERE type IN ('table', 'index', 'trigger', 'view')
           AND (name LIKE 'agent_org_%' OR name LIKE 'agent_inbox%' OR name LIKE 'agent_member_%')
         ORDER BY name",
    )?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut unknown = Vec::new();
    for row in rows {
        let name = row?;
        let known_runtime = name.starts_with("sqlite_autoindex_agent_org_runtime_")
            || read_known_runtime_object(conn, &name)?;
        if !known_runtime && !LEGACY_TABLES.contains(&name.as_str()) {
            unknown.push(name);
        }
    }
    Ok(unknown)
}

fn read_known_runtime_object(conn: &Connection, name: &str) -> SqliteResult<bool> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master
             WHERE name=?1
               AND (name LIKE 'agent_org_runtime_%' OR tbl_name LIKE 'agent_org_runtime_%')
         )",
        [name],
        |row| row.get(0),
    )
}

fn schema_error(message: String) -> SqliteError {
    SqliteError::SqliteFailure(ffi::Error::new(ffi::SQLITE_SCHEMA), Some(message))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    use super::*;

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory SQLite");
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .expect("enable foreign keys");
        conn
    }

    fn object_exists(conn: &Connection, object_type: &str, name: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM sqlite_master WHERE type=?1 AND name=?2
             )",
            rusqlite::params![object_type, name],
            |row| row.get(0),
        )
        .expect("inspect schema object")
    }

    fn row_count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap_or_else(|error| panic!("count {table}: {error}"))
    }

    fn create_legacy_fixture(conn: &Connection, table_count: usize, unknown_column: bool) {
        assert!(matches!(table_count, 5 | 9 | 11 | 13));
        let extra = if unknown_column {
            ", local_develop_column BLOB"
        } else {
            ""
        };
        conn.execute_batch(&format!(
            "CREATE TABLE agent_org_runs (id INTEGER PRIMARY KEY, payload TEXT{extra});
             INSERT INTO agent_org_runs VALUES (1, 'legacy-0'{unknown_value});
             CREATE TABLE agent_org_tasks (
                 id INTEGER PRIMARY KEY, org_run_id INTEGER NOT NULL, payload TEXT,
                 FOREIGN KEY(org_run_id) REFERENCES agent_org_runs(id) ON DELETE CASCADE
             );
             INSERT INTO agent_org_tasks VALUES (1, 1, 'legacy-1');
             CREATE TABLE agent_org_task_events (
                 id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, payload TEXT,
                 FOREIGN KEY(task_id) REFERENCES agent_org_tasks(id) ON DELETE CASCADE
             );
             INSERT INTO agent_org_task_events VALUES (1, 1, 'legacy-2');
             CREATE TABLE agent_inbox (
                 id INTEGER PRIMARY KEY, org_run_id INTEGER NOT NULL, payload TEXT,
                 FOREIGN KEY(org_run_id) REFERENCES agent_org_runs(id) ON DELETE CASCADE
             );
             INSERT INTO agent_inbox VALUES (1, 1, 'legacy-3');
             CREATE TABLE agent_member_interventions (
                 id INTEGER PRIMARY KEY, org_run_id INTEGER NOT NULL, payload TEXT,
                 FOREIGN KEY(org_run_id) REFERENCES agent_org_runs(id) ON DELETE CASCADE
             );
             INSERT INTO agent_member_interventions VALUES (1, 1, 'legacy-4');",
            unknown_value = if unknown_column { ", x'0102'" } else { "" },
        ))
        .expect("create five-table legacy fixture");
        if table_count >= 9 {
            conn.execute_batch(
                "CREATE TABLE agent_org_run_progress (
                     id INTEGER PRIMARY KEY, org_run_id INTEGER NOT NULL, payload TEXT,
                     FOREIGN KEY(org_run_id) REFERENCES agent_org_runs(id) ON DELETE CASCADE
                 );
                 INSERT INTO agent_org_run_progress VALUES (1, 1, 'legacy-5');
                 CREATE TABLE agent_org_plan_approvals (
                     id INTEGER PRIMARY KEY, org_run_id INTEGER NOT NULL, payload TEXT,
                     FOREIGN KEY(org_run_id) REFERENCES agent_org_runs(id) ON DELETE CASCADE
                 );
                 INSERT INTO agent_org_plan_approvals VALUES (1, 1, 'legacy-6');
                 CREATE TABLE agent_org_recovery_attempts (
                     id INTEGER PRIMARY KEY, org_run_id INTEGER NOT NULL, payload TEXT,
                     FOREIGN KEY(org_run_id) REFERENCES agent_org_runs(id) ON DELETE CASCADE
                 );
                 INSERT INTO agent_org_recovery_attempts VALUES (1, 1, 'legacy-7');
                 CREATE TABLE agent_inbox_materializations (
                     id INTEGER PRIMARY KEY, inbox_id INTEGER NOT NULL, payload TEXT,
                     FOREIGN KEY(inbox_id) REFERENCES agent_inbox(id) ON DELETE CASCADE
                 );
                 INSERT INTO agent_inbox_materializations VALUES (1, 1, 'legacy-8');",
            )
            .expect("create nine-table legacy fixture");
        }
        if table_count >= 11 {
            conn.execute_batch(
                "CREATE TABLE agent_inbox_delivery_resolutions (
                     id INTEGER PRIMARY KEY, inbox_id INTEGER NOT NULL, payload TEXT,
                     FOREIGN KEY(inbox_id) REFERENCES agent_inbox(id) ON DELETE CASCADE
                 );
                 INSERT INTO agent_inbox_delivery_resolutions VALUES (1, 1, 'legacy-9');
                 CREATE TABLE agent_org_task_run_schema_migrations (
                     id INTEGER PRIMARY KEY, org_run_id INTEGER NOT NULL, payload TEXT,
                     FOREIGN KEY(org_run_id) REFERENCES agent_org_runs(id) ON DELETE CASCADE
                 );
                 INSERT INTO agent_org_task_run_schema_migrations VALUES (1, 1, 'legacy-10');",
            )
            .expect("create eleven-table legacy fixture");
        }
        if table_count >= 13 {
            conn.execute_batch(
                "CREATE TABLE agent_org_member_materializations (
                     id INTEGER PRIMARY KEY, org_run_id INTEGER NOT NULL, payload TEXT,
                     FOREIGN KEY(org_run_id) REFERENCES agent_org_runs(id) ON DELETE CASCADE
                 );
                 INSERT INTO agent_org_member_materializations VALUES (1, 1, 'legacy-11');
                 CREATE TABLE agent_org_initial_inputs (
                     id INTEGER PRIMARY KEY, org_run_id INTEGER NOT NULL, payload TEXT,
                     FOREIGN KEY(org_run_id) REFERENCES agent_org_runs(id) ON DELETE CASCADE
                 );
                 INSERT INTO agent_org_initial_inputs VALUES (1, 1, 'legacy-12');",
            )
            .expect("create thirteen-table legacy fixture");
        }
        conn.execute_batch(
            "CREATE INDEX idx_legacy_agent_org_runs_payload ON agent_org_runs(payload);
             CREATE TRIGGER trg_legacy_agent_org_runs_touch
             AFTER UPDATE ON agent_org_runs BEGIN SELECT 1; END;",
        )
        .expect("legacy index and trigger");
    }

    fn seed_shared_sentinels(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE agent_sessions (
                 id TEXT PRIMARY KEY, session_id TEXT UNIQUE, payload BLOB, org_member_id TEXT
             );
             CREATE TABLE agent_messages (
                 id TEXT PRIMARY KEY, session_id TEXT, payload BLOB
             );
             CREATE TABLE code_sessions (
                 id TEXT PRIMARY KEY, session_id TEXT UNIQUE, payload BLOB, org_member_id TEXT
             );
             CREATE TABLE session_turn_intents (id TEXT PRIMARY KEY, payload BLOB, org_run_id TEXT);
             CREATE TABLE projects (id TEXT PRIMARY KEY, payload BLOB);
             CREATE TABLE work_items (id TEXT PRIMARY KEY, payload BLOB);
             CREATE TABLE routines (id TEXT PRIMARY KEY, payload BLOB);
             CREATE TABLE usage_events (id TEXT PRIMARY KEY, payload BLOB);
             INSERT INTO agent_sessions VALUES ('rust', 'rust-session', x'000102', 'member-a');
             INSERT INTO agent_messages VALUES ('message', 'rust-session', x'030405');
             INSERT INTO code_sessions VALUES ('cli', 'cli-session', x'060708', 'member-b');
             INSERT INTO session_turn_intents VALUES ('intent', x'090A0B', 'run-a');
             INSERT INTO projects VALUES ('project', x'0C0D0E');
             INSERT INTO work_items VALUES ('work-item', x'0F1011');
             INSERT INTO routines VALUES ('routine', x'121314');
             INSERT INTO usage_events VALUES ('usage', x'151617');",
        )
        .expect("shared sentinels");
    }

    fn shared_sentinel_fingerprint(conn: &Connection) -> Vec<(String, String)> {
        [
            "agent_sessions",
            "agent_messages",
            "code_sessions",
            "session_turn_intents",
            "projects",
            "work_items",
            "routines",
            "usage_events",
        ]
        .into_iter()
        .map(|table| {
            let fingerprint = conn
                .query_row(&format!("SELECT hex(payload) FROM {table}"), [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap_or_else(|error| panic!("fingerprint {table}: {error}"));
            (table.to_string(), fingerprint)
        })
        .collect()
    }

    #[test]
    fn retires_every_historical_namespace_shape_without_touching_shared_data() {
        for (table_count, unknown_column) in
            [(5, false), (9, false), (11, false), (13, false), (13, true)]
        {
            let conn = connection();
            create_legacy_fixture(&conn, table_count, unknown_column);
            seed_shared_sentinels(&conn);
            let shared_before = shared_sentinel_fingerprint(&conn);

            initialize(&conn).expect("retire legacy namespace");

            for table in LEGACY_TABLES {
                assert!(!object_exists(&conn, "table", table), "retained {table}");
            }
            for table in RUNTIME_TABLES {
                assert!(object_exists(&conn, "table", table), "missing {table}");
                let expected_rows = if table == "agent_org_runtime_meta" {
                    1 // the schema_epoch row
                } else {
                    0
                };
                assert_eq!(
                    row_count(&conn, table),
                    expected_rows,
                    "fresh {table} row count"
                );
            }
            assert!(!object_exists(
                &conn,
                "index",
                "idx_legacy_agent_org_runs_payload"
            ));
            assert!(!object_exists(
                &conn,
                "trigger",
                "trg_legacy_agent_org_runs_touch"
            ));
            assert_eq!(shared_sentinel_fingerprint(&conn), shared_before);
        }
    }

    #[test]
    fn repeated_downgrade_cleanup_preserves_the_complete_canonical_runtime() {
        let conn = connection();
        initialize(&conn).expect("fresh runtime");
        conn.execute_batch(
            "INSERT INTO agent_org_runtime_runs (
                id, org_id, coordinator_agent_id, root_session_id,
                org_snapshot_json, entry_mode, status, created_at, updated_at
             ) VALUES (
                'team-a', 'org-a', 'coordinator-a', 'root-a', '{\"team\":\"A\"}',
                'standalone_session', 'idle', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
             );
             INSERT INTO agent_org_runtime_run_progress
                (org_run_id, work_revision, completion_requested, updated_at)
             VALUES ('team-a', 7, 1, '2026-08-01T00:00:00Z');
             INSERT INTO agent_org_runtime_member_materializations
                (org_run_id, member_id, agent_id, generation, session_id,
                 authority_class, status, created_at, updated_at)
             VALUES ('team-a', 'member-a', 'agent-a', 1, 'session-a',
                     'starting', 'succeeded', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
             INSERT INTO agent_org_runtime_initial_inputs
                (org_run_id, turn_intent_id, message_id, content, payload_json,
                 status, created_at, updated_at)
             VALUES ('team-a', 'turn-a', 'message-a', 'hello', '{}',
                     'dispatched', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
             INSERT INTO agent_org_runtime_tasks
                (id, org_run_id, subject, status, created_at, updated_at)
             VALUES ('task-a', 'team-a', 'Task A', 'completed',
                     '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
             INSERT INTO agent_org_runtime_task_events
                (id, org_run_id, task_id, event_type, created_at)
             VALUES ('event-a', 'team-a', 'task-a', 'completed', '2026-08-01T00:00:00Z');
             INSERT INTO agent_org_runtime_task_schema_migrations
                (name, org_run_id, applied_at)
             VALUES ('canonical_blocked_by_v1', 'team-a', '2026-08-01T00:00:00Z');
             INSERT INTO agent_org_runtime_inbox
                (recipient_agent_id, recipient_member_id, sender_agent_id,
                 sender_member_id, org_run_id, payload_kind, payload_json, created_at, read_at)
             VALUES ('agent-a', 'member-a', 'coordinator-a', 'coordinator', 'team-a',
                     'message', '{}', '2026-08-01T00:00:00Z', '2026-08-01T00:00:01Z');
             INSERT INTO agent_org_runtime_inbox_materializations
                (inbox_id, session_id, transcript_message_id, transcript_intent_id, materialized_at)
             VALUES (1, 'session-a', 'message-a', 'turn-a', '2026-08-01T00:00:01Z');
             INSERT INTO agent_org_runtime_inbox_delivery_resolutions
                (inbox_id, org_run_id, resolution_kind, resolved_by_member_id,
                 reason, created_at)
             VALUES (2, 'team-a', 'cancelled', 'coordinator', 'done', '2026-08-01T00:00:02Z');
             INSERT INTO agent_org_runtime_plan_approvals
                (approval_id, plan_revision_id, request_id, org_run_id, source_task_id,
                 source_member_id, source_session_id, root_session_id, policy, status,
                 plan_title, plan_path, plan_content, created_at)
             VALUES ('approval-a', 'revision-a', 'request-a', 'team-a', 'task-a',
                     'member-a', 'session-a', 'root-a', 'coordinator', 'approved',
                     'Plan', '/tmp/plan-a', '# plan', '2026-08-01T00:00:00Z');
             INSERT INTO agent_org_runtime_recovery_attempts
                (org_run_id, action_kind, target_key, reason_fingerprint, attempts,
                 next_allowed_at, updated_at)
             VALUES ('team-a', 'member_rewake', 'member-a', 'fingerprint', 1,
                     '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
             INSERT INTO agent_org_runtime_member_interventions
                (org_run_id, member_id, agent_id, session_id, status, entered_at,
                 last_user_activity_at, resume_after)
             VALUES ('team-a', 'member-a', 'agent-a', 'session-a', 'user_intervention',
                     '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2099-08-01T00:00:00Z');",
        )
        .expect("canonical Team A fixture");
        let before = RUNTIME_TABLES
            .into_iter()
            .map(|table| (table, row_count(&conn, table)))
            .collect::<Vec<_>>();

        for _ in 0..2 {
            create_legacy_fixture(&conn, 13, true);
            initialize(&conn).expect("re-upgrade cleanup");
            assert_eq!(
                RUNTIME_TABLES
                    .into_iter()
                    .map(|table| (table, row_count(&conn, table)))
                    .collect::<Vec<_>>(),
                before
            );
            for table in LEGACY_TABLES {
                assert!(!object_exists(&conn, "table", table));
            }
        }

        let snapshot: String = conn
            .query_row(
                "SELECT org_snapshot_json FROM agent_org_runtime_runs WHERE id='team-a'",
                [],
                |row| row.get(0),
            )
            .expect("preserved snapshot");
        assert_eq!(snapshot, "{\"team\":\"A\"}");
    }

    #[test]
    fn partial_or_unknown_runtime_schema_fails_closed_before_legacy_cleanup() {
        for mutate in ["partial", "changed", "extra_index"] {
            let conn = connection();
            initialize(&conn).expect("canonical runtime");
            conn.execute_batch("CREATE TABLE agent_org_runs (sentinel TEXT); INSERT INTO agent_org_runs VALUES ('legacy');")
                .expect("legacy sentinel");
            match mutate {
                "partial" => conn
                    .execute_batch("DROP TABLE agent_org_runtime_initial_inputs;")
                    .expect("make partial schema"),
                "changed" => {
                    conn.execute_batch(
                        "DROP TABLE agent_org_runtime_member_interventions;
                         CREATE TABLE agent_org_runtime_member_interventions (sentinel TEXT);",
                    )
                    .expect("make changed schema");
                }
                "extra_index" => conn
                    .execute_batch(
                        "CREATE INDEX idx_agent_org_runtime_unknown
                         ON agent_org_runtime_runs(updated_at);",
                    )
                    .expect("make unknown index"),
                _ => unreachable!(),
            }

            let error = initialize(&conn).expect_err("unknown runtime must fail closed");
            assert!(
                error.to_string().contains("Agent Org runtime schema"),
                "{error}"
            );
            assert_eq!(row_count(&conn, "agent_org_runs"), 1);
        }
    }

    fn seed_minimal_run(conn: &Connection) {
        conn.execute_batch(
            "INSERT INTO agent_org_runtime_runs (
                id, org_id, coordinator_agent_id, root_session_id,
                org_snapshot_json, entry_mode, status, created_at, updated_at
             ) VALUES (
                'epoch-run', 'org-a', 'coordinator-a', 'root-a', '{}',
                'standalone_session', 'idle', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
             );",
        )
        .expect("seed runtime run row");
    }

    fn stored_epoch(conn: &Connection) -> String {
        conn.query_row(
            "SELECT value FROM agent_org_runtime_meta WHERE key='schema_epoch'",
            [],
            |row| row.get(0),
        )
        .expect("read stored schema epoch")
    }

    #[test]
    fn older_epoch_namespace_is_retired_and_recreated() {
        // (a) Explicit older epoch with a manifest mismatch: the sanctioned
        //     retire-and-recreate path for a deliberate DDL change.
        // (b) Pre-epoch namespace (no meta table at all): treated as epoch 0.
        for variant in ["older_epoch", "pre_epoch"] {
            let conn = connection();
            initialize(&conn).expect("canonical runtime");
            seed_minimal_run(&conn);
            seed_shared_sentinels(&conn);
            let shared_before = shared_sentinel_fingerprint(&conn);
            match variant {
                "older_epoch" => conn
                    .execute_batch(
                        "UPDATE agent_org_runtime_meta SET value='0' WHERE key='schema_epoch';
                         DROP TABLE agent_org_runtime_initial_inputs;",
                    )
                    .expect("simulate an older-epoch namespace"),
                "pre_epoch" => conn
                    .execute_batch("DROP TABLE agent_org_runtime_meta;")
                    .expect("simulate a pre-epoch namespace"),
                _ => unreachable!(),
            }

            initialize(&conn).expect("epoch upgrade must recreate the namespace");

            for table in RUNTIME_TABLES {
                assert!(
                    object_exists(&conn, "table", table),
                    "{variant}: missing {table}"
                );
            }
            assert_eq!(
                row_count(&conn, "agent_org_runtime_runs"),
                0,
                "{variant}: recreate is destructive by design"
            );
            assert_eq!(stored_epoch(&conn), SCHEMA_EPOCH.to_string());
            assert_eq!(shared_sentinel_fingerprint(&conn), shared_before);
            verify_manifest(&conn, &expected_manifest().expect("expected manifest"))
                .expect("canonical manifest after epoch recreate");
        }
    }

    #[test]
    fn newer_epoch_namespace_fails_closed_with_rollback_diagnostic() {
        let conn = connection();
        initialize(&conn).expect("canonical runtime");
        seed_minimal_run(&conn);
        conn.execute(
            "UPDATE agent_org_runtime_meta SET value='2' WHERE key='schema_epoch'",
            [],
        )
        .expect("simulate a namespace created by a newer version");

        let error = initialize(&conn).expect_err("rolled-back binary must fail closed");
        assert!(error.to_string().contains("newer version"), "{error}");

        // Nothing was touched: the newer-version data survives intact.
        assert_eq!(row_count(&conn, "agent_org_runtime_runs"), 1);
        assert_eq!(stored_epoch(&conn), "2");
    }

    #[test]
    fn unreadable_epoch_fails_closed_as_corruption() {
        for mutate in [
            // Meta table intact but the epoch row is gone.
            "DELETE FROM agent_org_runtime_meta WHERE key='schema_epoch';",
            // Epoch row present but garbled.
            "UPDATE agent_org_runtime_meta SET value='not-a-number' WHERE key='schema_epoch';",
        ] {
            let conn = connection();
            initialize(&conn).expect("canonical runtime");
            seed_minimal_run(&conn);
            conn.execute_batch(mutate).expect("corrupt the epoch row");

            let error = initialize(&conn).expect_err("unreadable epoch must fail closed");
            assert!(
                error.to_string().contains("unreadable Agent Org runtime schema epoch"),
                "{error}"
            );
            assert_eq!(row_count(&conn, "agent_org_runtime_runs"), 1);
        }
    }

    #[test]
    fn create_failure_rolls_back_every_legacy_drop() {
        let conn = connection();
        create_legacy_fixture(&conn, 13, false);
        conn.execute_batch("CREATE VIEW agent_org_runtime_runs AS SELECT 1 AS id;")
            .expect("runtime name conflict");

        initialize(&conn).expect_err("runtime create must fail");

        for table in LEGACY_TABLES {
            assert!(
                object_exists(&conn, "table", table),
                "rollback lost {table}"
            );
            assert_eq!(row_count(&conn, table), 1);
        }
        assert!(object_exists(&conn, "view", "agent_org_runtime_runs"));
    }

    #[test]
    fn unknown_agent_org_objects_are_preserved() {
        let conn = connection();
        conn.execute_batch(
            "CREATE TABLE agent_org_local_experiment (sentinel TEXT);
             INSERT INTO agent_org_local_experiment VALUES ('keep');",
        )
        .expect("unknown table");

        initialize(&conn).expect("initialize around unknown object");

        assert_eq!(row_count(&conn, "agent_org_local_experiment"), 1);
    }

    #[test]
    fn concurrent_initializers_serialize_to_one_canonical_schema() {
        let directory = tempfile::tempdir().expect("temporary database directory");
        let path = directory.path().join("sessions.db");
        let barrier = Arc::new(Barrier::new(2));
        let handles = (0..2)
            .map(|_| {
                let path = path.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let conn = Connection::open(path).expect("open shared SQLite database");
                    conn.busy_timeout(Duration::from_secs(5))
                        .expect("set busy timeout");
                    conn.execute_batch("PRAGMA foreign_keys=ON;")
                        .expect("enable foreign keys");
                    barrier.wait();
                    initialize(&conn)
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            handle
                .join()
                .expect("initializer thread")
                .expect("initialize");
        }

        let conn = Connection::open(path).expect("reopen shared database");
        verify_manifest(&conn, &expected_manifest().expect("expected manifest"))
            .expect("canonical manifest after concurrent init");
        assert_eq!(
            count_known_tables(&conn, &RUNTIME_TABLES).unwrap(),
            RUNTIME_TABLES.len()
        );
    }

    #[test]
    fn destructive_drop_counting_reports_existing_tables_with_their_rows() {
        let conn = connection();
        create_legacy_fixture(&conn, 5, false);

        let counts =
            count_existing_table_rows(&conn, &LEGACY_TABLES).expect("count legacy tables");

        // Only the five existing fixture tables are reported; each carries
        // its seeded single row. Missing tables never appear.
        assert_eq!(counts.len(), 5);
        for (table, rows) in &counts {
            assert!(
                LEGACY_TABLES.contains(&table.as_str()),
                "unexpected {table}"
            );
            assert_eq!(*rows, 1, "{table} row count");
        }
        assert!(counts
            .iter()
            .any(|(table, _)| table == "agent_org_runs"));
        assert!(!counts
            .iter()
            .any(|(table, _)| table == "agent_org_run_progress"));

        // Retirement wipes them; a rerun reports nothing to destroy.
        initialize(&conn).expect("retire legacy fixture");
        assert!(count_existing_table_rows(&conn, &LEGACY_TABLES)
            .expect("count after retirement")
            .is_empty());
    }

    #[test]
    fn scoped_init_degrades_to_unavailable_without_failing_db_init() {
        use crate::coordination::availability;

        let conn = connection();
        initialize(&conn).expect("canonical runtime");
        conn.execute_batch("DROP TABLE agent_org_runtime_initial_inputs;")
            .expect("corrupt the runtime namespace");

        // The production startup entry: coordinator failure is scoped, not
        // propagated into whole sessions.db init failure.
        crate::coordination::init_agent_org_schemas_scoped(&conn);

        let reason =
            availability::agent_org_runtime_unavailable_reason().expect("failure recorded");
        assert!(reason.contains("Agent Org runtime schema"), "{reason}");

        // Connection-layer init proceeds: later initializers still run DDL
        // on the same connection, so ordinary chat keeps working.
        conn.execute_batch("CREATE TABLE ordinary_chat_sentinel (id INTEGER PRIMARY KEY);")
            .expect("whole-DB init continues past the coordinator failure");

        // Every Agent Org store entry acquires its connection through the
        // gate and receives the structured unavailable error.
        let error = availability::runtime_connection().expect_err("gated store entry");
        assert!(
            error
                .to_string()
                .contains(availability::AGENT_ORG_RUNTIME_UNAVAILABLE_PREFIX),
            "{error}"
        );

        // A later successful coordinator run restores availability.
        let healthy = connection();
        crate::coordination::init_agent_org_schemas_scoped(&healthy);
        assert!(availability::agent_org_runtime_unavailable_reason().is_none());
    }

    /// Guard for the per-boot O(data) fixes: a canonical no-op boot must
    /// execute exactly as many SQL statements on a database holding 2000
    /// inbox rows + 2000 receipts + 2000 tasks as on an empty one.
    /// Statement-count equality is robust where time thresholds are not.
    #[test]
    fn no_op_boot_statement_count_is_independent_of_data_scale() {
        use std::cell::Cell;

        thread_local! {
            static STATEMENTS: Cell<usize> = const { Cell::new(0) };
        }
        fn count_statement(_sql: &str) {
            STATEMENTS.with(|counter| counter.set(counter.get() + 1));
        }
        fn measured_no_op_boot(conn: &mut Connection) -> usize {
            conn.trace(Some(count_statement));
            STATEMENTS.with(|counter| counter.set(0));
            initialize(conn).expect("canonical no-op boot");
            conn.trace(None);
            STATEMENTS.with(|counter| counter.get())
        }

        // Baseline: fresh create, one settle boot, then a measured no-op.
        let mut empty = connection();
        initialize(&empty).expect("fresh init");
        initialize(&empty).expect("settle boot");
        let empty_statements = measured_no_op_boot(&mut empty);

        // Seeded: identical boot sequence with 20 runs, 2000 unread inbox
        // rows, 2000 materialization receipts, and 2000 tasks (100 per run,
        // inside the per-run limit) present.
        let mut seeded = connection();
        initialize(&seeded).expect("fresh init");
        seeded
            .execute_batch(
                "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<20)
                 INSERT INTO agent_org_runtime_runs (
                     id, org_id, coordinator_agent_id, root_session_id,
                     org_snapshot_json, entry_mode, status, created_at, updated_at
                 )
                 SELECT 'run-'||printf('%02d', n), 'org-scale', 'coordinator-a', 'root-'||n,
                        '{}', 'standalone_session', 'idle',
                        '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
                 FROM seq;
                 WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<2000)
                 INSERT INTO agent_org_runtime_inbox (
                     recipient_agent_id, recipient_member_id, sender_agent_id,
                     sender_member_id, org_run_id, payload_kind, payload_json,
                     created_at, read_at
                 )
                 SELECT 'agent-a', 'member-a', 'coordinator-a', 'coordinator',
                        'run-'||printf('%02d', 1+(n%20)), 'message', '{}',
                        '2026-08-01T00:00:00Z', NULL
                 FROM seq;
                 WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<2000)
                 INSERT INTO agent_org_runtime_inbox_materializations (
                     inbox_id, session_id, transcript_message_id,
                     transcript_intent_id, materialized_at
                 )
                 SELECT n, 'session-'||n, 'message-'||n, 'turn-'||n,
                        '2026-08-01T00:00:01Z'
                 FROM seq;
                 WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<2000)
                 INSERT INTO agent_org_runtime_tasks (
                     id, org_run_id, subject, description, status,
                     blocks_json, blocked_by_json, created_at, updated_at
                 )
                 SELECT 'task-'||n, 'run-'||printf('%02d', 1+(n%20)), 'Task '||n, '',
                        'pending', '[]', '[]',
                        '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
                 FROM seq;",
            )
            .expect("seed 20 runs, 2000 inbox rows, 2000 receipts, 2000 tasks");
        initialize(&seeded).expect("settle boot marks every run's normalization");
        let seeded_statements = measured_no_op_boot(&mut seeded);

        assert!(empty_statements > 0, "trace hook must observe the boot");
        assert_eq!(
            seeded_statements, empty_statements,
            "canonical no-op boot must execute a constant statement count \
             regardless of stored data volume"
        );
    }
}

//! Atomic ownership of the redesigned Agent Org private SQLite namespace.
//!
//! Old releases may recreate the retired names after a downgrade. Every new
//! process therefore retires the exact known legacy set again; there is no
//! one-time marker. Redesigned data is treated more conservatively: a partial
//! or structurally unknown runtime namespace fails closed before any legacy
//! object is dropped.

use std::collections::BTreeMap;

use rusqlite::{ffi, Connection, Error as SqliteError, Result as SqliteResult};

use super::{
    agent_inbox, agent_member_interventions, agent_org_archive, agent_org_final_summary,
    agent_org_formal_triggers, agent_org_pause, agent_org_plan_approvals, agent_org_run_completion,
    agent_org_runs, agent_org_task_handoffs, agent_org_tasks, agent_org_tool_receipts,
    agent_org_turn_contexts, agent_org_watchdog, agent_org_work_episodes,
};

const RUNTIME_TABLES: [&str; 30] = [
    "agent_org_runtime_runs",
    "agent_org_runtime_run_progress",
    "agent_org_runtime_work_episodes",
    "agent_org_runtime_work_episode_tasks",
    "agent_org_runtime_run_completion_certificates",
    "agent_org_runtime_final_summary_receipts",
    "agent_org_runtime_member_materializations",
    "agent_org_runtime_initial_inputs",
    "agent_org_runtime_plan_revisions",
    "agent_org_runtime_plan_decisions",
    "agent_org_runtime_recovery_attempts",
    "agent_org_runtime_tasks",
    "agent_org_runtime_task_events",
    "agent_org_runtime_task_annotations",
    "agent_org_runtime_task_execution_handoffs",
    "agent_org_runtime_inbox",
    "agent_org_runtime_inbox_materializations",
    "agent_org_runtime_inbox_delivery_resolutions",
    "agent_org_runtime_inbox_task_bindings",
    "agent_org_runtime_formal_trigger_receipts",
    "agent_org_runtime_formal_trigger_attempts",
    "agent_org_runtime_member_interventions",
    "agent_org_runtime_member_intervention_turns",
    "agent_org_runtime_member_dispatch_allocators",
    "agent_org_runtime_turn_contexts",
    "agent_org_runtime_pause_episodes",
    "agent_org_runtime_pause_handoffs",
    "agent_org_runtime_archive_episodes",
    "agent_org_runtime_archive_teardowns",
    "agent_org_runtime_tool_call_receipts",
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
       AND type IN ('table', 'index', 'trigger')
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

type SchemaManifest = BTreeMap<(String, String), (String, String)>;

pub(super) fn initialize(conn: &Connection) -> SqliteResult<()> {
    let expected = expected_manifest()?;
    let tx = database::db::begin_immediate(conn)?;
    let runtime_table_count = count_known_tables(&tx, &RUNTIME_TABLES)?;

    let (fresh, migrated_task_bindings, migrated_task_history_index) =
        match runtime_table_count {
        0 => (true, false, false),
        count if count == RUNTIME_TABLES.len() => {
            let missing_task_history_index = !object_exists_with_connection(
                &tx,
                "index",
                agent_org_tasks::HISTORY_PAGE_INDEX_NAME,
            )?;
            if missing_task_history_index {
                verify_previous_manifest(&tx, &expected, false, true)?;
                agent_org_tasks::create_history_page_index(&tx)?;
                verify_manifest(&tx, &expected)?;
            } else {
                verify_manifest(&tx, &expected)?;
            }
            (false, false, missing_task_history_index)
        }
        count if count + 1 == RUNTIME_TABLES.len()
            && !object_exists_with_connection(
                &tx,
                "table",
                "agent_org_runtime_inbox_task_bindings",
            )? =>
        {
            let missing_task_history_index = !object_exists_with_connection(
                &tx,
                "index",
                agent_org_tasks::HISTORY_PAGE_INDEX_NAME,
            )?;
            verify_previous_manifest(&tx, &expected, true, missing_task_history_index)?;
            agent_inbox::create_task_message_binding_schema(&tx)?;
            agent_inbox::backfill_task_message_bindings(&tx)?;
            if missing_task_history_index {
                agent_org_tasks::create_history_page_index(&tx)?;
            }
            verify_manifest(&tx, &expected)?;
            (false, true, missing_task_history_index)
        }
        count => {
            return Err(schema_error(format!(
                "partial Agent Org runtime schema: found {count} of {} canonical tables; only an empty namespace or the complete current manifest is accepted",
                RUNTIME_TABLES.len(),
            )))
        }
    };

    let legacy_table_count = count_known_tables(&tx, &LEGACY_TABLES)?;
    let legacy_object_count = count_legacy_objects(&tx)?;
    tx.execute_batch(DROP_LEGACY_SCHEMA)?;

    if fresh {
        create_runtime_schema(&tx)?;
    }
    verify_manifest(&tx, &expected)?;
    agent_inbox::repair_dangling_materializations(&tx)?;
    let unknown_objects = unknown_agent_org_objects(&tx)?;
    tx.commit()?;

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
        migrated_task_bindings,
        migrated_task_history_index,
        idempotent = !fresh,
        "initialized isolated Agent Org runtime schema"
    );
    Ok(())
}

fn verify_previous_manifest(
    conn: &Connection,
    expected: &SchemaManifest,
    without_task_bindings: bool,
    without_task_history_index: bool,
) -> SqliteResult<()> {
    let mut previous = expected.clone();
    if without_task_bindings {
        previous.retain(|(_object_type, name), (table_name, _sql)| {
            name != "agent_org_runtime_inbox_task_bindings"
                && name != "idx_agent_org_runtime_inbox_task_bindings_wake"
                && table_name != "agent_org_runtime_inbox_task_bindings"
        });
    }
    if without_task_history_index {
        previous.remove(&(
            "index".to_string(),
            agent_org_tasks::HISTORY_PAGE_INDEX_NAME.to_string(),
        ));
    }
    verify_manifest(conn, &previous)
}

fn object_exists_with_connection(
    conn: &Connection,
    object_type: &str,
    name: &str,
) -> SqliteResult<bool> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master WHERE type=?1 AND name=?2
         )",
        rusqlite::params![object_type, name],
        |row| row.get(0),
    )
}

fn create_runtime_schema(conn: &Connection) -> SqliteResult<()> {
    agent_org_runs::create_schema(conn)?;
    agent_org_work_episodes::create_schema(conn)?;
    agent_org_run_completion::create_schema(conn)?;
    agent_inbox::create_schema(conn)?;
    agent_org_formal_triggers::create_schema(conn)?;
    agent_org_tasks::create_schema(conn)?;
    agent_org_task_handoffs::create_schema(conn)?;
    agent_org_plan_approvals::create_schema(conn)?;
    agent_org_final_summary::create_schema(conn)?;
    agent_member_interventions::create_schema(conn)?;
    agent_org_watchdog::create_schema(conn)?;
    agent_org_turn_contexts::create_schema(conn)?;
    agent_org_pause::create_schema(conn)?;
    agent_org_archive::create_schema(conn)?;
    agent_org_tool_receipts::create_schema(conn)
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
         WHERE type IN ('table', 'index', 'trigger')",
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
         WHERE type IN ('table', 'index', 'trigger')
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
    use std::time::{Duration, Instant};

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
    fn run_ddl_allows_cancelled_outcome_but_rejects_cancelled_team_status() {
        let conn = connection();
        initialize(&conn).expect("initialize runtime schema");

        conn.execute(
            "INSERT INTO agent_org_runtime_runs (
                 id, org_id, coordinator_agent_id, entry_mode, status,
                 last_activity_outcome, created_at, updated_at
             ) VALUES (
                 'outcome-cancelled', 'org-a', 'coordinator-a',
                 'standalone_session', 'idle', 'cancelled',
                 '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
             )",
            [],
        )
        .expect("cancelled is a valid last_activity_outcome");

        let error = conn
            .execute(
                "INSERT INTO agent_org_runtime_runs (
                     id, org_id, coordinator_agent_id, entry_mode, status,
                     last_activity_outcome, created_at, updated_at
                 ) VALUES (
                     'status-cancelled', 'org-a', 'coordinator-a',
                     'standalone_session', 'cancelled', 'completed',
                     '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
                 )",
                [],
            )
            .expect_err("cancelled must not become an Agent Org Team status");
        assert!(
            matches!(
                error,
                SqliteError::SqliteFailure(ref code, _)
                    if code.code == rusqlite::ErrorCode::ConstraintViolation
            ),
            "unexpected SQLite error: {error}"
        );
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
                assert_eq!(row_count(&conn, table), 0, "fresh {table} not empty");
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
                (id, org_run_id, activation_generation, subject, status, execution_mode,
                 created_by_participant_id, source_turn_intent_id, created_at, updated_at)
             VALUES ('task-a', 'team-a', 1, 'Task A', 'pending', 'build',
                     'coordinator', 'turn-a',
                     '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
             INSERT INTO agent_org_runtime_task_events
                (id, org_run_id, task_id, event_type, actor_member_id, actor_kind, created_at)
             VALUES ('event-a', 'team-a', 'task-a', 'created', 'coordinator', 'graph_writer',
                     '2026-08-01T00:00:00Z');
             INSERT INTO agent_org_runtime_task_annotations
                (id, org_run_id, task_id, kind, body, actor_kind,
                 actor_participant_id, created_at)
             VALUES ('annotation-a', 'team-a', 'task-a', 'audit_note', 'fixture',
                     'graph_writer', 'coordinator', '2026-08-01T00:00:00Z');
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
             INSERT INTO agent_org_runtime_plan_revisions
                (plan_revision_id, org_run_id, source_task_id, source_member_id,
                 source_session_id, source_turn_intent_id, root_session_id,
                 revision_number, plan_title, plan_path, plan_content,
                 content_digest, created_at)
             VALUES ('revision-a', 'team-a', 'task-a', 'member-a',
                     'session-a', 'turn-a', 'root-a', 1, 'Plan', '/tmp/plan-a',
                     '# plan',
                     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                     '2026-08-01T00:00:00Z');
             INSERT INTO agent_org_runtime_plan_decisions
                (approval_id, plan_revision_id, request_id, policy, status,
                 decision_by, created_at, resolved_at)
             VALUES ('approval-a', 'revision-a', 'request-a', 'coordinator',
                     'approved', 'coordinator', '2026-08-01T00:00:00Z',
                     '2026-08-01T00:00:01Z');
             INSERT INTO agent_org_runtime_recovery_attempts
                (org_run_id, action_kind, target_key, reason_fingerprint, attempts,
                 next_allowed_at, updated_at)
             VALUES ('team-a', 'member_rewake', 'member-a', 'fingerprint', 1,
                     '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
             INSERT INTO agent_org_runtime_member_interventions
                (intervention_receipt_id,org_run_id,member_id,agent_id,session_id,
                 status,source_event_id,entered_at,last_user_activity_at,updated_at)
             VALUES ('intervention-a','team-a','member-a','agent-a','session-a','active',
                     'message-a','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',
                     '2026-08-01T00:00:00Z');",
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
    fn exact_previous_manifest_adds_history_page_index_without_touching_data() {
        let conn = connection();
        initialize(&conn).expect("create current runtime");
        conn.execute_batch(
            "INSERT INTO agent_org_runtime_runs (
                 id,org_id,coordinator_agent_id,entry_mode,status,created_at,updated_at
             ) VALUES (
                 'run-history-index-upgrade','org-a','coordinator-agent',
                 'standalone_session','running',
                 '2026-08-30T00:00:00Z','2026-08-30T00:00:00Z'
             );
             INSERT INTO agent_org_runtime_tasks (
                 id,org_run_id,activation_generation,subject,status,execution_mode,
                 created_by_participant_id,source_turn_intent_id,created_at,updated_at
             ) VALUES (
                 'task-history-index-upgrade','run-history-index-upgrade',1,
                 'Preserve this Task','pending','build','coordinator','turn-a',
                 '2026-08-30T00:00:00Z','2026-08-30T00:00:00Z'
             );
             DROP INDEX idx_agent_org_runtime_tasks_history_page;",
        )
        .expect("simulate exact previous manifest");

        initialize(&conn).expect("upgrade history page index");
        assert!(object_exists(
            &conn,
            "index",
            agent_org_tasks::HISTORY_PAGE_INDEX_NAME
        ));
        assert_eq!(row_count(&conn, "agent_org_runtime_tasks"), 1);
        initialize(&conn).expect("upgraded history index remains idempotent");
    }

    #[test]
    fn exact_previous_manifest_adds_and_backfills_task_message_bindings() {
        let conn = connection();
        conn.execute_batch(
            "CREATE TABLE session_turn_intents (
                 session_id TEXT NOT NULL,
                 turn_intent_id TEXT NOT NULL,
                 client_message_id TEXT,
                 org_run_id TEXT,
                 source TEXT NOT NULL,
                 status TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 PRIMARY KEY(session_id,turn_intent_id)
             );",
        )
        .expect("shared Turn intent schema");
        initialize(&conn).expect("create current runtime");
        let now = "2026-08-29T00:00:00Z";
        conn.execute_batch(
            "INSERT INTO agent_org_runtime_runs (
                 id,org_id,coordinator_agent_id,root_session_id,entry_mode,status,
                 activation_generation,created_at,updated_at
             ) VALUES (
                 'run-binding-upgrade','org-a','coordinator-agent','root-session',
                 'standalone_session','running',2,
                 '2026-08-29T00:00:00Z','2026-08-29T00:00:00Z'
             );
             INSERT INTO session_turn_intents (
                 session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
             ) VALUES (
                 'root-session','root-reply-turn','run-binding-upgrade',
                 'resume','completed','2026-08-29T00:00:00Z','2026-08-29T00:00:00Z'
             );
             INSERT INTO agent_org_runtime_turn_contexts (
                 session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
                 source_kind,source_id,activation_generation,created_at
             ) VALUES (
                 'root-session','root-reply-turn','run-binding-upgrade','coordinator',
                 'coordinator','root_turn','root-reply-turn',2,
                 '2026-08-29T00:00:00Z'
             );
             INSERT INTO agent_org_runtime_tasks (
                 id,org_run_id,activation_generation,subject,owner,status,execution_mode,
                 created_by_participant_id,source_turn_intent_id,created_at,updated_at
             ) VALUES (
                 'task-upgrade','run-binding-upgrade',2,'Upgrade task','member-a',
                 'in_progress','build','coordinator','root-reply-turn',
                 '2026-08-29T00:00:00Z','2026-08-29T00:00:00Z'
             );
             INSERT INTO agent_org_runtime_inbox (
                 recipient_agent_id,recipient_member_id,sender_agent_id,sender_member_id,
                 org_run_id,payload_kind,payload_json,created_at
             ) VALUES (
                 'member-agent','member-a','coordinator-agent','coordinator',
                 'run-binding-upgrade','plain',
                 '{\"kind\":\"plain\",\"summary\":\"reply\",\"text\":\"continue\"}',
                 '2026-08-29T00:00:00Z'
             );",
        )
        .expect("seed previous-release reply facts");
        let inbox_id = conn.last_insert_rowid();
        let result = serde_json::json!({
            "delivered": [{
                "inbox_id": inbox_id,
                "recipient_member_id": "member-a"
            }],
            "kind": "plain",
            "org_run_id": "run-binding-upgrade",
            "related_task_id": "task-upgrade",
            "sender_member_id": "coordinator"
        })
        .to_string();
        conn.execute(
            "INSERT INTO agent_org_runtime_tool_call_receipts (
                 org_run_id,session_id,turn_intent_id,call_id,tool_name,operation,
                 canonical_digest,result_text,created_at
             ) VALUES (
                 'run-binding-upgrade','root-session','root-reply-turn','call-reply',
                 'org_send_message','plain',?1,?2,?3
             )",
            rusqlite::params!["a".repeat(64), result, now],
        )
        .expect("seed exactly-once send receipt");

        conn.execute_batch(
            "DROP TABLE agent_org_runtime_inbox_task_bindings;
             DROP INDEX idx_agent_org_runtime_tasks_history_page;",
        )
        .expect("simulate exact previous runtime manifest");
        assert_eq!(
            count_known_tables(&conn, &RUNTIME_TABLES).unwrap(),
            RUNTIME_TABLES.len() - 1
        );

        initialize(&conn).expect("upgrade exact previous manifest");
        assert!(object_exists(
            &conn,
            "index",
            agent_org_tasks::HISTORY_PAGE_INDEX_NAME
        ));
        let binding: (String, String, String) = conn
            .query_row(
                "SELECT task_id,recipient_member_id,source_turn_intent_id
                 FROM agent_org_runtime_inbox_task_bindings WHERE inbox_id=?1",
                [inbox_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("backfilled exact task message binding");
        assert_eq!(
            binding,
            (
                "task-upgrade".to_string(),
                "member-a".to_string(),
                "root-reply-turn".to_string()
            )
        );
        initialize(&conn).expect("upgraded manifest remains idempotent");
    }

    #[test]
    fn partial_or_unknown_runtime_schema_fails_closed_before_legacy_cleanup() {
        for mutate in ["partial", "changed", "extra_index"] {
            let conn = connection();
            initialize(&conn).expect("canonical runtime");
            conn.execute_batch("CREATE TABLE agent_org_runs (sentinel TEXT); INSERT INTO agent_org_runs VALUES ('legacy');")
                .expect("legacy sentinel");
            match mutate {
                "partial" => {
                    conn.execute_batch(
                        "DROP TABLE agent_org_runtime_turn_contexts;
                         DROP TABLE agent_org_runtime_member_dispatch_allocators;",
                    )
                    .expect("make partial schema");
                    assert_eq!(
                        count_known_tables(&conn, &RUNTIME_TABLES).unwrap(),
                        RUNTIME_TABLES.len() - 2
                    );
                }
                "changed" => {
                    conn.execute_batch(
                        "DROP TABLE agent_org_runtime_member_intervention_turns;
                         DROP TABLE agent_org_runtime_member_interventions;
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

    #[test]
    fn incomplete_runtime_manifest_requires_an_isolated_database() {
        let conn = connection();
        initialize(&conn).expect("canonical pause runtime");
        conn.execute_batch(
            "DROP TABLE agent_org_runtime_pause_handoffs;
             DROP TABLE agent_org_runtime_pause_episodes;",
        )
        .expect("simulate an incomplete strict runtime manifest");
        assert_eq!(
            count_known_tables(&conn, &RUNTIME_TABLES).unwrap(),
            RUNTIME_TABLES.len() - 2
        );

        let error = initialize(&conn).expect_err("previous runtime must not be migrated in place");
        let expected_message = format!(
            "found {} of {} canonical tables",
            RUNTIME_TABLES.len() - 2,
            RUNTIME_TABLES.len()
        );
        assert!(
            error.to_string().contains(&expected_message),
            "unexpected strict-schema error: {error}"
        );
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
    fn measures_constant_scale_startup_paths() {
        const SAMPLES: usize = 25;
        let mut fresh = Vec::with_capacity(SAMPLES);
        let mut no_op = Vec::with_capacity(SAMPLES);
        let mut cleanup = Vec::with_capacity(SAMPLES);

        for _ in 0..SAMPLES {
            let conn = connection();
            let started = Instant::now();
            initialize(&conn).expect("fresh init");
            fresh.push(started.elapsed());

            let started = Instant::now();
            initialize(&conn).expect("canonical no-op init");
            no_op.push(started.elapsed());

            create_legacy_fixture(&conn, 13, true);
            let started = Instant::now();
            initialize(&conn).expect("legacy cleanup init");
            cleanup.push(started.elapsed());
        }

        fn summary(samples: &mut [Duration]) -> (Duration, Duration) {
            samples.sort_unstable();
            (samples[samples.len() / 2], *samples.last().unwrap())
        }
        let (fresh_median, fresh_max) = summary(&mut fresh);
        let (no_op_median, no_op_max) = summary(&mut no_op);
        let (cleanup_median, cleanup_max) = summary(&mut cleanup);
        eprintln!(
            "Agent Org schema init, {SAMPLES} samples: fresh median={fresh_median:?} max={fresh_max:?}; canonical no-op median={no_op_median:?} max={no_op_max:?}; 13-table cleanup median={cleanup_median:?} max={cleanup_max:?}"
        );
    }
}

use rusqlite::{params, Connection};

use super::*;

fn fixture() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "PRAGMA foreign_keys=ON;
         CREATE TABLE session_turn_intents (
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
    .unwrap();
    crate::coordination::agent_org_runs::create_schema(&conn).unwrap();
    crate::coordination::agent_org_turn_contexts::create_schema(&conn).unwrap();
    create_schema(&conn).unwrap();
    crate::coordination::agent_org_tasks::create_schema(&conn).unwrap();
    conn.execute_batch(
        "INSERT INTO agent_org_runtime_runs(
             id,org_id,coordinator_agent_id,root_session_id,entry_mode,status,
             activation_generation,created_at,updated_at
         ) VALUES ('run','org','coordinator','root','standalone_session','running',1,
                   '2026-08-28T00:00:00Z','2026-08-28T00:00:00Z');",
    )
    .unwrap();
    conn
}

fn insert_root_turn(conn: &Connection, turn_id: &str, source: &str, generation: i64) {
    conn.execute(
        "INSERT INTO session_turn_intents(
             session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
         ) VALUES ('root',?1,'run',?2,'running',?3,?3)",
        params![turn_id, source, "2026-08-28T00:00:00Z"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts(
             session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
             source_kind,source_id,activation_generation,created_at
         ) VALUES ('root',?1,'run','coordinator','coordinator',
                   'root_turn',?1,?2,?3)",
        params![turn_id, generation, "2026-08-28T00:00:00Z"],
    )
    .unwrap();
}

fn insert_task(conn: &Connection, task_id: &str, generation: i64, turn_id: &str) {
    conn.execute(
        "INSERT INTO agent_org_runtime_tasks(
             id,org_run_id,activation_generation,subject,status,execution_mode,
             created_by_participant_id,source_turn_intent_id,created_at,updated_at
         ) VALUES (?1,'run',?2,?1,'pending','build','coordinator',?3,?4,?4)",
        params![task_id, generation, turn_id, "2026-08-28T00:00:00Z"],
    )
    .unwrap();
}

#[test]
fn pause_resume_keeps_one_episode_and_next_mission_opens_another() {
    let conn = fixture();

    insert_root_turn(&conn, "turn-1", "user_submit", 1);
    insert_task(&conn, "before-pause", 1, "turn-1");
    let first = associate_task_in_tx(&conn, "run", "before-pause", 1, "turn-1").unwrap();

    // Pause/Resume advances authorization but must not split the mission.
    conn.execute(
        "UPDATE agent_org_runtime_runs SET activation_generation=3 WHERE id='run'",
        [],
    )
    .unwrap();
    insert_root_turn(&conn, "turn-3", "agent_org", 3);
    insert_task(&conn, "after-resume", 3, "turn-3");
    let resumed = associate_task_in_tx(&conn, "run", "after-resume", 3, "turn-3").unwrap();
    assert_eq!(resumed, first);
    assert_eq!(
        task_ids_with_connection(&conn, "run", &first).unwrap(),
        vec!["after-resume".to_string(), "before-pause".to_string()]
    );

    close_active_in_tx(
        &conn,
        "run",
        &first,
        WorkEpisodeClosure {
            activation_generation: 3,
            work_revision: 2,
            outcome: "cancelled",
            certificate_id: "certificate-1",
            closed_at: "2026-08-28T00:01:00Z",
        },
    )
    .unwrap();
    conn.execute(
        "UPDATE agent_org_runtime_runs SET activation_generation=4 WHERE id='run'",
        [],
    )
    .unwrap();
    insert_root_turn(&conn, "turn-4", "user_submit", 4);
    insert_task(&conn, "next-mission", 4, "turn-4");
    let second = associate_task_in_tx(&conn, "run", "next-mission", 4, "turn-4").unwrap();
    assert_ne!(second, first);
    assert_eq!(
        active_with_connection(&conn, "run")
            .unwrap()
            .unwrap()
            .sequence,
        2
    );
}

#[test]
fn new_user_mission_cannot_join_an_uncertified_episode() {
    let conn = fixture();
    insert_root_turn(&conn, "turn-1", "user_submit", 1);
    insert_task(&conn, "first-mission", 1, "turn-1");
    let episode = associate_task_in_tx(&conn, "run", "first-mission", 1, "turn-1").unwrap();

    insert_root_turn(&conn, "turn-2", "user_submit", 1);
    insert_task(&conn, "second-mission", 1, "turn-2");
    let error = associate_task_in_tx(&conn, "run", "second-mission", 1, "turn-2")
        .expect_err("a new user mission must not be mixed into an uncertified episode");
    assert_eq!(
        error,
        format!("{UNRESOLVED_EPISODE_NEW_MISSION_ERROR}:{episode}")
    );

    insert_root_turn(&conn, "turn-repair", "agent_org", 1);
    insert_task(&conn, "repair", 1, "turn-repair");
    assert_eq!(
        associate_task_in_tx(&conn, "run", "repair", 1, "turn-repair").unwrap(),
        episode,
        "an internal Coordinator wake may still repair the active episode"
    );
}

#[test]
fn user_turn_replacement_stays_in_the_active_episode() {
    let conn = fixture();
    insert_root_turn(&conn, "turn-1", "user_submit", 1);
    insert_task(&conn, "interrupted", 1, "turn-1");
    let episode = associate_task_in_tx(&conn, "run", "interrupted", 1, "turn-1").unwrap();

    insert_root_turn(&conn, "turn-repair", "user_submit", 1);
    insert_task(&conn, "replacement", 1, "turn-repair");
    assert_eq!(
        associate_replacement_task_in_tx(
            &conn,
            "run",
            "replacement",
            "interrupted"
        )
        .unwrap(),
        episode,
        "a replacement is bound to the interrupted task's active episode, not treated as a new mission"
    );
    assert_eq!(
        task_ids_with_connection(&conn, "run", &episode).unwrap(),
        vec!["interrupted".to_string(), "replacement".to_string()]
    );

    insert_task(&conn, "unrelated", 1, "turn-repair");
    let error = associate_task_in_tx(&conn, "run", "unrelated", 1, "turn-repair")
        .expect_err("the same user Turn still cannot add unrelated work");
    assert_eq!(
        error,
        format!("{UNRESOLVED_EPISODE_NEW_MISSION_ERROR}:{episode}")
    );
}

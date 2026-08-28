use rusqlite::{params, Connection};

use super::*;

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
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    crate::coordination::agent_org_runs::create_schema(&conn).unwrap();
    create_schema(&conn).unwrap();
    crate::coordination::agent_org_tasks::create_schema(&conn).unwrap();
    conn.execute_batch(
        "INSERT INTO agent_org_runtime_runs(
             id,org_id,coordinator_agent_id,entry_mode,status,
             activation_generation,created_at,updated_at
         ) VALUES ('run','org','coordinator','standalone_session','running',1,
                   '2026-08-28T00:00:00Z','2026-08-28T00:00:00Z');",
    )
    .unwrap();

    insert_task(&conn, "before-pause", 1, "turn-1");
    let first = associate_task_in_tx(&conn, "run", "before-pause", 1, "turn-1").unwrap();

    // Pause/Resume advances authorization but must not split the mission.
    conn.execute(
        "UPDATE agent_org_runtime_runs SET activation_generation=3 WHERE id='run'",
        [],
    )
    .unwrap();
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

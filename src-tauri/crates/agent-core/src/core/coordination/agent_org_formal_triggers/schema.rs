use rusqlite::Connection;

pub(super) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_formal_trigger_receipts (
            receipt_id TEXT PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            trigger_kind TEXT NOT NULL,
            trigger_id TEXT NOT NULL,
            trigger_revision INTEGER NOT NULL CHECK(trigger_revision >= 1),
            source_kind TEXT NOT NULL,
            target_member_id TEXT NOT NULL CHECK(target_member_id='coordinator'),
            inbox_id INTEGER,
            task_id TEXT,
            owner_member_id TEXT,
            source_turn_intent_id TEXT,
            task_output_digest TEXT CHECK(
                task_output_digest IS NULL OR length(task_output_digest)=64
            ),
            plan_revision_id TEXT,
            status TEXT NOT NULL CHECK(status IN ('pending','materialized','resolved')),
            doorbell_status TEXT NOT NULL CHECK(doorbell_status IN ('missing','delivered','suppressed')),
            doorbell_delivered_at TEXT,
            current_attempt INTEGER NOT NULL DEFAULT 0 CHECK(current_attempt >= 0),
            materialized_input_id TEXT,
            materialized_event_id TEXT,
            resolved_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(org_run_id,trigger_kind,trigger_id,trigger_revision),
            UNIQUE(inbox_id),
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE,
            FOREIGN KEY(inbox_id) REFERENCES agent_org_runtime_inbox(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_formal_trigger_pending
            ON agent_org_runtime_formal_trigger_receipts(
                org_run_id,status,doorbell_status,created_at,receipt_id
            );
        CREATE INDEX IF NOT EXISTS idx_agent_org_formal_trigger_missing_doorbell
            ON agent_org_runtime_formal_trigger_receipts(
                doorbell_status,status,org_run_id,created_at
            ) WHERE status='pending' AND doorbell_status='missing';
        CREATE INDEX IF NOT EXISTS idx_agent_org_formal_trigger_task
            ON agent_org_runtime_formal_trigger_receipts(org_run_id,task_id,created_at)
            WHERE task_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS agent_org_runtime_formal_trigger_attempts (
            receipt_id TEXT NOT NULL,
            attempt INTEGER NOT NULL CHECK(attempt >= 1),
            session_id TEXT NOT NULL,
            turn_intent_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued','running','failed','resolved')),
            materialized_input_id TEXT NOT NULL,
            materialized_event_id TEXT,
            typed_error TEXT,
            queued_at TEXT NOT NULL,
            started_at TEXT,
            terminal_at TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(receipt_id,attempt),
            FOREIGN KEY(receipt_id)
                REFERENCES agent_org_runtime_formal_trigger_receipts(receipt_id)
                ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_formal_trigger_one_active_attempt
            ON agent_org_runtime_formal_trigger_attempts(receipt_id)
            WHERE status IN ('queued','running');
        CREATE INDEX IF NOT EXISTS idx_agent_org_formal_trigger_attempt_turn
            ON agent_org_runtime_formal_trigger_attempts(
                session_id,turn_intent_id,status,receipt_id
            );",
    )
}

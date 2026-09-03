use rusqlite::Connection;

pub(super) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_final_summary_receipts (
            receipt_id TEXT PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            activation_generation INTEGER NOT NULL CHECK(activation_generation >= 1),
            certificate_id TEXT NOT NULL,
            evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64),
            attempt INTEGER NOT NULL CHECK(attempt >= 1),
            status TEXT NOT NULL CHECK(status IN (
                'pending','running','persisting','persisted','failed'
            )),
            coordinator_session_id TEXT NOT NULL CHECK(trim(coordinator_session_id) <> ''),
            turn_intent_id TEXT,
            retry_request_id TEXT,
            started_at TEXT,
            terminal_at TEXT,
            event_id TEXT,
            typed_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(certificate_id,attempt),
            UNIQUE(certificate_id,retry_request_id),
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE,
            FOREIGN KEY(certificate_id)
                REFERENCES agent_org_runtime_run_completion_certificates(id)
                ON DELETE CASCADE,
            CHECK((status='pending' AND turn_intent_id IS NULL AND started_at IS NULL)
               OR (status IN ('running','persisting','persisted','failed')
                   AND turn_intent_id IS NOT NULL AND started_at IS NOT NULL)),
            CHECK((status IN ('persisted','failed'))=(terminal_at IS NOT NULL)),
            CHECK((status='persisted')=(event_id IS NOT NULL)),
            CHECK((status='failed')=(typed_error IS NOT NULL))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_final_summary_one_active
            ON agent_org_runtime_final_summary_receipts(certificate_id)
            WHERE status IN ('pending','running','persisting');
        CREATE INDEX IF NOT EXISTS idx_agent_org_final_summary_run_current
            ON agent_org_runtime_final_summary_receipts(
                org_run_id,activation_generation,attempt DESC
            );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_final_summary_turn
            ON agent_org_runtime_final_summary_receipts(
                coordinator_session_id,turn_intent_id
            ) WHERE turn_intent_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_org_final_summary_public_timeline
            ON agent_org_runtime_final_summary_receipts(org_run_id,terminal_at,receipt_id)
            WHERE status IN ('persisted','failed');",
    )
}

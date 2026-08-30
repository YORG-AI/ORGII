//! Durable task authority carried by Coordinator -> Member plain messages.
//!
//! `org_send_message.related_task_id` is transport metadata rather than part
//! of `AgentMessage::Plain`. Keep the exact association in a normalized row
//! so wake admission and task-scoped Inbox drain never have to infer a Task
//! from prose or scan the unbounded tool-receipt history.

use rusqlite::{params, Connection, OptionalExtension};

use super::AgentInboxStore;

const BINDING_KIND: &str = "coordinator_task_message";

pub(crate) fn create_task_message_binding_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_inbox_task_bindings (
            inbox_id INTEGER PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            recipient_member_id TEXT NOT NULL,
            binding_kind TEXT NOT NULL CHECK(binding_kind='coordinator_task_message'),
            source_turn_intent_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(inbox_id)
                REFERENCES agent_org_runtime_inbox(id) ON DELETE CASCADE,
            FOREIGN KEY(org_run_id,task_id)
                REFERENCES agent_org_runtime_tasks(org_run_id,id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_inbox_task_bindings_wake
            ON agent_org_runtime_inbox_task_bindings(
                org_run_id,recipient_member_id,task_id,inbox_id
            );",
    )
}

impl AgentInboxStore {
    /// Bind a freshly inserted Coordinator plain message to the exact durable
    /// Task that authorized its delivery. The source Inbox row, Task, current
    /// generation, and Coordinator Turn are revalidated in this same writer
    /// transaction; zero affected rows is an invariant failure.
    pub(crate) fn bind_task_message_in_tx(
        conn: &Connection,
        org_run_id: &str,
        inbox_id: i64,
        task_id: &str,
        recipient_member_id: &str,
        source_turn_intent_id: &str,
    ) -> Result<(), String> {
        let now = chrono::Utc::now().to_rfc3339();
        let inserted = conn
            .execute(
                "INSERT INTO agent_org_runtime_inbox_task_bindings (
                     inbox_id,org_run_id,task_id,recipient_member_id,binding_kind,
                     source_turn_intent_id,created_at
                 )
                 SELECT inbox.id,inbox.org_run_id,task.id,inbox.recipient_member_id,
                        ?7,source_context.turn_intent_id,?6
                 FROM agent_org_runtime_inbox inbox
                 JOIN agent_org_runtime_tasks task
                   ON task.org_run_id=inbox.org_run_id
                  AND task.id=?3
                  AND task.owner=?4
                  AND task.status IN ('pending','in_progress')
                 JOIN agent_org_runtime_runs run
                   ON run.id=task.org_run_id
                  AND run.status='running'
                  AND run.activation_generation=task.activation_generation
                 JOIN agent_org_runtime_turn_contexts source_context
                   ON source_context.org_run_id=inbox.org_run_id
                  AND source_context.turn_intent_id=?5
                  AND source_context.participant_id='coordinator'
                  AND source_context.turn_kind='coordinator'
                  AND source_context.source_kind IN ('root_turn','group_root')
                  AND source_context.activation_generation=run.activation_generation
                 WHERE inbox.id=?2
                   AND inbox.org_run_id=?1
                   AND inbox.recipient_member_id=?4
                   AND inbox.sender_member_id='coordinator'
                   AND inbox.delivery_class='formal_work'
                   AND inbox.payload_kind='plain'",
                params![
                    org_run_id,
                    inbox_id,
                    task_id,
                    recipient_member_id,
                    source_turn_intent_id,
                    now,
                    BINDING_KIND,
                ],
            )
            .map_err(|error| error.to_string())?;
        if inserted != 1 {
            return Err(format!(
                "Coordinator task message binding rejected for Inbox {inbox_id}, Task {task_id}, Member {recipient_member_id}"
            ));
        }
        Ok(())
    }
}

/// Resolve the oldest exact Coordinator reply that can continue an already
/// running TaskExecution. Every predicate is backed by canonical durable
/// state; ordinary peer chat and stale-generation messages cannot grant Task
/// authority.
pub(crate) fn oldest_unread_task_message_binding_with_connection(
    conn: &Connection,
    org_run_id: &str,
    recipient_member_id: &str,
    task_id: Option<&str>,
) -> Result<Option<(i64, String)>, String> {
    conn.query_row(
        "SELECT inbox.id,binding.task_id
         FROM agent_org_runtime_inbox_task_bindings binding
         JOIN agent_org_runtime_inbox inbox ON inbox.id=binding.inbox_id
         JOIN agent_org_runtime_tasks task
           ON task.org_run_id=binding.org_run_id
          AND task.id=binding.task_id
          AND task.owner=binding.recipient_member_id
          AND task.status='in_progress'
         JOIN agent_org_runtime_runs run
           ON run.id=task.org_run_id
          AND run.status='running'
          AND run.activation_generation=task.activation_generation
         JOIN agent_org_runtime_turn_contexts source_context
           ON source_context.org_run_id=binding.org_run_id
          AND source_context.turn_intent_id=binding.source_turn_intent_id
          AND source_context.participant_id='coordinator'
          AND source_context.turn_kind='coordinator'
          AND source_context.source_kind IN ('root_turn','group_root')
          AND source_context.activation_generation=run.activation_generation
         WHERE binding.org_run_id=?1
           AND binding.recipient_member_id=?2
           AND binding.binding_kind=?3
           AND (?4 IS NULL OR binding.task_id=?4)
           AND inbox.org_run_id=binding.org_run_id
           AND inbox.recipient_member_id=binding.recipient_member_id
           AND inbox.sender_member_id='coordinator'
           AND inbox.delivery_class='formal_work'
           AND inbox.payload_kind='plain'
           AND inbox.read_at IS NULL
           AND NOT EXISTS (
               SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
               WHERE resolution.inbox_id=inbox.id
           )
           AND EXISTS (
               SELECT 1 FROM agent_org_runtime_turn_contexts task_context
               WHERE task_context.org_run_id=task.org_run_id
                 AND task_context.participant_id=task.owner
                 AND task_context.turn_kind='task_execution'
                 AND task_context.task_id=task.id
                 AND task_context.owner_member_id=task.owner
                 AND task_context.activation_generation=run.activation_generation
           )
         ORDER BY inbox.id ASC
         LIMIT 1",
        params![org_run_id, recipient_member_id, BINDING_KIND, task_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|error| error.to_string())
}

/// One-time additive migration for releases that persisted the association
/// only inside the exactly-once `org_send_message` receipt. The receipt's
/// delivered Inbox id, related Task id, Coordinator Turn, recipient, and Task
/// identity must all agree before a binding is reconstructed.
pub(crate) fn backfill_task_message_bindings(conn: &Connection) -> rusqlite::Result<usize> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO agent_org_runtime_inbox_task_bindings (
             inbox_id,org_run_id,task_id,recipient_member_id,binding_kind,
             source_turn_intent_id,created_at
         )
         SELECT DISTINCT inbox.id,inbox.org_run_id,task.id,inbox.recipient_member_id,
                         ?1,source_context.turn_intent_id,?2
         FROM agent_org_runtime_tool_call_receipts receipt
         JOIN agent_org_runtime_turn_contexts source_context
           ON source_context.org_run_id=receipt.org_run_id
          AND source_context.session_id=receipt.session_id
          AND source_context.turn_intent_id=receipt.turn_intent_id
          AND source_context.participant_id='coordinator'
          AND source_context.turn_kind='coordinator'
          AND source_context.source_kind IN ('root_turn','group_root')
         JOIN json_each(
             CASE WHEN json_valid(receipt.result_text)
                  THEN receipt.result_text ELSE '{}' END,
             '$.delivered'
         ) delivered
         JOIN agent_org_runtime_inbox inbox
           ON inbox.org_run_id=receipt.org_run_id
          AND inbox.id=json_extract(delivered.value,'$.inbox_id')
          AND inbox.recipient_member_id=json_extract(
              delivered.value,'$.recipient_member_id'
          )
          AND inbox.sender_member_id='coordinator'
          AND inbox.delivery_class='formal_work'
          AND inbox.payload_kind='plain'
         JOIN agent_org_runtime_tasks task
           ON task.org_run_id=inbox.org_run_id
          AND task.id=json_extract(
              CASE WHEN json_valid(receipt.result_text)
                   THEN receipt.result_text ELSE '{}' END,
              '$.related_task_id'
          )
          AND task.owner=inbox.recipient_member_id
         WHERE receipt.tool_name='org_send_message'
           AND receipt.operation='plain'
           AND json_type(
               CASE WHEN json_valid(receipt.result_text)
                    THEN receipt.result_text ELSE '{}' END,
               '$.related_task_id'
           )='text'
           AND json_type(delivered.value,'$.inbox_id')='integer'
           AND json_type(delivered.value,'$.recipient_member_id')='text'",
        params![BINDING_KIND, now],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binding_schema_is_idempotent() {
        let conn = Connection::open_in_memory().expect("open SQLite");
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE agent_org_runtime_inbox(id INTEGER PRIMARY KEY);
             CREATE TABLE agent_org_runtime_tasks(
                 org_run_id TEXT NOT NULL,id TEXT NOT NULL,
                 PRIMARY KEY(org_run_id,id)
             );",
        )
        .expect("dependency tables");
        create_task_message_binding_schema(&conn).expect("first create");
        create_task_message_binding_schema(&conn).expect("second create");
    }
}

/// Start an exact TaskExecution only after its durable turn input has been
/// materialized, and as the last lifecycle mutation before Provider work.
/// Revalidation and Pending -> InProgress commit in one IMMEDIATE transaction
/// so Pause, cancellation, reassignment, or activation changes fail closed.
pub(crate) fn start_task_execution_before_provider(
    session_id: &str,
    turn_intent_id: &str,
    projected_inbox_ids: &[i64],
) -> Result<Option<String>, String> {
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
        let context =
            crate::coordination::agent_org_turn_contexts::revalidate_context_with_connection(
                &tx,
                session_id,
                turn_intent_id,
            )?;
        let changed = crate::coordination::agent_org_tasks::AgentOrgTaskStore::
            start_task_execution_turn_in_tx(&tx, &context, projected_inbox_ids)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(changed.then_some(context.org_run_id))
    })
}

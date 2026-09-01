//! Bounded human-readable prose for the coordinator repair notice, plus the
//! read-only probe for whether a coordinator-notice budget row already exists.

use super::super::*;

pub(super) fn bounded_id_list_preview(
    ids: &[String],
    max_items: usize,
    max_chars_per_id: usize,
) -> String {
    let preview = ids
        .iter()
        .take(max_items)
        .map(|id| crate::utils::safe_truncate_chars_to_string(id, max_chars_per_id))
        .collect::<Vec<_>>()
        .join(", ");
    let omitted = ids.len().saturating_sub(max_items);
    if omitted > 0 {
        format!("{preview}, +{omitted} more (use task_list/task_get)")
    } else {
        preview
    }
}

pub(super) fn bounded_recovery_reason_text(reasons: &[String]) -> String {
    const MAX_REASON_CHARS: usize = 15_000;
    let mut out = String::new();
    let mut used = 0usize;
    let mut included = 0usize;
    for reason in reasons {
        let separator = usize::from(!out.is_empty());
        let remaining = MAX_REASON_CHARS.saturating_sub(used.saturating_add(separator));
        if remaining == 0 {
            break;
        }
        let bounded = crate::utils::safe_truncate_chars_to_string(reason, remaining);
        if !out.is_empty() {
            out.push('\n');
            used += 1;
        }
        used = used.saturating_add(bounded.chars().count());
        out.push_str(&bounded);
        included += 1;
        if bounded.chars().count() < reason.chars().count() {
            break;
        }
    }
    let omitted = reasons.len().saturating_sub(included);
    if omitted > 0 {
        let suffix = format!(
            "\n+{omitted} additional repair item(s); use task_list/task_get for the full board."
        );
        let keep = MAX_REASON_CHARS.saturating_sub(suffix.chars().count());
        out = crate::utils::safe_truncate_chars_to_string(&out, keep);
        out.push_str(&suffix);
    }
    out
}

pub(super) fn coordinator_notice_budget_exists_with_connection(
    conn: &Connection,
    run_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM agent_org_recovery_attempts
             WHERE org_run_id=?1 AND action_kind=?2 AND target_key='coordinator'
         )",
        params![run_id, COORDINATOR_NOTICE],
        |row| row.get(0),
    )
    .map_err(|err| err.to_string())
}

//! Shared payload limits for durable Agent Org state and inbox messages.
//!
//! These checks live at persistence boundaries as well as tool entry points:
//! an internal caller, migration, or future transport must not be able to
//! bypass the same resource contract the LLM-facing tools advertise.

pub const TASK_SUBJECT_MAX_CHARS: usize = 200;
pub const TASK_SUBJECT_MAX_BYTES: usize = TASK_SUBJECT_MAX_CHARS * 4;
pub const TASK_DESCRIPTION_MAX_CHARS: usize = 4_000;
pub const TASK_DESCRIPTION_MAX_BYTES: usize = TASK_DESCRIPTION_MAX_CHARS * 4;
/// Maximum description preview carried by paginated task summaries and the
/// frequently-polled Run View. Full durable descriptions remain available via
/// `task_get`.
pub const TASK_SUMMARY_DESCRIPTION_MAX_CHARS: usize = 512;
pub const TASK_SUMMARY_ID_PREVIEW_MAX_CHARS: usize = 256;
pub const TASK_SUMMARY_DEPENDENCY_PREVIEW_MAX_COUNT: usize = 8;
pub const TASK_SUMMARY_ELIGIBILITY_PREVIEW_MAX_COUNT: usize = 16;
pub const TASK_SUMMARY_ARTIFACT_PREVIEW_MAX_COUNT: usize = 16;
pub const TASK_SUMMARY_PAGE_MAX_BYTES: usize = 512 * 1024;
pub const TASK_OPEN_ID_PREVIEW_MAX_BYTES: usize = 16 * 1024;
pub const TASK_ACTIVE_FORM_MAX_CHARS: usize = 1_000;
pub const TASK_ACTIVE_FORM_MAX_BYTES: usize = TASK_ACTIVE_FORM_MAX_CHARS * 4;
/// A task identifier must remain small enough to cross every durable delivery
/// boundary, including `TaskAssigned` inbox messages. Existing historical
/// rows remain readable; all new task ids, dependency ids, and cursors are
/// bounded at their write/tool boundary.
pub const TASK_IDENTIFIER_MAX_CHARS: usize = MESSAGE_IDENTIFIER_MAX_CHARS;
pub const TASK_IDENTIFIER_MAX_BYTES: usize = MESSAGE_IDENTIFIER_MAX_BYTES;
pub const TASK_METADATA_MAX_BYTES: usize = 64 * 1024;
pub const TASK_REQUIRED_ROLE_MAX_CHARS: usize = 200;
pub const TASK_REQUIRED_ROLE_MAX_BYTES: usize = TASK_REQUIRED_ROLE_MAX_CHARS * 4;
pub const TASK_DEPENDENCY_MAX_COUNT: usize = 128;
pub const TASK_DEPENDENCY_TOTAL_MAX_CHARS: usize = 8_000;
pub const TASK_DEPENDENCY_TOTAL_MAX_BYTES: usize = TASK_DEPENDENCY_TOTAL_MAX_CHARS * 4;
pub const TASK_ELIGIBILITY_MAX_COUNT: usize = 128;
pub const TASK_ELIGIBILITY_TOTAL_MAX_CHARS: usize = 8_000;
pub const TASK_ELIGIBILITY_TOTAL_MAX_BYTES: usize = TASK_ELIGIBILITY_TOTAL_MAX_CHARS * 4;
/// Serialized JSON can expand quotes/control characters beyond the decoded
/// identifier total. This is the pre-parse ceiling used for historical rows.
pub const TASK_DEPENDENCY_JSON_MAX_BYTES: usize = 256 * 1024;
pub const RFC3339_TIMESTAMP_MAX_CHARS: usize = 64;
pub const RFC3339_TIMESTAMP_MAX_BYTES: usize = RFC3339_TIMESTAMP_MAX_CHARS * 4;
/// Maximum number of durable task rows that one Agent Org run may retain.
/// This is a run-level storage boundary, not a recommendation for how many
/// tasks a coordinator should create in one model tool call.
pub const TASK_RUN_MAX_TASKS: usize = 200;
/// LLM-facing request limit for one atomic `task_graph_create` call. Keeping
/// this separate from [`TASK_RUN_MAX_TASKS`] avoids teaching coordinators to
/// create 200-node graphs merely because the database can retain that many.
pub const TASK_GRAPH_CREATE_MAX_TASKS: usize = 32;

pub const PLAIN_SUMMARY_MAX_CHARS: usize = 200;
pub const PLAIN_SUMMARY_MAX_BYTES: usize = PLAIN_SUMMARY_MAX_CHARS * 4;
pub const PLAIN_TEXT_MAX_CHARS: usize = 20_000;
pub const PLAIN_TEXT_MAX_BYTES: usize = PLAIN_TEXT_MAX_CHARS * 4;
pub const PLAN_FEEDBACK_MAX_CHARS: usize = 8_000;
pub const PLAN_FEEDBACK_MAX_BYTES: usize = PLAN_FEEDBACK_MAX_CHARS * 4;

pub const PLAN_TITLE_MAX_CHARS: usize = 200;
pub const PLAN_TITLE_MAX_BYTES: usize = PLAN_TITLE_MAX_CHARS * 4;
pub const PLAN_PATH_MAX_CHARS: usize = 4_096;
pub const PLAN_PATH_MAX_BYTES: usize = PLAN_PATH_MAX_CHARS * 4;
pub const PLAN_CONTENT_MAX_CHARS: usize = 200_000;
pub const PLAN_CONTENT_MAX_BYTES: usize = 256 * 1024;
pub const INLINE_PLAN_CONTENT_MAX_CHARS: usize = 20_000;
pub const INLINE_PLAN_CONTENT_MAX_BYTES: usize = INLINE_PLAN_CONTENT_MAX_CHARS * 4;

pub const TASK_OUTPUT_SUMMARY_MAX_CHARS: usize = 1_000;
pub const TASK_OUTPUT_SUMMARY_MAX_BYTES: usize = TASK_OUTPUT_SUMMARY_MAX_CHARS * 4;
pub const TASK_OUTPUT_CONTENT_MAX_CHARS: usize = 20_000;
pub const TASK_OUTPUT_CONTENT_MAX_BYTES: usize = TASK_OUTPUT_CONTENT_MAX_CHARS * 4;
pub const TASK_ARTIFACT_ID_MAX_CHARS: usize = 1_000;
pub const TASK_ARTIFACT_ID_MAX_BYTES: usize = TASK_ARTIFACT_ID_MAX_CHARS * 4;
pub const TASK_ARTIFACT_ID_MAX_COUNT: usize = 64;
pub const TASK_ARTIFACT_IDS_TOTAL_MAX_CHARS: usize = 16_000;
pub const TASK_ARTIFACT_IDS_TOTAL_MAX_BYTES: usize = TASK_ARTIFACT_IDS_TOTAL_MAX_CHARS * 4;

pub const MEMBER_SUMMARY_MAX_CHARS: usize = 500;
pub const MEMBER_SUMMARY_MAX_BYTES: usize = MEMBER_SUMMARY_MAX_CHARS * 4;
pub const MEMBER_DISPLAY_NAME_MAX_CHARS: usize = 200;
pub const MEMBER_DISPLAY_NAME_MAX_BYTES: usize = MEMBER_DISPLAY_NAME_MAX_CHARS * 4;
pub const ASSIGNED_BY_MAX_CHARS: usize = 200;
pub const ASSIGNED_BY_MAX_BYTES: usize = ASSIGNED_BY_MAX_CHARS * 4;
pub const MEMBER_FAILURE_REASON_MAX_CHARS: usize = 4_000;
pub const MEMBER_FAILURE_REASON_MAX_BYTES: usize = MEMBER_FAILURE_REASON_MAX_CHARS * 4;
pub const EXEC_MODE_REASON_MAX_CHARS: usize = 500;
pub const EXEC_MODE_REASON_MAX_BYTES: usize = EXEC_MODE_REASON_MAX_CHARS * 4;
pub const SHUTDOWN_NOTE_MAX_CHARS: usize = 2_000;
pub const SHUTDOWN_NOTE_MAX_BYTES: usize = SHUTDOWN_NOTE_MAX_CHARS * 4;
pub const MESSAGE_IDENTIFIER_MAX_CHARS: usize = 1_000;
pub const MESSAGE_IDENTIFIER_MAX_BYTES: usize = MESSAGE_IDENTIFIER_MAX_CHARS * 4;
pub const TASK_DEPENDENCY_OUTPUT_MAX_COUNT: usize = 64;
pub const TASK_DEPENDENCY_TOTAL_CONTENT_MAX_CHARS: usize = 50_000;
pub const TASK_DEPENDENCY_TOTAL_CONTENT_MAX_BYTES: usize =
    TASK_DEPENDENCY_TOTAL_CONTENT_MAX_CHARS * 4;
pub const AGENT_INBOX_PAYLOAD_MAX_BYTES: usize = 256 * 1024;

pub fn validate_text_len(
    field: &str,
    value: &str,
    max_chars: usize,
    max_bytes: usize,
) -> Result<(), String> {
    let byte_count = value.len();
    if byte_count > max_bytes {
        return Err(format!(
            "{field} must be <= {max_chars} chars and <= {max_bytes} bytes (got {byte_count} bytes)"
        ));
    }
    let char_count = value.chars().count();
    if char_count > max_chars {
        return Err(format!(
            "{field} must be <= {max_chars} chars and <= {max_bytes} bytes (got {char_count} chars)"
        ));
    }
    Ok(())
}

pub fn validate_required_text(
    field: &str,
    value: &str,
    max_chars: usize,
    max_bytes: usize,
) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    validate_text_len(field, value, max_chars, max_bytes)
}

pub fn validate_optional_text(
    field: &str,
    value: Option<&str>,
    max_chars: usize,
    max_bytes: usize,
) -> Result<(), String> {
    if let Some(value) = value {
        validate_text_len(field, value, max_chars, max_bytes)?;
    }
    Ok(())
}

pub fn validate_task_identifier(field: &str, value: &str) -> Result<(), String> {
    validate_message_identifier(field, value)
}

pub fn validate_message_identifier(field: &str, value: &str) -> Result<(), String> {
    validate_required_text(
        field,
        value,
        MESSAGE_IDENTIFIER_MAX_CHARS,
        MESSAGE_IDENTIFIER_MAX_BYTES,
    )?;
    if value != value.trim() {
        return Err(format!(
            "{field} must not contain leading or trailing whitespace"
        ));
    }
    Ok(())
}

pub fn validate_task_identifier_list(field: &str, values: &[String]) -> Result<(), String> {
    for (index, value) in values.iter().enumerate() {
        validate_task_identifier(&format!("{field}[{index}]"), value)?;
    }
    Ok(())
}

pub fn validate_task_dependency_ids(field: &str, values: &[String]) -> Result<(), String> {
    if values.len() > TASK_DEPENDENCY_MAX_COUNT {
        return Err(format!(
            "task_dependency_limit: {field} must contain at most {TASK_DEPENDENCY_MAX_COUNT} task ids"
        ));
    }
    validate_task_identifier_list(field, values)
        .map_err(|error| format!("task_dependency_limit: {error}"))?;
    let total_chars = values.iter().fold(0usize, |total, value| {
        total.saturating_add(value.chars().count())
    });
    let total_bytes = values
        .iter()
        .fold(0usize, |total, value| total.saturating_add(value.len()));
    if total_chars > TASK_DEPENDENCY_TOTAL_MAX_CHARS
        || total_bytes > TASK_DEPENDENCY_TOTAL_MAX_BYTES
    {
        return Err(format!(
            "task_dependency_limit: {field} must total <= {TASK_DEPENDENCY_TOTAL_MAX_CHARS} chars and <= {TASK_DEPENDENCY_TOTAL_MAX_BYTES} bytes"
        ));
    }
    Ok(())
}

pub fn validate_task_eligible_member_ids(field: &str, values: &[String]) -> Result<(), String> {
    if values.len() > TASK_ELIGIBILITY_MAX_COUNT {
        return Err(format!(
            "{field} must contain at most {TASK_ELIGIBILITY_MAX_COUNT} member ids"
        ));
    }
    validate_task_identifier_list(field, values)?;
    let total_chars = values.iter().fold(0usize, |total, value| {
        total.saturating_add(value.chars().count())
    });
    let total_bytes = values
        .iter()
        .fold(0usize, |total, value| total.saturating_add(value.len()));
    if total_chars > TASK_ELIGIBILITY_TOTAL_MAX_CHARS
        || total_bytes > TASK_ELIGIBILITY_TOTAL_MAX_BYTES
    {
        return Err(format!(
            "{field} must total <= {TASK_ELIGIBILITY_TOTAL_MAX_CHARS} chars and <= {TASK_ELIGIBILITY_TOTAL_MAX_BYTES} bytes"
        ));
    }
    Ok(())
}

pub fn validate_task_artifact_ids(field: &str, values: &[String]) -> Result<(), String> {
    if values.len() > TASK_ARTIFACT_ID_MAX_COUNT {
        return Err(format!(
            "{field} must contain at most {TASK_ARTIFACT_ID_MAX_COUNT} entries"
        ));
    }
    let mut total_chars = 0usize;
    let mut total_bytes = 0usize;
    for (index, value) in values.iter().enumerate() {
        validate_required_text(
            &format!("{field}[{index}]"),
            value,
            TASK_ARTIFACT_ID_MAX_CHARS,
            TASK_ARTIFACT_ID_MAX_BYTES,
        )?;
        total_chars = total_chars.saturating_add(value.chars().count());
        total_bytes = total_bytes.saturating_add(value.len());
    }
    if total_chars > TASK_ARTIFACT_IDS_TOTAL_MAX_CHARS
        || total_bytes > TASK_ARTIFACT_IDS_TOTAL_MAX_BYTES
    {
        return Err(format!(
            "{field} must total <= {TASK_ARTIFACT_IDS_TOTAL_MAX_CHARS} chars and <= {TASK_ARTIFACT_IDS_TOTAL_MAX_BYTES} bytes"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_count_unicode_chars_and_utf8_bytes() {
        assert!(validate_text_len("field", "你好", 2, 6).is_ok());
        assert!(validate_text_len("field", "你好呀", 2, 12)
            .unwrap_err()
            .contains("3 chars"));
        assert!(validate_text_len("field", "😀", 1, 3)
            .unwrap_err()
            .contains("4 bytes"));
    }

    #[test]
    fn task_identifier_uses_the_delivery_boundary() {
        assert!(
            validate_task_identifier("task id", &"a".repeat(TASK_IDENTIFIER_MAX_CHARS)).is_ok()
        );
        assert!(
            validate_task_identifier("task id", &"a".repeat(TASK_IDENTIFIER_MAX_CHARS + 1))
                .unwrap_err()
                .contains("task id must be <= 1000 chars")
        );
    }
}

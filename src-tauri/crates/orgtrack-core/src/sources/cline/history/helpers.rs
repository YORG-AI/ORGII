//! Small text, JSON, and path helpers shared by discovery and transcript
//! conversion, plus session-id/path resolution against the on-disk store.

use super::*;

pub(super) fn json_nonempty_string(value: &Value, path: &[&str]) -> Option<String> {
    let value = path
        .iter()
        .try_fold(value, |current, key| current.get(*key))?;
    let text = value.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

pub(super) fn json_i64_at_paths(value: &Value, paths: &[&[&str]]) -> Option<i64> {
    paths.iter().find_map(|path| {
        let value = path
            .iter()
            .try_fold(value, |current, key| current.get(*key))?;
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
            .or_else(|| value.as_f64().map(|number| number.round() as i64))
    })
}

/// Cline wraps user prompts as `<user_input mode="act">…</user_input>`; unwrap to
/// the inner text for a clean title/replay. Leaves non-wrapped text untouched.
pub(super) fn strip_user_input_wrapper(text: &str) -> &str {
    let trimmed = text.trim();
    let Some(after_open) = trimmed.strip_prefix("<user_input") else {
        return trimmed;
    };
    let Some(gt) = after_open.find('>') else {
        return trimmed;
    };
    let inner = &after_open[gt + 1..];
    inner.strip_suffix("</user_input>").unwrap_or(inner).trim()
}

/// Flatten a `tool_result.content` value (string, array of blocks, or object)
/// into readable text, capped so a huge command output can't bloat the payload.
pub(super) fn value_to_text(value: Option<&Value>) -> String {
    let mut out = String::new();
    if let Some(value) = value {
        append_value_text(value, &mut out);
    }
    let out = out.trim();
    if out.chars().count() > MAX_TOOL_OUTPUT_CHARS {
        let truncated: String = out.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
        format!("{truncated}\n… (truncated)")
    } else {
        out.to_string()
    }
}

pub(super) fn append_value_text(value: &Value, out: &mut String) {
    match value {
        Value::String(text) => push_line(out, text),
        Value::Array(items) => {
            for item in items {
                append_value_text(item, out);
            }
        }
        Value::Object(map) => {
            if let Some(Value::String(text)) = map.get("text") {
                push_line(out, text);
            } else if let Some(Value::String(text)) = map.get("result") {
                push_line(out, text);
            } else {
                push_line(out, &value.to_string());
            }
        }
        Value::Null => {}
        other => push_line(out, &other.to_string()),
    }
}

pub(super) fn push_line(out: &mut String, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(text);
}

pub(super) fn sidecar_json_path(messages_path: &Path, source_session_id: &str) -> Option<PathBuf> {
    let parent = messages_path.parent()?;
    let candidate = parent.join(format!("{source_session_id}.json"));
    candidate.is_file().then_some(candidate)
}

pub(super) fn cline_source_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(rest) = session_id.strip_prefix(CLINE_SESSION_PREFIX) else {
        return Err(format!("Invalid Cline history session id: {session_id}"));
    };
    if rest.is_empty() {
        return Err("Cline history session id is missing its source id".to_string());
    }
    Ok(rest)
}

pub(super) fn resolve_cline_messages_path(
    conn: &Connection,
    source_session_id: &str,
) -> Result<PathBuf, String> {
    if let Some(path) =
        imported_cache::get_cached_source_path_from_conn(conn, SOURCE_CLINE, source_session_id)?
    {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    for sessions_dir in cline_sessions_dirs()? {
        let candidate = sessions_dir
            .join(source_session_id)
            .join(format!("{source_session_id}{MESSAGES_SUFFIX}"));
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Cline history file not found for session: {source_session_id}"
    ))
}

pub(super) fn cline_sessions_dirs() -> Result<Vec<PathBuf>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory not found".to_string())?;
    Ok(cline_sessions_dir_candidates(&home))
}

pub(super) fn cline_db_paths() -> Result<Vec<PathBuf>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory not found".to_string())?;
    Ok(cline_db_path_candidates(&home))
}

/// `~/.cline/data/sessions` — the CLI's per-session store root.
pub(super) fn cline_sessions_dir_candidates(home: &Path) -> Vec<PathBuf> {
    vec![home.join(".cline").join("data").join("sessions")]
}

pub(super) fn cline_db_path_candidates(home: &Path) -> Vec<PathBuf> {
    vec![home
        .join(".cline")
        .join("data")
        .join("db")
        .join("sessions.db")]
}

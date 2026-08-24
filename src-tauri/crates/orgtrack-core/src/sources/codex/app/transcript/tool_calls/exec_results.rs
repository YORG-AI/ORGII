use serde_json::Value;

#[derive(Debug)]
pub(super) struct CodexExecResult {
    pub(super) output: String,
    pub(super) session_id: Option<String>,
    pub(super) exit_code: Option<i64>,
}

pub(super) fn append_incremental_output(existing: &mut String, next: &str) {
    if !next.is_empty() {
        existing.push_str(next);
    }
}

pub(super) fn codex_exec_results(output: Option<&Value>) -> Vec<CodexExecResult> {
    let parts = match output {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.as_str())
            })
            .collect::<Vec<_>>(),
        Some(Value::String(text)) => vec![text.as_str()],
        _ => Vec::new(),
    };

    let mut results: Vec<CodexExecResult> = Vec::new();
    for part in parts {
        let parsed_results = codex_exec_results_from_text(part);
        if !parsed_results.is_empty() {
            results.extend(parsed_results);
        } else if !is_codex_script_wrapper_text(part) {
            if let Some(result) = results.last_mut() {
                append_incremental_output(&mut result.output, part);
            }
        }
    }
    results
}

fn codex_exec_results_from_text(text: &str) -> Vec<CodexExecResult> {
    // Desktop `exec` can return either one JSON object per text part or one
    // Script-completed envelope whose Output payload is an array of results.
    // Normalize both shapes here so callers only handle per-command results.
    let direct = serde_json::from_str::<Value>(text.trim())
        .ok()
        .map(codex_exec_results_from_value)
        .unwrap_or_default();
    if !direct.is_empty() {
        return direct;
    }

    let Some(payload) = codex_script_output_payload(text) else {
        return Vec::new();
    };
    serde_json::from_str::<Value>(payload)
        .ok()
        .map(codex_exec_results_from_value)
        .unwrap_or_default()
}

fn codex_exec_results_from_value(value: Value) -> Vec<CodexExecResult> {
    match value {
        Value::Array(values) => values
            .into_iter()
            .filter_map(codex_exec_result_from_value)
            .collect(),
        value => codex_exec_result_from_value(value).into_iter().collect(),
    }
}

fn codex_exec_result_from_value(value: Value) -> Option<CodexExecResult> {
    let object = value.as_object()?;
    if !object.contains_key("output")
        && !object.contains_key("session_id")
        && !object.contains_key("sessionId")
        && !object.contains_key("exit_code")
        && !object.contains_key("exitCode")
    {
        return None;
    }
    Some(CodexExecResult {
        output: object
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        session_id: object
            .get("session_id")
            .or_else(|| object.get("sessionId"))
            .and_then(json_scalar_string),
        exit_code: object
            .get("exit_code")
            .or_else(|| object.get("exitCode"))
            .and_then(Value::as_i64),
    })
}

fn codex_script_output_payload(text: &str) -> Option<&str> {
    if !is_codex_script_wrapper_text(text) {
        return None;
    }
    ["\nOutput:\r\n", "\nOutput:\n"]
        .into_iter()
        .find_map(|marker| text.split_once(marker).map(|(_, payload)| payload.trim()))
        .filter(|payload| !payload.is_empty())
}

fn json_scalar_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn is_codex_script_wrapper_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("Script completed")
        || trimmed.starts_with("Script running with cell ID")
        || trimmed.starts_with("Script failed")
        || trimmed.starts_with("Script error")
}

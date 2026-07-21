//! Safe value helpers for extracting typed fields from serde_json values.

pub(super) fn safe_str(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(obj) => obj
            .get("content")
            .and_then(|v| v.as_str())
            .or_else(|| obj.get("text").and_then(|v| v.as_str()))
            .or_else(|| obj.get("message").and_then(|v| v.as_str()))
            .map(|s| s.to_string()),
        serde_json::Value::Array(arr) => arr.iter().find_map(safe_str),
        _ => None,
    }
}

pub(super) fn obj_str(
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<String> {
    obj.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

pub(super) fn extract_fenced_diff(text: &str) -> Option<String> {
    let start_marker = "```diff";
    let start = text.find(start_marker)?;
    let after_marker = &text[start + start_marker.len()..];
    let after_newline = after_marker.strip_prefix('\n').unwrap_or(after_marker);
    let end = after_newline.find("```")?;
    Some(after_newline[..end].trim_end().to_string())
}

pub(super) fn parse_diff_start_lines(diff: Option<&str>) -> (Option<usize>, Option<usize>) {
    let Some(diff_text) = diff else {
        return (None, None);
    };

    for line in diff_text.lines() {
        let Some(rest) = line.strip_prefix("@@ -") else {
            continue;
        };
        let Some((old_part, new_part_with_suffix)) = rest.split_once(" +") else {
            continue;
        };
        let Some((new_part, _suffix)) = new_part_with_suffix.split_once(" @@") else {
            continue;
        };
        let old_start = old_part
            .split(',')
            .next()
            .and_then(|value| value.parse::<usize>().ok());
        let new_start = new_part
            .split(',')
            .next()
            .and_then(|value| value.parse::<usize>().ok());
        return (old_start, new_start);
    }

    (None, None)
}

pub(super) fn obj_i64(obj: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<i64> {
    obj.get(key).and_then(|v| v.as_i64())
}

pub(super) fn obj_f64(obj: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<f64> {
    obj.get(key).and_then(|v| v.as_f64())
}

pub(super) fn obj_bool(
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<bool> {
    obj.get(key).and_then(|v| v.as_bool())
}

pub(super) fn obj_string_array(
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Vec<String> {
    obj.get(key)
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn parse_json_object_string(
    value: &serde_json::Value,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let text = value.as_str()?;
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Object(obj)) => Some(obj),
        Ok(_) => None,
        Err(err) => {
            tracing::warn!(
                error = %err,
                len = text.len(),
                "extractors: string payload is not valid JSON object; skipping"
            );
            None
        }
    }
}

pub(super) fn normalized_result_object(
    result: Option<&serde_json::Map<String, serde_json::Value>>,
) -> serde_json::Map<String, serde_json::Value> {
    let Some(result) = result else {
        return serde_json::Map::new();
    };
    result
        .get("content")
        .and_then(parse_json_object_string)
        .or_else(|| result.get("observation").and_then(parse_json_object_string))
        .unwrap_or_else(|| result.clone())
}

/// Extract success data from nested or flat result formats.
pub(super) fn get_success_data(
    result: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let empty = serde_json::Map::new();

    let nested = result
        .get("output")
        .and_then(|v| v.as_object())
        .and_then(|o| o.get("success"))
        .and_then(|v| v.as_object());

    let direct = result.get("success").and_then(|v| v.as_object());

    if let Some(n) = nested {
        if !n.is_empty() {
            return n.clone();
        }
    }
    if let Some(d) = direct {
        if !d.is_empty() {
            return d.clone();
        }
    }
    empty
}

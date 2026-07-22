//! Formatting helpers shared across commands: usage-table printers, sort/match
//! predicates, chunk text extraction, table/markdown/CSV cell escaping, JSON
//! encoding, and formatter-plugin (template) rendering.

use orgtrack_core::sources::imported_history::ImportedHistorySessionRow;
use orgtrack_core::usage_dashboard::{SessionSort, UsageSessionRow, UsageSummary};

use crate::plugins::FormatterPlugin;
use crate::Options;

pub(crate) fn print_usage_summary(summary: &UsageSummary) {
    println!("Usage summary");
    println!("  sessions        {}", summary.session_count);
    println!("  requests        {}", summary.request_count);
    println!("  input tokens    {}", summary.input_tokens);
    println!("  output tokens   {}", summary.output_tokens);
    println!("  cache read      {}", summary.cache_read_tokens);
    println!("  cache write     {}", summary.cache_write_tokens);
    println!("  total tokens    {}", summary.real_total_tokens);
    println!("  est. cost       ${:.2}", summary.cost_usd);
    println!("  cache hit rate  {:.1}%", summary.cache_hit_rate * 100.0);
    if !summary.by_bucket.is_empty() {
        println!("  by bucket:");
        for bucket in &summary.by_bucket {
            println!(
                "    {:<10} {:>10} tok  ${:.2}",
                bucket.bucket, bucket.real_total_tokens, bucket.cost_usd
            );
        }
    }
}

pub(crate) fn print_usage_session_row(row: &UsageSessionRow) {
    println!(
        "{:<12}  {:<10}  {:>10}  {:>9.2}  {}",
        truncate(&row.source, 12),
        truncate(row.model.as_deref().unwrap_or("-"), 10),
        row.real_total_tokens,
        row.cost_usd,
        truncate(&row.name, 40),
    );
}

pub(crate) fn parse_sort(sort: Option<&str>) -> Result<SessionSort, String> {
    match sort {
        None | Some("recent") => Ok(SessionSort::Recent),
        Some("cost") => Ok(SessionSort::Cost),
        Some("tokens") => Ok(SessionSort::Tokens),
        Some(other) => Err(format!(
            "unknown --sort '{other}' (expected recent, cost, or tokens)"
        )),
    }
}

pub(crate) fn row_matches(row: &ImportedHistorySessionRow, query: &str) -> bool {
    let mut haystacks: Vec<&str> = vec![&row.name, &row.session_id];
    if let Some(repo) = &row.repo_name {
        haystacks.push(repo);
    }
    if let Some(path) = &row.repo_path {
        haystacks.push(path);
    }
    if let Some(model) = &row.model {
        haystacks.push(model);
    }
    for file in &row.touched_files {
        haystacks.push(file);
    }
    haystacks
        .iter()
        .any(|value| value.to_lowercase().contains(query))
}

pub(crate) fn session_label(row: &ImportedHistorySessionRow) -> String {
    let name = if row.name.trim().is_empty() {
        row.session_id.clone()
    } else {
        row.name.clone()
    };
    match &row.repo_name {
        Some(repo) if !repo.is_empty() => format!("{name}  ({repo})"),
        _ => name,
    }
}

/// Extract a chunk payload's text, newlines preserved. Activity chunks carry
/// message text under a handful of shapes — `result.message.content` for user
/// turns, `result.content` for assistant/thinking, `args.cmd`/`args.command`
/// for shell tools, `result.observation` for tool output — so probe the known
/// text-bearing keys most-specific-first, and treat an empty object as "no text
/// here" so callers fall through to the other payload.
pub(crate) fn extract_text(value: &serde_json::Value) -> Option<String> {
    let non_blank = |text: &str| -> Option<String> {
        if text.trim().is_empty() {
            None
        } else {
            Some(text.to_string())
        }
    };
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(text) => non_blank(text),
        serde_json::Value::Object(map) if map.is_empty() => None,
        serde_json::Value::Array(items) if items.is_empty() => None,
        serde_json::Value::Object(map) => {
            if let Some(text) = map
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(|content| content.as_str())
            {
                if let Some(found) = non_blank(text) {
                    return Some(found);
                }
            }
            for key in [
                "content",
                "text",
                "observation",
                "cmd",
                "command",
                "body",
                "summary",
                "prompt",
                "description",
            ] {
                if let Some(text) = map.get(key).and_then(|value| value.as_str()) {
                    if let Some(found) = non_blank(text) {
                        return Some(found);
                    }
                }
            }
            non_blank(&value.to_string())
        }
        other => non_blank(&other.to_string()),
    }
}

/// One-line preview (newlines collapsed) — for tables and CSV cells.
pub(crate) fn preview_of(value: &serde_json::Value) -> Option<String> {
    extract_text(value).and_then(|text| {
        let one_line = text.replace('\n', " ");
        let trimmed = one_line.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

/// Full multi-line body — for the markdown transcript.
pub(crate) fn chunk_body(value: &serde_json::Value) -> Option<String> {
    extract_text(value).map(|text| text.trim().to_string()).filter(|text| !text.is_empty())
}

/// Escape a markdown table cell: no pipes or newlines may leak into the row.
pub(crate) fn md_cell(value: &str) -> String {
    value.replace('|', "\\|").replace('\n', " ")
}

/// One RFC-4180-ish CSV row (trailing newline). Fields containing a comma,
/// quote, or newline are quoted with `"` doubled.
pub(crate) fn csv_row(fields: &[&str]) -> String {
    let escaped: Vec<String> = fields
        .iter()
        .map(|field| {
            if field.contains([',', '"', '\n', '\r']) {
                format!("\"{}\"", field.replace('"', "\"\""))
            } else {
                field.to_string()
            }
        })
        .collect();
    format!("{}\n", escaped.join(","))
}

pub(crate) fn truncate(value: &str, max: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= max {
        value.to_string()
    } else if max <= 1 {
        chars.into_iter().take(max).collect()
    } else {
        let head: String = chars.into_iter().take(max - 1).collect();
        format!("{head}…")
    }
}

pub(crate) fn to_json<T: serde::Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|err| format!("json encode: {err}"))
}

/// If `--format` names a discovered formatter plugin, return it. Checked before
/// the built-in format parser so a plugin id doesn't read as "unknown format".
pub(crate) fn formatter_for<'a>(
    opts: &Options,
    formatters: &'a [FormatterPlugin],
) -> Option<&'a FormatterPlugin> {
    let name = opts.format.as_deref()?;
    formatters.iter().find(|formatter| formatter.id == name)
}

/// Render a command's result JSON through a formatter's sandboxed template and
/// print it. The template runs no code and gets no fs/network access.
pub(crate) fn render_template(
    formatter: &FormatterPlugin,
    context: &serde_json::Value,
) -> Result<(), String> {
    let source = std::fs::read_to_string(&formatter.template_path)
        .map_err(|err| format!("read template {}: {err}", formatter.template_path.display()))?;
    let mut env = minijinja::Environment::new();
    env.add_template_owned("formatter", source)
        .map_err(|err| format!("template '{}' error: {err}", formatter.id))?;
    let template = env
        .get_template("formatter")
        .map_err(|err| format!("template '{}' error: {err}", formatter.id))?;
    let rendered = template
        .render(context)
        .map_err(|err| format!("formatter '{}' render error: {err}", formatter.id))?;
    print!("{rendered}");
    if !rendered.ends_with('\n') {
        println!();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_adds_ellipsis_only_when_needed() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello", 3), "he…");
        assert_eq!(truncate("hi", 2), "hi");
    }

    #[test]
    fn md_cell_escapes_pipes_and_newlines() {
        assert_eq!(md_cell("a|b\nc"), "a\\|b c");
    }

    #[test]
    fn csv_row_quotes_when_needed() {
        assert_eq!(csv_row(&["a", "b"]), "a,b\n");
        assert_eq!(csv_row(&["a,b", "c\"d"]), "\"a,b\",\"c\"\"d\"\n");
    }

    #[test]
    fn sort_parse_defaults_to_recent() {
        assert!(matches!(parse_sort(Some("cost")).unwrap(), SessionSort::Cost));
        assert!(matches!(parse_sort(Some("tokens")).unwrap(), SessionSort::Tokens));
        assert!(matches!(parse_sort(None).unwrap(), SessionSort::Recent));
        assert!(parse_sort(Some("bogus")).is_err());
    }

    #[test]
    fn preview_collapses_and_body_preserves_newlines() {
        let msg = serde_json::json!({"message": {"content": "hello\nworld", "role": "user"}});
        assert_eq!(preview_of(&msg).unwrap(), "hello world");
        assert_eq!(chunk_body(&msg).unwrap(), "hello\nworld");

        assert!(preview_of(&serde_json::json!({})).is_none());
        assert_eq!(preview_of(&serde_json::json!({"content": "c"})).unwrap(), "c");
        assert_eq!(
            preview_of(&serde_json::json!({"observation": "obs"})).unwrap(),
            "obs"
        );
        assert_eq!(preview_of(&serde_json::json!({"cmd": "ls"})).unwrap(), "ls");
    }
}

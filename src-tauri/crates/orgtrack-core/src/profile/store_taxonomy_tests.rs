use super::*;
use crate::profile::signals::{classify_tool, ToolKind};
use std::collections::HashMap;

#[test]
#[ignore = "requires local session history"]
fn report_real_tool_names() {
    let home = std::env::var("ORGII_HOME")
        .unwrap_or_else(|_| format!("{}/.orgii", std::env::var("HOME").unwrap()));
    let path = format!("{home}/sessions.db");
    if !std::path::Path::new(&path).exists() {
        return;
    }
    let conn = Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .expect("open");
    let mut st = conn
        .prepare(
            "SELECT session_id FROM imported_history_session_cache
                 ORDER BY created_at_ms DESC LIMIT 300",
        )
        .expect("prepare");
    let ids: Vec<String> = st
        .query_map([], |r| r.get(0))
        .expect("query")
        .filter_map(Result::ok)
        .collect();
    drop(st);

    let mut counts: HashMap<(String, String), i64> = HashMap::new();
    for id in &ids {
        if let Ok(Some(chunks)) = load_activity_chunks_for_session(&conn, id) {
            for c in chunks.iter().filter(|c| c.action_type == "tool_call") {
                let kind = format!("{:?}", classify_tool(&c.function));
                *counts.entry((kind, c.function.clone())).or_default() += 1;
            }
        }
    }
    let mut rows: Vec<_> = counts.into_iter().collect();
    rows.sort_by_key(|(_, n)| -*n);
    eprintln!("\n  tool name -> category (from {} sessions):", ids.len());
    for ((kind, name), n) in rows.iter().take(30) {
        let flag = if kind == "Other" {
            "  <-- UNMAPPED"
        } else {
            ""
        };
        eprintln!("   {n:>7}  {kind:<9} {name}{flag}");
    }
    let unmapped: i64 = rows
        .iter()
        .filter(|((k, _), _)| k == "Other")
        .map(|(_, n)| *n)
        .sum();
    let total: i64 = rows.iter().map(|(_, n)| *n).sum();
    eprintln!(
        "\n  unmapped: {unmapped} / {total} calls ({:.1}%)",
        unmapped as f64 / total.max(1) as f64 * 100.0
    );
    assert_eq!(classify_tool("nonexistent_tool"), ToolKind::Other);
}

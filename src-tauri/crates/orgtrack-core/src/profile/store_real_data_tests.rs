use super::*;
use crate::profile;

#[test]
#[ignore = "requires local session history"]
fn real_local_history_produces_a_profile() {
    let home = std::env::var("ORGII_HOME")
        .unwrap_or_else(|_| format!("{}/.orgii", std::env::var("HOME").unwrap()));
    let path = format!("{home}/sessions.db");
    if !std::path::Path::new(&path).exists() {
        eprintln!("no local history at {path}; skipping");
        return;
    }
    let conn = Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .expect("open read-only");

    let mut statement = conn
        .prepare(
            "SELECT session_id, source FROM imported_history_session_cache
                 ORDER BY created_at_ms DESC LIMIT 400",
        )
        .expect("prepare");
    let ids: Vec<(String, String)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query")
        .filter_map(Result::ok)
        .collect();
    drop(statement);
    eprintln!("candidate sessions: {}", ids.len());

    let mut all = Vec::new();
    for (id, source) in &ids {
        if let Ok(Some(chunks)) = load_activity_chunks_for_session(&conn, id) {
            if chunks.len() >= 3 {
                all.push(signals::extract(id, source, &chunks));
            }
        }
    }
    eprintln!("extracted signals for {} sessions", all.len());
    assert!(!all.is_empty(), "no session yielded signals");

    let with_edit = all.iter().filter(|s| s.has_edit).count();
    let with_user = all.iter().filter(|s| s.user_turns > 0).count();
    eprintln!("  with a human turn: {with_user}   with an edit: {with_edit}");
    assert!(
        with_user > 0,
        "no human turns parsed — user_message shape changed?"
    );

    let p = profile::profile_for(&all);
    eprintln!(
        "\n  code {}  ({})  confidence {:.0}%  over {} sessions",
        p.code,
        p.archetype.as_deref().unwrap_or("partial"),
        p.confidence * 100.0,
        p.sessions
    );
    for a in &p.axes {
        eprintln!(
            "  {:3} {:>6.1}  {:<9} vs {:<9} n={:<5} agree {:.0}%  {} ({:?}) {}",
            a.key,
            a.score,
            a.negative_name,
            a.positive_name,
            a.sessions,
            a.consistency * 100.0,
            a.letter,
            a.clarity,
            a.caveat.as_deref().unwrap_or(""),
        );
    }
    let shares: Vec<f64> = signals::parallel_shares(&all)
        .into_iter()
        .map(|(_, v)| v)
        .collect();
    let cards = profile::highlights::build(&all, &shares);
    eprintln!("\n  {} highlight cards:", cards.len());
    for c in &cards {
        eprintln!("   [{:?}] {} / {}  {}", c.kind, c.id, c.detail_id, c.params);
    }
    assert_eq!(p.code.chars().count(), 4);
}

use super::*;
use crate::profile;
use std::time::Instant;

#[test]
#[ignore = "requires local session history"]
fn measure_scoring_cost() {
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

    let t = Instant::now();
    let all = load_signals(&conn, &[], None, 20_000).expect("load");
    let load_ms = t.elapsed().as_millis();
    if all.is_empty() {
        eprintln!("no cached signal rows yet - run the panel first");
        return;
    }
    eprintln!("\n  cached signal rows : {}", all.len());
    eprintln!("  load + deserialize : {load_ms} ms");

    let t = Instant::now();
    let shares: Vec<f64> = signals::parallel_shares(&all)
        .into_iter()
        .map(|(_, v)| v)
        .collect();
    eprintln!("  concurrency sweep  : {} ms", t.elapsed().as_millis());

    let t = Instant::now();
    let _ = profile::profile_for(&all);
    let one_ms = t.elapsed().as_millis();
    eprintln!("  ONE profile        : {one_ms} ms  (4 axes incl. anchor sensitivity)");

    let t = Instant::now();
    let _ = profile::highlights::build(&all, &shares);
    eprintln!("  highlights         : {} ms", t.elapsed().as_millis());

    let mut sources: Vec<String> = all.iter().map(|s| s.source.clone()).collect();
    sources.sort();
    sources.dedup();
    let windows = all.len().saturating_sub(400) / 200;
    let profiles = 1 + sources.len() + windows;
    eprintln!(
        "\n  a panel load computes {profiles} full profiles \
(1 global + {} per-source + {windows} drift windows)",
        sources.len()
    );
    eprintln!(
        "  => roughly {} ms of scoring per open",
        one_ms * profiles as u128
    );
}

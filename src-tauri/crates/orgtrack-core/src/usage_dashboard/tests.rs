//! Tests for the Usage dashboard: headline summary, per-session table,
//! per-round request log, trend buckets, and the combined
//! [`super::usage_overview`] streaming pass — including the mirror-exclusion
//! and bucket/time-window invariants the module doc comment calls out.

use super::*;
use crate::session_usage::recompute_session_usage;
use crate::store::sqlite::SqliteRecordStore;
use rusqlite::params;

fn fixture_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    SqliteRecordStore::init_tables(&conn).expect("init orgtrack tables");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("init source cache tables");
    conn.execute_batch(
        "CREATE TABLE session_token_usage (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id         TEXT NOT NULL,
            session_type       TEXT NOT NULL DEFAULT 'code',
            model              TEXT,
            account_id         TEXT,
            input_tokens       INTEGER NOT NULL DEFAULT 0,
            output_tokens      INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens       INTEGER NOT NULL DEFAULT 0,
            context_tokens     INTEGER NOT NULL DEFAULT 0,
            created_at         TEXT NOT NULL
         );
         CREATE TABLE code_sessions (
            session_id     TEXT PRIMARY KEY,
            name           TEXT,
            cli_agent_type TEXT,
            model          TEXT,
            account_id     TEXT,
            key_source     TEXT,
            updated_at     TEXT
         );
         CREATE TABLE agent_sessions (
            session_id TEXT PRIMARY KEY,
            name       TEXT,
            model      TEXT,
            account_id TEXT,
            key_source TEXT,
            updated_at TEXT
         );",
    )
    .expect("create app-owned tables");
    conn
}

fn insert_code_session(
    conn: &Connection,
    session_id: &str,
    cli_agent_type: &str,
    name: &str,
    updated_at: &str,
) {
    conn.execute(
        "INSERT INTO code_sessions (session_id, name, cli_agent_type, model, account_id, key_source, updated_at)
         VALUES (?1, ?2, ?3, 'claude-sonnet-4-5', 'acct-1', 'own_key', ?4)",
        params![session_id, name, cli_agent_type, updated_at],
    )
    .expect("insert code session");
}

fn insert_turn(
    conn: &Connection,
    session_id: &str,
    model: &str,
    tokens: (i64, i64, i64, i64),
    created_at: &str,
) {
    let (input, output, cache_read, cache_write) = tokens;
    let total = input + output + cache_read + cache_write;
    conn.execute(
        "INSERT INTO session_token_usage
            (session_id, session_type, model, account_id, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, total_tokens, context_tokens, created_at)
         VALUES (?1, 'code', ?2, 'acct-1', ?3, ?4, ?5, ?6, ?7, 0, ?8)",
        params![
            session_id,
            model,
            input,
            output,
            cache_read,
            cache_write,
            total,
            created_at
        ],
    )
    .expect("insert turn");
}

fn insert_imported(
    conn: &Connection,
    source: &str,
    session_id: &str,
    model: &str,
    tokens: (i64, i64),
    updated_at_ms: i64,
    listable: i64,
) {
    let (input, output) = tokens;
    conn.execute(
        "INSERT INTO imported_history_session_cache
            (source, source_session_id, session_id, name, model,
             input_tokens, output_tokens, updated_at_ms, listable, updated_at)
         VALUES (?1, ?2, ?3, 'Imported Session', ?4, ?5, ?6, ?7, ?8, '2026-07-16T00:00:00Z')",
        params![
            source,
            session_id,
            session_id,
            model,
            input,
            output,
            updated_at_ms,
            listable
        ],
    )
    .expect("insert imported cache row");
}

#[allow(clippy::too_many_arguments)]
fn insert_round(
    conn: &Connection,
    source: &str,
    session_id: &str,
    seq: i64,
    model: &str,
    tokens: (i64, i64, i64, i64),
    created_at_ms: i64,
) {
    let (input, output, cache_read, cache_write) = tokens;
    conn.execute(
        "INSERT INTO imported_history_round_usage
            (source, source_session_id, session_id, seq, model,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            source,
            session_id,
            session_id,
            seq,
            model,
            input,
            output,
            cache_read,
            cache_write,
            created_at_ms
        ],
    )
    .expect("insert imported round row");
}

#[test]
fn rounds_fallback_when_no_round_rows() {
    // No imported_history_round_usage rows: native sessions expand to their
    // per-turn rows, imported codex gets one synthesized fallback round.
    let conn = seeded_conn();
    let rows =
        usage_rounds(&conn, &UsageFilter::default(), SessionSort::Recent, 0, 100).expect("rounds");
    // claude 2 native turns + org2 1 native turn + codex 1 fallback = 4.
    assert_eq!(rows.len(), 4);
    assert!(rows.iter().all(|r| r.session_id != "mirror-claude"));
    let claude: Vec<_> = rows
        .iter()
        .filter(|r| r.session_id == "cli-claude")
        .collect();
    assert_eq!(claude.len(), 2);
    let codex: Vec<_> = rows
        .iter()
        .filter(|r| r.session_id == "ext-codex")
        .collect();
    assert_eq!(codex.len(), 1);
}

#[test]
fn rounds_use_real_rows_and_session_filter() {
    let conn = seeded_conn();
    // Give the imported codex session two real rounds (replaces the fallback).
    insert_round(
        &conn,
        "codex_app",
        "ext-codex",
        0,
        "gpt-5",
        (100_000, 10_000, 50_000, 0),
        ms("2026-07-18T02:00:00Z"),
    );
    insert_round(
        &conn,
        "codex_app",
        "ext-codex",
        1,
        "gpt-5",
        (120_000, 12_000, 0, 0),
        ms("2026-07-18T02:10:00Z"),
    );

    let rows =
        usage_rounds(&conn, &UsageFilter::default(), SessionSort::Recent, 0, 100).expect("rounds");
    // claude 2 + org2 1 + codex 2 real = 5.
    assert_eq!(rows.len(), 5);
    let codex: Vec<_> = rows
        .iter()
        .filter(|r| r.session_id == "ext-codex")
        .collect();
    assert_eq!(codex.len(), 2);
    assert_eq!(codex.iter().map(|r| r.input_tokens).sum::<i64>(), 220_000);

    // Session filter narrows to just that session's rounds.
    let filter = UsageFilter {
        session_id: Some("ext-codex".to_string()),
        ..UsageFilter::default()
    };
    let only = usage_rounds(&conn, &filter, SessionSort::Recent, 0, 100).expect("filtered");
    assert_eq!(only.len(), 2);
    assert!(only.iter().all(|r| r.session_id == "ext-codex"));
}

#[test]
fn overview_filters_and_pages_rounds_without_narrowing_summary() {
    let conn = seeded_conn();
    let query = UsageRoundQuery::from_wire(
        Some("claude-sonnet-4-5".to_string()),
        false,
        Some("claude".to_string()),
    );

    let first = usage_overview(
        &conn,
        &UsageFilter::default(),
        &query,
        SessionSort::Recent,
        0,
        1,
        TrendBucket::Hour,
        true,
        true,
        true,
    )
    .expect("overview");

    // Summary/trends remain scoped to the whole dashboard, while the
    // request log is filtered and transfers one server-side page.
    assert_eq!(first.summary.request_count, 4);
    assert_eq!(first.round_total, 2);
    assert_eq!(first.rounds.len(), 1);
    assert_eq!(first.rounds[0].session_id, "cli-claude");
    assert_eq!(
        first.round_models,
        vec![
            "claude-opus-4-5".to_string(),
            "claude-sonnet-4-5".to_string(),
            "gpt-5".to_string(),
        ]
    );
    assert!(!first.has_unknown_round_model);

    let second = usage_overview(
        &conn,
        &UsageFilter::default(),
        &query,
        SessionSort::Recent,
        1,
        1,
        TrendBucket::Hour,
        true,
        true,
        true,
    )
    .expect("second page");
    assert_eq!(second.round_total, 2);
    assert_eq!(second.rounds.len(), 1);
    assert_ne!(first.rounds[0].round_id, second.rounds[0].round_id);
}

#[test]
fn overview_skips_request_page_work_when_rounds_are_not_requested() {
    let conn = seeded_conn();
    let overview = usage_overview(
        &conn,
        &UsageFilter::default(),
        &UsageRoundQuery::default(),
        SessionSort::Recent,
        0,
        10,
        TrendBucket::Hour,
        true,
        true,
        false,
    )
    .expect("headline overview");

    assert_eq!(overview.summary.request_count, 4);
    assert!(!overview.trends.is_empty());
    assert!(overview.rounds.is_empty());
    assert_eq!(overview.round_total, 0);
    assert!(overview.round_models.is_empty());
    assert!(!overview.has_unknown_round_model);
}

#[test]
fn overview_skips_trend_buckets_when_trends_are_not_requested() {
    let conn = seeded_conn();
    let overview = usage_overview(
        &conn,
        &UsageFilter::default(),
        &UsageRoundQuery::default(),
        SessionSort::Recent,
        0,
        10,
        TrendBucket::Hour,
        true,
        false,
        false,
    )
    .expect("summary-only overview");

    assert_eq!(overview.summary.request_count, 4);
    assert!(overview.trends.is_empty());
    assert!(overview.rounds.is_empty());
}

#[test]
fn overview_skips_headline_work_for_a_request_page_load() {
    let conn = seeded_conn();
    let overview = usage_overview(
        &conn,
        &UsageFilter::default(),
        &UsageRoundQuery::default(),
        SessionSort::Recent,
        0,
        10,
        TrendBucket::Hour,
        false,
        false,
        true,
    )
    .expect("request-page overview");

    assert_eq!(overview.summary, UsageSummary::default());
    assert!(overview.trends.is_empty());
    assert_eq!(overview.round_total, 4);
    assert_eq!(overview.rounds.len(), 4);
    assert!(!overview.round_models.is_empty());
}

#[test]
fn round_query_distinguishes_unknown_models() {
    let known = UsageRoundRow {
        model: Some("gpt-5".to_string()),
        ..UsageRoundRow::default()
    };
    let unknown = UsageRoundRow::default();
    let query = UsageRoundQuery::from_wire(Some("gpt-5".to_string()), true, None);

    assert!(!query.matches(&known));
    assert!(query.matches(&unknown));
}

/// Build a small realistic DB: one native claude session (2 turns), one
/// native org2 (rust-agent) session, one purely-imported codex session, and
/// a listable=0 mirror of the native claude session (the double-count trap).
fn seeded_conn() -> Connection {
    let conn = fixture_conn();

    // Native claude CLI session — 2 turns.
    insert_code_session(
        &conn,
        "cli-claude",
        "claude",
        "Claude run",
        "2026-07-18T03:00:00Z",
    );
    insert_turn(
        &conn,
        "cli-claude",
        "claude-sonnet-4-5",
        (1_000_000, 100_000, 200_000, 50_000),
        "2026-07-18T03:00:00Z",
    );
    insert_turn(
        &conn,
        "cli-claude",
        "claude-sonnet-4-5",
        (500_000, 50_000, 0, 0),
        "2026-07-18T05:00:00Z",
    );
    recompute_session_usage(&conn, "cli-claude")
        .unwrap()
        .expect("claude projected");

    // Org2 rust-agent session — 1 turn. Owner lives in agent_sessions.
    conn.execute(
        "INSERT INTO agent_sessions (session_id, name, model, account_id, key_source, updated_at)
         VALUES ('agent-1', 'Org2 agent', 'claude-opus-4-5', 'acct-1', 'own_key', '2026-07-18T04:00:00Z')",
        [],
    )
    .unwrap();
    insert_turn(
        &conn,
        "agent-1",
        "claude-opus-4-5",
        (200_000, 20_000, 0, 0),
        "2026-07-18T04:00:00Z",
    );
    recompute_session_usage(&conn, "agent-1")
        .unwrap()
        .expect("agent projected");

    // Purely-imported codex session (listable=1) — session-level tokens.
    let codex_ms = ms("2026-07-18T02:00:00Z");
    insert_imported(
        &conn,
        "codex_app",
        "ext-codex",
        "gpt-5",
        (400_000, 40_000),
        codex_ms,
        1,
    );
    recompute_session_usage(&conn, "ext-codex")
        .unwrap()
        .expect("codex projected");

    // Managed mirror of the native claude session (listable=0, different
    // session_id) — must be excluded from every rollup.
    let mirror_ms = ms("2026-07-18T03:30:00Z");
    insert_imported(
        &conn,
        "claude_code",
        "mirror-claude",
        "claude-sonnet-4-5",
        (1_500_000, 150_000),
        mirror_ms,
        0,
    );
    recompute_session_usage(&conn, "mirror-claude")
        .unwrap()
        .expect("mirror projected");

    conn
}

fn ms(iso: &str) -> i64 {
    iso_to_ms(iso).expect("valid iso")
}

#[test]
fn iso_parsing_handles_z_offset_and_space() {
    assert_eq!(iso_to_ms("2026-07-18T00:00:00Z"), Some(1_784_332_800_000));
    assert_eq!(
        iso_to_ms("2026-07-18T00:00:00+00:00"),
        iso_to_ms("2026-07-18T00:00:00Z")
    );
    assert_eq!(
        iso_to_ms("2026-07-18 00:00:00"),
        iso_to_ms("2026-07-18T00:00:00Z")
    );
    assert_eq!(iso_to_ms(""), None);
    assert_eq!(iso_to_ms("not-a-date"), None);
}

#[test]
fn summary_excludes_mirror_and_buckets_sources() {
    let conn = seeded_conn();
    let summary = usage_summary(&conn, &UsageFilter::default()).expect("summary");

    // 3 real sessions (claude native, org2, codex imported) — mirror dropped.
    assert_eq!(summary.session_count, 3);
    // Native claude: 1.5M in / 150k out / 200k cache_read / 50k cache_write.
    // Org2: 200k in / 20k out. Codex imported: 400k in / 40k out.
    assert_eq!(summary.input_tokens, 1_500_000 + 200_000 + 400_000);
    assert_eq!(summary.output_tokens, 150_000 + 20_000 + 40_000);
    assert_eq!(summary.cache_read_tokens, 200_000);
    assert_eq!(summary.cache_write_tokens, 50_000);
    assert_eq!(
        summary.real_total_tokens,
        summary.input_tokens
            + summary.output_tokens
            + summary.cache_read_tokens
            + summary.cache_write_tokens
    );
    // Requests: claude 2 turns + org2 1 turn + codex 1 imported session = 4.
    assert_eq!(summary.request_count, 4);
    // Cost is the sum of the three projection cost_usd values (all > 0).
    assert!(summary.cost_usd > 0.0);

    // Per-bucket breakdown: claude, codex, org2 (sorted).
    let buckets: Vec<&str> = summary
        .by_bucket
        .iter()
        .map(|b| b.bucket.as_str())
        .collect();
    assert_eq!(buckets, vec!["claude", "codex", "org2"]);
    let claude = summary
        .by_bucket
        .iter()
        .find(|b| b.bucket == "claude")
        .unwrap();
    assert_eq!(claude.session_count, 1);
}

#[test]
fn bucket_filter_scopes_to_one_source() {
    let conn = seeded_conn();
    let filter = UsageFilter {
        bucket: Some(BUCKET_CLAUDE.to_string()),
        ..UsageFilter::default()
    };
    let summary = usage_summary(&conn, &filter).expect("summary");
    assert_eq!(summary.session_count, 1);
    assert_eq!(summary.input_tokens, 1_500_000);
    assert_eq!(summary.request_count, 2);
}

#[test]
fn all_sources_includes_other_bucket() {
    let conn = seeded_conn();
    insert_imported(
        &conn,
        "opencode",
        "ext-opencode",
        "gpt-5",
        (50_000, 5_000),
        ms("2026-07-18T06:00:00Z"),
        1,
    );
    recompute_session_usage(&conn, "ext-opencode")
        .unwrap()
        .expect("opencode projected");

    let scoped = usage_summary(&conn, &UsageFilter::default()).expect("scoped summary");
    assert_eq!(scoped.session_count, 3);

    let all = usage_summary(
        &conn,
        &UsageFilter {
            all_sources: true,
            ..UsageFilter::default()
        },
    )
    .expect("all-sources summary");
    assert_eq!(all.session_count, 4);
    assert!(all.by_bucket.iter().any(|bucket| bucket.bucket == "other"));
}

#[test]
fn time_window_filters_sessions_by_last_activity() {
    let conn = seeded_conn();
    // Window covering only 02:00–02:30 → just the codex imported session.
    let filter = UsageFilter {
        bucket: None,
        start_ms: Some(ms("2026-07-18T01:30:00Z")),
        end_ms: Some(ms("2026-07-18T02:30:00Z")),
        ..UsageFilter::default()
    };
    let summary = usage_summary(&conn, &filter).expect("summary");
    assert_eq!(summary.session_count, 1);
    assert_eq!(
        summary.by_bucket.first().map(|b| b.bucket.as_str()),
        Some("codex")
    );
}

#[test]
fn sessions_table_sorts_and_excludes_mirror() {
    let conn = seeded_conn();
    let rows = usage_sessions(&conn, &UsageFilter::default(), SessionSort::Cost, 0, 100)
        .expect("sessions");
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().all(|r| r.session_id != "mirror-claude"));
    // Sorted by cost descending.
    for pair in rows.windows(2) {
        assert!(pair[0].cost_usd >= pair[1].cost_usd);
    }
    // Native claude row has a turn count; imported codex row has none.
    let claude = rows.iter().find(|r| r.session_id == "cli-claude").unwrap();
    assert_eq!(claude.turn_count, 2);
    assert_eq!(claude.name, "Claude run");
    let codex = rows.iter().find(|r| r.session_id == "ext-codex").unwrap();
    assert_eq!(codex.turn_count, 0);
    assert_eq!(
        codex.tokens_source,
        crate::session_usage::TOKENS_SOURCE_IMPORTED
    );
}

#[test]
fn sessions_table_paginates() {
    let conn = seeded_conn();
    let page = usage_sessions(&conn, &UsageFilter::default(), SessionSort::Recent, 1, 1)
        .expect("sessions");
    assert_eq!(page.len(), 1);
}

#[test]
fn trends_use_per_turn_native_and_lumped_imported() {
    let conn = seeded_conn();
    let series = usage_trends(&conn, &UsageFilter::default(), TrendBucket::Hour).expect("trends");
    // Distinct hour buckets: codex 02:00, claude 03:00, org2 04:00, claude 05:00.
    let keys: Vec<i64> = series.iter().map(|p| p.bucket_ms).collect();
    assert_eq!(
        keys,
        vec![
            ms("2026-07-18T02:00:00Z"),
            ms("2026-07-18T03:00:00Z"),
            ms("2026-07-18T04:00:00Z"),
            ms("2026-07-18T05:00:00Z"),
        ]
    );
    // The 03:00 native claude turn carries its full split; mirror excluded.
    let three = series
        .iter()
        .find(|p| p.bucket_ms == ms("2026-07-18T03:00:00Z"))
        .unwrap();
    assert_eq!(three.input_tokens, 1_000_000);
    assert_eq!(three.cache_read_tokens, 200_000);
    assert!(three.cost_usd > 0.0);
    // The 02:00 imported codex point is lumped session-level.
    let two = series
        .iter()
        .find(|p| p.bucket_ms == ms("2026-07-18T02:00:00Z"))
        .unwrap();
    assert_eq!(two.input_tokens, 400_000);
}

#[test]
fn trends_day_bucket_collapses_hours() {
    let conn = seeded_conn();
    let series = usage_trends(&conn, &UsageFilter::default(), TrendBucket::Day).expect("trends");
    assert_eq!(series.len(), 1);
    assert_eq!(series[0].bucket_ms, ms("2026-07-18T00:00:00Z"));
}

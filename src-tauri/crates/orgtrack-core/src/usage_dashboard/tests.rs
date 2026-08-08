//! Tests for the Usage dashboard: headline summary, per-session table,
//! per-round request log, trend buckets, and the combined
//! [`super::usage_overview`] streaming pass — including the mirror-exclusion
//! and bucket/time-window invariants the module doc comment calls out.

use super::rounds::{native_turn_candidates_for_filter, native_turn_query_plan};
use super::*;
use crate::session_usage::recompute_session_usage;
use crate::store::sqlite::SqliteRecordStore;
use rusqlite::params;
use std::collections::HashSet;

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
         );
         CREATE INDEX idx_stu_session_created_at_id
             ON session_token_usage(session_id, created_at, id);",
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

#[test]
fn daily_rollup_buckets_days_and_excludes_mirror() {
    let conn = seeded_conn();
    // A second UTC day for the native claude session, so the rollup must
    // split one session across two day rows.
    insert_turn(
        &conn,
        "cli-claude",
        "claude-sonnet-4-5",
        (100_000, 10_000, 0, 0),
        "2026-07-19T01:00:00Z",
    );
    recompute_session_usage(&conn, "cli-claude")
        .unwrap()
        .expect("claude reprojected");

    let rollup = usage_daily_rollup(
        &conn,
        ms("2026-07-01T00:00:00Z"),
        ms("2026-07-31T23:59:59Z"),
    )
    .expect("daily rollup");

    // Sorted by (dayStartMs, bucket).
    let keys: Vec<(i64, &str)> = rollup
        .days
        .iter()
        .map(|row| (row.day_start_ms, row.bucket.as_str()))
        .collect();
    assert_eq!(
        keys,
        vec![
            (ms("2026-07-18T00:00:00Z"), "claude"),
            (ms("2026-07-18T00:00:00Z"), "codex"),
            (ms("2026-07-18T00:00:00Z"), "org2"),
            (ms("2026-07-19T00:00:00Z"), "claude"),
        ]
    );

    // Day-18 claude cell: exactly the 2 native turns. The listable=0 mirror
    // twin (1.5M input at 03:30) must not add a fallback round — its tokens
    // would double the cell and bump sessions/requests.
    let day18_claude = &rollup.days[0];
    assert_eq!(day18_claude.input_tokens, 1_500_000);
    assert_eq!(day18_claude.output_tokens, 150_000);
    assert_eq!(day18_claude.cache_read_tokens, 200_000);
    assert_eq!(day18_claude.cache_write_tokens, 50_000);
    assert_eq!(day18_claude.total_tokens, 1_900_000);
    assert_eq!(day18_claude.sessions, 1);
    assert_eq!(day18_claude.requests, 2);
    assert!(day18_claude.cost_usd > 0.0);

    let day19_claude = &rollup.days[3];
    assert_eq!(day19_claude.input_tokens, 100_000);
    assert_eq!(day19_claude.output_tokens, 10_000);
    assert_eq!(day19_claude.sessions, 1);
    assert_eq!(day19_claude.requests, 1);

    // The imported codex fallback round lands as one request on day 18.
    let day18_codex = &rollup.days[1];
    assert_eq!(day18_codex.input_tokens, 400_000);
    assert_eq!(day18_codex.sessions, 1);
    assert_eq!(day18_codex.requests, 1);

    // Lifetime census: cli-claude + agent-1 + ext-codex; the listable=0
    // mirror twin must not inflate the count.
    assert_eq!(rollup.total_sessions, 3);
}

#[test]
fn daily_rollup_includes_other_bucket() {
    let conn = seeded_conn();
    // Long-tail provider → `other` bucket, which the desktop dashboard's
    // default scope drops but the team rollup must keep.
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

    let rollup = usage_daily_rollup(
        &conn,
        ms("2026-07-18T00:00:00Z"),
        ms("2026-07-18T23:59:59Z"),
    )
    .expect("daily rollup");

    let other = rollup
        .days
        .iter()
        .find(|row| row.bucket == "other")
        .expect("other bucket present");
    assert_eq!(other.day_start_ms, ms("2026-07-18T00:00:00Z"));
    assert_eq!(other.input_tokens, 50_000);
    assert_eq!(other.output_tokens, 5_000);
    assert_eq!(other.sessions, 1);
    assert_eq!(other.requests, 1);
    // `other` sorts after the four scoped buckets within the day.
    assert_eq!(
        rollup.days.last().map(|row| row.bucket.as_str()),
        Some("other")
    );
}

#[test]
fn daily_rollup_window_clips_rounds() {
    let conn = seeded_conn();
    // Window covering only 02:00–02:30 → just the imported codex round.
    let rollup = usage_daily_rollup(
        &conn,
        ms("2026-07-18T01:30:00Z"),
        ms("2026-07-18T02:30:00Z"),
    )
    .expect("daily rollup");

    assert_eq!(rollup.days.len(), 1);
    assert_eq!(rollup.days[0].bucket, "codex");
    assert_eq!(rollup.days[0].day_start_ms, ms("2026-07-18T00:00:00Z"));
    assert_eq!(rollup.days[0].input_tokens, 400_000);
}

#[test]
fn daily_rollup_derives_a_true_rolling_24h_snapshot_in_the_same_scan() {
    let conn = fixture_conn();
    insert_code_session(
        &conn,
        "rolling-claude",
        "claude",
        "Rolling window",
        "2026-07-18T12:00:00+00:00",
    );
    insert_turn(
        &conn,
        "rolling-claude",
        "claude-sonnet-4-5",
        (100, 10, 0, 0),
        "2026-07-17T11:59:59.999Z",
    );
    insert_turn(
        &conn,
        "rolling-claude",
        "claude-sonnet-4-5",
        (200, 20, 30, 40),
        "2026-07-17T12:00:00Z",
    );
    recompute_session_usage(&conn, "rolling-claude")
        .unwrap()
        .expect("rolling session projected");

    let end_ms = ms("2026-07-18T12:00:00Z");
    let rollup = usage_daily_rollup(&conn, ms("2026-07-01T00:00:00Z"), end_ms)
        .expect("daily + rolling rollup");

    assert_eq!(rollup.recent_usage_24h.start_ms, ms("2026-07-17T12:00:00Z"));
    assert_eq!(rollup.recent_usage_24h.end_ms, end_ms);
    assert_eq!(rollup.recent_usage_24h.summary.input_tokens, 200);
    assert_eq!(rollup.recent_usage_24h.summary.output_tokens, 20);
    assert_eq!(rollup.recent_usage_24h.summary.cache_read_tokens, 30);
    assert_eq!(rollup.recent_usage_24h.summary.cache_write_tokens, 40);
    assert_eq!(rollup.recent_usage_24h.summary.session_count, 1);
    assert_eq!(rollup.recent_usage_24h.summary.request_count, 1);
    assert_eq!(rollup.recent_usage_24h.trends.len(), 1);
    assert_eq!(
        rollup.recent_usage_24h.trends[0].bucket_ms,
        ms("2026-07-17T12:00:00Z")
    );

    // The daily sync window still contains both rounds; the rolling snapshot
    // alone excludes the row one millisecond before the 24h boundary.
    assert_eq!(
        rollup.days.iter().map(|row| row.input_tokens).sum::<i64>(),
        300
    );
}

#[test]
fn daily_rollup_skips_zero_usage_cells() {
    let conn = seeded_conn();
    // A zero-token turn on an otherwise idle day: the cell would carry a
    // request but no tokens/cost, and must be omitted from the wire rows.
    insert_turn(
        &conn,
        "cli-claude",
        "claude-sonnet-4-5",
        (0, 0, 0, 0),
        "2026-07-20T01:00:00Z",
    );
    recompute_session_usage(&conn, "cli-claude")
        .unwrap()
        .expect("claude reprojected");

    let rollup = usage_daily_rollup(
        &conn,
        ms("2026-07-20T00:00:00Z"),
        ms("2026-07-20T23:59:59Z"),
    )
    .expect("daily rollup");
    assert!(
        rollup.days.is_empty(),
        "zero-usage day must be skipped: {:?}",
        rollup.days
    );
}

#[test]
fn native_window_pushdown_preserves_inclusive_millisecond_bounds() {
    // A fresh, minimal fixture (not `seeded_conn`) so the boundary math below
    // is easy to check by hand without other fixture rows in range.
    let conn = fixture_conn();
    insert_code_session(
        &conn,
        "boundary-claude",
        "claude",
        "Boundary run",
        "2026-07-18T02:00:00+00:00",
    );

    let boundary_ms = ms("2026-07-18T02:00:00Z");

    // Every native `created_at` in production is `Utc::now().to_rfc3339()`:
    // fixed `+00:00` offset, minimal (chrono `AutoSi`) fractional digits.
    // These rows pin the floor-vs-boundary edge the SQL pushdown must get
    // right: `iso_to_ms` floors sub-millisecond precision away, so a turn
    // landing in the SAME millisecond as the window's upper bound but with
    // extra sub-ms precision must still be included (rows at 333/555 below).
    insert_turn(
        &conn,
        "boundary-claude",
        "claude-sonnet-4-5",
        (111, 0, 0, 0),
        "2026-07-18T01:59:59.999+00:00", // boundary_ms - 1ms: excluded
    );
    insert_turn(
        &conn,
        "boundary-claude",
        "claude-sonnet-4-5",
        (222, 0, 0, 0),
        "2026-07-18T02:00:00+00:00", // exactly boundary_ms: included
    );
    insert_turn(
        &conn,
        "boundary-claude",
        "claude-sonnet-4-5",
        (333, 0, 0, 0),
        "2026-07-18T02:00:00.000700+00:00", // boundary_ms + 0.7ms, same floor: included
    );
    insert_turn(
        &conn,
        "boundary-claude",
        "claude-sonnet-4-5",
        (444, 0, 0, 0),
        "2026-07-18T02:00:00.001+00:00", // boundary_ms + 1ms: excluded
    );
    insert_turn(
        &conn,
        "boundary-claude",
        "claude-sonnet-4-5",
        (555, 0, 0, 0),
        "2026-07-18T02:00:00.001200+00:00", // boundary_ms + 1.2ms: excluded
    );
    recompute_session_usage(&conn, "boundary-claude")
        .unwrap()
        .expect("boundary session projected");

    // Zero-width window: only turns whose floored millisecond is exactly
    // `boundary_ms` should survive on either code path.
    let filter = UsageFilter {
        bucket: None,
        start_ms: Some(boundary_ms),
        end_ms: Some(boundary_ms),
        session_id: None,
        all_sources: true,
    };

    // Interactive and unattended callers now share the SQL-pushed-down path.
    let interactive =
        usage_rounds(&conn, &filter, SessionSort::Recent, 0, 100).expect("interactive rounds");
    assert_eq!(interactive.len(), 2);
    assert_eq!(
        interactive.iter().map(|r| r.input_tokens).sum::<i64>(),
        222 + 333
    );

    // The daily rollup must retain the same inclusive millisecond semantics.
    let rollup = usage_daily_rollup(&conn, boundary_ms, boundary_ms).expect("daily rollup");
    assert_eq!(rollup.days.len(), 1);
    assert_eq!(rollup.days[0].bucket, "claude");
    assert_eq!(rollup.days[0].requests, 2);
    assert_eq!(rollup.days[0].input_tokens, 222 + 333);
}

#[test]
fn interactive_native_query_loads_only_windowed_scoped_rows_and_uses_stable_ids() {
    let conn = fixture_conn();
    insert_code_session(
        &conn,
        "windowed-claude",
        "claude",
        "Windowed Claude",
        "2026-07-18T02:00:00+00:00",
    );
    conn.execute(
        "INSERT INTO agent_sessions
            (session_id, name, model, account_id, key_source, updated_at)
         VALUES
            ('windowed-org2', 'Windowed Org2', 'gpt-5', 'acct-1', 'own_key',
             '2026-07-18T02:00:00+00:00')",
        [],
    )
    .expect("insert out-of-source session");

    // Large lifetime tail for the in-scope session. The old interactive path
    // mapped every one of these rows before dropping them in Rust.
    for index in 0..1_000 {
        insert_turn(
            &conn,
            "windowed-claude",
            "claude-sonnet-4-5",
            (index + 1, 0, 0, 0),
            "2025-01-01T00:00:00+00:00",
        );
    }
    insert_turn(
        &conn,
        "windowed-claude",
        "claude-sonnet-4-5",
        (2_001, 0, 0, 0),
        "2026-07-18T02:00:00+00:00",
    );
    let first_target_id = conn.last_insert_rowid();
    insert_turn(
        &conn,
        "windowed-claude",
        "claude-sonnet-4-5",
        (2_002, 0, 0, 0),
        "2026-07-18T02:00:00.000700+00:00",
    );
    let second_target_id = conn.last_insert_rowid();
    insert_turn(
        &conn,
        "windowed-org2",
        "gpt-5",
        (9_999, 0, 0, 0),
        "2026-07-18T02:00:00+00:00",
    );
    recompute_session_usage(&conn, "windowed-claude")
        .unwrap()
        .expect("claude projected");
    recompute_session_usage(&conn, "windowed-org2")
        .unwrap()
        .expect("org2 projected");

    let boundary_ms = ms("2026-07-18T02:00:00Z");
    let filter = UsageFilter {
        bucket: Some(BUCKET_CLAUDE.to_string()),
        start_ms: Some(boundary_ms),
        end_ms: Some(boundary_ms),
        session_id: None,
        all_sources: false,
    };
    let lifetime_rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM session_token_usage", [], |row| {
            row.get(0)
        })
        .expect("lifetime row count");
    assert_eq!(lifetime_rows, 1_003);
    assert_eq!(
        native_turn_candidates_for_filter(&conn, &filter).expect("windowed candidates"),
        2,
        "only the two in-window Claude rows should cross into Rust"
    );

    let rows = usage_rounds(&conn, &filter, SessionSort::Recent, 0, 100).expect("windowed rounds");
    assert_eq!(rows.len(), 2);
    let round_ids = rows
        .iter()
        .map(|row| row.round_id.clone())
        .collect::<HashSet<_>>();
    assert_eq!(
        round_ids,
        HashSet::from([
            format!("windowed-claude#{first_target_id}"),
            format!("windowed-claude#{second_target_id}"),
        ])
    );

    // Changing the time window must not renumber the same database rows.
    let broad = usage_rounds(
        &conn,
        &UsageFilter {
            bucket: Some(BUCKET_CLAUDE.to_string()),
            ..UsageFilter::default()
        },
        SessionSort::Recent,
        0,
        2_000,
    )
    .expect("broad rounds");
    assert!(broad
        .iter()
        .any(|row| row.round_id == format!("windowed-claude#{first_target_id}")));
    assert!(broad
        .iter()
        .any(|row| row.round_id == format!("windowed-claude#{second_target_id}")));

    let plan = native_turn_query_plan(&conn, &filter).expect("native query plan");
    assert!(
        plan.iter()
            .any(|detail| detail.contains("idx_stu_session_created_at_id")),
        "windowed native query must use the canonical scoped-window index: {plan:?}"
    );
}

#[test]
fn daily_rollup_serializes_camel_case() {
    let row = DailyRollupRow {
        day_start_ms: 1_784_332_800_000,
        bucket: "claude".to_string(),
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 3,
        cache_write_tokens: 4,
        total_tokens: 10,
        cost_usd: 0.5,
        sessions: 1,
        requests: 2,
    };
    let json = serde_json::to_value(DailyRollup {
        days: vec![row],
        total_sessions: 42,
        recent_usage_24h: RecentUsageSnapshot {
            start_ms: 1_784_332_800_000,
            end_ms: 1_784_419_200_000,
            summary: UsageSummary::default(),
            trends: vec![UsageTrendPoint {
                bucket_ms: 1_784_332_800_000,
                input_tokens: 5,
                ..UsageTrendPoint::default()
            }],
        },
    })
    .expect("serialize rollup");
    assert_eq!(json["totalSessions"], 42);
    let row = &json["days"][0];
    assert_eq!(row["dayStartMs"], 1_784_332_800_000_i64);
    assert_eq!(row["bucket"], "claude");
    assert_eq!(row["inputTokens"], 1);
    assert_eq!(row["outputTokens"], 2);
    assert_eq!(row["cacheReadTokens"], 3);
    assert_eq!(row["cacheWriteTokens"], 4);
    assert_eq!(row["totalTokens"], 10);
    assert_eq!(row["costUsd"], 0.5);
    assert_eq!(row["sessions"], 1);
    assert_eq!(row["requests"], 2);
    assert_eq!(json["recentUsage24h"]["startMs"], 1_784_332_800_000_i64);
    assert_eq!(json["recentUsage24h"]["endMs"], 1_784_419_200_000_i64);
    assert_eq!(json["recentUsage24h"]["trends"][0]["inputTokens"], 5);
}

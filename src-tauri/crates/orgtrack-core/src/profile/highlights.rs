//! Highlight cards — the readable half of the profile.
//!
//! The four axes answer "what kind of builder are you". These answer the
//! questions you'd actually ask about your own year: how long was the longest
//! session, how many agents at once, when do you work, what did you build.
//!
//! Two rules keep the deck honest and varied:
//!
//! 1. **A card is emitted only when its number is real.** Every builder returns
//!    `Option`, so a corpus with no diffs simply has no lines-changed card
//!    rather than a card reading "0 lines". Nothing is padded.
//! 2. **The deck is deliberately mixed.** Cards are grouped by `kind` — scale,
//!    extreme, rhythm, style, craft — and the deck interleaves the groups so the
//!    result is not fourteen variations on "big number of the same shape".
//!
//! Nothing here reads message text. Signal rows hold aggregates only, so the
//! "your go-to prompt" style of card (a literal quote) is deliberately absent;
//! it would need a separate path that reads transcripts and persists nothing.
//!
//! **No prose here.** A card carries an id and raw numbers; the panel renders
//! the wording from `builderProfile.cards.<id>`. Formatting has to happen there
//! too — thousands separators, dates, and whether an hour reads as "5pm" or
//! "17:00" are all locale decisions that a Rust `format!` would get wrong for
//! every user outside en-US.

use chrono::{DateTime, Datelike, Local, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};

use super::signals::SessionSignals;

/// Card family. The panel uses this to vary presentation and to interleave.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HighlightKind {
    /// Totals — how much, over how long.
    Scale,
    /// Records — the biggest single instance of something.
    Extreme,
    /// When and how often you show up.
    Rhythm,
    /// How you talk to the agent.
    Style,
    /// What you actually built.
    Craft,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    /// Selects `cards.<id>.question` and `cards.<id>.headline`.
    pub id: String,
    /// Selects `cards.<id>.detail`. Usually the same as `id`; a few cards swap
    /// only their closing line depending on the numbers.
    pub detail_id: String,
    pub kind: HighlightKind,
    /// Interpolation values, raw. The panel formats them for the locale.
    pub params: serde_json::Value,
}

fn card(id: &'static str, kind: HighlightKind, params: serde_json::Value) -> Highlight {
    Highlight {
        id: id.to_string(),
        detail_id: id.to_string(),
        kind,
        params,
    }
}

/// Same card, but its closing line comes from a different key.
fn card_with_detail(
    id: &'static str,
    detail_id: &'static str,
    kind: HighlightKind,
    params: serde_json::Value,
) -> Highlight {
    Highlight {
        id: id.to_string(),
        detail_id: detail_id.to_string(),
        kind,
        params,
    }
}

/// Local calendar time. "When do you work" and "how many days in a row" are
/// questions about the user's own clock; answering them in UTC shifts the hour
/// and moves sessions across day boundaries, which silently breaks streaks too.
fn day(ms: i64) -> Option<DateTime<Local>> {
    (ms > 0)
        .then(|| Local.timestamp_millis_opt(ms).single())
        .flatten()
}

/// Build the deck. `parallel` is the per-session concurrency share, in the same
/// order as `sessions`.
pub fn build(sessions: &[SessionSignals], parallel: &[f64]) -> Vec<Highlight> {
    use serde_json::json;

    if sessions.is_empty() {
        return Vec::new();
    }
    let n = sessions.len() as i64;
    let mut out: Vec<Highlight> = Vec::new();

    // ---- scale ----
    let total_secs: f64 = sessions.iter().map(|s| s.active_secs).sum();
    if total_secs > 3600.0 {
        out.push(card(
            "total_time",
            HighlightKind::Scale,
            json!({ "hours": (total_secs / 3600.0).round() as i64, "sessions": n }),
        ));
    }
    let added: i64 = sessions.iter().map(|s| s.lines_added).sum();
    let removed: i64 = sessions.iter().map(|s| s.lines_removed).sum();
    if added > 0 {
        let touched = sessions.iter().filter(|s| s.lines_added > 0).count() as i64;
        out.push(card(
            "lines",
            HighlightKind::Scale,
            json!({ "added": added, "sessions": touched, "removed": removed }),
        ));
    }
    let tools: i64 = sessions.iter().map(|s| s.tool_calls).sum();
    if tools > 0 {
        out.push(card(
            "tool_calls",
            HighlightKind::Scale,
            json!({ "total": tools, "perSession": (tools / n.max(1)).max(1) }),
        ));
    }

    // ---- extremes ----
    if let Some(longest) = sessions
        .iter()
        .max_by(|a, b| a.longest_span_secs.total_cmp(&b.longest_span_secs))
        .filter(|s| s.longest_span_secs > 600.0)
    {
        out.push(card(
            "longest_session",
            HighlightKind::Extreme,
            json!({ "seconds": longest.longest_span_secs.round() as i64 }),
        ));
    }
    if let Some(run) = sessions
        .iter()
        .map(|s| s.max_chain)
        .max()
        .filter(|v| *v > 5)
    {
        out.push(card(
            "longest_run",
            HighlightKind::Extreme,
            json!({ "steps": run }),
        ));
    }
    if let Some(peak) = parallel
        .iter()
        .copied()
        .fold(None::<f64>, |m, v| Some(m.map_or(v, |x: f64| x.max(v))))
        .filter(|v| *v > 0.2)
    {
        out.push(card(
            "parallel_peak",
            HighlightKind::Extreme,
            json!({ "percent": (peak * 100.0).round() as i64 }),
        ));
    }

    // ---- rhythm ----
    let days: BTreeSet<i32> = sessions
        .iter()
        .filter_map(|s| day(s.started_at_ms).map(|d| d.num_days_from_ce()))
        .collect();
    if let Some(streak) = longest_streak(&days).filter(|v| *v > 1) {
        out.push(card(
            "streak",
            HighlightKind::Rhythm,
            json!({ "days": streak }),
        ));
    }
    let mut by_hour: HashMap<u32, i64> = HashMap::new();
    for s in sessions {
        if let Some(d) = day(s.started_at_ms) {
            *by_hour.entry(d.hour()).or_default() += 1;
        }
    }
    if let Some((hour, count)) = by_hour.iter().max_by_key(|(_, c)| **c) {
        if *count > 2 {
            out.push(card(
                "peak_hour",
                HighlightKind::Rhythm,
                json!({ "hour": hour, "sessions": count }),
            ));
        }
    }
    let deep: Vec<&SessionSignals> = sessions
        .iter()
        .filter(|s| s.longest_span_secs > 5_400.0)
        .collect();
    if !deep.is_empty() {
        let mean = deep.iter().map(|s| s.longest_span_secs).sum::<f64>() / deep.len() as f64;
        out.push(card(
            "deep_sessions",
            HighlightKind::Rhythm,
            json!({ "count": deep.len() as i64, "seconds": mean.round() as i64 }),
        ));
    }
    if let Some((date_ms, count)) = busiest_day(sessions) {
        out.push(card(
            "busiest_day",
            HighlightKind::Rhythm,
            json!({ "sessions": count, "dateMs": date_ms }),
        ));
    }

    // ---- style ----
    let with_words: Vec<&SessionSignals> = sessions
        .iter()
        .filter(|s| s.user_turns > 0 && s.prompt_words > 0)
        .collect();
    if !with_words.is_empty() {
        let turns: i64 = with_words.iter().map(|s| s.user_turns).sum();
        let words: i64 = with_words.iter().map(|s| s.prompt_words).sum();
        let mean_words = (words / turns.max(1)).max(1);
        out.push(card_with_detail(
            "prompt_length",
            if mean_words < 30 {
                "prompt_length"
            } else {
                "prompt_length_long"
            },
            HighlightKind::Style,
            json!({ "words": mean_words }),
        ));
        out.push(card(
            "prompts_per_session",
            HighlightKind::Style,
            json!({ "prompts": (turns / with_words.len() as i64).max(1) }),
        ));
        if let Some(longest) = with_words
            .iter()
            .map(|s| s.longest_prompt_words)
            .max()
            .filter(|v| *v > 80)
        {
            out.push(card(
                "longest_prompt",
                HighlightKind::Style,
                json!({ "words": longest }),
            ));
        }
    }
    let redirects = mean_of(sessions, |s| s.redirect_rate);
    if redirects > 0.0 {
        out.push(card(
            "redirects",
            HighlightKind::Style,
            json!({ "percent": (redirects * 100.0).round() as i64 }),
        ));
    }
    // The question asks how often a run *lands*, so the headline is the
    // complement of the interrupt rate, not the rate itself.
    let interrupts = mean_of(sessions, |s| s.interrupt_rate).clamp(0.0, 1.0);
    let finished = ((1.0 - interrupts) * 100.0).round() as i64;
    out.push(card_with_detail(
        "interrupts",
        if interrupts < 0.005 {
            "interrupts_never"
        } else {
            "interrupts"
        },
        HighlightKind::Style,
        json!({ "percent": finished, "rest": (100 - finished).max(1) }),
    ));

    // ---- craft ----
    let builders = sessions.iter().filter(|s| s.has_edit).count() as i64;
    let planned = sessions
        .iter()
        .filter(|s| s.has_edit && s.planned_first)
        .count() as i64;
    if builders > 0 {
        out.push(card(
            "plan_first",
            HighlightKind::Craft,
            json!({
                "percent": (planned * 100 / builders.max(1)).max(0),
                "planned": planned,
                "builders": builders,
            }),
        ));
    }
    let harness = mean_of(sessions, |s| s.harness_edit_share);
    if harness > 0.0 {
        out.push(card(
            "harness",
            HighlightKind::Craft,
            json!({ "percent": (harness * 100.0).round().max(1.0) as i64 }),
        ));
    }
    let fanout = sessions.iter().filter(|s| s.delegate_calls > 0).count() as i64;
    if fanout > 0 {
        out.push(card(
            "fanout",
            HighlightKind::Craft,
            json!({ "percent": (fanout * 100 / n.max(1)).max(1) }),
        ));
    }
    let mut tools_used: Vec<&str> = sessions.iter().map(|s| s.source.as_str()).collect();
    tools_used.sort_unstable();
    tools_used.dedup();
    if tools_used.len() > 1 {
        out.push(card(
            "tool_spread",
            HighlightKind::Craft,
            json!({ "tools": tools_used.len() as i64 }),
        ));
    }

    interleave(out)
}

fn mean_of(sessions: &[SessionSignals], f: impl Fn(&SessionSignals) -> f64) -> f64 {
    if sessions.is_empty() {
        return 0.0;
    }
    sessions.iter().map(f).sum::<f64>() / sessions.len() as f64
}

fn longest_streak(days: &BTreeSet<i32>) -> Option<i64> {
    let mut best = 0i64;
    let mut run = 0i64;
    let mut prev: Option<i32> = None;
    for d in days {
        run = match prev {
            Some(p) if *d == p + 1 => run + 1,
            _ => 1,
        };
        best = best.max(run);
        prev = Some(*d);
    }
    (best > 0).then_some(best)
}

/// Busiest local calendar day as `(timestamp_ms, sessions)`. The timestamp is
/// returned raw so the panel can render it in the user's own date format.
fn busiest_day(sessions: &[SessionSignals]) -> Option<(i64, i64)> {
    let mut counts: HashMap<i32, (i64, i64)> = HashMap::new();
    for s in sessions {
        if let Some(d) = day(s.started_at_ms) {
            let entry = counts
                .entry(d.num_days_from_ce())
                .or_insert((s.started_at_ms, 0));
            entry.0 = entry.0.min(s.started_at_ms);
            entry.1 += 1;
        }
    }
    counts
        .into_values()
        .max_by_key(|(_, c)| *c)
        .filter(|(_, c)| *c > 2)
}

/// Round-robin the families so the deck reads as a mix rather than as five
/// blocks of near-identical cards.
fn interleave(cards: Vec<Highlight>) -> Vec<Highlight> {
    use HighlightKind::*;
    // Rhythm leads so the streak — the longest span the deck can show — opens
    // the grid; the rest of the rotation keeps the families mixed.
    let order = [Rhythm, Extreme, Craft, Style, Scale];
    let mut buckets: Vec<Vec<Highlight>> = order.iter().map(|_| Vec::new()).collect();
    for c in cards {
        let idx = order.iter().position(|k| *k == c.kind).unwrap_or(0);
        buckets[idx].push(c);
    }
    let mut out = Vec::new();
    let mut round = 0;
    loop {
        let mut pushed = false;
        for b in buckets.iter_mut() {
            if round < b.len() {
                out.push(b[round].clone());
                pushed = true;
            }
        }
        if !pushed {
            break;
        }
        round += 1;
    }
    out
}

/// Every id `build` can emit. The panel needs a translation for each, so this
/// doubles as the contract between the deck and `builderProfile.cards.*`.
pub const CARD_IDS: [&str; 21] = [
    "total_time",
    "lines",
    "tool_calls",
    "longest_session",
    "longest_run",
    "parallel_peak",
    "streak",
    "peak_hour",
    "deep_sessions",
    "busiest_day",
    "prompt_length",
    "prompt_length_long",
    "prompts_per_session",
    "longest_prompt",
    "redirects",
    "interrupts",
    "interrupts_never",
    "plan_first",
    "harness",
    "fanout",
    "tool_spread",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn sess(i: i64) -> SessionSignals {
        SessionSignals {
            session_id: format!("s{i}"),
            source: "claude_code".into(),
            // one session per day, 09:00 UTC
            started_at_ms: 1_760_000_000_000 + i * 86_400_000,
            active_secs: 3_600.0,
            longest_span_secs: 3_600.0,
            active_spans: vec![(0, 1000)],
            user_turns: 5,
            prompt_words: 100,
            longest_prompt_words: 40,
            tool_calls: 50,
            max_chain: 12,
            has_edit: true,
            ..Default::default()
        }
    }

    fn find<'a>(cards: &'a [Highlight], id: &str) -> &'a Highlight {
        cards
            .iter()
            .find(|c| c.id == id)
            .unwrap_or_else(|| panic!("no {id} card"))
    }

    #[test]
    fn a_card_is_omitted_rather_than_showing_a_hollow_zero() {
        let quiet: Vec<SessionSignals> = (0..5)
            .map(|i| SessionSignals {
                session_id: format!("s{i}"),
                started_at_ms: 1_760_000_000_000,
                ..Default::default()
            })
            .collect();
        let cards = build(&quiet, &vec![0.0; quiet.len()]);
        for id in ["lines", "longest_session", "streak", "harness", "fanout"] {
            assert!(
                !cards.iter().any(|c| c.id == id),
                "{id} should not appear without real data"
            );
        }
    }

    #[test]
    fn consecutive_days_make_a_streak_and_a_gap_breaks_it() {
        let days: BTreeSet<i32> = [1, 2, 3, 4, 9, 10].into_iter().collect();
        assert_eq!(longest_streak(&days), Some(4));
        assert_eq!(longest_streak(&BTreeSet::new()), None);
    }

    #[test]
    fn the_deck_mixes_families_instead_of_grouping_them() {
        let v: Vec<_> = (0..30).map(sess).collect();
        let cards = build(&v, &vec![0.5; v.len()]);
        assert!(
            cards.len() >= 6,
            "expected a full deck, got {}",
            cards.len()
        );
        let kinds: Vec<_> = cards.iter().take(4).map(|c| c.kind).collect();
        let unique: BTreeSet<_> = kinds.iter().map(|k| format!("{k:?}")).collect();
        assert!(
            unique.len() >= 3,
            "first four cards should span families, got {kinds:?}"
        );
    }

    #[test]
    fn cards_carry_numbers_only_so_the_panel_owns_the_wording() {
        let v: Vec<_> = (0..30).map(sess).collect();
        for c in build(&v, &vec![0.5; v.len()]) {
            assert!(CARD_IDS.contains(&c.id.as_str()), "unlisted id {}", c.id);
            assert!(
                CARD_IDS.contains(&c.detail_id.as_str()),
                "unlisted detail id {}",
                c.detail_id
            );
            let obj = c.params.as_object().expect("params must be an object");
            assert!(!obj.is_empty(), "{} has no params", c.id);
            for (k, v) in obj {
                assert!(
                    v.is_number(),
                    "{}.{k} is {v}; prose belongs in the locale files",
                    c.id
                );
            }
        }
    }

    #[test]
    fn a_finished_run_is_reported_as_finished_not_as_its_complement() {
        let mut v: Vec<_> = (0..30).map(sess).collect();
        for s in v.iter_mut() {
            s.interrupt_rate = 0.05; // you cut 5% of runs short
        }
        let cards = build(&v, &vec![0.0; v.len()]);
        let c = find(&cards, "interrupts");
        assert_eq!(
            c.params["percent"], 95,
            "the question asks how often it lands"
        );
        assert_eq!(c.params["rest"], 5);
        assert_eq!(c.detail_id, "interrupts");
    }

    #[test]
    fn a_run_that_is_never_cut_short_swaps_only_its_closing_line() {
        let v: Vec<_> = (0..30).map(sess).collect(); // interrupt_rate defaults to 0
        let cards = build(&v, &vec![0.0; v.len()]);
        let c = find(&cards, "interrupts");
        assert_eq!(c.params["percent"], 100);
        assert_eq!(c.detail_id, "interrupts_never");
    }

    #[test]
    fn the_working_hour_is_the_users_own_clock_not_utc() {
        use chrono::TimeZone;
        let local_nine = Local
            .with_ymd_and_hms(2026, 3, 10, 9, 0, 0)
            .single()
            .expect("valid local time");
        let v: Vec<_> = (0..6)
            .map(|i| SessionSignals {
                session_id: format!("s{i}"),
                started_at_ms: local_nine.timestamp_millis() + i * 60_000,
                ..sess(i)
            })
            .collect();
        let cards = build(&v, &vec![0.0; v.len()]);
        let c = find(&cards, "peak_hour");
        assert_eq!(c.params["hour"], 9, "hour must be the local clock, not UTC");
    }

    #[test]
    fn the_busiest_day_carries_a_timestamp_for_the_panel_to_format() {
        let v: Vec<_> = (0..30).map(|i| SessionSignals { ..sess(i / 10) }).collect();
        let cards = build(&v, &vec![0.0; v.len()]);
        let c = find(&cards, "busiest_day");
        assert!(c.params["dateMs"].as_i64().unwrap_or(0) > 0);
        assert!(c.params["sessions"].as_i64().unwrap_or(0) > 2);
    }
}

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
    /// Stable id, for test selectors and for the panel's keys.
    pub id: String,
    pub kind: HighlightKind,
    /// The question the card answers, e.g. "Your longest single session?".
    pub question: String,
    /// The answer, large: "14h 55m".
    pub headline: String,
    /// One line of context under it.
    pub detail: String,
}

fn card(
    id: &'static str,
    kind: HighlightKind,
    question: &'static str,
    headline: String,
    detail: String,
) -> Highlight {
    Highlight {
        id: id.to_string(),
        kind,
        question: question.to_string(),
        headline,
        detail,
    }
}

fn plural(n: i64, one: &str, many: &str) -> String {
    if n == 1 {
        one.to_string()
    } else {
        many.replace("{}", &thousands(n))
    }
}

/// 232098 -> "232,098". Big numbers are the whole point of these cards.
fn thousands(n: i64) -> String {
    let s = n.abs().to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 {
        format!("-{out}")
    } else {
        out
    }
}

fn duration(secs: f64) -> String {
    let total = secs.max(0.0) as i64;
    let (h, m) = (total / 3600, (total % 3600) / 60);
    match (h, m) {
        (0, 0) => format!("{total}s"),
        (0, m) => format!("{m}m"),
        (h, 0) => format!("{h}h"),
        (h, m) => format!("{h}h {m}m"),
    }
}

fn hour_label(hour: u32) -> String {
    match hour {
        0 => "midnight".into(),
        12 => "noon".into(),
        h if h < 12 => format!("{h}am"),
        h => format!("{}pm", h - 12),
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
            "How much time did you put in?",
            format!("{} hours", thousands((total_secs / 3600.0).round() as i64)),
            plural(n, "In a single session.", "Across {} sessions."),
        ));
    }
    let added: i64 = sessions.iter().map(|s| s.lines_added).sum();
    let removed: i64 = sessions.iter().map(|s| s.lines_removed).sum();
    if added > 0 {
        let touched = sessions.iter().filter(|s| s.lines_added > 0).count() as i64;
        out.push(card(
            "lines",
            HighlightKind::Scale,
            "How much did you ship?",
            format!("{} lines", thousands(added)),
            format!(
                "Added across {} sessions, with {} removed.",
                thousands(touched),
                thousands(removed)
            ),
        ));
    }
    let tools: i64 = sessions.iter().map(|s| s.tool_calls).sum();
    if tools > 0 {
        out.push(card(
            "tool_calls",
            HighlightKind::Scale,
            "How much did the agent do?",
            format!("{} tool calls", thousands(tools)),
            format!(
                "About {} per session.",
                thousands((tools / n.max(1)).max(1))
            ),
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
            "Your longest single session?",
            duration(longest.longest_span_secs),
            "Your deepest uninterrupted stretch with an agent.".into(),
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
            "How far does the agent get on its own?",
            format!("{run} steps"),
            "Its longest run without a word from you.".into(),
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
            "How often is more than one agent running?",
            format!("{}% of your time", (peak * 100.0).round() as i64),
            "In your most parallel session, that share of it had company.".into(),
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
            "What's your longest streak?",
            format!("{streak} days straight"),
            "Consecutive days you worked with an agent.".into(),
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
                "When do you work?",
                hour_label(*hour),
                format!("You started {} sessions in that hour.", thousands(*count)),
            ));
        }
    }
    let deep = sessions
        .iter()
        .filter(|s| s.longest_span_secs > 5_400.0)
        .count() as i64;
    if deep > 0 {
        let mean = sessions
            .iter()
            .filter(|s| s.longest_span_secs > 5_400.0)
            .map(|s| s.longest_span_secs)
            .sum::<f64>()
            / deep as f64;
        out.push(card(
            "deep_sessions",
            HighlightKind::Rhythm,
            "How do you work?",
            plural(deep, "1 deep session", "{} deep sessions"),
            format!("Averaging {} of unbroken focus.", duration(mean)),
        ));
    }
    if let Some(busiest) = busiest_day(sessions) {
        out.push(card(
            "busiest_day",
            HighlightKind::Rhythm,
            "Your busiest day?",
            plural(busiest.1, "1 session", "{} sessions"),
            format!("All on {}.", busiest.0),
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
        out.push(card(
            "prompt_length",
            HighlightKind::Style,
            "How long are your prompts?",
            format!("{} words on average", (words / turns.max(1)).max(1)),
            if words / turns.max(1) < 30 {
                "Short and conversational.".into()
            } else {
                "You brief in paragraphs, not one-liners.".into()
            },
        ));
        out.push(card(
            "prompts_per_session",
            HighlightKind::Style,
            "How much do you talk to your agent?",
            format!(
                "{} prompts a session",
                (turns / with_words.len() as i64).max(1)
            ),
            "How often you step in over a session.".into(),
        ));
        if let Some(longest) = with_words.iter().map(|s| s.longest_prompt_words).max() {
            if longest > 80 {
                out.push(card(
                    "longest_prompt",
                    HighlightKind::Style,
                    "Your longest single prompt?",
                    format!("{} words", thousands(longest)),
                    "One message, everything in it.".into(),
                ));
            }
        }
    }
    let redirects = mean_of(sessions, |s| s.redirect_rate);
    if redirects > 0.0 {
        out.push(card(
            "redirects",
            HighlightKind::Style,
            "How often do you change course?",
            format!("{}% of messages", (redirects * 100.0).round() as i64),
            "Where you stop and point the agent somewhere else.".into(),
        ));
    }
    // The question asks how often a run *lands*, so the headline has to be the
    // complement of the interrupt rate, not the rate itself.
    let interrupts = mean_of(sessions, |s| s.interrupt_rate).clamp(0.0, 1.0);
    let finished = ((1.0 - interrupts) * 100.0).round() as i64;
    out.push(card(
        "interrupts",
        HighlightKind::Style,
        "Do you let it finish?",
        format!("{finished}% of the time"),
        if interrupts < 0.005 {
            "You almost never cut a run short.".into()
        } else {
            format!("You interrupt the other {}%.", (100 - finished).max(1))
        },
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
            "How often do you plan first?",
            format!(
                "{}% of build sessions",
                (planned * 100 / builders.max(1)).max(0)
            ),
            format!(
                "{} of {} sessions that changed code started from a plan.",
                thousands(planned),
                thousands(builders)
            ),
        ));
    }
    let harness = mean_of(sessions, |s| s.harness_edit_share);
    if harness > 0.0 {
        out.push(card(
            "harness",
            HighlightKind::Craft,
            "Do you sharpen your own tools?",
            format!("{}% of edits", (harness * 100.0).round().max(1.0) as i64),
            "Changes to your agent's own instructions — CLAUDE.md, rules, skills.".into(),
        ));
    }
    let fanout = sessions.iter().filter(|s| s.delegate_calls > 0).count() as i64;
    if fanout > 0 {
        out.push(card(
            "fanout",
            HighlightKind::Craft,
            "Do you fan out to subagents?",
            format!("{}% of sessions", (fanout * 100 / n.max(1)).max(1)),
            "Where one agent spawned others to work in parallel.".into(),
        ));
    }
    let mut tools_used: Vec<&str> = sessions.iter().map(|s| s.source.as_str()).collect();
    tools_used.sort_unstable();
    tools_used.dedup();
    if tools_used.len() > 1 {
        out.push(card(
            "tool_spread",
            HighlightKind::Craft,
            "How many agents do you keep?",
            format!("{} different tools", tools_used.len()),
            "Your work is spread across all of them.".into(),
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

fn busiest_day(sessions: &[SessionSignals]) -> Option<(String, i64)> {
    let mut counts: HashMap<String, i64> = HashMap::new();
    for s in sessions {
        if let Some(d) = day(s.started_at_ms) {
            *counts.entry(d.format("%-d %B").to_string()).or_default() += 1;
        }
    }
    counts
        .into_iter()
        .max_by_key(|(_, c)| *c)
        .filter(|(_, c)| *c > 2)
}

/// Round-robin the families so the deck reads as a mix rather than as five
/// blocks of near-identical cards.
fn interleave(cards: Vec<Highlight>) -> Vec<Highlight> {
    use HighlightKind::*;
    let order = [Extreme, Rhythm, Craft, Style, Scale];
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

    #[test]
    fn thousands_separator() {
        assert_eq!(thousands(232_098), "232,098");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1_000), "1,000");
    }

    #[test]
    fn duration_reads_like_a_person_wrote_it() {
        assert_eq!(duration(53_700.0), "14h 55m");
        assert_eq!(duration(3_600.0), "1h");
        assert_eq!(duration(90.0), "1m");
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
    fn a_finished_run_is_reported_as_finished_not_as_its_complement() {
        let mut v: Vec<_> = (0..30).map(sess).collect();
        for s in v.iter_mut() {
            s.interrupt_rate = 0.05; // you cut 5% of runs short
        }
        let cards = build(&v, &vec![0.0; v.len()]);
        let c = cards.iter().find(|c| c.id == "interrupts").expect("card");
        assert_eq!(
            c.headline, "95% of the time",
            "the question asks how often it lands"
        );
        assert!(c.detail.contains('5'), "and the detail names the other 5%");
    }

    #[test]
    fn the_working_hour_is_the_users_own_clock_not_utc() {
        use chrono::{Local, TimeZone, Timelike};
        // 09:00 local, whatever the machine's zone is.
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
        let c = cards.iter().find(|c| c.id == "peak_hour").expect("card");
        assert_eq!(
            c.headline,
            hour_label(local_nine.hour()),
            "reported hour must match the local clock"
        );
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
    fn every_card_answers_a_question_and_carries_a_detail() {
        let v: Vec<_> = (0..30).map(sess).collect();
        for c in build(&v, &vec![0.5; v.len()]) {
            assert!(c.question.ends_with('?'), "{} has no question", c.id);
            assert!(!c.headline.is_empty(), "{} has no headline", c.id);
            assert!(!c.detail.is_empty(), "{} has no detail", c.id);
        }
    }
}

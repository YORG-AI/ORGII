//! Builder profile — a measured description of how someone works with coding
//! agents, derived from the sessions already on their machine.
//!
//! Four axes, each a letter: Map/Explore, Direct/Delegate, Focused/Swarm,
//! Systemize/Ship. A letter is printed only when it passes both gates in
//! [`axes`]; otherwise the slot is `?`, which means *not measurable from your
//! data* rather than *middling*.
//!
//! Shape of the pipeline, mirroring [`crate::session_usage`]:
//!
//! ```text
//! ActivityChunk stream  ->  SessionSignals  ->  orgtrack_core_session_signals
//!                                                        |
//!                                    cross-session concurrency pass
//!                                                        |
//!                                            anchored scoring + gates
//!                                                        |
//!                                                 BuilderProfile
//! ```
//!
//! Signals are a derived projection: one immutable row per session, keyed by
//! `signals_version`, safe to drop and rebuild. Rows are computed lazily —
//! extracted on demand and cached, then topped up by a bounded background pass —
//! because a full sweep of every transcript is far too expensive to do eagerly.
//! Aggregation is a SQL pass over signal rows, never a re-read of transcripts.

pub mod axes;
pub mod highlights;
pub mod signals;
#[cfg(feature = "sqlite")]
pub mod store;

use serde::{Deserialize, Serialize};

pub use axes::{AxisInput, AxisScore, MIN_SESSIONS_FOR_TYPE};
pub use highlights::{Highlight, HighlightKind};
pub use signals::{SessionSignals, SIGNALS_VERSION};

/// A profile computed over one set of sessions — everything, one tool, or one
/// time window.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuilderProfile {
    /// Four letters, `?` where a gate failed, e.g. `EAWH` or `EA?H`.
    pub code: String,
    /// Always resolves — the code always has four letters.
    pub archetype: Option<String>,
    /// One line per earned letter.
    pub blurbs: Vec<String>,
    /// 0..1, from score magnitude and session agreement.
    pub confidence: f64,
    pub sessions: usize,
    /// True once there are enough sessions for the code to be worth showing.
    pub has_enough_sessions: bool,
    pub axes: Vec<AxisScore>,
    /// Measured but never letter-bearing; see [`axes::VT`].
    pub secondary: Vec<AxisScore>,
    /// Share of sessions that fan out to subagents. Deliberately not folded into
    /// Focused/Swarm: it is the other level of parallelism and points the other
    /// way, so averaging the two cancels the axis.
    pub subagent_session_share: f64,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
}

/// Score every axis over `inputs` and assemble the code.
pub fn build_profile(inputs: &[AxisInput]) -> BuilderProfile {
    let scored: Vec<AxisScore> = axes::AXES.iter().map(|d| axes::score(inputs, d)).collect();
    let secondary: Vec<AxisScore> = axes::SECONDARY
        .iter()
        .map(|d| axes::score(inputs, d))
        .collect();

    // Always four letters. Clarity carries how much each one is worth.
    let code: String = scored.iter().map(|a| a.letter).collect();
    let confidence = {
        let per: Vec<f64> = scored
            .iter()
            .map(|a| (a.score.abs() / 30.0).clamp(0.1, 1.0) * a.clarity.weight())
            .collect();
        (per.iter().sum::<f64>() / per.len() as f64 * 100.0).round() / 100.0
    };
    let blurbs = scored
        .iter()
        .map(|a| axes::blurb(a.letter).to_string())
        .filter(|b| !b.is_empty())
        .collect();

    let started = inputs
        .iter()
        .map(|i| i.signals.started_at_ms)
        .filter(|t| *t > 0)
        .min()
        .unwrap_or(0);
    let ended = inputs
        .iter()
        .flat_map(|i| i.signals.active_spans.iter().map(|(_, b)| *b))
        .max()
        .unwrap_or(0);
    let fanout = if inputs.is_empty() {
        0.0
    } else {
        inputs
            .iter()
            .filter(|i| i.signals.delegate_calls > 0)
            .count() as f64
            / inputs.len() as f64
    };

    BuilderProfile {
        archetype: axes::archetype(&code).map(str::to_string),
        code,
        blurbs,
        confidence,
        sessions: inputs.len(),
        has_enough_sessions: inputs.len() >= MIN_SESSIONS_FOR_TYPE,
        axes: scored,
        secondary,
        subagent_session_share: (fanout * 1000.0).round() / 1000.0,
        started_at_ms: started,
        ended_at_ms: ended,
    }
}

/// Pair each session's signals with its cross-session concurrency figure, which
/// cannot be derived from a session in isolation.
pub fn to_inputs(sessions: &[SessionSignals]) -> Vec<AxisInput<'_>> {
    let shares = signals::parallel_shares(sessions);
    sessions
        .iter()
        .enumerate()
        .map(|(i, s)| AxisInput {
            signals: s,
            parallel_share: shares.get(i).map(|(_, v)| *v).unwrap_or(0.0),
        })
        .collect()
}

/// Convenience: signals in, profile out.
pub fn profile_for(sessions: &[SessionSignals]) -> BuilderProfile {
    build_profile(&to_inputs(sessions))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn swarming_delegator(i: i64) -> SessionSignals {
        SessionSignals {
            session_id: format!("s{i}"),
            source: "claude_code".into(),
            has_edit: true,
            postedit_turns: 1,
            tools_per_user: 22.0,
            max_chain: 39,
            mean_chain: 23.0,
            interrupt_rate: 0.0,
            user_share: 0.13,
            product_edit_share: 1.0,
            started_at_ms: i * 1_000,
            active_spans: vec![(i * 1_000, i * 1_000 + 600_000)],
            ..Default::default()
        }
    }

    #[test]
    fn overlapping_sessions_read_as_swarm_and_earn_the_letter() {
        let v: Vec<_> = (0..40).map(swarming_delegator).collect();
        let p = profile_for(&v);
        assert!(p.has_enough_sessions);
        assert_eq!(
            &p.code[1..3],
            "AW",
            "delegating and swarming, got {}",
            p.code
        );
        assert!(p.confidence > 0.0);
    }

    #[test]
    fn a_thin_corpus_is_flagged_rather_than_typed() {
        let v: Vec<_> = (0..6).map(swarming_delegator).collect();
        let p = profile_for(&v);
        assert!(
            !p.has_enough_sessions,
            "6 sessions must not present as a type"
        );
    }

    #[test]
    fn every_corpus_produces_four_letters_and_an_archetype() {
        // Sessions that never changed anything: the edit-gated axes have
        // nothing to work with, but the code must still read as a type.
        let v: Vec<SessionSignals> = (0..40)
            .map(|i| SessionSignals {
                session_id: format!("s{i}"),
                has_edit: false,
                ..Default::default()
            })
            .collect();
        let p = profile_for(&v);
        assert_eq!(p.code.chars().count(), 4);
        assert!(
            !p.code.contains('?'),
            "never refuse a letter, got {}",
            p.code
        );
        assert!(
            p.archetype.is_some(),
            "four letters always name an archetype"
        );
        assert!(
            p.axes.iter().any(|a| a.caveat.is_some()),
            "axes with nothing to measure must say so"
        );
    }

    #[test]
    fn a_split_corpus_still_answers_but_says_the_answer_is_soft() {
        // Alternating extremes: a genuine coin flip on Direct vs Delegate.
        let v: Vec<SessionSignals> = (0..40)
            .map(|i| {
                let hi = i % 2 == 0;
                SessionSignals {
                    session_id: format!("s{i}"),
                    has_edit: true,
                    postedit_turns: 1,
                    tools_per_user: if hi { 60.0 } else { 0.5 },
                    max_chain: if hi { 120 } else { 1 },
                    mean_chain: if hi { 60.0 } else { 1.0 },
                    interrupt_rate: if hi { 0.0 } else { 1.2 },
                    user_share: if hi { 0.05 } else { 0.9 },
                    ..Default::default()
                }
            })
            .collect();
        let p = profile_for(&v);
        let da = p.axes.iter().find(|a| a.key == "DA").expect("DA axis");
        assert!(
            da.letter == 'A' || da.letter == 'D',
            "it still picks a side"
        );
        assert!(
            matches!(da.clarity, axes::Clarity::Slight | axes::Clarity::Moderate),
            "a split corpus must not read as clear, got {:?}",
            da.clarity
        );
        assert!(da.caveat.is_some(), "and it must say why");
    }
}

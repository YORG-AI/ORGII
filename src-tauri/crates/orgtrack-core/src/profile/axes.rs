//! Anchored scoring and the two gates that decide whether a letter is printed.
//!
//! **Why anchors and not percentiles.** Ranking a person's sessions against
//! their own history cannot produce a type: the mean of a percentile is 0.5 by
//! construction, so "average over my sessions" always lands dead centre. A type
//! needs an external reference. Until a multi-person baseline exists, each
//! signal carries a declared neutral value. These anchors are the model's
//! assumptions made explicit and are the one thing to recalibrate once real
//! between-person data arrives — [`AxisScore::flip_factor`] reports how much
//! each verdict depends on them.
//!
//! **Every axis always yields a letter.** Withholding one produces `?A?H`,
//! which is not a type — it is a refusal, and it makes the result useless to
//! read. MBTI reports a letter even at 51/49; what it adds is *preference
//! clarity*, and that is the right shape here too.
//!
//! So the two quality checks below no longer gate the letter, they grade it:
//!
//! - `consistency >= MIN_CONSISTENCY` — most sessions fall on that side.
//! - `flip_factor >= MIN_FLIP` (or `<= 1/MIN_FLIP`) — the anchors must move by
//!   at least that multiple before the letter changes.
//!
//! The first catches "your sessions disagree"; the second catches "this leaning
//! is an artefact of where the anchor was placed". Passing both with a wide
//! margin is [`Clarity::VeryClear`]; failing both is [`Clarity::Slight`] — the
//! letter still stands, with the reason attached in `caveat`.

use serde::{Deserialize, Serialize};

use super::signals::SessionSignals;

/// Log-units to saturation: a session ~3x the anchor reaches |0.75|, so an
/// extreme session informs the mean without dominating it.
const SPREAD: f64 = 1.1;
/// Below this share of agreeing sessions the axis is near chance.
pub const MIN_CONSISTENCY: f64 = 0.65;
/// Anchors must move at least this multiple to flip the letter.
pub const MIN_FLIP: f64 = 1.5;
/// Fewer sessions than this and an axis reports nothing at all.
pub const MIN_SESSIONS: usize = 5;
/// Below this the four-letter code is not shown; see `reliability` analysis —
/// letter agreement with the full corpus reaches ~98% here.
pub const MIN_SESSIONS_FOR_TYPE: usize = 25;

#[derive(Debug, Clone, Copy)]
pub struct SignalRef {
    pub name: &'static str,
    /// +1 pushes toward the positive pole, -1 toward the negative.
    pub sign: f64,
    pub anchor: f64,
    pub label: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct AxisDef {
    pub key: &'static str,
    pub pos: char,
    pub neg: char,
    pub pos_name: &'static str,
    pub neg_name: &'static str,
    pub question: &'static str,
    pub signals: &'static [SignalRef],
    /// The construct is undefined in a session that changed nothing.
    pub needs_edit: bool,
    /// The construct is undefined without a human turn after a change.
    pub needs_postedit: bool,
}

macro_rules! sig {
    ($n:expr, $s:expr, $a:expr, $l:expr) => {
        SignalRef {
            name: $n,
            sign: $s,
            anchor: $a,
            label: $l,
        }
    };
}

/// Map vs Explore — human-side only. Earlier versions used prompt length
/// (measured verbosity) and then agent tool-mix (measured the harness); both
/// collapsed. What survives is how the person frames the work.
pub const ME: AxisDef = AxisDef {
    key: "ME",
    pos: 'M',
    neg: 'E',
    pos_name: "Map",
    neg_name: "Explore",
    question: "Do you reduce ambiguity before acting, or by acting?",
    signals: &[
        sig!(
            "brief_items",
            1.0,
            2.0,
            "enumerated steps in your opening brief"
        ),
        sig!(
            "brief_constraints",
            1.0,
            3.0,
            "constraints you state up front"
        ),
        sig!(
            "brief_targets",
            1.0,
            2.0,
            "files or symbols you name up front"
        ),
        sig!("question_rate", -1.0, 0.30, "questions you ask per message"),
        sig!(
            "redirect_rate",
            -1.0,
            0.15,
            "mid-flight redirects you issue"
        ),
    ],
    needs_edit: false,
    needs_postedit: false,
};

/// Direct vs Delegate — measured strictly *inside* a run, so it cannot collapse
/// into Verify/Trust, which is measured strictly *after* a change.
pub const DA: AxisDef = AxisDef {
    key: "DA",
    pos: 'A',
    neg: 'D',
    pos_name: "Delegate",
    neg_name: "Direct",
    question: "Do you manage the process, or the boundary?",
    signals: &[
        sig!("tools_per_user", 1.0, 8.0, "tool calls per instruction"),
        sig!("max_chain", 1.0, 25.0, "longest uninterrupted run"),
        sig!("mean_chain", 1.0, 8.0, "mean uninterrupted run"),
        sig!("interrupt_rate", -1.0, 0.05, "how often you interrupt"),
        sig!("user_share", -1.0, 0.30, "share of turns that are yours"),
    ],
    needs_edit: false,
    needs_postedit: false,
};

/// Focused vs Swarm. Letter is F/W because S belongs to Systemize.
///
/// Only inter-session parallelism defines the letter. Subagent fan-out is the
/// other level of the same idea but points the opposite way for real users
/// (rare per session), and averaging the two cancels the axis into the fragile
/// band — so fan-out is reported as a separate fact, not folded in.
pub const FW: AxisDef = AxisDef {
    key: "FW",
    pos: 'W',
    neg: 'F',
    pos_name: "Swarm",
    neg_name: "Focused",
    question: "Do you run one agent, or many at once?",
    signals: &[sig!(
        "parallel_share",
        1.0,
        0.50,
        "share of your working time with another agent live"
    )],
    needs_edit: false,
    needs_postedit: false,
};

/// Systemize vs Ship — classified over *edited* paths only. Counting files that
/// were merely read would measure what the agent looked at, not what the person
/// chose to build.
pub const SH: AxisDef = AxisDef {
    key: "SH",
    pos: 'S',
    neg: 'H',
    pos_name: "Systemize",
    neg_name: "Ship",
    question: "Are you building the machine, or using it to deliver?",
    signals: &[
        sig!(
            "harness_edit_share",
            1.0,
            0.05,
            "agent instructions: CLAUDE.md, rules, skills"
        ),
        sig!("infra_edit_share", 1.0, 0.12, "build, CI and config"),
        sig!("doc_edit_share", 1.0, 0.10, "documentation"),
        sig!("product_edit_share", -1.0, 0.65, "product code"),
    ],
    needs_edit: true,
    needs_postedit: false,
};

/// Verify vs Trust — measured but *not* letter-bearing. Reading a diff leaves no
/// trace in a transcript, so roughly 70% of post-change behaviour is
/// unobservable. Reported as a low-confidence secondary trait.
pub const VT: AxisDef = AxisDef {
    key: "VT",
    pos: 'V',
    neg: 'T',
    pos_name: "Verify",
    neg_name: "Trust",
    question: "Do you require evidence continuously, or inspect by exception?",
    signals: &[
        sig!(
            "postedit_evidence_rate",
            1.0,
            0.30,
            "you report what you observed"
        ),
        sig!(
            "postedit_paste_rate",
            1.0,
            0.20,
            "you paste output or errors back"
        ),
        sig!(
            "postedit_moveon_rate",
            -1.0,
            0.35,
            "you move on without comment"
        ),
    ],
    needs_edit: true,
    needs_postedit: true,
};

/// The four letter-bearing axes, in code order.
pub const AXES: [AxisDef; 4] = [ME, DA, FW, SH];
/// Measured, shown, but never part of the code.
pub const SECONDARY: [AxisDef; 1] = [VT];

/// One session's inputs: its own signals plus the cross-session concurrency
/// figure, which cannot be derived from the session alone.
#[derive(Debug, Clone, Copy)]
pub struct AxisInput<'a> {
    pub signals: &'a SessionSignals,
    pub parallel_share: f64,
}

impl AxisInput<'_> {
    fn value(&self, name: &str) -> Option<f64> {
        let s = self.signals;
        Some(match name {
            "brief_items" => s.brief_items as f64,
            "brief_constraints" => s.brief_constraints as f64,
            "brief_targets" => s.brief_targets as f64,
            "question_rate" => s.question_rate,
            "redirect_rate" => s.redirect_rate,
            "tools_per_user" => s.tools_per_user,
            "max_chain" => s.max_chain as f64,
            "mean_chain" => s.mean_chain,
            "interrupt_rate" => s.interrupt_rate,
            "user_share" => s.user_share,
            "parallel_share" => self.parallel_share,
            "harness_edit_share" => s.harness_edit_share,
            "infra_edit_share" => s.infra_edit_share,
            "doc_edit_share" => s.doc_edit_share,
            "product_edit_share" => s.product_edit_share,
            "postedit_evidence_rate" => s.postedit_evidence_rate,
            "postedit_paste_rate" => s.postedit_paste_rate,
            "postedit_moveon_rate" => s.postedit_moveon_rate,
            _ => return None,
        })
    }

    fn eligible_for(&self, def: &AxisDef) -> bool {
        (!def.needs_edit || self.signals.has_edit)
            && (!def.needs_postedit || self.signals.postedit_turns >= 1)
    }
}

/// One signal's contribution, kept so every score can be traced to its evidence.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub label: String,
    pub signal: String,
    /// Mean of this signal's per-session contribution, -1..+1.
    pub contribution: f64,
    pub median: f64,
    pub anchor: f64,
    pub toward_positive: bool,
}

/// How firmly a letter is held. Borrowed from MBTI's preference-clarity index:
/// the letter is never withheld, but how much weight it deserves is stated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Clarity {
    /// Near a coin flip. Real, but do not build anything on it.
    Slight,
    /// One of the two checks passed.
    Moderate,
    /// Both checks passed.
    Clear,
    /// Both checks passed, and by a wide margin.
    VeryClear,
}

impl Clarity {
    /// Rough 0..1 weight, for rolling several axes into one confidence figure.
    pub fn weight(self) -> f64 {
        match self {
            Clarity::Slight => 0.25,
            Clarity::Moderate => 0.55,
            Clarity::Clear => 0.85,
            Clarity::VeryClear => 1.0,
        }
    }
}

/// A score this far from neutral, with both checks passed, reads as emphatic.
const EMPHATIC_SCORE: f64 = 20.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AxisScore {
    pub key: String,
    pub question: String,
    pub positive_name: String,
    pub negative_name: String,
    /// -100..+100. Positive leans to the positive pole.
    pub score: f64,
    /// The letter. Always present — an axis always picks a side.
    pub letter: char,
    /// How firmly that letter is held.
    pub clarity: Clarity,
    pub sessions: usize,
    /// Share of sessions agreeing in sign with the mean.
    pub consistency: f64,
    /// 1 - spread of per-session scores: how much this moves session to session.
    pub stability: f64,
    /// Multiple the anchors must move to flip the letter; `None` = never flips.
    pub flip_factor: Option<f64>,
    /// Why the letter is not firmly held, when it isn't. Shown beside it
    /// rather than in place of it.
    pub caveat: Option<String>,
    pub evidence: Vec<Evidence>,
}

fn signal_scores(inputs: &[AxisInput], def: &AxisDef, factor: f64) -> Vec<Vec<f64>> {
    def.signals
        .iter()
        .map(|sr| {
            let anchor = (sr.anchor * factor).max(f64::MIN_POSITIVE);
            let base = anchor.ln_1p();
            inputs
                .iter()
                .map(|i| {
                    let v = i.value(sr.name).unwrap_or(0.0).max(0.0);
                    ((v.ln_1p() - base) / SPREAD).tanh() * sr.sign
                })
                .collect()
        })
        .collect()
}

fn per_session(inputs: &[AxisInput], def: &AxisDef, factor: f64) -> Vec<f64> {
    let per_signal = signal_scores(inputs, def, factor);
    (0..inputs.len())
        .map(|i| per_signal.iter().map(|s| s[i]).sum::<f64>() / per_signal.len() as f64)
        .collect()
}

fn median(mut v: Vec<f64>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

/// How far the anchors must move, multiplicatively, before the letter flips.
/// A large factor means the verdict is not an artefact of anchor placement.
///
/// Coarse bracket, then bisect. A uniform scale on the anchors is *not*
/// monotone for a mixed-sign axis — raising an anchor lowers a `+1` signal's
/// contribution but raises a `-1` one — so the bracket has to be found by
/// scanning before bisection is valid. 24 + 24 evaluations replaces a flat
/// 200-step scan at the same reported precision, and this runs once per axis
/// per profile, of which a panel load computes a dozen or more.
fn flip_factor(inputs: &[AxisInput], def: &AxisDef) -> Option<f64> {
    let mean_at = |f: f64| {
        let s = per_session(inputs, def, f);
        s.iter().sum::<f64>() / s.len() as f64
    };
    let base_positive = mean_at(1.0) >= 0.0;

    const COARSE: usize = 24;
    const LO: f64 = -4.0; // ~1/55x
    const HI: f64 = 4.0; //  ~55x
    let at = |i: usize| (LO + (HI - LO) * i as f64 / (COARSE - 1) as f64).exp();

    // Nearest bracket on each side of 1.0, so the smallest flip wins.
    let mut best: Option<(f64, f64)> = None;
    let mut prev = (at(0), mean_at(at(0)) >= 0.0);
    for i in 1..COARSE {
        let f = at(i);
        let positive = mean_at(f) >= 0.0;
        if positive != prev.1 {
            let crossing = (prev.0, f);
            let dist = crossing.1.ln().abs().min(crossing.0.ln().abs());
            if best.is_none_or(|(a, b): (f64, f64)| dist < b.ln().abs().min(a.ln().abs())) {
                best = Some(crossing);
            }
        }
        prev = (f, positive);
    }
    let (mut lo, mut hi) = best?;
    for _ in 0..24 {
        let mid = ((lo.ln() + hi.ln()) / 2.0).exp();
        if (mean_at(mid) >= 0.0) == base_positive {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Some(((lo.ln() + hi.ln()) / 2.0).exp())
}

/// One session's own position on an axis, ungated — for picking the sessions at
/// each extreme so a verdict can be checked against something the user
/// remembers. Returns `None` when the construct is undefined for that session.
pub fn session_score(input: &AxisInput, def: &AxisDef) -> Option<f64> {
    if !input.eligible_for(def) {
        return None;
    }
    let per = per_session(std::slice::from_ref(input), def, 1.0);
    per.first().map(|v| (v * 1000.0).round() / 10.0)
}

/// Score one axis over a set of sessions.
pub fn score(all: &[AxisInput], def: &AxisDef) -> AxisScore {
    let inputs: Vec<AxisInput> = all
        .iter()
        .filter(|i| i.eligible_for(def))
        .copied()
        .collect();
    let base = AxisScore {
        key: def.key.to_string(),
        question: def.question.to_string(),
        positive_name: def.pos_name.to_string(),
        negative_name: def.neg_name.to_string(),
        score: 0.0,
        letter: def.neg,
        clarity: Clarity::Slight,
        sessions: inputs.len(),
        consistency: 0.0,
        stability: 0.0,
        flip_factor: None,
        caveat: Some("too few sessions to tell".to_string()),
        evidence: Vec::new(),
    };
    if inputs.len() < MIN_SESSIONS {
        return base;
    }

    let per = per_session(&inputs, def, 1.0);
    let n = per.len() as f64;
    let mean = per.iter().sum::<f64>() / n;
    let sd = (per.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n).sqrt();
    let consistency = per.iter().filter(|x| (**x >= 0.0) == (mean >= 0.0)).count() as f64 / n;

    let per_signal = signal_scores(&inputs, def, 1.0);
    let mut evidence: Vec<Evidence> = def
        .signals
        .iter()
        .zip(per_signal.iter())
        .map(|(sr, scores)| Evidence {
            label: sr.label.to_string(),
            signal: sr.name.to_string(),
            contribution: scores.iter().sum::<f64>() / n,
            median: median(
                inputs
                    .iter()
                    .map(|i| i.value(sr.name).unwrap_or(0.0))
                    .collect(),
            ),
            anchor: sr.anchor,
            toward_positive: sr.sign > 0.0,
        })
        .collect();
    evidence.sort_by(|a, b| {
        b.contribution
            .abs()
            .partial_cmp(&a.contribution.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let flip = flip_factor(&inputs, def);
    let sessions_agree = consistency >= MIN_CONSISTENCY;
    let anchor_holds = !flip.is_some_and(|f| f > 1.0 / MIN_FLIP && f < MIN_FLIP);
    let score = (mean * 1000.0).round() / 10.0;

    // The letter is whichever side the sessions actually fall on. It is never
    // withheld — an axis that refuses to answer is worse than a weak answer.
    let letter = if mean >= 0.0 { def.pos } else { def.neg };
    let clarity = match (sessions_agree, anchor_holds) {
        (true, true) if score.abs() >= EMPHATIC_SCORE => Clarity::VeryClear,
        (true, true) => Clarity::Clear,
        (false, false) => Clarity::Slight,
        _ => Clarity::Moderate,
    };
    // Say what is soft about it, next to the letter rather than instead of it.
    let caveat = match (sessions_agree, anchor_holds) {
        (true, true) => None,
        (false, false) => Some("your sessions are split, and it sits near neutral".to_string()),
        (false, true) => Some("your sessions are split on this".to_string()),
        (true, false) => Some("it sits close to neutral".to_string()),
    };

    AxisScore {
        score,
        letter,
        clarity,
        consistency: (consistency * 100.0).round() / 100.0,
        stability: ((1.0 - sd * 2.2).max(0.0) * 100.0).round() / 100.0,
        flip_factor: flip,
        caveat,
        evidence,
        ..base
    }
}

/// M/E x D/A x F/W x S/H.
pub fn archetype(code: &str) -> Option<&'static str> {
    Some(match code {
        "MDFS" => "Systems Architect",
        "MDFH" => "Mission Commander",
        "MDWS" => "Fleet Architect",
        "MDWH" => "Campaign Commander",
        "MAFS" => "Platform Builder",
        "MAFH" => "Studio Producer",
        "MAWS" => "Orchestration Architect",
        "MAWH" => "Portfolio Operator",
        "EDFS" => "Investigative Engineer",
        "EDFH" => "Debugging Detective",
        "EDWS" => "Parallel Prospector",
        "EDWH" => "Multi-Track Hacker",
        "EAFS" => "Emergent Architect",
        "EAFH" => "Improvising Shipper",
        "EAWS" => "Research Conductor",
        "EAWH" => "Swarm Founder",
        _ => return None,
    })
}

pub fn blurb(letter: char) -> &'static str {
    match letter {
        'M' => "You pin the target down before you move.",
        'E' => "You find the real problem by making motion.",
        'D' => "You shape the path step by step.",
        'A' => "You set the boundary and let the agent find the path.",
        'F' => "You give one agent your whole attention.",
        'W' => "You keep several agents moving and steer between them.",
        'S' => "You build the machine that builds.",
        'H' => "You optimise for the thing shipping.",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sess(f: impl Fn(&mut SessionSignals)) -> SessionSignals {
        let mut s = SessionSignals {
            has_edit: true,
            postedit_turns: 1,
            ..Default::default()
        };
        f(&mut s);
        s
    }

    fn inputs<'a>(v: &'a [SessionSignals], p: f64) -> Vec<AxisInput<'a>> {
        v.iter()
            .map(|s| AxisInput {
                signals: s,
                parallel_share: p,
            })
            .collect()
    }

    #[test]
    fn a_clear_delegator_earns_the_letter() {
        let v: Vec<_> = (0..40)
            .map(|i| {
                sess(|s| {
                    s.tools_per_user = 20.0 + i as f64 * 0.1;
                    s.max_chain = 40;
                    s.mean_chain = 22.0;
                    s.interrupt_rate = 0.0;
                    s.user_share = 0.12;
                })
            })
            .collect();
        let out = score(&inputs(&v, 0.0), &DA);
        assert_eq!(out.letter, 'A');
        assert_eq!(out.clarity, Clarity::VeryClear);
        assert!(out.caveat.is_none(), "a clear letter carries no caveat");
        assert!(out.score > 15.0, "score was {}", out.score);
    }

    #[test]
    fn split_sessions_still_yield_a_letter_but_a_soft_one() {
        let v: Vec<_> = (0..40)
            .map(|i| {
                sess(|s| {
                    let hi = i % 2 == 0;
                    s.tools_per_user = if hi { 40.0 } else { 1.0 };
                    s.max_chain = if hi { 90 } else { 2 };
                    s.mean_chain = if hi { 40.0 } else { 1.0 };
                    s.interrupt_rate = if hi { 0.0 } else { 0.9 };
                    s.user_share = if hi { 0.1 } else { 0.8 };
                })
            })
            .collect();
        let out = score(&inputs(&v, 0.0), &DA);
        assert!(
            out.letter == 'A' || out.letter == 'D',
            "an axis always picks a side"
        );
        assert_ne!(out.clarity, Clarity::Clear);
        assert_ne!(out.clarity, Clarity::VeryClear);
        assert!(out.caveat.is_some(), "a soft letter must say why");
    }

    #[test]
    fn a_verdict_that_hinges_on_the_anchor_is_flagged_not_hidden() {
        // Everything sits exactly on the anchors: consistent, but meaningless.
        let v: Vec<_> = (0..40)
            .map(|i| {
                sess(|s| {
                    let jitter = 1.0 + (i % 3) as f64 * 0.01;
                    s.tools_per_user = 8.0 * jitter;
                    s.max_chain = 25;
                    s.mean_chain = 8.0 * jitter;
                    s.interrupt_rate = 0.05 * jitter;
                    s.user_share = 0.30 * jitter;
                })
            })
            .collect();
        let out = score(&inputs(&v, 0.0), &DA);
        assert!(out.letter == 'A' || out.letter == 'D');
        assert!(
            matches!(out.clarity, Clarity::Slight | Clarity::Moderate),
            "sitting on the anchor cannot read as clear, got {:?}",
            out.clarity
        );
        assert!(out.caveat.unwrap().contains("neutral"));
    }

    #[test]
    fn edit_constructs_skip_sessions_that_changed_nothing() {
        let mut v: Vec<SessionSignals> = (0..30)
            .map(|_| sess(|s| s.product_edit_share = 1.0))
            .collect();
        v.extend((0..70).map(|_| SessionSignals {
            has_edit: false,
            ..Default::default()
        }));
        let out = score(&inputs(&v, 0.0), &SH);
        assert_eq!(out.sessions, 30, "the 70 no-edit sessions are not scored");
    }

    #[test]
    fn archetype_covers_every_combination() {
        for m in ['M', 'E'] {
            for d in ['D', 'A'] {
                for f in ['F', 'W'] {
                    for s in ['S', 'H'] {
                        let code: String = [m, d, f, s].iter().collect();
                        assert!(archetype(&code).is_some(), "missing {code}");
                    }
                }
            }
        }
    }
}

//! Per-session behavioural signals, extracted from the normalized
//! [`ActivityChunk`] stream.
//!
//! Two rules govern which signals exist here, both learned the hard way from a
//! prototype that got them wrong first:
//!
//! 1. **Human-side only, for anything that defines a type letter.** Signals
//!    describing what the *agent* did (share of tool calls that are reads,
//!    whether it ran tests) track the harness, not the person: Cursor's agent
//!    searches far more than Claude Code's, so an axis built on them flips sign
//!    when the corpus changes tools. Signals describing what the *human* did
//!    (how they brief, how often they interject, how many sessions they run at
//!    once, which files they choose to change) are stable across harnesses.
//!
//! 2. **Measure a construct only where it is defined.** "Did you investigate
//!    before acting" and "did you verify the change" are meaningless in a
//!    session that never changed anything — and roughly half of all sessions
//!    never do. Those sessions carry `has_edit = 0` and are excluded by the
//!    scorer rather than silently scored as zero.
//!
//! Ordering note: chunk array order is authoritative. `created_at` must not be
//! used for sequencing — Cursor's timestamps are synthetic (ties are rewritten
//! +1ms) and Codex emits a tool chunk when its output arrives, not when the
//! call was issued.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use chrono::{DateTime, Utc};
use core_types::activity::ActivityChunk;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sources::imported_history::{
    ACTION_TYPE_ASSISTANT, ACTION_TYPE_RAW, ACTION_TYPE_TASK_FAILED, ACTION_TYPE_TOOL_CALL,
    FUNCTION_USER_MESSAGE,
};

/// Bump when an extractor change alters any emitted value. Rows with an older
/// version are recomputed by the backfill rather than trusted.
pub const SIGNALS_VERSION: i64 = 3;

/// Idle span that ends a stretch of genuine activity. A session left open
/// overnight would otherwise "overlap" every other session and fake a swarm.
const IDLE_GAP_SECS: f64 = 300.0;
/// A lone event still occupies a little wall clock.
const MIN_SEGMENT_SECS: f64 = 20.0;
/// Opening-brief text beyond this is boilerplate for our purposes.
const BRIEF_SCAN_CHARS: usize = 4000;
/// A post-edit reply shorter than this, with no observation in it, reads as
/// "carry on" rather than "here is what I saw".
const SHORT_REPLY_CHARS: usize = 25;

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static regex"))
}

/// A human does not open a message with an XML-ish tag. Enumerating every
/// harness's injection markers is whack-a-mole (`<recommended_plugins>`,
/// `<environment_context>`, `# AGENTS.md instructions ...`); this is structural.
fn injection_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)^\s*(<[a-z][a-z0-9_]{2,40}>|#\s*(AGENTS|CLAUDE)\.md\b|You are (Codex|Claude|an? \w+ agent)\b)",
    )
}

fn list_item_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?m)^\s*(?:\d+[.)]|[-*•])\s+")
}

fn constraint_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)\b(must|should|shouldn't|don't|do not|never|always|only|instead|required?|acceptance|constraint|ensure|make sure|avoid|without|keep|preserve)\b|不要|必须|需要|确保|保持|不能",
    )
}

fn target_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"`[^`\n]{2,80}`|\b[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|rb|md|json|toml|ya?ml|sql|sh|css|scss)\b",
    )
}

fn redirect_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)\b(actually|instead|no,|nope|wait|revert|undo|never ?mind|nvm|scrap that|hold on|not what i|rollback)\b|其实|算了|等等|不对|回滚|撤销",
    )
}

/// The human reports something they observed — evidence that they looked.
fn evidence_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)\b(still|doesn'?t work|not work|broken|fails?|failed|failing|error|traceback|exception|crash|regression|wrong|incorrect|returns?|shows?|i ran|i tested|i checked|output|stack ?trace|undefined|404|500)\b|还是|不对|报错|失败|没生效|崩|不行|无效",
    )
}

/// A bare acknowledgement — they took the change on trust.
fn ack_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)^\s*(ok(ay)?|good|great|nice|perfect|thanks?|thx|ty|next|continue|go ahead|proceed|yes|yep|sure|cool|done|lgtm|ship it|好的?|可以|继续|行|嗯)\b[\s.!,~]*$",
    )
}

fn interrupt_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)\[request interrupted|interrupted by user")
}

fn harness_path_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)(CLAUDE\.md|AGENTS\.md|\.cursor/rules|\.claude/|\.orgii/|skills?/.*SKILL\.md|mcp[._-]?config|\.mcp\.json|settings\.jsonc?|\.cursorrules|copilot-instructions)",
    )
}

fn infra_path_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)(^|/)(Makefile|Dockerfile|docker-compose|\.github/|\.gitlab-ci|Jenkinsfile|scripts?/|ci/|\.circleci/|webpack\.config|vite\.config|tsconfig|pyproject\.toml|Cargo\.toml|package\.json|\.eslintrc|tailwind\.config|justfile)",
    )
}

fn test_path_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)(^|/)(tests?|__tests__|spec)/|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|test_.*\.py$",
    )
}

fn doc_path_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)\.(md|mdx|rst|txt)$")
}

/// What kind of thing a path is, for Systemize vs Ship.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathKind {
    /// The agent's own instructions — CLAUDE.md, cursor rules, MCP config.
    Harness,
    Test,
    Infra,
    Doc,
    Product,
}

pub fn classify_path(path: &str) -> PathKind {
    if harness_path_re().is_match(path) {
        PathKind::Harness
    } else if test_path_re().is_match(path) {
        PathKind::Test
    } else if infra_path_re().is_match(path) {
        PathKind::Infra
    } else if doc_path_re().is_match(path) {
        PathKind::Doc
    } else {
        PathKind::Product
    }
}

/// Coarse tool taxonomy shared across harnesses.
///
/// Both canonical names (`read_file`, `edit_file_by_replace`) and raw
/// pass-through names are matched: `orgtrack-core`'s Claude Code reader
/// normalizes only `Bash` and the edit family, leaving `Read`/`Grep`/`Glob`
/// under their original names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    Read,
    Search,
    Edit,
    Shell,
    Delegate,
    Todo,
    Web,
    Other,
}

pub fn classify_tool(function: &str) -> ToolKind {
    match function {
        "read_file" | "Read" | "NotebookRead" | "view_image" => ToolKind::Read,
        "grep" | "glob_file_search" | "codebase_search" | "Grep" | "Glob" | "LS" | "list_dir" => {
            ToolKind::Search
        }
        "edit_file_by_replace"
        | "delete_file"
        | "Edit"
        | "Write"
        | "MultiEdit"
        | "NotebookEdit" => ToolKind::Edit,
        "run_command_line" | "await_output" | "Bash" | "BashOutput" => ToolKind::Shell,
        "subagent" | "Task" | "Agent" | "spawn_agent" | "wait_agent" => ToolKind::Delegate,
        // Every harness names its planner differently and only Cursor is
        // canonicalised upstream, so the raw names have to be listed too.
        // Verified against real history by `store::taxonomy::report_real_tool_names`.
        "manage_todo"
        | "TodoWrite"
        | "todo_write"
        | "update_plan"
        | "update_current_step"
        | "TaskCreate"
        | "TaskUpdate"
        | "TaskStop" => ToolKind::Todo,
        "web_search" | "WebFetch" | "WebSearch" => ToolKind::Web,
        _ => ToolKind::Other,
    }
}

fn str_field<'a>(args: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| args.get(*k).and_then(Value::as_str))
        .filter(|s| !s.is_empty())
}

fn tool_path(args: &Value) -> Option<&str> {
    str_field(
        args,
        &[
            "file_path",
            "target_file",
            "path",
            "relativeWorkspacePath",
            "effectiveUri",
            "notebook_path",
        ],
    )
}

/// Strip harness injections from a human-channel message; empty means the
/// message was not written by a person.
pub fn clean_user_text(raw: &str) -> &str {
    let t = raw.trim();
    if t.is_empty() || injection_re().is_match(t) {
        return "";
    }
    t
}

/// One session's behavioural signals. Every field is an aggregate — no message
/// text, no file paths — so a row is safe to persist and to export.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSignals {
    pub session_id: String,
    pub source: String,
    pub signals_version: i64,
    pub started_at_ms: i64,
    pub active_secs: f64,
    /// Merged spans of genuine activity, as `[start_ms, end_ms]` pairs. Kept so
    /// cross-session concurrency can be computed without re-reading transcripts.
    pub active_spans: Vec<(i64, i64)>,

    pub user_turns: i64,
    pub assistant_turns: i64,
    pub tool_calls: i64,
    pub edit_calls: i64,
    /// Subagent fan-out. Reported alongside Focused/Swarm, never folded in.
    pub delegate_calls: i64,
    pub has_edit: bool,

    // Map vs Explore — how the human frames the work.
    pub brief_items: i64,
    pub brief_constraints: i64,
    pub brief_targets: i64,
    pub question_rate: f64,
    pub redirect_rate: f64,

    // Direct vs Delegate — how much rope the human gives, mid-run.
    pub tools_per_user: f64,
    pub max_chain: i64,
    pub mean_chain: f64,
    pub interrupt_rate: f64,
    pub user_share: f64,

    // Systemize vs Ship — what the human chooses to change.
    pub harness_edit_share: f64,
    pub infra_edit_share: f64,
    pub doc_edit_share: f64,
    pub test_edit_share: f64,
    pub product_edit_share: f64,

    // Verify vs Trust — secondary; most verification is silent and unobservable.
    pub postedit_turns: i64,
    pub postedit_evidence_rate: f64,
    pub postedit_moveon_rate: f64,
    pub postedit_paste_rate: f64,

    // Colour for the highlight cards. Not scored on any axis.
    /// Words you typed across the session.
    pub prompt_words: i64,
    /// Your longest single message, in words.
    pub longest_prompt_words: i64,
    /// Lines the agent added / removed, where the reader reports a diff.
    pub lines_added: i64,
    pub lines_removed: i64,
    /// A plan or todo list came before the first edit.
    pub planned_first: bool,
    /// Longest single stretch of unbroken activity, in seconds.
    pub longest_span_secs: f64,
}

fn parse_ts_ms(raw: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|d| d.with_timezone(&Utc).timestamp_millis())
        .or_else(|| {
            raw.parse::<i64>()
                .ok()
                .map(|n| if n > 1e11 as i64 { n } else { n * 1000 })
        })
}

/// Merge event timestamps into spans of genuine activity.
fn active_spans(mut stamps: Vec<i64>) -> Vec<(i64, i64)> {
    if stamps.is_empty() {
        return Vec::new();
    }
    stamps.sort_unstable();
    let gap = (IDLE_GAP_SECS * 1000.0) as i64;
    let min_len = (MIN_SEGMENT_SECS * 1000.0) as i64;
    let mut out = Vec::new();
    let (mut start, mut last) = (stamps[0], stamps[0]);
    for t in stamps.into_iter().skip(1) {
        if t - last > gap {
            out.push((start, last.max(start + min_len)));
            start = t;
        }
        last = t;
    }
    out.push((start, last.max(start + min_len)));
    out
}

/// Extract one session's signals from its chunk stream.
pub fn extract(session_id: &str, source: &str, chunks: &[ActivityChunk]) -> SessionSignals {
    let mut s = SessionSignals {
        session_id: session_id.to_string(),
        source: source.to_string(),
        signals_version: SIGNALS_VERSION,
        ..Default::default()
    };

    let mut stamps: Vec<i64> = Vec::new();
    let mut chains: Vec<i64> = Vec::new();
    let mut chain = 0i64;
    let (mut interrupts, mut questions, mut redirects) = (0i64, 0i64, 0i64);
    let (mut postedit_evidence, mut postedit_moveon, mut postedit_paste) = (0i64, 0i64, 0i64);
    let mut pending_postedit = false;
    let mut first_brief_seen = false;
    let (mut lines_added, mut lines_removed) = (0i64, 0i64);
    let mut planned_first = false;
    let mut edited: BTreeSet<String> = BTreeSet::new();
    let mut edit_kinds: Vec<PathKind> = Vec::new();

    for chunk in chunks {
        if let Some(ms) = parse_ts_ms(&chunk.created_at) {
            stamps.push(ms);
        }
        match chunk.action_type.as_str() {
            ACTION_TYPE_TASK_FAILED => interrupts += 1, // Codex reports aborts explicitly
            ACTION_TYPE_ASSISTANT => s.assistant_turns += 1,
            ACTION_TYPE_TOOL_CALL => {
                s.tool_calls += 1;
                chain += 1;
                let kind = classify_tool(&chunk.function);
                if kind == ToolKind::Todo && !s.has_edit {
                    planned_first = true;
                }
                if kind == ToolKind::Delegate {
                    s.delegate_calls += 1;
                }
                if kind == ToolKind::Edit {
                    s.edit_calls += 1;
                    s.has_edit = true;
                    pending_postedit = true;
                    if let Some(p) = tool_path(&chunk.args) {
                        edit_kinds.push(classify_path(p));
                        edited.insert(p.to_string());
                    }
                    // Only some readers attach a diff; absent means unknown, not zero.
                    let num = |k: &str| chunk.result.get(k).and_then(Value::as_i64).unwrap_or(0);
                    lines_added += num("linesAdded");
                    lines_removed += num("linesRemoved");
                }
            }
            ACTION_TYPE_RAW if chunk.function == FUNCTION_USER_MESSAGE => {
                // The readers put the human's text on `result.message.content`
                // (see `imported_history::user_message_chunk`), not on `args`.
                let body = chunk
                    .result
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .or_else(|| chunk.result.get("content"))
                    .or_else(|| chunk.args.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                // The interrupt sentinel arrives as an ordinary user message on
                // Claude Code; it is not a human turn.
                if interrupt_re().is_match(body) {
                    interrupts += 1;
                    continue;
                }
                let text = clean_user_text(body);
                if text.is_empty() {
                    continue;
                }
                if chain > 0 {
                    chains.push(chain);
                    s.max_chain = s.max_chain.max(chain);
                    chain = 0;
                }
                s.user_turns += 1;
                if !first_brief_seen {
                    first_brief_seen = true;
                    let head: String = text.chars().take(BRIEF_SCAN_CHARS).collect();
                    s.brief_items = list_item_re().find_iter(&head).count() as i64;
                    s.brief_constraints = constraint_re().find_iter(&head).count() as i64;
                    s.brief_targets = target_re().find_iter(&head).count() as i64;
                }
                questions += text.matches('?').count() as i64 + text.matches('？').count() as i64;
                if redirect_re().is_match(text) {
                    redirects += 1;
                }
                if pending_postedit {
                    pending_postedit = false;
                    s.postedit_turns += 1;
                    if text.contains("```") || text.matches('\n').count() >= 3 {
                        postedit_paste += 1;
                    }
                    if evidence_re().is_match(text) {
                        postedit_evidence += 1;
                    } else if ack_re().is_match(text) || text.chars().count() < SHORT_REPLY_CHARS {
                        postedit_moveon += 1;
                    }
                }
            }
            _ => {}
        }
    }
    if chain > 0 {
        chains.push(chain);
        s.max_chain = s.max_chain.max(chain);
    }

    let users = s.user_turns.max(1) as f64;
    let turns = (s.user_turns + s.assistant_turns).max(1) as f64;
    let edits = edit_kinds.len().max(1) as f64;
    let postedit = s.postedit_turns.max(1) as f64;

    s.tools_per_user = s.tool_calls as f64 / users;
    s.mean_chain = if chains.is_empty() {
        0.0
    } else {
        chains.iter().sum::<i64>() as f64 / chains.len() as f64
    };
    s.interrupt_rate = interrupts as f64 / users;
    s.user_share = s.user_turns as f64 / turns;
    s.question_rate = questions as f64 / users;
    s.redirect_rate = redirects as f64 / users;

    let share = |k: PathKind| edit_kinds.iter().filter(|x| **x == k).count() as f64 / edits;
    s.harness_edit_share = share(PathKind::Harness);
    s.infra_edit_share = share(PathKind::Infra);
    s.doc_edit_share = share(PathKind::Doc);
    s.test_edit_share = share(PathKind::Test);
    s.product_edit_share = share(PathKind::Product);

    s.postedit_evidence_rate = postedit_evidence as f64 / postedit;
    s.postedit_moveon_rate = postedit_moveon as f64 / postedit;
    s.postedit_paste_rate = postedit_paste as f64 / postedit;

    s.lines_added = lines_added;
    s.lines_removed = lines_removed;
    s.planned_first = planned_first;

    let spans = active_spans(stamps);
    s.longest_span_secs = spans
        .iter()
        .map(|(a, b)| (b - a) as f64 / 1000.0)
        .fold(0.0, f64::max);
    s.started_at_ms = spans.first().map(|(a, _)| *a).unwrap_or(0);
    s.active_secs = spans.iter().map(|(a, b)| (b - a) as f64 / 1000.0).sum();
    s.active_spans = spans;
    s
}

/// Share of each session's active time during which at least one *other*
/// session was also active — the Solo/Swarm signal.
///
/// Bounded [0,1], so its neutral point is a defined 0.5 ("more often than not")
/// rather than a fitted one. Mean-concurrency has no such point: any anchor for
/// it lands near the population median, which forces the agreement gate to ~50%
/// by construction and makes the axis look uninformative whatever the truth is.
pub fn parallel_shares(sessions: &[SessionSignals]) -> Vec<(String, f64)> {
    #[derive(PartialEq)]
    enum Edge {
        Close,
        Open,
    }
    let mut edges: Vec<(i64, Edge, usize)> = Vec::new();
    for (i, s) in sessions.iter().enumerate() {
        for (a, b) in &s.active_spans {
            edges.push((*a, Edge::Open, i));
            edges.push((*b, Edge::Close, i));
        }
    }
    // At a shared boundary, open before close so touching spans count as overlap.
    edges.sort_by(|x, y| {
        x.0.cmp(&y.0)
            .then_with(|| (x.1 == Edge::Close).cmp(&(y.1 == Edge::Close)))
    });

    let mut live: BTreeSet<usize> = BTreeSet::new();
    let mut total = vec![0f64; sessions.len()];
    let mut parallel = vec![0f64; sessions.len()];
    let mut prev: Option<i64> = None;
    for (t, edge, idx) in edges {
        if let Some(p) = prev {
            if t > p && !live.is_empty() {
                let dt = (t - p) as f64;
                let many = live.len() > 1;
                for &i in &live {
                    total[i] += dt;
                    if many {
                        parallel[i] += dt;
                    }
                }
            }
        }
        match edge {
            Edge::Open => {
                live.insert(idx);
            }
            Edge::Close => {
                live.remove(&idx);
            }
        }
        prev = Some(t);
    }
    sessions
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let share = if total[i] > 0.0 {
                parallel[i] / total[i]
            } else {
                0.0
            };
            (s.session_id.clone(), share)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(text: &str, at: &str) -> ActivityChunk {
        ActivityChunk {
            chunk_id: format!("u-{at}"),
            session_id: "s".into(),
            action_type: ACTION_TYPE_RAW.into(),
            function: FUNCTION_USER_MESSAGE.into(),
            args: json!({}),
            result: json!({ "type": "user", "message": { "content": text, "role": "user" } }),
            created_at: at.into(),
            thread_id: None,
            process_id: None,
            broadcast_only: false,
        }
    }

    fn tool(function: &str, args: Value, at: &str) -> ActivityChunk {
        ActivityChunk {
            chunk_id: format!("t-{at}"),
            session_id: "s".into(),
            action_type: ACTION_TYPE_TOOL_CALL.into(),
            function: function.into(),
            args,
            result: json!({}),
            created_at: at.into(),
            thread_id: None,
            process_id: None,
            broadcast_only: false,
        }
    }

    #[test]
    fn harness_injections_are_not_human_turns() {
        assert_eq!(clean_user_text("<recommended_plugins>\nHere is a list"), "");
        assert_eq!(clean_user_text("# AGENTS.md instructions for /repo"), "");
        assert_eq!(clean_user_text("<environment_context>\n<cwd>/x"), "");
        assert_eq!(clean_user_text("  fix the parser  "), "fix the parser");
    }

    #[test]
    fn a_session_that_never_edits_is_marked_undefined_for_edit_constructs() {
        let chunks = vec![
            user("what does this do?", "2026-07-01T10:00:00Z"),
            tool(
                "Read",
                json!({ "file_path": "a.rs" }),
                "2026-07-01T10:00:05Z",
            ),
        ];
        let s = extract("s", "claude_code", &chunks);
        assert!(!s.has_edit);
        assert_eq!(s.edit_calls, 0);
        assert_eq!(s.user_turns, 1);
    }

    #[test]
    fn post_edit_reply_is_classified_and_only_counted_after_an_edit() {
        let chunks = vec![
            user("add a flag", "2026-07-01T10:00:00Z"),
            tool(
                "Edit",
                json!({ "file_path": "src/lib.rs" }),
                "2026-07-01T10:00:10Z",
            ),
            user("still broken, returns 404", "2026-07-01T10:01:00Z"),
            user("now do the docs", "2026-07-01T10:02:00Z"),
        ];
        let s = extract("s", "claude_code", &chunks);
        assert_eq!(
            s.postedit_turns, 1,
            "only the turn right after an edit counts"
        );
        assert_eq!(s.postedit_evidence_rate, 1.0);
        assert_eq!(s.postedit_moveon_rate, 0.0);
        assert!(s.has_edit);
        assert_eq!(s.product_edit_share, 1.0);
    }

    #[test]
    fn interrupt_sentinel_counts_as_an_interrupt_not_a_turn() {
        let chunks = vec![
            user("go", "2026-07-01T10:00:00Z"),
            tool("Bash", json!({ "command": "ls" }), "2026-07-01T10:00:05Z"),
            user("[Request interrupted by user]", "2026-07-01T10:00:06Z"),
        ];
        let s = extract("s", "claude_code", &chunks);
        assert_eq!(s.user_turns, 1);
        assert_eq!(s.interrupt_rate, 1.0);
    }

    #[test]
    fn harness_files_separate_from_product_files() {
        let chunks = vec![
            user("update the rules", "2026-07-01T10:00:00Z"),
            tool(
                "Edit",
                json!({ "file_path": "CLAUDE.md" }),
                "2026-07-01T10:00:10Z",
            ),
            tool(
                "Edit",
                json!({ "file_path": "src/a.rs" }),
                "2026-07-01T10:00:20Z",
            ),
        ];
        let s = extract("s", "claude_code", &chunks);
        assert_eq!(s.harness_edit_share, 0.5);
        assert_eq!(s.product_edit_share, 0.5);
    }

    #[test]
    fn idle_gap_splits_activity_so_a_parked_tab_is_not_active_all_night() {
        let chunks = vec![
            user("a", "2026-07-01T10:00:00Z"),
            tool("Read", json!({}), "2026-07-01T10:00:30Z"),
            user("b", "2026-07-01T18:00:00Z"),
        ];
        let s = extract("s", "claude_code", &chunks);
        assert_eq!(s.active_spans.len(), 2, "8h gap must break the span");
        assert!(
            s.active_secs < 120.0,
            "active time excludes the idle stretch"
        );
    }

    #[test]
    fn parallel_share_sees_overlap_not_span() {
        let mk = |id: &str, spans: Vec<(i64, i64)>| SessionSignals {
            session_id: id.into(),
            active_spans: spans,
            ..Default::default()
        };
        let out = parallel_shares(&[
            mk("a", vec![(0, 1000)]),
            mk("b", vec![(500, 1500)]),
            mk("c", vec![(9000, 9500)]),
        ]);
        let get = |id: &str| out.iter().find(|(s, _)| s == id).unwrap().1;
        assert!((get("a") - 0.5).abs() < 1e-6, "half of a overlaps b");
        assert!((get("b") - 0.5).abs() < 1e-6);
        assert_eq!(get("c"), 0.0, "c runs alone");
    }
}

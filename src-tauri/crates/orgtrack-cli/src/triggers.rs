//! Usage/behavior **triggers**: declarative threshold rules that fire when a
//! metric crosses a limit, evaluated by `orgtrack check`. No code runs — a
//! trigger is pure config (`~/.orgtrack/triggers.toml` or `--triggers`), so
//! this is safe by construction. The optional exec-**hook** action side (phase
//! 2) inherits the plugin trust model.
//!
//! See `docs/orgtrack-triggers-design.md`.

use std::collections::BTreeMap;

use orgtrack_core::sources::imported_history::epoch_ms_to_iso;
use orgtrack_core::usage_dashboard::UsageSessionRow;
use serde::Deserialize;

/// A metric aggregated over a scope's sessions.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Metric {
    CostUsd,
    Tokens,
    InputTokens,
    OutputTokens,
    CacheReadTokens,
    CacheWriteTokens,
    SessionCount,
    CacheHitRate,
}

impl Metric {
    fn parse(value: &str) -> Result<Self, String> {
        Ok(match value {
            "cost_usd" => Metric::CostUsd,
            "tokens" | "total_tokens" => Metric::Tokens,
            "input_tokens" => Metric::InputTokens,
            "output_tokens" => Metric::OutputTokens,
            "cache_read_tokens" => Metric::CacheReadTokens,
            "cache_write_tokens" => Metric::CacheWriteTokens,
            "session_count" => Metric::SessionCount,
            "cache_hit_rate" => Metric::CacheHitRate,
            other => return Err(format!("unknown metric '{other}'")),
        })
    }
}

/// The grouping a trigger's metric is evaluated over.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scope {
    Total,
    Day,
    Source,
    Project,
    Session,
}

impl Scope {
    fn parse(value: &str) -> Result<Self, String> {
        Ok(match value {
            "total" => Scope::Total,
            "day" => Scope::Day,
            "source" => Scope::Source,
            "project" => Scope::Project,
            "session" => Scope::Session,
            other => return Err(format!("unknown scope '{other}'")),
        })
    }

    fn label(self) -> &'static str {
        match self {
            Scope::Total => "total",
            Scope::Day => "day",
            Scope::Source => "source",
            Scope::Project => "project",
            Scope::Session => "session",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Op {
    Gt,
    Ge,
    Lt,
    Le,
}

impl Op {
    fn parse(value: &str) -> Result<Self, String> {
        Ok(match value {
            ">" => Op::Gt,
            ">=" => Op::Ge,
            "<" => Op::Lt,
            "<=" => Op::Le,
            other => return Err(format!("unknown op '{other}' (>, >=, <, <=)")),
        })
    }

    fn test(self, actual: f64, limit: f64) -> bool {
        match self {
            Op::Gt => actual > limit,
            Op::Ge => actual >= limit,
            Op::Lt => actual < limit,
            Op::Le => actual <= limit,
        }
    }

    pub(crate) fn symbol(self) -> &'static str {
        match self {
            Op::Gt => ">",
            Op::Ge => ">=",
            Op::Lt => "<",
            Op::Le => "<=",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Severity {
    Info,
    Warn,
    Error,
}

impl Severity {
    fn parse(value: &str) -> Result<Self, String> {
        Ok(match value {
            "info" => Severity::Info,
            "warn" | "warning" => Severity::Warn,
            "error" => Severity::Error,
            other => return Err(format!("unknown severity '{other}' (info, warn, error)")),
        })
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Warn => "warn",
            Severity::Error => "error",
        }
    }
}

/// A validated trigger rule.
pub(crate) struct Trigger {
    pub(crate) id: String,
    pub(crate) metric: Metric,
    pub(crate) scope: Scope,
    pub(crate) op: Op,
    pub(crate) value: f64,
    pub(crate) severity: Severity,
    pub(crate) message: Option<String>,
}

/// One trigger that fired against one scope key.
pub(crate) struct Firing {
    pub(crate) trigger_id: String,
    pub(crate) scope: &'static str,
    pub(crate) scope_key: String,
    pub(crate) op: Op,
    pub(crate) limit: f64,
    pub(crate) actual: f64,
    pub(crate) is_ratio: bool,
    pub(crate) severity: Severity,
    pub(crate) message: String,
}

#[derive(Deserialize)]
struct TriggersFile {
    #[serde(default)]
    trigger: Vec<TriggerSpec>,
}

#[derive(Deserialize)]
struct TriggerSpec {
    id: String,
    metric: String,
    scope: String,
    op: String,
    value: f64,
    #[serde(default = "default_severity")]
    severity: String,
    #[serde(default)]
    message: String,
}

fn default_severity() -> String {
    "warn".to_string()
}

/// Parse a `triggers.toml`. Individual malformed triggers are reported (via the
/// returned `Err`) rather than silently dropped.
pub(crate) fn parse(toml_text: &str) -> Result<Vec<Trigger>, String> {
    let file: TriggersFile = toml::from_str(toml_text).map_err(|err| format!("parse: {err}"))?;
    let mut triggers = Vec::with_capacity(file.trigger.len());
    for spec in file.trigger {
        triggers.push(Trigger {
            metric: Metric::parse(&spec.metric)
                .map_err(|err| format!("trigger '{}': {err}", spec.id))?,
            scope: Scope::parse(&spec.scope)
                .map_err(|err| format!("trigger '{}': {err}", spec.id))?,
            op: Op::parse(&spec.op).map_err(|err| format!("trigger '{}': {err}", spec.id))?,
            severity: Severity::parse(&spec.severity)
                .map_err(|err| format!("trigger '{}': {err}", spec.id))?,
            value: spec.value,
            message: if spec.message.trim().is_empty() {
                None
            } else {
                Some(spec.message)
            },
            id: spec.id,
        });
    }
    Ok(triggers)
}

/// Aggregate one scope group's token/cost/count totals.
#[derive(Default, Clone)]
struct Agg {
    cost: f64,
    tokens: i64,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    count: i64,
}

impl Agg {
    fn add(&mut self, row: &UsageSessionRow) {
        self.cost += row.cost_usd;
        self.tokens += row.real_total_tokens;
        self.input += row.input_tokens;
        self.output += row.output_tokens;
        self.cache_read += row.cache_read_tokens;
        self.cache_write += row.cache_write_tokens;
        self.count += 1;
    }

    fn metric(&self, metric: Metric) -> f64 {
        match metric {
            Metric::CostUsd => self.cost,
            Metric::Tokens => self.tokens as f64,
            Metric::InputTokens => self.input as f64,
            Metric::OutputTokens => self.output as f64,
            Metric::CacheReadTokens => self.cache_read as f64,
            Metric::CacheWriteTokens => self.cache_write as f64,
            Metric::SessionCount => self.count as f64,
            Metric::CacheHitRate => {
                let denom = self.input + self.cache_write + self.cache_read;
                if denom > 0 {
                    self.cache_read as f64 / denom as f64
                } else {
                    0.0
                }
            }
        }
    }
}

/// Evaluate every trigger against the session set and return all firings, most
/// severe first. `project_of` maps a session id to its project slug (for
/// `scope = "project"`); a session's display key uses its name.
pub(crate) fn evaluate(
    sessions: &[UsageSessionRow],
    project_of: &BTreeMap<String, String>,
    triggers: &[Trigger],
) -> Vec<Firing> {
    let mut firings = Vec::new();
    for trigger in triggers {
        // Group the sessions by this trigger's scope.
        let mut groups: BTreeMap<String, Agg> = BTreeMap::new();
        for row in sessions {
            let key = match trigger.scope {
                Scope::Total => "all".to_string(),
                Scope::Day => day_key(row.last_active_ms),
                Scope::Source => row.source.clone(),
                Scope::Project => project_of
                    .get(&row.session_id)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string()),
                Scope::Session => {
                    let name = if row.name.trim().is_empty() {
                        row.session_id.clone()
                    } else {
                        row.name.clone()
                    };
                    format!("{}|{name}", row.session_id)
                }
            };
            groups.entry(key).or_default().add(row);
        }
        for (key, agg) in &groups {
            let actual = agg.metric(trigger.metric);
            if trigger.op.test(actual, trigger.value) {
                // For `session` scope the key embeds `id|name`; show the name.
                let scope_key = key.split_once('|').map(|(_, name)| name).unwrap_or(key);
                firings.push(Firing {
                    trigger_id: trigger.id.clone(),
                    scope: trigger.scope.label(),
                    scope_key: scope_key.to_string(),
                    op: trigger.op,
                    limit: trigger.value,
                    actual,
                    is_ratio: trigger.metric == Metric::CacheHitRate,
                    severity: trigger.severity,
                    message: render_message(trigger, scope_key, actual),
                });
            }
        }
    }
    // error > warn > info; then by trigger id for stability.
    firings.sort_by(|a, b| {
        severity_rank(b.severity)
            .cmp(&severity_rank(a.severity))
            .then(a.trigger_id.cmp(&b.trigger_id))
    });
    firings
}

fn render_message(trigger: &Trigger, scope_key: &str, actual: f64) -> String {
    match &trigger.message {
        Some(template) => template
            .replace("{scope}", scope_key)
            .replace("{actual}", &format_value(actual, trigger.metric == Metric::CacheHitRate))
            .replace("{value}", &format_value(trigger.value, trigger.metric == Metric::CacheHitRate)),
        None => format!(
            "{} {} {} {} ({})",
            trigger.id,
            metric_label(trigger.metric),
            trigger.op.symbol(),
            format_value(trigger.value, trigger.metric == Metric::CacheHitRate),
            scope_key,
        ),
    }
}

fn metric_label(metric: Metric) -> &'static str {
    match metric {
        Metric::CostUsd => "cost_usd",
        Metric::Tokens => "tokens",
        Metric::InputTokens => "input_tokens",
        Metric::OutputTokens => "output_tokens",
        Metric::CacheReadTokens => "cache_read_tokens",
        Metric::CacheWriteTokens => "cache_write_tokens",
        Metric::SessionCount => "session_count",
        Metric::CacheHitRate => "cache_hit_rate",
    }
}

/// Human-format a metric value: ratios as %, otherwise a compact number.
pub(crate) fn format_value(value: f64, is_ratio: bool) -> String {
    if is_ratio {
        format!("{:.1}%", value * 100.0)
    } else if value >= 1_000_000.0 {
        format!("{:.1}M", value / 1_000_000.0)
    } else if value >= 1_000.0 {
        format!("{:.1}K", value / 1_000.0)
    } else if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        format!("{value:.2}")
    }
}

fn severity_rank(severity: Severity) -> u8 {
    match severity {
        Severity::Info => 0,
        Severity::Warn => 1,
        Severity::Error => 2,
    }
}

/// `last_active_ms` → `YYYY-MM-DD` (uses the shared ISO formatter, date part).
fn day_key(last_active_ms: i64) -> String {
    if last_active_ms <= 0 {
        return "unknown".to_string();
    }
    let iso = epoch_ms_to_iso(last_active_ms);
    iso.get(..10).unwrap_or(&iso).to_string()
}

/// The process exit code for a set of firings: 2 if any error, else 1 when
/// `strict` and any warn fired, else 0.
pub(crate) fn exit_code(firings: &[Firing], strict: bool) -> i32 {
    if firings.iter().any(|f| f.severity == Severity::Error) {
        2
    } else if strict && firings.iter().any(|f| f.severity == Severity::Warn) {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(source: &str, cost: f64, tokens: i64, last_ms: i64) -> UsageSessionRow {
        UsageSessionRow {
            source: source.to_string(),
            session_id: format!("{source}-{last_ms}"),
            cost_usd: cost,
            real_total_tokens: tokens,
            last_active_ms: last_ms,
            ..Default::default()
        }
    }

    #[test]
    fn parses_and_validates() {
        let ok = parse("[[trigger]]\nid=\"c\"\nmetric=\"cost_usd\"\nscope=\"total\"\nop=\">\"\nvalue=10\n").unwrap();
        assert_eq!(ok.len(), 1);
        assert!(parse("[[trigger]]\nid=\"c\"\nmetric=\"bogus\"\nscope=\"total\"\nop=\">\"\nvalue=1\n").is_err());
        assert!(parse("[[trigger]]\nid=\"c\"\nmetric=\"cost_usd\"\nscope=\"total\"\nop=\"~\"\nvalue=1\n").is_err());
    }

    #[test]
    fn total_scope_fires_once_when_over() {
        let sessions = vec![row("claude_code", 30.0, 10, 1), row("codex_app", 25.0, 5, 1)];
        let triggers = parse("[[trigger]]\nid=\"cap\"\nmetric=\"cost_usd\"\nscope=\"total\"\nop=\">\"\nvalue=50\nseverity=\"error\"\n").unwrap();
        let firings = evaluate(&sessions, &BTreeMap::new(), &triggers);
        assert_eq!(firings.len(), 1);
        assert_eq!(firings[0].actual, 55.0);
        assert_eq!(exit_code(&firings, false), 2);
    }

    #[test]
    fn source_scope_fires_per_source_over_limit() {
        let sessions = vec![
            row("claude_code", 60.0, 10, 1),
            row("codex_app", 5.0, 5, 1),
        ];
        let triggers = parse("[[trigger]]\nid=\"src\"\nmetric=\"cost_usd\"\nscope=\"source\"\nop=\">\"\nvalue=50\n").unwrap();
        let firings = evaluate(&sessions, &BTreeMap::new(), &triggers);
        assert_eq!(firings.len(), 1);
        assert_eq!(firings[0].scope_key, "claude_code");
        // warn (default) with no --strict → exit 0
        assert_eq!(exit_code(&firings, false), 0);
        assert_eq!(exit_code(&firings, true), 1);
    }

    #[test]
    fn no_firing_when_under() {
        let sessions = vec![row("claude_code", 1.0, 10, 1)];
        let triggers = parse("[[trigger]]\nid=\"x\"\nmetric=\"cost_usd\"\nscope=\"total\"\nop=\">\"\nvalue=50\n").unwrap();
        assert!(evaluate(&sessions, &BTreeMap::new(), &triggers).is_empty());
    }
}

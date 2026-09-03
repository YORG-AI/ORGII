//! Thinking / reasoning mode classification and parameter mapping.
//!
//! Different model families expose thinking control through wildly different
//! request shapes, so a single `thinking` parameter cannot be correct for all
//! of them. This module is the single source of truth for:
//!
//! 1. **Parsing** the reasoning-level suffix ORG2 encodes into model ids
//!    (e.g. `glm-5.2-high`, `claude-opus-4-7-thinking-xhigh`) back into a
//!    structured level **plus the real base model id** that providers accept
//!    — providers reject the suffixed alias.
//! 2. **Classifying** a model into a [`ThinkingMode`] (adaptive vs budget vs
//!    effort vs toggle), using version-aware regex ported from Cherry Studio
//!    so Opus 4.7+/Fable-5/Mythos (adaptive) are never mis-sent
//!    `budget_tokens` (which they reject with HTTP 400).
//! 3. **Translating** `(mode, level)` into each provider's wire parameter.
//!
//! The suffix token set mirrors the frontend `VARIANT_SUFFIX_TOKENS`
//! (`src/util/modelVariants.ts`) so front- and back-end agree on what a
//! "variant suffix" is.

use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;

use crate::providers::model_capabilities::{classify_family, ModelFamily};

/// User-selectable reasoning effort, independent of provider protocol.
/// Mirrors the frontend `MODEL_REASONING_LEVEL`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasoningLevel {
    None,
    Baseline,
    Low,
    Medium,
    High,
    ExtraHigh,
    Max,
    /// Max reasoning plus harness-level delegation; not a wire effort above Max.
    Ultra,
    Ultracode,
}

impl ReasoningLevel {
    /// Parse a single (already compound-merged) suffix token into a level.
    /// Returns `None` for non-level tokens (`thinking`, `fast`) and unknown
    /// strings, so the caller can treat them as the orthogonal flags they are.
    pub fn from_token(token: &str) -> Option<Self> {
        match token {
            "none" => Some(Self::None),
            "baseline" => Some(Self::Baseline),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "extra" | "extra-high" | "xhigh" => Some(Self::ExtraHigh),
            "max" => Some(Self::Max),
            "ultra" => Some(Self::Ultra),
            "ultracode" => Some(Self::Ultracode),
            _ => None,
        }
    }
}

/// How a model exposes thinking control. Decides the request parameter shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingMode {
    /// Non-reasoning model — send no thinking/effort parameter.
    None,
    /// Anthropic adaptive thinking (Opus 4.7/4.8, Fable-5, Mythos).
    /// Rejects `budget_tokens` (HTTP 400); requires `display: "summarized"`
    /// (API defaults to `omitted`, hiding reasoning) and forbids
    /// `temperature`/`top_p`/`top_k` (also HTTP 400).
    AnthropicAdaptive,
    /// Anthropic 4.6 adaptive thinking (opus-4.6 / sonnet-4.6).
    /// `thinking: {type: "adaptive"}` + `effort` (UI extra_high → API `max`).
    Anthropic46,
    /// Legacy Anthropic extended thinking (Opus 4/4.1/4.5, Sonnet 4/4.5, 3.7).
    /// `thinking: {type: "enabled", budget_tokens}`.
    AnthropicLegacyBudget,
    /// OpenAI reasoning models (gpt-5+/o-series). `reasoning_effort`.
    OpenAiEffort,
    /// Zhipu GLM. Simple on/off `thinking: {type: "enabled"|"disabled"}`
    /// toggle — budget support is unreliable across GLM versions, so we do
    /// not send a budget (mirrors Cherry Studio).
    ZhipuToggle,
}

/// A model id split into its base alias + the variant suffix ORG2 encoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedVariant {
    /// The real model id providers accept (suffix stripped).
    pub base_model: String,
    pub level: Option<ReasoningLevel>,
    pub thinking: bool,
    pub fast: bool,
}

impl ParsedVariant {
    /// No suffix encoded — the id is the base id, nothing to map.
    pub fn bare(model: &str) -> Self {
        Self {
            base_model: model.to_string(),
            level: None,
            thinking: false,
            fast: false,
        }
    }
}

/// Tokens that may appear as ORG2-encoded variant suffixes. Matches the
/// frontend `VARIANT_SUFFIX_TOKENS` exactly. Provider-native suffixes
/// (`mini`, `flash`, date stamps, `20250514`) are deliberately absent so they
/// are never stripped.
const SUFFIX_TOKENS: &[&str] = &[
    "none",
    "baseline",
    "low",
    "medium",
    "high",
    "extra",
    "extra-high",
    "xhigh",
    "max",
    "ultra",
    "ultracode",
    "minimal",
    "thinking",
    "fast",
];

fn is_suffix_token(tok: &str) -> bool {
    SUFFIX_TOKENS.contains(&tok)
}

/// Split a (possibly suffixed) model id into base alias + variant metadata.
///
/// Peels trailing tokens that belong to ORG2's variant vocabulary only;
/// provider-native suffixes are preserved. `extra` + `high` are merged into
/// `extra-high` exactly as the frontend (`mergeCompoundTokens`) does.
pub fn parse_model_variant(model: &str) -> ParsedVariant {
    let lower = model.to_lowercase();
    let lower_segments: Vec<&str> = lower.split('-').collect();

    // Walk from the end, peeling recognised suffix tokens off the base.
    let mut split = lower_segments.len();
    while split > 1 {
        if !is_suffix_token(lower_segments[split - 1]) {
            break;
        }
        split -= 1;
    }

    if split == lower_segments.len() {
        // No suffix token peeled — id carries no encoded variant.
        return ParsedVariant::bare(model);
    }

    let raw_tokens: Vec<&str> = lower_segments[split..].to_vec();

    // Merge `extra` + `high` → `extra-high`.
    let mut merged: Vec<String> = Vec::with_capacity(raw_tokens.len());
    let mut i = 0;
    while i < raw_tokens.len() {
        if raw_tokens[i] == "extra" && i + 1 < raw_tokens.len() && raw_tokens[i + 1] == "high" {
            merged.push("extra-high".to_string());
            i += 2;
        } else {
            merged.push(raw_tokens[i].to_string());
            i += 1;
        }
    }

    let mut thinking = false;
    let mut fast = false;
    let mut level: Option<ReasoningLevel> = None;
    for tok in &merged {
        match tok.as_str() {
            "thinking" => thinking = true,
            "fast" => fast = true,
            other if level.is_none() => level = ReasoningLevel::from_token(other),
            _ => {}
        }
    }

    // Base model keeps original casing (take the first `split` segments).
    let base_model: String = model.split('-').take(split).collect::<Vec<_>>().join("-");

    ParsedVariant {
        base_model,
        level,
        thinking,
        fast,
    }
}

// ── Reasoning trigger words ─────────────────────────────────────────────────

impl ReasoningLevel {
    /// Ordinal for level comparison (higher = more reasoning).
    fn rank(self) -> u8 {
        match self {
            Self::None => 0,
            Self::Baseline => 1,
            Self::Low => 2,
            Self::Medium => 3,
            Self::High => 4,
            Self::ExtraHigh => 5,
            Self::Max => 6,
            Self::Ultra => 7,
            Self::Ultracode => 8,
        }
    }

    /// Suffix token used when re-encoding a level into a model id.
    fn suffix_token(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Baseline => "baseline",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::ExtraHigh => "xhigh",
            Self::Max => "max",
            Self::Ultra => "ultra",
            Self::Ultracode => "ultracode",
        }
    }
}

/// Detect a reasoning trigger word in a user message.
///
/// Ordered strongest-first: "ultrathink" → Max, "think harder" /
/// "think really hard" / "think very hard" → ExtraHigh, "think hard" /
/// "megathink" → High. Matching is case-insensitive.
///
/// Deliberately NO bare-"think" tier: "I think the bug is…" is ordinary
/// prose, and forcing an explicit effort level onto adaptive-thinking
/// models can DOWNGRADE what the API would have chosen dynamically. The
/// reference implementation's current version keeps only explicit trigger
/// phrases for the same reason.
pub fn detect_reasoning_trigger(text: &str) -> Option<ReasoningLevel> {
    let lower = text.to_lowercase();
    if lower.contains("ultrathink") {
        return Some(ReasoningLevel::Max);
    }
    if lower.contains("think harder")
        || lower.contains("think really hard")
        || lower.contains("think very hard")
        || lower.contains("think intensely")
    {
        return Some(ReasoningLevel::ExtraHigh);
    }
    if lower.contains("think hard")
        || lower.contains("megathink")
        || lower.contains("think a lot")
        || lower.contains("think deeply")
    {
        return Some(ReasoningLevel::High);
    }
    None
}

/// Re-encode `model` with at least `min_level` reasoning.
///
/// Parses the ORG2 variant suffix, takes the max of the encoded level and
/// `min_level`, and rebuilds the id. Returns the original id unchanged when
/// the encoded level already meets or exceeds `min_level`, so per-turn
/// escalation never *lowers* an explicit user selection. Provider-agnostic:
/// the returned id goes through the same `parse_model_variant` path every
/// provider already uses.
pub fn escalate_model_reasoning(model: &str, min_level: ReasoningLevel) -> String {
    let parsed = parse_model_variant(model);
    let current_rank = parsed.level.map(|l| l.rank()).unwrap_or(0);
    if current_rank >= min_level.rank() {
        return model.to_string();
    }
    let mut rebuilt = parsed.base_model;
    if parsed.thinking {
        rebuilt.push_str("-thinking");
    }
    rebuilt.push('-');
    rebuilt.push_str(min_level.suffix_token());
    if parsed.fast {
        rebuilt.push_str("-fast");
    }
    rebuilt
}

#[cfg(test)]
mod reasoning_trigger_tests {
    use super::*;

    #[test]
    fn ultrathink_maps_to_max() {
        assert_eq!(
            detect_reasoning_trigger("please ULTRATHINK about this"),
            Some(ReasoningLevel::Max)
        );
    }

    #[test]
    fn think_harder_maps_to_extra_high() {
        assert_eq!(
            detect_reasoning_trigger("think harder about the edge cases"),
            Some(ReasoningLevel::ExtraHigh)
        );
    }

    #[test]
    fn think_hard_maps_to_high() {
        assert_eq!(
            detect_reasoning_trigger("Think hard before answering"),
            Some(ReasoningLevel::High)
        );
    }

    #[test]
    fn bare_think_does_not_trigger() {
        // Ordinary prose must never escalate — and never force an explicit
        // level onto adaptive models that would have chosen dynamically.
        assert_eq!(
            detect_reasoning_trigger("I think the bug is in auth.rs"),
            None
        );
        assert_eq!(detect_reasoning_trigger("think about it"), None);
        assert_eq!(detect_reasoning_trigger("rethinking the approach"), None);
        assert_eq!(detect_reasoning_trigger("he thinks so"), None);
    }

    #[test]
    fn no_trigger_returns_none() {
        assert_eq!(detect_reasoning_trigger("fix the bug in auth.rs"), None);
    }

    #[test]
    fn escalate_appends_suffix_to_bare_model() {
        assert_eq!(
            escalate_model_reasoning("claude-opus-4-6", ReasoningLevel::High),
            "claude-opus-4-6-high"
        );
    }

    #[test]
    fn escalate_never_lowers_explicit_level() {
        assert_eq!(
            escalate_model_reasoning("claude-opus-4-6-max", ReasoningLevel::Medium),
            "claude-opus-4-6-max"
        );
    }

    #[test]
    fn escalate_raises_lower_level() {
        assert_eq!(
            escalate_model_reasoning("claude-opus-4-6-low", ReasoningLevel::Max),
            "claude-opus-4-6-max"
        );
    }

    #[test]
    fn escalate_preserves_thinking_and_fast_flags() {
        assert_eq!(
            escalate_model_reasoning("glm-4.7-thinking", ReasoningLevel::High),
            "glm-4.7-thinking-high"
        );
        assert_eq!(
            escalate_model_reasoning("claude-opus-4-6-fast", ReasoningLevel::High),
            "claude-opus-4-6-high-fast"
        );
    }
}

// ── Claude version detection (ported from Cherry Studio) ───────────────────

fn opus47_or_newer_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // minor capped at two digits so date suffixes (e.g. -20250514) fall
        // into the trailing-suffix group rather than being read as the minor.
        Regex::new(
            r"^(?:anthropic\.)?claude-(opus|fable|sonnet)-(\d+)(?:[.-](\d{1,2}))?(?:[@\-:][\w\-:]+)?$",
        )
        .expect("opus47 regex")
    })
}

fn mythos_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"claude-mythos").expect("mythos regex"))
}

fn claude46_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?:anthropic\.)?claude-(?:opus|sonnet)-4[.-]6(?:[@\-:][\w\-:]+)?$")
            .expect("claude46 regex")
    })
}

/// Opus 4.7+ / Fable 5+ / Mythos — the adaptive-thinking family that rejects
/// `budget_tokens` and sampling parameters with HTTP 400.
pub fn is_claude_opus_47_or_newer(base_model: &str) -> bool {
    let id = base_model.to_lowercase();
    // Mythos (ORG2: `claude-mythos` = "Mythos 5") shares the new architecture.
    // Matched via regex (not a `.contains` family-token literal) so the
    // no_substring_capability_checks test stays green.
    if mythos_regex().is_match(&id) {
        return true;
    }
    let caps = match opus47_or_newer_regex().captures(&id) {
        Some(c) => c,
        None => return false,
    };
    let family = caps.get(1).unwrap().as_str();
    let major: u32 = caps.get(2).unwrap().as_str().parse().unwrap_or(0);
    let minor: u32 = caps
        .get(3)
        .map(|m| m.as_str().parse().unwrap_or(0))
        .unwrap_or(0);
    if family == "fable" {
        return major >= 5;
    }
    major > 4 || (major == 4 && minor >= 7)
}

/// Opus/Sonnet 4.6 — adaptive thinking + `effort` (UI extra_high → `max`).
pub fn is_claude_46_series(base_model: &str) -> bool {
    claude46_regex().is_match(&base_model.to_lowercase())
}

/// 4.7+ rejects `temperature`/`top_p`/`top_k` with HTTP 400 regardless of
/// whether thinking is requested.
pub fn is_claude_rejects_sampling(base_model: &str) -> bool {
    is_claude_opus_47_or_newer(base_model)
}

/// Classify a base model id into its thinking mode.
///
/// Family classification is centralised in
/// `model_capabilities::classify_family`; here we only split the Anthropic
/// family by version into its thinking-mode generations (adaptive / 4.6 /
/// legacy budget). `provider_name` flows through to `classify_family` to
/// disambiguate aliases that carry no family prefix.
pub fn resolve_thinking_mode(base_model: &str, provider_name: &str) -> ThinkingMode {
    match classify_family(base_model, provider_name) {
        ModelFamily::Anthropic => {
            if is_claude_opus_47_or_newer(base_model) {
                ThinkingMode::AnthropicAdaptive
            } else if is_claude_46_series(base_model) {
                ThinkingMode::Anthropic46
            } else {
                ThinkingMode::AnthropicLegacyBudget
            }
        }
        ModelFamily::Zhipu => ThinkingMode::ZhipuToggle,
        ModelFamily::OpenAi => ThinkingMode::OpenAiEffort,
        ModelFamily::Other => ThinkingMode::None,
    }
}

// ── Parameter mapping ──────────────────────────────────────────────────────

/// Anthropic `effort` value for adaptive / 4.6 modes. `None` when the level
/// maps to "no explicit effort" (baseline) — the caller still sends
/// `thinking: {type: "adaptive"}` in that case.
pub fn anthropic_effort(mode: ThinkingMode, level: Option<ReasoningLevel>) -> Option<&'static str> {
    let level = level?;
    if matches!(level, ReasoningLevel::Baseline | ReasoningLevel::None) {
        return None;
    }
    let xhigh_target = match mode {
        ThinkingMode::AnthropicAdaptive => "xhigh",
        ThinkingMode::Anthropic46 => "max",
        _ => return None,
    };
    Some(match level {
        ReasoningLevel::Low => "low",
        ReasoningLevel::Medium => "medium",
        ReasoningLevel::High => "high",
        ReasoningLevel::ExtraHigh => xhigh_target,
        ReasoningLevel::Max | ReasoningLevel::Ultra => "max",
        ReasoningLevel::Ultracode => "ultracode",
        ReasoningLevel::Baseline | ReasoningLevel::None => return None,
    })
}

/// Build the Anthropic `thinking` request object for the given mode + level.
///
/// Returns `None` when no thinking param should be sent (`ThinkingMode::None`,
/// or non-Anthropic modes). `max_tokens` is only consulted by the legacy
/// budget branch.
pub fn anthropic_thinking_param(
    mode: ThinkingMode,
    level: Option<ReasoningLevel>,
    max_tokens: u32,
) -> Option<Value> {
    match mode {
        ThinkingMode::None | ThinkingMode::OpenAiEffort | ThinkingMode::ZhipuToggle => None,
        ThinkingMode::AnthropicAdaptive => {
            if matches!(level, Some(ReasoningLevel::None)) {
                return Some(json!({ "type": "disabled" }));
            }
            // `display: "summarized"` is required — the API defaults to
            // `omitted`, which strips reasoning from the response.
            Some(json!({ "type": "adaptive", "display": "summarized" }))
        }
        ThinkingMode::Anthropic46 => {
            if matches!(level, Some(ReasoningLevel::None)) {
                return Some(json!({ "type": "disabled" }));
            }
            Some(json!({ "type": "adaptive" }))
        }
        ThinkingMode::AnthropicLegacyBudget => {
            if matches!(level, Some(ReasoningLevel::None)) {
                return Some(json!({ "type": "disabled" }));
            }
            let budget = anthropic_legacy_budget(level, max_tokens);
            Some(json!({ "type": "enabled", "budget_tokens": budget }))
        }
    }
}

/// Legacy Claude budget by level. Baseline / unspecified preserves the prior
/// `(max_tokens / 2).clamp(1024, 32768)` behaviour so existing flows don't
/// regress when no level was selected.
fn anthropic_legacy_budget(level: Option<ReasoningLevel>, max_tokens: u32) -> u32 {
    match level {
        Some(ReasoningLevel::Low) => 8_192,
        Some(ReasoningLevel::Medium) => 16_384,
        Some(ReasoningLevel::High) => 24_576,
        Some(ReasoningLevel::ExtraHigh) => 28_672,
        Some(ReasoningLevel::Max | ReasoningLevel::Ultra | ReasoningLevel::Ultracode) => 32_768,
        _ => (max_tokens / 2).clamp(1024, 32_768),
    }
}

/// `max_tokens` floor so the legacy thinking budget can't starve the visible
/// answer. Only the legacy budget branch needs this — adaptive modes have no
/// caller-supplied budget to make room for.
pub fn anthropic_max_tokens_floor(
    mode: ThinkingMode,
    level: Option<ReasoningLevel>,
    max_tokens: u32,
) -> u32 {
    match mode {
        ThinkingMode::AnthropicLegacyBudget => {
            let budget = anthropic_legacy_budget(level, max_tokens);
            max_tokens.max(budget + 1024)
        }
        _ => max_tokens,
    }
}

/// OpenAI wire effort. Preserve selectable `xhigh` and `max` values instead
/// of silently lowering them. Model discovery owns which levels are offered;
/// unsupported explicit selections should be rejected by the provider.
/// Ultra uses Max reasoning; its delegation mode is applied by the harness.
/// Baseline/none retain the existing behavior of using the model default.
pub fn openai_effort(level: Option<ReasoningLevel>) -> Option<&'static str> {
    Some(match level? {
        ReasoningLevel::Low => "low",
        ReasoningLevel::Medium => "medium",
        ReasoningLevel::High => "high",
        ReasoningLevel::ExtraHigh => "xhigh",
        ReasoningLevel::Max | ReasoningLevel::Ultra => "max",
        ReasoningLevel::Ultracode => "high",
        ReasoningLevel::Baseline | ReasoningLevel::None => return None,
    })
}

/// Zhipu GLM `thinking` toggle. Budget is intentionally not mapped (unreliable
/// across GLM versions); we only flip thinking on/off.
pub fn zhipu_thinking(level: Option<ReasoningLevel>) -> Option<Value> {
    match level {
        Some(ReasoningLevel::None) => Some(json!({ "type": "disabled" })),
        Some(ReasoningLevel::Baseline) | None => None, // model default (enabled)
        Some(_) => Some(json!({ "type": "enabled" })),
    }
}

/// Resolved openai_compat thinking fields for one model id. This is the
/// shared assembly step used by both the streaming and non-streaming chat
/// paths (`openai_compat::streaming::chat` / `sse_stream`) so they cannot
/// drift on the strip + dispatch logic.
///
/// At most one of `reasoning_effort` (OpenAI) and `thinking` (Zhipu GLM) is
/// set — never both, never for a non-reasoning model.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenAiCompatThinking {
    /// Real model id providers accept (suffix stripped).
    pub base_model: String,
    pub reasoning_effort: Option<String>,
    pub thinking: Option<Value>,
}

pub fn resolve_openai_compat_thinking(
    resolved_model: &str,
    provider_name: &str,
) -> OpenAiCompatThinking {
    let parsed = parse_model_variant(resolved_model);
    let mode = resolve_thinking_mode(&parsed.base_model, provider_name);
    let reasoning_effort = if mode == ThinkingMode::OpenAiEffort {
        openai_effort(parsed.level).map(str::to_string)
    } else {
        None
    };
    let thinking = if mode == ThinkingMode::ZhipuToggle {
        zhipu_thinking(parsed.level)
    } else {
        None
    };
    OpenAiCompatThinking {
        base_model: parsed.base_model,
        reasoning_effort,
        thinking,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::providers::registry::provider_id;

    // ── parse_model_variant ────────────────────────────────────────────────

    #[test]
    fn parses_glm_level_suffix() {
        let p = parse_model_variant("glm-5.2-high");
        assert_eq!(p.base_model, "glm-5.2");
        assert_eq!(p.level, Some(ReasoningLevel::High));
        assert!(!p.thinking);
        assert!(!p.fast);
    }

    #[test]
    fn parses_claude_thinking_xhigh() {
        let p = parse_model_variant("claude-opus-4-7-thinking-xhigh");
        assert_eq!(p.base_model, "claude-opus-4-7");
        assert_eq!(p.level, Some(ReasoningLevel::ExtraHigh));
        assert!(p.thinking);
    }

    #[test]
    fn merges_extra_high_compound() {
        let p = parse_model_variant("claude-opus-4-7-extra-high");
        assert_eq!(p.base_model, "claude-opus-4-7");
        assert_eq!(p.level, Some(ReasoningLevel::ExtraHigh));
    }

    #[test]
    fn parses_fable_ultracode() {
        let p = parse_model_variant("claude-fable-5-ultracode");
        assert_eq!(p.base_model, "claude-fable-5");
        assert_eq!(p.level, Some(ReasoningLevel::Ultracode));
        assert!(!p.thinking);
    }

    /// Fable 5.1's minor-version segment is not a variant token — peeling the
    /// effort suffix must stop at `-1` and leave the base model intact.
    #[test]
    fn parses_fable_5_1_effort_suffix_without_eating_the_minor_version() {
        let p = parse_model_variant("claude-fable-5-1-ultracode");
        assert_eq!(p.base_model, "claude-fable-5-1");
        assert_eq!(p.level, Some(ReasoningLevel::Ultracode));

        let bare = parse_model_variant("claude-fable-5-1");
        assert_eq!(bare.base_model, "claude-fable-5-1");
        assert!(bare.level.is_none());
    }

    #[test]
    fn parses_codex_ultra_without_losing_the_delegation_mode() {
        let p = parse_model_variant("gpt-5.6-sol-ultra-fast");
        assert_eq!(p.base_model, "gpt-5.6-sol");
        assert_eq!(p.level, Some(ReasoningLevel::Ultra));
        assert!(p.fast);
        assert_eq!(
            escalate_model_reasoning("gpt-5.6-sol-ultra-fast", ReasoningLevel::Max),
            "gpt-5.6-sol-ultra-fast"
        );
    }

    #[test]
    fn preserves_provider_native_suffixes() {
        // `mini` / `flash` / date stamps are NOT variant tokens.
        for id in &["gpt-5.5-mini", "gemini-2.0-flash", "claude-opus-4-20250514"] {
            let p = parse_model_variant(id);
            assert_eq!(p.base_model, *id, "base_model must not strip native suffix");
            assert!(p.level.is_none());
        }
    }

    #[test]
    fn bare_id_has_no_variant() {
        let p = parse_model_variant("glm-5.2");
        assert_eq!(p.base_model, "glm-5.2");
        assert!(p.level.is_none());
    }

    // ── Claude version detection ───────────────────────────────────────────

    #[test]
    fn detects_opus_47_or_newer() {
        for id in &[
            "claude-opus-4-7",
            "claude-opus-4.7",
            "claude-opus-4-8",
            "claude-opus-5",
            "claude-fable-5",
            "claude-fable-5-1",
            "anthropic.claude-fable-5-1-v1",
            "anthropic.claude-opus-4-7-v1",
            "claude-mythos",
        ] {
            assert!(is_claude_opus_47_or_newer(id), "{id} should be 4.7+");
        }
    }

    #[test]
    fn does_not_misclassify_date_stamped_as_47() {
        // claude-opus-4-20250514 must NOT be read as 4.<20250514>.
        assert!(!is_claude_opus_47_or_newer("claude-opus-4-20250514"));
        assert!(!is_claude_opus_47_or_newer("claude-opus-4-6"));
        assert!(!is_claude_opus_47_or_newer("claude-opus-4-5"));
    }

    #[test]
    fn detects_claude_46_series() {
        assert!(is_claude_46_series("claude-opus-4-6"));
        assert!(is_claude_46_series("claude-sonnet-4.6"));
        assert!(!is_claude_46_series("claude-opus-4-7"));
        assert!(!is_claude_46_series("claude-opus-4-5"));
    }

    #[test]
    fn opus_47_rejects_sampling() {
        assert!(is_claude_rejects_sampling("claude-opus-4-8"));
        assert!(!is_claude_rejects_sampling("claude-opus-4-6"));
    }

    // ── resolve_thinking_mode ──────────────────────────────────────────────

    #[test]
    fn classifies_modes() {
        assert_eq!(
            resolve_thinking_mode("claude-opus-4-8", provider_id::ANTHROPIC),
            ThinkingMode::AnthropicAdaptive
        );
        assert_eq!(
            resolve_thinking_mode("claude-opus-4-6", provider_id::ANTHROPIC),
            ThinkingMode::Anthropic46
        );
        assert_eq!(
            resolve_thinking_mode("claude-opus-4-5", provider_id::ANTHROPIC),
            ThinkingMode::AnthropicLegacyBudget
        );
        assert_eq!(
            resolve_thinking_mode("glm-5.2", provider_id::ZHIPU),
            ThinkingMode::ZhipuToggle
        );
        assert_eq!(
            resolve_thinking_mode("gpt-5.5", provider_id::OPENAI),
            ThinkingMode::OpenAiEffort
        );
    }

    // ── Anthropic parameter mapping ────────────────────────────────────────

    #[test]
    fn adaptive_emits_summarized_display() {
        let t = anthropic_thinking_param(
            ThinkingMode::AnthropicAdaptive,
            Some(ReasoningLevel::High),
            8192,
        )
        .unwrap();
        assert_eq!(t["type"], "adaptive");
        assert_eq!(t["display"], "summarized");
        // adaptive must NEVER carry budget_tokens (would 400)
        assert!(t.get("budget_tokens").is_none());
        assert_eq!(
            anthropic_effort(ThinkingMode::AnthropicAdaptive, Some(ReasoningLevel::High)),
            Some("high")
        );
        assert_eq!(
            anthropic_effort(
                ThinkingMode::AnthropicAdaptive,
                Some(ReasoningLevel::ExtraHigh)
            ),
            Some("xhigh")
        );
        assert_eq!(
            anthropic_effort(ThinkingMode::AnthropicAdaptive, Some(ReasoningLevel::Max)),
            Some("max")
        );
        assert_eq!(
            anthropic_effort(
                ThinkingMode::AnthropicAdaptive,
                Some(ReasoningLevel::Ultracode)
            ),
            Some("ultracode")
        );
    }

    #[test]
    fn claude46_maps_extra_high_to_max() {
        assert_eq!(
            anthropic_effort(ThinkingMode::Anthropic46, Some(ReasoningLevel::ExtraHigh)),
            Some("max")
        );
        let t = anthropic_thinking_param(
            ThinkingMode::Anthropic46,
            Some(ReasoningLevel::Medium),
            8192,
        )
        .unwrap();
        assert_eq!(t["type"], "adaptive");
        assert!(t.get("display").is_none());
    }

    #[test]
    fn legacy_budget_respects_level_and_baseline_default() {
        let t = anthropic_thinking_param(
            ThinkingMode::AnthropicLegacyBudget,
            Some(ReasoningLevel::High),
            8192,
        )
        .unwrap();
        assert_eq!(t["type"], "enabled");
        assert_eq!(t["budget_tokens"], 24_576);

        // Baseline / unspecified preserves prior max_tokens/2 behaviour.
        let t = anthropic_thinking_param(ThinkingMode::AnthropicLegacyBudget, None, 8192).unwrap();
        assert_eq!(t["budget_tokens"], 4096);
    }

    #[test]
    fn none_level_disables_thinking() {
        for mode in [
            ThinkingMode::AnthropicAdaptive,
            ThinkingMode::Anthropic46,
            ThinkingMode::AnthropicLegacyBudget,
        ] {
            let t = anthropic_thinking_param(mode, Some(ReasoningLevel::None), 8192).unwrap();
            assert_eq!(t["type"], "disabled", "{mode:?} none → disabled");
        }
    }

    // ── OpenAI / Zhipu ──────────────────────────────────────────────────────

    #[test]
    fn openai_effort_preserves_extra_high_and_max() {
        assert_eq!(
            openai_effort(Some(ReasoningLevel::ExtraHigh)),
            Some("xhigh")
        );
        assert_eq!(openai_effort(Some(ReasoningLevel::Max)), Some("max"));
        assert_eq!(openai_effort(Some(ReasoningLevel::Ultra)), Some("max"));
        assert_eq!(openai_effort(Some(ReasoningLevel::High)), Some("high"));
        assert_eq!(openai_effort(Some(ReasoningLevel::Baseline)), None);
    }

    #[test]
    fn zhipu_only_toggles_no_budget() {
        assert_eq!(
            zhipu_thinking(Some(ReasoningLevel::High)).unwrap(),
            json!({"type":"enabled"})
        );
        assert_eq!(
            zhipu_thinking(Some(ReasoningLevel::None)).unwrap(),
            json!({"type":"disabled"})
        );
        // baseline / no selection → don't touch (model default)
        assert!(zhipu_thinking(Some(ReasoningLevel::Baseline)).is_none());
        assert!(zhipu_thinking(None).is_none());
    }

    // ── openai_compat assembly: model id → request fields ──────────────────

    #[test]
    fn openai_compat_glm_emits_thinking_toggle_not_effort() {
        let r = resolve_openai_compat_thinking("glm-5.2-high", provider_id::ZHIPU);
        assert_eq!(r.base_model, "glm-5.2");
        assert!(r.reasoning_effort.is_none());
        assert_eq!(r.thinking.unwrap(), json!({ "type": "enabled" }));
    }

    #[test]
    fn openai_compat_openai_emits_reasoning_effort_not_thinking() {
        let r = resolve_openai_compat_thinking("gpt-5.5-high", provider_id::OPENAI);
        assert_eq!(r.base_model, "gpt-5.5");
        assert_eq!(r.reasoning_effort.as_deref(), Some("high"));
        assert!(r.thinking.is_none());
    }

    #[test]
    fn openai_compat_preserves_gpt_5_6_upper_efforts() {
        for base in ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] {
            for effort in ["xhigh", "max"] {
                let r = resolve_openai_compat_thinking(
                    &format!("{base}-{effort}"),
                    provider_id::OPENAI,
                );
                assert_eq!(r.base_model, base);
                assert_eq!(r.reasoning_effort.as_deref(), Some(effort));
                assert!(r.thinking.is_none());
            }
        }
    }

    #[test]
    fn openai_compat_default_emits_neither() {
        // No level suffix → don't touch; model uses its provider default.
        let r = resolve_openai_compat_thinking("glm-5.2", provider_id::ZHIPU);
        assert_eq!(r.base_model, "glm-5.2");
        assert!(r.reasoning_effort.is_none());
        assert!(r.thinking.is_none());
    }

    #[test]
    fn openai_compat_preserves_native_suffix() {
        // `mini` is a provider-native suffix, not a level token → not stripped.
        let r = resolve_openai_compat_thinking("gpt-5.5-mini", provider_id::OPENAI);
        assert_eq!(r.base_model, "gpt-5.5-mini");
        assert!(r.reasoning_effort.is_none());
        assert!(r.thinking.is_none());
    }

    // ── Claude version detection: aliases, separators, date stamps ─────────

    #[test]
    fn detects_opus_47_across_aliases_separators_and_dates() {
        // Version separators: `-` and `.`.
        for id in &["claude-opus-4-7", "claude-opus-4.7", "claude-opus-4-8"] {
            assert!(is_claude_opus_47_or_newer(id), "{id} should be 4.7+");
        }
        // Provider alias prefixes / trailing version tags (Bedrock, Vertex).
        assert!(is_claude_opus_47_or_newer("anthropic.claude-opus-4-7-v1"));
        assert!(is_claude_opus_47_or_newer("claude-opus-4-7@001"));
        // 4.7 with a date stamp is still 4.7 (adaptive).
        assert!(is_claude_opus_47_or_newer("claude-opus-4-7-20250514"));
        // 4 base with a date stamp must NOT be read as 4.<date>.
        assert!(!is_claude_opus_47_or_newer("claude-opus-4-20250514"));
    }
}

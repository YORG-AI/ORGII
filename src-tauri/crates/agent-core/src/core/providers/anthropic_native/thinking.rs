//! Extended-thinking request parameters, driven by [`ThinkingMode`].
//!
//! Anthropic exposes thinking control through three mutually incompatible
//! shapes depending on model generation, so a single `thinking` object
//! cannot be correct for all of them. [`ThinkingMode`] (classified by
//! `thinking_mode::resolve_thinking_mode`) decides which:
//!
//! - **Adaptive** (Opus 4.7/4.8, Fable-5, Mythos): `thinking:{type:adaptive,
//!   display:summarized}` + top-level `effort`. Rejects `budget_tokens`
//!   (HTTP 400) and rejects `temperature`/`top_p`/`top_k` (also 400).
//! - **4.6** (opus-4.6 / sonnet-4.6): `thinking:{type:adaptive}` + `effort`
//!   (UI extra_high → API `max`).
//! - **Legacy** (Opus 4/4.1/4.5, Sonnet 4/4.5, 3.7): `thinking:{type:enabled,
//!   budget_tokens}`.
//!
//! This module only translates a resolved mode + the caller's
//! [`ThinkingDirective`] + selected [`ReasoningLevel`] into the Anthropic
//! request quad `(thinking, effort, temperature, max_tokens)`. Mode
//! classification and level→parameter mapping live in `thinking_mode`.

use serde_json::{json, Value};

use crate::providers::model_capabilities::{ModelCapabilities, ThinkingSupport};
use crate::providers::registry::provider_id;
use crate::providers::thinking_mode::{
    anthropic_effort, anthropic_max_tokens_floor, anthropic_thinking_param,
    is_claude_rejects_sampling, resolve_thinking_mode, ReasoningLevel, ThinkingMode,
};

/// What the caller wants from thinking, independent of what the model can do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThinkingDirective {
    /// Normal behavior: enable thinking when the model supports it.
    #[default]
    Auto,
    /// Caller needs plain text (side queries: summarization, extraction,
    /// classification). For adaptive/legacy models we send
    /// `{"type": "disabled"}`; for `AlwaysOn` models — which reject
    /// `disabled` with a 400 — we instead pad `max_tokens` so thinking
    /// can't exhaust the output budget before the answer is emitted.
    PlainText,
}

/// Headroom added to `max_tokens` for always-on-thinking models when the
/// caller wants plain text. claude_code observed 0–1114 thinking tokens on
/// classifier calls; 2048 gives comfortable margin.
const ALWAYS_ON_THINKING_PAD_TOKENS: u32 = 2048;

/// The Anthropic request quad produced by [`build_thinking_params`].
pub(super) struct ThinkingOutcome {
    pub thinking: Option<Value>,
    /// Effort value for adaptive/4.6 modes. The request builder nests it
    /// into `output_config.effort` (Claude Code OAuth rejects the legacy
    /// top-level `effort` field).
    pub effort: Option<String>,
    pub temperature: Option<f32>,
    pub max_tokens: u32,
}

/// Build the `(thinking, effort, temperature, max_tokens)` quad for one
/// Anthropic chat call.
///
/// `base_model` is the real model id (variant suffix already stripped by the
/// caller via `thinking_mode::parse_model_variant`) — it drives mode
/// classification and the sampling-rejection check. `level` is the
/// user-selected reasoning level decoded from the suffix (`None` when no
/// level was encoded).
pub(super) fn build_thinking_params(
    base_model: &str,
    level: Option<ReasoningLevel>,
    force_thinking: bool,
    directive: ThinkingDirective,
    caps: &ModelCapabilities,
    max_tokens: u32,
    temperature: f32,
) -> ThinkingOutcome {
    let mode = resolve_thinking_mode(base_model, provider_id::ANTHROPIC);

    // Non-thinking model: pass everything through unchanged.
    if caps.thinking == ThinkingSupport::No || mode == ThinkingMode::None {
        return ThinkingOutcome {
            thinking: None,
            effort: None,
            temperature: Some(temperature),
            max_tokens,
        };
    }

    let (thinking, effort, effective_max) = match directive {
        ThinkingDirective::PlainText => {
            // Side query wants plain text. How to suppress thinking depends
            // on the generation:
            //  - AlwaysOn adaptive (Fable/Mythos): `disabled` returns 400 and
            //    thinking is unconditional — pad the output budget instead.
            //  - Legacy (4.0/4.5/3.7): accept `{type:disabled}`.
            //  - Adaptive (4.6/4.7/4.8): thinking is OFF BY DEFAULT when no
            //    `thinking` field is sent, so omit it. Sending `{type:disabled}`
            //    is non-standard here (400s on Fable/Mythos).
            if caps.thinking == ThinkingSupport::AlwaysOn {
                (
                    None,
                    None,
                    max_tokens.saturating_add(ALWAYS_ON_THINKING_PAD_TOKENS),
                )
            } else if mode == ThinkingMode::AnthropicLegacyBudget {
                (Some(json!({ "type": "disabled" })), None, max_tokens)
            } else {
                (None, None, max_tokens)
            }
        }
        ThinkingDirective::Auto => {
            let thinking = if force_thinking {
                anthropic_thinking_param(mode, level, max_tokens)
            } else {
                None
            };
            let effort = anthropic_effort(mode, level).map(str::to_string);
            let floor = anthropic_max_tokens_floor(mode, level, max_tokens);
            // AlwaysOn adaptive (mythos): thinking is obligatory, make sure
            // the output budget has room even though we send no thinking param.
            let floor = if caps.thinking == ThinkingSupport::AlwaysOn
                && mode == ThinkingMode::AnthropicAdaptive
            {
                floor.max(ALWAYS_ON_THINKING_PAD_TOKENS + 1024)
            } else {
                floor
            };
            (thinking, effort, floor)
        }
    };

    // Temperature: 4.7+ rejects sampling params unconditionally (400);
    // otherwise omit when thinking is actually engaged and the model
    // requires it (Anthropic rejects enabled-thinking + temperature).
    let thinking_engaged = thinking
        .as_ref()
        .and_then(|t| t.get("type").and_then(|v| v.as_str()))
        .map(|ty| ty == "enabled" || ty == "adaptive")
        .unwrap_or(false);
    let temperature = if is_claude_rejects_sampling(base_model)
        || (thinking_engaged && caps.omit_temperature_with_thinking)
    {
        None
    } else {
        Some(temperature)
    };

    ThinkingOutcome {
        thinking,
        effort,
        temperature,
        max_tokens: effective_max,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(thinking: ThinkingSupport) -> ModelCapabilities {
        ModelCapabilities {
            context_window: 200_000,
            thinking,
            omit_temperature_with_thinking: true,
            text_only_wire: false,
        }
    }

    #[test]
    fn non_thinking_model_passes_through() {
        let o = build_thinking_params(
            "claude-3-5-haiku",
            None,
            true,
            ThinkingDirective::Auto,
            &caps(ThinkingSupport::No),
            4096,
            0.7,
        );
        assert!(o.thinking.is_none());
        assert!(o.effort.is_none());
        assert_eq!(o.temperature, Some(0.7));
        assert_eq!(o.max_tokens, 4096);
    }

    #[test]
    fn adaptive_emits_summarized_and_effort_without_budget() {
        let o = build_thinking_params(
            "claude-opus-4-8",
            Some(ReasoningLevel::High),
            true,
            ThinkingDirective::Auto,
            &caps(ThinkingSupport::Optional),
            8192,
            0.7,
        );
        let thinking = o.thinking.expect("adaptive sends thinking");
        assert_eq!(thinking["type"], "adaptive");
        assert_eq!(thinking["display"], "summarized");
        assert!(
            thinking.get("budget_tokens").is_none(),
            "budget_tokens would 400"
        );
        assert_eq!(o.effort.as_deref(), Some("high"));
        // 4.7+ rejects temperature unconditionally.
        assert!(o.temperature.is_none());
    }

    #[test]
    fn adaptive_effort_variant_without_thinking_omits_thinking_param() {
        let o = build_thinking_params(
            "claude-opus-4-8",
            Some(ReasoningLevel::High),
            false,
            ThinkingDirective::Auto,
            &caps(ThinkingSupport::Optional),
            8192,
            0.7,
        );
        assert!(o.thinking.is_none());
        assert_eq!(o.effort.as_deref(), Some("high"));
        assert!(o.temperature.is_none());
    }

    #[test]
    fn adaptive_baseline_sends_no_effort() {
        let o = build_thinking_params(
            "claude-opus-4-8",
            Some(ReasoningLevel::Baseline),
            true,
            ThinkingDirective::Auto,
            &caps(ThinkingSupport::Optional),
            8192,
            0.7,
        );
        assert_eq!(o.thinking.unwrap()["type"], "adaptive");
        assert!(o.effort.is_none());
    }

    #[test]
    fn claude46_maps_extra_high_to_max_effort() {
        let o = build_thinking_params(
            "claude-opus-4-6",
            Some(ReasoningLevel::ExtraHigh),
            true,
            ThinkingDirective::Auto,
            &caps(ThinkingSupport::Optional),
            8192,
            0.7,
        );
        assert_eq!(o.thinking.unwrap()["type"], "adaptive");
        assert_eq!(o.effort.as_deref(), Some("max"));
    }

    #[test]
    fn legacy_budget_uses_level_and_omits_temperature_when_engaged() {
        let o = build_thinking_params(
            "claude-opus-4-5",
            Some(ReasoningLevel::High),
            true,
            ThinkingDirective::Auto,
            &caps(ThinkingSupport::Optional),
            8192,
            0.7,
        );
        let thinking = o.thinking.unwrap();
        assert_eq!(thinking["type"], "enabled");
        assert_eq!(thinking["budget_tokens"], 24_576);
        assert!(o.effort.is_none());
        // thinking engaged + omit_temperature_with_thinking → None
        assert!(o.temperature.is_none());
        // floor ensures budget + 1024 room
        assert!(o.max_tokens >= 24_576 + 1024);
    }

    #[test]
    fn legacy_baseline_preserves_half_max_tokens_budget() {
        let o = build_thinking_params(
            "claude-opus-4-5",
            None,
            true,
            ThinkingDirective::Auto,
            &caps(ThinkingSupport::Optional),
            8192,
            0.7,
        );
        assert_eq!(o.thinking.unwrap()["budget_tokens"], 4096);
    }

    #[test]
    fn plain_text_disables_thinking_on_optional_and_keeps_temperature() {
        let o = build_thinking_params(
            "claude-opus-4-5",
            None,
            true,
            ThinkingDirective::PlainText,
            &caps(ThinkingSupport::Optional),
            1024,
            0.5,
        );
        assert_eq!(o.thinking.unwrap()["type"], "disabled");
        // thinking not engaged → temperature retained (not 4.7+)
        assert_eq!(o.temperature, Some(0.5));
    }

    #[test]
    fn plain_text_on_alwayson_pads_and_omits_temperature_for_mythos() {
        let o = build_thinking_params(
            "claude-mythos",
            None,
            true,
            ThinkingDirective::PlainText,
            &caps(ThinkingSupport::AlwaysOn),
            1024,
            0.5,
        );
        // Must NOT send disabled (would 400).
        assert!(o.thinking.is_none());
        assert!(o.max_tokens > 1024);
        // mythos is adaptive-line → rejects sampling.
        assert!(o.temperature.is_none());
    }

    #[test]
    fn plain_text_on_adaptive_omits_thinking_and_temperature() {
        let o = build_thinking_params(
            "claude-opus-4-8",
            Some(ReasoningLevel::High),
            true,
            ThinkingDirective::PlainText,
            &caps(ThinkingSupport::Optional),
            1024,
            0.5,
        );
        // Adaptive (4.7/4.8): thinking is off by default when no `thinking`
        // field is sent — omit rather than sending `{type:disabled}`, which
        // is non-standard (400s on Fable/Mythos).
        assert!(o.thinking.is_none());
        // 4.7+ rejects sampling regardless of the thinking state.
        assert!(o.temperature.is_none());
    }
}

//! Single source of truth for per-model capability resolution.
//!
//! Replaces the two parallel substring-match tables that previously lived in
//! `anthropic_native/thinking.rs` (thinking support) and `model_hints.rs`
//! (context windows). Every capability question — "does this model think?",
//! "how big is its context window?", "can I send temperature together with
//! thinking?" — must go through [`resolve`].
//!
//! # Resolution chain
//!
//! 1. **KeyVault** (`KEY_SERVICE`): the user's own model registry. A
//!    `ModelVariant { reasoning: Some(_) }` row for this model means the
//!    user (or the behavioral-observation writeback in `side_query.rs`)
//!    has marked it as a reasoning model.
//! 2. **Built-in family table** ([`FAMILY_RULES`]): declarative, one row
//!    per model family. The ONLY place family substring patterns live.
//! 3. **Conservative defaults**: unknown models get a 200K window and
//!    `ThinkingSupport::Optional` — "works, maybe suboptimally" instead
//!    of "fails loudly when the guess is wrong".
//!
//! @[MODEL LAUNCH]: when a new model family ships, add ONE row to
//! [`FAMILY_RULES`]. Do not add model-family substring checks (`.contains`/
//! `.starts_with` on `gpt-`, `claude`, `gemini`, …) anywhere else.
//!
//! The `no_substring_capability_checks_outside_this_module` test (in
//! `tests/model_capabilities_tests.rs`) is the enforcement point: it scans
//! the crate source and fails if a *new* module introduces such a check.
//!
//! A handful of pre-existing matchers are NOT yet routed through [`resolve`]
//! and are tracked in that test's `CAPABILITY_CHECK_ALLOWLIST` (vision,
//! tokenizer family, knowledge-cutoff, and reasoning-param detection — see
//! the 2026-06-13 architecture audit S2 — plus the legacy provider-routing
//! table in `model_hints`). Migrating one of those into [`ModelCapabilities`]
//! should delete its allowlist entry, tightening the ratchet.

use std::collections::HashSet;
use std::sync::RwLock;

use key_vault::key_store::{ModelVariant, KEY_SERVICE};

/// Process-level set of models observed to REJECT the `temperature` request
/// param outright (Anthropic's newer models — e.g. `claude-opus-4-8` — return
/// HTTP 400 `temperature is deprecated for this model`).
///
/// This is a self-healing learning cache: the first request that trips the
/// 400 records the wire model id here, and every subsequent `prepare_request`
/// for that model omits `temperature` entirely. No KeyVault schema change is
/// needed because the fact is provider-deterministic (true for every account
/// that touches the model) and cheap to relearn after a restart.
///
/// Keyed by the wire model id (post `wire_model_name` normalization) so the
/// lookup in `prepare_request` matches exactly what gets sent on the wire.
static TEMPERATURE_UNSUPPORTED: RwLock<Option<HashSet<String>>> = RwLock::new(None);

/// Returns true when `wire_model` has been observed to reject `temperature`.
pub fn temperature_unsupported(wire_model: &str) -> bool {
    TEMPERATURE_UNSUPPORTED
        .read()
        .ok()
        .and_then(|guard| guard.as_ref().map(|set| set.contains(wire_model)))
        .unwrap_or(false)
}

/// Record that `wire_model` rejected the `temperature` param. Idempotent.
/// Returns true if this was a newly-learned fact (first observation).
pub fn mark_temperature_unsupported(wire_model: &str) -> bool {
    if temperature_unsupported(wire_model) {
        return false;
    }
    if let Ok(mut guard) = TEMPERATURE_UNSUPPORTED.write() {
        return guard
            .get_or_insert_with(HashSet::new)
            .insert(wire_model.to_string());
    }
    false
}

/// How a model handles extended thinking / reasoning output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingSupport {
    /// Model never emits thinking blocks; sending a `thinking` request
    /// param would be rejected.
    No,
    /// Model supports thinking and accepts `{"type": "disabled"}` to turn
    /// it off (Claude 3.7 / 4 family behavior).
    Optional,
    /// Model thinks unconditionally server-side and REJECTS
    /// `{"type": "disabled"}` with a 400. Callers that need plain text
    /// must pad `max_tokens` instead (claude_code yoloClassifier lesson:
    /// observed 0–1114 thinking tokens before the answer).
    AlwaysOn,
}

/// Resolved capabilities for one model id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelCapabilities {
    pub context_window: usize,
    pub thinking: ThinkingSupport,
    /// When true, requests that enable thinking must omit `temperature`
    /// (Anthropic rejects sending both).
    pub omit_temperature_with_thinking: bool,
}

impl ModelCapabilities {
    /// Conservative profile for models nothing knows about: assume
    /// thinking-capable (never breaks a non-thinking model) and a 200K
    /// window (common modern reasoning-model size).
    pub const fn unknown() -> Self {
        Self {
            context_window: 200_000,
            thinking: ThinkingSupport::Optional,
            omit_temperature_with_thinking: true,
        }
    }
}

/// One declarative row: any model id containing `pattern` (after claude
/// shorthand normalization + lowercasing) gets these capabilities.
/// First match wins — order from most to least specific.
struct FamilyRule {
    pattern: &'static str,
    context_window: usize,
    thinking: ThinkingSupport,
}

/// @[MODEL LAUNCH] checklist:
/// 1. Add the family row here (pattern is matched with `contains` on the
///    lowercased, shorthand-normalized model id).
/// 2. If the model always thinks and rejects `thinking: disabled`, use
///    `AlwaysOn` — side queries will pad max_tokens instead.
/// 3. Nothing else. Tests pin that no other module does substring checks.
const FAMILY_RULES: &[FamilyRule] = &[
    // ── Anthropic ──
    // claude-fable-5: thinks by default in non-streaming responses
    // (2026-06-12 incident: thinking-only side-query responses broke
    // compaction + session-memory extraction).
    // claude-fable-5: 1M context window (Anthropic official docs).
    FamilyRule {
        pattern: "claude-fable-5",
        context_window: 1_000_000,
        thinking: ThinkingSupport::AlwaysOn,
    },
    // Known claude-opus-4.6/4.7/4.8 releases upgraded to 1M; 4 / 4.1 /
    // 4.5 stayed at 200K. Add future releases explicitly.
    FamilyRule {
        pattern: "claude-opus-4.6",
        context_window: 1_000_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "claude-opus-4.7",
        context_window: 1_000_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "claude-opus-4.8",
        context_window: 1_000_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "claude-opus-4",
        context_window: 200_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "claude-sonnet-5",
        context_window: 1_000_000,
        thinking: ThinkingSupport::Optional,
    },
    // claude-sonnet-4.5: 200K. Must come BEFORE claude-sonnet-4 so the more
    // specific pattern wins.
    FamilyRule {
        pattern: "claude-sonnet-4.5",
        context_window: 200_000,
        thinking: ThinkingSupport::Optional,
    },
    // claude-sonnet-4-5 hyphen variant (same model, 200K).
    FamilyRule {
        pattern: "claude-sonnet-4-5",
        context_window: 200_000,
        thinking: ThinkingSupport::Optional,
    },
    // claude-sonnet-4.6: 1M context window. Must come BEFORE claude-sonnet-4
    // so it beats the base pattern. Add future releases explicitly.
    FamilyRule {
        pattern: "claude-sonnet-4.6",
        context_window: 1_000_000,
        thinking: ThinkingSupport::Optional,
    },
    // claude-sonnet-4-6 hyphen variant (1M).
    FamilyRule {
        pattern: "claude-sonnet-4-6",
        context_window: 1_000_000,
        thinking: ThinkingSupport::Optional,
    },
    // claude-sonnet-4 base (original 20250514 release, 200K).
    FamilyRule {
        pattern: "claude-sonnet-4",
        context_window: 200_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "claude-haiku-4-5",
        context_window: 200_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "claude-haiku-4",
        context_window: 200_000,
        thinking: ThinkingSupport::Optional,
    },
    // claude-mythos (Mythos Preview / Mythos 5): 1M, always-on thinking.
    FamilyRule {
        pattern: "claude-mythos",
        context_window: 1_000_000,
        thinking: ThinkingSupport::AlwaysOn,
    },
    FamilyRule {
        pattern: "claude-3-7",
        context_window: 200_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "claude-3-5",
        context_window: 200_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "claude-3-opus",
        context_window: 200_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "claude-3-haiku",
        context_window: 200_000,
        thinking: ThinkingSupport::No,
    },
    // Unknown claude generations (claude-5, claude-6 …): 1M context
    // window (all new Anthropic models ship with 1M) and assume always-on
    // thinking — newer Anthropic models default to it, and AlwaysOn is the
    // safe guess (Optional would send `disabled` and risk a 400).
    FamilyRule {
        pattern: "claude",
        context_window: 1_000_000,
        thinking: ThinkingSupport::AlwaysOn,
    },
    // ── OpenAI ──
    FamilyRule {
        pattern: "gpt-5.6",
        context_window: 1_050_000,
        thinking: ThinkingSupport::AlwaysOn,
    },
    FamilyRule {
        pattern: "gpt-5.5",
        context_window: 1_050_000,
        thinking: ThinkingSupport::AlwaysOn,
    },
    FamilyRule {
        pattern: "gpt-5",
        context_window: 1_000_000,
        thinking: ThinkingSupport::AlwaysOn,
    },
    FamilyRule {
        pattern: "gpt-4.1",
        context_window: 1_000_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "o3",
        context_window: 200_000,
        thinking: ThinkingSupport::AlwaysOn,
    },
    FamilyRule {
        pattern: "o4",
        context_window: 200_000,
        thinking: ThinkingSupport::AlwaysOn,
    },
    FamilyRule {
        pattern: "o1",
        context_window: 200_000,
        thinking: ThinkingSupport::AlwaysOn,
    },
    FamilyRule {
        pattern: "gpt-4o",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "gpt-4-turbo",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "gpt-4",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "gpt",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    // ── Google ──
    FamilyRule {
        pattern: "gemini-2",
        context_window: 1_000_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "gemini-1.5",
        context_window: 1_000_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "gemini",
        context_window: 1_000_000,
        thinking: ThinkingSupport::Optional,
    },
    // ── DeepSeek ──
    FamilyRule {
        pattern: "deepseek-v4",
        context_window: 1_000_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "deepseek-r1",
        context_window: 128_000,
        thinking: ThinkingSupport::AlwaysOn,
    },
    FamilyRule {
        pattern: "deepseek-v3",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "deepseek-coder",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "deepseek-chat",
        context_window: 1_000_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "deepseek-reasoner",
        context_window: 1_000_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "deepseek",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    // ── Alibaba / Moonshot / Zhipu ──
    FamilyRule {
        pattern: "qwen3-coder",
        context_window: 256_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "qwen3-coder-next",
        context_window: 256_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "qwen3",
        context_window: 128_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "qwen2.5-coder",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "qwen2.5",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "qwen-max",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "qwen-plus",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "qwen-turbo",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "qwen",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "kimi",
        context_window: 256_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "moonshot-v1-128k",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "moonshot-v1-32k",
        context_window: 32_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "moonshot-v1-8k",
        context_window: 8_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "moonshot",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    // glm-5.2: 1M context window — only the 5.2 release reached 1M;
    // 5 / 5.1 / 5-turbo stay at 200K. Must come BEFORE glm-5.
    FamilyRule {
        pattern: "glm-5.2",
        context_window: 1_000_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "glm-5",
        context_window: 200_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "glm-4.6",
        context_window: 200_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "glm-4.5",
        context_window: 128_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "glm-4",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "glm",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    // ── Meta / xAI / Mistral ──
    FamilyRule {
        pattern: "llama-4-scout",
        context_window: 10_000_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "llama-4-maverick",
        context_window: 1_000_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "llama-4",
        context_window: 1_000_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "llama-3.3",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "llama-3.2",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "llama-3.1",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "llama-3",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "llama",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "grok-build",
        context_window: 256_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "grok-4.3",
        context_window: 1_000_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "grok-4",
        context_window: 256_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "grok-3",
        context_window: 128_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "grok",
        context_window: 128_000,
        thinking: ThinkingSupport::Optional,
    },
    FamilyRule {
        pattern: "codestral",
        context_window: 256_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "mistral-large",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "mistral-medium",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "mistral-small",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "mistral",
        context_window: 128_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "mixtral-8x22b",
        context_window: 65_000,
        thinking: ThinkingSupport::No,
    },
    FamilyRule {
        pattern: "mixtral",
        context_window: 32_000,
        thinking: ThinkingSupport::No,
    },
];

/// Resolve capabilities for `model`, optionally consulting the KeyVault
/// entry for `account_id`.
///
/// Resolution chain for the context window:
/// 1. **Static family table** ([`FAMILY_RULES`]) — the model's nominal
///    capability (e.g. opus-4.6 = 1M).
/// 2. **KeyVault override** — if the provider's `/v1/models` reported a
///    `context_length` for this model on this account (stored as
///    `ModelVariant.context_window`), it overrides the static value. This is
///    what makes a proxy that caps a 1M model at 256K show the *real* limit
///    instead of the nominal one. Absent (official OpenAI/Anthropic, which
///    don't expose `context_length`) → keep the static value.
///
/// Thinking support is upgraded only (a KeyVault `reasoning` row beats the
/// family guess); context window can be either raised or lowered by the
/// provider override.
pub fn resolve(model: &str, account_id: Option<&str>) -> ModelCapabilities {
    let mut caps = resolve_from_family_table(model);

    if let Some(account_id) = account_id {
        if let Some(key) = KEY_SERVICE.get_key_by_id(account_id) {
            apply_keyvault_overrides(&mut caps, model, &key.model_variants);
        }
    }

    caps
}

/// Resolve the context window while preserving an explicitly configured agent
/// override. `None` means "auto"; in that mode account-specific provider caps
/// from KeyVault beat the static family table.
pub fn resolve_effective_context_window(
    model: &str,
    account_id: Option<&str>,
    explicit_context_window: Option<u64>,
) -> usize {
    explicit_context_window
        .filter(|ctx| *ctx > 0)
        .map(|ctx| ctx as usize)
        .unwrap_or_else(|| resolve(model, account_id).context_window)
}

fn apply_keyvault_overrides(caps: &mut ModelCapabilities, model: &str, variants: &[ModelVariant]) {
    let Some(variant) = variants.iter().find(|v| v.model == model) else {
        return;
    };

    if let Some(ctx) = variant.context_window.filter(|ctx| *ctx > 0) {
        caps.context_window = ctx as usize;
    }

    if let Some(vault_thinking) = resolve_thinking_from_variant(variant) {
        caps.thinking = vault_thinking;
    }
}

#[cfg(test)]
fn resolve_with_keyvault_variants(model: &str, variants: &[ModelVariant]) -> ModelCapabilities {
    let mut caps = resolve_from_family_table(model);
    apply_keyvault_overrides(&mut caps, model, variants);
    caps
}

fn resolve_from_family_table(model: &str) -> ModelCapabilities {
    let normalized = super::model_hints::normalize_claude_shorthand(model);
    let model_lower = normalize_claude_release_separators(&normalized.to_lowercase());
    for rule in FAMILY_RULES {
        if model_lower.contains(rule.pattern) {
            return ModelCapabilities {
                context_window: rule.context_window,
                thinking: rule.thinking,
                omit_temperature_with_thinking: true,
            };
        }
    }
    ModelCapabilities::unknown()
}

fn normalize_claude_release_separators(model: &str) -> String {
    const ALIASES: &[(&str, &str)] = &[
        ("claude-opus-4-6", "claude-opus-4.6"),
        ("claude-opus-4-7", "claude-opus-4.7"),
        ("claude-opus-4-8", "claude-opus-4.8"),
        ("claude-sonnet-4-5", "claude-sonnet-4.5"),
        ("claude-sonnet-4-6", "claude-sonnet-4.6"),
    ];

    let mut normalized = model.to_string();
    for (from, to) in ALIASES {
        normalized = normalized.replace(from, to);
    }
    normalized
}

/// KeyVault layer: a `ModelVariant` row with `reasoning: Some(..)` marks
/// the model as a reasoning model for this account. The writeback in
/// `side_query.rs` uses the value `"always_on"` to record observed
/// always-on behavior; any other non-empty value means Optional.
fn resolve_thinking_from_variant(variant: &ModelVariant) -> Option<ThinkingSupport> {
    let reasoning = variant.reasoning.as_deref()?;
    if reasoning.is_empty() {
        return None;
    }
    Some(if reasoning == OBSERVED_ALWAYS_ON_REASONING {
        ThinkingSupport::AlwaysOn
    } else {
        ThinkingSupport::Optional
    })
}

/// `ModelVariant.reasoning` value written by behavioral observation when a
/// model is seen thinking despite a `disabled` request (or rejects
/// `disabled` with a 400). Shared with `key_vault`'s writeback API.
pub const OBSERVED_ALWAYS_ON_REASONING: &str = "always_on";

/// Coarse model family for thinking-mode classification.
///
/// This is the designated home for model-family prefix matching outside
/// `FAMILY_RULES`: patterns are matched through the `FAMILY_TABLE` variable
/// (`.contains(pat)`), never a family literal, so the
/// `no_substring_capability_checks_outside_this_module` test stays green.
/// Other modules (`thinking_mode`) route family-derived behavior through
/// this function instead of re-doing their own substring checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelFamily {
    Anthropic,
    OpenAi,
    Zhipu,
    Other,
}

const FAMILY_TABLE: &[(&str, ModelFamily)] = &[
    ("claude", ModelFamily::Anthropic),
    ("glm", ModelFamily::Zhipu),
    ("gpt-5", ModelFamily::OpenAi),
    ("o1", ModelFamily::OpenAi),
    ("o3", ModelFamily::OpenAi),
    ("o4", ModelFamily::OpenAi),
];

/// Classify a model id into a coarse family. The provider name breaks ties
/// when the id carries no known family prefix (e.g. a custom alias routed
/// through a specific provider).
pub fn classify_family(base_model: &str, provider_name: &str) -> ModelFamily {
    let id = base_model.to_lowercase();
    for (pat, fam) in FAMILY_TABLE {
        if id.contains(pat) {
            return *fam;
        }
    }
    match provider_name {
        crate::providers::registry::provider_id::ANTHROPIC => ModelFamily::Anthropic,
        crate::providers::registry::provider_id::ZHIPU => ModelFamily::Zhipu,
        crate::providers::registry::provider_id::OPENAI => ModelFamily::OpenAi,
        _ => ModelFamily::Other,
    }
}

#[cfg(test)]
#[path = "tests/model_capabilities_tests.rs"]
mod tests;

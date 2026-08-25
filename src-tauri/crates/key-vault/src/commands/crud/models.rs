use super::{DefaultVariantInfo, ModelVariantInfo};
use crate::key_store::{
    is_official_anthropic_endpoint, AuthMethod, ModelKey, ModelType, ModelVariant,
};
use crate::types::DiscoveredModel;

fn has_non_empty_secret(value: &Option<String>) -> bool {
    value
        .as_deref()
        .is_some_and(|secret| !secret.trim().is_empty())
}

fn account_uses_anthropic_native_messages(entry: &ModelKey) -> bool {
    match entry.model_type {
        // Azure-hosted Anthropic gateway: the Azure base URL is mandatory and
        // first-party, not a relay.
        ModelType::AzureAnthropicApi => true,
        ModelType::AnthropicApi => is_official_anthropic_endpoint(entry.base_url.as_deref()),
        ModelType::ClaudeCode => {
            entry.auth_method == AuthMethod::Oauth
                && has_non_empty_secret(&entry.session_token)
                && is_official_anthropic_endpoint(entry.base_url.as_deref())
        }
        // Third-party providers that merely speak the Anthropic protocol
        // (relays, Anthropic-compatible vendors) never get synthesized effort
        // variants — effort support is only guaranteed on official endpoints.
        _ => false,
    }
}

pub const CLAUDE_CODE_OAUTH_MODELS: &[&str] = &[
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5-20250929",
];

pub const CLAUDE_CODE_OAUTH_DEFAULT_ENABLED_MODELS: &[&str] = &[
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
];

pub const CODEX_OAUTH_MODELS: &[&str] = &[
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.2",
    "codex-auto-review",
];

pub const CODEX_OAUTH_DEFAULT_ENABLED_MODELS: &[&str] =
    &["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

/// Claude models whose Messages requests carry `output_config.effort`.
pub fn model_supports_output_config_effort(model: &str) -> bool {
    let lower = model.to_lowercase();
    if !lower.starts_with("claude-") || lower.contains("haiku") {
        return false;
    }
    lower.contains("fable-5")
        || lower.contains("mythos-5")
        || lower.contains("opus-5")
        || lower.contains("opus-4-8")
        || lower.contains("opus-4-7")
        || lower.contains("opus-4-6")
        || lower.contains("sonnet-5")
        || lower.contains("sonnet-4-6")
}

fn claude_model_has_thinking_toggle(model: &str) -> bool {
    let lower = model.to_lowercase();
    lower.contains("opus-4-8") || lower.contains("sonnet-")
}

/// A "real" selectable effort rung, as opposed to a bare record row
/// (`model == base_model` with no recognized reasoning level) produced by the
/// context-window / observed-reasoning writebacks in `key_store::service`.
fn is_actionable_variant(variant: &ModelVariant) -> bool {
    variant.model != variant.base_model
        || variant.fast
        || matches!(
            variant.reasoning.as_deref(),
            Some(
                "baseline"
                    | "low"
                    | "medium"
                    | "high"
                    | "extra_high"
                    | "xhigh"
                    | "ultra"
                    | "max"
                    | "ultracode",
            )
        )
}

const ANTHROPIC_EFFORT_RUNGS: &[(&str, &str)] = &[
    ("low", "low"),
    ("medium", "medium"),
    ("high", "high"),
    ("xhigh", "extra_high"),
    ("max", "max"),
];

const FABLE_EFFORT_RUNGS: &[(&str, &str)] = &[
    ("low", "low"),
    ("medium", "medium"),
    ("high", "high"),
    ("xhigh", "extra_high"),
    ("max", "max"),
    ("ultracode", "ultracode"),
];

fn effort_variants_for_base_model(
    base_model: &str,
    context_window: Option<u64>,
) -> Vec<ModelVariantInfo> {
    let mut variants = Vec::new();
    let has_thinking_toggle = claude_model_has_thinking_toggle(base_model);
    let lower = base_model.to_lowercase();
    let rungs = if lower.contains("fable-5") {
        FABLE_EFFORT_RUNGS
    } else {
        ANTHROPIC_EFFORT_RUNGS
    };
    for (suffix, reasoning) in rungs {
        variants.push(ModelVariantInfo {
            model: format!("{base_model}-{suffix}"),
            base_model: base_model.to_string(),
            reasoning: Some((*reasoning).to_string()),
            fast: false,
            context_window,
        });
        if has_thinking_toggle {
            variants.push(ModelVariantInfo {
                model: format!("{base_model}-thinking-{suffix}"),
                base_model: base_model.to_string(),
                reasoning: Some((*reasoning).to_string()),
                fast: false,
                context_window,
            });
        }
    }
    variants
}

fn codex_model_supports_variants(model: &str) -> bool {
    CODEX_OAUTH_MODELS.contains(&model) && model != "codex-auto-review"
}

fn codex_model_supports_fast_tier(model: &str) -> bool {
    matches!(
        model,
        "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna" | "gpt-5.5" | "gpt-5.4"
    )
}

fn codex_model_supports_ultra_tier(model: &str) -> bool {
    matches!(model, "gpt-5.6-sol" | "gpt-5.6-terra")
}

fn codex_effort_variants_for_base_model(base_model: &str) -> Vec<ModelVariantInfo> {
    let mut out = Vec::new();
    let supports_fast = codex_model_supports_fast_tier(base_model);
    let mut efforts = vec!["low", "medium", "high", "xhigh"];
    if codex_model_supports_ultra_tier(base_model) {
        efforts.push("ultra");
    }
    for effort in efforts {
        out.push(ModelVariantInfo {
            model: format!("{base_model}-{effort}"),
            base_model: base_model.to_string(),
            reasoning: Some(effort.to_string()),
            fast: false,
            context_window: None,
        });
        if supports_fast {
            out.push(ModelVariantInfo {
                model: format!("{base_model}-{effort}-fast"),
                base_model: base_model.to_string(),
                reasoning: Some(effort.to_string()),
                fast: true,
                context_window: None,
            });
        }
    }
    out
}

fn discovered_codex_variants(model: &DiscoveredModel) -> Vec<ModelVariantInfo> {
    if model.supported_efforts.is_empty() {
        return codex_effort_variants_for_base_model(&model.id);
    }

    let supports_fast = codex_model_supports_fast_tier(&model.id);
    let mut out = Vec::new();
    for effort in &model.supported_efforts {
        if !matches!(
            effort.as_str(),
            "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
        ) {
            continue;
        }
        if effort == "none" {
            continue;
        }
        out.push(ModelVariantInfo {
            model: format!("{}-{effort}", model.id),
            base_model: model.id.clone(),
            reasoning: Some(effort.clone()),
            fast: false,
            context_window: model.context_window,
        });
        if supports_fast {
            out.push(ModelVariantInfo {
                model: format!("{}-{effort}-fast", model.id),
                base_model: model.id.clone(),
                reasoning: Some(effort.clone()),
                fast: true,
                context_window: model.context_window,
            });
        }
    }
    out
}

fn discovered_anthropic_variants(model: &DiscoveredModel) -> Vec<ModelVariantInfo> {
    if model.supported_efforts.is_empty() {
        return effort_variants_for_base_model(&model.id, model.context_window);
    }

    let has_thinking_toggle = model.supports_manual_thinking;
    let mut variants = Vec::new();
    for effort in &model.supported_efforts {
        if !matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh" | "max") {
            continue;
        }
        let reasoning = if effort == "xhigh" {
            "extra_high".to_string()
        } else {
            effort.clone()
        };
        variants.push(ModelVariantInfo {
            model: format!("{}-{effort}", model.id),
            base_model: model.id.clone(),
            reasoning: Some(reasoning.clone()),
            fast: false,
            context_window: model.context_window,
        });
        if has_thinking_toggle {
            variants.push(ModelVariantInfo {
                model: format!("{}-thinking-{effort}", model.id),
                base_model: model.id.clone(),
                reasoning: Some(reasoning),
                fast: false,
                context_window: model.context_window,
            });
        }
    }
    variants
}

/// Produce the exact variant/default metadata rendered in the OAuth wizard
/// and later returned for the saved account. Live capability metadata wins;
/// the family tables supply metadata for the baked fallback catalog and for
/// built-in Codex bases completed onto version-limited live discovery.
pub(in crate::commands) fn oauth_model_metadata(
    agent_type: &str,
    models: &[DiscoveredModel],
) -> (Vec<ModelVariantInfo>, Vec<DefaultVariantInfo>) {
    let mut variants = Vec::new();
    let mut defaults = Vec::new();

    for model in models {
        let (model_variants, fallback_effort) = match agent_type {
            "codex"
                if !model.supported_efforts.is_empty()
                    || codex_model_supports_variants(&model.id) =>
            {
                (discovered_codex_variants(model), Some("medium"))
            }
            "claude_code"
                if !model.supported_efforts.is_empty()
                    || model_supports_output_config_effort(&model.id) =>
            {
                (discovered_anthropic_variants(model), Some("high"))
            }
            _ => (Vec::new(), None),
        };
        append_missing_variants(&mut variants, model_variants);

        let Some(fallback_effort) = fallback_effort else {
            continue;
        };
        let effort = model.default_effort.as_deref().unwrap_or(fallback_effort);
        let variant_id = if effort == "none" {
            model.id.clone()
        } else {
            format!("{}-{effort}", model.id)
        };
        if variants.iter().any(|variant| variant.model == variant_id) {
            defaults.push(DefaultVariantInfo {
                base_model: model.id.clone(),
                model: variant_id,
            });
        }
    }

    (variants, defaults)
}

/// GLM (Zhipu) models that expose a thinking-effort ladder (High / Max on top
/// of the bare Baseline row). Only GLM 5.2 and newer 5.x lines qualify — GLM 5.1
/// and older have no effort ladder. Distinct sub-models (e.g. `glm-5-turbo`) are
/// excluded because their id carries a non-numeric tier segment.
fn glm_model_supports_variants(model: &str) -> bool {
    let lower = model.to_lowercase();
    let Some(rest) = lower.strip_prefix("glm-5.") else {
        return false;
    };
    // `rest` must be a pure minor version (e.g. "2", "3") — reject anything with
    // a further `-tier` segment like `glm-5.2-air`.
    rest.parse::<u32>().map(|minor| minor >= 2).unwrap_or(false)
}

/// GLM effort ladder: `High` and `Max` synthesized on top of the bare Baseline
/// model row. Zhipu recommends `Max` for coding, which drives the default in
/// [`default_variants_for_key`].
fn glm_effort_variants_for_base_model(base_model: &str) -> Vec<ModelVariantInfo> {
    ["high", "max"]
        .into_iter()
        .map(|effort| ModelVariantInfo {
            model: format!("{base_model}-{effort}"),
            base_model: base_model.to_string(),
            reasoning: Some(effort.to_string()),
            fast: false,
            context_window: None,
        })
        .collect()
}

fn append_missing_variants(out: &mut Vec<ModelVariantInfo>, variants: Vec<ModelVariantInfo>) {
    for synthesized in variants {
        if out.iter().any(|variant| variant.model == synthesized.model) {
            continue;
        }
        out.push(synthesized);
    }
}

pub(super) fn default_variants_for_key(entry: &ModelKey) -> Vec<DefaultVariantInfo> {
    let mut out: Vec<DefaultVariantInfo> = entry
        .default_variants
        .iter()
        .map(|variant| DefaultVariantInfo {
            base_model: variant.base_model.clone(),
            model: variant.model.clone(),
        })
        .collect();

    if matches!(entry.model_type, ModelType::Codex) {
        for model in entry
            .available_models
            .iter()
            .filter(|model| codex_model_supports_variants(model))
        {
            if out.iter().any(|variant| variant.base_model == *model) {
                continue;
            }
            out.push(DefaultVariantInfo {
                base_model: model.clone(),
                model: format!("{model}-medium"),
            });
        }
    }

    // GLM 5.2+ defaults to Max effort (Zhipu recommends Max for coding).
    for model in entry
        .available_models
        .iter()
        .filter(|model| glm_model_supports_variants(model))
    {
        if out.iter().any(|variant| variant.base_model == *model) {
            continue;
        }
        out.push(DefaultVariantInfo {
            base_model: model.clone(),
            model: format!("{model}-max"),
        });
    }

    if account_uses_anthropic_native_messages(entry) {
        for model in entry
            .available_models
            .iter()
            .filter(|model| model_supports_output_config_effort(model))
        {
            if out.iter().any(|variant| variant.base_model == *model) {
                continue;
            }
            out.push(DefaultVariantInfo {
                base_model: model.clone(),
                model: format!("{model}-high"),
            });
        }
    }

    out
}

pub(super) fn model_variants_for_key(entry: &ModelKey) -> Vec<ModelVariantInfo> {
    // Every stored variant passes through untouched, for every account type:
    // bare record rows (`model == base_model`) carry provider-reported
    // context windows that the frontend context-usage display reads.
    let mut out: Vec<ModelVariantInfo> = entry
        .model_variants
        .iter()
        .map(|variant| ModelVariantInfo {
            model: variant.model.clone(),
            base_model: variant.base_model.clone(),
            reasoning: variant.reasoning.clone(),
            fast: variant.fast,
            context_window: variant.context_window.filter(|ctx| *ctx > 0),
        })
        .collect();

    if matches!(entry.model_type, ModelType::Codex) {
        for model in entry
            .available_models
            .iter()
            .filter(|model| codex_model_supports_variants(model))
        {
            if entry
                .model_variants
                .iter()
                .any(|variant| variant.base_model == *model && is_actionable_variant(variant))
            {
                continue;
            }
            append_missing_variants(&mut out, codex_effort_variants_for_base_model(model));
        }
    }

    // GLM (Zhipu) 5.2+ effort ladder (High / Max). Not gated on ModelType —
    // Zhipu accounts are OpenAI-compatible API keys, matched by model id. Skip
    // any model that already carries a real ladder from the provider/user.
    for model in entry
        .available_models
        .iter()
        .filter(|model| glm_model_supports_variants(model))
    {
        if entry
            .model_variants
            .iter()
            .any(|variant| variant.base_model == *model && is_actionable_variant(variant))
        {
            continue;
        }
        append_missing_variants(&mut out, glm_effort_variants_for_base_model(model));
    }

    if !account_uses_anthropic_native_messages(entry) {
        return out;
    }

    for model in entry
        .available_models
        .iter()
        .filter(|model| model_supports_output_config_effort(model))
    {
        // A real effort ladder already exists (user- or sync-created) —
        // don't synthesize a duplicate. Bare record rows don't count.
        if entry
            .model_variants
            .iter()
            .any(|variant| variant.base_model == *model && is_actionable_variant(variant))
        {
            continue;
        }
        let context_window = entry
            .model_variants
            .iter()
            .find(|variant| variant.base_model == *model || variant.model == *model)
            .and_then(|variant| variant.context_window)
            .filter(|ctx| *ctx > 0);
        append_missing_variants(
            &mut out,
            effort_variants_for_base_model(model, context_window),
        );
    }
    out
}

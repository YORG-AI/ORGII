//! Bundled per-model price catalog.
//!
//! Turns a model id into a [`ModelPricing`] (per-Mtok input/output/cache rates).
//! The catalog is a JSON file compiled into the binary via [`include_str!`], so
//! lookups are pure in-process reads with no SQLite dependency.
//!
//! ## Why the catalog replaces the `model_pricing` SQLite table
//!
//! The historical `resolve_model_pricing` read a `model_pricing` table that was
//! never created or populated anywhere, so every lookup fell through to the four
//! hardcoded defaults. Rather than add a schema-init + seed step (which would also
//! mean writing reference data into a user database on every launch), we treat the
//! rate card as static build-time data: parsed once into an in-memory index. This
//! keeps the read-only guarantee intact (no DB writes) and removes the dead table.
//!
//! ## Lookup order
//!
//! 1. Local/self-hosted providers price at `$0`.
//! 2. Exact id match (case-insensitive).
//! 3. Normalized id match (case-fold, `.`/`_` treated as `-`, date-pin and
//!    effort/verbosity suffixes stripped).
//! 4. Longest-prefix family fallback over the normalized ids.
//! 5. Mid-range default.

use std::sync::OnceLock;

use serde::Deserialize;

/// Per-model rates, expressed in USD per 1,000,000 tokens (per Mtok).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelPricing {
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cache_creation_per_mtok: f64,
    pub cache_read_per_mtok: f64,
}

impl ModelPricing {
    /// Zero-rate pricing used for local / self-hosted providers.
    pub const ZERO: Self = Self {
        input_per_mtok: 0.0,
        output_per_mtok: 0.0,
        cache_creation_per_mtok: 0.0,
        cache_read_per_mtok: 0.0,
    };
}

impl Default for ModelPricing {
    fn default() -> Self {
        catalog().default
    }
}

// ============================================================================
// Catalog data model
// ============================================================================

#[derive(Debug, Clone, Copy, Deserialize)]
struct RawRates {
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

impl From<RawRates> for ModelPricing {
    fn from(raw: RawRates) -> Self {
        Self {
            input_per_mtok: raw.input,
            output_per_mtok: raw.output,
            cache_creation_per_mtok: raw.cache_write,
            cache_read_per_mtok: raw.cache_read,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct RawEntry {
    id: String,
    #[serde(flatten)]
    rates: RawRates,
}

#[derive(Debug, Clone, Deserialize)]
struct RawCatalog {
    default: RawRates,
    models: Vec<RawEntry>,
}

/// Parsed catalog: an exact-id index, a normalized-id index, and a
/// length-descending list of normalized ids for prefix fallback.
struct Catalog {
    default: ModelPricing,
    /// (lowercased exact id, pricing)
    by_exact: Vec<(String, ModelPricing)>,
    /// (normalized id, pricing), sorted by normalized-id length descending
    by_normalized: Vec<(String, ModelPricing)>,
}

const CATALOG_JSON: &str = include_str!("model_pricing_catalog.json");

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let raw: RawCatalog = serde_json::from_str(CATALOG_JSON)
            .expect("bundled model_pricing_catalog.json must be valid JSON");
        let default = ModelPricing::from(raw.default);
        let mut by_exact = Vec::with_capacity(raw.models.len());
        let mut by_normalized = Vec::with_capacity(raw.models.len());
        for entry in raw.models {
            let pricing = ModelPricing::from(entry.rates);
            by_exact.push((entry.id.to_ascii_lowercase(), pricing));
            by_normalized.push((normalize_model_id(&entry.id), pricing));
        }
        // Longest normalized id first so prefix fallback prefers the most specific
        // family (e.g. `claude-sonnet-4-5` before `claude-sonnet`).
        by_normalized.sort_by_key(|entry| std::cmp::Reverse(entry.0.len()));
        Catalog {
            default,
            by_exact,
            by_normalized,
        }
    })
}

// ============================================================================
// Public API
// ============================================================================

/// Resolve list-price rates for a model id, following the documented lookup
/// order. `None` (missing model) resolves to the mid-range default.
pub fn resolve_pricing(model: Option<&str>) -> ModelPricing {
    let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) else {
        return catalog().default;
    };

    if is_local_provider(model) {
        return ModelPricing::ZERO;
    }

    let catalog = catalog();
    let lower = model.to_ascii_lowercase();

    // 2. exact id
    if let Some((_, pricing)) = catalog.by_exact.iter().find(|(id, _)| *id == lower) {
        return *pricing;
    }

    // 3. normalized id
    let normalized = normalize_model_id(model);
    if let Some((_, pricing)) = catalog
        .by_normalized
        .iter()
        .find(|(id, _)| *id == normalized)
    {
        return *pricing;
    }

    // 4. longest-prefix family fallback (list is length-descending)
    if let Some((_, pricing)) = catalog
        .by_normalized
        .iter()
        .find(|(id, _)| normalized.starts_with(id.as_str()))
    {
        return *pricing;
    }

    // 5. mid-range default
    catalog.default
}

// ============================================================================
// Normalization
// ============================================================================

/// Return true when the model id points at a local / self-hosted runtime whose
/// tokens carry no provider cost.
fn is_local_provider(model: &str) -> bool {
    let lower = model.to_ascii_lowercase();
    // `provider/model` prefix, if present.
    if let Some((prefix, _)) = lower.split_once('/') {
        if matches!(
            prefix,
            "local"
                | "ollama"
                | "lmstudio"
                | "lm-studio"
                | "vllm"
                | "llamacpp"
                | "llama-cpp"
                | "koboldcpp"
                | "textgen"
                | "self-hosted"
                | "selfhosted"
        ) {
            return true;
        }
    }
    const LOCAL_MARKERS: [&str; 9] = [
        "ollama",
        "lmstudio",
        "lm-studio",
        "vllm",
        "llama.cpp",
        "llamacpp",
        "localhost",
        "self-hosted",
        "selfhosted",
    ];
    LOCAL_MARKERS.iter().any(|marker| lower.contains(marker))
}

/// Case-fold, treat `.`/`_` as `-`, drop any `provider/` prefix, and strip
/// trailing date-pin and effort/verbosity suffixes so that
/// `claude-sonnet-4-5-20250101` and `claude.sonnet.4.5` collapse to one id.
pub fn normalize_model_id(model: &str) -> String {
    let mut value = model.trim().to_ascii_lowercase();

    // Drop a leading `provider/` segment (e.g. `anthropic/claude-...`).
    if let Some((_, rest)) = value.split_once('/') {
        value = rest.to_string();
    }
    // A trailing `@date` pin (e.g. `gpt-4o@2024-08-06`).
    if let Some((head, _)) = value.split_once('@') {
        value = head.to_string();
    }

    // Unify separators: `.` and `_` -> `-`, whitespace -> `-`.
    let unified: String = value
        .chars()
        .map(|ch| match ch {
            '.' | '_' | ' ' => '-',
            other => other,
        })
        .collect();

    // Split on `-`, dropping empty segments (collapses runs of separators).
    let mut segments: Vec<&str> = unified.split('-').filter(|s| !s.is_empty()).collect();

    // Strip trailing date-pin and effort/verbosity/channel suffixes.
    while let Some(last) = segments.last().copied() {
        if is_droppable_suffix(last) {
            segments.pop();
        } else {
            break;
        }
    }

    segments.join("-")
}

/// A trailing segment that carries no pricing signal: date pins
/// (`20250101`, `2025`, `0806`), effort/verbosity levels, and release channels.
fn is_droppable_suffix(segment: &str) -> bool {
    const SUFFIXES: [&str; 12] = [
        "high",
        "medium",
        "low",
        "minimal",
        "thinking",
        "nonthinking",
        "reasoning",
        "latest",
        "preview",
        "exp",
        "experimental",
        "stable",
    ];
    if SUFFIXES.contains(&segment) {
        return true;
    }
    // Pure numeric date pin (e.g. `20250101`, `0806`, `2025`), but not short
    // version tokens that are part of a family name (those are handled by the
    // normalized/exact indexes, which keep the digits).
    let all_digits = segment.len() >= 4 && segment.chars().all(|ch| ch.is_ascii_digit());
    all_digits
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_parses_and_indexes() {
        let catalog = catalog();
        assert!(!catalog.by_exact.is_empty());
        assert!(!catalog.by_normalized.is_empty());
        // sorted length-descending
        let lens: Vec<usize> = catalog
            .by_normalized
            .iter()
            .map(|(id, _)| id.len())
            .collect();
        assert!(lens.windows(2).all(|w| w[0] >= w[1]));
    }

    #[test]
    fn exact_match_wins() {
        let pricing = resolve_pricing(Some("claude-sonnet-4-5"));
        assert_eq!(pricing.input_per_mtok, 3.0);
        assert_eq!(pricing.output_per_mtok, 15.0);
    }

    #[test]
    fn normalization_strips_date_pin_and_folds_dots() {
        assert_eq!(
            normalize_model_id("claude-sonnet-4-5-20250101"),
            "claude-sonnet-4-5"
        );
        assert_eq!(normalize_model_id("claude.sonnet.4.5"), "claude-sonnet-4-5");
        assert_eq!(
            normalize_model_id("anthropic/Claude-Sonnet-4-5"),
            "claude-sonnet-4-5"
        );
        let a = resolve_pricing(Some("claude-sonnet-4-5-20250101"));
        let b = resolve_pricing(Some("claude.sonnet.4.5"));
        assert_eq!(a, b);
    }

    #[test]
    fn effort_suffix_is_stripped() {
        assert_eq!(normalize_model_id("gpt-5-high"), "gpt-5");
        assert_eq!(
            resolve_pricing(Some("gpt-5-high")),
            resolve_pricing(Some("gpt-5"))
        );
    }

    #[test]
    fn prefix_family_fallback() {
        // `gpt-5-chat` is not an exact entry -> falls back to `gpt-5` family.
        let chat = resolve_pricing(Some("gpt-5-chat-latest"));
        let base = resolve_pricing(Some("gpt-5"));
        assert_eq!(chat, base);
    }

    #[test]
    fn local_providers_are_free() {
        assert_eq!(resolve_pricing(Some("ollama/llama3.1")), ModelPricing::ZERO);
        assert_eq!(
            resolve_pricing(Some("lmstudio/qwen2.5-coder")),
            ModelPricing::ZERO
        );
        assert_eq!(resolve_pricing(Some("vllm/mixtral")), ModelPricing::ZERO);
    }

    #[test]
    fn unknown_model_gets_default() {
        let pricing = resolve_pricing(Some("totally-made-up-model-xyz"));
        assert_eq!(pricing, ModelPricing::default());
    }

    #[test]
    fn missing_model_gets_default() {
        assert_eq!(resolve_pricing(None), ModelPricing::default());
    }
}

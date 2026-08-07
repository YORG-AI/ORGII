//! API Key and Base URL extraction from messy text input.
//!
//! This module provides regex-based extraction of API keys and base URLs
//! from unstructured text, eliminating the need for LLM-based extraction
//! in most cases.
//!
//! Supports:
//! - Anthropic: sk-ant-*, sk_* (64+ chars)
//! - OpenAI/Codex: sk-* (not sk_)
//! - Google/Gemini: AIza* (native) or sk-* (proxy)
//! - GitHub: github_pat_*, ghp_*
//! - Proxy APIs: sk-* format (any length 24+ chars)
//!
//! Also extracts base URLs from patterns like:
//! - ANTHROPIC_BASE_URL = "https://..."
//! - OPENAI_BASE_URL="https://..."
//! - GOOGLE_GEMINI_BASE_URL = "https://..."

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// Result of key extraction
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExtractionResult {
    /// Extracted API key (if found)
    pub api_key: Option<String>,
    /// Extracted base URL (if found)
    pub base_url: Option<String>,
    /// Detected key type
    pub key_type: Option<String>,
    /// Confidence level: "high", "medium", "low"
    pub confidence: String,
    /// Any warnings or notes
    pub notes: Vec<String>,
}

// Lazy-compiled regex patterns for performance
// Note: Using (?:^|[^...]) instead of \b for Chinese character compatibility
static ANTHROPIC_KEY: LazyLock<Regex> = LazyLock::new(|| {
    // sk-ant-api03-xxx or sk_xxx (64+ hex chars)
    Regex::new(r"(?i)(?:^|[^a-zA-Z0-9_-])(sk[-_]ant[-_][a-zA-Z0-9_-]{20,}|sk_[a-fA-F0-9]{40,})(?:[^a-zA-Z0-9_-]|$)").unwrap()
});

static OPENAI_KEY: LazyLock<Regex> = LazyLock::new(|| {
    // sk-xxx (not sk_ which is Anthropic style)
    // OpenAI keys are typically sk-proj-xxx or sk-xxx format
    // Proxy keys can be shorter (e.g., sk-b166e6c00f9246f4bda823196826815c = 35 chars)
    // Match sk- followed by alphanumeric, then at least 20 more chars (min 24 total)
    Regex::new(r"(?:^|[^a-zA-Z0-9_-])(sk-[a-zA-Z0-9][a-zA-Z0-9_-]{20,})(?:[^a-zA-Z0-9_-]|$)")
        .unwrap()
});

static GOOGLE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    // AIzaSy... (39 chars total)
    Regex::new(r"(?:^|[^a-zA-Z0-9_-])(AIza[a-zA-Z0-9_-]{35,})(?:[^a-zA-Z0-9_-]|$)").unwrap()
});

static GITHUB_KEY: LazyLock<Regex> = LazyLock::new(|| {
    // github_pat_xxx or ghp_xxx
    Regex::new(r"(?:^|[^a-zA-Z0-9_-])(github_pat_[a-zA-Z0-9_]{20,}|ghp_[a-zA-Z0-9]{30,})(?:[^a-zA-Z0-9_-]|$)").unwrap()
});

// Base URL patterns
static BASE_URL_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // Match: SOMETHING_BASE_URL = "https://..." or SOMETHING_BASE_URL="https://..."
    // Also handles Chinese quotes "" and single quotes
    Regex::new(r#"(?i)[A-Z_]*BASE_URL\s*[=：:]\s*["'""]?(https?://[^\s"'""\n]+)["'""]?"#).unwrap()
});

// Standalone URL pattern (for cases where URL is just listed)
static URL_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(https?://[^\s"'<>\n]+)"#).unwrap());

/// Extract API key and base URL from raw text input.
///
/// # Arguments
/// * `input` - Raw text that may contain API keys, URLs, and other content
/// * `agent_type` - Optional hint about what type of key to look for
///
/// # Returns
/// * `ExtractionResult` with extracted key, base URL, and metadata
pub fn extract_keys(input: &str, agent_type: Option<&str>) -> ExtractionResult {
    let mut result = ExtractionResult {
        confidence: "low".to_string(),
        ..Default::default()
    };

    // Normalize input (handle Chinese colons, quotes, etc.)
    let normalized = input
        .replace('：', ":") // Chinese colon
        .replace('；', ";") // Chinese semicolon
        .replace(['\u{201C}', '\u{201D}'], "\"")
        .replace(['\u{2018}', '\u{2019}'], "'");

    // Try to extract API key based on agent type hint or auto-detect
    let (key, key_type) = extract_api_key(&normalized, agent_type);

    if let Some(k) = key {
        result.api_key = Some(k);
        result.key_type = Some(key_type.clone());
        result.confidence = "high".to_string();
    }

    // Try to extract base URL
    if let Some(url) = extract_base_url(&normalized, result.key_type.as_deref()) {
        result.base_url = Some(url);
    }

    // Add notes about what was found
    if result.api_key.is_some() {
        result.notes.push(format!(
            "Found {} key",
            result.key_type.as_deref().unwrap_or("unknown")
        ));
    } else {
        result.notes.push("No API key found".to_string());
        result.confidence = "low".to_string();
    }

    if result.base_url.is_some() {
        result.notes.push("Found base URL".to_string());
    }

    result
}

/// Extract API key from text, optionally filtered by agent type
fn extract_api_key(input: &str, agent_type: Option<&str>) -> (Option<String>, String) {
    // When agent_type is specified, trust the user's selection
    // Many proxy providers use sk- format regardless of the underlying service
    // So we extract ANY valid-looking key and return the user's specified type

    if let Some(agent) = agent_type {
        let agent_lower = agent.to_lowercase();
        let key_type = agent_lower.clone();

        // Try all key patterns - the user knows what agent they're configuring
        // Order: most specific first, then generic sk- patterns

        // Native key formats first
        if let Some(cap) = ANTHROPIC_KEY.captures(input) {
            return (Some(cap[1].to_string()), key_type);
        }
        if let Some(cap) = GOOGLE_KEY.captures(input) {
            return (Some(cap[1].to_string()), key_type);
        }
        if let Some(cap) = GITHUB_KEY.captures(input) {
            return (Some(cap[1].to_string()), key_type);
        }
        // Generic sk- format (used by many proxies)
        if let Some(cap) = OPENAI_KEY.captures(input) {
            return (Some(cap[1].to_string()), key_type);
        }
    }

    // Auto-detect mode (no agent_type specified): guess based on key format
    // Anthropic sk_xxx (most specific - 64 hex chars) or sk-ant-
    if let Some(cap) = ANTHROPIC_KEY.captures(input) {
        let key = &cap[1];
        if key.starts_with("sk-ant-") || (key.starts_with("sk_") && key.len() >= 64) {
            return (Some(key.to_string()), "anthropic".to_string());
        }
    }

    // Google AIza keys (very specific format)
    if let Some(cap) = GOOGLE_KEY.captures(input) {
        return (Some(cap[1].to_string()), "google".to_string());
    }

    // GitHub tokens (specific prefixes)
    if let Some(cap) = GITHUB_KEY.captures(input) {
        return (Some(cap[1].to_string()), "github".to_string());
    }

    // Generic sk- keys (could be OpenAI, proxy, etc.)
    if let Some(cap) = OPENAI_KEY.captures(input) {
        return (Some(cap[1].to_string()), "unknown".to_string());
    }

    (None, "unknown".to_string())
}

// ─── URL Scoring / Ranking ───────────────────────────────────────────
//
// Zero-config URL scoring: no per-agent keyword maps, no hardcoded path
// lists.  Instead we combine three strategies:
//
//  1. **Auto-derived fuzzy matching** — keywords are derived from the
//     agent_type string itself (e.g. "claude_code" → ["claude"]) and
//     fuzzy-matched against URL segments using nucleo (same engine as
//     our file search / Helix editor).
//
//  2. **Structural segment classification** — each path segment is
//     scored by its *shape* (length, hyphens, version patterns, etc.)
//     rather than by matching against a dictionary.
//
//  3. **URL-level structural signals** — host prefix, path depth,
//     fragment presence, query-param heuristics.
//
// Adding a new agent type requires ZERO code changes — keywords are
// derived automatically.

use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};

/// Minimum score a URL must reach to be considered an API base URL.
pub(crate) const URL_MIN_SCORE: f64 = 2.0;

// ── Agent keyword derivation ─────────────────────────────────────────

/// Words that appear in agent type names but carry no semantic value for
/// URL matching.  Kept intentionally tiny — these are structural noise,
/// not domain knowledge.
const NOISE_WORDS: &[&str] = &["cli", "code", "pro", "api", "key", "app"];

/// Automatically derive search keywords from an agent_type string.
///
/// ```text
/// "codex"       → ["codex"]
/// "claude_code" → ["claude"]          // "code" is noise
/// "cursor_cli"  → ["cursor"]
/// "copilot"     → ["copilot"]
/// "kiro"        → ["kiro"]
/// ```
///
/// No per-agent mapping table needed.
pub(crate) fn derive_search_terms(agent_type: &str) -> Vec<String> {
    let lower = agent_type.to_lowercase();

    lower
        .split(['_', '-'])
        .filter(|part| part.len() >= 3 && !NOISE_WORDS.contains(part))
        .map(String::from)
        .collect()
}

// ── Nucleo fuzzy matching ────────────────────────────────────────────

/// Fuzzy-match `needle` against `haystack` using nucleo.
/// Returns a score > 0 on match, or None if no match.
pub(crate) fn fuzzy_score(needle: &str, haystack: &str) -> Option<u32> {
    if needle.is_empty() || haystack.is_empty() {
        return None;
    }

    let pattern = Pattern::new(
        needle,
        CaseMatching::Ignore,
        Normalization::Smart,
        AtomKind::Fuzzy,
    );

    let mut matcher = Matcher::new(Config::DEFAULT);
    let mut buf = Vec::new();
    let haystack_utf32 = Utf32Str::new(haystack, &mut buf);

    pattern.score(haystack_utf32, &mut matcher)
}

// ── Structural segment classification ────────────────────────────────
//
// Instead of listing every possible "doc" or "API" word, we classify
// path segments by their *shape*.  This handles languages, new services,
// and creative proxy names without code changes.

/// Score a single URL path segment by its structural properties.
///
/// Positive = looks like an API route.
/// Negative = looks like a human-readable / content page.
/// Zero     = ambiguous.
fn classify_segment(seg: &str) -> f64 {
    let len = seg.len();
    if len == 0 {
        return 0.0;
    }

    // ── Strong API indicator: the literal segment "api" ──
    if seg == "api" {
        return 4.0;
    }

    // ── Version pattern: v1, v2, v3 … v99 ──
    if len <= 3 && seg.starts_with('v') && seg[1..].bytes().all(|b| b.is_ascii_digit()) {
        return 2.5;
    }

    let mut score = 0.0;
    let hyphen_count = seg.chars().filter(|&c| c == '-').count();
    let alpha_ratio = seg.chars().filter(|c| c.is_alphabetic()).count() as f64 / len as f64;

    // ── Slug detection: long, hyphen-separated = human-readable page ──
    // e.g. "getting-started-with-gemini" or "wb12f08va3xakgwu" (doc ID)
    if hyphen_count >= 2 && len > 12 {
        score -= 3.0;
    }

    // ── Short clean segments lean API-like ──
    // API paths tend to be short identifiers: "chat", "models", "codex"
    if len <= 12 && hyphen_count == 0 && alpha_ratio > 0.7 {
        score += 0.5;
    }

    // ── Very long unhyphenated segments = hash / doc ID ──
    if len > 25 && hyphen_count == 0 {
        score -= 1.5;
    }

    // ── Known navigation-page prefixes (tiny set — structural, not domain) ──
    // These are universal across languages / cultures and extremely unlikely
    // to appear in API paths.  Only 5 stems cover ~95% of cases.
    const PAGE_STEMS: &[&str] = &["doc", "wiki", "blog", "help", "admin"];
    for stem in PAGE_STEMS {
        if seg.starts_with(stem) {
            score -= 4.0;
            break;
        }
    }

    // ── Dashboard / auth pages (also universal) ──
    const DASH_STEMS: &[&str] = &["login", "signup", "register", "dashboard", "console"];
    for stem in DASH_STEMS {
        if seg.starts_with(stem) {
            score -= 3.0;
            break;
        }
    }

    // ── Utility / info pages ──
    const INFO_STEMS: &[&str] = &["balance", "status", "pricing", "about", "support", "faq"];
    for stem in INFO_STEMS {
        if seg == *stem || (seg.starts_with(stem) && seg.len() <= stem.len() + 3) {
            score -= 3.0;
            break;
        }
    }

    score
}

// ── URL-level scoring ────────────────────────────────────────────────

/// Score a single URL candidate for likelihood of being an API base URL.
///
/// Combines:
///   - Segment-level structural classification (no hardcoded API word list)
///   - Fuzzy agent-keyword matching via nucleo (auto-derived, no mapping)
///   - URL-level structural signals (host, depth, fragment, query params)
pub(crate) fn score_url(url: &str, agent_type: Option<&str>) -> f64 {
    let Ok(parsed) = url::Url::parse(url) else {
        return -100.0;
    };

    let path = parsed.path().to_lowercase();
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    let mut score = 0.0;

    // Split path into segments for per-segment analysis
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    // ── 1. Structural segment classification ──
    for seg in &segments {
        score += classify_segment(seg);
    }

    // ── 2. Agent keyword fuzzy matching (auto-derived) ──
    if let Some(agent) = agent_type {
        let terms = derive_search_terms(agent);
        let mut best_seg_score: u32 = 0;
        let mut matched = false;

        for term in &terms {
            // Fuzzy match against each path segment
            for seg in &segments {
                if let Some(s) = fuzzy_score(term, seg) {
                    if s > best_seg_score {
                        best_seg_score = s;
                    }
                    matched = true;
                }
            }
            // Also check against host
            if fuzzy_score(term, &host).is_some() {
                matched = true;
            }
        }

        if matched {
            // Scale: nucleo scores vary, but any match is a strong signal.
            // Cap the bonus to avoid runaway scores from very long matches.
            let bonus = 4.0 + (best_seg_score as f64 / 100.0).min(2.0);
            score += bonus;
        }
    }

    // ── 3. URL-level structural signals ──

    // Host starts with "api." — strong API hint
    if host.starts_with("api.") {
        score += 3.0;
    }
    // Host starts with "docs." or "wiki." — strong page hint
    if host.starts_with("docs.") || host.starts_with("wiki.") {
        score -= 4.0;
    }

    // Path depth: root URLs are homepages, deeper paths lean API
    match segments.len() {
        0 => score -= 2.0,
        1 => {}
        _ => score += 1.0,
    }

    // Fragment (#section) — API URLs almost never use fragments
    if parsed.fragment().is_some() {
        score -= 2.0;
    }

    // Query-param heuristics: doc-viewer params are a page signal
    if let Some(q) = parsed.query() {
        let q_lower = q.to_lowercase();
        if q_lower.contains("singledoc")
            || q_lower.contains("from=from_")
            || q_lower.contains("utm_")
        {
            score -= 2.0;
        }
    }

    score
}

/// Extract base URL from text using scored ranking of all URL candidates.
fn extract_base_url(input: &str, key_type: Option<&str>) -> Option<String> {
    // Highest-confidence: explicit BASE_URL assignment (env-var style)
    if let Some(cap) = BASE_URL_PATTERN.captures(input) {
        let url = cap[1].to_string();
        let url = url.trim_end_matches([';', '；', '"', '\'']);
        return Some(url.to_string());
    }

    // Collect every URL in the text, score it, and pick the winner
    let mut best: Option<(f64, String)> = None;

    for cap in URL_PATTERN.captures_iter(input) {
        let url = &cap[1];
        let s = score_url(url, key_type);

        if s >= URL_MIN_SCORE && best.as_ref().is_none_or(|(prev, _)| s > *prev) {
            best = Some((s, url.trim_end_matches('/').to_string()));
        }
    }

    best.map(|(_, url)| url)
}

#[cfg(test)]
#[path = "tests/key_extractor_tests.rs"]
mod tests;

use crate::providers::model_capabilities::*;
use std::path::Path;

// ── Family table resolution ──

#[test]
fn claude_fable_5_is_always_on() {
    let caps = resolve("claude-fable-5-20260601", None);
    assert_eq!(caps.thinking, ThinkingSupport::AlwaysOn);
    assert_eq!(caps.context_window, 1_000_000);
}

#[test]
fn claude_opus_4_is_optional() {
    let caps = resolve("claude-opus-4-20250514", None);
    assert_eq!(caps.thinking, ThinkingSupport::Optional);
    assert_eq!(caps.context_window, 1_000_000);
}

#[test]
fn claude_sonnet_4_is_optional() {
    let caps = resolve("claude-sonnet-4-20250514", None);
    assert_eq!(caps.thinking, ThinkingSupport::Optional);
}

#[test]
fn claude_3_5_sonnet_no_thinking() {
    let caps = resolve("claude-3-5-sonnet-20241022", None);
    assert_eq!(caps.thinking, ThinkingSupport::No);
}

#[test]
fn claude_37_is_optional() {
    let caps = resolve("claude-3-7-sonnet-20250219", None);
    assert_eq!(caps.thinking, ThinkingSupport::Optional);
}

#[test]
fn shorthand_sonnet_4_normalizes() {
    let caps = resolve("sonnet-4", None);
    assert_eq!(caps.thinking, ThinkingSupport::Optional);
    assert_eq!(caps.context_window, 200_000);
}

#[test]
fn claude_haiku_4_5_is_optional() {
    let caps = resolve("claude-haiku-4-5-20251001", None);
    assert_eq!(caps.thinking, ThinkingSupport::Optional);
    assert_eq!(caps.context_window, 200_000);
}

// ── Sonnet 4.6 variant (1M) ──

#[test]
fn sonnet_4_6_is_1m() {
    let caps = resolve("claude-sonnet-4.6-20260101", None);
    assert_eq!(caps.thinking, ThinkingSupport::Optional);
    assert_eq!(caps.context_window, 1_000_000);
}

// ── OpenAI family ──

#[test]
fn gpt5_is_always_on() {
    let caps = resolve("gpt-5-2025-06-01", None);
    assert_eq!(caps.thinking, ThinkingSupport::AlwaysOn);
    assert_eq!(caps.context_window, 1_000_000);

    let gpt55 = resolve("gpt-5.5", None);
    assert_eq!(gpt55.thinking, ThinkingSupport::AlwaysOn);
    assert_eq!(gpt55.context_window, 1_050_000);
}

#[test]
fn o3_is_always_on() {
    let caps = resolve("o3-2025-04-16", None);
    assert_eq!(caps.thinking, ThinkingSupport::AlwaysOn);
}

#[test]
fn gpt4o_no_thinking() {
    let caps = resolve("gpt-4o-2024-11-20", None);
    assert_eq!(caps.thinking, ThinkingSupport::No);
}

// ── DeepSeek ──

#[test]
fn deepseek_r1_always_on() {
    let caps = resolve("deepseek-r1", None);
    assert_eq!(caps.thinking, ThinkingSupport::AlwaysOn);
    assert_eq!(caps.context_window, 128_000);
}

#[test]
fn deepseek_v3_no_thinking() {
    let caps = resolve("deepseek-v3-0324", None);
    assert_eq!(caps.thinking, ThinkingSupport::No);
}

#[test]
fn deepseek_current_aliases_use_1m() {
    assert_eq!(resolve("deepseek-v4-flash", None).context_window, 1_000_000);
    assert_eq!(resolve("deepseek-chat", None).context_window, 1_000_000);
    assert_eq!(resolve("deepseek-reasoner", None).context_window, 1_000_000);
}

#[test]
fn deepseek_legacy_fallback_uses_128k() {
    assert_eq!(resolve("deepseek-coder", None).context_window, 128_000);
}

// ── Alibaba / Z.AI / xAI / Mistral / Meta ──

#[test]
fn qwen3_coder_uses_256k() {
    let caps = resolve("qwen3-coder-plus", None);
    assert_eq!(caps.context_window, 256_000);
    assert_eq!(caps.thinking, ThinkingSupport::Optional);
}

#[test]
fn qwen_fallback_uses_128k_not_legacy_32k() {
    let caps = resolve("qwen2.5-72b-instruct", None);
    assert_eq!(caps.context_window, 128_000);
}

#[test]
fn glm_modern_windows() {
    assert_eq!(resolve("glm-4.6", None).context_window, 200_000);
    assert_eq!(resolve("glm-4.5", None).context_window, 128_000);
    assert_eq!(resolve("glm-4-air", None).context_window, 128_000);
}

#[test]
fn grok_and_mistral_windows() {
    assert_eq!(resolve("grok-build-0.1", None).context_window, 256_000);
    assert_eq!(resolve("grok-4.3", None).context_window, 1_000_000);
    assert_eq!(resolve("grok-4", None).context_window, 256_000);
    assert_eq!(resolve("codestral-latest", None).context_window, 256_000);
    assert_eq!(
        resolve("mistral-large-latest", None).context_window,
        128_000
    );
}

#[test]
fn llama_windows_follow_model_card() {
    assert_eq!(resolve("llama-4-scout", None).context_window, 10_000_000);
    assert_eq!(resolve("llama-4-maverick", None).context_window, 1_000_000);
    assert_eq!(resolve("llama-4", None).context_window, 1_000_000);
    assert_eq!(resolve("llama-3-70b", None).context_window, 128_000);
    assert_eq!(
        resolve("llama-3.2-90b-vision", None).context_window,
        128_000
    );
}

// ── Unknown model ──

#[test]
fn unknown_model_conservative_defaults() {
    let caps = resolve("totally-unknown-model-xyz", None);
    assert_eq!(caps, ModelCapabilities::unknown());
    assert_eq!(caps.context_window, 200_000);
    assert_eq!(caps.thinking, ThinkingSupport::Optional);
    assert!(caps.omit_temperature_with_thinking);

    assert_eq!(resolve("o5.5-high", None).context_window, 200_000);
}

// ── Case insensitivity ──

#[test]
fn case_insensitive_matching() {
    let caps = resolve("Claude-Opus-4-20250514", None);
    assert_eq!(caps.thinking, ThinkingSupport::Optional);
}

// ── Google ──

#[test]
fn gemini_2_optional() {
    let caps = resolve("gemini-2.0-flash", None);
    assert_eq!(caps.thinking, ThinkingSupport::Optional);
    assert_eq!(caps.context_window, 1_000_000);
}

// ── Future unknown claude is AlwaysOn (safe bet) ──

#[test]
fn future_claude_defaults_to_always_on() {
    let caps = resolve("claude-7-ultra-2029", None);
    assert_eq!(caps.thinking, ThinkingSupport::AlwaysOn);
    assert_eq!(caps.context_window, 1_000_000);
}

// ─────────────────────────────────────────────────────────────────────────
// Enforcement: model-family substring checks live ONLY in model_capabilities
// ─────────────────────────────────────────────────────────────────────────
//
// The module doc promises this test. It scans the crate's production source
// for `.contains("<family>")` / `.starts_with("<family>")` / `.ends_with(...)`
// model-family classification and fails if a file outside the documented
// allowlist introduces one. New model-derived behavior must route through
// `model_capabilities::resolve` (add a `FAMILY_RULES` row) instead.
//
// The allowlist captures the matchers the 2026-06-13 architecture audit (S2)
// flagged as not-yet-migrated into `ModelCapabilities` (vision, tokenizer
// family, knowledge cutoff, reasoning-param detection) plus the legacy
// provider-routing table in `model_hints` (keep-with-reason). Migrating any
// of these into `ModelCapabilities::resolve` should remove its entry here,
// tightening the ratchet.

/// Files permitted to contain model-family substring checks today. Paths are
/// relative to the crate `src/` directory, using `/` separators.
const CAPABILITY_CHECK_ALLOWLIST: &[&str] = &[
    // keep-with-reason: provider-id routing hints, not capability decisions.
    "core/providers/model_hints.rs",
    // deferred (audit S2): migrate into ModelCapabilities.
    "core/turn_executor/screenshot.rs",        // vision detection
    "core/model_context/tokenizer.rs",         // tokenizer family
    "core/session/prompt/section_builders.rs", // knowledge-cutoff ladder
    "core/providers/openai_compat/types.rs",   // reasoning-param detection
    "core/providers/openai_responses/mod.rs",  // gpt-5 reasoning detection
];

/// Lowercased model-family id prefixes. A string literal passed to
/// `contains`/`starts_with`/`ends_with` beginning with one of these is treated
/// as a model-family classification.
const FAMILY_TOKENS: &[&str] = &[
    "gpt", "claude", "gemini", "deepseek", "qwen", "llama", "mixtral", "glm", "kimi", "moonshot",
    "grok", "mistral", "o1", "o3", "o4",
];

fn brace_delta(line: &str) -> i32 {
    line.bytes().fold(0i32, |acc, b| match b {
        b'{' => acc + 1,
        b'}' => acc - 1,
        _ => acc,
    })
}

/// True if `line` contains a `.contains("<fam>"` / `.starts_with("<fam>"` /
/// `.ends_with("<fam>"` model-family substring check.
fn line_has_family_substring_check(line: &str) -> bool {
    let trimmed = line.trim_start();
    // Ignore comments / doc comments.
    if trimmed.starts_with("//") {
        return false;
    }
    for method in ["contains", "starts_with", "ends_with"] {
        let pat = format!(".{method}(");
        let mut from = 0;
        while let Some(rel) = line[from..].find(&pat) {
            let after = line[from + rel + pat.len()..].trim_start();
            if let Some(rest) = after.strip_prefix('"') {
                let lit = rest.to_ascii_lowercase();
                // Exclude the non-model "claude-cli/" user-agent literal.
                if !lit.starts_with("claude-cli")
                    && FAMILY_TOKENS.iter().any(|t| lit.starts_with(t))
                {
                    return true;
                }
            }
            from += rel + pat.len();
        }
    }
    false
}

/// Scan one source file, skipping inline `#[cfg(test)] mod … { … }` bodies
/// (test code may reference model ids without being a capability decision).
/// Externalized `#[cfg(test)] #[path=…] mod tests;` declarations are not
/// skipped (they contain no checks), so production code above/below them is
/// still scanned.
fn file_has_violation(path: &Path) -> bool {
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    let mut test_depth = 0i32;
    let mut armed = false; // saw `#[cfg(test)]`, deciding inline-mod vs decl
    for line in content.lines() {
        if test_depth > 0 {
            test_depth += brace_delta(line);
            continue;
        }
        if armed {
            let t = line.trim_start();
            if t.starts_with("#[") {
                continue; // further attributes (e.g. #[path = …])
            }
            armed = false;
            if t.contains("mod ") && line.contains('{') {
                // inline test module — enter skip mode.
                test_depth = brace_delta(line);
                continue;
            }
            // externalized `mod tests;` (or other cfg(test) item) — fall
            // through and scan this line normally.
        }
        if line.contains("#[cfg(test)]") {
            armed = true;
            continue;
        }
        if line_has_family_substring_check(line) {
            return true;
        }
    }
    false
}

fn collect_violations(dir: &Path, src_root: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_violations(&path, src_root, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let rel = path
            .strip_prefix(src_root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        // Skip test files and the source-of-truth module itself.
        if rel.contains("/tests/")
            || rel.contains("__tests__")
            || rel.ends_with("_tests.rs")
            || rel == "core/providers/model_capabilities.rs"
        {
            continue;
        }
        if file_has_violation(&path) {
            out.push(rel);
        }
    }
}

#[test]
fn no_substring_capability_checks_outside_this_module() {
    let src_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut violations = Vec::new();
    collect_violations(&src_root, &src_root, &mut violations);
    violations.sort();
    violations.dedup();

    let undocumented: Vec<&String> = violations
        .iter()
        .filter(|f| !CAPABILITY_CHECK_ALLOWLIST.contains(&f.as_str()))
        .collect();
    assert!(
        undocumented.is_empty(),
        "New model-family substring check(s) found outside model_capabilities.rs: {undocumented:?}.\n\
         Route model-derived behavior through `model_capabilities::resolve` (add a FAMILY_RULES row),\n\
         or, if this is a deliberately-deferred migration, add the file to CAPABILITY_CHECK_ALLOWLIST with a reason."
    );

    // Ratchet: every allowlisted file must still contain a check, so removing
    // a matcher forces removing its allowlist entry (prevents stale debt).
    let stale: Vec<&&str> = CAPABILITY_CHECK_ALLOWLIST
        .iter()
        .filter(|f| !violations.iter().any(|v| v == *f))
        .collect();
    assert!(
        stale.is_empty(),
        "Allowlist entries no longer contain a family substring check (remove them): {stale:?}"
    );
}

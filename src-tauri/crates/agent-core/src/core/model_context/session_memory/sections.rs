//! Section-level helpers for SM markdown:
//!
//! - parse `### `-delimited sections to estimate per-section token cost
//! - generate "you must condense" reminders when sections / totals are over budget
//! - truncate oversized sections at line boundaries before compact injection

/// Rough token estimation (`chars / 4`).
pub(super) fn rough_token_estimate(text: &str) -> usize {
    text.len() / 4
}

/// Parsed section with header and estimated token count.
#[derive(Debug, Clone)]
pub struct SmSection {
    pub header: String,
    pub tokens: usize,
}

/// Parse SM content into per-section token counts.
///
/// Sections are delimited by markdown `### ` headers (matching the SM template).
pub fn analyze_section_sizes(content: &str) -> Vec<SmSection> {
    let mut sections = Vec::new();
    let mut current_header = String::new();
    let mut current_lines: Vec<&str> = Vec::new();

    for line in content.lines() {
        if line.starts_with("### ") {
            if !current_header.is_empty() && !current_lines.is_empty() {
                let body = current_lines.join("\n");
                sections.push(SmSection {
                    header: current_header.clone(),
                    tokens: rough_token_estimate(body.trim()),
                });
            }
            current_header = line.to_string();
            current_lines.clear();
        } else {
            current_lines.push(line);
        }
    }

    if !current_header.is_empty() && !current_lines.is_empty() {
        let body = current_lines.join("\n");
        sections.push(SmSection {
            header: current_header,
            tokens: rough_token_estimate(body.trim()),
        });
    }

    sections
}

/// Build enforcement reminders for oversized sections.
///
/// Returns an empty string when all sections are within budget,
/// otherwise returns a prompt suffix telling the LLM which sections
/// to condense and by how much.
pub fn generate_section_reminders(
    sections: &[SmSection],
    total_tokens: usize,
    max_section_tokens: usize,
    max_total_tokens: usize,
) -> String {
    let over_budget = total_tokens > max_total_tokens;
    let mut oversized: Vec<(&str, usize)> = sections
        .iter()
        .filter(|sec| sec.tokens > max_section_tokens)
        .map(|sec| (sec.header.as_str(), sec.tokens))
        .collect();
    oversized.sort_by_key(|entry| std::cmp::Reverse(entry.1));

    if oversized.is_empty() && !over_budget {
        return String::new();
    }

    let mut parts = Vec::new();

    if over_budget {
        parts.push(format!(
            "\n\nCRITICAL: The session memory is currently ~{} tokens, which exceeds the maximum of {} tokens. \
             You MUST condense the content to fit within this budget. Aggressively shorten oversized \
             sections by removing less important details, merging related items, and summarizing older \
             entries. Prioritize keeping \"Current State\" and \"Errors and Corrections\" accurate and detailed.",
            total_tokens, max_total_tokens,
        ));
    }

    if !oversized.is_empty() {
        let label = if over_budget {
            "Oversized sections to condense"
        } else {
            "IMPORTANT: The following sections exceed the per-section limit and MUST be condensed"
        };
        let details: Vec<String> = oversized
            .iter()
            .map(|(header, tokens)| {
                format!(
                    "- \"{}\" is ~{} tokens (limit: {})",
                    header, tokens, max_section_tokens
                )
            })
            .collect();
        parts.push(format!("\n\n{}:\n{}", label, details.join("\n")));
    }

    parts.join("")
}

/// Truncate SM sections that exceed the per-section character limit.
///
/// Used before injecting SM into the compact summary message to prevent
/// oversized SM from consuming the post-compact token budget.
///
/// `max_section_tokens` is converted to chars via `* 4` (matching
/// `roughTokenCountEstimation`). Lines are kept at line boundaries.
pub fn truncate_for_compact(content: &str, max_section_tokens: usize) -> (String, bool) {
    let max_chars = max_section_tokens * 4;
    let mut output_lines: Vec<String> = Vec::new();
    let mut current_header: Option<String> = None;
    let mut current_lines: Vec<&str> = Vec::new();
    let mut was_truncated = false;

    for line in content.lines() {
        if line.starts_with("### ") {
            let (lines, trunc) = flush_section(&current_header, &current_lines, max_chars);
            output_lines.extend(lines);
            was_truncated = was_truncated || trunc;
            current_header = Some(line.to_string());
            current_lines.clear();
        } else {
            current_lines.push(line);
        }
    }

    let (lines, trunc) = flush_section(&current_header, &current_lines, max_chars);
    output_lines.extend(lines);
    was_truncated = was_truncated || trunc;

    (output_lines.join("\n"), was_truncated)
}

fn flush_section(header: &Option<String>, lines: &[&str], max_chars: usize) -> (Vec<String>, bool) {
    let Some(header_str) = header else {
        return (lines.iter().map(|line| line.to_string()).collect(), false);
    };

    let section_content: String = lines.join("\n");
    if section_content.len() <= max_chars {
        let mut result = vec![header_str.clone()];
        result.extend(lines.iter().map(|line| line.to_string()));
        return (result, false);
    }

    let mut kept = vec![header_str.clone()];
    let mut char_count = 0;
    for line in lines {
        if char_count + line.len() + 1 > max_chars {
            break;
        }
        kept.push(line.to_string());
        char_count += line.len() + 1;
    }
    kept.push("\n[... section truncated for length ...]".to_string());
    (kept, true)
}

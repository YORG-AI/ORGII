//! `## Rules` section rendering and the per-rule UTF-8-safe byte budget.

pub(crate) fn build_rules_section(rules: &[(String, String)]) -> String {
    const MAX_RULES_BYTES: usize = 50_000;
    if rules.is_empty() {
        return "## Rules\n".to_string();
    }

    let full_entries: Vec<String> = rules
        .iter()
        .map(|(name, content)| format!("\n### {}\n\n{}\n", name, content))
        .collect();
    let full_total: usize = full_entries.iter().map(String::len).sum();
    if full_total <= MAX_RULES_BYTES {
        return format!("## Rules{}", full_entries.join(""));
    }

    let per_rule_budget = (MAX_RULES_BYTES / rules.len()).max(512);
    let mut section = String::from("## Rules\n");
    for (name, content) in rules {
        let prefix = format!("\n### {}\n\n", name);
        let suffix = "\n";
        let content_budget = per_rule_budget.saturating_sub(prefix.len() + suffix.len());
        let capped = cap_rule_content(content, content_budget);
        section.push_str(&prefix);
        section.push_str(&capped);
        section.push_str(suffix);
    }
    section.push_str(&format!(
        "\n[rules budget applied: {} rules exceeded {}KB total; each rule received a fair UTF-8-safe slice]",
        rules.len(),
        MAX_RULES_BYTES / 1000
    ));
    section
}

pub(crate) fn cap_rule_content(content: &str, max_bytes: usize) -> String {
    if content.len() <= max_bytes {
        return content.to_string();
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !content.is_char_boundary(boundary) {
        boundary -= 1;
    }
    format!(
        "{}\n\n[rule truncated: omitted {} bytes]",
        &content[..boundary],
        content.len() - boundary
    )
}

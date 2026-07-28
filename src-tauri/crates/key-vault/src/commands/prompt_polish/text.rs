//! Generic text post-processing helpers shared across the prompt-polish commands.

const SHORT_ANSWER_MAX_CHARS: usize = 24;
pub(super) fn clean_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}
fn strip_tagged_block_case_insensitive(mut text: String, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");

    loop {
        let lower = text.to_lowercase();
        let Some(start) = lower.find(&open) else {
            break;
        };
        let after_open = start + open.len();
        if let Some(relative_end) = lower[after_open..].find(&close) {
            let end = after_open + relative_end + close.len();
            text.replace_range(start..end, "");
        } else {
            text.replace_range(start.., "");
            break;
        }
    }

    text
}
pub(super) fn strip_reasoning_artifacts(text: &str) -> String {
    let mut cleaned = text.to_string();
    for tag in ["think", "thinking", "reasoning", "analysis"] {
        cleaned = strip_tagged_block_case_insensitive(cleaned, tag);
    }

    cleaned
        .lines()
        .filter(|line| {
            let trimmed = line.trim().to_lowercase();
            !trimmed.starts_with("analysis:")
                && !trimmed.starts_with("reasoning:")
                && !trimmed.starts_with("thought:")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}
pub(super) fn is_short_text(text: &str) -> bool {
    text.trim().chars().count() <= SHORT_ANSWER_MAX_CHARS
}
pub(super) fn normalized_short_input(text: &str) -> String {
    text.trim()
        .trim_matches(|ch: char| {
            ch.is_ascii_punctuation()
                || ch.is_whitespace()
                || matches!(
                    ch,
                    '。' | '，' | '、' | '？' | '！' | '：' | '；' | '“' | '”'
                )
        })
        .to_lowercase()
}
pub(super) fn is_greeting_like(text: &str) -> bool {
    let normalized = normalized_short_input(text);
    [
        "你好",
        "您好",
        "hello",
        "hi",
        "hey",
        "在吗",
        "谢谢",
        "thanks",
        "thank you",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase))
}
pub(super) fn text_excerpt(value: &str, max_chars: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = normalized.chars();
    let excerpt = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{excerpt}...")
    } else {
        excerpt
    }
}

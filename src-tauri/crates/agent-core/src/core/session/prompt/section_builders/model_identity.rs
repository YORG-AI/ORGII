//! Model identity line (knowledge-cutoff ladder) and the channel runtime line.

// ============================================
// Model identity
// ============================================

pub(crate) fn build_model_identity(model: &str) -> Option<String> {
    let cutoff = if model.contains("claude-sonnet-4-6") {
        Some("August 2025")
    } else if model.contains("claude-opus-4-6")
        || model.contains("claude-opus-4-5")
        || model.contains("claude-opus-4")
    {
        Some("May 2025")
    } else if model.contains("claude-sonnet-4-5") || model.contains("claude-sonnet-4") {
        Some("January 2025")
    } else if model.contains("claude-haiku-4") {
        Some("February 2025")
    } else {
        None
    };

    let mut line = format!("You are powered by the model `{}`.", model);
    if let Some(date) = cutoff {
        line.push_str(&format!(" Knowledge cutoff: {}.", date));
    }
    Some(line)
}

pub(crate) fn build_runtime_line(model: &str, channel: Option<&str>) -> String {
    let os_name = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let mut fields = vec![
        format!("os={} ({})", os_name, arch),
        format!("model={}", model),
    ];
    if let Some(channel) = channel {
        fields.push(format!("channel={}", channel));
    }
    format!("Runtime: {}", fields.join(" | "))
}

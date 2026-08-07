//! Screenshot and inline image marker resolution in tool results
//!
//! Scans tool output for two marker types:
//! 1. `[screenshot:<8-hex-chars>]` — looked up in `ScreenshotStore`
//! 2. `[image:<mime>:<base64-data>]` — self-contained inline image (from read_file)
//!
//! Both are replaced with `image_url` content blocks for vision-capable models.

use regex::Regex;
use serde_json::Value;

use shared_state::ScreenshotStore;

// ============================================
// Marker Resolution
// ============================================

/// Regex matching `[screenshot:<8-char-uuid>]` markers in tool results.
fn screenshot_marker_regex() -> Regex {
    Regex::new(r"\[screenshot:([a-f0-9]{8})\]").unwrap()
}

/// Regex matching `[image:<mime>:<base64-data>]` markers from read_file.
fn inline_image_marker_regex() -> Regex {
    Regex::new(r"\[image:(image/[a-z]+):([A-Za-z0-9+/=]+)\]").unwrap()
}

/// Heuristic: does this model name suggest vision/multimodal support?
fn is_vision_model(model: &str) -> bool {
    let lower = model.to_lowercase();
    // GPT-4o, GPT-4-turbo-vision, GPT-4.1, o1, o3, o4 variants
    if lower.contains("gpt-4o")
        || lower.contains("gpt-4.1")
        || lower.contains("gpt-4-turbo")
        || lower.starts_with("o1")
        || lower.starts_with("o3")
        || lower.starts_with("o4")
    {
        return true;
    }
    // Claude 3+ and claude-4+
    if lower.contains("claude-3") || lower.contains("claude-4") {
        return true;
    }
    // Gemini models
    if lower.contains("gemini") {
        return true;
    }
    false
}

/// Create a shallow copy of `messages` with image markers resolved
/// to multimodal `image_url` content blocks.  Only tool-role messages are touched.
///
/// Handles both `[screenshot:ID]` (ScreenshotStore lookup) and
/// `[image:mime:base64]` (self-contained from read_file).
///
/// For vision-capable models the marker is replaced with an OpenAI-format
/// `image_url` block (data URI).  All providers already convert this to their
/// native format (e.g. Anthropic's `image` block).
///
/// For text-only models the markers are simply stripped.
pub(crate) fn resolve_screenshot_markers(
    messages: &[Value],
    store: &ScreenshotStore,
    model: &str,
) -> Vec<Value> {
    let screenshot_re = screenshot_marker_regex();
    let image_re = inline_image_marker_regex();
    let vision = is_vision_model(model);

    messages
        .iter()
        .map(|msg| {
            let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
            if role != "tool" {
                return msg.clone();
            }

            let content = match msg.get("content").and_then(|c| c.as_str()) {
                Some(text) => text,
                None => return msg.clone(),
            };

            let has_screenshots = screenshot_re.is_match(content);
            let has_inline_images = image_re.is_match(content);

            if !has_screenshots && !has_inline_images {
                return msg.clone();
            }

            if !vision {
                let mut cleaned = screenshot_re.replace_all(content, "").to_string();
                cleaned = image_re.replace_all(&cleaned, "").to_string();
                let mut cloned = msg.clone();
                cloned["content"] = Value::String(cleaned);
                return cloned;
            }

            let mut text_without_markers = screenshot_re.replace_all(content, "").to_string();
            text_without_markers = image_re.replace_all(&text_without_markers, "").to_string();
            let mut content_blocks: Vec<Value> = Vec::new();

            let trimmed = text_without_markers.trim();
            if !trimmed.is_empty() {
                content_blocks.push(serde_json::json!({
                    "type": "text",
                    "text": trimmed,
                }));
            }

            for capture in screenshot_re.captures_iter(content) {
                let screenshot_id = &capture[1];
                if let Some(data_uri) = store.get_as_data_uri(screenshot_id) {
                    content_blocks.push(serde_json::json!({
                        "type": "image_url",
                        "image_url": { "url": data_uri },
                    }));
                }
            }

            for capture in image_re.captures_iter(content) {
                let mime = &capture[1];
                let b64_data = &capture[2];
                let data_uri = format!("data:{};base64,{}", mime, b64_data);
                content_blocks.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": data_uri },
                }));
            }

            let mut cloned = msg.clone();
            cloned["content"] = Value::Array(content_blocks);
            cloned
        })
        .collect()
}

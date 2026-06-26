//! Feishu event parsing — extracts InboundMessages from WebSocket event frames.

use serde_json::Value;
use std::collections::HashSet;
use tracing::{debug, info};

use crate::bus::InboundMessage;
use crate::integrations::channels::config::AccessPolicy;

/// Maximum dedup cache size for message IDs (FIFO eviction).
pub(super) const MAX_DEDUP_CACHE: usize = 500;

/// Config subset needed by the event parser (avoids cloning the full config).
pub(super) struct FeishuEventConfig {
    pub(super) group_policy: String,
    pub(super) dm_policy: String,
    pub(super) require_mention: bool,
    pub(super) allow_from: Vec<String>,
    pub(super) bot_open_id: String,
}

/// Parse a Feishu event frame and extract an InboundMessage if applicable.
pub(super) fn parse_feishu_event(
    payload: &Value,
    channel_name: &str,
    config: &FeishuEventConfig,
    dedup: &mut HashSet<String>,
    dedup_order: &mut Vec<String>,
) -> Option<InboundMessage> {
    let header = payload.get("header")?;
    let event_type = header.get("event_type")?.as_str()?;

    if event_type != "im.message.receive_v1" {
        return None;
    }

    let event = payload.get("event")?;
    let message = event.get("message")?;
    let sender = event.get("sender")?;

    let sender_type = sender
        .get("sender_type")
        .and_then(|s| s.as_str())
        .unwrap_or("");
    let message_id = message
        .get("message_id")
        .and_then(|m| m.as_str())
        .unwrap_or("");
    if sender_type != "user" {
        return None;
    }

    // Dedup: skip if we've already processed this message_id
    if !message_id.is_empty() {
        if dedup.contains(message_id) {
            return None;
        }
        // FIFO eviction
        if dedup.len() >= MAX_DEDUP_CACHE {
            if let Some(oldest) = dedup_order.first().cloned() {
                dedup.remove(&oldest);
                dedup_order.remove(0);
            }
        }
        dedup.insert(message_id.to_string());
        dedup_order.push(message_id.to_string());
    }

    let chat_id = message
        .get("chat_id")
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let chat_type = message
        .get("chat_type")
        .and_then(|c| c.as_str())
        .unwrap_or("p2p");
    let message_type = message
        .get("message_type")
        .and_then(|m| m.as_str())
        .unwrap_or("text");
    tracing::info!("[feishu:debug] message_type={:?} raw_content_preview", message_type);
    let sender_id = sender
        .get("sender_id")
        .and_then(|s| s.get("open_id"))
        .and_then(|o| o.as_str())
        .unwrap_or("");

    // Access control: group policy.
    //
    // Pre-fix this lived as an inline string match with `_ => {} // "open"`
    // for the group case AND a much narrower branch that only handled
    // `"allowlist"` for DMs — which meant `dm_policy = "disabled"` was
    // silently *not* honored and DMs went through. Both sides now route
    // through the typed `AccessPolicy` so the wire-value `"disabled"`
    // closes both gates and unknown values fail closed.
    if chat_type == "group" {
        let group_policy = AccessPolicy::parse_with_default(
            &config.group_policy,
            AccessPolicy::Open,
            "feishu-group",
        );
        match group_policy {
            AccessPolicy::Disabled => return None,
            AccessPolicy::Allowlist => {
                if !config.allow_from.is_empty()
                    && !config
                        .allow_from
                        .iter()
                        .any(|a| a == chat_id || a == sender_id)
                {
                    return None;
                }
            }
            AccessPolicy::Open => {}
        }

        // Require @mention in groups
        if config.require_mention {
            let mentions = message.get("mentions").and_then(|m| m.as_array());
            let bot_mentioned = mentions.is_some_and(|arr| {
                arr.iter().any(|mention| {
                    mention
                        .get("id")
                        .and_then(|id| id.get("open_id"))
                        .and_then(|o| o.as_str())
                        .is_some_and(|oid| oid == config.bot_open_id)
                })
            });
            if !bot_mentioned {
                return None;
            }
        }
    } else {
        // DM policy
        let dm_policy =
            AccessPolicy::parse_with_default(&config.dm_policy, AccessPolicy::Open, "feishu-dm");
        match dm_policy {
            AccessPolicy::Disabled => return None,
            AccessPolicy::Allowlist => {
                if !config.allow_from.is_empty()
                    && !config.allow_from.iter().any(|a| a == sender_id)
                {
                    // 这次 debug 最大的坑：allowlist 用错 open_id（per-app 不同）会静默吞消息。
                    // 加日志：拒绝时打印 sender open_id，方便对照 allow_from 配置。
                    debug!(
                        "[feishu] DM rejected by allowlist: sender open_id={} not in allow_from (size={})",
                        sender_id,
                        config.allow_from.len()
                    );
                    return None;
                }
            }
            AccessPolicy::Open => {}
        }
    }

    // Extract text content
    let raw_content = message
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("{}");
    let content_text = extract_text_content(raw_content, message_type);

    if content_text.is_empty() {
        return None;
    }

    let mut inbound = InboundMessage::new(channel_name, sender_id, chat_id, &content_text);
    inbound.metadata.insert(
        "message_id".to_string(),
        Value::String(message_id.to_string()),
    );
    inbound.metadata.insert(
        "chat_type".to_string(),
        Value::String(chat_type.to_string()),
    );
    inbound.metadata.insert(
        "message_type".to_string(),
        Value::String(message_type.to_string()),
    );

    // Store image/file keys in media vec
    if message_type == "image" {
        tracing::info!("[feishu:debug] image msg raw_content={}", raw_content);
        if let Some(key) = parse_content_json(raw_content).and_then(|v| {
            v.get("image_key")
                .and_then(|k| k.as_str())
                .map(|s| s.to_string())
        }) {
            tracing::info!("[feishu:debug] extracted image_key, media push");
            inbound.media.push(format!("feishu:image:{}:{}", message_id, key));
        } else {
            tracing::warn!("[feishu:debug] FAILED to extract image_key from raw_content");
        }
    } else if message_type == "post" {
        // Rich-text (post) messages can embed images as `img` elements
        // carrying an `image_key`. Collect them so they get downloaded too.
        if let Some(parsed) = parse_content_json(raw_content) {
            let mut keys = Vec::new();
            collect_post_image_keys(&parsed, &mut keys);
            for key in keys {
                inbound.media.push(format!("feishu:image:{}:{}", message_id, key));
            }
        }
    } else if message_type == "file" {
        if let Some(key) = parse_content_json(raw_content).and_then(|v| {
            v.get("file_key")
                .and_then(|k| k.as_str())
                .map(|s| s.to_string())
        }) {
            inbound.media.push(format!("feishu:file:{}", key));
        }
    }

    info!(
        "[{}] Parsed inbound message: session_key={}, sender={}, content_len={}",
        channel_name,
        inbound.session_key(),
        sender_id,
        content_text.len()
    );

    Some(inbound)
}

/// Extract plain text from Feishu message content JSON string.
fn extract_text_content(raw_content: &str, message_type: &str) -> String {
    let parsed = match parse_content_json(raw_content) {
        Some(val) => val,
        None => return String::new(),
    };

    match message_type {
        "text" => parsed
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        "post" => flatten_post_content(&parsed),
        "image" => "[image]".to_string(),
        "file" => {
            let name = parsed
                .get("file_name")
                .and_then(|f| f.as_str())
                .unwrap_or("file");
            format!("[file: {}]", name)
        }
        _ => {
            format!("[{}]", message_type)
        }
    }
}

/// Parse the double-encoded content JSON string.
fn parse_content_json(raw: &str) -> Option<Value> {
    serde_json::from_str(raw).ok()
}

/// Walk a Feishu "post" content tree and collect all embedded `img` element
/// `image_key`s (locale roots zh_cn/en_us/ja_jp, then paragraphs of elements).
fn collect_post_image_keys(parsed: &Value, out: &mut Vec<String>) {
    let content_root = parsed
        .get("zh_cn")
        .or_else(|| parsed.get("en_us"))
        .or_else(|| parsed.get("ja_jp"))
        .unwrap_or(parsed);

    if let Some(paragraphs) = content_root.get("content").and_then(|c| c.as_array()) {
        for paragraph in paragraphs {
            if let Some(elements) = paragraph.as_array() {
                for element in elements {
                    let tag = element.get("tag").and_then(|t| t.as_str()).unwrap_or("");
                    if tag == "img" {
                        if let Some(key) =
                            element.get("image_key").and_then(|k| k.as_str())
                        {
                            out.push(key.to_string());
                        }
                    }
                }
            }
        }
    }
}


/// Flatten Feishu "post" rich text to plain text.
fn flatten_post_content(parsed: &Value) -> String {
    let content_root = parsed
        .get("zh_cn")
        .or_else(|| parsed.get("en_us"))
        .or_else(|| parsed.get("ja_jp"))
        .unwrap_or(parsed);

    let mut result = String::new();

    if let Some(title) = content_root.get("title").and_then(|t| t.as_str()) {
        if !title.is_empty() {
            result.push_str(title);
            result.push('\n');
        }
    }

    if let Some(paragraphs) = content_root.get("content").and_then(|c| c.as_array()) {
        for paragraph in paragraphs {
            if let Some(elements) = paragraph.as_array() {
                for element in elements {
                    let tag = element.get("tag").and_then(|t| t.as_str()).unwrap_or("");
                    match tag {
                        "text" => {
                            if let Some(text) = element.get("text").and_then(|t| t.as_str()) {
                                result.push_str(text);
                            }
                        }
                        "a" => {
                            if let Some(text) = element.get("text").and_then(|t| t.as_str()) {
                                result.push_str(text);
                            }
                        }
                        "at" => {
                            if let Some(name) = element.get("user_name").and_then(|n| n.as_str()) {
                                result.push('@');
                                result.push_str(name);
                            }
                        }
                        "img" => {
                            result.push_str("[image]");
                        }
                        _ => {}
                    }
                }
                result.push('\n');
            }
        }
    }

    result.trim().to_string()
}

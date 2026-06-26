use super::event::*;
use serde_json::json;
use std::collections::HashSet;

fn default_config() -> FeishuEventConfig {
    FeishuEventConfig {
        group_policy: "open".to_string(),
        dm_policy: "open".to_string(),
        require_mention: false,
        allow_from: vec![],
        bot_open_id: "bot_123".to_string(),
    }
}

fn make_dm_event(sender_id: &str, content: &str) -> serde_json::Value {
    json!({
        "header": { "event_type": "im.message.receive_v1" },
        "event": {
            "message": {
                "message_id": format!("msg_{}", rand_id()),
                "chat_id": "chat_dm_1",
                "chat_type": "p2p",
                "message_type": "text",
                "content": json!({"text": content}).to_string(),
            },
            "sender": {
                "sender_type": "user",
                "sender_id": { "open_id": sender_id },
            }
        }
    })
}

fn make_group_event(
    sender_id: &str,
    chat_id: &str,
    content: &str,
    mentions: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut message = json!({
        "message_id": format!("msg_{}", rand_id()),
        "chat_id": chat_id,
        "chat_type": "group",
        "message_type": "text",
        "content": json!({"text": content}).to_string(),
    });
    if let Some(m) = mentions {
        message["mentions"] = m;
    }
    json!({
        "header": { "event_type": "im.message.receive_v1" },
        "event": {
            "message": message,
            "sender": {
                "sender_type": "user",
                "sender_id": { "open_id": sender_id },
            }
        }
    })
}

static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn rand_id() -> u64 {
    COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

// ============================================
// Basic parsing
// ============================================

#[test]
fn parse_dm_text_message() {
    let config = default_config();
    let mut dedup = HashSet::new();
    let mut dedup_order = Vec::new();
    let payload = make_dm_event("user_001", "Hello bot!");

    let result = parse_feishu_event(
        &payload,
        "test_feishu",
        &config,
        &mut dedup,
        &mut dedup_order,
    );
    let msg = result.expect("should parse a valid DM");
    assert_eq!(msg.channel, "test_feishu");
    assert_eq!(msg.sender_id, "user_001");
    assert_eq!(msg.content, "Hello bot!");
    assert_eq!(msg.chat_id, "chat_dm_1");
}

#[test]
fn skip_non_message_event_type() {
    let config = default_config();
    let mut dedup = HashSet::new();
    let mut dedup_order = Vec::new();
    let payload = json!({
        "header": { "event_type": "im.chat.member.add_v1" },
        "event": {}
    });
    let result = parse_feishu_event(&payload, "test", &config, &mut dedup, &mut dedup_order);
    assert!(result.is_none());
}

#[test]
fn skip_bot_sender() {
    let config = default_config();
    let mut dedup = HashSet::new();
    let mut dedup_order = Vec::new();
    let payload = json!({
        "header": { "event_type": "im.message.receive_v1" },
        "event": {
            "message": {
                "message_id": "msg_bot",
                "chat_id": "chat_1",
                "chat_type": "p2p",
                "message_type": "text",
                "content": "{\"text\":\"bot reply\"}",
            },
            "sender": {
                "sender_type": "bot",
                "sender_id": { "open_id": "bot_123" },
            }
        }
    });
    let result = parse_feishu_event(&payload, "test", &config, &mut dedup, &mut dedup_order);
    assert!(result.is_none());
}

#[test]
fn skip_empty_text_content() {
    let config = default_config();
    let mut dedup = HashSet::new();
    let mut dedup_order = Vec::new();
    let payload = json!({
        "header": { "event_type": "im.message.receive_v1" },
        "event": {
            "message": {
                "message_id": "msg_empty",
                "chat_id": "chat_1",
                "chat_type": "p2p",
                "message_type": "text",
                "content": "{\"text\":\"\"}",
            },
            "sender": {
                "sender_type": "user",
                "sender_id": { "open_id": "user_1" },
            }
        }
    });
    let result = parse_feishu_event(&payload, "test", &config, &mut dedup, &mut dedup_order);
    assert!(result.is_none());
}

// ============================================
// Dedup
// ============================================

#[test]
fn dedup_skips_duplicate_message_id() {
    let config = default_config();
    let mut dedup = HashSet::new();
    let mut dedup_order = Vec::new();
    let payload = json!({
        "header": { "event_type": "im.message.receive_v1" },
        "event": {
            "message": {
                "message_id": "msg_dup_1",
                "chat_id": "chat_1",
                "chat_type": "p2p",
                "message_type": "text",
                "content": "{\"text\":\"hello\"}",
            },
            "sender": {
                "sender_type": "user",
                "sender_id": { "open_id": "user_1" },
            }
        }
    });

    let first = parse_feishu_event(&payload, "test", &config, &mut dedup, &mut dedup_order);
    assert!(first.is_some());

    let second = parse_feishu_event(&payload, "test", &config, &mut dedup, &mut dedup_order);
    assert!(second.is_none(), "duplicate message_id should be skipped");
}

#[test]
fn dedup_fifo_eviction() {
    let config = default_config();
    let mut dedup = HashSet::new();
    let mut dedup_order = Vec::new();

    for idx in 0..MAX_DEDUP_CACHE + 5 {
        let payload = json!({
            "header": { "event_type": "im.message.receive_v1" },
            "event": {
                "message": {
                    "message_id": format!("msg_evict_{}", idx),
                    "chat_id": "chat_1",
                    "chat_type": "p2p",
                    "message_type": "text",
                    "content": "{\"text\":\"msg\"}",
                },
                "sender": {
                    "sender_type": "user",
                    "sender_id": { "open_id": "user_1" },
                }
            }
        });
        let _ = parse_feishu_event(&payload, "test", &config, &mut dedup, &mut dedup_order);
    }

    assert!(
        dedup.len() <= MAX_DEDUP_CACHE,
        "dedup set should not exceed MAX_DEDUP_CACHE"
    );
}

// ============================================
// Group policies
// ============================================

#[test]
fn group_disabled_policy_blocks_all() {
    let config = FeishuEventConfig {
        group_policy: "disabled".to_string(),
        ..default_config()
    };
    let mut dedup = HashSet::new();
    let mut dedup_order = Vec::new();
    let payload = make_group_event("user_1", "group_1", "Hello", None);
    let result = parse_feishu_event(&payload, "test", &config, &mut dedup, &mut dedup_order);
    assert!(result.is_none());
}

#[test]
fn group_allowlist_blocks_unallowed() {
    let config = FeishuEventConfig {
        group_policy: "allowlist".to_string(),
        allow_from: vec!["allowed_group".to_string()],
        ..default_config()
    };
    let mut dedup = HashSet::new();
    let mut dedup_order = Vec::new();

    let blocked = make_group_event("user_1", "other_group", "Hello", None);
    assert!(parse_feishu_event(&blocked, "test", &config, &mut dedup, &mut dedup_order).is_none());

    let allowed = make_group_event("user_1", "allowed_group", "Hello", None);
    assert!(parse_feishu_event(&allowed, "test", &config, &mut dedup, &mut dedup_order).is_some());
}

#[test]
fn group_require_mention_filters_without_mention() {
    let config = FeishuEventConfig {
        require_mention: true,
        bot_open_id: "bot_123".to_string(),
        ..default_config()
    };
    let mut dedup = HashSet::new();
    let mut dedup_order = Vec::new();

    let no_mention = make_group_event("user_1", "group_1", "Hello", None);
    assert!(
        parse_feishu_event(&no_mention, "test", &config, &mut dedup, &mut dedup_order).is_none()
    );

    let with_mention = make_group_event(
        "user_1",
        "group_1",
        "Hello @bot",
        Some(json!([
            { "id": { "open_id": "bot_123" } }
        ])),
    );
    assert!(
        parse_feishu_event(&with_mention, "test", &config, &mut dedup, &mut dedup_order).is_some()
    );
}

// ============================================
// DM policies
// ============================================

#[test]
fn dm_allowlist_blocks_unallowed_sender() {
    let config = FeishuEventConfig {
        dm_policy: "allowlist".to_string(),
        allow_from: vec!["vip_user".to_string()],
        ..default_config()
    };
    let mut dedup = HashSet::new();
    let mut dedup_order = Vec::new();

    let blocked = make_dm_event("random_user", "Hi");
    assert!(parse_feishu_event(&blocked, "test", &config, &mut dedup, &mut dedup_order).is_none());

    let allowed = make_dm_event("vip_user", "Hi");
    assert!(parse_feishu_event(&allowed, "test", &config, &mut dedup, &mut dedup_order).is_some());
}

/// Regression: pre-fix the DM branch only handled `"allowlist"` and
/// silently let `"disabled"` and unknown values fall through, so users
/// who set `dm_policy = "disabled"` were still receiving DMs.
#[test]
fn dm_disabled_blocks_all_senders() {
    let config = FeishuEventConfig {
        dm_policy: "disabled".to_string(),
        ..default_config()
    };
    let mut dedup = HashSet::new();
    let mut dedup_order = Vec::new();

    let payload = make_dm_event("any_user", "Hi");
    assert!(
        parse_feishu_event(&payload, "test", &config, &mut dedup, &mut dedup_order).is_none(),
        "dm_policy = \"disabled\" must block DMs"
    );
}

/// Regression: an unknown DM policy string used to silently behave like
/// "open" for DMs — but for DMs we treat absence of policy as "open"
/// (back-compat) only via `parse_with_default`, while a *typo'd*
/// non-empty value fails closed.
#[test]
fn dm_unknown_policy_fails_closed() {
    let config = FeishuEventConfig {
        dm_policy: "alowlist".to_string(),
        ..default_config()
    };
    let mut dedup = HashSet::new();
    let mut dedup_order = Vec::new();

    let payload = make_dm_event("any_user", "Hi");
    assert!(
        parse_feishu_event(&payload, "test", &config, &mut dedup, &mut dedup_order).is_none(),
        "typo'd dm_policy must fail closed, not silently behave like \"open\""
    );
}

// ============================================
// Media extraction
// ============================================

#[test]
fn image_message_extracts_media_key() {
    let config = default_config();
    let mut dedup = HashSet::new();
    let mut dedup_order = Vec::new();
    let payload = json!({
        "header": { "event_type": "im.message.receive_v1" },
        "event": {
            "message": {
                "message_id": "msg_img_1",
                "chat_id": "chat_1",
                "chat_type": "p2p",
                "message_type": "image",
                "content": json!({"image_key": "img-v2-abc"}).to_string(),
            },
            "sender": {
                "sender_type": "user",
                "sender_id": { "open_id": "user_1" },
            }
        }
    });
    let msg = parse_feishu_event(&payload, "test", &config, &mut dedup, &mut dedup_order).unwrap();
    assert_eq!(msg.content, "[image]");
    assert_eq!(msg.media.len(), 1);
    assert_eq!(msg.media[0], "feishu:image:msg_img_1:img-v2-abc");
}

#[test]
fn post_message_extracts_embedded_image_keys() {
    let config = default_config();
    let mut dedup = HashSet::new();
    let mut dedup_order = Vec::new();
    let payload = json!({
        "header": { "event_type": "im.message.receive_v1" },
        "event": {
            "message": {
                "message_id": "msg_post_1",
                "chat_id": "chat_1",
                "chat_type": "p2p",
                "message_type": "post",
                "content": json!({
                    "zh_cn": {
                        "content": [[
                            {"tag": "text", "text": "看图"},
                            {"tag": "img", "image_key": "img-post-abc"}
                        ]]
                    }
                }).to_string(),
            },
            "sender": {
                "sender_type": "user",
                "sender_id": { "open_id": "user_1" },
            }
        }
    });
    let msg = parse_feishu_event(&payload, "test", &config, &mut dedup, &mut dedup_order).unwrap();
    assert_eq!(msg.content.trim(), "看图[image]");
    assert_eq!(msg.media.len(), 1);
    assert_eq!(msg.media[0], "feishu:image:msg_post_1:img-post-abc");
}

#[test]
fn file_message_extracts_media_key() {
    let config = default_config();
    let mut dedup = HashSet::new();
    let mut dedup_order = Vec::new();
    let payload = json!({
        "header": { "event_type": "im.message.receive_v1" },
        "event": {
            "message": {
                "message_id": "msg_file_1",
                "chat_id": "chat_1",
                "chat_type": "p2p",
                "message_type": "file",
                "content": json!({"file_key": "file-v2-xyz", "file_name": "report.pdf"}).to_string(),
            },
            "sender": {
                "sender_type": "user",
                "sender_id": { "open_id": "user_1" },
            }
        }
    });
    let msg = parse_feishu_event(&payload, "test", &config, &mut dedup, &mut dedup_order).unwrap();
    assert_eq!(msg.content, "[file: report.pdf]");
    assert_eq!(msg.media.len(), 1);
    assert_eq!(msg.media[0], "feishu:file:file-v2-xyz");
}

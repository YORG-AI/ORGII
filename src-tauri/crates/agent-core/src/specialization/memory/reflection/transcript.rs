//! Transcript building for the reflection write path.
//!
//! Loads `user`/`assistant` rows from `agent_messages` and renders them as a
//! single tail-biased string suitable for an LLM extraction call. Tool turns
//! are deliberately excluded — see [`build_transcript`].

use crate::foundation::persistence::db_helpers::message_role;
use regex::RegexSet;
use std::sync::OnceLock;

/// 结构性噪音行模式（迁移自 OpenClaw NoiseFilter，B4 噪音剥离补强）。
///
/// ORG-2 自带噪音去除只有 `MIN_TRANSCRIPT_LEN` + role 过滤（很粗），
/// 不会剥离飞书/OpenClaw 注入的结构性噪音行。这些行若进 reflection transcript，
/// 会被模型当成对话内容学进 learning（状态栏被当"用户说的话"）。
///
/// 逐行匹配：命中任一模式的行会被丢弃，剩余行重组后才进 transcript。
const NOISE_LINE_PATTERNS: &[&str] = &[
    r"^\[STATUS BAR\]",                           // 状态栏指令
    r"^\s*📊\s*等效[:：]",                        // 状态栏正文
    r"^Conversation info \(untrusted metadata\)", // 飞书元数据块
    r"^Feishu\[[^\]]*\] DM from ",                // 飞书 DM 信封头
    r"^System:.*Feishu\[[^\]]*\] DM",             // System 包裹的飞书信封
    r"^System:.*Exec (completed|failed)",         // Exec 完成回灌
    r"^\[message_id:\s*om_",                      // 飞书 message_id
    r"^\s*NO_REPLY\s*$",                          // 静默回复标记
    r"^\s*HEARTBEAT_OK\s*$",                      // 心跳 ack
    r"^\[\[\s*reply_to(_current)?\s*[:\]]",       // reply tag
    r"^\[Memory V3 相关记忆\]",                   // Memory V3 注入块
    r"^\[/Memory V3\]",
    r"^【User Traits】", // 画像注入
    r"^【Current Context】",
];

fn noise_set() -> &'static RegexSet {
    static SET: OnceLock<RegexSet> = OnceLock::new();
    SET.get_or_init(|| RegexSet::new(NOISE_LINE_PATTERNS).expect("noise patterns must compile"))
}

/// 剥离 content 中的结构性噪音行；返回清洗后的内容（保留非噪音行原文）。
///
/// 不做语义压缩、不改非噪音行内容（遵守"原话保真"铁律：只删纯噪音行，
/// 用户纠正/正文一字不动）。
fn strip_noise_lines(content: &str) -> String {
    let set = noise_set();
    let kept: Vec<&str> = content
        .lines()
        .filter(|line| !set.is_match(line.trim_start()))
        .collect();
    kept.join("\n")
}

/// Minimum transcript length to trigger reflection (chars).
///
/// Transcript is now user+assistant only (tool turns are excluded — they're
/// covered by L2 workspace memory / extract_memories), so this threshold filters
/// out trivially-short exchanges that have no durable behavioral signal.
pub(super) const MIN_TRANSCRIPT_LEN: usize = 200;

/// Total transcript byte cap fed to the reflection LLM. Tail-biased: when
/// the conversation exceeds this cap we drop the head (oldest turns) and
/// keep the tail (most recent exchange + session conclusion) because insights
/// about *how the session went* concentrate at the end, not the beginning.
///
/// This replaces the previous per-message byte truncation (2000 user/assistant,
/// 800 tool_input, 500 tool_output) which caused the reflection model to see
/// only the head bytes of every message — including sandbox paths, e2e test
/// IDs, and tool schema errors that then leaked into "learnings". See
/// `docs/agent/audit-fallbacks-0421.md` for the 14 polluted rows this
/// caused before 0421.
pub(super) const TRANSCRIPT_TOTAL_CAP: usize = 16_000;

/// Build a condensed transcript from session messages.
///
/// Only `user` and `assistant` turns are included. `tool_call` / `tool_result`
/// rows are deliberately excluded: durable L3 insights (user preferences,
/// correction patterns, cross-session strategies) live in the natural-language
/// turns, while tool-level detail (file paths, shell output, schema errors)
/// is noise at this layer and is already captured by L2 workspace memory and
/// `extract_memories`. Earlier revisions of this function included tool rows
/// and truncated each one to the first N bytes, which is exactly how the
/// "e2e-orch-…", "sandbox-…", and "missing additionalProperties" artifacts
/// leaked into `learnings` rows.
///
/// This is the same shape mem0's `parse_messages` and memU's
/// `format_conversation_for_preprocess` produce — per-message lines, no
/// per-message byte truncation. A single total-length cap is applied at the
/// end, tail-biased so the tail of the session (where conclusions and
/// corrections typically surface) is always preserved.
pub fn build_transcript(conn: &rusqlite::Connection, session_id: &str) -> Result<String, String> {
    let mut stmt = conn
        .prepare(
            "SELECT role, content
             FROM agent_messages
             WHERE session_id = ?1 AND role IN (?2, ?3)
             ORDER BY sequence ASC",
        )
        .map_err(|e| format!("Query failed: {}", e))?;

    let rows = stmt
        .query_map(
            rusqlite::params![session_id, message_role::USER, message_role::ASSISTANT],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| format!("Query failed: {}", e))?;

    let mut transcript = String::new();
    for (role, content) in rows.filter_map(Result::ok) {
        append_transcript_line(&mut transcript, &role, &content);
    }

    Ok(trim_head_to_cap(&transcript, TRANSCRIPT_TOTAL_CAP))
}

fn append_transcript_line(transcript: &mut String, role: &str, content: &str) {
    let label = match role {
        message_role::USER => "User",
        message_role::ASSISTANT => "Assistant",
        _ => return,
    };
    // B4: 先剥离结构性噪音行（状态栏/System信封/message_id/HEARTBEAT_OK 等），
    // 再判空。避免噪音被当对话内容学进 learning。
    let cleaned = strip_noise_lines(content);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return;
    }
    transcript.push_str(label);
    transcript.push_str(": ");
    transcript.push_str(trimmed);
    transcript.push_str("\n\n");
}

/// Trim the *head* of `text` so the byte length fits within `cap`, snapping
/// the cut to a UTF-8 character boundary. Never byte-indexes inside a multi-
/// byte codepoint.
fn trim_head_to_cap(text: &str, cap: usize) -> String {
    if text.len() <= cap {
        return text.to_string();
    }
    let start_byte = text.len() - cap;
    let mut boundary = start_byte;
    while boundary < text.len() && !text.is_char_boundary(boundary) {
        boundary += 1;
    }
    text[boundary..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_transcript_line_keeps_user_and_assistant_only() {
        let mut out = String::new();
        append_transcript_line(&mut out, message_role::USER, "hello world");
        append_transcript_line(&mut out, message_role::ASSISTANT, "hi there");
        append_transcript_line(&mut out, message_role::TOOL_CALL, "should be dropped");
        append_transcript_line(&mut out, message_role::TOOL_RESULT, "should be dropped");
        append_transcript_line(&mut out, "unknown_role", "also dropped");
        assert!(out.contains("User: hello world"));
        assert!(out.contains("Assistant: hi there"));
        assert!(!out.contains("should be dropped"));
        assert!(!out.contains("also dropped"));
        assert!(!out.contains("Tool Call"));
        assert!(!out.contains("Tool Result"));
    }

    #[test]
    fn append_transcript_line_skips_empty_and_whitespace_content() {
        let mut out = String::new();
        append_transcript_line(&mut out, message_role::USER, "");
        append_transcript_line(&mut out, message_role::USER, "   \n\t  ");
        assert_eq!(out, "");
    }

    #[test]
    fn strip_noise_lines_removes_structural_noise_keeps_content() {
        // 混合：噪音行 + 真实正文 + 用户纠正（必须保真）
        let raw = "[STATUS BAR] 本条回复末尾追加状态栏\n\
                   📊 等效: 744k (74%) · 压缩: 0次\n\
                   不对，你这个路径用错了，应该用 /mnt/share_88\n\
                   [message_id: om_x100b6c9f8f4]\n\
                   System: [2026-06-24] Feishu[default] DM from ou_xxx: 继续\n\
                   NO_REPLY\n\
                   HEARTBEAT_OK\n\
                   这是真正的方案正文。";
        let cleaned = strip_noise_lines(raw);
        // 噪音被删
        assert!(!cleaned.contains("STATUS BAR"));
        assert!(!cleaned.contains("📊 等效"));
        assert!(!cleaned.contains("message_id"));
        assert!(!cleaned.contains("Feishu[default] DM"));
        assert!(!cleaned.contains("NO_REPLY"));
        assert!(!cleaned.contains("HEARTBEAT_OK"));
        // 正文 + 用户纠正原话保真
        assert!(cleaned.contains("不对，你这个路径用错了，应该用 /mnt/share_88"));
        assert!(cleaned.contains("这是真正的方案正文。"));
    }

    #[test]
    fn append_transcript_line_strips_noise_before_append() {
        let mut out = String::new();
        // 纯噪音内容 → append 后应为空（剥离后 trimmed 为空）
        append_transcript_line(
            &mut out,
            message_role::USER,
            "[STATUS BAR] x\n📊 等效: 0k\nNO_REPLY",
        );
        assert_eq!(out, "", "pure-noise message must yield empty transcript");
        // 噪音 + 正文 → 只保留正文
        append_transcript_line(
            &mut out,
            message_role::ASSISTANT,
            "HEARTBEAT_OK\n实际回复内容",
        );
        assert!(out.contains("Assistant: 实际回复内容"));
        assert!(!out.contains("HEARTBEAT_OK"));
    }

    #[test]
    fn trim_head_to_cap_returns_input_when_under_cap() {
        let s = "hello";
        assert_eq!(trim_head_to_cap(s, 100), "hello");
    }

    #[test]
    fn trim_head_to_cap_drops_head_not_tail() {
        let input: String = "A".repeat(100) + &"B".repeat(100);
        let out = trim_head_to_cap(&input, 50);
        assert_eq!(out.len(), 50);
        assert!(
            out.chars().all(|c| c == 'B'),
            "tail-biased trim must keep trailing bytes"
        );
    }

    #[test]
    fn trim_head_to_cap_respects_utf8_boundaries() {
        let input = "a".to_string() + &"✓".repeat(20);
        let out = trim_head_to_cap(&input, 10);
        assert!(
            out.chars().all(|c| c == '✓'),
            "must never byte-index into a multi-byte codepoint — got: {:?}",
            out
        );
    }
}

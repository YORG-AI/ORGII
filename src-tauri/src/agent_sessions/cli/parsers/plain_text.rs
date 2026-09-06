//! Plain-text CLI output parser.
//!
//! Some non-interactive harness profiles, including Antigravity `--print`,
//! write only the final assistant response to stdout. Buffer it and emit one
//! complete assistant chunk when the process exits.

use core_types::activity::ActivityChunk;

use super::types::TokenUsage;
use super::CliAgentParser;

pub struct PlainTextParser {
    session_id: String,
    output: String,
}

impl PlainTextParser {
    pub fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            output: String::new(),
        }
    }
}

impl CliAgentParser for PlainTextParser {
    fn parse_line(&mut self, line: &str) -> Vec<ActivityChunk> {
        if !self.output.is_empty() {
            self.output.push('\n');
        }
        self.output.push_str(line);
        Vec::new()
    }

    fn on_exit(&mut self, exit_code: i32) -> Vec<ActivityChunk> {
        let mut chunks = Vec::new();
        if !self.output.is_empty() {
            let content = std::mem::take(&mut self.output);
            let mut assistant = ActivityChunk::new(&self.session_id, "assistant", "message");
            assistant.result = serde_json::json!({
                "observation": content,
                "content": content,
                "role": "assistant",
                "is_delta": false,
                "is_full_content": true,
            });
            chunks.push(assistant);
        }

        let mut session_end = ActivityChunk::new(&self.session_id, "session_end", "session_end");
        session_end.result = serde_json::json!({
            "success": exit_code == 0,
            "exit_code": exit_code,
        });
        chunks.push(session_end);
        chunks
    }

    fn token_usage(&self) -> Option<TokenUsage> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffers_plain_text_until_exit() {
        let mut parser = PlainTextParser::new("session-1");
        assert!(parser.parse_line("First line").is_empty());
        assert!(parser.parse_line("Second line").is_empty());

        let chunks = parser.on_exit(0);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].action_type, "assistant");
        assert_eq!(
            chunks[0]
                .result
                .get("content")
                .and_then(|value| value.as_str()),
            Some("First line\nSecond line")
        );
        assert_eq!(
            chunks[1]
                .result
                .get("success")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
    }
}

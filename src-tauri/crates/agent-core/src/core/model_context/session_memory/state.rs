//! Per-session mutable state for session memory.

/// Per-session state for session memory.
#[derive(Debug, Clone, Default)]
pub struct SessionMemoryState {
    /// Current SM markdown content (`None` = never extracted).
    pub content: Option<String>,
    /// Durable start-sequence of the last message summarized into SM.
    /// Frame-independent: extraction (bounded durable suffix) and SM-compact
    /// (in-turn tail) each resolve it to an index in their own array.
    pub last_summarized_seq: Option<i64>,
    /// Total context tokens at the time of the last extraction.
    pub tokens_at_last_extraction: usize,
    /// Tool calls seen since the last extraction.
    pub tool_calls_since_extraction: usize,
    /// Whether the initialization threshold has been met at least once.
    pub initialized: bool,
    /// Guards against concurrent extractions.
    pub extraction_in_progress: bool,
}

impl SessionMemoryState {
    /// Record that tool calls happened (increment counter).
    pub fn record_tool_calls(&mut self, count: usize) {
        self.tool_calls_since_extraction += count;
    }
}

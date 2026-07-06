use std::collections::HashMap;

use crate::providers::traits::{ProviderStreamEvent, StreamDelta, ToolCallDelta};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FlushReason {
    BeforeTool,
    TurnEnd,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NormalizedStreamEvent {
    MessageDelta(String),
    ThinkingDelta(String),
    ToolCallDelta(ToolCallDelta),
    Finish {
        finish_reason: String,
        usage: Option<HashMap<String, i64>>,
    },
    FlushSegment(FlushReason),
    UnknownFrame {
        provider: String,
        event_type: String,
        sample: String,
    },
}

#[derive(Debug, Default)]
pub(crate) struct TurnStreamNormalizer {
    current_segment: Option<StreamSegmentKind>,
    unknown_frame_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamSegmentKind {
    Message,
    Thinking,
}

impl TurnStreamNormalizer {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn ingest_delta(&mut self, delta: StreamDelta) -> Vec<NormalizedStreamEvent> {
        // Most deltas carry exactly one field (content OR reasoning OR tool_call_delta).
        // Pre-allocating capacity=1 avoids the reallocation on the first push in the
        // common case and keeps the fast path to a single small heap alloc.
        let mut events = Vec::with_capacity(1);
        if let Some(text) = delta.content {
            events.extend(self.ingest_event(ProviderStreamEvent::MessageDelta { text }));
        }
        if let Some(text) = delta.reasoning {
            events.extend(self.ingest_event(ProviderStreamEvent::ThinkingDelta { text }));
        }
        if let Some(tool_delta) = delta.tool_call_delta {
            events.extend(
                self.ingest_event(ProviderStreamEvent::ToolCallDelta { delta: tool_delta }),
            );
        }
        if let Some(finish_reason) = delta.finish_reason {
            events.extend(self.ingest_event(ProviderStreamEvent::Complete {
                finish_reason,
                usage: delta.usage,
            }));
        }
        events
    }

    pub(crate) fn ingest_event(
        &mut self,
        event: ProviderStreamEvent,
    ) -> Vec<NormalizedStreamEvent> {
        // Capacity=2 covers the flush+event pair emitted when a tool delta
        // follows message/thinking content; single-event paths never reallocate.
        let mut events = Vec::with_capacity(2);
        match event {
            ProviderStreamEvent::MessageDelta { text } => {
                if !text.is_empty() {
                    self.current_segment = Some(StreamSegmentKind::Message);
                    events.push(NormalizedStreamEvent::MessageDelta(text));
                }
            }
            ProviderStreamEvent::ThinkingDelta { text } => {
                if !text.is_empty() {
                    self.current_segment = Some(StreamSegmentKind::Thinking);
                    events.push(NormalizedStreamEvent::ThinkingDelta(text));
                }
            }
            ProviderStreamEvent::ToolCallDelta { delta } => {
                self.flush_before_tool(&mut events);
                events.push(NormalizedStreamEvent::ToolCallDelta(delta));
            }
            ProviderStreamEvent::ToolCallStart { index, id, name } => {
                self.flush_before_tool(&mut events);
                events.push(NormalizedStreamEvent::ToolCallDelta(ToolCallDelta {
                    index,
                    id: Some(id),
                    name: Some(name),
                    arguments_delta: None,
                }));
            }
            ProviderStreamEvent::ToolCallReady {
                index,
                id,
                name,
                arguments,
            } => {
                self.flush_before_tool(&mut events);
                events.push(NormalizedStreamEvent::ToolCallDelta(ToolCallDelta {
                    index,
                    id: Some(id),
                    name: Some(name),
                    arguments_delta: Some(arguments),
                }));
            }
            ProviderStreamEvent::FlushSegment { reason } => {
                self.current_segment = None;
                events.push(NormalizedStreamEvent::FlushSegment(match reason {
                    crate::providers::traits::ProviderFlushReason::BeforeTool => {
                        FlushReason::BeforeTool
                    }
                    crate::providers::traits::ProviderFlushReason::TurnEnd => FlushReason::TurnEnd,
                }));
            }
            ProviderStreamEvent::Complete {
                finish_reason,
                usage,
            } => {
                self.current_segment = None;
                events.push(NormalizedStreamEvent::FlushSegment(FlushReason::TurnEnd));
                events.push(NormalizedStreamEvent::Finish {
                    finish_reason,
                    usage,
                });
            }
            ProviderStreamEvent::UnknownFrame {
                provider,
                event_type,
                sample,
            } => {
                self.unknown_frame_count += 1;
                events.push(NormalizedStreamEvent::UnknownFrame {
                    provider,
                    event_type,
                    sample,
                });
            }
        }
        events
    }

    #[cfg(test)]
    fn unknown_frame_count(&self) -> usize {
        self.unknown_frame_count
    }

    fn flush_before_tool(&mut self, events: &mut Vec<NormalizedStreamEvent>) {
        if self.current_segment.take().is_some() {
            events.push(NormalizedStreamEvent::FlushSegment(FlushReason::BeforeTool));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flushes_message_before_tool_delta() {
        let mut normalizer = TurnStreamNormalizer::new();
        assert_eq!(
            normalizer.ingest_event(ProviderStreamEvent::MessageDelta {
                text: "hello".to_string(),
            }),
            vec![NormalizedStreamEvent::MessageDelta("hello".to_string())]
        );

        let events = normalizer.ingest_event(ProviderStreamEvent::ToolCallStart {
            index: 0,
            id: "call_1".to_string(),
            name: "read_file".to_string(),
        });

        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[0],
            NormalizedStreamEvent::FlushSegment(FlushReason::BeforeTool)
        ));
        assert!(matches!(events[1], NormalizedStreamEvent::ToolCallDelta(_)));
    }

    #[test]
    fn counts_unknown_frames_without_blocking_completion() {
        let mut normalizer = TurnStreamNormalizer::new();
        let unknown = normalizer.ingest_event(ProviderStreamEvent::UnknownFrame {
            provider: "codex_native".to_string(),
            event_type: "response.future.delta".to_string(),
            sample: "{\"type\":\"response.future.delta\"}".to_string(),
        });
        let complete = normalizer.ingest_event(ProviderStreamEvent::Complete {
            finish_reason: "stop".to_string(),
            usage: None,
        });

        assert_eq!(normalizer.unknown_frame_count(), 1);
        assert!(matches!(
            unknown[0],
            NormalizedStreamEvent::UnknownFrame { .. }
        ));
        assert!(complete.iter().any(|event| matches!(
            event,
            NormalizedStreamEvent::Finish { finish_reason, .. } if finish_reason == "stop"
        )));
    }
}

use conversation_portability::{
    PortableContentBlock, PortableConversation, PortableEventBody, PortableRole,
    PortableToolCallState,
};
use serde_json::Value;

use crate::{NativeMaterializationError, NativeMaterializationResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NativeSemanticEvent {
    Message {
        role: PortableRole,
        content: Vec<PortableContentBlock>,
    },
    ToolCall {
        call_id: String,
        name: String,
        state: PortableToolCallState,
        input: Value,
    },
    ToolResult {
        call_id: String,
        content: Vec<PortableContentBlock>,
        is_error: bool,
    },
    CompactionSummary {
        content: Vec<PortableContentBlock>,
    },
    CompactionBoundary {
        content: Vec<PortableContentBlock>,
    },
}

/// One native source record's ordered, model-visible blocks. Provider record
/// ids/ordinals are provenance and are not copied to the target; the group
/// boundary itself is continuation semantics (for example Claude
/// text/tool_use/text in one assistant message).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeSemanticGroup {
    pub(crate) events: Vec<NativeSemanticEvent>,
}

/// Projection provenance (event ids, source ordinals/threads/timestamps and
/// canonical tool aliases) remains in the portable checkpoint. Native replay
/// parity covers the ordered model-visible history: exact roles/content,
/// native source-record grouping, tool name/input/state/linkage/result, and
/// compaction boundaries/summaries.
pub(crate) fn portable_semantics(
    conversation: &PortableConversation,
) -> NativeMaterializationResult<Vec<NativeSemanticGroup>> {
    conversation
        .require_materializable_continuation()
        .map_err(NativeMaterializationError::invalid)?;

    let mut groups = Vec::<(NativeSourceGroupKey, NativeSemanticGroup)>::new();
    for event in &conversation.events {
        let semantics = match &event.body {
            PortableEventBody::Message { role, content } => Ok(content
                .iter()
                .cloned()
                .map(|block| NativeSemanticEvent::Message {
                    role: *role,
                    content: vec![block],
                })
                .collect::<Vec<_>>()),
            PortableEventBody::ToolCall {
                call_id,
                name,
                state,
                input,
                ..
            } => Ok(vec![NativeSemanticEvent::ToolCall {
                call_id: call_id.clone(),
                name: name.clone(),
                state: *state,
                input: input.clone(),
            }]),
            PortableEventBody::ToolResult {
                call_id,
                content,
                is_error,
            } => Ok(vec![NativeSemanticEvent::ToolResult {
                call_id: call_id.clone(),
                content: content.clone(),
                is_error: *is_error,
            }]),
            PortableEventBody::CompactionSummary { content } => {
                Ok(vec![NativeSemanticEvent::CompactionSummary {
                    content: content.clone(),
                }])
            }
            PortableEventBody::CompactionBoundary { content } => {
                Ok(vec![NativeSemanticEvent::CompactionBoundary {
                    content: content.clone(),
                }])
            }
            PortableEventBody::Annotation { .. } => {
                Err(NativeMaterializationError::unsupported_semantics(
                    "Source annotations have no verified native continuation representation",
                ))
            }
        }?;
        let group_key = NativeSourceGroupKey {
            source_record_index: event.source_record_index,
            source_record_type: event.source_record_type.clone(),
            source_record_id: event.source_record_id.clone(),
        };
        if let Some((previous_key, group)) = groups.last_mut() {
            if *previous_key == group_key {
                group.events.extend(semantics);
                continue;
            }
        }
        groups.push((group_key, NativeSemanticGroup { events: semantics }));
    }
    Ok(groups.into_iter().map(|(_, group)| group).collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeSourceGroupKey {
    source_record_index: u64,
    source_record_type: Option<String>,
    source_record_id: Option<String>,
}

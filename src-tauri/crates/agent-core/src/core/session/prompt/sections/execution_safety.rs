//! Sections governing how actions are taken and how context is reclaimed:
//! command approval and function-result clearing.

use crate::core::session::prompt::cache::PromptCachePolicy;
use crate::core::session::prompt::registry::{order, AppliesDecision, PromptCtx, PromptSection};
use crate::core::session::prompt::section_builders::*;

// ---------------------------------------------------------------------
// 170. Command approval — non-channel only
// ---------------------------------------------------------------------

pub struct CommandApprovalSection;

impl PromptSection for CommandApprovalSection {
    fn id(&self) -> &'static str {
        "command_approval"
    }
    fn order_hint(&self) -> i32 {
        order::COMMAND_APPROVAL
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.is_channel_session {
            AppliesDecision::Skip {
                reason: "channel_session_no_command_approval",
            }
        } else {
            AppliesDecision::Apply {
                reason: "non_channel_session",
            }
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, _ctx: &PromptCtx) -> Option<String> {
        Some(build_command_approval_section())
    }
}

// ---------------------------------------------------------------------
// 180. Function-result clearing — context management
// ---------------------------------------------------------------------

pub struct FunctionResultClearingSection;

impl PromptSection for FunctionResultClearingSection {
    fn id(&self) -> &'static str {
        "function_result_clearing"
    }
    fn order_hint(&self) -> i32 {
        order::FUNCTION_RESULT_CLEARING
    }
    fn applies(&self, _ctx: &PromptCtx) -> AppliesDecision {
        AppliesDecision::Apply { reason: "always" }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, _ctx: &PromptCtx) -> Option<String> {
        Some(build_function_result_clearing_section())
    }
}

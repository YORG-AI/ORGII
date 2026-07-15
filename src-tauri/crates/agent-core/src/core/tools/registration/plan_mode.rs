//! Plan-mode tool registration: `create_plan` writes the plan file AND
//! submits it for approval in a single step.
//!
//! The tool is only registered when the session provides a
//! `plan_slot_cache` (coding capability). Subagents never reach this
//! tool — `create_plan` is in `SUBAGENT_FORBIDDEN_TOOLS`, and their
//! inherited policy layer hard-denies it (subagents cannot enter plan
//! mode). `plan_approval_manager` is still typed as `Option` because a
//! non-coding custom agent definition could theoretically register the
//! tool without a manager; `create_plan::execute` errors out loudly in
//! that case rather than writing an unsubmittable plan file.

use std::collections::HashSet;
use std::sync::Arc;

use crate::tools::impls::plan_mode::create_plan::{CreatePlanTool, CreatePlanToolContext};
use crate::tools::registry::ToolRegistry;

use super::{register_if_enabled, ToolDeps};

pub fn register(registry: &mut ToolRegistry, deps: &ToolDeps, disabled: &HashSet<String>) {
    let Some(ref slot_cache) = deps.plan_slot_cache else {
        return;
    };

    let create_ctx = Arc::new(CreatePlanToolContext::new(
        slot_cache.clone(),
        deps.plan_approval_manager.clone(),
        deps.agent_org_context.clone(),
        deps.agent_org_current_member_id.clone(),
        deps.app_handle.clone(),
    ));
    register_if_enabled(
        registry,
        Box::new(CreatePlanTool::new(create_ctx)),
        disabled,
    );
}

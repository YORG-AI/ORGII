//! First-class `skill` tool — atomic SKILL.md expansion.
//!
//! Replaces the two-step "scan listing → read_file the SKILL.md" flow the
//! per-turn skill listing used to ask for. Models routinely skipped the
//! second step; a dedicated tool with blocking-requirement wording (the
//! reference agent's proven pattern) makes invocation a single atomic act.
//! The listing (delta names + descriptions) still rides the dynamic
//! sections; this tool turns a listed name into the full body.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::session::workspace::SessionWorkspace;
use crate::skills::loader::SkillsLoader;
use crate::tools::names as tool_names;
use crate::tools::traits::{CallContext, Tool, ToolError};

pub struct SkillTool {
    workspace: Arc<parking_lot::RwLock<SessionWorkspace>>,
    load_workspace_resources: bool,
    agent_id: Option<String>,
}

impl SkillTool {
    pub fn new(
        workspace: Arc<parking_lot::RwLock<SessionWorkspace>>,
        load_workspace_resources: bool,
        agent_id: Option<String>,
    ) -> Self {
        Self {
            workspace,
            load_workspace_resources,
            agent_id,
        }
    }

    fn build_loader(&self) -> SkillsLoader {
        let skills_dir = self.workspace.read().working_dir().join(".orgii");
        let mut loader = SkillsLoader::new(&skills_dir)
            .with_builtin_dir(crate::skills::loader::global_skills_dir())
            .with_load_workspace_resources(self.load_workspace_resources);
        if let Some(ref agent_id) = self.agent_id {
            loader = loader.with_agent_id(agent_id.clone());
        }
        loader
    }
}

#[async_trait]
impl Tool for SkillTool {
    fn name(&self) -> &str {
        tool_names::SKILL
    }

    fn description(&self) -> &str {
        "Load a skill's full instructions by name. \
         BLOCKING REQUIREMENT: when a listed skill matches the current task, invoke this tool \
         BEFORE doing any other work on that task — skills encode workspace-specific workflows \
         and conventions that override your defaults. \
         NEVER mention a skill or claim to follow it without actually calling this tool first. \
         Names come from the 'Skills relevant to your task' listing. \
         Invoke at most one skill per task (the most specific match)."
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn is_read_only(&self) -> bool {
        true
    }

    /// SKILL.md bodies are load-bearing — the model must follow the FULL
    /// text, so persistence stays off (a disk stub would hide the
    /// instructions). 100K chars (~25K tokens) is still generous headroom;
    /// skills larger than that should point the model at files to read
    /// with offset/limit rather than inlining everything.
    fn output_budget(&self) -> usize {
        100_000
    }

    fn allow_persisted_output(&self) -> bool {
        false
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "skill": {
                    "type": "string",
                    "description": "Skill name exactly as it appears in the skill listing."
                }
            },
            "required": ["skill"]
        })
    }

    async fn execute_text(&self, params: Value, ctx: &CallContext) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let name = params
            .get("skill")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ToolError::InvalidParams("missing field 'skill'".to_string()))?;

        // Path-safe: skill names are directory names under the skills roots.
        if name.contains('/') || name.contains('\\') || name.contains("..") {
            return Err(ToolError::InvalidParams(format!(
                "invalid skill name: {name}"
            )));
        }

        let loader = self.build_loader();
        match loader.load_skill_with_path(name) {
            Some((content, skill_md_path)) => {
                // Skills reference bundled files (scripts/, references/, assets/)
                // relative to their own directory; without the base dir the model
                // cannot resolve them. Binary-embedded builtins have no dir.
                let base_dir_line = skill_md_path
                    .as_deref()
                    .and_then(std::path::Path::parent)
                    .map(|dir| format!("Base directory for this skill: {}\n\n", dir.display()))
                    .unwrap_or_default();
                Ok(format!(
                    "## Skill: {name}\n\n{base_dir_line}{content}\n\n\
                     Apply these instructions to the current task now. They take precedence over \
                     your default approach for the areas they cover."
                ))
            }
            None => {
                let available = loader
                    .build_skill_listing_entries(&[], None)
                    .into_iter()
                    .map(|entry| entry.name)
                    .collect::<Vec<_>>()
                    .join(", ");
                Err(ToolError::ExecutionFailed(format!(
                    "Skill not found: {name}. Available skills: {available}"
                )))
            }
        }
    }
}

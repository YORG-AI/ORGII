//! Skill Discovery Prefetch — selects relevant skills via side-query and
//! injects their full content into the system prompt.
//!
//! Instead of listing skill summaries and requiring the agent to
//! `read_file` a SKILL.md, this module proactively selects the most
//! relevant skill(s) for the current user message and injects the full
//! content directly.
//!
//! ## Flow
//!
//! 1. At turn start, `select_skills()` sends a side-query with skill summaries
//!    and the user's latest message
//! 2. The LLM responds with skill names that are relevant
//! 3. Selected skills have their full SKILL.md content loaded
//! 4. Content is injected as a prompt section in the system prompt
//!
//! ## Fallback
//!
//! If the side-query fails or returns no results, falls back to the normal
//! summary-based skill listing (no regression).

use std::path::Path;

use serde_json::Value;
use tracing::{info, warn};

use super::loader::SkillInfo;
use super::loader::SkillsLoader;
use crate::core::side_query::{self, SideQueryConfig};
use crate::providers::traits::LLMProvider;

/// Maximum number of skills to inject (prevents context bloat).
const MAX_PREFETCH_SKILLS: usize = 3;

/// Maximum tokens for the selection side-query response.
const SELECTION_MAX_TOKENS: u32 = 256;

/// Result of skill prefetch.
#[derive(Debug, Clone)]
pub struct PrefetchResult {
    /// Names of selected skills.
    pub selected_names: Vec<String>,
    /// Full SKILL.md content for each selected skill.
    pub skill_contents: Vec<PrefetchedSkill>,
    /// Side-query tokens used.
    pub tokens_used: i64,
}

#[derive(Debug, Clone)]
pub struct PrefetchedSkill {
    pub name: String,
    pub source: String,
    pub path: String,
    pub content: String,
}

impl PrefetchResult {
    /// Build a prompt section from prefetched skills.
    pub fn build_prompt_section(&self) -> Option<String> {
        if self.skill_contents.is_empty() {
            return None;
        }

        let mut parts = Vec::new();
        for skill in &self.skill_contents {
            parts.push(format!(
                "### Skill: {}\n\nSource: {}\nPath: `{}`\nContent already prefetched; do not try to read a guessed skill path for this skill.\n\n{}",
                skill.name,
                skill.source,
                skill.path,
                skill.content.trim()
            ));
        }

        Some(format!(
            "# Prefetched Skills (auto-selected as relevant to this task)\n\n\
             Follow the instructions in these skills. They encode workspace-specific \
             conventions and workflows.\n\n{}",
            parts.join("\n\n---\n\n")
        ))
    }
}

/// Build the side-query prompt for skill selection.
fn build_selection_query(user_message: &str, skills: &[SkillInfo]) -> String {
    let mut lines = Vec::new();
    for skill in skills {
        let desc = if skill.description.is_empty() {
            "No description"
        } else {
            &skill.description
        };
        lines.push(format!("- {}: {}", skill.name, desc));
    }

    format!(
        "You are a skill selector. Given the user's task and a list of available skills, \
         select the skills that are directly relevant. Return ONLY the skill names, \
         one per line, with no other text. If no skills are relevant, return \"NONE\".\n\n\
         Available skills:\n{}\n\n\
         User's task:\n{}",
        lines.join("\n"),
        user_message
    )
}

/// Select relevant skills for the user's message via a side-query.
///
/// Returns a `PrefetchResult` with selected skill names and their full content.
/// On failure, returns an empty result (graceful fallback).
#[allow(clippy::too_many_arguments)]
// These values come from distinct runtime owners; wrapping them solely for
// this call would create a relay request with no additional invariant.
pub async fn select_skills(
    provider: &dyn LLMProvider,
    user_message: &str,
    workspace: &Path,
    model: &str,
    disabled_skills: &[String],
    source_dirs: &[String],
    agent_id: &str,
    load_workspace_resources: bool,
) -> PrefetchResult {
    let empty_result = PrefetchResult {
        selected_names: Vec::new(),
        skill_contents: Vec::new(),
        tokens_used: 0,
    };

    // Load available skills
    let loader = SkillsLoader::new(workspace)
        .with_builtin_dir(super::loader::global_skills_dir())
        .with_extra_source_dirs(source_dirs)
        .with_disabled_skills(disabled_skills.to_vec())
        .with_agent_id(agent_id.to_string())
        .with_load_workspace_resources(load_workspace_resources);

    let all_skills: Vec<SkillInfo> = loader
        .list_skills()
        .into_iter()
        .filter(|s| s.enabled && s.available && !s.always)
        .collect();

    if all_skills.is_empty() {
        return empty_result;
    }

    // Build and execute the selection side-query
    let query = build_selection_query(user_message, &all_skills);
    let config = SideQueryConfig {
        model: Some(model.to_string()),
        max_tokens: SELECTION_MAX_TOKENS,
        temperature: 0.0,
        system_prompt: None,
        ..Default::default()
    };

    let user_msg = serde_json::json!({
        "role": "user",
        "content": query,
    });

    let result = match side_query::side_query(provider, &[user_msg], &config, model).await {
        Ok(result) => result,
        Err(err) => {
            warn!("[skill-prefetch] Side-query failed: {}", err);
            return empty_result;
        }
    };

    let tokens_used = result.prompt_tokens + result.completion_tokens;

    // Parse selected skill names from the response
    let response_text = result.content.trim();
    if response_text == "NONE" || response_text.is_empty() {
        info!("[skill-prefetch] No relevant skills found");
        return PrefetchResult {
            selected_names: Vec::new(),
            skill_contents: Vec::new(),
            tokens_used,
        };
    }

    let selected_names: Vec<String> = response_text
        .lines()
        .map(|line| line.trim().trim_start_matches("- ").trim().to_string())
        .filter(|name| !name.is_empty())
        .take(MAX_PREFETCH_SKILLS)
        .collect();

    // Validate and load selected skills
    let valid_names: std::collections::HashSet<String> =
        all_skills.iter().map(|s| s.name.clone()).collect();

    let mut skill_contents: Vec<PrefetchedSkill> = Vec::new();
    for name in &selected_names {
        if !valid_names.contains(name) {
            warn!(
                "[skill-prefetch] LLM returned unknown skill '{}', skipping",
                name
            );
            continue;
        }

        if let Some(skill) = all_skills.iter().find(|s| s.name == *name) {
            match std::fs::read_to_string(&skill.path) {
                Ok(content) => {
                    info!(
                        "[skill-prefetch] Loaded skill '{}' ({} chars)",
                        name,
                        content.len()
                    );
                    skill_contents.push(PrefetchedSkill {
                        name: name.clone(),
                        source: skill.source.clone(),
                        path: skill.path.display().to_string(),
                        content,
                    });
                }
                Err(err) => {
                    warn!("[skill-prefetch] Failed to read skill '{}': {}", name, err);
                }
            }
        }
    }

    let final_names: Vec<String> = skill_contents
        .iter()
        .map(|skill| skill.name.clone())
        .collect();
    info!(
        "[skill-prefetch] Selected {} skill(s): {:?} (tokens_used={})",
        final_names.len(),
        final_names,
        tokens_used
    );

    PrefetchResult {
        selected_names: final_names,
        skill_contents,
        tokens_used,
    }
}

/// Extract the latest user message from a conversation history.
pub fn extract_latest_user_message(messages: &[Value]) -> Option<String> {
    messages
        .iter()
        .rev()
        .find(|msg| {
            msg.get("role")
                .and_then(|r| r.as_str())
                .map(|r| r == "user")
                .unwrap_or(false)
        })
        .and_then(|msg| msg.get("content").and_then(|c| c.as_str()))
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_selection_query_formats_correctly() {
        let skills = vec![SkillInfo {
            name: "test-skill".into(),
            description: "A test skill".into(),
            path: "/tmp/test/SKILL.md".into(),
            source: "workspace".into(),
            always: false,
            enabled: true,
            available: true,
            estimated_tokens: 500,
            full_content_tokens: 500,
            description_quality: super::super::loader::DescriptionQuality::Good,
            bundled_files: Vec::new(),
            required_bins: Vec::new(),
            required_env: Vec::new(),
            version: String::new(),
            license: String::new(),
            compatibility: String::new(),
            missing_bins: Vec::new(),
            missing_env: Vec::new(),
        }];

        let query = build_selection_query("implement auth", &skills);
        assert!(query.contains("test-skill: A test skill"));
        assert!(query.contains("implement auth"));
        assert!(query.contains("NONE"));
    }

    #[test]
    fn extract_latest_user_message_finds_last() {
        let messages = vec![
            serde_json::json!({"role": "system", "content": "system"}),
            serde_json::json!({"role": "user", "content": "first"}),
            serde_json::json!({"role": "assistant", "content": "response"}),
            serde_json::json!({"role": "user", "content": "second"}),
        ];

        assert_eq!(
            extract_latest_user_message(&messages),
            Some("second".to_string())
        );
    }

    #[test]
    fn extract_latest_user_message_none_when_empty() {
        let messages: Vec<Value> = vec![serde_json::json!({"role": "system", "content": "system"})];
        assert_eq!(extract_latest_user_message(&messages), None);
    }

    #[test]
    fn prefetch_result_builds_prompt_section() {
        let result = PrefetchResult {
            selected_names: vec!["my-skill".into()],
            skill_contents: vec![PrefetchedSkill {
                name: "my-skill".into(),
                source: "workspace".into(),
                path: "/repo/.orgii/skills/my-skill/SKILL.md".into(),
                content: "# My Skill\n\nDo this thing.".into(),
            }],
            tokens_used: 100,
        };

        let section = result.build_prompt_section().unwrap();
        assert!(section.contains("Prefetched Skills"));
        assert!(section.contains("my-skill"));
        assert!(section.contains("Source: workspace"));
        assert!(section.contains("/repo/.orgii/skills/my-skill/SKILL.md"));
        assert!(section.contains("Content already prefetched"));
        assert!(section.contains("Do this thing."));
    }

    #[test]
    fn prefetch_result_empty_returns_none() {
        let result = PrefetchResult {
            selected_names: Vec::new(),
            skill_contents: Vec::new(),
            tokens_used: 0,
        };

        assert!(result.build_prompt_section().is_none());
    }

    #[test]
    fn parse_selection_response() {
        let response = "test-skill\nother-skill\n";
        let names: Vec<String> = response
            .lines()
            .map(|line: &str| line.trim().trim_start_matches("- ").trim().to_string())
            .filter(|name: &String| !name.is_empty())
            .take(MAX_PREFETCH_SKILLS)
            .collect();

        assert_eq!(names, vec!["test-skill", "other-skill"]);
    }

    #[test]
    fn parse_selection_response_with_dashes() {
        let response = "- test-skill\n- other-skill\n";
        let names: Vec<String> = response
            .lines()
            .map(|line: &str| line.trim().trim_start_matches("- ").trim().to_string())
            .filter(|name: &String| !name.is_empty())
            .take(MAX_PREFETCH_SKILLS)
            .collect();

        assert_eq!(names, vec!["test-skill", "other-skill"]);
    }

    #[test]
    fn parse_selection_response_none() {
        let response = "NONE";
        assert_eq!(response.trim(), "NONE");
    }

    #[test]
    fn max_prefetch_limits_to_three() {
        let response = "a\nb\nc\nd\ne\n";
        let names: Vec<String> = response
            .lines()
            .map(|line: &str| line.trim().to_string())
            .filter(|name: &String| !name.is_empty())
            .take(MAX_PREFETCH_SKILLS)
            .collect();

        assert_eq!(names.len(), 3);
    }
}

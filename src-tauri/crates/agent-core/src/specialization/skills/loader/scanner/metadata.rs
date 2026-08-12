//! SKILL.md YAML-frontmatter parsing and requirement checks.

use super::super::types::SkillMetadata;
use super::SkillsLoader;

impl SkillsLoader {
    pub(super) fn skill_metadata_applies_to_agent(&self, meta: &SkillMetadata) -> bool {
        let Some(agent_id) = self.agent_id.as_deref() else {
            return meta.include_agents.is_empty();
        };
        if meta
            .exclude_agents
            .iter()
            .any(|excluded| excluded == agent_id)
        {
            return false;
        }
        meta.include_agents.is_empty()
            || meta
                .include_agents
                .iter()
                .any(|included| included == agent_id)
    }

    fn parse_inline_list(line: &str) -> Vec<String> {
        let inner = line.split('[').nth(1).unwrap_or("").trim_end_matches(']');
        inner
            .split(',')
            .map(|item| item.trim().trim_matches('"').trim_matches('\'').to_string())
            .filter(|item| !item.is_empty())
            .collect()
    }

    /// Parse YAML frontmatter from a skill file.
    ///
    /// Expects frontmatter delimited by `---` at the top of the file.
    pub(super) fn parse_skill_metadata(&self, content: &str) -> SkillMetadata {
        let mut meta = SkillMetadata::default();

        if let Some(after_start) = content.strip_prefix("---") {
            if let Some(end_idx) = after_start.find("---") {
                let frontmatter = &after_start[..end_idx];
                let mut in_bins = false;
                let mut in_env = false;
                let mut in_include_agent = false;
                let mut in_exclude_agent = false;

                for line in frontmatter.lines() {
                    let trimmed = line.trim();

                    if !trimmed.starts_with('-') && !trimmed.is_empty() {
                        in_bins = false;
                        in_env = false;
                        in_include_agent = false;
                        in_exclude_agent = false;
                    }

                    if let Some(after) = trimmed.strip_prefix("name:") {
                        let val = after.trim().trim_matches('"').trim_matches('\'');
                        if !val.is_empty() {
                            meta.name = val.to_string();
                        }
                    } else if let Some(after) = trimmed.strip_prefix("description:") {
                        let val = after.trim().trim_matches('"').trim_matches('\'');
                        if !val.is_empty() {
                            meta.description = val.to_string();
                        }
                    } else if trimmed.starts_with("always:") {
                        meta.always = trimmed.contains("true");
                    } else if let Some(after) = trimmed.strip_prefix("version:") {
                        let val = after.trim().trim_matches('"').trim_matches('\'');
                        if !val.is_empty() {
                            meta.version = val.to_string();
                        }
                    } else if let Some(after) = trimmed.strip_prefix("license:") {
                        let val = after.trim().trim_matches('"').trim_matches('\'');
                        if !val.is_empty() {
                            meta.license = val.to_string();
                        }
                    } else if let Some(after) = trimmed.strip_prefix("compatibility:") {
                        let val = after.trim().trim_matches('"').trim_matches('\'');
                        if !val.is_empty() {
                            meta.compatibility = val.to_string();
                        }
                    } else if trimmed == "include-agent:" || trimmed.starts_with("include-agent:") {
                        in_include_agent = true;
                        in_exclude_agent = false;
                        in_bins = false;
                        in_env = false;
                        if trimmed.contains('[') {
                            meta.include_agents.extend(Self::parse_inline_list(trimmed));
                            in_include_agent = false;
                        }
                    } else if trimmed == "exclude-agent:" || trimmed.starts_with("exclude-agent:") {
                        in_exclude_agent = true;
                        in_include_agent = false;
                        in_bins = false;
                        in_env = false;
                        if trimmed.contains('[') {
                            meta.exclude_agents.extend(Self::parse_inline_list(trimmed));
                            in_exclude_agent = false;
                        }
                    } else if trimmed == "bins:" || trimmed.starts_with("bins:") {
                        in_bins = true;
                        in_env = false;
                        in_include_agent = false;
                        in_exclude_agent = false;
                        if trimmed.contains('[') {
                            let inner = trimmed
                                .split('[')
                                .nth(1)
                                .unwrap_or("")
                                .trim_end_matches(']');
                            for item in inner.split(',') {
                                let val = item.trim().trim_matches('"').trim_matches('\'');
                                if !val.is_empty() {
                                    meta.required_bins.push(val.to_string());
                                }
                            }
                            in_bins = false;
                        }
                    } else if trimmed == "env:" || trimmed.starts_with("env:") {
                        in_env = true;
                        in_bins = false;
                        in_include_agent = false;
                        in_exclude_agent = false;
                        if trimmed.contains('[') {
                            let inner = trimmed
                                .split('[')
                                .nth(1)
                                .unwrap_or("")
                                .trim_end_matches(']');
                            for item in inner.split(',') {
                                let val = item.trim().trim_matches('"').trim_matches('\'');
                                if !val.is_empty() {
                                    meta.required_env.push(val.to_string());
                                }
                            }
                            in_env = false;
                        }
                    } else if let Some(after) = trimmed.strip_prefix("- ") {
                        let val = after.trim().trim_matches('"').trim_matches('\'');
                        if in_bins && !val.is_empty() {
                            meta.required_bins.push(val.to_string());
                        } else if in_env && !val.is_empty() {
                            meta.required_env.push(val.to_string());
                        } else if in_include_agent && !val.is_empty() {
                            meta.include_agents.push(val.to_string());
                        } else if in_exclude_agent && !val.is_empty() {
                            meta.exclude_agents.push(val.to_string());
                        }
                    }
                }
            }
        }

        // Fallback: derive description from first non-header body line if not in frontmatter
        if meta.description.is_empty() {
            let body_start = if let Some(after_start) = content.strip_prefix("---") {
                after_start.find("---").map(|idx| idx + 6).unwrap_or(0)
            } else {
                0
            };

            for line in content[body_start..].lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("<!--") {
                    continue;
                }
                meta.description = crate::utils::safe_truncate_chars_to_string(&trimmed, 120);
                break;
            }
        }

        meta
    }

    /// Check requirements and return (available, missing_bins, missing_env).
    pub(super) fn check_requirements(
        &self,
        bins: &[String],
        env_vars: &[String],
    ) -> (bool, Vec<String>, Vec<String>) {
        let missing_bins: Vec<String> = bins
            .iter()
            .filter(|bin| which::which(bin).is_err())
            .cloned()
            .collect();

        let missing_env: Vec<String> = env_vars
            .iter()
            .filter(|var| std::env::var(var).is_err())
            .cloned()
            .collect();

        let available = missing_bins.is_empty() && missing_env.is_empty();
        (available, missing_bins, missing_env)
    }
}

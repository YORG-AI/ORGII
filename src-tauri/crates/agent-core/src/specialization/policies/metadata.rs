use std::path::{Path, PathBuf};

use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::Deserialize;

use super::{scan_md_files, PoliciesConfig};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedPolicy {
    pub name: String,
    pub content: String,
    pub source_path: PathBuf,
    pub path_globs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConditionalPolicy {
    pub name: String,
    pub content: String,
    pub source_path: PathBuf,
    pub path_globs: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PolicySet {
    pub unconditional: Vec<LoadedPolicy>,
    pub conditional: Vec<ConditionalPolicy>,
}

#[derive(Debug, Clone)]
pub struct CompiledConditionalPolicy {
    pub name: String,
    pub content: String,
    pub source_path: PathBuf,
    matcher: GlobSet,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct PolicyFrontmatter {
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    include_agent: Vec<String>,
    #[serde(default)]
    exclude_agent: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PolicyMetadata {
    pub path_globs: Vec<String>,
    pub include_agents: Vec<String>,
    pub exclude_agents: Vec<String>,
}

fn normalize_list(items: Vec<String>) -> Vec<String> {
    items
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn metadata_applies_to_agent(metadata: &PolicyMetadata, agent_id: &str) -> bool {
    if metadata
        .exclude_agents
        .iter()
        .any(|excluded| excluded == agent_id)
    {
        return false;
    }
    metadata.include_agents.is_empty()
        || metadata
            .include_agents
            .iter()
            .any(|included| included == agent_id)
}

impl ConditionalPolicy {
    pub fn compile(self) -> Result<CompiledConditionalPolicy, String> {
        let mut builder = GlobSetBuilder::new();
        for pattern in &self.path_globs {
            let glob = Glob::new(pattern).map_err(|err| {
                format!(
                    "Invalid paths glob {:?} in policy {}: {}",
                    pattern, self.name, err
                )
            })?;
            builder.add(glob);
        }
        let matcher = builder.build().map_err(|err| {
            format!(
                "Failed to compile paths globs for policy {}: {}",
                self.name, err
            )
        })?;
        Ok(CompiledConditionalPolicy {
            name: self.name,
            content: self.content,
            source_path: self.source_path,
            matcher,
        })
    }
}

impl CompiledConditionalPolicy {
    pub fn is_match(&self, relative_path: &Path) -> bool {
        self.matcher.is_match(relative_path)
    }
}

pub(crate) fn load_policy_set(
    dir: &Path,
    config: &PoliciesConfig,
    agent_id: &str,
    repo_path: Option<&str>,
) -> PolicySet {
    let mut set = PolicySet::default();
    for (name, path) in scan_md_files(dir) {
        if config.is_disabled(&name)
            || !config.applies_to_agent(&name, agent_id)
            || !config.applies_to_repo(&name, repo_path)
        {
            continue;
        }
        let Ok(raw_content) = std::fs::read_to_string(&path) else {
            continue;
        };
        if raw_content.trim().is_empty() {
            continue;
        }
        let (content, metadata) = parse_policy_file(&raw_content);
        if content.trim().is_empty() || !metadata_applies_to_agent(&metadata, agent_id) {
            continue;
        }
        if metadata.path_globs.is_empty() {
            set.unconditional.push(LoadedPolicy {
                name,
                content,
                source_path: path,
                path_globs: metadata.path_globs,
            });
        } else {
            set.conditional.push(ConditionalPolicy {
                name,
                content,
                source_path: path,
                path_globs: metadata.path_globs,
            });
        }
    }
    set.unconditional
        .sort_by(|left, right| left.name.cmp(&right.name));
    set.conditional
        .sort_by(|left, right| left.name.cmp(&right.name));
    set
}

pub(crate) fn parse_policy_file(raw: &str) -> (String, PolicyMetadata) {
    let Some(rest) = raw.strip_prefix("---\n") else {
        return (raw.to_string(), PolicyMetadata::default());
    };
    let Some(end_index) = rest.find("\n---") else {
        return (raw.to_string(), PolicyMetadata::default());
    };

    let frontmatter = &rest[..end_index];
    let after_marker = &rest[end_index + "\n---".len()..];
    let content = after_marker.strip_prefix('\n').unwrap_or(after_marker);
    let metadata = serde_yaml::from_str::<PolicyFrontmatter>(frontmatter)
        .map(|frontmatter| PolicyMetadata {
            path_globs: normalize_list(frontmatter.paths),
            include_agents: normalize_list(frontmatter.include_agent),
            exclude_agents: normalize_list(frontmatter.exclude_agent),
        })
        .unwrap_or_default();

    (content.to_string(), metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::specialization::policies::config::{PoliciesConfig, PolicyConfig};
    use std::collections::HashMap;

    #[test]
    fn parse_policy_file_without_frontmatter_keeps_content() {
        let (content, metadata) = parse_policy_file("Use cargo test.");
        assert_eq!(content, "Use cargo test.");
        assert!(metadata.path_globs.is_empty());
    }

    #[test]
    fn parse_policy_file_supports_inline_paths() {
        let raw = "---\npaths: [src/**/*.rs, Cargo.toml]\n---\nUse Rust rules.";
        let (content, metadata) = parse_policy_file(raw);
        assert_eq!(content, "Use Rust rules.");
        assert_eq!(metadata.path_globs, vec!["src/**/*.rs", "Cargo.toml"]);
    }

    #[test]
    fn parse_policy_file_supports_multiline_paths() {
        let raw = "---\npaths:\n  - src/**/*.ts\n  - tests/**/*.ts\n---\nUse TS rules.";
        let (content, metadata) = parse_policy_file(raw);
        assert_eq!(content, "Use TS rules.");
        assert_eq!(metadata.path_globs, vec!["src/**/*.ts", "tests/**/*.ts"]);
    }

    #[test]
    fn parse_policy_file_malformed_frontmatter_keeps_content_unconditional() {
        let raw = "---\npaths: [unterminated\n---\nKeep this visible.";
        let (content, metadata) = parse_policy_file(raw);
        assert_eq!(content, "Keep this visible.");
        assert!(metadata.path_globs.is_empty());
    }

    #[test]
    fn migrated_simon_rules_are_unconditional_global() {
        // E/Phase-7 迁移：F 类硬约束 + B2 偏好用 `paths: []` 写成全局 rule。
        // 断言空 paths → 无 path_globs（=unconditional，全局生效），content 保真。
        let core = "---\npaths: []\n---\n\n# 核心硬约束\n\n绝不擅自 fallback；绝不加 timeout；setsid nohup 启动后台任务。";
        let (content, metadata) = parse_policy_file(core);
        assert!(
            metadata.path_globs.is_empty(),
            "paths:[] must yield no globs (unconditional)"
        );
        assert!(content.contains("绝不擅自 fallback"));
        assert!(content.contains("绝不加 timeout"));
        assert!(content.contains("setsid"));

        let profile =
            "---\npaths: []\n---\n\n# 用户偏好\n\n默认永远用 sonnet-4.6，除非 Simon 主动说切。";
        let (pcontent, pmeta) = parse_policy_file(profile);
        assert!(pmeta.path_globs.is_empty());
        assert!(pcontent.contains("sonnet-4.6"));
    }

    #[test]
    fn load_policy_set_classifies_and_filters_rules() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("always.md"), "Always rule").unwrap();
        std::fs::write(
            dir.path().join("conditional.md"),
            "---\npaths:\n  - src/**/*.rs\n---\nRust-only rule",
        )
        .unwrap();
        std::fs::write(dir.path().join("disabled.md"), "Disabled rule").unwrap();
        std::fs::write(dir.path().join("other-agent.md"), "Other agent rule").unwrap();
        std::fs::write(dir.path().join("other-repo.md"), "Other repo rule").unwrap();

        let mut policies = HashMap::new();
        policies.insert(
            "disabled".to_string(),
            PolicyConfig {
                disabled: true,
                ..PolicyConfig::default()
            },
        );
        policies.insert(
            "other-agent".to_string(),
            PolicyConfig {
                agents: vec!["different-agent".to_string()],
                ..PolicyConfig::default()
            },
        );
        policies.insert(
            "other-repo".to_string(),
            PolicyConfig {
                scope_repo_paths: Some(vec!["/repo/b".to_string()]),
                ..PolicyConfig::default()
            },
        );

        let set = load_policy_set(
            dir.path(),
            &PoliciesConfig { policies },
            "agent-a",
            Some("/repo/a"),
        );

        assert_eq!(
            set.unconditional
                .iter()
                .map(|policy| policy.name.as_str())
                .collect::<Vec<_>>(),
            vec!["always"]
        );
        assert_eq!(
            set.conditional
                .iter()
                .map(|policy| policy.name.as_str())
                .collect::<Vec<_>>(),
            vec!["conditional"]
        );
    }

    #[test]
    fn load_policy_set_honors_frontmatter_agent_scope() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("included.md"),
            "---\ninclude-agent:\n  - agent-a\n---\nIncluded rule",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("excluded.md"),
            "---\nexclude-agent:\n  - agent-a\n---\nExcluded rule",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("other.md"),
            "---\ninclude-agent:\n  - agent-b\n---\nOther rule",
        )
        .unwrap();

        let set = load_policy_set(dir.path(), &PoliciesConfig::default(), "agent-a", None);

        assert_eq!(
            set.unconditional
                .iter()
                .map(|policy| policy.name.as_str())
                .collect::<Vec<_>>(),
            vec!["included"]
        );
    }

    #[test]
    fn compiled_conditional_policy_matches_relative_paths() {
        let policy = ConditionalPolicy {
            name: "rust".to_string(),
            content: "Rust rule".to_string(),
            source_path: PathBuf::from("rust.md"),
            path_globs: vec!["src/**/*.rs".to_string()],
        }
        .compile()
        .unwrap();

        assert!(policy.is_match(Path::new("src/core/lib.rs")));
        assert!(!policy.is_match(Path::new("src/core/lib.ts")));
    }
}

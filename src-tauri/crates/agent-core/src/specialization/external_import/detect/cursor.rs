//! Detectors for Cursor IDE artifacts.
//!
//! Covers:
//!   - `.cursor/rules/*.mdc`       → `Policy`
//!   - `.cursor/agents/<name>.md`  → `AgentDefinition`
//!   - `.cursor/skills/<name>/SKILL.md` (workspace)
//!   - `~/.cursor/skills-cursor/<name>/SKILL.md` (user-global)
//!     → `Skill`

use std::path::Path;

use super::super::types::{
    DetectedItem, FidelityWarning, ItemKind, ItemPreview, SourceAgent, SourceScope,
};
use super::helpers::{
    first_body_line, home_dir, orgii_skill_exists, orgii_target_exists, path_has_denied_ancestor,
    split_frontmatter, MAX_ITEMS_PER_BATCH, MAX_RULE_BYTES,
};
use super::vendor_agents::detect_vendor_agents;
use crate::specialization::policies::PolicySource;

// ============================================================
// Cursor IDE — `.cursor/rules/*.mdc`
// ============================================================

pub(super) fn detect_cursor_rules(repo_path: Option<&Path>) -> Vec<DetectedItem> {
    let mut out = Vec::new();

    if let Some(repo) = repo_path {
        let dir = repo.join(".cursor").join("rules");
        scan_cursor_rule_dir(
            &dir,
            SourceScope::WorkspaceLocal {
                repo_path: repo.to_path_buf(),
            },
            PolicySource::Workspace,
            Some(repo),
            &mut out,
        );
    }

    if repo_path.is_none() {
        let user_global = home_dir().map(|home| home.join(".cursor").join("rules"));
        if let Some(dir) = user_global {
            scan_cursor_rule_dir(
                &dir,
                SourceScope::UserGlobal,
                PolicySource::Global,
                None,
                &mut out,
            );
        }
    }

    out
}

fn scan_cursor_rule_dir(
    dir: &Path,
    scope: SourceScope,
    target_source: PolicySource,
    workspace_path: Option<&Path>,
    out: &mut Vec<DetectedItem>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(it) => it,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if out
            .iter()
            .filter(|item| {
                matches!(item.source_agent, SourceAgent::CursorIde) && item.kind == ItemKind::Policy
            })
            .count()
            >= MAX_ITEMS_PER_BATCH
        {
            return;
        }

        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("mdc") {
            continue;
        }
        if path_has_denied_ancestor(&path) {
            continue;
        }

        let item = match build_cursor_rule_item(&path, &scope, target_source, workspace_path) {
            Some(item) => item,
            None => continue,
        };
        out.push(item);
    }

    out.sort_by(|a, b| a.suggested_name.cmp(&b.suggested_name));
}

fn build_cursor_rule_item(
    path: &Path,
    scope: &SourceScope,
    target_source: PolicySource,
    workspace_path: Option<&Path>,
) -> Option<DetectedItem> {
    let name = path.file_stem()?.to_str()?.to_string();
    if name.is_empty() {
        return None;
    }

    let raw = std::fs::read_to_string(path).ok()?;
    let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    if size_bytes > MAX_RULE_BYTES {
        return None;
    }

    let mut warnings = Vec::new();
    let (frontmatter_pairs, body) = match split_frontmatter(&raw) {
        Ok((pairs, body)) => (pairs, body.to_string()),
        Err(detail) => {
            warnings.push(FidelityWarning::FrontmatterParseError { detail });
            (Vec::new(), raw.clone())
        }
    };

    let already_imported = orgii_target_exists(target_source, workspace_path, &name);

    Some(DetectedItem {
        source_agent: SourceAgent::CursorIde,
        source_scope: scope.clone(),
        kind: ItemKind::Policy,
        source_path: path.to_path_buf(),
        suggested_name: name,
        already_imported,
        fidelity_warnings: warnings,
        preview: ItemPreview {
            summary: first_body_line(&body),
            frontmatter: frontmatter_pairs,
            size_bytes,
        },
    })
}

// ============================================================
// Cursor IDE — agents
// ============================================================

pub(super) fn detect_cursor_agents(repo_path: Option<&Path>) -> Vec<DetectedItem> {
    detect_vendor_agents(repo_path, ".cursor", SourceAgent::CursorIde)
}

// ============================================================
// Cursor IDE — skills
//
// Two layouts are supported, mirroring how Cursor itself stores them:
//   - Workspace-local:  `<repo>/.cursor/skills/<name>/SKILL.md`
//   - User-global:    `~/.cursor/skills-cursor/<name>/SKILL.md`
// ============================================================

pub(super) fn detect_cursor_skills(repo_path: Option<&Path>) -> Vec<DetectedItem> {
    let mut out = Vec::new();

    if let Some(repo) = repo_path {
        scan_cursor_skills_dir(
            &repo.join(".cursor").join("skills"),
            SourceScope::WorkspaceLocal {
                repo_path: repo.to_path_buf(),
            },
            Some(repo),
            &mut out,
        );
    }

    if repo_path.is_none() {
        if let Some(home) = home_dir() {
            scan_cursor_skills_dir(
                &home.join(".cursor").join("skills-cursor"),
                SourceScope::UserGlobal,
                None,
                &mut out,
            );
        }
    }

    out.sort_by(|a, b| a.suggested_name.cmp(&b.suggested_name));
    out
}

fn scan_cursor_skills_dir(
    dir: &Path,
    scope: SourceScope,
    target_repo_path: Option<&Path>,
    out: &mut Vec<DetectedItem>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(it) => it,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if out
            .iter()
            .filter(|item| {
                item.kind == ItemKind::Skill && matches!(item.source_agent, SourceAgent::CursorIde)
            })
            .count()
            >= MAX_ITEMS_PER_BATCH
        {
            return;
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path_has_denied_ancestor(&path) {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        if let Some(item) = build_cursor_skill_item(&skill_md, &scope, target_repo_path) {
            out.push(item);
        }
    }
}

fn build_cursor_skill_item(
    path: &Path,
    scope: &SourceScope,
    target_repo_path: Option<&Path>,
) -> Option<DetectedItem> {
    let stem = path.parent()?.file_name()?.to_str()?.to_string();
    if stem.is_empty() {
        return None;
    }

    let raw = std::fs::read_to_string(path).ok()?;
    let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size_bytes > MAX_RULE_BYTES {
        return None;
    }

    let mut warnings = Vec::new();
    let (frontmatter_pairs, body) = match split_frontmatter(&raw) {
        Ok((pairs, body)) => (pairs, body.to_string()),
        Err(detail) => {
            warnings.push(FidelityWarning::FrontmatterParseError { detail });
            (Vec::new(), raw.clone())
        }
    };

    let suggested_name = stem;
    let already_imported = orgii_skill_exists(target_repo_path, &suggested_name);

    Some(DetectedItem {
        source_agent: SourceAgent::CursorIde,
        source_scope: scope.clone(),
        kind: ItemKind::Skill,
        source_path: path.to_path_buf(),
        suggested_name,
        already_imported,
        fidelity_warnings: warnings,
        preview: ItemPreview {
            summary: first_body_line(&body),
            frontmatter: frontmatter_pairs,
            size_bytes,
        },
    })
}

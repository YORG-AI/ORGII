//! Attribute listening ports to workspace folder probes.

use super::types::{WorkspacePortAttributionConfidence, WorkspacePortOwner, WorkspacePortProbe};

#[derive(Debug, Clone)]
pub(crate) struct NormalizedWorkspacePortProbe {
    pub probe: WorkspacePortProbe,
    pub normalized_path: String,
}

pub(crate) fn normalize_workspace_port_probes(
    folders: &[WorkspacePortProbe],
) -> Vec<NormalizedWorkspacePortProbe> {
    folders
        .iter()
        .map(|probe| NormalizedWorkspacePortProbe {
            probe: probe.clone(),
            normalized_path: normalize_comparable_path(&probe.path),
        })
        .collect()
}

pub(crate) fn attribute_port_to_workspaces(
    cwd: Option<&str>,
    command_line: Option<&str>,
    folders: &[NormalizedWorkspacePortProbe],
) -> Option<WorkspacePortOwner> {
    let cwd_normalized = cwd.map(normalize_comparable_path);
    if let Some(ref cwd_path) = cwd_normalized {
        if let Some(matched) = pick_deepest_matching(folders, |candidate| {
            is_same_or_descendant(cwd_path, &candidate.normalized_path)
        }) {
            return Some(to_owner(
                &matched.probe,
                WorkspacePortAttributionConfidence::Cwd,
            ));
        }
    }

    let command_normalized = command_line.map(normalize_comparable_text);
    let Some(command_line) = command_normalized else {
        return None;
    };

    let matched = pick_deepest_matching(folders, |candidate| {
        includes_path_boundary(&command_line, &candidate.normalized_path)
    })?;
    Some(to_owner(
        &matched.probe,
        WorkspacePortAttributionConfidence::Command,
    ))
}

fn to_owner(
    probe: &WorkspacePortProbe,
    confidence: WorkspacePortAttributionConfidence,
) -> WorkspacePortOwner {
    WorkspacePortOwner {
        folder_id: probe.id.clone(),
        repo_id: probe.repo_id.clone(),
        display_name: probe.display_name.clone(),
        path: probe.path.clone(),
        confidence,
    }
}

fn pick_deepest_matching<'a, F>(
    candidates: &'a [NormalizedWorkspacePortProbe],
    predicate: F,
) -> Option<&'a NormalizedWorkspacePortProbe>
where
    F: Fn(&NormalizedWorkspacePortProbe) -> bool,
{
    let mut best: Option<&NormalizedWorkspacePortProbe> = None;
    for candidate in candidates {
        if !predicate(candidate) {
            continue;
        }
        if best
            .map(|current| candidate.normalized_path.len() > current.normalized_path.len())
            .unwrap_or(true)
        {
            best = Some(candidate);
        }
    }
    best
}

fn is_same_or_descendant(candidate: &str, parent: &str) -> bool {
    candidate == parent || candidate.starts_with(&format!("{parent}/"))
}

fn includes_path_boundary(command_line: &str, normalized_path: &str) -> bool {
    let mut search_from = 0;
    while let Some(relative_index) = command_line[search_from..].find(normalized_path) {
        let index = search_from + relative_index;
        let before = if index == 0 {
            None
        } else {
            command_line.chars().nth(index - 1)
        };
        let after = command_line.chars().nth(index + normalized_path.len());
        let starts_on_boundary = before
            .map(|ch| ch.is_whitespace() || matches!(ch, '"' | '\'' | '='))
            .unwrap_or(true);
        let ends_on_boundary = after
            .map(|ch| ch.is_whitespace() || matches!(ch, '"' | '\'' | '/' | ':'))
            .unwrap_or(true);
        if starts_on_boundary && ends_on_boundary {
            return true;
        }
        search_from = index + normalized_path.len();
    }
    false
}

pub(crate) fn normalize_comparable_path(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.starts_with('/') {
        // Keep POSIX absolute paths intact even when evaluated on Windows hosts.
        return normalize_comparable_text(trimmed);
    }
    let path = std::path::Path::new(trimmed);
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    normalize_comparable_text(&resolved.to_string_lossy())
}

pub(crate) fn normalize_comparable_text(input: &str) -> String {
    let normalized = input.replace('\\', "/");
    let collapsed = collapse_slashes(&normalized);
    #[cfg(windows)]
    {
        collapsed.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        collapsed
    }
}

fn collapse_slashes(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut previous_slash = false;
    for ch in input.chars() {
        if ch == '/' {
            if !previous_slash {
                result.push('/');
            }
            previous_slash = true;
        } else {
            previous_slash = false;
            result.push(ch);
        }
    }
    result
}

#[cfg(test)]
#[path = "attribution_tests.rs"]
mod tests;

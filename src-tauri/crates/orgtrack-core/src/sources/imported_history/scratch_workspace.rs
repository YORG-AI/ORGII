//! Provider-managed per-session scratch directories are not workspaces.
//!
//! Several external agent apps do not ask the user to pick a project. When the
//! user just starts talking, the app invents a throwaway folder for that one
//! conversation and reports it as the session `cwd`:
//!
//! - WorkBuddy  → `~/WorkBuddy/<YYYY-MM-DD-HH-MM-SS>`
//! - Qoder      → `~/Documents/Qoder/<YYYY-MM-DD>/chat-<n>`
//! - Codex app  → `~/Documents/Codex/<YYYY-MM-DD>/<prompt-slug>`, and the
//!   ChatGPT desktop app's `~/Documents/ChatGPT/<prompt-slug>`
//!
//! Storing that path as the session's `repo_path` invents a one-session
//! "workspace": the sidebar's Organize-by-workspace view then grows a group
//! header per conversation, labelled with a bare timestamp or `chat-1`, and
//! the Data/Usage surfaces attribute cost to a directory the user never
//! chose. The value is a real cwd but it is not a workspace, so the invariant
//! belongs at the imported-history write boundary: a scratch cwd is persisted
//! as *no workspace* and the session groups under "No Workspace".
//!
//! Matching is deliberately narrow. Each rule is anchored at the external
//! history home dir, requires the exact component depth the owning app uses,
//! and applies only to that app's own source id — so a real project a user
//! happens to keep at `~/Documents/Codex/...` and opens in another editor
//! keeps its own workspace group.

use std::path::{Component, Path};

use super::metadata::{SOURCE_CODEX_APP, SOURCE_QODER, SOURCE_WORKBUDDY};

/// `true` when `path` is the owning app's per-session scratch directory (or
/// the root it creates them under) rather than a workspace the user chose.
pub fn is_agent_scratch_workspace(source: &str, path: &str) -> bool {
    let home = app_paths::external_history_home_dir();
    is_agent_scratch_workspace_under(&home, source, path)
}

/// Home-anchored core of [`is_agent_scratch_workspace`], split out so tests
/// can pin a fixture home instead of the caller's real one.
pub(crate) fn is_agent_scratch_workspace_under(home: &Path, source: &str, path: &str) -> bool {
    let Some(segments) = relative_segments(home, path) else {
        return false;
    };
    match source {
        // `~/WorkBuddy/<YYYY-MM-DD-HH-MM-SS>`. WorkBuddy also ships as
        // CodeBuddy, which uses the same layout under its own root.
        SOURCE_WORKBUDDY => match segments.as_slice() {
            [root] => is_scratch_root(root, &["WorkBuddy", "CodeBuddy"]),
            [root, session] => {
                is_scratch_root(root, &["WorkBuddy", "CodeBuddy"]) && is_timestamp_dir(session)
            }
            _ => false,
        },
        // `~/Documents/Qoder/<YYYY-MM-DD>/chat-<n>`.
        SOURCE_QODER => match segments.as_slice() {
            ["Documents", root] => is_scratch_root(root, &["Qoder"]),
            ["Documents", root, date] => is_scratch_root(root, &["Qoder"]) && is_date_dir(date),
            ["Documents", root, date, chat] => {
                is_scratch_root(root, &["Qoder"]) && is_date_dir(date) && is_chat_dir(chat)
            }
            _ => false,
        },
        // `~/Documents/Codex/<YYYY-MM-DD>/<prompt-slug>`, plus the ChatGPT
        // desktop app's flat `~/Documents/ChatGPT/<prompt-slug>`. Both are
        // reported by the Codex rollout writer, so both live on this arm.
        SOURCE_CODEX_APP => match segments.as_slice() {
            ["Documents", root] => is_scratch_root(root, &["Codex", "ChatGPT"]),
            ["Documents", root, slug] => {
                (is_scratch_root(root, &["Codex"]) && is_date_dir(slug))
                    || (is_scratch_root(root, &["ChatGPT"]) && is_slug_dir(slug))
            }
            ["Documents", root, date, slug] => {
                is_scratch_root(root, &["Codex"]) && is_date_dir(date) && is_slug_dir(slug)
            }
            _ => false,
        },
        _ => false,
    }
}

/// `path`'s components relative to `home`, or `None` when it is not under
/// `home` (or is `home` itself — the home dir is a legitimate cwd that other
/// sources record, and blanking it is not this invariant's business).
fn relative_segments<'a>(home: &Path, path: &'a str) -> Option<Vec<&'a str>> {
    let trimmed = path.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let candidate = Path::new(trimmed);
    // Reject anything with `.`/`..`/symbolic components: the stored value is
    // an absolute cwd, and a traversal segment means it did not come from the
    // writer this rule models.
    if !candidate
        .components()
        .all(|component| matches!(component, Component::Normal(_) | Component::RootDir))
    {
        return None;
    }
    let relative = candidate.strip_prefix(home).ok()?;
    let segments: Vec<&str> = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect();
    (!segments.is_empty()).then_some(segments)
}

/// Scratch roots are matched case-insensitively: the apps have shipped both
/// `WorkBuddy` and `Workbuddy`, and macOS paths round-trip either way.
fn is_scratch_root(segment: &str, roots: &[&str]) -> bool {
    roots.iter().any(|root| segment.eq_ignore_ascii_case(root))
}

/// `YYYY-MM-DD`.
fn is_date_dir(segment: &str) -> bool {
    matches_digit_groups(segment, &[4, 2, 2])
}

/// `YYYY-MM-DD-HH-MM-SS`.
fn is_timestamp_dir(segment: &str) -> bool {
    matches_digit_groups(segment, &[4, 2, 2, 2, 2, 2])
}

/// `chat-<n>`.
fn is_chat_dir(segment: &str) -> bool {
    segment
        .strip_prefix("chat-")
        .is_some_and(|index| !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit()))
}

/// A prompt-derived leaf: the app slugifies the opening message, so it is
/// non-empty and carries only lowercase alphanumerics and dashes.
fn is_slug_dir(segment: &str) -> bool {
    !segment.is_empty()
        && !segment.starts_with('-')
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn matches_digit_groups(segment: &str, widths: &[usize]) -> bool {
    let mut parts = segment.split('-');
    for width in widths {
        let Some(part) = parts.next() else {
            return false;
        };
        if part.len() != *width || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
    }
    parts.next().is_none()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/Users/dev")
    }

    fn is_scratch(source: &str, path: &str) -> bool {
        is_agent_scratch_workspace_under(&home(), source, path)
    }

    #[test]
    fn workbuddy_per_session_dirs_are_scratch() {
        assert!(is_scratch(SOURCE_WORKBUDDY, "/Users/dev/WorkBuddy"));
        assert!(is_scratch(
            SOURCE_WORKBUDDY,
            "/Users/dev/Workbuddy/2026-06-23-20-59-34"
        ));
        assert!(is_scratch(
            SOURCE_WORKBUDDY,
            "/Users/dev/CodeBuddy/2026-06-23-23-30-58/"
        ));
    }

    #[test]
    fn qoder_chat_dirs_are_scratch() {
        assert!(is_scratch(SOURCE_QODER, "/Users/dev/Documents/Qoder"));
        assert!(is_scratch(
            SOURCE_QODER,
            "/Users/dev/Documents/Qoder/2026-07-16"
        ));
        assert!(is_scratch(
            SOURCE_QODER,
            "/Users/dev/Documents/Qoder/2026-07-16/chat-12"
        ));
    }

    #[test]
    fn codex_app_prompt_slug_dirs_are_scratch() {
        assert!(is_scratch(SOURCE_CODEX_APP, "/Users/dev/Documents/Codex"));
        assert!(is_scratch(
            SOURCE_CODEX_APP,
            "/Users/dev/Documents/Codex/2026-08-23"
        ));
        assert!(is_scratch(
            SOURCE_CODEX_APP,
            "/Users/dev/Documents/Codex/2026-08-23/do-a-quick-evaluation-of-users"
        ));
        assert!(is_scratch(
            SOURCE_CODEX_APP,
            "/Users/dev/Documents/ChatGPT/magazine"
        ));
    }

    #[test]
    fn real_workspaces_are_never_scratch() {
        assert!(!is_scratch(
            SOURCE_CODEX_APP,
            "/Users/dev/Documents/GitHub/ORGII"
        ));
        assert!(!is_scratch(SOURCE_WORKBUDDY, "/Users/dev/org2"));
        assert!(!is_scratch(SOURCE_QODER, "/Users/dev"));
        assert!(!is_scratch(SOURCE_CODEX_APP, ""));
        // A project nested under the scratch root still has real content, so
        // only the exact depths the writer produces are treated as scratch.
        assert!(!is_scratch(
            SOURCE_CODEX_APP,
            "/Users/dev/Documents/Codex/2026-08-23/what/nested-repo"
        ));
    }

    #[test]
    fn rules_do_not_leak_across_sources() {
        // The same path recorded by a different app means the user really
        // opened that directory there, so its workspace group is kept.
        assert!(!is_scratch(
            "cursor_ide",
            "/Users/dev/Documents/Codex/2026-08-23/what"
        ));
        assert!(!is_scratch(
            SOURCE_QODER,
            "/Users/dev/Documents/Codex/2026-08-23/what"
        ));
        assert!(!is_scratch(
            SOURCE_CODEX_APP,
            "/Users/dev/Documents/Qoder/2026-07-16/chat-1"
        ));
    }

    #[test]
    fn non_matching_shapes_are_kept() {
        // Not a timestamp / date / chat-<n> leaf.
        assert!(!is_scratch(SOURCE_WORKBUDDY, "/Users/dev/WorkBuddy/notes"));
        assert!(!is_scratch(
            SOURCE_QODER,
            "/Users/dev/Documents/Qoder/2026-07-16/scratch"
        ));
        assert!(!is_scratch(
            SOURCE_QODER,
            "/Users/dev/Documents/Qoder/july/chat-1"
        ));
        // Uppercase in the leaf means it was not slugified by the app.
        assert!(!is_scratch(
            SOURCE_CODEX_APP,
            "/Users/dev/Documents/ChatGPT/Magazine"
        ));
    }
}

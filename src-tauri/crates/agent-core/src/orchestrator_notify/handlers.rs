//! Per-event handlers for `orchestrator_notify`.
//!
//! When an agent session changes state (review completes, work-item
//! finishes, error surfaces), the orchestrator wants a structured digest
//! suitable for project-management bookkeeping. Each `extract_*` /
//! `handle_*` function in this file pulls the relevant message slice out
//! of the session log and shapes it into a typed payload — the dispatch
//! site lives in `orchestrator_notify::mod`.

pub(super) fn extract_review_feedback(
    session_id: &str,
) -> Option<core_types::workflow::ReviewFeedback> {
    use core_types::workflow::{ReviewFeedback, ReviewOutcome};

    let messages = crate::session::persistence::load_messages(session_id).ok()?;

    let last_assistant = messages
        .iter()
        .rev()
        .find(|msg| msg.role == "assistant" && !msg.content.is_empty())?;

    let content = &last_assistant.content;

    if let Some(feedback) = parse_structured_review_block(content, session_id) {
        return Some(feedback);
    }

    tracing::debug!(
        "[review] No structured block found for session {}, falling back to keyword heuristics",
        session_id
    );
    let content_lower = content.to_lowercase();
    let outcome = if content_lower.contains("approved")
        && !content_lower.contains("not approved")
        && !content_lower.contains("changes needed")
        && !content_lower.contains("changes requested")
    {
        ReviewOutcome::Approved
    } else {
        ReviewOutcome::ChangesRequested
    };

    let summary = extract_first_sentence(content);

    Some(ReviewFeedback {
        outcome,
        summary,
        comments: Vec::new(),
        session_id: session_id.to_string(),
        reviewed_at: chrono::Utc::now().to_rfc3339(),
        resolved_from_previous: Vec::new(),
    })
}

pub(crate) fn parse_structured_review_block(
    content: &str,
    session_id: &str,
) -> Option<core_types::workflow::ReviewFeedback> {
    use core_types::workflow::{ReviewComment, ReviewFeedback, ReviewOutcome};

    let start_marker = "---REVIEW_START---";
    let end_marker = "---REVIEW_END---";

    let start_idx = content.find(start_marker)?;
    let block_start = start_idx + start_marker.len();
    let end_idx = content[block_start..].find(end_marker)?;
    let block = &content[block_start..block_start + end_idx];

    let mut outcome: Option<ReviewOutcome> = None;
    let mut summary = String::new();
    let mut comments: Vec<ReviewComment> = Vec::new();
    let mut in_issues = false;

    for line in block.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix("VERDICT:") {
            let verdict = rest.trim().to_uppercase();
            outcome = Some(match verdict.as_str() {
                "APPROVED" => ReviewOutcome::Approved,
                "CHANGES_REQUESTED" => ReviewOutcome::ChangesRequested,
                _ => ReviewOutcome::ChangesRequested,
            });
            in_issues = false;
        } else if let Some(rest) = trimmed.strip_prefix("SUMMARY:") {
            summary = rest.trim().to_string();
            in_issues = false;
        } else if trimmed == "ISSUES:" {
            in_issues = true;
        } else if in_issues && trimmed.starts_with("- [") {
            if let Some(comment) = parse_issue_line(trimmed) {
                comments.push(comment);
            }
        }
    }

    let outcome = outcome?;

    Some(ReviewFeedback {
        outcome,
        summary,
        comments,
        session_id: session_id.to_string(),
        reviewed_at: chrono::Utc::now().to_rfc3339(),
        resolved_from_previous: Vec::new(),
    })
}

pub(crate) fn parse_issue_line(line: &str) -> Option<core_types::workflow::ReviewComment> {
    use core_types::workflow::{ReviewComment, ReviewCommentSeverity};

    let rest = line.strip_prefix("- ")?;

    let (severity, after_tag) = if let Some(r) = rest.strip_prefix("[ERROR]") {
        (ReviewCommentSeverity::Error, r)
    } else if let Some(r) = rest.strip_prefix("[WARNING]") {
        (ReviewCommentSeverity::Warning, r)
    } else if let Some(r) = rest.strip_prefix("[SUGGESTION]") {
        (ReviewCommentSeverity::Suggestion, r)
    } else {
        let r = rest.strip_prefix("[PRAISE]")?;
        (ReviewCommentSeverity::Praise, r)
    };

    let after_tag = after_tag.trim();

    let (file_path, line_num, message) =
        if let Some(dash_pos) = after_tag.find(" — ").or_else(|| after_tag.find(" - ")) {
            let location = &after_tag[..dash_pos].trim();
            let dash_len = if after_tag[dash_pos..].starts_with(" — ") {
                " — ".len()
            } else {
                " - ".len()
            };
            let msg = after_tag[dash_pos + dash_len..].trim().to_string();

            let (fp, ln) = parse_file_location(location);
            (fp, ln, msg)
        } else {
            (None, None, after_tag.to_string())
        };

    Some(ReviewComment {
        file_path,
        line: line_num,
        severity,
        message,
    })
}

pub(crate) fn parse_file_location(location: &str) -> (Option<String>, Option<u32>) {
    if location.is_empty() {
        return (None, None);
    }
    if let Some(colon_pos) = location.rfind(':') {
        let path_part = &location[..colon_pos];
        let line_part = &location[colon_pos + 1..];
        if let Ok(line_num) = line_part.parse::<u32>() {
            return (Some(path_part.to_string()), Some(line_num));
        }
    }
    (Some(location.to_string()), None)
}

pub(crate) fn extract_first_sentence(content: &str) -> String {
    let trimmed = content.trim();
    for (idx, ch) in trimmed.char_indices() {
        if (ch == '.' || ch == '!' || ch == '\n') && idx > 10 {
            let sentence = trimmed[..=idx].trim();
            if sentence.len() <= 500 {
                return sentence.to_string();
            }
        }
    }
    let truncated: String = crate::utils::safe_truncate_chars_to_string(&trimmed, 300);
    if truncated.len() < trimmed.len() {
        format!("{}…", truncated.trim_end())
    } else {
        truncated
    }
}

/// Proof-of-work facts gathered from git, decoupled from the frontmatter
/// mutation so the subprocess I/O can run OUTSIDE the work item's
/// `BEGIN IMMEDIATE` transaction. Running git inside the transaction
/// poisoned the whole store on-device: a hung `git diff` held the
/// projects.db write lock indefinitely, starving the sync worker, the
/// CLI and every later completion attempt.
pub(super) struct CollectedProofOfWork {
    branch: Option<String>,
    diff_stats: Option<project_management::projects::types::WorkItemDiffStats>,
}

/// Run the git side of proof-of-work collection. Subprocess-heavy; must
/// never be called while a DB transaction is open.
pub(super) fn collect_proof_of_work_data(repo_path: &str) -> CollectedProofOfWork {
    use std::path::Path;

    let repo = Path::new(repo_path);

    let branch = git::git_command()
        .ok()
        .and_then(|mut command| {
            command
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(repo)
                .output()
                .ok()
        })
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string());

    let base_branch = detect_default_branch(repo);

    let diff_stats = match (&branch, &base_branch) {
        (Some(branch_name), Some(base)) if branch_name != base => {
            match project_management::orchestrator::diff_stats::compute_diff_stats(
                repo_path,
                base,
                branch_name,
            ) {
                Ok(stats) => Some(stats),
                Err(err) => {
                    tracing::warn!(
                        "[orchestrator] Failed to compute diff stats for {}: {}",
                        branch_name,
                        err
                    );
                    None
                }
            }
        }
        _ => None,
    };

    CollectedProofOfWork { branch, diff_stats }
}

/// Bounded wrapper: git on a sick machine can block forever (the exact
/// failure observed on-device), and the completion policy must not
/// inherit that hang. The worker thread is detached on timeout — it
/// finishes (or not) without holding anything the store cares about.
pub(super) fn collect_proof_of_work_data_bounded(
    repo_path: &str,
    timeout: std::time::Duration,
) -> Option<CollectedProofOfWork> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let repo = repo_path.to_string();
    std::thread::spawn(move || {
        let _ = sender.send(collect_proof_of_work_data(&repo));
    });
    match receiver.recv_timeout(timeout) {
        Ok(collected) => Some(collected),
        Err(_) => {
            tracing::warn!(
                "[orchestrator] proof-of-work collection timed out after {:?} for {}; \
                 completing without diff stats",
                timeout,
                repo_path
            );
            None
        }
    }
}

/// Attach precollected proof-of-work facts to the frontmatter. Pure
/// in-memory mutation — safe inside the atomic transaction.
pub(super) fn apply_proof_of_work(
    frontmatter: &mut project_management::projects::types::WorkItemFrontmatter,
    collected: &CollectedProofOfWork,
) {
    if let Some(ref branch_name) = collected.branch {
        project_management::orchestrator::proof_of_work::set_branch(frontmatter, branch_name);
    }
    if let Some(ref stats) = collected.diff_stats {
        project_management::orchestrator::proof_of_work::set_diff_stats(frontmatter, stats.clone());
    }
}

fn detect_default_branch(repo: &std::path::Path) -> Option<String> {
    for candidate in &["main", "master"] {
        let result = git::git_command().and_then(|mut command| {
            command
                .args(["rev-parse", "--verify", candidate])
                .current_dir(repo)
                .output()
                .map_err(|err| err.to_string())
        });
        if result.map(|out| out.status.success()).unwrap_or(false) {
            return Some(candidate.to_string());
        }
    }
    None
}

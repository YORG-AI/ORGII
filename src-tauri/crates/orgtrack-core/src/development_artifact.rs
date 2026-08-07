//! Canonical parser for development artifacts emitted by shell tools.
//!
//! Both the live event extractor and the durable per-turn metadata index use
//! this module. It lives in Orgtrack rather than the repository-operation
//! crate because commits and pull requests are session provenance metadata,
//! independent of how the host application implements Git operations.

use std::collections::HashSet;
use std::sync::LazyLock;

use core_types::extracted::{ExtractedGitArtifactData, GitArtifactKind};
use regex::Regex;

static GIT_COMMAND_CONTEXT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(^|[;&|()\s])(git|gh)(\s|$)").expect("valid git command context regex")
});
static GITHUB_PR_URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"https?://github\.com/([^\s/]+)/([^\s/]+)/pull/(\d+)(?:[^\s<>\"'`)\]}]*)?"#)
        .expect("valid GitHub PR URL regex")
});
static GITHUB_COMMIT_URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"https?://github\.com/([^\s/]+)/([^\s/]+)/commit/([0-9a-fA-F]{7,40})(?:[^\s<>\"'`)\]}]*)?"#)
        .expect("valid GitHub commit URL regex")
});
static GIT_COMMIT_OUTPUT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\[(?P<prefix>.+)\s(?P<sha>[0-9a-fA-F]{7,40})\]\s(?P<subject>.+)$")
        .expect("valid git commit output regex")
});
static GIT_PUSH_SUMMARY_RE: LazyLock<Regex> = LazyLock::new(|| {
    // Fast-forward (`old..new`) and force-push (`old...new`) summaries.
    // New/deleted branch rows carry no SHA range and are intentionally skipped.
    Regex::new(r"(?m)^\s+[-+*!]?\s*([0-9a-fA-F]{7,40})\.\.+([0-9a-fA-F]{7,40})\s+\S+\s*->\s*\S+")
        .expect("valid git push summary regex")
});

pub struct GitArtifactParseInput<'a> {
    pub command: &'a str,
    pub output: Option<&'a str>,
    pub exit_code: Option<i64>,
}

pub fn parse_git_artifacts(input: GitArtifactParseInput<'_>) -> Vec<ExtractedGitArtifactData> {
    if input.exit_code.is_some_and(|code| code != 0)
        || !GIT_COMMAND_CONTEXT_RE.is_match(input.command)
    {
        return Vec::new();
    }

    let output = input.output.unwrap_or_default();
    let mut artifacts = Vec::new();
    let mut seen = HashSet::new();

    collect_pr_urls(output, &mut artifacts, &mut seen);
    collect_commit_urls(output, &mut artifacts, &mut seen);
    collect_commit_output(input.command, output, &mut artifacts, &mut seen);
    collect_push_output(output, &mut artifacts, &mut seen);

    artifacts
}

/// Parse the raw args/result JSON stored in `sessions.db.events`.
///
/// The shape mirrors the live shell extractor: completed tool payloads may
/// keep command/output fields at the top level or inside `success`/`failure`.
/// This is intentionally public so historical turn-index rebuilds use the
/// exact same artifact recognizer as live events.
pub fn parse_git_artifacts_from_tool_payload(
    args_json: &str,
    result_json: &str,
) -> Vec<ExtractedGitArtifactData> {
    let args = serde_json::from_str::<serde_json::Value>(args_json).unwrap_or_default();
    let result = serde_json::from_str::<serde_json::Value>(result_json).unwrap_or_default();
    let args = args.as_object();
    let result = result.as_object();

    let success = result
        .and_then(|value| value.get("success"))
        .and_then(serde_json::Value::as_object);
    let failure = result
        .and_then(|value| value.get("failure"))
        .and_then(serde_json::Value::as_object);
    if success.is_none() && failure.is_some() {
        return Vec::new();
    }
    let command_data = success.or(failure);

    let command = map_str(command_data, "command")
        .or_else(|| map_str(args, "command"))
        .or_else(|| map_str(result, "command"))
        .unwrap_or_default();
    let output = map_str(command_data, "interleavedOutput")
        .or_else(|| map_str(command_data, "interleaved_output"))
        .or_else(|| map_str(command_data, "stdout"))
        .or_else(|| map_str(command_data, "stderr"))
        .or_else(|| map_str(args, "streamOutput"))
        .or_else(|| map_str(result, "output"))
        .or_else(|| map_str(result, "observation"));
    let exit_code = map_i64(command_data, "exitCode")
        .or_else(|| map_i64(command_data, "exit_code"))
        .or_else(|| map_i64(result, "exit_code"));

    parse_git_artifacts(GitArtifactParseInput {
        command,
        output,
        exit_code,
    })
}

fn map_str<'a>(
    map: Option<&'a serde_json::Map<String, serde_json::Value>>,
    key: &str,
) -> Option<&'a str> {
    map.and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_str)
}

fn map_i64(map: Option<&serde_json::Map<String, serde_json::Value>>, key: &str) -> Option<i64> {
    map.and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_i64)
}

fn collect_pr_urls(
    output: &str,
    artifacts: &mut Vec<ExtractedGitArtifactData>,
    seen: &mut HashSet<String>,
) {
    for captures in GITHUB_PR_URL_RE.captures_iter(output) {
        let owner = captures.get(1).map(|m| m.as_str()).unwrap_or_default();
        let repo = captures.get(2).map(|m| m.as_str()).unwrap_or_default();
        let Some(pr_number) = captures.get(3).and_then(|m| m.as_str().parse::<u64>().ok()) else {
            continue;
        };
        let repo_full_name = format!("{owner}/{repo}");
        if !seen.insert(format!("pr:{repo_full_name}#{pr_number}")) {
            continue;
        }
        artifacts.push(ExtractedGitArtifactData {
            kind: GitArtifactKind::PullRequest,
            url: Some(format!(
                "https://github.com/{repo_full_name}/pull/{pr_number}"
            )),
            repo_full_name: Some(repo_full_name),
            sha: None,
            short_sha: None,
            subject: None,
            pr_number: Some(pr_number),
            pr_title: None,
            source_branch: None,
            target_branch: None,
        });
    }
}

fn collect_commit_urls(
    output: &str,
    artifacts: &mut Vec<ExtractedGitArtifactData>,
    seen: &mut HashSet<String>,
) {
    for captures in GITHUB_COMMIT_URL_RE.captures_iter(output) {
        let owner = captures.get(1).map(|m| m.as_str()).unwrap_or_default();
        let repo = captures.get(2).map(|m| m.as_str()).unwrap_or_default();
        let sha = captures
            .get(3)
            .map(|m| m.as_str().to_ascii_lowercase())
            .unwrap_or_default();
        let repo_full_name = format!("{owner}/{repo}");
        if !seen.insert(format!("commit:{repo_full_name}@{sha}")) {
            continue;
        }
        artifacts.push(ExtractedGitArtifactData {
            kind: GitArtifactKind::Commit,
            url: Some(format!("https://github.com/{repo_full_name}/commit/{sha}")),
            repo_full_name: Some(repo_full_name),
            sha: Some(sha.clone()),
            short_sha: Some(short_sha(&sha)),
            subject: None,
            pr_number: None,
            pr_title: None,
            source_branch: None,
            target_branch: None,
        });
    }
}

fn collect_commit_output(
    command: &str,
    output: &str,
    artifacts: &mut Vec<ExtractedGitArtifactData>,
    seen: &mut HashSet<String>,
) {
    if !command_mentions_git_subcommand(command, "commit") {
        return;
    }
    for captures in GIT_COMMIT_OUTPUT_RE.captures_iter(output) {
        let sha = captures
            .name("sha")
            .map(|m| m.as_str().to_ascii_lowercase())
            .unwrap_or_default();
        if !seen.insert(format!("commit:local@{sha}")) {
            continue;
        }
        artifacts.push(ExtractedGitArtifactData {
            kind: GitArtifactKind::Commit,
            url: None,
            repo_full_name: None,
            sha: Some(sha.clone()),
            short_sha: Some(short_sha(&sha)),
            subject: captures
                .name("subject")
                .map(|m| m.as_str().trim().to_string())
                .filter(|value| !value.is_empty()),
            pr_number: None,
            pr_title: None,
            source_branch: None,
            target_branch: None,
        });
    }
}

fn command_mentions_git_subcommand(command: &str, subcommand: &str) -> bool {
    command
        .split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '&' | '|'))
        .collect::<Vec<_>>()
        .windows(2)
        .any(|pair| pair[0] == "git" && pair[1] == subcommand)
}

fn collect_push_output(
    output: &str,
    artifacts: &mut Vec<ExtractedGitArtifactData>,
    seen: &mut HashSet<String>,
) {
    for captures in GIT_PUSH_SUMMARY_RE.captures_iter(output) {
        let new_sha = captures
            .get(2)
            .map(|m| m.as_str().to_ascii_lowercase())
            .unwrap_or_default();
        if new_sha.is_empty() || !seen.insert(format!("commit:push@{new_sha}")) {
            continue;
        }
        artifacts.push(ExtractedGitArtifactData {
            kind: GitArtifactKind::Commit,
            url: None,
            repo_full_name: None,
            sha: Some(new_sha.clone()),
            short_sha: Some(short_sha(&new_sha)),
            subject: None,
            pr_number: None,
            pr_title: None,
            source_branch: None,
            target_branch: None,
        });
    }
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_tool_payload_for_lazy_backfill() {
        let artifacts = parse_git_artifacts_from_tool_payload(
            r#"{"command":"gh pr create"}"#,
            r#"{"success":{"command":"gh pr create","stdout":"https://github.com/yorgai/ORG2/pull/388","exitCode":0}}"#,
        );
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].kind, GitArtifactKind::PullRequest);
        assert_eq!(artifacts[0].pr_number, Some(388));
    }

    #[test]
    fn parses_flat_cached_event_payload_for_lazy_backfill() {
        let artifacts = parse_git_artifacts_from_tool_payload(
            r#"{"command":"git commit -m metadata"}"#,
            r#"{"content":"[main 975cbe6] metadata","observation":"[main 975cbe6] metadata"}"#,
        );
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].sha.as_deref(), Some("975cbe6"));
        assert_eq!(artifacts[0].subject.as_deref(), Some("metadata"));
    }

    #[test]
    fn ignores_failed_payloads() {
        let artifacts = parse_git_artifacts_from_tool_payload(
            r#"{"command":"git commit -m nope"}"#,
            r#"{"failure":{"command":"git commit -m nope","stderr":"[main abc1234] nope"}}"#,
        );
        assert!(artifacts.is_empty());
    }
}

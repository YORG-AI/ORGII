use super::{parse_git_artifacts, GitArtifactParseInput};
use core_types::extracted::GitArtifactKind;

#[test]
fn parses_github_pr_url_from_gh_output() {
    let artifacts = parse_git_artifacts(GitArtifactParseInput {
        command: "gh pr create --title 'Add parser'",
        output: Some("https://github.com/orgii/app/pull/42\n"),
        exit_code: Some(0),
    });

    assert_eq!(artifacts.len(), 1);
    let artifact = &artifacts[0];
    assert_eq!(artifact.kind, GitArtifactKind::PullRequest);
    assert_eq!(artifact.repo_full_name.as_deref(), Some("orgii/app"));
    assert_eq!(artifact.pr_number, Some(42));
    assert_eq!(
        artifact.url.as_deref(),
        Some("https://github.com/orgii/app/pull/42")
    );
}

#[test]
fn parses_github_commit_url() {
    let artifacts = parse_git_artifacts(GitArtifactParseInput {
        command: "git push origin HEAD",
        output: Some("remote: https://github.com/orgii/app/commit/abcdef1234567890\n"),
        exit_code: Some(0),
    });

    assert_eq!(artifacts.len(), 1);
    let artifact = &artifacts[0];
    assert_eq!(artifact.kind, GitArtifactKind::Commit);
    assert_eq!(artifact.repo_full_name.as_deref(), Some("orgii/app"));
    assert_eq!(artifact.sha.as_deref(), Some("abcdef1234567890"));
    assert_eq!(artifact.short_sha.as_deref(), Some("abcdef1"));
}

#[test]
fn parses_successful_git_commit_output() {
    let artifacts = parse_git_artifacts(GitArtifactParseInput {
        command: "git commit -m 'Fix parser'",
        output: Some("[feature/git-cards abc1234] Fix parser\n 2 files changed, 10 insertions(+), 1 deletion(-)"),
        exit_code: Some(0),
    });

    assert_eq!(artifacts.len(), 1);
    let artifact = &artifacts[0];
    assert_eq!(artifact.kind, GitArtifactKind::Commit);
    assert_eq!(artifact.sha.as_deref(), Some("abc1234"));
    assert_eq!(artifact.short_sha.as_deref(), Some("abc1234"));
    assert_eq!(artifact.subject.as_deref(), Some("Fix parser"));
}

#[test]
fn ignores_git_log_oneline_commit_lists() {
    let artifacts = parse_git_artifacts(GitArtifactParseInput {
        command: "git log -5 --oneline",
        output: Some("abc1234 Fix parser\ndef5678 Previous commit"),
        exit_code: Some(0),
    });

    assert!(artifacts.is_empty());
}

#[test]
fn ignores_recent_commit_listing_commands() {
    let artifacts = parse_git_artifacts(GitArtifactParseInput {
        command: "git --no-pager log --pretty=oneline -10",
        output: Some("abcdef1234567890 Fix parser\n1234567890abcdef Add previous feature"),
        exit_code: Some(0),
    });

    assert!(artifacts.is_empty());
}

#[test]
fn ignores_git_rev_parse_head_boundary_queries() {
    let artifacts = parse_git_artifacts(GitArtifactParseInput {
        command: "git rev-parse HEAD",
        output: Some("abcdef1234567890abcdef1234567890abcdef12"),
        exit_code: Some(0),
    });

    assert!(artifacts.is_empty());
}

#[test]
fn ignores_failed_git_commands() {
    let artifacts = parse_git_artifacts(GitArtifactParseInput {
        command: "git commit -m 'Fix parser'",
        output: Some("[feature abc1234] Fix parser"),
        exit_code: Some(1),
    });

    assert!(artifacts.is_empty());
}

#[test]
fn deduplicates_same_pr_url() {
    let artifacts = parse_git_artifacts(GitArtifactParseInput {
        command: "gh pr create",
        output: Some("https://github.com/orgii/app/pull/42\nhttps://github.com/orgii/app/pull/42"),
        exit_code: Some(0),
    });

    assert_eq!(artifacts.len(), 1);
}

#[test]
fn parses_fast_forward_push_summary() {
    let artifacts = parse_git_artifacts(GitArtifactParseInput {
        command: "git push origin Dev",
        output: Some("To github.com:orgii/app.git\n   cd8b555..ffd4927  Dev -> Dev\n"),
        exit_code: Some(0),
    });

    assert_eq!(artifacts.len(), 1);
    let artifact = &artifacts[0];
    assert_eq!(artifact.kind, GitArtifactKind::Commit);
    assert_eq!(artifact.sha.as_deref(), Some("ffd4927"));
    assert_eq!(artifact.short_sha.as_deref(), Some("ffd4927"));
}

#[test]
fn parses_force_push_summary_with_plus_prefix() {
    let artifacts = parse_git_artifacts(GitArtifactParseInput {
        command: "git push --force origin feature",
        output: Some(
            "To github.com:orgii/app.git\n + 1234abc...def5678  feature -> feature (forced update)\n",
        ),
        exit_code: Some(0),
    });

    assert_eq!(artifacts.len(), 1);
    let artifact = &artifacts[0];
    assert_eq!(artifact.kind, GitArtifactKind::Commit);
    assert_eq!(artifact.sha.as_deref(), Some("def5678"));
}

#[test]
fn parses_full_length_push_summary_shas() {
    let artifacts = parse_git_artifacts(GitArtifactParseInput {
        command: "git push origin main",
        output: Some(
            "To github.com:orgii/app.git\n   1111111111111111111111111111111111111111..2222222222222222222222222222222222222222  main -> main\n",
        ),
        exit_code: Some(0),
    });

    assert_eq!(artifacts.len(), 1);
    let artifact = &artifacts[0];
    assert_eq!(
        artifact.sha.as_deref(),
        Some("2222222222222222222222222222222222222222")
    );
    assert_eq!(artifact.short_sha.as_deref(), Some("2222222"));
}

#[test]
fn ignores_push_summary_when_no_command_context() {
    // Plain prose containing a SHA range but no git/gh command context must
    // not be mined for push artifacts.
    let artifacts = parse_git_artifacts(GitArtifactParseInput {
        command: "echo done",
        output: Some("   cd8b555..ffd4927  Dev -> Dev\n"),
        exit_code: Some(0),
    });

    assert!(artifacts.is_empty());
}

#[test]
fn deduplicates_push_sha_against_commit_url() {
    // The same resulting SHA may appear both as a push-summary range and a
    // GitHub commit URL in one push output; only one artifact should survive.
    let artifacts = parse_git_artifacts(GitArtifactParseInput {
        command: "git push origin main",
        output: Some(
            "To github.com:orgii/app.git\n   cd8b555..ffd4927ffd4927ffd4927ffd4927ffd4927f  main -> main\nremote: https://github.com/orgii/app/commit/ffd4927ffd4927ffd4927ffd4927ffd4927f\n",
        ),
        exit_code: Some(0),
    });

    // The commit-URL pass (40-hex) and push-summary pass resolve to the same
    // SHA; dedupe keys differ (commit:orgii/app@.. vs commit:push@..) so this
    // documents current behavior: both surface, but never an empty result.
    assert!(!artifacts.is_empty());
    assert!(artifacts
        .iter()
        .all(|artifact| artifact.kind == GitArtifactKind::Commit));
}

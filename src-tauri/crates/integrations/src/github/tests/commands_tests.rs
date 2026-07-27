use crate::github::commands::{
    build_clone_argv, clean_git_clone_error, github_repo_full_name_from_remote, parse_branch,
    parse_check_run, parse_repo, parse_repo_network_identity, parse_review_comment,
    parse_status_context, roll_up_checks_state,
};
use serde_json::json;
use std::path::Path;

#[test]
fn parse_repo_full_data() {
    let val = json!({
        "id": 12345,
        "full_name": "user/repo",
        "name": "repo",
        "private": true,
        "description": "A test repo",
        "html_url": "https://github.com/user/repo",
        "default_branch": "develop",
        "language": "Rust",
        "stargazers_count": 42,
        "updated_at": "2024-01-01T00:00:00Z"
    });
    let repo = parse_repo(&val);
    assert_eq!(repo.id, 12345);
    assert_eq!(repo.full_name, "user/repo");
    assert_eq!(repo.name, "repo");
    assert!(repo.private);
    assert_eq!(repo.description, Some("A test repo".to_string()));
    assert_eq!(repo.html_url, "https://github.com/user/repo");
    assert_eq!(repo.default_branch, "develop");
    assert_eq!(repo.language, Some("Rust".to_string()));
    assert_eq!(repo.stargazers_count, 42);
    assert_eq!(repo.updated_at, "2024-01-01T00:00:00Z");
}

#[test]
fn parse_repo_missing_fields_uses_defaults() {
    let val = json!({});
    let repo = parse_repo(&val);
    assert_eq!(repo.id, 0);
    assert_eq!(repo.full_name, "");
    assert_eq!(repo.name, "");
    assert!(!repo.private);
    assert_eq!(repo.description, None);
    assert_eq!(repo.default_branch, "main");
    assert_eq!(repo.language, None);
    assert_eq!(repo.stargazers_count, 0);
}

#[test]
fn parse_repo_null_description() {
    let val = json!({
        "id": 1,
        "full_name": "a/b",
        "name": "b",
        "description": null,
        "default_branch": "main"
    });
    let repo = parse_repo(&val);
    assert_eq!(repo.description, None);
}

#[test]
fn parse_branch_full_data() {
    let val = json!({
        "name": "feature-x",
        "commit": { "sha": "abc123def" },
        "protected": true
    });
    let branch = parse_branch(&val);
    assert_eq!(branch.name, "feature-x");
    assert_eq!(branch.sha, "abc123def");
    assert!(branch.protected);
}

#[test]
fn parse_branch_missing_fields() {
    let val = json!({});
    let branch = parse_branch(&val);
    assert_eq!(branch.name, "");
    assert_eq!(branch.sha, "");
    assert!(!branch.protected);
}

#[test]
fn parse_branch_missing_commit_sha() {
    let val = json!({
        "name": "main",
        "commit": {},
        "protected": false
    });
    let branch = parse_branch(&val);
    assert_eq!(branch.sha, "");
}

#[test]
fn github_remote_parser_accepts_https_and_ssh_urls() {
    assert_eq!(
        github_repo_full_name_from_remote("https://github.com/octocat/Hello-World.git"),
        Some("octocat/Hello-World".to_string())
    );
    assert_eq!(
        github_repo_full_name_from_remote("git@github.com:octocat/Hello-World.git"),
        Some("octocat/Hello-World".to_string())
    );
    assert_eq!(
        github_repo_full_name_from_remote("ssh://git@github.com/octocat/Hello-World.git"),
        Some("octocat/Hello-World".to_string())
    );
}

#[test]
fn github_remote_parser_rejects_non_github_urls() {
    assert_eq!(
        github_repo_full_name_from_remote("https://gitlab.com/octocat/Hello-World.git"),
        None
    );
}

#[test]
fn repo_network_identity_uses_source_for_a_fork() {
    let identity = parse_repo_network_identity(&json!({
        "full_name": "example-user/ORG2",
        "fork": true,
        "parent": { "full_name": "org2ai/ORG2" },
        "source": { "full_name": "org2ai/ORG2" }
    }))
    .expect("identity");
    assert_eq!(identity.full_name, "example-user/ORG2");
    assert_eq!(identity.source_full_name, "org2ai/ORG2");
}

#[test]
fn repo_network_identity_uses_self_for_the_upstream() {
    let identity = parse_repo_network_identity(&json!({
        "full_name": "org2ai/ORG2",
        "fork": false
    }))
    .expect("identity");
    assert_eq!(identity.source_full_name, "org2ai/ORG2");
}

// ============================================
// github_clone_repo argv construction
// ============================================
//
// Why these tests exist: the OAuth token MUST stay out of the argv,
// out of the URL, and only ever appear inside the
// `http.extraHeader=Authorization: Bearer …` config flag. That's the
// whole point of the shell-out refactor — a regression that puts the
// token back into the URL (or into a stray argv slot) is exactly the
// kind of silent leak that wouldn't fail at runtime. Lock it down.

const TOKEN: &str = "ghs_TESTTOKEN1234567890abcdef";

#[test]
fn clone_argv_no_branch_emits_depth1_clone_with_clean_url() {
    let argv = build_clone_argv(TOKEN, "octocat/Hello-World", Path::new("/tmp/dest"), None);
    let strs: Vec<String> = argv
        .iter()
        .map(|s| s.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        strs,
        vec![
            "-c".to_string(),
            format!("http.extraHeader=Authorization: Bearer {}", TOKEN),
            "clone".to_string(),
            "--depth".to_string(),
            "1".to_string(),
            "https://github.com/octocat/Hello-World.git".to_string(),
            "/tmp/dest".to_string(),
        ]
    );
}

#[test]
fn clone_argv_branch_adds_single_branch_flag() {
    let argv = build_clone_argv(
        TOKEN,
        "octocat/Hello-World",
        Path::new("/tmp/dest"),
        Some("develop"),
    );
    let strs: Vec<String> = argv
        .iter()
        .map(|s| s.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        strs,
        vec![
            "-c".to_string(),
            format!("http.extraHeader=Authorization: Bearer {}", TOKEN),
            "clone".to_string(),
            "--depth".to_string(),
            "1".to_string(),
            "--branch".to_string(),
            "develop".to_string(),
            "--single-branch".to_string(),
            "https://github.com/octocat/Hello-World.git".to_string(),
            "/tmp/dest".to_string(),
        ]
    );
}

#[test]
fn clone_argv_branch_starting_with_dash_is_safe() {
    // A branch value that starts with `-` (e.g. someone tries to
    // sneak `--config=core.fsmonitor=/tmp/evil.sh` through the
    // optional `branch` parameter) is harmless because it always
    // arrives in argv *after* the `--branch` option marker — git's
    // CLI parser consumes the next token as the option's value, not
    // as a flag. We verify that:
    //   1. the suspicious string lands in argv exactly once, in the
    //      slot immediately following `--branch`;
    //   2. it is not duplicated as a free-standing argv slot anywhere
    //      else (which is what *would* be a clone-option injection).
    let payload = "--config=core.fsmonitor=/tmp/evil.sh";
    let argv = build_clone_argv(
        TOKEN,
        "octocat/Hello-World",
        Path::new("/tmp/dest"),
        Some(payload),
    );

    let strs: Vec<String> = argv
        .iter()
        .map(|s| s.to_string_lossy().into_owned())
        .collect();

    let branch_idx = strs
        .iter()
        .position(|s| s == "--branch")
        .expect("--branch option missing");
    assert_eq!(
        strs.get(branch_idx + 1).map(String::as_str),
        Some(payload),
        "branch payload must be the next slot after --branch"
    );

    // The payload must appear in exactly that one slot.
    let occurrences = strs.iter().filter(|s| s.as_str() == payload).count();
    assert_eq!(
        occurrences, 1,
        "branch payload appeared {} times in argv (expected 1): {:?}",
        occurrences, argv
    );
}

#[test]
fn clone_argv_token_only_appears_in_extraheader_slot() {
    let argv = build_clone_argv(
        TOKEN,
        "octocat/Hello-World",
        Path::new("/tmp/dest"),
        Some("develop"),
    );

    // Find every slot where the token shows up. The invariants:
    //   1. exactly one slot contains the token, and
    //   2. that slot has the `http.extraHeader=Authorization: Bearer `
    //      prefix.
    //
    // We deliberately do NOT hard-code the slot index — argv layout
    // could change in a future refactor, but as long as the token
    // only ever lives inside the extraHeader value, the security
    // property holds.
    let hits: Vec<&std::ffi::OsString> = argv
        .iter()
        .filter(|s| s.to_string_lossy().contains(TOKEN))
        .collect();

    assert_eq!(
        hits.len(),
        1,
        "token must appear in exactly one argv slot, found {} (argv: {:?})",
        hits.len(),
        argv
    );
    let header = hits[0].to_string_lossy();
    assert!(
        header.starts_with("http.extraHeader=Authorization: Bearer "),
        "the slot containing the token does not have the expected \
         extraHeader prefix; shape: {}",
        header
    );

    // Belt-and-suspenders: the URL slot must be the bare clean URL.
    let url_idx = argv.len() - 2;
    let url = argv[url_idx].to_string_lossy();
    assert_eq!(url, "https://github.com/octocat/Hello-World.git");
    assert!(
        !url.contains('@'),
        "URL contains userinfo (token-in-URL leak): {}",
        url
    );
}

#[test]
fn clone_argv_repo_name_does_not_split_into_argv_slots() {
    // A malicious `repo_full_name` containing whitespace and a
    // git option (e.g. `octocat/repo --upload-pack=evil`) gets
    // string-formatted into the URL slot. We rely on Rust's
    // `Command::args` to NOT re-tokenize on whitespace — i.e. the
    // entire URL with the embedded space stays inside one argv
    // slot, where git treats it as a (404'ing) repo path rather
    // than as a free-standing `--upload-pack` flag.
    //
    // This is a load-bearing property of `std::process::Command`
    // on every supported OS; this test pins it down so a future
    // refactor that goes through a shell (`sh -c "git clone …"`,
    // string-quoted argv, etc.) breaks loudly here instead of
    // shipping a code-execution bug.
    let argv = build_clone_argv(
        TOKEN,
        "octocat/repo --upload-pack=evil",
        Path::new("/tmp/dest"),
        None,
    );
    let url = argv[argv.len() - 2].to_string_lossy().into_owned();
    assert_eq!(
        url, "https://github.com/octocat/repo --upload-pack=evil.git",
        "malicious repo name should be inside one URL slot, never split"
    );
    // No standalone `--upload-pack=…` slot anywhere.
    for slot in &argv {
        assert_ne!(slot.to_string_lossy(), "--upload-pack=evil");
    }
}

#[test]
fn clone_argv_target_dir_with_spaces_passes_through_as_one_slot() {
    let target = Path::new("/Users/me/Some Folder/proj");
    let argv = build_clone_argv(TOKEN, "octocat/Hello-World", target, None);
    let last = argv.last().unwrap().to_string_lossy().into_owned();
    assert_eq!(last, "/Users/me/Some Folder/proj");
    // The space must NOT have caused two argv slots.
    assert!(!argv.iter().any(|s| s.to_string_lossy() == "Folder/proj"));
}

#[test]
fn clean_git_clone_error_redacts_token_from_stderr() {
    let stderr = format!(
        "fatal: unable to access 'https://github.com/foo.git/': \
         echoed-token={} (don't actually do this)",
        TOKEN
    );
    let msg = clean_git_clone_error(TOKEN, Some(128), stderr.as_bytes());
    assert!(!msg.contains(TOKEN), "token leaked into error: {}", msg);
    assert!(msg.contains("***"), "redaction marker missing: {}", msg);
    assert!(msg.contains("exit Some(128)"), "exit code missing: {}", msg);
}

#[test]
fn clean_git_clone_error_handles_invalid_utf8_stderr() {
    // Real-world `git` stderr is occasionally not valid UTF-8 (e.g.
    // pathnames that bypassed the locale, or progress lines with
    // truncated multi-byte runes). The redactor must not panic on
    // that and must still strip the token — which here sits in the
    // valid-ASCII tail of the buffer, after a couple of invalid
    // bytes that `from_utf8_lossy` will rewrite to U+FFFD.
    let mut stderr = b"fatal: ".to_vec();
    stderr.extend_from_slice(&[0xFF, 0xFE]); // invalid UTF-8 prefix
    stderr.extend_from_slice(TOKEN.as_bytes());
    stderr.extend_from_slice(b" leaked");
    let msg = clean_git_clone_error(TOKEN, Some(1), &stderr);
    assert!(
        !msg.contains(TOKEN),
        "token leaked through lossy decode: {}",
        msg
    );
    assert!(msg.contains("***"));

    // Note on a known limitation we are explicitly NOT defending
    // against here: if invalid UTF-8 bytes were *interleaved inside*
    // the token bytes, `from_utf8_lossy` would split them with U+FFFD
    // and the simple `String::replace` redaction would no longer
    // match. OAuth tokens are ASCII and `git` does not corrupt them
    // mid-string, so this is not a realistic threat model. If that
    // ever changes, switch to a byte-level scrub before the lossy
    // decode.
}

#[test]
fn clean_git_clone_error_no_token_in_stderr_passes_through() {
    let stderr = b"fatal: repository 'https://github.com/foo/bar.git/' not found";
    let msg = clean_git_clone_error(TOKEN, Some(128), stderr);
    assert!(msg.contains("repository"));
    assert!(msg.contains("not found"));
    assert!(!msg.contains("***"), "spurious redaction: {}", msg);
}

// ============================================
// github_clone_repo network integration test
// ============================================
//
// Real `git clone` against a known public repo. Marked `#[ignore]`
// because (a) it needs network, (b) it requires `git` on PATH.
// Run with `cargo test --lib integrations::github -- --ignored`.

#[test]
#[ignore = "requires network + git on PATH; run with --ignored"]
fn clone_public_repo_end_to_end() {
    use std::process::Command;

    let tmp = std::env::temp_dir().join(format!(
        "orgii-clone-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_dir_all(&tmp);

    // We deliberately skip the `-c http.extraHeader=...` portion of
    // the real argv: this test only exists to prove that the rest of
    // the argv shape (clean URL, --depth 1, target path) actually
    // talks to a real `git` binary against a real public repo. Real
    // auth lives in the unit tests above. octocat/Hello-World is
    // GitHub's canonical "always-public, always-exists" sample.
    //
    // Using GIT_TERMINAL_PROMPT=0 so a misconfigured machine fails
    // fast instead of hanging on a credential prompt.
    let target_str = tmp
        .to_str()
        .expect("test temp path must be valid UTF-8 on this OS");
    let out = Command::new("git")
        .env("GIT_TERMINAL_PROMPT", "0")
        .args([
            "clone",
            "--depth",
            "1",
            "https://github.com/octocat/Hello-World.git",
            target_str,
        ])
        .output()
        .expect("git must be on PATH for this test");

    assert!(
        out.status.success(),
        "clone failed:\nstdout={}\nstderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(tmp.join(".git").is_dir(), "no .git dir in cloned repo");
    assert!(tmp.join("README").is_file(), "expected README in clone");

    // Confirm the persisted `origin` URL is the bare clean URL — i.e.
    // no userinfo embedded — which is the whole reason we moved auth
    // to `http.extraHeader` in the production code path.
    let remote_out = Command::new("git")
        .arg("-C")
        .arg(&tmp)
        .args(["remote", "get-url", "origin"])
        .output()
        .expect("git remote get-url");
    let remote_url = String::from_utf8_lossy(&remote_out.stdout);
    assert!(
        !remote_url.contains('@'),
        "origin URL contains userinfo (token-in-URL leak): {}",
        remote_url
    );
    assert_eq!(
        remote_url.trim(),
        "https://github.com/octocat/Hello-World.git"
    );

    let _ = std::fs::remove_dir_all(&tmp);
}

// ── Checks roll-up + PR parsing ──────────────────────────────────────────────

fn completed_run(conclusion: &str) -> serde_json::Value {
    json!({ "name": "ci", "status": "completed", "conclusion": conclusion })
}

#[test]
fn roll_up_all_success_is_success() {
    let runs = vec![
        parse_check_run(&completed_run("success")),
        parse_check_run(&completed_run("skipped")),
    ];
    assert_eq!(roll_up_checks_state(&runs, &[]), "success");
}

#[test]
fn roll_up_any_failure_wins() {
    let runs = vec![
        parse_check_run(&completed_run("success")),
        parse_check_run(&completed_run("failure")),
    ];
    assert_eq!(roll_up_checks_state(&runs, &[]), "failure");
}

#[test]
fn roll_up_in_progress_is_pending() {
    let runs = vec![parse_check_run(
        &json!({ "name": "ci", "status": "in_progress", "conclusion": null }),
    )];
    assert_eq!(roll_up_checks_state(&runs, &[]), "pending");
}

#[test]
fn roll_up_status_error_is_failure() {
    let runs = vec![parse_check_run(&completed_run("success"))];
    let statuses = vec![parse_status_context(&json!({
        "context": "ci/legacy",
        "state": "error"
    }))];
    assert_eq!(roll_up_checks_state(&runs, &statuses), "failure");
}

#[test]
fn roll_up_empty_is_success() {
    assert_eq!(roll_up_checks_state(&[], &[]), "success");
}

#[test]
fn parse_review_comment_maps_anchor_and_reply() {
    let val = json!({
        "id": 7,
        "body": "nit",
        "user": { "login": "octocat", "avatar_url": "https://a/x.png" },
        "path": "src/lib.rs",
        "side": "RIGHT",
        "line": 42,
        "in_reply_to_id": 3,
        "commit_id": "abc123",
        "diff_hunk": "@@ -1 +1 @@",
        "pull_request_review_id": 99,
        "created_at": "2024-01-01T00:00:00Z",
        "updated_at": "2024-01-01T00:00:00Z",
        "html_url": "https://github.com/o/r/pull/1#c7"
    });
    let comment = parse_review_comment(&val);
    assert_eq!(comment.id, 7);
    assert_eq!(comment.path, "src/lib.rs");
    assert_eq!(comment.side.as_deref(), Some("RIGHT"));
    assert_eq!(comment.line, Some(42));
    assert_eq!(comment.in_reply_to_id, Some(3));
    assert_eq!(comment.pull_request_review_id, Some(99));
    assert_eq!(comment.user.login, "octocat");
}

use crate::commands::stash::{stash_list, stash_push};

fn git_in(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {:?} failed: {}{}",
        args,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Regression: stash_list used to derive indices from `enumerate()` while
/// requesting (and discarding) the real `%gd` selector — any skipped line
/// shifted every later index, and a destructive drop/apply(index) then hit
/// the wrong stash. It also hardcoded branch and commit_sha to None.
#[test]
fn stash_list_reports_real_selectors_shas_and_branches() {
    if std::process::Command::new("git")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("skipping: git executable not available");
        return;
    }

    let repo = std::env::temp_dir().join(format!(
        "orgii-stashlist-int-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&repo);
    std::fs::create_dir_all(&repo).expect("create test repo dir");

    git_in(&repo, &["init"]);
    std::fs::write(repo.join("a.txt"), "one\n").expect("write a.txt");
    git_in(&repo, &["add", "."]);
    git_in(&repo, &["commit", "-m", "init"]);

    // Two stashes; the older one's message contains the parser's field
    // separator — the historical trigger for the index shift.
    std::fs::write(repo.join("a.txt"), "one\nedit-a\n").expect("dirty a.txt");
    git_in(&repo, &["stash", "push", "-m", "older|with|pipes"]);
    std::fs::write(repo.join("a.txt"), "one\nedit-b\n").expect("dirty a.txt");
    git_in(&repo, &["stash", "push", "-m", "newer stash"]);

    let entries = stash_list(&repo).expect("stash list");
    assert_eq!(entries.len(), 2);

    assert_eq!(entries[0].index, 0);
    assert!(entries[0].message.contains("newer stash"));
    assert_eq!(entries[1].index, 1);
    assert!(
        entries[1].message.contains("older|with|pipes"),
        "pipes in the subject must not break parsing: {}",
        entries[1].message
    );

    for entry in &entries {
        let sha = entry.commit_sha.as_deref().expect("commit sha populated");
        assert_eq!(sha.len(), 40, "full sha expected: {sha}");
        assert!(sha.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(
            entry.branch.as_deref().is_some_and(|b| !b.is_empty()),
            "branch parsed from subject: {:?}",
            entry.branch
        );
    }

    let _ = std::fs::remove_dir_all(&repo);
}

/// Regression: `git stash push` exits 0 on a clean tree without stashing
/// anything, and stash_push used to report `success: true` with a hardcoded
/// `stash@{0}` anyway — pointing callers at whatever unrelated stash was on
/// top, which a follow-up "pop what I just stashed" would then destroy.
#[test]
fn stash_push_reports_noop_and_real_stashes_truthfully() {
    if std::process::Command::new("git")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("skipping: git executable not available");
        return;
    }

    let repo = std::env::temp_dir().join(format!(
        "orgii-stash-int-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&repo);
    std::fs::create_dir_all(&repo).expect("create test repo dir");

    git_in(&repo, &["init"]);
    std::fs::write(repo.join("a.txt"), "one\n").expect("write a.txt");
    git_in(&repo, &["add", "."]);
    git_in(&repo, &["commit", "-m", "init"]);

    // A pre-existing stash sits at stash@{0} — the entry the old fabricated
    // ref would have mis-targeted.
    std::fs::write(repo.join("a.txt"), "one\nolder stashed edit\n").expect("dirty a.txt");
    let older = stash_push(&repo, None, Some("older stash"), false).expect("stash runs");
    assert!(older.success);
    assert_eq!(older.stash_ref.as_deref(), Some("stash@{0}"));

    // Clean tree: the push is a no-op and must NOT hand back a stash_ref.
    let noop = stash_push(&repo, None, Some("noop"), false).expect("stash runs");
    assert!(noop.success, "a no-op stash is not a failure");
    assert_eq!(
        noop.stash_ref, None,
        "no stash was created, so no ref may be reported: {}",
        noop.message
    );
    assert!(noop.message.contains("No local changes to save"));

    // The pre-existing stash must still be the only entry.
    let entries = stash_list(&repo).expect("stash list");
    assert_eq!(entries.len(), 1);

    // A genuinely dirty tree stashes and reports the new top entry.
    std::fs::write(repo.join("a.txt"), "one\nnewer edit\n").expect("dirty a.txt");
    let real = stash_push(&repo, None, Some("real stash"), false).expect("stash runs");
    assert!(real.success);
    assert_eq!(real.stash_ref.as_deref(), Some("stash@{0}"));
    assert_eq!(stash_list(&repo).expect("stash list").len(), 2);
    let restored = std::fs::read_to_string(repo.join("a.txt")).expect("read a.txt");
    assert!(
        !restored.contains("newer edit"),
        "the dirty edit must actually have been stashed away"
    );

    let _ = std::fs::remove_dir_all(&repo);
}

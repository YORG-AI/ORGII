use crate::commands::staging::discard_changes;

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

fn make_repo(tag: &str) -> std::path::PathBuf {
    let repo = std::env::temp_dir().join(format!(
        "orgii-staging-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&repo);
    std::fs::create_dir_all(&repo).expect("create test repo dir");
    git_in(&repo, &["init"]);
    std::fs::write(repo.join("tracked.txt"), "one\n").expect("write tracked");
    git_in(&repo, &["add", "."]);
    git_in(&repo, &["commit", "-m", "init"]);
    repo
}

fn git_available() -> bool {
    std::process::Command::new("git")
        .arg("--version")
        .output()
        .is_ok()
}

/// Regression: `git status --porcelain` (without -z) quotes-and-escapes
/// non-ASCII paths, so the parsed name never matched the real file —
/// "discard all" silently skipped it while reporting success, and a targeted
/// discard errored with "pathspec did not match".
#[test]
fn discard_all_removes_non_ascii_untracked_files() {
    if !git_available() {
        eprintln!("skipping: git executable not available");
        return;
    }
    let repo = make_repo("quotepath");

    std::fs::write(repo.join("émoji café.txt"), "untracked\n").expect("write unicode file");
    std::fs::write(repo.join("tracked.txt"), "one\ndirty\n").expect("dirty tracked");

    discard_changes(&repo, &[".".to_string()]).expect("discard all");

    assert!(
        !repo.join("émoji café.txt").exists(),
        "quoted-path untracked file must be deleted, not silently skipped"
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("tracked.txt")).expect("read tracked"),
        "one\n",
        "tracked edit must be discarded"
    );

    let _ = std::fs::remove_dir_all(&repo);
}

/// Regression: a staged rename used to parse as the literal path
/// "old -> new", matching nothing — the discard errored out (targeted) or
/// skipped the rename (discard all).
#[test]
fn discard_all_undoes_a_staged_rename() {
    if !git_available() {
        eprintln!("skipping: git executable not available");
        return;
    }
    let repo = make_repo("rename");

    git_in(&repo, &["mv", "tracked.txt", "renamed.txt"]);

    discard_changes(&repo, &[".".to_string()]).expect("discard all");

    assert!(
        repo.join("tracked.txt").exists(),
        "original path must be restored"
    );
    assert!(
        !repo.join("renamed.txt").exists(),
        "rename target must be removed"
    );
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["status", "--porcelain"])
        .output()
        .expect("status");
    assert!(
        status.stdout.is_empty(),
        "tree must be clean after discard: {}",
        String::from_utf8_lossy(&status.stdout)
    );

    let _ = std::fs::remove_dir_all(&repo);
}

#[test]
fn targeted_discard_restores_a_single_dirty_file() {
    if !git_available() {
        eprintln!("skipping: git executable not available");
        return;
    }
    let repo = make_repo("targeted");

    std::fs::write(repo.join("tracked.txt"), "one\ndirty\n").expect("dirty tracked");
    std::fs::write(repo.join("other.txt"), "keep me\n").expect("write other");

    discard_changes(&repo, &["tracked.txt".to_string()]).expect("targeted discard");

    assert_eq!(
        std::fs::read_to_string(repo.join("tracked.txt")).expect("read tracked"),
        "one\n"
    );
    assert!(
        repo.join("other.txt").exists(),
        "unrelated untracked file must be untouched"
    );

    let _ = std::fs::remove_dir_all(&repo);
}

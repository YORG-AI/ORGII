use super::truncate_output;

#[test]
fn truncate_output_returns_short_text() {
    let short = "hello world";
    assert_eq!(truncate_output(short.to_string(), 100), short);
}

#[test]
fn truncate_output_truncates_long_text() {
    let long = "x".repeat(500);
    let result = truncate_output(long.clone(), 100);
    assert!(result.len() <= 200);
    assert!(result.contains("[...truncated"));
    assert!(result.contains("500 total chars"));
}

#[test]
fn truncate_output_at_exact_limit() {
    let exact = "a".repeat(100);
    assert_eq!(truncate_output(exact.clone(), 100), exact);
}

#[test]
fn truncate_output_one_over_limit() {
    let over = "b".repeat(101);
    let result = truncate_output(over, 100);
    assert!(result.contains("[...truncated"));
}

#[test]
fn recursive_glob_is_rejected_before_a_network_walk_begins() {
    let error = super::ensure_glob_scope_is_safe_on_filesystem(
        "**/*BEV*_clean.pkl",
        std::path::Path::new("/mnt/public-data/user"),
        Some("nfs"),
    )
    .unwrap_err();

    assert!(error.contains("Recursive glob"));
    assert!(error.contains("network filesystem 'nfs'"));
    assert!(error.contains("narrower subdirectory"));
}

#[test]
fn non_recursive_glob_remains_available_on_a_network_filesystem() {
    super::ensure_glob_scope_is_safe_on_filesystem(
        "1785780323_clean.pkl",
        std::path::Path::new("/mnt/public-data/user"),
        Some("nfs"),
    )
    .unwrap();
}

#[test]
fn recursive_glob_remains_available_on_a_local_filesystem() {
    super::ensure_glob_scope_is_safe_on_filesystem(
        "**/*.rs",
        std::path::Path::new("/workspace"),
        Some("ext4"),
    )
    .unwrap();
}

#[test]
fn mount_lookup_uses_the_deepest_matching_mountpoint() {
    let mounts = concat!(
        "rootfs / ext4 rw 0 0\n",
        "server:/public /mnt/public-data nfs rw 0 0\n",
        "server:/private /mnt/public-data/private nfs4 rw 0 0\n",
    );
    assert_eq!(
        super::filesystem_type_for_path_from_mounts(
            std::path::Path::new("/mnt/public-data/private/user"),
            mounts,
        )
        .as_deref(),
        Some("nfs4")
    );
}

#[test]
fn mount_lookup_unescapes_mountpoint_spaces() {
    let mounts = "server:/share /mnt/remote\\040share cifs rw 0 0\n";
    assert_eq!(
        super::filesystem_type_for_path_from_mounts(
            std::path::Path::new("/mnt/remote share/data"),
            mounts,
        )
        .as_deref(),
        Some("cifs")
    );
}

#[test]
fn local_glob_entry_budget_returns_an_explicit_error_instead_of_partial_results() {
    let root = tempfile::tempdir().expect("tempdir");
    for index in 0..4 {
        std::fs::write(root.path().join(format!("file-{index}.txt")), "x").expect("write fixture");
    }
    let walker = ignore::WalkBuilder::new(root.path()).build();
    let error = super::collect_bounded_glob_matches(walker, root.path(), 10, 2, 24)
        .expect_err("entry cap must fail explicitly");

    assert!(error.contains("stopped after scanning 2 entries"));
    assert!(error.contains("Narrow repo_path"));
}

#[test]
fn local_glob_depth_limit_returns_an_explicit_error_instead_of_no_matches() {
    let root = tempfile::tempdir().expect("tempdir");
    let deep = root.path().join("a").join("b");
    std::fs::create_dir_all(&deep).expect("create deep tree");
    std::fs::write(deep.join("target.txt"), "x").expect("write fixture");

    let walker = ignore::WalkBuilder::new(root.path())
        .max_depth(Some(1))
        .build();
    let error = super::collect_bounded_glob_matches(walker, root.path(), 10, 100, 1)
        .expect_err("depth cap must fail explicitly");

    assert!(error.contains("maximum depth of 1"));
    assert!(error.contains("before finding a match"));
}

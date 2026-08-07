use git2::{Repository, Signature};
use git_api::commands::diff::{get_batch_file_diffs, get_diff_numstat, get_diff_numstat_combined};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

struct TempRepo(std::path::PathBuf);

impl TempRepo {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("orgii-numstat-rename-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create temporary repository directory");
        Self(path)
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn content_identical_move_has_zero_line_changes() {
    let temp_repo = TempRepo::new();
    let repo = Repository::init(&temp_repo.0).expect("initialize repository");
    let original_path = temp_repo.0.join("old/icon.svg");
    let relocated_path = temp_repo.0.join("new/icon.svg");

    fs::create_dir_all(original_path.parent().unwrap()).expect("create original directory");
    fs::write(&original_path, "<svg>same content</svg>\n").expect("write original file");

    let mut index = repo.index().expect("open index");
    index
        .add_path(Path::new("old/icon.svg"))
        .expect("add original file");
    index.write().expect("write index");
    let tree_id = index.write_tree().expect("write tree");
    let tree = repo.find_tree(tree_id).expect("find tree");
    let signature = Signature::now("ORGII Test", "test@orgii.local").expect("signature");
    repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
        .expect("create initial commit");
    drop(tree);
    drop(repo);

    fs::create_dir_all(relocated_path.parent().unwrap()).expect("create relocated directory");
    fs::rename(&original_path, &relocated_path).expect("relocate file");

    let numstat =
        get_diff_numstat(&temp_repo.0, "HEAD", None, false, true).expect("get worktree numstat");
    assert_eq!(numstat.files.len(), 1);
    assert_eq!(numstat.files[0].path, "new/icon.svg");
    assert_eq!(numstat.files[0].status, "renamed");
    assert_eq!(numstat.total_insertions, 0);
    assert_eq!(numstat.total_deletions, 0);

    let combined =
        get_diff_numstat_combined(&temp_repo.0, "HEAD", true).expect("get combined numstat");
    assert_eq!(combined.files.len(), 1);
    assert_eq!(combined.total_insertions, 0);
    assert_eq!(combined.total_deletions, 0);
}

#[test]
fn batch_diff_content_identical_move_has_zero_line_changes() {
    let temp_repo = TempRepo::new();
    let repo = Repository::init(&temp_repo.0).expect("initialize repository");
    let original_path = temp_repo.0.join("old/icon.svg");
    let relocated_path = temp_repo.0.join("new/icon.svg");

    fs::create_dir_all(original_path.parent().unwrap()).expect("create original directory");
    fs::write(&original_path, "<svg>same content</svg>\n").expect("write original file");

    let mut index = repo.index().expect("open index");
    index
        .add_path(Path::new("old/icon.svg"))
        .expect("add original file");
    index.write().expect("write index");
    let tree_id = index.write_tree().expect("write tree");
    let tree = repo.find_tree(tree_id).expect("find tree");
    let signature = Signature::now("ORGII Test", "test@orgii.local").expect("signature");
    repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
        .expect("create initial commit");
    drop(tree);
    drop(repo);

    fs::create_dir_all(relocated_path.parent().unwrap()).expect("create relocated directory");
    fs::rename(&original_path, &relocated_path).expect("relocate file");

    let file_paths = vec!["new/icon.svg".to_string()];
    let original_paths = HashMap::from([("new/icon.svg".to_string(), "old/icon.svg".to_string())]);
    let batch = get_batch_file_diffs(
        &temp_repo.0,
        &file_paths,
        Some(&original_paths),
        "HEAD",
        None,
        3,
    )
    .expect("get batch file diff");

    assert_eq!(batch.files.len(), 1);
    assert_eq!(batch.files[0].file_path, "new/icon.svg");
    assert_eq!(batch.files[0].old_path.as_deref(), Some("old/icon.svg"));
    assert_eq!(batch.files[0].status, "renamed");
    assert_eq!(batch.files[0].insertions, 0);
    assert_eq!(batch.files[0].deletions, 0);
    assert_eq!(batch.stats.insertions, 0);
    assert_eq!(batch.stats.deletions, 0);
    assert_eq!(batch.files[0].old_content, batch.files[0].new_content);
}

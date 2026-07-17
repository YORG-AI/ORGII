//! Core diff operations using git2.
//!
//! Provides structured diff access with hunks, lines, and proper status detection.

use crate::types::*;
use git2::{DiffDelta, DiffHunk as Git2Hunk, DiffLine as Git2Line, DiffOptions, Repository};
use rayon::prelude::*;
use std::cell::RefCell;
use std::path::Path;

/// Convert git2 delta status to string
pub(super) fn delta_status_to_string(status: git2::Delta) -> String {
    match status {
        git2::Delta::Added => "added".to_string(),
        git2::Delta::Deleted => "deleted".to_string(),
        git2::Delta::Modified => "modified".to_string(),
        git2::Delta::Renamed => "renamed".to_string(),
        git2::Delta::Copied => "copied".to_string(),
        git2::Delta::Typechange => "typechange".to_string(),
        git2::Delta::Unmodified => "unmodified".to_string(),
        git2::Delta::Ignored => "ignored".to_string(),
        git2::Delta::Untracked => "untracked".to_string(),
        git2::Delta::Conflicted => "conflicted".to_string(),
        git2::Delta::Unreadable => "unreadable".to_string(),
    }
}

/// State for collecting single file diff data
struct SingleFileDiffCollector {
    result: RefCell<FileDiffResult>,
    current_hunk: RefCell<Option<GitDiffHunk>>,
}

impl SingleFileDiffCollector {
    fn new(file_path: &str) -> Self {
        Self {
            result: RefCell::new(FileDiffResult {
                file_path: file_path.to_string(),
                old_path: None,
                status: "modified".to_string(),
                hunks: Vec::new(),
                insertions: 0,
                deletions: 0,
                binary: false,
                old_content: None,
                new_content: None,
            }),
            current_hunk: RefCell::new(None),
        }
    }

    fn on_file(&self, delta: &DiffDelta, file_path: &str) {
        let mut result = self.result.borrow_mut();
        result.status = delta_status_to_string(delta.status());
        result.binary = delta.flags().is_binary();
        if let Some(old_file) = delta.old_file().path() {
            let old_path_str = old_file.to_string_lossy().to_string();
            if old_path_str != file_path {
                result.old_path = Some(old_path_str);
            }
        }
    }

    fn on_binary(&self) {
        self.result.borrow_mut().binary = true;
    }

    fn on_hunk(&self, hunk: &Git2Hunk) {
        // Save previous hunk
        if let Some(h) = self.current_hunk.borrow_mut().take() {
            self.result.borrow_mut().hunks.push(h);
        }
        *self.current_hunk.borrow_mut() = Some(GitDiffHunk {
            old_start: hunk.old_start(),
            old_lines: hunk.old_lines(),
            new_start: hunk.new_start(),
            new_lines: hunk.new_lines(),
            lines: Vec::new(),
        });
    }

    fn on_line(&self, line: &Git2Line) {
        if let Some(ref mut h) = *self.current_hunk.borrow_mut() {
            let line_type = match line.origin() {
                '+' => "addition",
                '-' => "deletion",
                ' ' => "context",
                _ => "context",
            };

            let content = String::from_utf8_lossy(line.content()).to_string();

            h.lines.push(DiffLine {
                line_type: line_type.to_string(),
                content,
                old_line_number: line.old_lineno(),
                new_line_number: line.new_lineno(),
            });
        }
    }

    fn finalize(self, insertions: u32, deletions: u32) -> FileDiffResult {
        // Don't forget the last hunk
        if let Some(h) = self.current_hunk.borrow_mut().take() {
            self.result.borrow_mut().hunks.push(h);
        }
        let mut result = self.result.into_inner();
        result.insertions = insertions;
        result.deletions = deletions;
        result
    }

    fn set_content(&self, old_content: Option<String>, new_content: Option<String>) {
        let mut result = self.result.borrow_mut();
        result.old_content = old_content;
        result.new_content = new_content;
    }
}

/// Read file content from a tree or working directory
fn read_file_content(
    repo: &Repository,
    file_path: &str,
    tree: Option<&git2::Tree>,
) -> Result<String, String> {
    if let Some(tree) = tree {
        // Read from tree (commit)
        let entry = tree
            .get_path(std::path::Path::new(file_path))
            .map_err(|e| format!("File not found in tree: {}", e))?;
        let object = entry
            .to_object(repo)
            .map_err(|e| format!("Failed to get object: {}", e))?;
        let blob = object
            .as_blob()
            .ok_or_else(|| "Object is not a blob".to_string())?;

        String::from_utf8(blob.content().to_vec())
            .map_err(|_| "File contains invalid UTF-8".to_string())
    } else {
        // Read from working directory
        let repo_path = repo
            .path()
            .parent()
            .ok_or_else(|| "Invalid repo path".to_string())?;
        let full_path = repo_path.join(file_path);
        std::fs::read_to_string(&full_path)
            .map_err(|e| format!("Failed to read file from working directory: {}", e))
    }
}

/// Get structured diff for a single file between two refs
pub fn get_file_diff(
    repo_path: &Path,
    file_path: &str,
    from_ref: &str,
    to_ref: Option<&str>,
    context_lines: u32,
) -> Result<FileDiffResult, String> {
    let repo =
        Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    let old_tree = super::ref_utils::resolve_from_ref(&repo, from_ref)?;
    let empty_base = super::ref_utils::is_empty_base(from_ref);

    // Get the new tree (to_ref or working directory)
    let new_tree = match to_ref {
        Some(ref_name)
            if ref_name != "WORKING" && ref_name != "WORKDIR" && ref_name != "STAGED" =>
        {
            let obj = repo
                .revparse_single(ref_name)
                .map_err(|e| format!("Failed to resolve ref '{}': {}", ref_name, e))?;
            let commit = obj
                .peel_to_commit()
                .map_err(|e| format!("Failed to get commit: {}", e))?;
            Some(
                commit
                    .tree()
                    .map_err(|e| format!("Failed to get tree: {}", e))?,
            )
        }
        _ => None, // Working directory or staged
    };

    let mut diff_opts = DiffOptions::new();
    diff_opts.context_lines(context_lines);
    diff_opts.pathspec(file_path);
    if empty_base {
        diff_opts.include_untracked(true);
    }

    let diff = if new_tree.is_some() {
        repo.diff_tree_to_tree(old_tree.as_ref(), new_tree.as_ref(), Some(&mut diff_opts))
            .map_err(|e| format!("Failed to create diff: {}", e))?
    } else if old_tree.is_some() || empty_base {
        repo.diff_tree_to_workdir_with_index(old_tree.as_ref(), Some(&mut diff_opts))
            .map_err(|e| format!("Failed to create diff: {}", e))?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut diff_opts))
            .map_err(|e| format!("Failed to create diff: {}", e))?
    };

    let stats = diff
        .stats()
        .map_err(|e| format!("Failed to get diff stats: {}", e))?;
    let insertions = stats.insertions() as u32;
    let deletions = stats.deletions() as u32;

    let collector = SingleFileDiffCollector::new(file_path);
    let file_path_owned = file_path.to_string();

    diff.foreach(
        &mut |delta: DiffDelta, _progress| {
            collector.on_file(&delta, &file_path_owned);
            true
        },
        Some(&mut |_delta: DiffDelta, _binary| {
            collector.on_binary();
            true
        }),
        Some(&mut |_delta: DiffDelta, hunk: Git2Hunk| {
            collector.on_hunk(&hunk);
            true
        }),
        Some(
            &mut |_delta: DiffDelta, _hunk: Option<Git2Hunk>, line: Git2Line| {
                collector.on_line(&line);
                true
            },
        ),
    )
    .map_err(|e| format!("Failed to iterate diff: {}", e))?;

    // Read full file content for both old and new versions
    let old_content = if old_tree.is_some() {
        read_file_content(&repo, file_path, old_tree.as_ref()).ok()
    } else {
        None
    };

    let new_content = if new_tree.is_some() {
        read_file_content(&repo, file_path, new_tree.as_ref()).ok()
    } else {
        // Read from working directory
        read_file_content(&repo, file_path, None).ok()
    };

    collector.set_content(old_content, new_content);

    Ok(collector.finalize(insertions, deletions))
}

/// Get structured diff for a single file with support for renamed files
///
/// For renamed files, `original_path` specifies where to read old content from in HEAD,
/// while `file_path` is the new path in the working directory.
pub fn get_file_diff_with_rename(
    repo_path: &Path,
    file_path: &str,
    original_path: Option<&str>,
    from_ref: &str,
    to_ref: Option<&str>,
    context_lines: u32,
) -> Result<FileDiffResult, String> {
    let repo =
        Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    let old_tree = super::ref_utils::resolve_from_ref(&repo, from_ref)?;
    let empty_base = super::ref_utils::is_empty_base(from_ref);

    // Get the new tree (to_ref or working directory)
    let new_tree = match to_ref {
        Some(ref_name)
            if ref_name != "WORKING" && ref_name != "WORKDIR" && ref_name != "STAGED" =>
        {
            let obj = repo
                .revparse_single(ref_name)
                .map_err(|e| format!("Failed to resolve ref '{}': {}", ref_name, e))?;
            let commit = obj
                .peel_to_commit()
                .map_err(|e| format!("Failed to get commit: {}", e))?;
            Some(
                commit
                    .tree()
                    .map_err(|e| format!("Failed to get tree: {}", e))?,
            )
        }
        _ => None,
    };

    let mut diff_opts = DiffOptions::new();
    diff_opts.context_lines(context_lines);
    diff_opts.pathspec(file_path);
    let compares_to_workdir = new_tree.is_none();
    if empty_base || (original_path.is_some() && compares_to_workdir) {
        diff_opts.include_untracked(true);
        diff_opts.recurse_untracked_dirs(true);
        diff_opts.show_untracked_content(true);
    }

    // If we have an original_path (renamed file), also include it in the pathspec
    if let Some(orig) = original_path {
        diff_opts.pathspec(orig);
    }

    let mut diff = if new_tree.is_some() {
        repo.diff_tree_to_tree(old_tree.as_ref(), new_tree.as_ref(), Some(&mut diff_opts))
            .map_err(|e| format!("Failed to create diff: {}", e))?
    } else if old_tree.is_some() || empty_base {
        repo.diff_tree_to_workdir_with_index(old_tree.as_ref(), Some(&mut diff_opts))
            .map_err(|e| format!("Failed to create diff: {}", e))?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut diff_opts))
            .map_err(|e| format!("Failed to create diff: {}", e))?
    };

    // An unstaged move arrives as a tracked deletion plus an untracked
    // destination. The caller already supplied the original path, so include
    // that destination in similarity detection before calculating stats.
    // Otherwise a byte-identical one-line move is incorrectly reported as
    // one deletion even though the status layer correctly labels it renamed.
    if original_path.is_some() {
        let mut find_opts = git2::DiffFindOptions::new();
        find_opts.renames(true);
        if compares_to_workdir {
            find_opts.for_untracked(true);
        }
        diff.find_similar(Some(&mut find_opts))
            .map_err(|e| format!("Failed to detect rename for {file_path}: {e}"))?;
    }

    let stats = diff
        .stats()
        .map_err(|e| format!("Failed to get diff stats: {}", e))?;
    let insertions = stats.insertions() as u32;
    let deletions = stats.deletions() as u32;

    let collector = SingleFileDiffCollector::new(file_path);
    let file_path_owned = file_path.to_string();

    diff.foreach(
        &mut |delta: DiffDelta, _progress| {
            collector.on_file(&delta, &file_path_owned);
            true
        },
        Some(&mut |_delta: DiffDelta, _binary| {
            collector.on_binary();
            true
        }),
        Some(&mut |_delta: DiffDelta, hunk: Git2Hunk| {
            collector.on_hunk(&hunk);
            true
        }),
        Some(
            &mut |_delta: DiffDelta, _hunk: Option<Git2Hunk>, line: Git2Line| {
                collector.on_line(&line);
                true
            },
        ),
    )
    .map_err(|e| format!("Failed to iterate diff: {}", e))?;

    // Read full file content for both old and new versions
    // For renamed files, use original_path for old content
    let old_content_path = original_path.unwrap_or(file_path);
    let old_content = if old_tree.is_some() {
        read_file_content(&repo, old_content_path, old_tree.as_ref()).ok()
    } else {
        None
    };

    let new_content = if new_tree.is_some() {
        read_file_content(&repo, file_path, new_tree.as_ref()).ok()
    } else {
        // Read from working directory
        read_file_content(&repo, file_path, None).ok()
    };

    collector.set_content(old_content, new_content);

    let mut result = collector.finalize(insertions, deletions);

    // For renamed files, set the old_path field
    if original_path.is_some() && result.old_path.is_none() {
        result.old_path = original_path.map(|s| s.to_string());
        if result.status == "modified" {
            result.status = "renamed".to_string();
        }
    }

    Ok(result)
}

/// Compute the diff for a single file given a **pre-opened** repository and
/// pre-resolved trees.  Avoids the per-file `Repository::open` cost when
/// processing multiple files in `get_batch_file_diffs`.
///
/// `old_tree_oid` / `new_tree_oid` are the OIDs of the from/to trees; `None`
/// means "working directory" (same semantics as the public APIs).
/// `empty_base` mirrors `ref_utils::is_empty_base`.
fn diff_single_file_in_repo(
    repo: &Repository,
    file_path: &str,
    original_path: Option<&str>,
    old_tree_oid: Option<git2::Oid>,
    new_tree_oid: Option<git2::Oid>,
    empty_base: bool,
    context_lines: u32,
) -> Result<FileDiffResult, String> {
    // Re-hydrate OIDs into Tree objects (cheap — just a hash lookup)
    let old_tree: Option<git2::Tree> = old_tree_oid
        .map(|oid| {
            repo.find_tree(oid)
                .map_err(|e| format!("Failed to find old tree {oid}: {e}"))
        })
        .transpose()?;

    let new_tree: Option<git2::Tree> = new_tree_oid
        .map(|oid| {
            repo.find_tree(oid)
                .map_err(|e| format!("Failed to find new tree {oid}: {e}"))
        })
        .transpose()?;

    let mut diff_opts = DiffOptions::new();
    diff_opts.context_lines(context_lines);
    diff_opts.pathspec(file_path);
    let compares_to_workdir = new_tree.is_none();
    if empty_base || (original_path.is_some() && compares_to_workdir) {
        diff_opts.include_untracked(true);
        diff_opts.recurse_untracked_dirs(true);
        diff_opts.show_untracked_content(true);
    }
    if let Some(orig) = original_path {
        diff_opts.pathspec(orig);
    }

    let mut diff = if new_tree.is_some() {
        repo.diff_tree_to_tree(old_tree.as_ref(), new_tree.as_ref(), Some(&mut diff_opts))
            .map_err(|e| format!("diff_tree_to_tree failed for {file_path}: {e}"))?
    } else if old_tree.is_some() || empty_base {
        repo.diff_tree_to_workdir_with_index(old_tree.as_ref(), Some(&mut diff_opts))
            .map_err(|e| format!("diff_tree_to_workdir failed for {file_path}: {e}"))?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut diff_opts))
            .map_err(|e| format!("diff_index_to_workdir failed for {file_path}: {e}"))?
    };

    if original_path.is_some() {
        let mut find_opts = git2::DiffFindOptions::new();
        find_opts.renames(true);
        if compares_to_workdir {
            find_opts.for_untracked(true);
        }
        diff.find_similar(Some(&mut find_opts))
            .map_err(|e| format!("Failed to detect rename for {file_path}: {e}"))?;
    }

    let stats = diff
        .stats()
        .map_err(|e| format!("Failed to get diff stats for {file_path}: {e}"))?;
    let insertions = stats.insertions() as u32;
    let deletions = stats.deletions() as u32;

    let collector = SingleFileDiffCollector::new(file_path);
    let file_path_owned = file_path.to_string();

    diff.foreach(
        &mut |delta: DiffDelta, _| {
            collector.on_file(&delta, &file_path_owned);
            true
        },
        Some(&mut |_: DiffDelta, _| {
            collector.on_binary();
            true
        }),
        Some(&mut |_: DiffDelta, hunk: Git2Hunk| {
            collector.on_hunk(&hunk);
            true
        }),
        Some(&mut |_: DiffDelta, _: Option<Git2Hunk>, line: Git2Line| {
            collector.on_line(&line);
            true
        }),
    )
    .map_err(|e| format!("Failed to iterate diff for {file_path}: {e}"))?;

    let old_content_path = original_path.unwrap_or(file_path);
    let old_content = if old_tree.is_some() {
        read_file_content(repo, old_content_path, old_tree.as_ref()).ok()
    } else {
        None
    };
    let new_content = if new_tree.is_some() {
        read_file_content(repo, file_path, new_tree.as_ref()).ok()
    } else {
        read_file_content(repo, file_path, None).ok()
    };

    collector.set_content(old_content, new_content);
    let mut result = collector.finalize(insertions, deletions);

    if original_path.is_some() && result.old_path.is_none() {
        result.old_path = original_path.map(|s| s.to_string());
        if result.status == "modified" {
            result.status = "renamed".to_string();
        }
    }

    Ok(result)
}

/// Get structured diff for multiple files.
///
/// **Performance**: opens the repository exactly once, resolves the from/to
/// trees once, then dispatches per-file diffs in parallel via `rayon`.
/// Previously each file triggered a separate `Repository::open` + tree
/// resolution, making this O(N) serial I/O.
pub fn get_batch_file_diffs(
    repo_path: &Path,
    file_paths: &[String],
    original_paths: Option<&std::collections::HashMap<String, String>>,
    from_ref: &str,
    to_ref: Option<&str>,
    context_lines: u32,
) -> Result<BatchFileDiffResult, String> {
    if file_paths.is_empty() {
        return Ok(BatchFileDiffResult {
            files: Vec::new(),
            stats: GitDiffStats {
                insertions: 0,
                deletions: 0,
                files_changed: 0,
            },
        });
    }

    // Open repo and resolve trees once for all files.
    let repo =
        Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {e}"))?;

    let old_tree = super::ref_utils::resolve_from_ref(&repo, from_ref)?;
    let empty_base = super::ref_utils::is_empty_base(from_ref);

    let new_tree: Option<git2::Tree> = match to_ref {
        Some(ref_name)
            if ref_name != "WORKING" && ref_name != "WORKDIR" && ref_name != "STAGED" =>
        {
            let obj = repo
                .revparse_single(ref_name)
                .map_err(|e| format!("Failed to resolve ref '{ref_name}': {e}"))?;
            let commit = obj
                .peel_to_commit()
                .map_err(|e| format!("Failed to get commit: {e}"))?;
            Some(
                commit
                    .tree()
                    .map_err(|e| format!("Failed to get tree: {e}"))?,
            )
        }
        _ => None,
    };

    // Capture OIDs so they can be sent across rayon threads (git2 Tree is not
    // Send, but Oid is just a 20-byte hash — safe to copy).
    let old_tree_oid = old_tree.as_ref().map(|t| t.id());
    let new_tree_oid = new_tree.as_ref().map(|t| t.id());

    // repo_path is Send; we pass it into each thread to open a fresh handle.
    // git2::Repository is NOT Send, so each rayon thread opens its own handle
    // but reuses the already-resolved OIDs to skip ref-walking.
    let repo_path_owned = repo_path.to_path_buf();
    let from_ref_owned = from_ref.to_string();
    let to_ref_owned: Option<String> = to_ref.map(|s| s.to_string());

    let results: Vec<Result<FileDiffResult, String>> = file_paths
        .par_iter()
        .map(|file_path| {
            let original_path = original_paths
                .and_then(|map| map.get(file_path))
                .map(|s| s.as_str());

            // Each rayon thread opens its own Repository handle (cheap on
            // most OSes — just an ODB open, no network I/O).
            let thread_repo = Repository::open(&repo_path_owned)
                .map_err(|e| format!("Failed to open repository in worker: {e}"))?;

            // If we couldn't resolve trees above (e.g. unborn HEAD), fall back
            // to the safe per-file path which handles that edge case.
            if old_tree_oid.is_none() && !empty_base && new_tree_oid.is_none() {
                return get_file_diff_with_rename(
                    &repo_path_owned,
                    file_path,
                    original_path,
                    &from_ref_owned,
                    to_ref_owned.as_deref(),
                    context_lines,
                );
            }

            diff_single_file_in_repo(
                &thread_repo,
                file_path,
                original_path,
                old_tree_oid,
                new_tree_oid,
                empty_base,
                context_lines,
            )
        })
        .collect();

    let mut files = Vec::with_capacity(results.len());
    let mut total_insertions = 0u32;
    let mut total_deletions = 0u32;

    for result in results {
        match result {
            Ok(diff) => {
                total_insertions += diff.insertions;
                total_deletions += diff.deletions;
                files.push(diff);
            }
            Err(e) => {
                eprintln!("Warning: Failed to get diff for file: {e}");
            }
        }
    }

    let files_changed = files.len() as u32;
    Ok(BatchFileDiffResult {
        files,
        stats: GitDiffStats {
            insertions: total_insertions,
            deletions: total_deletions,
            files_changed,
        },
    })
}

/// Get diff for all staged changes
pub fn get_staged_diff(
    repo_path: &Path,
    context_lines: u32,
) -> Result<BatchFileDiffResult, String> {
    let repo =
        Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    // Get HEAD tree
    let head = repo
        .head()
        .map_err(|e| format!("Failed to get HEAD: {}", e))?;
    let head_commit = head
        .peel_to_commit()
        .map_err(|e| format!("Failed to get commit: {}", e))?;
    let head_tree = head_commit
        .tree()
        .map_err(|e| format!("Failed to get tree: {}", e))?;

    let mut diff_opts = DiffOptions::new();
    diff_opts.context_lines(context_lines);

    // Diff HEAD to index (staged changes)
    let diff = repo
        .diff_tree_to_index(Some(&head_tree), None, Some(&mut diff_opts))
        .map_err(|e| format!("Failed to create diff: {}", e))?;

    collect_batch_diff(&repo, diff)
}

/// Get diff for a single staged file
pub fn get_staged_file_diff(
    repo_path: &Path,
    file_path: &str,
    context_lines: u32,
) -> Result<FileDiffResult, String> {
    get_file_diff(repo_path, file_path, "HEAD", Some("STAGED"), context_lines)
}

/// State for collecting diff data using RefCell for interior mutability
struct DiffCollector {
    files: RefCell<Vec<FileDiffResult>>,
    current_file: RefCell<Option<FileDiffResult>>,
    current_hunk: RefCell<Option<GitDiffHunk>>,
}

impl DiffCollector {
    fn new() -> Self {
        Self {
            files: RefCell::new(Vec::new()),
            current_file: RefCell::new(None),
            current_hunk: RefCell::new(None),
        }
    }

    fn on_file(&self, delta: &DiffDelta) {
        // Save previous file if exists
        if let Some(mut f) = self.current_file.borrow_mut().take() {
            if let Some(h) = self.current_hunk.borrow_mut().take() {
                f.hunks.push(h);
            }
            self.files.borrow_mut().push(f);
        }

        let new_path = delta
            .new_file()
            .path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let old_path = delta
            .old_file()
            .path()
            .map(|p| p.to_string_lossy().to_string());

        *self.current_file.borrow_mut() = Some(FileDiffResult {
            file_path: new_path.clone(),
            old_path: if old_path.as_ref() != Some(&new_path) {
                old_path
            } else {
                None
            },
            status: delta_status_to_string(delta.status()),
            hunks: Vec::new(),
            insertions: 0,
            deletions: 0,
            binary: delta.flags().is_binary(),
            old_content: None,
            new_content: None,
        });
    }

    fn on_binary(&self) {
        if let Some(ref mut f) = *self.current_file.borrow_mut() {
            f.binary = true;
        }
    }

    fn on_hunk(&self, hunk: &Git2Hunk) {
        // Save previous hunk if exists
        if let Some(h) = self.current_hunk.borrow_mut().take() {
            if let Some(ref mut f) = *self.current_file.borrow_mut() {
                f.hunks.push(h);
            }
        }
        *self.current_hunk.borrow_mut() = Some(GitDiffHunk {
            old_start: hunk.old_start(),
            old_lines: hunk.old_lines(),
            new_start: hunk.new_start(),
            new_lines: hunk.new_lines(),
            lines: Vec::new(),
        });
    }

    fn on_line(&self, line: &Git2Line) {
        if let Some(ref mut h) = *self.current_hunk.borrow_mut() {
            let line_type = match line.origin() {
                '+' => {
                    if let Some(ref mut f) = *self.current_file.borrow_mut() {
                        f.insertions += 1;
                    }
                    "addition"
                }
                '-' => {
                    if let Some(ref mut f) = *self.current_file.borrow_mut() {
                        f.deletions += 1;
                    }
                    "deletion"
                }
                ' ' => "context",
                _ => "context",
            };

            let content = String::from_utf8_lossy(line.content()).to_string();

            h.lines.push(DiffLine {
                line_type: line_type.to_string(),
                content,
                old_line_number: line.old_lineno(),
                new_line_number: line.new_lineno(),
            });
        }
    }

    fn finalize(self) -> Vec<FileDiffResult> {
        // Don't forget the last file and hunk
        if let Some(mut f) = self.current_file.borrow_mut().take() {
            if let Some(h) = self.current_hunk.borrow_mut().take() {
                f.hunks.push(h);
            }
            self.files.borrow_mut().push(f);
        }
        self.files.into_inner()
    }
}

/// Helper to collect batch diff result from a git2::Diff
pub(super) fn collect_batch_diff(
    _repo: &Repository,
    diff: git2::Diff,
) -> Result<BatchFileDiffResult, String> {
    let stats = diff
        .stats()
        .map_err(|e| format!("Failed to get diff stats: {}", e))?;

    let collector = DiffCollector::new();

    diff.foreach(
        &mut |delta: DiffDelta, _progress| {
            collector.on_file(&delta);
            true
        },
        Some(&mut |_delta: DiffDelta, _binary| {
            collector.on_binary();
            true
        }),
        Some(&mut |_delta: DiffDelta, hunk: Git2Hunk| {
            collector.on_hunk(&hunk);
            true
        }),
        Some(
            &mut |_delta: DiffDelta, _hunk: Option<Git2Hunk>, line: Git2Line| {
                collector.on_line(&line);
                true
            },
        ),
    )
    .map_err(|e| format!("Failed to iterate diff: {}", e))?;

    let files = collector.finalize();

    Ok(BatchFileDiffResult {
        files,
        stats: GitDiffStats {
            insertions: stats.insertions() as u32,
            deletions: stats.deletions() as u32,
            files_changed: stats.files_changed() as u32,
        },
    })
}

/// Format git2::Time to ISO 8601 string
pub(super) fn format_time(time: git2::Time) -> String {
    use chrono::{FixedOffset, TimeZone};

    let offset_minutes = time.offset_minutes();
    let offset =
        FixedOffset::east_opt(offset_minutes * 60).unwrap_or(FixedOffset::east_opt(0).unwrap());

    offset
        .timestamp_opt(time.seconds(), 0)
        .single()
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| time.seconds().to_string())
}

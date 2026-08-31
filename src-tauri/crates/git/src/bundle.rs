//! Git Bundle Module
//!
//! Provides Tauri commands for creating git bundles from local repositories.
//! Used for uploading local projects to cloud market sessions while
//! preserving git history.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;

use crate::util::{close_inherited_fds, git_command, is_transient_error};
use tauri::Emitter;

// ============================================
// Types
// ============================================

/// Result of git bundle creation
#[derive(Debug, Serialize, Deserialize)]
pub struct GitBundleResult {
    /// Base64-encoded bundle data
    pub data: String,
    /// Size of the bundle in bytes
    pub size: u64,
    /// Branch name that was bundled
    pub branch_name: String,
    /// HEAD commit SHA
    pub head_sha: String,
    /// Number of commits in the bundle
    pub commit_count: usize,
    /// Original folder name
    pub folder_name: String,
}

/// Progress information during bundle creation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleProgress {
    pub phase: String,
    pub message: String,
}

// ============================================
// Constants
// ============================================

/// Maximum bundle size (200MB)
const MAX_BUNDLE_SIZE: u64 = 200 * 1024 * 1024;

// ============================================
// Helper Functions
// ============================================

/// Helper to run git commands directly, closing inherited file descriptors
/// Uses pre_exec on Unix to close FDs 3-1024 before exec to avoid WebView FD inheritance issues
fn run_git_command(repo_path: &PathBuf, args: &[&str]) -> Result<std::process::Output, String> {
    // Verify the directory exists before running
    if !repo_path.exists() {
        return Err(format!("Repository path does not exist: {:?}", repo_path));
    }

    let max_retries = 5;
    let mut last_error = String::new();

    for attempt in 0..max_retries {
        let result = git_command().and_then(|mut cmd| {
            cmd.args(args)
                .current_dir(repo_path)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .env("GIT_TERMINAL_PROMPT", "0");

            close_inherited_fds(&mut cmd);
            cmd.output().map_err(|err| err.to_string())
        });

        match result {
            Ok(output) => return Ok(output),
            Err(e) => {
                last_error = e.to_string();

                // Only retry transient errors
                if !is_transient_error(&last_error) {
                    return Err(format!(
                        "Failed to run git {}: {} (path: {:?})",
                        args.join(" "),
                        last_error,
                        repo_path
                    ));
                }
            }
        }

        // Exponential backoff
        if attempt < max_retries - 1 {
            let delay_ms = 200 * (attempt as u64 + 1);
            println!(
                "⚠️ [GitBundle] Retry {}/{} for git {} (waiting {}ms) - {}",
                attempt + 1,
                max_retries,
                args.join(" "),
                delay_ms,
                last_error
            );
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        }
    }

    Err(format!(
        "git {} failed after {} retries: {} (path: {:?})",
        args.join(" "),
        max_retries,
        last_error,
        repo_path
    ))
}

/// Get the current branch name
fn get_current_branch(repo_path: &PathBuf) -> Result<String, String> {
    let output = run_git_command(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Get the HEAD commit SHA
fn get_head_sha(repo_path: &PathBuf) -> Result<String, String> {
    let output = run_git_command(repo_path, &["rev-parse", "HEAD"])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Count commits in the repository
fn count_commits(repo_path: &PathBuf) -> Result<usize, String> {
    let output = run_git_command(repo_path, &["rev-list", "--count", "HEAD"])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let count_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    count_str
        .parse::<usize>()
        .map_err(|e| format!("Failed to parse commit count: {}", e))
}

/// Auto-commit uncommitted changes if any exist
/// Note: We skip the status check and just try to commit directly
/// This avoids "Bad file descriptor" errors that occur with git status in Tauri
/// If git add fails (e.g., due to file descriptor issues), we skip gracefully
fn auto_commit_if_needed(repo_path: &PathBuf) -> Result<bool, String> {
    // Try to stage all changes - if this fails due to file descriptor issues, skip it
    match run_git_command(repo_path, &["add", "-A"]) {
        Ok(add_output) => {
            if !add_output.status.success() {
                let stderr = String::from_utf8_lossy(&add_output.stderr);
                // (`git add` never prints "nothing to commit"; the old check
                // for it here was dead.)
                if !stderr.is_empty() {
                    println!("⚠️ [GitBundle] git add warning: {}", stderr);
                }
            }
        }
        Err(e) => {
            // If git add fails (e.g., Bad file descriptor), skip and continue
            // The repo might already be clean, so we can proceed with bundle creation
            println!("⚠️ [GitBundle] Skipping git add due to error: {}", e);
            println!("📦 [GitBundle] Proceeding with bundle creation without staging changes");
            return Ok(false);
        }
    }

    // Try to commit - handle "nothing to commit" gracefully
    match run_git_command(
        repo_path,
        &["commit", "-m", "Orgii: Auto-commit before cloud session"],
    ) {
        Ok(commit_output) => {
            if commit_output.status.success() {
                println!("📦 [GitBundle] Auto-committed changes");
                return Ok(true);
            }

            let stderr = String::from_utf8_lossy(&commit_output.stderr);
            let stdout = String::from_utf8_lossy(&commit_output.stdout);

            // "nothing to commit" is expected and OK
            if stderr.contains("nothing to commit") || stdout.contains("nothing to commit") {
                println!("📦 [GitBundle] No changes to commit");
                return Ok(false);
            }

            // Other commit errors are also OK - just log and continue
            println!("⚠️ [GitBundle] Commit skipped: {}", stderr.trim());
            Ok(false)
        }
        Err(e) => {
            // If commit fails, just skip and continue
            println!("⚠️ [GitBundle] Skipping commit due to error: {}", e);
            Ok(false)
        }
    }
}

/// Check if there are uncommitted changes (for get_git_repo_info)
fn has_uncommitted_changes(repo_path: &PathBuf) -> Result<bool, String> {
    let output = run_git_command(repo_path, &["status", "--porcelain"])?;

    if !output.status.success() {
        // If status fails, assume no changes (to avoid blocking the info query)
        return Ok(false);
    }

    Ok(!output.stdout.is_empty())
}

// ============================================
// Tauri Commands
// ============================================

/// Create a git bundle from a repository path
///
/// # Arguments
/// * `folder_path` - Absolute path to the git repository
///
/// # Returns
/// * `GitBundleResult` containing base64-encoded bundle data
#[tauri::command(rename_all = "camelCase")]
pub fn create_git_bundle(
    folder_path: String,
    window: tauri::Window,
) -> Result<GitBundleResult, String> {
    let repo_path = PathBuf::from(&folder_path);

    // Validate folder exists
    if !repo_path.exists() {
        return Err(format!("Folder does not exist: {}", folder_path));
    }

    if !repo_path.is_dir() {
        return Err(format!("Path is not a directory: {}", folder_path));
    }

    // Canonicalize path to resolve symlinks and ensure it's valid
    let repo_path = repo_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path '{}': {}", folder_path, e))?;

    // Check if it's a git repository
    let git_dir = repo_path.join(".git");
    if !git_dir.exists() {
        return Err(format!(
            "Not a git repository: {}. Please initialize git first.",
            folder_path
        ));
    }

    println!("📦 [GitBundle] Validated repo path: {:?}", repo_path);

    let folder_name = repo_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project")
        .to_string();

    println!("📦 [GitBundle] Creating bundle for: {}", folder_path);

    // Emit progress
    let _ = window.emit(
        "bundle-progress",
        serde_json::json!({
            "phase": "checking",
            "message": "Checking repository status..."
        }),
    );

    // Auto-commit any uncommitted changes
    let auto_committed = auto_commit_if_needed(&repo_path)?;
    if auto_committed {
        println!("📦 [GitBundle] Auto-committed uncommitted changes");
        let _ = window.emit(
            "bundle-progress",
            serde_json::json!({
                "phase": "committed",
                "message": "Auto-committed local changes"
            }),
        );
    }

    // Get branch and HEAD info
    let branch_name = get_current_branch(&repo_path)?;
    let head_sha = get_head_sha(&repo_path)?;
    let commit_count = count_commits(&repo_path)?;

    println!(
        "📦 [GitBundle] Repository info: branch={}, HEAD={}, commits={}",
        branch_name, head_sha, commit_count
    );

    // Emit progress
    let _ = window.emit(
        "bundle-progress",
        serde_json::json!({
            "phase": "bundling",
            "message": format!("Creating bundle from {} ({} commits)...", branch_name, commit_count)
        }),
    );

    // Create temporary bundle file in system temp directory to avoid path issues
    let bundle_filename = format!("orgii-{}.bundle", std::process::id());
    let bundle_path = std::env::temp_dir().join(&bundle_filename);
    let bundle_path_str = bundle_path.to_string_lossy().to_string();

    // Create the bundle using git bundle create (with retry for transient errors)
    // Include the current branch ref so server can detect it
    let refs_head = format!("refs/heads/{}", branch_name);
    let bundle_output = run_git_command(
        &repo_path,
        &["bundle", "create", &bundle_path_str, "HEAD", &refs_head],
    )?;

    if !bundle_output.status.success() {
        let _ = fs::remove_file(&bundle_path);
        return Err(format!(
            "Git bundle creation failed: {}",
            String::from_utf8_lossy(&bundle_output.stderr)
        ));
    }

    // Read the bundle file
    let bundle_data = fs::read(&bundle_path).map_err(|e| {
        let _ = fs::remove_file(&bundle_path);
        format!("Failed to read bundle file: {}", e)
    })?;

    let bundle_size = bundle_data.len() as u64;

    // Clean up the temporary bundle file
    let _ = fs::remove_file(&bundle_path);

    // Check size limit
    if bundle_size > MAX_BUNDLE_SIZE {
        return Err(format!(
            "Bundle too large: {} MB (max: {} MB)",
            bundle_size / 1024 / 1024,
            MAX_BUNDLE_SIZE / 1024 / 1024
        ));
    }

    // Encode to base64
    let base64_data = STANDARD.encode(&bundle_data);

    println!(
        "✅ [GitBundle] Created bundle: {} bytes, {} commits",
        bundle_size, commit_count
    );

    // Emit completion
    let _ = window.emit(
        "bundle-complete",
        serde_json::json!({
            "folder_name": folder_name,
            "branch_name": branch_name,
            "commit_count": commit_count,
            "size": bundle_size,
        }),
    );

    Ok(GitBundleResult {
        data: base64_data,
        size: bundle_size,
        branch_name,
        head_sha,
        commit_count,
        folder_name,
    })
}

/// Get git repository information without creating bundle
/// Useful for showing preview before bundling
#[tauri::command(rename_all = "camelCase")]
pub fn get_git_repo_info(folder_path: String) -> Result<GitRepoInfo, String> {
    let repo_path = PathBuf::from(&folder_path);

    if !repo_path.exists() {
        return Err(format!("Folder does not exist: {}", folder_path));
    }

    if !repo_path.is_dir() {
        return Err(format!("Path is not a directory: {}", folder_path));
    }

    // Check if it's a git repository
    let git_dir = repo_path.join(".git");
    let is_git_repo = git_dir.exists();

    let folder_name = repo_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project")
        .to_string();

    if !is_git_repo {
        return Ok(GitRepoInfo {
            folder_name,
            is_git_repo: false,
            branch_name: None,
            head_sha: None,
            commit_count: 0,
            has_uncommitted_changes: false,
        });
    }

    let branch_name = get_current_branch(&repo_path).ok();
    let head_sha = get_head_sha(&repo_path).ok();
    let commit_count = count_commits(&repo_path).unwrap_or(0);
    let uncommitted = has_uncommitted_changes(&repo_path).unwrap_or(false);

    Ok(GitRepoInfo {
        folder_name,
        is_git_repo: true,
        branch_name,
        head_sha,
        commit_count,
        has_uncommitted_changes: uncommitted,
    })
}

/// Git repository information
#[derive(Debug, Serialize, Deserialize)]
pub struct GitRepoInfo {
    pub folder_name: String,
    pub is_git_repo: bool,
    pub branch_name: Option<String>,
    pub head_sha: Option<String>,
    pub commit_count: usize,
    pub has_uncommitted_changes: bool,
}

// ============================================
// Tests
// ============================================

// ============================================
// Git Sync Commands (Pull/Push)
// ============================================

/// Result of applying a git bundle
#[derive(Debug, Serialize, Deserialize)]
pub struct ApplyBundleResult {
    /// Whether the operation succeeded
    pub success: bool,
    /// The ref that was created (e.g., "refs/remotes/cloud/main")
    pub ref_name: String,
    /// Any message or error
    pub message: String,
}

/// Apply a git bundle by fetching into a remote ref
///
/// This creates refs/remotes/cloud/{branch} without touching the user's branches.
/// User can then decide whether to merge.
#[tauri::command(rename_all = "camelCase")]
pub fn apply_git_bundle(
    folder_path: String,
    bundle_data: String, // Base64-encoded bundle
    cloud_branch: String,
) -> Result<ApplyBundleResult, String> {
    let repo_path = PathBuf::from(&folder_path);

    // Validate folder exists and is a git repo
    if !repo_path.exists() || !repo_path.is_dir() {
        return Err(format!("Invalid folder path: {}", folder_path));
    }

    let git_dir = repo_path.join(".git");
    if !git_dir.exists() {
        return Err("Not a git repository".to_string());
    }

    // Create orgii directory for bundle storage
    let orgii_dir = git_dir.join("orgii");
    let _ = fs::create_dir_all(&orgii_dir);

    let bundle_path = orgii_dir.join("cloud.bundle");

    // Decode base64 and write bundle file
    let bundle_bytes = STANDARD
        .decode(&bundle_data)
        .map_err(|e| format!("Failed to decode bundle: {}", e))?;

    fs::write(&bundle_path, &bundle_bytes).map_err(|e| format!("Failed to write bundle: {}", e))?;

    // Fetch from bundle into remote ref (with retry for transient errors)
    // Use + prefix to FORCE update - this is a tracking ref we own, not a user branch
    // Without +, git rejects non-fast-forward updates (e.g., when cloud history diverged)
    let ref_name = format!("refs/remotes/cloud/{}", cloud_branch);
    let head_ref = format!("+HEAD:{}", ref_name); // + for force update
    let bundle_path_str = bundle_path.to_str().unwrap();
    let fetch_output = run_git_command(&repo_path, &["fetch", bundle_path_str, &head_ref])
        .inspect_err(|_e| {
            let _ = fs::remove_file(&bundle_path);
        })?;

    // Clean up bundle file
    let _ = fs::remove_file(&bundle_path);

    if !fetch_output.status.success() {
        let stderr = String::from_utf8_lossy(&fetch_output.stderr);
        return Err(format!("Failed to apply bundle: {}", stderr));
    }

    println!("✅ [GitBundle] Applied bundle to {}", ref_name);

    Ok(ApplyBundleResult {
        success: true,
        ref_name,
        message: format!("Bundle applied to cloud/{}", cloud_branch),
    })
}

/// Result of creating a push bundle
#[derive(Debug, Serialize, Deserialize)]
pub struct PushBundleResult {
    /// Base64-encoded bundle data
    pub data: String,
    /// Size in bytes
    pub size: u64,
    /// HEAD commit SHA
    pub head_sha: String,
    /// Whether this is incremental or full
    pub is_incremental: bool,
}

/// Create a git bundle for pushing to cloud
///
/// Creates an incremental bundle if base_sha is provided and valid,
/// otherwise creates a full bundle.
#[tauri::command(rename_all = "camelCase")]
pub fn create_push_bundle(
    folder_path: String,
    base_sha: Option<String>,
) -> Result<PushBundleResult, String> {
    let repo_path = PathBuf::from(&folder_path);

    // Validate folder exists and is a git repo
    if !repo_path.exists() || !repo_path.is_dir() {
        return Err(format!("Invalid folder path: {}", folder_path));
    }

    let git_dir = repo_path.join(".git");
    if !git_dir.exists() {
        return Err("Not a git repository".to_string());
    }

    // Get HEAD SHA
    let head_sha = get_head_sha(&repo_path)?;

    // Create orgii directory for bundle storage
    let orgii_dir = git_dir.join("orgii");
    let _ = fs::create_dir_all(&orgii_dir);

    let bundle_path = orgii_dir.join("push.bundle");

    // Try incremental bundle if base_sha provided
    let mut is_incremental = false;
    let mut bundle_created = false;

    let bundle_path_str = bundle_path.to_str().unwrap();

    if let Some(ref base) = base_sha {
        // Check if base commit exists (with retry)
        if let Ok(output) = run_git_command(&repo_path, &["cat-file", "-t", base]) {
            if output.status.success() {
                // Base exists, try incremental bundle
                let ref_spec = format!("{}..HEAD", base);
                if let Ok(output) = run_git_command(
                    &repo_path,
                    &["bundle", "create", bundle_path_str, &ref_spec],
                ) {
                    if output.status.success() {
                        is_incremental = true;
                        bundle_created = true;
                    }
                }
            }
        }
    }

    // Fall back to full bundle
    if !bundle_created {
        let bundle_output =
            run_git_command(&repo_path, &["bundle", "create", bundle_path_str, "HEAD"])?;

        if !bundle_output.status.success() {
            let stderr = String::from_utf8_lossy(&bundle_output.stderr);
            return Err(format!("Failed to create bundle: {}", stderr));
        }
    }

    // Read bundle file
    let bundle_data = fs::read(&bundle_path).map_err(|e| {
        let _ = fs::remove_file(&bundle_path);
        format!("Failed to read bundle: {}", e)
    })?;

    let bundle_size = bundle_data.len() as u64;

    // Clean up
    let _ = fs::remove_file(&bundle_path);

    // Check size limit
    if bundle_size > MAX_BUNDLE_SIZE {
        return Err(format!(
            "Bundle too large: {} MB (max: {} MB)",
            bundle_size / 1024 / 1024,
            MAX_BUNDLE_SIZE / 1024 / 1024
        ));
    }

    // Encode to base64
    let base64_data = STANDARD.encode(&bundle_data);

    println!(
        "✅ [GitBundle] Created push bundle: {} bytes, incremental={}",
        bundle_size, is_incremental
    );

    Ok(PushBundleResult {
        data: base64_data,
        size: bundle_size,
        head_sha,
        is_incremental,
    })
}

/// Result of merge operation
#[derive(Debug, Serialize, Deserialize)]
pub struct CloudMergeResult {
    /// Whether merge succeeded
    pub success: bool,
    /// Whether there were conflicts
    pub has_conflicts: bool,
    /// Conflicting files (if any)
    pub conflicting_files: Vec<String>,
    /// Message
    pub message: String,
}

/// Merge a ref into the current branch
#[tauri::command(rename_all = "camelCase")]
pub fn merge_cloud_ref(folder_path: String, ref_name: String) -> Result<CloudMergeResult, String> {
    let repo_path = PathBuf::from(&folder_path);

    // Validate folder exists and is a git repo
    if !repo_path.exists() || !repo_path.is_dir() {
        return Err(format!("Invalid folder path: {}", folder_path));
    }

    let git_dir = repo_path.join(".git");
    if !git_dir.exists() {
        return Err("Not a git repository".to_string());
    }

    // Try to merge (with retry for transient errors)
    let merge_output = run_git_command(&repo_path, &["merge", &ref_name, "--no-edit"])?;

    if merge_output.status.success() {
        return Ok(CloudMergeResult {
            success: true,
            has_conflicts: false,
            conflicting_files: vec![],
            message: "Merge completed successfully".to_string(),
        });
    }

    // Check for conflicts (with retry)
    let status_output = run_git_command(&repo_path, &["status", "--porcelain"])?;

    let status_str = String::from_utf8_lossy(&status_output.stdout);
    let mut conflicting_files = Vec::new();

    for line in status_str.lines() {
        // Lines starting with "UU", "AA", "DD", etc. indicate conflicts
        if line.starts_with("UU")
            || line.starts_with("AA")
            || line.starts_with("DD")
            || line.starts_with("AU")
            || line.starts_with("UA")
            || line.starts_with("DU")
            || line.starts_with("UD")
        {
            if let Some(file) = line.get(3..) {
                conflicting_files.push(file.to_string());
            }
        }
    }

    if !conflicting_files.is_empty() {
        return Ok(CloudMergeResult {
            success: false,
            has_conflicts: true,
            conflicting_files,
            message: "Merge conflicts detected. Please resolve locally.".to_string(),
        });
    }

    // Other merge failure
    let stderr = String::from_utf8_lossy(&merge_output.stderr);
    Err(format!("Merge failed: {}", stderr))
}

/// Get the current HEAD SHA (exposed as Tauri command)
#[tauri::command(rename_all = "camelCase")]
pub fn get_local_head_sha(folder_path: String) -> Result<String, String> {
    let repo_path = PathBuf::from(&folder_path);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err(format!("Invalid folder path: {}", folder_path));
    }

    let git_dir = repo_path.join(".git");
    if !git_dir.exists() {
        return Err("Not a git repository".to_string());
    }

    get_head_sha(&repo_path)
}

/// List all branches for a repository (for @ mention autocomplete)
#[tauri::command(rename_all = "camelCase")]
pub fn get_repo_branches(repo_path: String) -> Result<GetRepoBranchesResult, String> {
    let path = std::path::Path::new(&repo_path);
    if !path.exists() || !path.is_dir() {
        return Err(format!("Invalid repo path: {}", repo_path));
    }
    let git_dir = path.join(".git");
    if !git_dir.exists() {
        return Err("Not a git repository".to_string());
    }
    let data = crate::branches::list_branches(path)?;
    Ok(GetRepoBranchesResult {
        branches: data
            .branches
            .into_iter()
            .map(|b| BranchName { name: b.name })
            .collect(),
    })
}

/// Response for get_repo_branches
#[derive(Debug, Serialize, Deserialize)]
pub struct GetRepoBranchesResult {
    pub branches: Vec<BranchName>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BranchName {
    pub name: String,
}

/// Get the current branch name (exposed as Tauri command)
#[tauri::command(rename_all = "camelCase")]
pub fn get_local_branch(folder_path: String) -> Result<String, String> {
    let repo_path = PathBuf::from(&folder_path);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err(format!("Invalid folder path: {}", folder_path));
    }

    let git_dir = repo_path.join(".git");
    if !git_dir.exists() {
        return Err("Not a git repository".to_string());
    }

    get_current_branch(&repo_path)
}

// ============================================
// Git Operations for Conflict Resolution
// ============================================

/// Stage all files in the repository (git add -A)
/// Uses run_git_command helper with retries and clean environment
#[tauri::command(rename_all = "camelCase")]
pub fn git_add_all(folder_path: String) -> Result<(), String> {
    let repo_path = PathBuf::from(&folder_path);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err(format!("Invalid folder path: {}", folder_path));
    }

    let git_dir = repo_path.join(".git");
    if !git_dir.exists() {
        return Err("Not a git repository".to_string());
    }

    // Use run_git_command which has retries and uses env -i for clean environment
    let output = run_git_command(&repo_path, &["add", "-A"])?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git add failed: {}", stderr));
    }

    println!("✅ [GitBundle] Staged all files");
    Ok(())
}

/// Create a commit with the given message
/// Uses run_git_command helper with retries and clean environment
#[tauri::command(rename_all = "camelCase")]
pub fn git_commit(folder_path: String, message: String) -> Result<(), String> {
    let repo_path = PathBuf::from(&folder_path);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err(format!("Invalid folder path: {}", folder_path));
    }

    let git_dir = repo_path.join(".git");
    if !git_dir.exists() {
        return Err("Not a git repository".to_string());
    }

    // Use run_git_command which has retries and uses env -i for clean environment
    let output = run_git_command(&repo_path, &["commit", "-m", &message])?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Git prints "nothing to commit, working tree clean" to STDOUT and
        // exits 1; checking stderr alone turned the benign no-op into
        // `git commit failed:` with an empty message.
        if stderr.contains("nothing to commit") || stdout.contains("nothing to commit") {
            println!("📝 [GitBundle] Nothing to commit");
            return Ok(());
        }
        return Err(format!("git commit failed: {}{}", stdout, stderr));
    }

    println!("✅ [GitBundle] Commit created: {}", message);
    Ok(())
}

// ============================================
// Local Commit History
// ============================================

/// Commit info for the frontend
#[derive(Debug, Clone, serde::Serialize)]
pub struct LocalCommitInfo {
    pub sha: String,
    pub message: String,
    pub author: String,
    pub timestamp: String,
}

/// Get local commit history for a repository
///
/// Returns commits in reverse chronological order (most recent first).
/// Used for calculating ahead/behind status with remote.
#[tauri::command(rename_all = "camelCase")]
pub fn get_local_commit_history(
    folder_path: String,
    limit: Option<u32>,
) -> Result<Vec<LocalCommitInfo>, String> {
    let repo_path = PathBuf::from(&folder_path);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err(format!("Invalid folder path: {}", folder_path));
    }

    let git_dir = repo_path.join(".git");
    if !git_dir.exists() {
        return Err("Not a git repository".to_string());
    }

    let limit = limit.unwrap_or(50).min(200);

    // Format: sha<NUL>subject<NUL>author name <email><NUL>ISO date<RS>
    // Using record separator (0x1e) to split entries
    let limit_arg = format!("-{}", limit);
    let format_arg = "--format=%H%x00%s%x00%an <%ae>%x00%aI%x1e";
    let output = run_git_command(&repo_path, &["log", &limit_arg, format_arg])?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git log failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut commits = Vec::new();

    // Split by record separator (0x1e), filter empty entries
    for record in stdout.split('\x1e') {
        let record = record.trim();
        if record.is_empty() {
            continue;
        }

        let parts: Vec<&str> = record.split('\x00').collect();
        if parts.len() >= 4 {
            commits.push(LocalCommitInfo {
                sha: parts[0].to_string(),
                message: parts[1].to_string(),
                author: parts[2].to_string(),
                timestamp: parts[3].to_string(),
            });
        }
    }

    Ok(commits)
}

// ============================================
// Ahead/Behind Calculation (libgit2)
// ============================================

/// Result of ahead/behind calculation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AheadBehindStatus {
    /// Number of commits local is ahead of remote
    pub ahead: usize,
    /// Number of commits local is behind remote
    pub behind: usize,
    /// Whether local and remote are in sync
    pub in_sync: bool,
}

/// Calculate ahead/behind status between local HEAD and a remote SHA.
///
/// Uses libgit2's `graph_ahead_behind()` which is O(n) where n is the
/// number of commits between the two refs — much faster than the previous
/// approach of fetching commit lists and comparing in JS.
///
/// # Arguments
/// * `folder_path` - Path to the git repository
/// * `remote_head_sha` - The remote HEAD SHA to compare against
///
/// # Returns
/// * `AheadBehindStatus` with ahead, behind counts and in_sync flag
#[tauri::command(rename_all = "camelCase")]
pub fn calculate_ahead_behind(
    folder_path: String,
    remote_head_sha: String,
) -> Result<AheadBehindStatus, String> {
    use git2::{Oid, Repository};

    let repo_path = PathBuf::from(&folder_path);

    // Validate folder exists
    if !repo_path.exists() || !repo_path.is_dir() {
        return Err(format!("Invalid folder path: {}", folder_path));
    }

    let git_dir = repo_path.join(".git");
    if !git_dir.exists() {
        return Err("Not a git repository".to_string());
    }

    // Open repository using libgit2
    let repo =
        Repository::open(&repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    // Get local HEAD commit
    let local_oid = repo
        .head()
        .map_err(|e| format!("Failed to get HEAD: {}", e))?
        .peel_to_commit()
        .map_err(|e| format!("Failed to get HEAD commit: {}", e))?
        .id();

    // Parse remote SHA
    let remote_oid = Oid::from_str(&remote_head_sha)
        .map_err(|e| format!("Invalid remote SHA '{}': {}", remote_head_sha, e))?;

    // Check if remote commit exists in local repo
    // If not, the repos have diverged completely or remote is ahead
    if repo.find_commit(remote_oid).is_err() {
        // Remote commit doesn't exist locally - we're behind by unknown amount
        // Fall back to counting local commits (they're all "ahead")
        let local_count = count_commits(&repo_path).unwrap_or(0);
        return Ok(AheadBehindStatus {
            ahead: local_count,
            behind: 0, // Can't determine without remote commits
            in_sync: false,
        });
    }

    // If local and remote are the same, we're in sync
    if local_oid == remote_oid {
        return Ok(AheadBehindStatus {
            ahead: 0,
            behind: 0,
            in_sync: true,
        });
    }

    // Use libgit2's graph_ahead_behind for efficient calculation
    let (ahead, behind) = repo
        .graph_ahead_behind(local_oid, remote_oid)
        .map_err(|e| format!("Failed to calculate ahead/behind: {}", e))?;

    Ok(AheadBehindStatus {
        ahead,
        behind,
        in_sync: ahead == 0 && behind == 0,
    })
}

// ============================================
// Tests
// ============================================

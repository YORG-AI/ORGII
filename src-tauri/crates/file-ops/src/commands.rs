//! File Utilities Module
//!
//! High-performance file utilities implemented in Rust for better performance:
//! - Binary file detection (byte-level analysis)
//! - Gitignore/path filtering (pattern matching)
//!
//! These operations are called frequently from the frontend and benefit from
//! native performance vs JavaScript implementations.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

// ============================================
// Binary Detection
// ============================================

/// Common binary file extensions (lowercase)
const BINARY_EXTENSIONS: &[&str] = &[
    // Images
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg", "tiff", "tif", "psd", "ai", "eps",
    "raw", "cr2", "nef", "orf", "sr2", // Videos
    "mp4", "avi", "mov", "wmv", "flv", "mkv", "webm", "m4v", "mpg", "mpeg", "3gp",
    // Audio
    "mp3", "wav", "flac", "aac", "ogg", "wma", "m4a", "opus", "aiff", // Archives
    "zip", "tar", "gz", "bz2", "7z", "rar", "xz", "tgz", "jar", "war", "ear",
    // Executables & Libraries
    "exe", "dll", "so", "dylib", "bin", "app", "deb", "rpm", "msi", "dmg", "pkg", "apk", "ipa",
    // Documents (binary formats)
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "pages", "numbers",
    "key", // Fonts
    "ttf", "otf", "woff", "woff2", "eot", // Database
    "db", "sqlite", "sqlite3", "mdb", // Other binary formats
    "pyc", "pyo", "class", "o", "obj", "a", "lib", "wasm", "node",
];

/// Known text files without extensions
const KNOWN_TEXT_FILES: &[&str] = &[
    "Makefile",
    "Dockerfile",
    "Jenkinsfile",
    "Vagrantfile",
    "Gemfile",
    "Rakefile",
    "Procfile",
    "README",
    "LICENSE",
    "CHANGELOG",
    "CONTRIBUTING",
    "AUTHORS",
    "NOTICE",
    ".gitignore",
    ".dockerignore",
    ".npmignore",
    ".editorconfig",
    ".prettierrc",
    ".eslintrc",
    ".babelrc",
];

/// Result of binary detection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryDetectionResult {
    /// Whether the file is binary
    pub is_binary: bool,
    /// Detection method used
    pub method: String,
    /// Additional details (e.g., extension matched, null byte found)
    pub details: Option<String>,
}

/// Check if a file is binary based on its extension
#[tauri::command]
pub fn is_binary_by_extension(file_path: String) -> BinaryDetectionResult {
    let path = Path::new(&file_path);

    // Get filename
    let filename = path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();

    // Check if it's a known text file
    if KNOWN_TEXT_FILES.contains(&filename.as_str()) {
        return BinaryDetectionResult {
            is_binary: false,
            method: "known_text_file".to_string(),
            details: Some(format!("Known text file: {}", filename)),
        };
    }

    // Get extension
    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    // Check if extension is in binary list
    if BINARY_EXTENSIONS.contains(&extension.as_str()) {
        return BinaryDetectionResult {
            is_binary: true,
            method: "extension".to_string(),
            details: Some(format!("Binary extension: .{}", extension)),
        };
    }

    // Check for extensionless files with binary patterns
    if extension.is_empty() {
        // Common binary executable patterns in path
        let path_lower = file_path.to_lowercase();
        let binary_patterns = [
            "-aarch64", "-x86_64", "-arm64", "-i386", "-i686", "-armv7", "-darwin", "-linux",
            "-windows", "-macos", "-apple", "helper", "daemon", "agent", "server", "client",
            "worker", "service", "/bin/",
        ];

        for pattern in binary_patterns {
            if path_lower.contains(pattern) {
                return BinaryDetectionResult {
                    is_binary: true,
                    method: "pattern".to_string(),
                    details: Some(format!("Binary pattern: {}", pattern)),
                };
            }
        }
    }

    BinaryDetectionResult {
        is_binary: false,
        method: "extension".to_string(),
        details: None,
    }
}

/// Check if file content is binary by analyzing bytes
///
/// This is more accurate but requires reading the file.
/// Uses SIMD-optimized null byte detection.
#[tauri::command]
pub fn is_binary_content(content: Vec<u8>, sample_size: Option<usize>) -> BinaryDetectionResult {
    let sample_size = sample_size.unwrap_or(8000);
    let sample = if content.len() > sample_size {
        &content[..sample_size]
    } else {
        &content
    };

    // Check for null bytes - strong indicator of binary content
    // This is the most reliable test
    if sample.contains(&0u8) {
        return BinaryDetectionResult {
            is_binary: true,
            method: "null_byte".to_string(),
            details: Some("Contains null byte".to_string()),
        };
    }

    // Count non-printable characters
    let mut non_printable_count = 0usize;
    for &byte in sample {
        // Allow common whitespace: tab (9), newline (10), carriage return (13), space (32)
        if byte == 9 || byte == 10 || byte == 13 || byte == 32 {
            continue;
        }

        // Check for non-printable characters (< 32 or between 127-159)
        if byte < 32 || (byte > 126 && byte < 160) {
            non_printable_count += 1;
        }
    }

    // If more than 30% of characters are non-printable, consider it binary
    let ratio = non_printable_count as f64 / sample.len() as f64;
    if ratio > 0.3 {
        return BinaryDetectionResult {
            is_binary: true,
            method: "non_printable_ratio".to_string(),
            details: Some(format!("Non-printable ratio: {:.1}%", ratio * 100.0)),
        };
    }

    BinaryDetectionResult {
        is_binary: false,
        method: "content_analysis".to_string(),
        details: None,
    }
}

/// Check if a file is binary (combines extension + content check)
/// Reads the file from disk for content analysis
#[tauri::command]
pub fn is_binary_file(
    file_path: String,
    check_content: Option<bool>,
) -> Result<BinaryDetectionResult, String> {
    // First check extension
    let ext_result = is_binary_by_extension(file_path.clone());
    if ext_result.is_binary {
        return Ok(ext_result);
    }

    // If content check requested and extension didn't match
    if check_content.unwrap_or(true) {
        let path = Path::new(&file_path);
        if path.exists() && path.is_file() {
            // Read first 8KB of file
            match std::fs::read(&file_path) {
                Ok(content) => {
                    let content_result = is_binary_content(content, Some(8000));
                    if content_result.is_binary {
                        return Ok(content_result);
                    }
                }
                Err(e) => {
                    return Err(format!("Failed to read file: {}", e));
                }
            }
        }
    }

    Ok(BinaryDetectionResult {
        is_binary: false,
        method: "combined".to_string(),
        details: None,
    })
}

// ============================================
// macOS Document Conversion (textutil)
// ============================================

/// Result of converting a .pages file — the frontend uses `kind` to pick a renderer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PagesPreviewResult {
    /// `"html"` = rich HTML (render in div), `"pdf"` = temp PDF path (render in iframe)
    pub kind: String,
    /// HTML string or absolute path to a temp PDF file
    pub data: String,
}

/// Convert a .pages document for preview.
///
/// Strategy (macOS only, tried in order):
/// 1. `textutil -convert html` — fast, works for older XML-based .pages
/// 2. `osascript` + Pages.app export to PDF — works for all .pages, text selectable
/// 3. Quick Look thumbnail — image-only fallback if Pages.app is not installed
#[tauri::command]
pub async fn convert_pages_to_html(file_path: String) -> Result<PagesPreviewResult, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = file_path;
        return Err("Pages preview is only supported on macOS".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        use std::time::{SystemTime, UNIX_EPOCH};

        let path = Path::new(&file_path);
        if !path.exists() {
            return Err(format!("File not found: {}", file_path));
        }

        let output_dir = std::env::temp_dir().join("orgii_pages_preview");
        std::fs::create_dir_all(&output_dir)
            .map_err(|err| format!("Failed to create temp dir: {}", err))?;

        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();

        // --- Attempt 1: textutil (fast, older XML-based .pages) ---
        let output_html = format!("{}/pages_{}.html", output_dir.to_string_lossy(), ts);
        {
            let textutil_output = output_html.clone();
            let textutil_input = file_path.clone();

            let textutil_result = tokio::task::spawn_blocking(move || {
                std::process::Command::new("textutil")
                    .args([
                        "-convert",
                        "html",
                        "-output",
                        &textutil_output,
                        &textutil_input,
                    ])
                    .output()
            })
            .await
            .map_err(|err| format!("Task join error: {}", err))?;

            if let Ok(output) = textutil_result {
                if output.status.success() && Path::new(&output_html).exists() {
                    let html = std::fs::read_to_string(&output_html)
                        .map_err(|err| format!("Failed to read converted HTML: {}", err))?;
                    let _ = std::fs::remove_file(&output_html);
                    return Ok(PagesPreviewResult {
                        kind: "html".into(),
                        data: html,
                    });
                }
            }
            let _ = std::fs::remove_file(&output_html);
        }

        // --- Attempt 2: Pages.app export to PDF (text selectable) ---
        let output_pdf = format!("{}/pages_{}.pdf", output_dir.to_string_lossy(), ts);
        {
            let pdf_path = output_pdf.clone();
            let input_path = file_path.clone();

            let script = format!(
                r#"
                    tell application "Pages"
                        open POSIX file "{input}"
                        export front document to POSIX file "{output}" as PDF
                        close front document saving no
                    end tell
                "#,
                input = input_path.replace('"', r#"\""#),
                output = pdf_path.replace('"', r#"\""#),
            );

            let osa_result = tokio::task::spawn_blocking(move || {
                std::process::Command::new("osascript")
                    .args(["-e", &script])
                    .output()
            })
            .await
            .map_err(|err| format!("Task join error: {}", err))?;

            if let Ok(output) = osa_result {
                if output.status.success() && Path::new(&output_pdf).exists() {
                    return Ok(PagesPreviewResult {
                        kind: "pdf".into(),
                        data: output_pdf,
                    });
                }
            }
            let _ = std::fs::remove_file(&output_pdf);
        }

        // --- Attempt 3: Quick Look thumbnail (image fallback) ---
        let ql_dir = format!("{}/ql_{}", output_dir.to_string_lossy(), ts);
        std::fs::create_dir_all(&ql_dir)
            .map_err(|err| format!("Failed to create Quick Look temp dir: {}", err))?;

        {
            let ql_dir_cmd = ql_dir.clone();
            let ql_input = file_path.clone();

            let ql_result = tokio::task::spawn_blocking(move || {
                std::process::Command::new("qlmanage")
                    .args(["-t", "-s", "2048", "-o", &ql_dir_cmd, &ql_input])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .output()
            })
            .await
            .map_err(|err| format!("Task join error: {}", err))?
            .map_err(|err| format!("Failed to run qlmanage: {}", err))?;

            if ql_result.status.success() {
                if let Some(png) = find_png_in_dir(&ql_dir) {
                    use base64::{engine::general_purpose::STANDARD, Engine as _};
                    let png_bytes = std::fs::read(&png)
                        .map_err(|err| format!("Failed to read Quick Look thumbnail: {}", err))?;
                    let b64 = STANDARD.encode(&png_bytes);
                    let _ = std::fs::remove_dir_all(&ql_dir);

                    let html = format!(
                        r#"<div style="display:flex;justify-content:center;padding:16px"><img src="data:image/png;base64,{}" style="max-width:100%;height:auto;border-radius:4px" /></div>"#,
                        b64,
                    );
                    return Ok(PagesPreviewResult {
                        kind: "html".into(),
                        data: html,
                    });
                }
            }
        }

        let _ = std::fs::remove_dir_all(&ql_dir);
        Err("Could not preview this Pages document".to_string())
    }
}

/// Find the first .png file in a directory (used for qlmanage output).
#[cfg(target_os = "macos")]
fn find_png_in_dir(dir: &str) -> Option<std::path::PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("png") {
            return Some(path);
        }
    }
    None
}

// ============================================
// Ignore Filter
// ============================================

/// Directories that should always be ignored
const BLACKLIST_DIRS: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "node_modules",
    ".next",
    ".nuxt",
    ".turbo",
    ".parcel-cache",
    "target",
    ".gradle",
    ".m2",
    "out",
    ".idea",
    ".vscode",
    ".vs",
    ".DS_Store",
    "Thumbs.db",
    ".cache",
    ".tmp",
    "tmp",
    "temp",
];

/// File extensions that should always be ignored
const BLACKLIST_EXTENSIONS: &[&str] = &[
    ".pyc", ".pyo", ".pyd", ".class", ".o", ".obj", ".so", ".dylib", ".dll", ".exe", ".a", ".lib",
    ".zip", ".tar", ".tar.gz", ".tgz", ".rar", ".7z", ".jar", ".war", ".ear", ".swp", ".swo",
    ".bak", ".orig", ".sqlite", ".db", ".sqlite3",
];

/// Dotfiles that are whitelisted (config files that should NOT be ignored)
const DOTFILE_WHITELIST: &[&str] = &[
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yaml",
    ".prettierrc.yml",
    ".prettierrc.js",
    ".eslintrc",
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.yaml",
    ".eslintrc.yml",
    ".stylelintrc",
    ".stylelintrc.json",
    ".babelrc",
    ".babelrc.json",
    ".browserslistrc",
    ".npmrc",
    ".nvmrc",
    ".node-version",
    ".python-version",
    ".ruby-version",
    ".tool-versions",
    ".dockerignore",
    ".clang-format",
    ".clang-tidy",
    ".rustfmt.toml",
    ".flake8",
    ".pylintrc",
    ".isort.cfg",
    ".pre-commit-config.yaml",
    ".env.example",
    ".env.template",
    ".env.sample",
    ".gitlab-ci.yml",
    ".travis.yml",
    ".markdownlint.json",
    ".markdownlintrc",
];

/// Directories that are whitelisted (even though they start with .)
const WHITELIST_DIRS: &[&str] = &[".github", ".circleci", ".cargo"];

/// Files/directories that are ALWAYS blocked (security sensitive)
const HARD_BLOCKED: &[&str] = &[
    ".git",
    ".env",
    ".env.local",
    ".env.development.local",
    ".env.production.local",
    ".env.test.local",
    ".secrets",
    ".aws",
    ".ssh",
    ".gnupg",
    ".netrc",
];

/// Result of ignore check
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IgnoreResult {
    /// Whether the path should be ignored
    pub should_ignore: bool,
    /// Reason for the decision
    pub reason: String,
    /// Category of ignore (hard_blocked, blacklist_dir, blacklist_ext, dotfile, gitignore)
    pub category: Option<String>,
}

/// Check if a path should be ignored for file sync
#[tauri::command]
pub fn should_ignore_path(
    relative_path: String,
    gitignore_patterns: Option<Vec<String>>,
) -> IgnoreResult {
    let parts: Vec<&str> = relative_path.split(&['/', '\\'][..]).collect();
    let filename = parts.last().copied().unwrap_or("");

    // Build HashSets for faster lookup
    let hard_blocked: HashSet<&str> = HARD_BLOCKED.iter().copied().collect();
    let blacklist_dirs: HashSet<&str> = BLACKLIST_DIRS.iter().copied().collect();
    let dotfile_whitelist: HashSet<&str> = DOTFILE_WHITELIST.iter().copied().collect();
    let whitelist_dirs: HashSet<&str> = WHITELIST_DIRS.iter().copied().collect();

    // Check hard blocked paths (security)
    for part in &parts {
        if hard_blocked.contains(*part) {
            return IgnoreResult {
                should_ignore: true,
                reason: format!("Security-sensitive path: {}", part),
                category: Some("hard_blocked".to_string()),
            };
        }
    }

    // Check if filename is in dotfile whitelist
    if dotfile_whitelist.contains(filename) {
        return IgnoreResult {
            should_ignore: false,
            reason: format!("Whitelisted config file: {}", filename),
            category: None,
        };
    }

    // Check if path contains whitelisted directory
    for part in &parts {
        if whitelist_dirs.contains(*part) {
            return IgnoreResult {
                should_ignore: false,
                reason: format!("Whitelisted directory: {}", part),
                category: None,
            };
        }
    }

    // Check if filename starts with dot (hidden file)
    if filename.starts_with('.') {
        return IgnoreResult {
            should_ignore: true,
            reason: format!("Hidden file: {}", filename),
            category: Some("dotfile".to_string()),
        };
    }

    // Check blacklist directories
    for part in &parts {
        if blacklist_dirs.contains(*part) {
            return IgnoreResult {
                should_ignore: true,
                reason: format!("Blacklisted directory: {}", part),
                category: Some("blacklist_dir".to_string()),
            };
        }
    }

    // Check blacklist extensions
    for ext in BLACKLIST_EXTENSIONS {
        if filename.ends_with(ext) {
            return IgnoreResult {
                should_ignore: true,
                reason: format!("Blacklisted extension: {}", ext),
                category: Some("blacklist_ext".to_string()),
            };
        }
    }

    // Check gitignore patterns if provided
    if let Some(patterns) = gitignore_patterns {
        for pattern in patterns {
            if match_gitignore_pattern(&relative_path, &pattern) {
                return IgnoreResult {
                    should_ignore: true,
                    reason: format!("Gitignore pattern: {}", pattern),
                    category: Some("gitignore".to_string()),
                };
            }
        }
    }

    IgnoreResult {
        should_ignore: false,
        reason: "No ignore rules matched".to_string(),
        category: None,
    }
}

/// Match a gitignore pattern against a path
pub(crate) fn match_gitignore_pattern(path: &str, pattern: &str) -> bool {
    // Skip comments and negations
    if pattern.is_empty() || pattern.starts_with('#') || pattern.starts_with('!') {
        return false;
    }

    // Convert gitignore pattern to regex
    let mut regex_pattern = pattern
        .replace('.', r"\.")
        .replace("**", ".*")
        .replace('*', "[^/]*")
        .replace('?', "[^/]");

    // Handle directory patterns — strip the trailing escaped separator
    if pattern.ends_with('/') {
        regex_pattern = format!("(^|/){}(/|$)", &regex_pattern[..regex_pattern.len() - 1]);
    } else {
        regex_pattern = format!("(^|/){}$", regex_pattern);
    }

    // Try to match
    match regex::Regex::new(&regex_pattern) {
        Ok(re) => re.is_match(path),
        Err(_) => false,
    }
}

/// Batch check multiple paths for ignore status
/// More efficient than calling should_ignore_path for each path individually
#[tauri::command]
pub fn should_ignore_paths_batch(
    relative_paths: Vec<String>,
    gitignore_patterns: Option<Vec<String>>,
) -> Vec<IgnoreResult> {
    relative_paths
        .into_iter()
        .map(|path| should_ignore_path(path, gitignore_patterns.clone()))
        .collect()
}

/// Filter a list of paths, returning only those that should NOT be ignored
#[tauri::command]
pub fn filter_ignored_paths(
    relative_paths: Vec<String>,
    gitignore_patterns: Option<Vec<String>>,
) -> Vec<String> {
    relative_paths
        .into_iter()
        .filter(|path| !should_ignore_path(path.clone(), gitignore_patterns.clone()).should_ignore)
        .collect()
}

// ============================================
// Directory Listing (UI file tree)
// ============================================

/// A single directory entry for the frontend file tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: &'static str,
    pub is_symlink: bool,
    pub is_ignored: bool,
}

/// List a directory's contents with gitignore filtering and symlink
/// resolution in a single call. Returns entries sorted directories-first
/// then alphabetically.
///
/// Replaces the TS-side `loadDirectoryContents` which did
/// readDir + per-entry stat + gitignore check + sort across many async hops.
#[tauri::command]
pub async fn list_directory_filtered(
    dir_path: String,
    repo_path: Option<String>,
    gitignore_patterns: Option<Vec<String>>,
) -> Result<Vec<DirEntry>, String> {
    let dir_path_clone = dir_path.clone();
    let repo_path_clone = repo_path.clone();
    let patterns_clone = gitignore_patterns.clone();

    tokio::task::spawn_blocking(move || {
        let entries = std::fs::read_dir(&dir_path_clone)
            .map_err(|err| format!("read_dir failed: {}", err))?;

        let mut result: Vec<DirEntry> = Vec::new();

        for entry in entries {
            let entry = entry.map_err(|err| format!("entry error: {}", err))?;
            let file_name = entry.file_name().to_string_lossy().to_string();
            let full_path = format!("{}/{}", dir_path_clone, file_name);

            let metadata = entry
                .metadata()
                .map_err(|err| format!("metadata error: {}", err))?;
            let is_symlink = metadata.file_type().is_symlink();

            let is_dir = if is_symlink {
                std::fs::metadata(&full_path)
                    .map(|m| m.is_dir())
                    .unwrap_or(false)
            } else {
                metadata.is_dir()
            };

            let is_ignored = if let Some(ref repo) = repo_path_clone {
                let relative = if full_path.starts_with(&format!("{}/", repo)) {
                    &full_path[repo.len() + 1..]
                } else {
                    &file_name
                };
                let path_to_check = if is_dir {
                    format!("{}/", relative)
                } else {
                    relative.to_string()
                };
                should_ignore_path(path_to_check, patterns_clone.clone()).should_ignore
            } else {
                false
            };

            result.push(DirEntry {
                name: file_name,
                path: full_path,
                entry_type: if is_dir { "directory" } else { "file" },
                is_symlink,
                is_ignored,
            });
        }

        result.sort_by(|left, right| {
            if left.entry_type == right.entry_type {
                left.name.to_lowercase().cmp(&right.name.to_lowercase())
            } else if left.entry_type == "directory" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        });

        Ok(result)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

// ============================================
// Recursive Directory Tree
// ============================================

/// A directory tree node with optional children for expanded directories.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: &'static str,
    pub is_symlink: bool,
    pub is_ignored: bool,
    pub expanded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeEntry>>,
}

/// Load a directory tree in a single call, recursing into previously-expanded
/// directories. Replaces the TS-side `mergeTreeReloadingExpanded` which did
/// sequential `readDir` per expanded directory across many async hops.
#[tauri::command]
pub async fn list_directory_tree(
    dir_path: String,
    repo_path: Option<String>,
    gitignore_patterns: Option<Vec<String>>,
    expanded_paths: Vec<String>,
) -> Result<Vec<TreeEntry>, String> {
    let expanded_set: std::collections::HashSet<String> = expanded_paths.into_iter().collect();

    tokio::task::spawn_blocking(move || {
        build_tree_level(&dir_path, &repo_path, &gitignore_patterns, &expanded_set)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

fn build_tree_level(
    dir_path: &str,
    repo_path: &Option<String>,
    gitignore_patterns: &Option<Vec<String>>,
    expanded_set: &std::collections::HashSet<String>,
) -> Result<Vec<TreeEntry>, String> {
    let entries = std::fs::read_dir(dir_path).map_err(|err| format!("read_dir failed: {}", err))?;

    let mut result: Vec<TreeEntry> = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|err| format!("entry error: {}", err))?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        let full_path = format!("{}/{}", dir_path, file_name);

        let metadata = entry
            .metadata()
            .map_err(|err| format!("metadata error: {}", err))?;
        let is_symlink = metadata.file_type().is_symlink();

        let is_dir = if is_symlink {
            std::fs::metadata(&full_path)
                .map(|m| m.is_dir())
                .unwrap_or(false)
        } else {
            metadata.is_dir()
        };

        let is_ignored = if let Some(ref repo) = repo_path {
            let relative = if full_path.starts_with(&format!("{}/", repo)) {
                &full_path[repo.len() + 1..]
            } else {
                &file_name
            };
            let path_to_check = if is_dir {
                format!("{}/", relative)
            } else {
                relative.to_string()
            };
            should_ignore_path(path_to_check, gitignore_patterns.clone()).should_ignore
        } else {
            false
        };

        let should_expand = is_dir && expanded_set.contains(&full_path);
        let children = if should_expand {
            match build_tree_level(&full_path, repo_path, gitignore_patterns, expanded_set) {
                Ok(kids) => Some(kids),
                Err(_) => Some(Vec::new()),
            }
        } else if is_dir {
            Some(Vec::new())
        } else {
            None
        };

        result.push(TreeEntry {
            name: file_name,
            path: full_path,
            entry_type: if is_dir { "directory" } else { "file" },
            is_symlink,
            is_ignored,
            expanded: should_expand,
            children,
        });
    }

    result.sort_by(|left, right| {
        if left.entry_type == right.entry_type {
            left.name.to_lowercase().cmp(&right.name.to_lowercase())
        } else if left.entry_type == "directory" {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(result)
}

// ============================================
// Preview asset scope
// ============================================

/// Validate a path the frontend wants to stream through the asset protocol:
/// it must exist and be a regular file. Returns the canonical path, which is
/// what the scope is widened for and what `convertFileSrc` must receive.
pub fn validate_preview_asset_path(file_path: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::Path::new(file_path);
    let metadata =
        std::fs::metadata(path).map_err(|err| format!("Cannot preview {}: {}", file_path, err))?;
    if !metadata.is_file() {
        return Err(format!("Cannot preview {}: not a regular file", file_path));
    }
    std::fs::canonicalize(path).map_err(|err| format!("Cannot resolve {}: {}", file_path, err))
}

/// Allow the asset protocol to serve one file the user opened in a preview.
///
/// `<video>` and the PDF viewer can then stream the file straight from disk
/// (the asset handler answers HTTP range requests) instead of the frontend
/// reading the whole file into a Blob. The scope is widened per file, never
/// per directory: only files the user explicitly opened become reachable
/// through `asset://`, and the fs plugin could already read all of them.
#[tauri::command]
pub fn allow_preview_asset(app: tauri::AppHandle, file_path: String) -> Result<String, String> {
    use tauri::Manager;

    let canonical = validate_preview_asset_path(&file_path)?;
    app.asset_protocol_scope()
        .allow_file(&canonical)
        .map_err(|err| format!("Cannot allow preview of {}: {}", file_path, err))?;
    Ok(canonical.to_string_lossy().into_owned())
}

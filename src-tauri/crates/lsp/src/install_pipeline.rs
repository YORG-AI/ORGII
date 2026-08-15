//! LSP Server Installation Pipeline
//!
//! Provides on-demand installation of LSP server binaries when they are not
//! found on the system. This is NOT automatic background installation - it only
//! runs when a server is explicitly requested and the binary is missing.
//!
//! Pipeline:
//! 1. Check PATH for existing binary
//! 2. Check ~/.orgii/lsp-bin/ for previously installed binary
//! 3. If enabled, install via package manager (npm, pip, go, cargo, etc.)
//! 4. If enabled, download from GitHub releases
//!
//! Reuses the existing `package_manager.rs` detection for npm, pip, cargo, go, etc.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;

use super::command_detection::command_exists;
use super::commands::package_manager::detect_package_manager;
use app_paths::lsp_bin_dir;

/// How to install an LSP server binary.
#[derive(Debug, Clone)]
pub enum InstallMethod {
    /// Install via npm/pnpm/yarn/bun (e.g., typescript-language-server, pyright)
    Npm { package: &'static str },

    /// Install via `go install` (e.g., gopls)
    Go { module: &'static str },

    /// Install via `dotnet tool install` (e.g., csharp-ls)
    Dotnet { tool: &'static str },

    /// Install via `pip`/`pip3` (e.g., python-lsp-server)
    Pip { package: &'static str },

    /// Install via `cargo install` (but prefer pre-built binaries when available)
    Cargo { crate_name: &'static str },

    /// Download from GitHub releases (e.g., clangd, rust-analyzer, lua-language-server)
    GithubRelease {
        repo: &'static str,
        binary_name: &'static str,
        /// Function to generate the asset filename pattern for this platform
        /// Args: (version_tag, target_triple)
        asset_pattern: fn(&str, &str) -> String,
    },

    /// Require the binary to already be on PATH (no auto-install).
    /// Used for system-provided tools like sourcekit-lsp (Xcode), rust-analyzer (rustup).
    RequirePath,
}

/// Errors that can occur during auto-installation.
#[derive(Debug)]
pub enum InstallError {
    /// Auto-install is disabled via environment variable
    Disabled,
    /// The required package manager is not available
    PackageManagerNotFound(String),
    /// Installation command failed
    InstallFailed { command: String, stderr: String },
    /// Binary still not found after installation
    BinaryNotFound(String),
    /// GitHub release download failed
    DownloadFailed(String),
    /// RequirePath method - binary must be installed manually
    ManualInstallRequired(String),
    /// Generic error
    Other(String),
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => write!(f, "LSP auto-install is disabled"),
            Self::PackageManagerNotFound(pm) => {
                write!(f, "Package manager not found: {}", pm)
            }
            Self::InstallFailed { command, stderr } => {
                write!(f, "Install command failed: {}\n{}", command, stderr)
            }
            Self::BinaryNotFound(bin) => {
                write!(f, "Binary '{}' not found after installation", bin)
            }
            Self::DownloadFailed(msg) => write!(f, "Download failed: {}", msg),
            Self::ManualInstallRequired(bin) => {
                write!(
                    f,
                    "Binary '{}' requires manual installation (not auto-installable)",
                    bin
                )
            }
            Self::Other(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for InstallError {}

/// Check if on-demand installation is enabled (synchronous version for non-async contexts).
///
/// Priority:
/// 1. Environment variable `ORGII_LSP_INSTALL` (if set)
/// 2. Global config file `~/.orgii/lsp.json` (async version reads this)
/// 3. Default: true
///
/// For async contexts, use `super::config::is_auto_install_enabled()` instead.
pub fn is_install_enabled_sync() -> bool {
    // Environment variable takes precedence (support both old and new names)
    for var_name in &["ORGII_LSP_INSTALL", "ORGII_LSP_AUTO_INSTALL"] {
        if let Ok(env_val) = std::env::var(var_name) {
            return !matches!(
                env_val.to_lowercase().as_str(),
                "false" | "0" | "no" | "off"
            );
        }
    }

    // Fallback to config file (blocking read - use sparingly)
    super::config::load_config()
        .map(|c| c.auto_install)
        .unwrap_or(true)
}

/// Find a binary on PATH or in the LSP bin directory.
pub fn find_binary(binary_name: &str) -> Option<PathBuf> {
    // First check if it's on PATH
    if let Ok(path) = which::which(binary_name) {
        return Some(path);
    }

    // Then check in our LSP bin directory
    let lsp_bin = lsp_bin_dir();
    let bin_path = lsp_bin.join(binary_name);
    if bin_path.exists() && bin_path.is_file() {
        return Some(bin_path);
    }

    // On Windows, also check with .exe extension
    #[cfg(target_os = "windows")]
    {
        let exe_path = lsp_bin.join(format!("{}.exe", binary_name));
        if exe_path.exists() && exe_path.is_file() {
            return Some(exe_path);
        }
    }

    None
}

/// Ensure an LSP server binary is available, installing it if necessary.
///
/// Returns the path to the binary on success.
pub async fn ensure_binary(
    method: &InstallMethod,
    binary_name: &str,
) -> Result<PathBuf, InstallError> {
    // Check if binary already exists
    if let Some(path) = find_binary(binary_name) {
        return Ok(path);
    }

    // Check if auto-install is enabled
    if !is_install_enabled_sync() {
        return Err(InstallError::Disabled);
    }

    // Install based on method
    match method {
        InstallMethod::Npm { package } => install_via_npm(package, binary_name).await,
        InstallMethod::Go { module } => install_via_go(module, binary_name).await,
        InstallMethod::Dotnet { tool } => install_via_dotnet(tool, binary_name).await,
        InstallMethod::Pip { package } => install_via_pip(package, binary_name).await,
        InstallMethod::Cargo { crate_name } => install_via_cargo(crate_name, binary_name).await,
        InstallMethod::GithubRelease {
            repo,
            binary_name: release_binary,
            asset_pattern,
        } => install_from_github(repo, release_binary, asset_pattern).await,
        InstallMethod::RequirePath => {
            Err(InstallError::ManualInstallRequired(binary_name.to_string()))
        }
    }
}

/// Install a package via npm/pnpm/yarn/bun.
async fn install_via_npm(package: &str, binary_name: &str) -> Result<PathBuf, InstallError> {
    let pm = detect_package_manager("npm")
        .ok_or_else(|| InstallError::PackageManagerNotFound("npm/pnpm/yarn/bun".to_string()))?;

    let mut args = pm
        .install_args
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    args.push(package.to_string());

    run_install_command(pm.command, &args, binary_name).await
}

/// Install a package via `go install`.
async fn install_via_go(module: &str, binary_name: &str) -> Result<PathBuf, InstallError> {
    if !command_exists("go") {
        return Err(InstallError::PackageManagerNotFound("go".to_string()));
    }

    run_install_command(
        "go",
        &["install".to_string(), module.to_string()],
        binary_name,
    )
    .await
}

/// Install a tool via `dotnet tool install`.
async fn install_via_dotnet(tool: &str, binary_name: &str) -> Result<PathBuf, InstallError> {
    if !command_exists("dotnet") {
        return Err(InstallError::PackageManagerNotFound("dotnet".to_string()));
    }

    run_install_command(
        "dotnet",
        &[
            "tool".to_string(),
            "install".to_string(),
            "-g".to_string(),
            tool.to_string(),
        ],
        binary_name,
    )
    .await
}

/// Install a package via pip/pip3.
async fn install_via_pip(package: &str, binary_name: &str) -> Result<PathBuf, InstallError> {
    let pm = detect_package_manager("pip")
        .ok_or_else(|| InstallError::PackageManagerNotFound("pip/pip3".to_string()))?;

    let mut args = pm
        .install_args
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    args.push(package.to_string());

    run_install_command(pm.command, &args, binary_name).await
}

/// Install a crate via `cargo install`.
async fn install_via_cargo(crate_name: &str, binary_name: &str) -> Result<PathBuf, InstallError> {
    if !command_exists("cargo") {
        return Err(InstallError::PackageManagerNotFound("cargo".to_string()));
    }

    run_install_command(
        "cargo",
        &["install".to_string(), crate_name.to_string()],
        binary_name,
    )
    .await
}

/// Run an install command and verify the binary exists afterward.
async fn run_install_command(
    command: &str,
    args: &[String],
    binary_name: &str,
) -> Result<PathBuf, InstallError> {
    tracing::info!("[lsp/auto_install] Running: {} {}", command, args.join(" "));

    let mut cmd = Command::new(command);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Suppress console window on Windows.
    #[cfg(windows)]
    cmd.creation_flags(app_platform::CREATE_NO_WINDOW);
    let output = cmd
        .spawn()
        .map_err(|e| InstallError::Other(format!("Failed to spawn {}: {}", command, e)))?
        .wait_with_output()
        .await
        .map_err(|e| InstallError::Other(format!("Failed to wait for {}: {}", command, e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(InstallError::InstallFailed {
            command: format!("{} {}", command, args.join(" ")),
            stderr,
        });
    }

    // Verify the binary now exists
    find_binary(binary_name).ok_or_else(|| InstallError::BinaryNotFound(binary_name.to_string()))
}

/// Install from GitHub releases.
///
/// Downloads the appropriate release asset for the current platform.
async fn install_from_github(
    repo: &str,
    binary_name: &str,
    asset_pattern: &(dyn Fn(&str, &str) -> String + Send + Sync),
) -> Result<PathBuf, InstallError> {
    // Determine current platform triple
    let target_triple = get_target_triple();

    // Get the latest release tag from GitHub
    let release_url = format!("https://api.github.com/repos/{}/releases/latest", repo);

    let client = reqwest::Client::builder()
        .user_agent("orgii-lsp-installer/1.0")
        .build()
        .map_err(|e| InstallError::DownloadFailed(e.to_string()))?;

    let release: serde_json::Value = client
        .get(&release_url)
        .send()
        .await
        .map_err(|e| InstallError::DownloadFailed(e.to_string()))?
        .json()
        .await
        .map_err(|e| InstallError::DownloadFailed(e.to_string()))?;

    let tag = release["tag_name"]
        .as_str()
        .ok_or_else(|| InstallError::DownloadFailed("No tag_name in release".to_string()))?;

    // Generate the asset filename for this platform
    let asset_name = asset_pattern(tag, &target_triple);

    // Find the download URL for this asset
    let assets = release["assets"]
        .as_array()
        .ok_or_else(|| InstallError::DownloadFailed("No assets in release".to_string()))?;

    let download_url = assets
        .iter()
        .find_map(|asset| {
            let name = asset["name"].as_str()?;
            if name == asset_name || name.contains(&asset_name) {
                asset["browser_download_url"]
                    .as_str()
                    .map(|s| s.to_string())
            } else {
                None
            }
        })
        .ok_or_else(|| {
            InstallError::DownloadFailed(format!(
                "No matching asset found for pattern '{}' in release {}",
                asset_name, tag
            ))
        })?;

    // Download the asset
    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| InstallError::DownloadFailed(e.to_string()))?;

    let bytes = response
        .bytes()
        .await
        .map_err(|e| InstallError::DownloadFailed(e.to_string()))?;

    // Ensure the LSP bin directory exists
    let bin_dir = lsp_bin_dir();
    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| InstallError::Other(format!("Failed to create lsp-bin dir: {}", e)))?;

    // Determine the binary path
    let binary_path = if cfg!(target_os = "windows") {
        bin_dir.join(format!("{}.exe", binary_name))
    } else {
        bin_dir.join(binary_name)
    };

    // Handle different archive formats
    if asset_name.ends_with(".zip") {
        extract_zip(&bytes, &bin_dir, binary_name)?;
    } else if asset_name.ends_with(".tar.gz") || asset_name.ends_with(".tgz") {
        extract_tar_gz(&bytes, &bin_dir, binary_name)?;
    } else if asset_name.ends_with(".tar.xz") {
        extract_tar_xz(&bytes, &bin_dir, binary_name)?;
    } else {
        // Assume it's a raw binary
        std::fs::write(&binary_path, &bytes)
            .map_err(|e| InstallError::Other(format!("Failed to write binary: {}", e)))?;
    }

    // Make the binary executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| InstallError::Other(format!("Failed to set permissions: {}", e)))?;
    }

    // Verify
    find_binary(binary_name).ok_or_else(|| InstallError::BinaryNotFound(binary_name.to_string()))
}

/// Get the current platform's target triple.
fn get_target_triple() -> String {
    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "arm") {
        "arm"
    } else {
        "unknown"
    };

    let os = if cfg!(target_os = "windows") {
        "pc-windows-msvc"
    } else if cfg!(target_os = "macos") {
        "apple-darwin"
    } else if cfg!(target_os = "linux") {
        "unknown-linux-gnu"
    } else {
        "unknown"
    };

    format!("{}-{}", arch, os)
}

/// Extract a zip archive, finding the binary inside.
fn extract_zip(data: &[u8], dest_dir: &Path, binary_name: &str) -> Result<(), InstallError> {
    use std::io::{Cursor, Read};

    let cursor = Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| InstallError::DownloadFailed(format!("Failed to open zip: {}", e)))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| {
            InstallError::DownloadFailed(format!("Failed to read zip entry: {}", e))
        })?;

        let name = file.name().to_string();

        // Look for the binary (might be in a subdirectory)
        if name.ends_with(binary_name) || name.ends_with(&format!("{}.exe", binary_name)) {
            let out_path = if cfg!(target_os = "windows") {
                dest_dir.join(format!("{}.exe", binary_name))
            } else {
                dest_dir.join(binary_name)
            };

            let mut contents = Vec::new();
            file.read_to_end(&mut contents)
                .map_err(|e| InstallError::Other(format!("Failed to read zip content: {}", e)))?;

            std::fs::write(&out_path, &contents)
                .map_err(|e| InstallError::Other(format!("Failed to write binary: {}", e)))?;

            return Ok(());
        }
    }

    Err(InstallError::DownloadFailed(format!(
        "Binary '{}' not found in zip archive",
        binary_name
    )))
}

/// Extract a tar.gz archive, finding the binary inside.
fn extract_tar_gz(data: &[u8], dest_dir: &Path, binary_name: &str) -> Result<(), InstallError> {
    use flate2::read::GzDecoder;
    use std::io::Cursor;
    use tar::Archive;

    let cursor = Cursor::new(data);
    let decoder = GzDecoder::new(cursor);
    let mut archive = Archive::new(decoder);

    for entry in archive
        .entries()
        .map_err(|e| InstallError::DownloadFailed(format!("Failed to read tar.gz: {}", e)))?
    {
        let mut entry = entry.map_err(|e| {
            InstallError::DownloadFailed(format!("Failed to read tar entry: {}", e))
        })?;

        let path = entry.path().map_err(|e| {
            InstallError::DownloadFailed(format!("Failed to get entry path: {}", e))
        })?;

        let name = path.to_string_lossy();

        // Look for the binary
        if name.ends_with(binary_name) {
            let out_path = dest_dir.join(binary_name);
            entry
                .unpack(&out_path)
                .map_err(|e| InstallError::Other(format!("Failed to unpack binary: {}", e)))?;
            return Ok(());
        }
    }

    Err(InstallError::DownloadFailed(format!(
        "Binary '{}' not found in tar.gz archive",
        binary_name
    )))
}

/// Extract a tar.xz archive, finding the binary inside.
fn extract_tar_xz(data: &[u8], dest_dir: &Path, binary_name: &str) -> Result<(), InstallError> {
    use std::io::{Cursor, Read};
    use tar::Archive;
    use xz2::read::XzDecoder;

    let cursor = Cursor::new(data);
    let decoder = XzDecoder::new(cursor);
    let mut archive = Archive::new(decoder);

    for entry in archive
        .entries()
        .map_err(|e| InstallError::DownloadFailed(format!("Failed to read tar.xz: {}", e)))?
    {
        let mut entry = entry.map_err(|e| {
            InstallError::DownloadFailed(format!("Failed to read tar entry: {}", e))
        })?;

        let path = entry.path().map_err(|e| {
            InstallError::DownloadFailed(format!("Failed to get entry path: {}", e))
        })?;

        let name = path.to_string_lossy();

        // Look for the binary
        if name.ends_with(binary_name) {
            let out_path = dest_dir.join(binary_name);
            let mut contents = Vec::new();
            entry
                .read_to_end(&mut contents)
                .map_err(|e| InstallError::Other(format!("Failed to read tar content: {}", e)))?;
            std::fs::write(&out_path, &contents)
                .map_err(|e| InstallError::Other(format!("Failed to write binary: {}", e)))?;
            return Ok(());
        }
    }

    Err(InstallError::DownloadFailed(format!(
        "Binary '{}' not found in tar.xz archive",
        binary_name
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn test_is_install_enabled_default() {
        let _lock = ENV_MUTEX.lock().unwrap();
        std::env::remove_var("ORGII_LSP_INSTALL");
        std::env::remove_var("ORGII_LSP_AUTO_INSTALL");
        assert!(is_install_enabled_sync());
    }

    #[test]
    fn test_is_install_disabled_via_new_var() {
        let _lock = ENV_MUTEX.lock().unwrap();
        std::env::remove_var("ORGII_LSP_AUTO_INSTALL");
        std::env::set_var("ORGII_LSP_INSTALL", "false");
        assert!(!is_install_enabled_sync());
        std::env::remove_var("ORGII_LSP_INSTALL");
    }

    #[test]
    fn test_is_install_disabled_via_old_var() {
        let _lock = ENV_MUTEX.lock().unwrap();
        std::env::remove_var("ORGII_LSP_INSTALL");
        std::env::set_var("ORGII_LSP_AUTO_INSTALL", "false");
        assert!(!is_install_enabled_sync());
        std::env::remove_var("ORGII_LSP_AUTO_INSTALL");
    }

    #[test]
    fn test_is_install_disabled_various_values() {
        let _lock = ENV_MUTEX.lock().unwrap();
        std::env::remove_var("ORGII_LSP_AUTO_INSTALL");
        for value in &["false", "0", "no", "off", "FALSE", "NO", "OFF"] {
            std::env::set_var("ORGII_LSP_INSTALL", value);
            assert!(
                !is_install_enabled_sync(),
                "Expected disabled for value '{}'",
                value
            );
        }
        std::env::remove_var("ORGII_LSP_INSTALL");
    }

    #[test]
    fn test_is_install_enabled_explicit() {
        let _lock = ENV_MUTEX.lock().unwrap();
        std::env::remove_var("ORGII_LSP_AUTO_INSTALL");
        for value in &["true", "1", "yes", "on", "TRUE"] {
            std::env::set_var("ORGII_LSP_INSTALL", value);
            assert!(
                is_install_enabled_sync(),
                "Expected enabled for value '{}'",
                value
            );
        }
        std::env::remove_var("ORGII_LSP_INSTALL");
    }

    #[test]
    fn test_get_target_triple() {
        let triple = get_target_triple();
        assert!(!triple.is_empty());
        // Should contain an arch
        assert!(
            triple.contains("x86_64")
                || triple.contains("aarch64")
                || triple.contains("arm")
                || triple.contains("unknown")
        );
    }

    #[test]
    fn test_find_binary_on_path() {
        // This test assumes `ls` or `cmd` exists on the system
        #[cfg(unix)]
        {
            let result = find_binary("ls");
            assert!(result.is_some());
        }
        #[cfg(windows)]
        {
            let result = find_binary("cmd");
            assert!(result.is_some());
        }
    }

    #[test]
    fn test_find_binary_not_found() {
        let result = find_binary("nonexistent-binary-xyz-12345");
        assert!(result.is_none());
    }

    #[test]
    fn test_install_method_display() {
        let npm = InstallMethod::Npm {
            package: "typescript",
        };
        let go = InstallMethod::Go {
            module: "golang.org/x/tools/gopls@latest",
        };
        let require = InstallMethod::RequirePath;

        // Just verify they don't panic
        let _ = format!("{:?}", npm);
        let _ = format!("{:?}", go);
        let _ = format!("{:?}", require);
    }

    #[test]
    fn test_install_error_display() {
        let disabled = InstallError::Disabled;
        let not_found = InstallError::PackageManagerNotFound("npm".to_string());
        let manual = InstallError::ManualInstallRequired("rust-analyzer".to_string());

        // Verify Display trait works
        assert!(disabled.to_string().contains("disabled"));
        assert!(not_found.to_string().contains("npm"));
        assert!(manual.to_string().contains("rust-analyzer"));
    }
}

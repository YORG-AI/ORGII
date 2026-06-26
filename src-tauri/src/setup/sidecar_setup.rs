//! Optional sidecar installation for browser and desktop automation.
//!
//! Sidecars are installed lazily into `~/.orgii/bin/` after explicit user or
//! feature request. Startup must not download sidecars, because slow GitHub
//! access can keep first paint behind the splash screen on restricted networks.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tracing::info;

const AGENT_BROWSER_VERSION: &str = "v0.27.2";
const PEEKABOO_VERSION: &str = "v3.2.3";
const PLACEHOLDER_MARKER: &[u8] = b"ORGII_GENERATED_OPTIONAL_SIDECAR_PLACEHOLDER";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OptionalSidecar {
    AgentBrowser,
    Peekaboo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    pub sidecar: OptionalSidecar,
    pub installed: bool,
    pub supported: bool,
    pub path: Option<String>,
}

#[tauri::command]
pub async fn sidecar_list_status() -> Result<Vec<SidecarStatus>, String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let bin_dir = app_paths::sidecar_bin_dir();

    Ok(vec![
        sidecar_status(OptionalSidecar::AgentBrowser, &bin_dir, os, arch),
        sidecar_status(OptionalSidecar::Peekaboo, &bin_dir, os, arch),
    ])
}

#[tauri::command]
pub async fn sidecar_install(sidecar: OptionalSidecar) -> Result<SidecarStatus, String> {
    let bin_dir = app_paths::sidecar_bin_dir();
    tokio::fs::create_dir_all(&bin_dir)
        .await
        .map_err(|err| format!("failed to create sidecar bin dir: {err}"))?;

    let client = build_client()?;
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    match sidecar {
        OptionalSidecar::AgentBrowser => install_agent_browser(&client, &bin_dir, os, arch).await?,
        OptionalSidecar::Peekaboo => install_peekaboo(&client, &bin_dir, os, arch).await?,
    }

    Ok(sidecar_status(sidecar, &bin_dir, os, arch))
}

fn sidecar_status(sidecar: OptionalSidecar, bin_dir: &Path, os: &str, arch: &str) -> SidecarStatus {
    let candidate = match sidecar {
        OptionalSidecar::AgentBrowser => agent_browser_target(os, arch)
            .ok()
            .map(|(_, dest_name)| bin_dir.join(dest_name)),
        OptionalSidecar::Peekaboo => peekaboo_supported(os).then(|| bin_dir.join("peekaboo")),
    };

    let installed_path = candidate
        .as_ref()
        .filter(|path| is_real_binary(path))
        .map(|path| path.display().to_string());

    SidecarStatus {
        sidecar,
        installed: installed_path.is_some(),
        supported: candidate.is_some(),
        path: installed_path,
    }
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("orgii-sidecar-setup/1.0")
        .timeout(std::time::Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|err| format!("failed to build HTTP client: {err}"))
}

async fn install_agent_browser(
    client: &reqwest::Client,
    bin_dir: &Path,
    os: &str,
    arch: &str,
) -> Result<(), String> {
    let (asset, dest_name) = agent_browser_target(os, arch)?;
    let dest = bin_dir.join(&dest_name);

    if is_real_binary(&dest) {
        info!("[sidecar_setup] agent-browser already present");
        return Ok(());
    }

    let url = format!(
        "https://github.com/vercel-labs/agent-browser/releases/download/{AGENT_BROWSER_VERSION}/{asset}"
    );
    download_to(client, &url, &dest).await?;
    set_executable(&dest)?;
    info!(
        "[sidecar_setup] installed agent-browser → {}",
        dest.display()
    );
    Ok(())
}

fn agent_browser_target(os: &str, arch: &str) -> Result<(String, String), String> {
    let pair = match (os, arch) {
        ("macos", "aarch64") => (
            "agent-browser-darwin-arm64",
            "agent-browser-aarch64-apple-darwin",
        ),
        ("macos", "x86_64") => (
            "agent-browser-darwin-x64",
            "agent-browser-x86_64-apple-darwin",
        ),
        ("linux", "x86_64") => (
            "agent-browser-linux-x64",
            "agent-browser-x86_64-unknown-linux-gnu",
        ),
        ("windows", "x86_64") => (
            "agent-browser-win32-x64.exe",
            "agent-browser-x86_64-pc-windows-msvc.exe",
        ),
        _ => return Err(format!("agent-browser: unsupported platform {os}/{arch}")),
    };
    Ok((pair.0.to_string(), pair.1.to_string()))
}

async fn install_peekaboo(
    client: &reqwest::Client,
    bin_dir: &Path,
    os: &str,
    _arch: &str,
) -> Result<(), String> {
    if !peekaboo_supported(os) {
        return Err(format!("peekaboo: unsupported platform {os}"));
    }

    let dest = bin_dir.join("peekaboo");
    let dest_aarch64 = bin_dir.join("peekaboo-aarch64-apple-darwin");
    let dest_x86 = bin_dir.join("peekaboo-x86_64-apple-darwin");

    if is_real_binary(&dest) && is_real_binary(&dest_aarch64) {
        info!("[sidecar_setup] peekaboo already present");
        return Ok(());
    }

    let url = format!(
        "https://github.com/steipete/peekaboo/releases/download/{PEEKABOO_VERSION}/peekaboo-macos-universal.tar.gz"
    );

    let tmp_dir = temp_dir_in(bin_dir, "peekaboo")?;
    let archive = tmp_dir.join("peekaboo-macos-universal.tar.gz");
    download_to(client, &url, &archive).await?;

    run_tar_extract(&archive, &tmp_dir)?;

    let binary = find_file_named(&tmp_dir, "peekaboo")
        .ok_or_else(|| "peekaboo binary not found in archive".to_string())?;

    let bytes = tokio::fs::read(&binary)
        .await
        .map_err(|err| format!("read extracted peekaboo: {err}"))?;

    for dest_path in [&dest, &dest_aarch64, &dest_x86] {
        tokio::fs::write(dest_path, &bytes)
            .await
            .map_err(|err| format!("write {}: {err}", dest_path.display()))?;
        set_executable(dest_path)?;
    }

    tokio::fs::write(
        bin_dir.join("peekaboo-VERSION"),
        format!("{PEEKABOO_VERSION}\n"),
    )
    .await
    .map_err(|err| format!("write peekaboo-VERSION: {err}"))?;

    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;

    info!("[sidecar_setup] installed peekaboo → {}", dest.display());
    Ok(())
}

fn peekaboo_supported(os: &str) -> bool {
    os == "macos"
}

const CHUNK_STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

async fn download_to(client: &reqwest::Client, url: &str, dest: &Path) -> Result<(), String> {
    info!("[sidecar_setup] downloading {url}");

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|err| format!("mkdir {}: {err}", parent.display()))?;
    }

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|err| format!("GET {url}: {err}"))?
        .error_for_status()
        .map_err(|err| format!("GET {url} HTTP error: {err}"))?;

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|err| format!("create {}: {err}", dest.display()))?;

    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    loop {
        match tokio::time::timeout(CHUNK_STALL_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                file.write_all(&chunk)
                    .await
                    .map_err(|err| format!("write {}: {err}", dest.display()))?;
            }
            Ok(Some(Err(err))) => {
                return Err(format!("reading body {url}: {err}"));
            }
            Ok(None) => break,
            Err(_) => {
                return Err(format!(
                    "download stalled (no data for {}s): {url}",
                    CHUNK_STALL_TIMEOUT.as_secs()
                ));
            }
        }
    }

    file.flush()
        .await
        .map_err(|err| format!("flush {}: {err}", dest.display()))?;

    Ok(())
}

fn run_tar_extract(archive: &Path, dest_dir: &Path) -> Result<(), String> {
    let mut command = std::process::Command::new("tar");
    command.arg("-xzf").arg(archive).arg("-C").arg(dest_dir);
    app_platform::hide_console(&mut command);
    let status = command
        .status()
        .map_err(|err| format!("tar failed to start: {err}"))?;

    if !status.success() {
        return Err(format!(
            "tar -xzf {} -C {} exited with {}",
            archive.display(),
            dest_dir.display(),
            status
        ));
    }
    Ok(())
}

fn temp_dir_in(parent: &Path, prefix: &str) -> Result<PathBuf, String> {
    let tmp = parent.join(format!(".tmp-{prefix}-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|err| format!("mkdir tmp {}: {err}", tmp.display()))?;
    Ok(tmp)
}

fn find_file_named(dir: &Path, name: &str) -> Option<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file_named(&path, name) {
                return Some(found);
            }
        } else if path.file_name().and_then(|name| name.to_str()) == Some(name) {
            return Some(path);
        }
    }
    None
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let meta =
        std::fs::metadata(path).map_err(|err| format!("metadata {}: {err}", path.display()))?;
    let mut perms = meta.permissions();
    perms.set_mode(perms.mode() | 0o755);
    std::fs::set_permissions(path, perms)
        .map_err(|err| format!("chmod {}: {err}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn is_real_binary(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    !is_placeholder_bytes(&std::fs::read(path).unwrap_or_default())
}

fn is_placeholder_bytes(bytes: &[u8]) -> bool {
    bytes.starts_with(PLACEHOLDER_MARKER)
}

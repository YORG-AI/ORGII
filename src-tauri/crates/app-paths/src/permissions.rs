//! Owner-only hardening for sensitive files (keys, OAuth tokens): `chmod`
//! on Unix, a best-effort `icacls` grant on Windows.

use std::path::Path;

#[cfg(windows)]
use std::process::Stdio;

/// Restrict a sensitive file (keys, OAuth tokens) to owner-only access.
///
/// Unix: `chmod 0o600`.
/// Windows: `icacls /inheritance:r /grant:r "<domain>\\<user>:F"` (best-effort;
/// logs a warning if `icacls` is unavailable rather than failing the parent op).
pub fn set_sensitive_file_permissions(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }

    #[cfg(windows)]
    {
        if let Some(path_str) = path.to_str() {
            if let Some(account) = current_windows_account_for_acl() {
                let mut cmd = std::process::Command::new("icacls");
                cmd.args([
                    path_str,
                    "/inheritance:r",
                    "/grant:r",
                    &format!("{}:F", account),
                ]);
                // Suppress console window on Windows.
                app_platform::hide_console(&mut cmd);
                let result = cmd.output();

                match result {
                    Ok(output) if !output.status.success() => {
                        tracing::warn!(
                            "[permissions] Failed to set permissions on {}: {}",
                            path_str,
                            String::from_utf8_lossy(&output.stderr)
                        );
                    }
                    Err(err) => {
                        tracing::warn!(
                            "[permissions] icacls not available, file {} may be world-readable: {}",
                            path_str,
                            err
                        );
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(())
}

#[cfg(windows)]
fn current_windows_account_for_acl() -> Option<String> {
    let mut cmd = std::process::Command::new("whoami");
    cmd.stdin(Stdio::null()).stderr(Stdio::null());
    // Suppress console window on Windows.
    app_platform::hide_console(&mut cmd);
    let whoami = cmd.output().ok().and_then(|output| {
        if output.status.success() {
            String::from_utf8(output.stdout)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        } else {
            None
        }
    });
    if whoami.is_some() {
        return whoami;
    }

    let username = std::env::var("USERNAME").ok()?.trim().to_string();
    if username.is_empty() {
        return None;
    }
    if username.contains('\\') {
        return Some(username);
    }

    let domain = std::env::var("USERDOMAIN").unwrap_or_default();
    let domain = domain.trim();
    if domain.is_empty() {
        Some(username)
    } else {
        Some(format!("{}\\{}", domain, username))
    }
}

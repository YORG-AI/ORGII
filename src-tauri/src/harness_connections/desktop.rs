//! Read-only Desktop installation and applied-profile metadata. Never launch the app.
use key_vault::harness_connections::{ConnectionAuthScheme, DesktopConnectionOptions};

pub(super) async fn installation() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(|| {
            let home = app_paths::external_history_home_dir();
            let candidates = [
                home.join("Applications/Claude.app/Contents/Info.plist"),
                std::path::PathBuf::from("/Applications/Claude.app/Contents/Info.plist"),
            ];
            for path in candidates {
                if !path.exists() {
                    continue;
                }
                let value = plist::Value::from_file(path)
                    .map_err(|_| "Cannot read Claude Desktop version")?;
                return value
                    .as_dictionary()
                    .and_then(|value| value.get("CFBundleShortVersionString"))
                    .and_then(plist::Value::as_string)
                    .map(|value| Some(value.to_string()))
                    .ok_or_else(|| "Cannot read Claude Desktop version".into());
            }
            Ok(None)
        })
        .await
        .map_err(|_| "Desktop installation lookup failed")?
    }
    #[cfg(windows)]
    {
        let path = app_paths::external_history_data_local_dir().join("Claude/Claude.exe");
        if !path.is_file() {
            return Ok(None);
        }
        let mut command = tokio::process::Command::new("powershell.exe");
        command
            .kill_on_drop(true)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-Item -LiteralPath $env:ORGII_DESKTOP_EXECUTABLE).VersionInfo.ProductVersion",
            ])
            .env("ORGII_DESKTOP_EXECUTABLE", path);
        let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
            .await
            .map_err(|_| "Desktop version lookup timed out")?
            .map_err(|_| "Cannot read Claude Desktop version")?;
        if !output.status.success() {
            return Err("Cannot read Claude Desktop version".into());
        }
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
        ))
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    Ok(None)
}

pub(super) fn validate_version(version: &str) -> Result<(), String> {
    let numbers = version
        .split('.')
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot verify this Claude Desktop version")?;
    if numbers.len() != 3 || numbers.as_slice() < [1, 46388, 1].as_slice() {
        return Err(
            "Update Claude Desktop to 1.46388.1 or newer for this configuration format".into(),
        );
    }
    Ok(())
}

pub(super) fn applied_options(
    config: &agent_cli::managed_config::CliConfigManagedStatus,
) -> Result<Option<DesktopConnectionOptions>, String> {
    if config.mode != agent_cli::managed_config::CliConfigMode::Direct {
        return Ok(None);
    }
    let path = config
        .target_files
        .iter()
        .find(|file| file.id == "profile")
        .ok_or("Desktop profile is missing")?;
    let raw =
        std::fs::read(&path.target_path).map_err(|_| "Cannot read the applied Desktop profile")?;
    let value: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|_| "Invalid applied Desktop profile")?;
    let endpoint = value["inferenceGatewayBaseUrl"]
        .as_str()
        .ok_or("Desktop profile endpoint is missing")?;
    let url = reqwest::Url::parse(endpoint).map_err(|_| "Invalid Desktop endpoint")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Desktop profile endpoint contains unsupported credentials or URL parameters".into(),
        );
    }
    let auth_scheme = match value["inferenceGatewayAuthScheme"].as_str() {
        Some("bearer") => ConnectionAuthScheme::Bearer,
        Some("x-api-key") => ConnectionAuthScheme::ApiKey,
        _ => return Err("Unsupported authentication in the applied Desktop profile".into()),
    };
    Ok(Some(DesktopConnectionOptions {
        endpoint: Some(endpoint.into()),
        auth_scheme: Some(auth_scheme),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_verified_schema_versions_and_direct_model_ids_are_accepted() {
        for version in ["1.46388.1", "1.46388.4"] {
            validate_version(version).unwrap();
        }
        for version in ["1.0.0", "1.46388", "1.46388.1-beta"] {
            assert!(validate_version(version).is_err());
        }
        for model in [
            "claude-sonnet-5",
            "anthropic/claude-opus-5",
            "claude-haiku-4-5",
        ] {
            agent_cli::managed_config::desktop::validate_model(model).unwrap();
        }
        for model in [
            "sonnet",
            "custom-model",
            "claude-opus-",
            "claude-opus-5[1m]",
        ] {
            assert!(agent_cli::managed_config::desktop::validate_model(model).is_err());
        }
    }
}

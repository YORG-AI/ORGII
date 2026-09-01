//! Codex app-server process lifecycle: temporary CODEX_HOME plus stdio RPC calls.

use super::id_token::extract_account_id_from_id_token;
use super::json_rpc::{wait_for_rpc_id, write_json_rpc_notification, write_json_rpc_request};
use super::model_discovery::{discovered_models_from_app_server, CodexModelListResponse};
use super::process_tree::terminate_codex_app_server_tree;
use super::quota::{quota_from_codex_rate_limits_response, CodexRateLimitsResponse};
use crate::types::{DiscoveredModel, QuotaInfo};
use integrations::cli_binary_resolver::{resolve_cli_binary_command, CliBinaryId};
use serde::de::DeserializeOwned;
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const APP_SERVER_TIMEOUT_SECS: u64 = 10;
pub(super) const APP_SERVER_SHUTDOWN_TIMEOUT_SECS: u64 = 2;

pub(super) async fn write_temporary_codex_home(
    access_token: &str,
    refresh_token: Option<&str>,
    id_token: Option<&str>,
) -> Result<PathBuf, String> {
    let codex_home =
        std::env::temp_dir().join(format!("orgii-codex-app-server-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&codex_home)
        .await
        .map_err(|err| format!("Failed to create temporary Codex home: {err}"))?;

    let account_id = id_token.and_then(extract_account_id_from_id_token);
    let auth_json = serde_json::json!({
        "OPENAI_API_KEY": serde_json::Value::Null,
        "tokens": {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "id_token": id_token,
            "account_id": account_id,
        },
        "last_refresh": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
    });

    let auth_path = codex_home.join("auth.json");
    let auth_bytes = serde_json::to_vec_pretty(&auth_json)
        .map_err(|err| format!("Failed to serialize Codex auth file: {err}"))?;
    tokio::fs::write(&auth_path, auth_bytes)
        .await
        .map_err(|err| format!("Failed to write Codex auth file: {err}"))?;
    app_paths::set_sensitive_file_permissions(&auth_path)
        .map_err(|err| format!("Failed to secure Codex auth file: {err}"))?;

    Ok(codex_home)
}

pub(super) async fn cleanup_temporary_codex_home(codex_home: &PathBuf, operation: &str) {
    if let Err(err) = tokio::fs::remove_dir_all(codex_home).await {
        log::warn!(
            "[CodexAppServer] Failed to remove temporary Codex home after {} ({}): {}",
            operation,
            codex_home.display(),
            err
        );
    }
}

pub(super) async fn run_codex_rate_limits_rpc(codex_home: &PathBuf) -> Result<QuotaInfo, String> {
    let payload: CodexRateLimitsResponse = run_codex_app_server_rpc(
        codex_home,
        "account/rateLimits/read",
        serde_json::json!({}),
        "rate-limit request",
    )
    .await?;
    Ok(quota_from_codex_rate_limits_response(payload))
}

pub(super) async fn run_codex_model_list_rpc(
    codex_home: &PathBuf,
) -> Result<Vec<DiscoveredModel>, String> {
    let payload: CodexModelListResponse = run_codex_app_server_rpc(
        codex_home,
        "model/list",
        serde_json::json!({ "limit": 1000, "includeHidden": false }),
        "model-list request",
    )
    .await?;
    Ok(discovered_models_from_app_server(payload))
}

async fn run_codex_app_server_rpc<T: DeserializeOwned>(
    codex_home: &PathBuf,
    method: &str,
    params: serde_json::Value,
    operation: &str,
) -> Result<T, String> {
    let codex_binary = resolve_cli_binary_command(CliBinaryId::Codex);
    let mut child = Command::new(&codex_binary);
    child
        .args(["-s", "read-only", "-a", "untrusted", "app-server"])
        .env("CODEX_HOME", codex_home)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // npm's `codex` entry point launches the native binary as a descendant.
    // Isolate the wrapper tree so timeout cleanup cannot orphan the native
    // app-server with our stdout/stderr handles still open.
    #[cfg(unix)]
    child.process_group(0);

    #[cfg(windows)]
    child.creation_flags(app_platform::CREATE_NO_WINDOW);

    let mut child = child
        .spawn()
        .map_err(|err| format!("Failed to start Codex app-server via {codex_binary}: {err}"))?;
    let child_pid = child.id();

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex app-server stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout unavailable".to_string())?;
    let stderr = child.stderr.take();

    let stderr_task = stderr.map(|stream| {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stream).lines();
            let mut output = String::new();
            while let Ok(Some(line)) = reader.next_line().await {
                if output.len() < 20_000 {
                    output.push_str(&line);
                    output.push('\n');
                }
            }
            output
        })
    });

    let rpc = async {
        write_json_rpc_request(
            &mut stdin,
            1,
            "initialize",
            serde_json::json!({
                "clientInfo": { "name": "orgii", "version": "1.0.0" }
            }),
        )
        .await?;

        let mut reader = BufReader::new(stdout).lines();
        wait_for_rpc_id::<serde_json::Value>(&mut reader, 1).await?;

        write_json_rpc_notification(&mut stdin, "initialized", serde_json::json!({})).await?;
        write_json_rpc_request(&mut stdin, 2, method, params).await?;
        wait_for_rpc_id::<T>(&mut reader, 2).await
    };

    let mut result =
        match tokio::time::timeout(std::time::Duration::from_secs(APP_SERVER_TIMEOUT_SECS), rpc)
            .await
        {
            Ok(result) => result,
            Err(_) => Err(format!("Codex app-server {operation} timed out")),
        };

    drop(stdin);
    terminate_codex_app_server_tree(&mut child, child_pid, operation).await;

    if let Some(mut task) = stderr_task {
        match tokio::time::timeout(
            std::time::Duration::from_secs(APP_SERVER_SHUTDOWN_TIMEOUT_SECS),
            &mut task,
        )
        .await
        {
            Ok(Ok(stderr_output)) => {
                if let Err(ref error_message) = result {
                    if !stderr_output.trim().is_empty() {
                        result = Err(format!("{error_message}: {}", stderr_output.trim()));
                    }
                }
            }
            Ok(Err(err)) => log::debug!(
                "[CodexAppServer] stderr reader failed after {}: {}",
                operation,
                err
            ),
            Err(_) => {
                task.abort();
                log::warn!(
                    "[CodexAppServer] stderr pipe did not close after {}; reader aborted",
                    operation
                );
            }
        }
    }

    result
}

//! Line-delimited JSON-RPC framing for the Codex app-server stdio protocol.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncWriteExt, BufReader};

#[derive(Debug, Deserialize)]
struct JsonRpcResponse<T> {
    id: Option<u64>,
    result: Option<T>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    message: String,
}

#[derive(Debug, Serialize)]
struct JsonRpcRequest<'a, T> {
    jsonrpc: &'static str,
    id: u64,
    method: &'a str,
    params: T,
}

#[derive(Debug, Serialize)]
struct JsonRpcNotification<'a, T> {
    jsonrpc: &'static str,
    method: &'a str,
    params: T,
}

pub(super) async fn write_json_rpc_request<T: Serialize>(
    stdin: &mut tokio::process::ChildStdin,
    id: u64,
    method: &str,
    params: T,
) -> Result<(), String> {
    let request = JsonRpcRequest {
        jsonrpc: "2.0",
        id,
        method,
        params,
    };
    write_json_line(stdin, &request).await
}

pub(super) async fn write_json_rpc_notification<T: Serialize>(
    stdin: &mut tokio::process::ChildStdin,
    method: &str,
    params: T,
) -> Result<(), String> {
    let notification = JsonRpcNotification {
        jsonrpc: "2.0",
        method,
        params,
    };
    write_json_line(stdin, &notification).await
}

async fn write_json_line<T: Serialize>(
    stdin: &mut tokio::process::ChildStdin,
    value: &T,
) -> Result<(), String> {
    let mut line = serde_json::to_vec(value)
        .map_err(|err| format!("Failed to serialize Codex JSON-RPC message: {err}"))?;
    line.push(b'\n');
    stdin
        .write_all(&line)
        .await
        .map_err(|err| format!("Failed to write Codex JSON-RPC message: {err}"))
}

pub(super) async fn wait_for_rpc_id<T: for<'de> Deserialize<'de>>(
    reader: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    expected_id: u64,
) -> Result<T, String> {
    while let Some(line) = reader
        .next_line()
        .await
        .map_err(|err| format!("Failed to read Codex JSON-RPC output: {err}"))?
    {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<JsonRpcResponse<T>>(trimmed) {
            Ok(response) => response,
            Err(_) => continue,
        };
        if response.id != Some(expected_id) {
            continue;
        }
        if let Some(error) = response.error {
            return Err(format!("Codex app-server RPC failed: {}", error.message));
        }
        return response
            .result
            .ok_or_else(|| "Codex app-server RPC response omitted result".to_string());
    }

    Err("Codex app-server exited before returning the requested response".to_string())
}

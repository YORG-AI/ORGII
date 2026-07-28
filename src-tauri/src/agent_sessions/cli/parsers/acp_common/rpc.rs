//! JSON-RPC framing over the agent subprocess's stdin/stdout.

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};

use super::content::truncate_str_safe;

// ============================================
// JSON-RPC Helpers
// ============================================

pub(super) async fn acp_send(
    stdin: &mut ChildStdin,
    request_id: u64,
    method: &str,
    params: Value,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params,
    });
    let line = format!("{}\n", msg);
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|err| format!("ACP write error: {}", err))?;
    stdin
        .flush()
        .await
        .map_err(|err| format!("ACP flush error: {}", err))?;
    Ok(())
}

pub(super) async fn acp_respond(stdin: &mut ChildStdin, request_id: &Value, result: Value) {
    let msg = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": result,
    });
    let line = format!("{}\n", msg);
    let _ = stdin.write_all(line.as_bytes()).await;
    let _ = stdin.flush().await;
}

pub(super) async fn acp_read(
    reader: &mut BufReader<ChildStdout>,
    buf: &mut String,
) -> Result<Value, String> {
    loop {
        buf.clear();
        match reader.read_line(buf).await {
            Ok(0) => return Err("ACP: unexpected EOF".into()),
            Ok(_) => {
                let trimmed = buf.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let val: Value = serde_json::from_str(trimmed)
                    .map_err(|err| format!("ACP JSON parse error: {}", err))?;
                // Log JSON-RPC errors at warn level, others at debug
                if val.get("error").is_some() {
                    tracing::warn!("[ACP] ← {}", trimmed);
                } else if val.get("id").is_some() {
                    let preview = val
                        .get("result")
                        .map(|r| {
                            let s = r.to_string();
                            truncate_str_safe(&s, 200)
                        })
                        .unwrap_or_default();
                    tracing::debug!("[ACP] ← response id={} result={}", val["id"], preview);
                } else {
                    let preview = truncate_str_safe(trimmed, 300);
                    tracing::debug!("[ACP] ← notif: {}", preview);
                }
                return Ok(val);
            }
            Err(err) => return Err(format!("ACP read error: {}", err)),
        }
    }
}

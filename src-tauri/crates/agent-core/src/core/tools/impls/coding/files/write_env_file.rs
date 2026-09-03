//! `write_env_file` — privileged writer for `.env`-style files.
//!
//! The only tool today that may resolve `{{secret:<token>}}` placeholders
//! minted by `manage_secrets` to their plaintext form. The plaintext is
//! materialized into a `Zeroizing<String>` buffer, written to disk, and
//! immediately dropped (overwritten in memory by `zeroize`).
//!
//! # Why a dedicated tool (instead of `edit_file`)
//!
//! Every additional code path that touches plaintext secrets is a fresh
//! audit burden. By giving the broker exactly one consumer we keep the
//! plaintext blast radius to a single function whose path is fully
//! covered by the threat model in `interaction::secret_broker`.
//!
//! # Guardrails enforced here (independent of file-system permissions)
//!
//! * Path must resolve inside the session workspace (or an additional
//!   allowed dir). No tilde escapes, no `..` escapes — `resolve_path_with_extras`
//!   canonicalizes both sides and rejects on mismatch.
//! * Filename must look like a dotenv (basename starts with `.env` or ends
//!   with `.env` / `.env.local` / `.env.<stage>`). Refuses to write
//!   `secrets.txt` or `config.json` even if the agent asks — those routes
//!   should go through the regular `edit_file` flow with the user's eyes
//!   on it.
//! * On Unix the file is created with mode `0o600` (owner read/write only).
//! * Refuses to overwrite a file that is currently tracked by git unless
//!   the caller passes `acknowledge_tracked: true`. The default ADE flow
//!   creates a new `.env` (which is git-ignored), so the tracked check
//!   protects against accidental clobbers when the agent grabs the wrong
//!   path.

use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::foundation::tool_infra::file::resolve_path_with_extras;
use crate::interaction::secret_broker::{Resolve, SecretBroker};
use crate::tools::names as tool_names;
use crate::tools::traits::{Tool, ToolError};

use super::{allowed_roots, WorkspaceStateHandle};

use zeroize::Zeroizing;

/// Maximum allowed body size — bigger than any legitimate `.env` file but
/// small enough that an accidental binary blob doesn't ride through.
const MAX_BODY_BYTES: usize = 256 * 1024;

pub struct WriteEnvFileTool {
    workspace_state: Option<WorkspaceStateHandle>,
    scratchpad_dir: Option<PathBuf>,
    broker: Arc<SecretBroker>,
}

impl WriteEnvFileTool {
    pub fn new(
        workspace_state: Option<WorkspaceStateHandle>,
        scratchpad_dir: Option<PathBuf>,
        broker: Arc<SecretBroker>,
    ) -> Self {
        Self {
            workspace_state,
            scratchpad_dir,
            broker,
        }
    }

    fn allowed_dir(&self) -> Option<PathBuf> {
        self.workspace_state
            .as_ref()
            .map(|ws| ws.read().working_dir().to_path_buf())
    }
}

#[async_trait]
impl Tool for WriteEnvFileTool {
    fn name(&self) -> &str {
        tool_names::WRITE_ENV_FILE
    }

    fn description(&self) -> &str {
        "Write a `.env`-style file to disk, resolving any `{{secret:<token>}}` \
         placeholders that were minted by `manage_secrets` to their plaintext \
         form at write time. The plaintext never enters the LLM transcript or \
         the chat history.\n\n\
         Use this — not `edit_file` — whenever the file content contains a \
         secret placeholder. Refuses to write non-dotenv filenames, refuses \
         to overwrite git-tracked files (pass `acknowledge_tracked: true` to \
         override), and sets `0o600` on Unix."
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "required": ["path", "content"],
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative or absolute path to the `.env` file. Must resolve inside the session workspace and have a `.env`-style filename."
                },
                "content": {
                    "type": "string",
                    "description": "File body. May contain any number of `{{secret:<token>}}` placeholders from previous `manage_secrets` calls; each is resolved to the captured plaintext at write time."
                },
                "consume_tokens": {
                    "type": "boolean",
                    "description": "If true, each resolved secret is dropped from the broker after substitution. Default: true — `.env` writes are normally one-shot."
                },
                "acknowledge_tracked": {
                    "type": "boolean",
                    "description": "Set to true to allow overwriting a file that is currently tracked by git. Default: false."
                },
                "overwrite": {
                    "type": "boolean",
                    "description": "If false, refuse to write when the target already exists. Default: true."
                }
            }
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let path_str = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidParams("Missing 'path'".into()))?;
        let content = params
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidParams("Missing 'content'".into()))?;
        let consume_tokens = params
            .get("consume_tokens")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let acknowledge_tracked = params
            .get("acknowledge_tracked")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let overwrite = params
            .get("overwrite")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        if content.len() > MAX_BODY_BYTES {
            return Err(ToolError::InvalidParams(format!(
                "File body exceeds {MAX_BODY_BYTES}-byte cap"
            )));
        }

        let allowed_dir = self.allowed_dir();
        let static_dirs: Vec<PathBuf> = self.scratchpad_dir.iter().cloned().collect();
        let extras: Vec<PathBuf> = allowed_roots(&static_dirs, self.workspace_state.as_ref());
        let resolved = resolve_path_with_extras(path_str, allowed_dir.as_deref(), &extras)
            .map_err(ToolError::PermissionDenied)?;

        ensure_dotenv_basename(&resolved)?;

        if !overwrite && resolved.exists() {
            return Err(ToolError::InvalidParams(format!(
                "Target '{}' already exists and overwrite=false",
                resolved.display()
            )));
        }

        if !acknowledge_tracked && is_git_tracked(&resolved) {
            return Err(ToolError::PermissionDenied(format!(
                "Refusing to write '{}': the file is tracked by git. \
                 Pass acknowledge_tracked=true only if you are certain.",
                resolved.display()
            )));
        }

        let (resolved_body, used_tokens) = self.substitute_secrets(content).await?;

        // Materialize into a zeroizing buffer that gets wiped on drop.
        let body = Zeroizing::new(resolved_body);

        if let Some(parent) = resolved.parent() {
            std::fs::create_dir_all(parent).map_err(|err| {
                ToolError::ExecutionFailed(format!(
                    "Failed to create parent dirs for '{}': {err}",
                    resolved.display()
                ))
            })?;
        }

        write_file_secure(&resolved, body.as_bytes()).map_err(ToolError::ExecutionFailed)?;

        if consume_tokens {
            for token in &used_tokens {
                self.broker.discard(token).await;
            }
        }

        Ok(format!(
            "Wrote {} bytes to '{}' (resolved {} secret placeholder{}). \
             Plaintext was not echoed to the chat.",
            body.len(),
            resolved.display(),
            used_tokens.len(),
            if used_tokens.len() == 1 { "" } else { "s" },
        ))
    }
}

impl WriteEnvFileTool {
    /// Walk the body, replacing each `{{secret:<token>}}` with the captured
    /// plaintext. Returns the resolved body plus the set of tokens that
    /// were consumed (so the caller can discard them if requested).
    async fn substitute_secrets(&self, body: &str) -> Result<(String, Vec<String>), ToolError> {
        let mut out = String::with_capacity(body.len());
        let mut used: Vec<String> = Vec::new();
        let mut rest = body;

        while let Some(start) = rest.find("{{secret:") {
            out.push_str(&rest[..start]);
            let after_marker = &rest[start + "{{secret:".len()..];
            let end = after_marker.find("}}").ok_or_else(|| {
                ToolError::InvalidParams("Unterminated `{{secret:` placeholder in content".into())
            })?;
            let token = after_marker[..end].trim().to_string();
            match self.broker.resolve(&token).await {
                Resolve::Plaintext(pt) => {
                    out.push_str(pt.as_str());
                    if !used.contains(&token) {
                        used.push(token);
                    }
                }
                Resolve::Expired => {
                    return Err(ToolError::ExecutionFailed(format!(
                        "Secret token '{token}' has expired or was already consumed. \
                         Re-run `manage_secrets {{ action: \"request\" }}` to capture it again."
                    )));
                }
                Resolve::Unknown => {
                    return Err(ToolError::InvalidParams(format!(
                        "Token '{token}' is not a known secret placeholder."
                    )));
                }
            }
            rest = &after_marker[end + 2..];
        }
        out.push_str(rest);
        Ok((out, used))
    }
}

fn ensure_dotenv_basename(path: &Path) -> Result<(), ToolError> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| ToolError::InvalidParams("Path has no filename".into()))?;

    // Accept `.env`, `.env.local`, `.env.production`, `myservice.env`, etc.
    // Reject anything else so a misrouted call cannot write secrets into,
    // say, `README.md` or `config.json`.
    let lower = name.to_ascii_lowercase();
    let looks_like_dotenv = lower == ".env"
        || lower.starts_with(".env.")
        || lower.ends_with(".env")
        || lower.ends_with(".env.local")
        || lower.contains(".env.");
    if !looks_like_dotenv {
        return Err(ToolError::PermissionDenied(format!(
            "'{name}' is not a `.env`-style filename. `write_env_file` only writes \
             dotenv files; use `edit_file` for other targets."
        )));
    }
    Ok(())
}

fn is_git_tracked(path: &Path) -> bool {
    let parent = match path.parent() {
        Some(p) => p,
        None => return false,
    };
    let mut command = std::process::Command::new("git");
    command
        .arg("-C")
        .arg(parent)
        .arg("ls-files")
        .arg("--error-unmatch")
        .arg(path);
    // Suppress the console window this git check would flash on Windows.
    app_platform::hide_console(&mut command);
    let output = command.output();
    matches!(output, Ok(out) if out.status.success())
}

#[cfg(unix)]
fn write_file_secure(path: &Path, body: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|err| format!("Failed to open '{}': {err}", path.display()))?;
    file.write_all(body)
        .map_err(|err| format!("Failed to write '{}': {err}", path.display()))?;
    file.sync_all()
        .map_err(|err| format!("Failed to sync '{}': {err}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn write_file_secure(path: &Path, body: &[u8]) -> Result<(), String> {
    std::fs::write(path, body).map_err(|err| format!("Failed to write '{}': {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dotenv_basename_accepts_common_forms() {
        for ok in [
            ".env",
            ".env.local",
            ".env.production",
            "service.env",
            ".env.staging",
        ] {
            assert!(
                ensure_dotenv_basename(Path::new(ok)).is_ok(),
                "expected '{ok}' to be accepted"
            );
        }
    }

    #[test]
    fn dotenv_basename_rejects_other_files() {
        for bad in ["secrets.txt", "config.json", "README.md", "env"] {
            assert!(
                ensure_dotenv_basename(Path::new(bad)).is_err(),
                "expected '{bad}' to be rejected"
            );
        }
    }

    #[tokio::test]
    async fn substitute_resolves_then_consumes() {
        let broker = Arc::new(SecretBroker::new());
        let recv = broker
            .ask("s", "r", "OPENAI_API_KEY", "api_key", "prompt", None)
            .await;
        broker.submit("r", "sk-12345".into()).await;
        let token = match recv.await.unwrap() {
            crate::interaction::secret_broker::SecretCapture::Submitted { token } => token,
            _ => panic!(),
        };

        let tool = WriteEnvFileTool::new(None, None, Arc::clone(&broker));
        let body = format!("OPENAI_API_KEY={{{{secret:{token}}}}}\n");
        let (resolved, used) = tool.substitute_secrets(&body).await.unwrap();
        assert_eq!(resolved, "OPENAI_API_KEY=sk-12345\n");
        assert_eq!(used, vec![token]);
    }

    #[tokio::test]
    async fn substitute_rejects_unknown_token() {
        let broker = Arc::new(SecretBroker::new());
        let tool = WriteEnvFileTool::new(None, None, Arc::clone(&broker));
        let err = tool
            .substitute_secrets("X={{secret:secret-never-minted}}\n")
            .await
            .unwrap_err();
        match err {
            ToolError::ExecutionFailed(msg) => assert!(msg.contains("expired")),
            other => panic!("unexpected: {:?}", other),
        }
    }
}

//! Global MCP Resource tools.
//!
//! MCP resources are exposed via **two** built-in tools, not a
//! per-server bridge:
//!
//! - [`McpListResourcesTool`] (`ListMcpResources`): LLM enumerates the
//!   resources offered by all connected MCP servers, optionally filtering
//!   by server name. Output is a JSON array so the LLM can pick which
//!   URI to read next.
//! - [`McpReadResourceTool`] (`ReadMcpResource`): LLM reads a specific
//!   `{server, uri}` pair. Text content is returned verbatim; binary
//!   blobs are persisted to `$ORGII_HOME/tool-results/` and a short
//!   breadcrumb is returned instead — the LLM never sees base64.
//!
//! Design notes:
//! - Both tools are registered globally once (not per-server) so the
//!   LLM's `tools` array stays stable even as servers come and go.
//! - Output format is JSON, encoded in `text` so OpenAI-compat wire
//!   carries it verbatim; no structured content blocks are emitted
//!   (the Anthropic-native wire still receives just the JSON text).
//! - Binary blobs are replaced with `blobSavedTo` paths + English
//!   breadcrumbs (see [`super::result::binary_blob_breadcrumb`]).
//!
//! Both tools are read-only and concurrency-safe.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Value};

use crate::tools::traits::{Tool, ToolError};

use super::manager::McpManager;
use super::resources::McpResourceContent;
use super::result::{binary_blob_breadcrumb, persist_binary_blob};

/// Tool name used on the wire.
pub const LIST_MCP_RESOURCES_TOOL_NAME: &str = "ListMcpResources";

/// Tool name for single-URI reads.
pub const READ_MCP_RESOURCE_TOOL_NAME: &str = "ReadMcpResource";

/// Global tool: enumerate MCP resources across all connected servers.
///
/// Registered exactly once whenever any connected MCP server declares
/// `resources` capability. Server filter is optional — when absent the
/// LLM sees every resource from every resource-capable server.
pub struct McpListResourcesTool {
    manager: Arc<McpManager>,
    visible_server_names: HashSet<String>,
}

impl McpListResourcesTool {
    pub fn new(manager: Arc<McpManager>, visible_server_names: HashSet<String>) -> Self {
        Self {
            manager,
            visible_server_names,
        }
    }
}

#[async_trait]
impl Tool for McpListResourcesTool {
    fn name(&self) -> &str {
        LIST_MCP_RESOURCES_TOOL_NAME
    }

    fn description(&self) -> &str {
        "List resources exposed by connected MCP servers. \
Resources are contextual data (files, schemas, docs, etc.) that a server \
offers for on-demand reading. Use `ReadMcpResource` to fetch a specific \
resource by its URI. Pass `server` to filter to a single server."
    }

    fn category(&self) -> &str {
        "mcp"
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server": {
                    "type": "string",
                    "description": "Optional server name to filter resources by. \
        When omitted, returns resources from every connected server that supports them."
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
        let target_server = params
            .get("server")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Snapshot every (server, resource) pair currently visible.
        // `all_resources` already filters out servers whose `resources`
        // capability is missing, so no extra gate is needed here.
        let mut pairs = self.manager.all_resources().await;
        pairs.retain(|(name, _resource)| self.visible_server_names.contains(name));

        if let Some(ref target) = target_server {
            pairs.retain(|(name, _)| name == target);
            if pairs.is_empty() {
                // Distinguish "server not found" from "server found,
                // no resources". We don't have a list of connected
                // servers at hand cheaply — return a clear empty
                // array with a note so the LLM isn't confused.
                return Ok(format!(
                    "[]\n\n[No resources from server '{}' — either the server isn't connected, \
doesn't declare a resources capability, or currently exposes none.]",
                    target
                ));
            }
        }

        let items: Vec<Value> = pairs
            .into_iter()
            .map(|(server, res)| {
                let mut obj = json!({
                    "uri": res.uri,
                    "name": res.name,
                    "server": server,
                });
                if let Some(desc) = res.description {
                    obj["description"] = Value::String(desc);
                }
                if let Some(mime) = res.mime_type {
                    obj["mimeType"] = Value::String(mime);
                }
                if let Some(size) = res.size {
                    obj["size"] = Value::from(size);
                }
                obj
            })
            .collect();

        if items.is_empty() {
            return Ok("[]\n\n[No MCP servers currently expose resources. \
MCP servers may still provide tools even when they have no resources.]"
                .to_string());
        }

        serde_json::to_string_pretty(&items)
            .map_err(|err| ToolError::ExecutionFailed(format!("serialize resources: {err}")))
    }
}

/// Global tool: read a single MCP resource by `{server, uri}`.
///
/// For text resources the content is returned verbatim. For binary
/// blobs, the raw bytes are written to `$ORGII_HOME/tool-results/` (via
/// [`persist_binary_blob`]) and the LLM receives a short breadcrumb.
pub struct McpReadResourceTool {
    manager: Arc<McpManager>,
    visible_server_names: HashSet<String>,
}

impl McpReadResourceTool {
    pub fn new(manager: Arc<McpManager>, visible_server_names: HashSet<String>) -> Self {
        Self {
            manager,
            visible_server_names,
        }
    }
}

#[async_trait]
impl Tool for McpReadResourceTool {
    fn name(&self) -> &str {
        READ_MCP_RESOURCE_TOOL_NAME
    }

    fn description(&self) -> &str {
        "Read a single MCP resource by URI. Text resources return their \
content verbatim. Binary blobs are persisted to disk and a path + \
breadcrumb is returned so the LLM can still reason about them without \
ingesting raw bytes."
    }

    fn category(&self) -> &str {
        "mcp"
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server": {
                    "type": "string",
                    "description": "MCP server name (as shown by ListMcpResources)."
                },
                "uri": {
                    "type": "string",
                    "description": "Resource URI to read (e.g. file://..., https://..., or a server-specific scheme)."
                }
            },
            "required": ["server", "uri"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let server = params
            .get("server")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidParams("Missing 'server' parameter".to_string()))?;
        let uri = params
            .get("uri")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidParams("Missing 'uri' parameter".to_string()))?;

        if !self.visible_server_names.contains(server) {
            return Err(ToolError::InvalidParams(format!(
                "MCP server '{}' is not available in this session",
                server
            )));
        }

        let contents = self
            .manager
            .read_resource(server, uri)
            .await
            .map_err(ToolError::ExecutionFailed)?;

        let rendered: Vec<Value> = contents
            .into_iter()
            .map(|c| render_content(server, c))
            .collect();

        let wrapped = json!({ "contents": rendered });
        serde_json::to_string_pretty(&wrapped)
            .map_err(|err| ToolError::ExecutionFailed(format!("serialize contents: {err}")))
    }
}

/// Project one `McpResourceContent` variant into the JSON shape the LLM
/// receives. The binary path branch is persisted via
/// [`persist_binary_blob`].
fn render_content(server: &str, content: McpResourceContent) -> Value {
    match content {
        McpResourceContent::Text {
            uri,
            mime_type,
            text,
        } => {
            let mut obj = json!({ "uri": uri, "text": text });
            if let Some(mime) = mime_type {
                obj["mimeType"] = Value::String(mime);
            }
            obj
        }
        McpResourceContent::Blob {
            uri,
            mime_type,
            blob,
        } => {
            // Try to decode + persist. If either fails, fall back to a
            // text breadcrumb so the LLM still has something to act on.
            match BASE64.decode(blob.as_bytes()) {
                Ok(bytes) => {
                    let size = bytes.len() as u64;
                    match persist_binary_blob(server, &uri, mime_type.as_deref(), &bytes) {
                        Some(path) => {
                            let prefix = format!("[Resource from {server} at {uri}] ");
                            let breadcrumb =
                                binary_blob_breadcrumb(&path, mime_type.as_deref(), size, &prefix);
                            let mut obj = json!({
                                "uri": uri,
                                "blobSavedTo": path.display().to_string(),
                                "text": breadcrumb,
                            });
                            if let Some(mime) = mime_type {
                                obj["mimeType"] = Value::String(mime);
                            }
                            obj
                        }
                        None => {
                            let mut obj = json!({
                                "uri": uri,
                                "text": format!(
                                    "Binary content could not be persisted to disk \
                            (MCP server '{server}'); raw bytes dropped. {size} bytes."
                                ),
                            });
                            if let Some(mime) = mime_type {
                                obj["mimeType"] = Value::String(mime);
                            }
                            obj
                        }
                    }
                }
                Err(err) => {
                    let mut obj = json!({
                        "uri": uri,
                        "text": format!(
                            "Binary content from MCP server '{server}' was not valid base64: {err}."
                        ),
                    });
                    if let Some(mime) = mime_type {
                        obj["mimeType"] = Value::String(mime);
                    }
                    obj
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! These tests use the projection helpers directly (no live MCP
    //! connection) because spinning up `rmcp` stubs here would bloat the
    //! unit-test surface beyond what's covered in `client.rs` /
    //! `bridge.rs`. Integration against a real `McpManager` is exercised
    //! from the `e2e-test` binary.

    use super::*;

    #[test]
    fn render_text_content_keeps_mime_and_text() {
        let v = render_content(
            "srv",
            McpResourceContent::Text {
                uri: "file://x.txt".into(),
                mime_type: Some("text/plain".into()),
                text: "hello".into(),
            },
        );
        assert_eq!(v["uri"], "file://x.txt");
        assert_eq!(v["text"], "hello");
        assert_eq!(v["mimeType"], "text/plain");
        assert!(v.get("blobSavedTo").is_none());
    }

    #[test]
    fn render_text_content_without_mime_omits_field() {
        let v = render_content(
            "srv",
            McpResourceContent::Text {
                uri: "file://x".into(),
                mime_type: None,
                text: "hi".into(),
            },
        );
        assert!(v.get("mimeType").is_none(), "no mime → no key");
    }

    #[test]
    fn render_blob_content_persists_when_home_available() {
        // Isolate $ORGII_HOME so the blob lands in a tempdir.
        let _sb = test_helpers::test_env::sandbox();

        let bytes: Vec<u8> = vec![0xCA, 0xFE, 0xBA, 0xBE];
        let blob = BASE64.encode(&bytes);
        let v = render_content(
            "srv",
            McpResourceContent::Blob {
                uri: "res://binary".into(),
                mime_type: Some("image/png".into()),
                blob,
            },
        );

        assert_eq!(v["uri"], "res://binary");
        assert_eq!(v["mimeType"], "image/png");
        let saved = v["blobSavedTo"].as_str().expect("blobSavedTo set");
        let saved_path = std::path::PathBuf::from(saved);
        assert!(saved_path.is_file(), "blob should exist on disk");
        assert_eq!(std::fs::read(&saved_path).unwrap(), bytes);
        let breadcrumb = v["text"].as_str().unwrap();
        assert!(breadcrumb.contains("image/png"));
        assert!(breadcrumb.contains("4 bytes"));
        assert!(breadcrumb.contains("[Resource from srv at res://binary]"));
    }

    #[test]
    fn render_blob_content_invalid_base64_falls_back_to_breadcrumb() {
        let v = render_content(
            "srv",
            McpResourceContent::Blob {
                uri: "res://bad".into(),
                mime_type: None,
                blob: "!!!not-base64!!!".into(),
            },
        );
        assert_eq!(v["uri"], "res://bad");
        assert!(v.get("blobSavedTo").is_none());
        let text = v["text"].as_str().unwrap();
        assert!(text.contains("was not valid base64"), "got: {text}");
    }

    #[test]
    fn read_tool_parameters_require_server_and_uri() {
        let tool = McpReadResourceTool::new(Arc::new(McpManager::new()), HashSet::new());
        let schema = tool.parameters();
        let required = schema["required"].as_array().unwrap();
        let required: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
        assert!(required.contains(&"server"));
        assert!(required.contains(&"uri"));
    }

    #[test]
    fn list_tool_parameters_have_optional_server_only() {
        let tool = McpListResourcesTool::new(Arc::new(McpManager::new()), HashSet::new());
        let schema = tool.parameters();
        assert!(
            schema.get("required").is_none() || schema["required"].as_array().unwrap().is_empty(),
            "server is optional on List"
        );
        assert!(schema["properties"]["server"].is_object());
    }

    #[tokio::test]
    async fn list_tool_returns_empty_marker_when_no_servers_have_resources() {
        let manager = Arc::new(McpManager::new());
        let tool = McpListResourcesTool::new(Arc::clone(&manager), HashSet::new());
        let result = tool
            .execute_text(
                json!({}),
                &crate::tools::call_context::CallContext::trusted_sde(),
            )
            .await
            .expect("execute ok");
        // No connected servers → returns an empty JSON array with a
        // note. LLMs can still parse "[]" out of it.
        assert!(
            result.starts_with("[]"),
            "expected empty marker, got: {result}"
        );
        assert!(
            result.contains("No MCP servers currently expose resources"),
            "should explain why the list is empty"
        );
    }

    #[tokio::test]
    async fn list_tool_server_filter_with_no_match_returns_empty_marker() {
        let manager = Arc::new(McpManager::new());
        let tool = McpListResourcesTool::new(Arc::clone(&manager), HashSet::new());
        let result = tool
            .execute_text(
                json!({ "server": "does-not-exist" }),
                &crate::tools::call_context::CallContext::trusted_sde(),
            )
            .await
            .expect("execute ok");
        assert!(
            result.starts_with("[]"),
            "expected empty marker, got: {result}"
        );
        assert!(
            result.contains("does-not-exist"),
            "should name the requested server"
        );
    }

    #[tokio::test]
    async fn read_tool_rejects_missing_server() {
        let manager = Arc::new(McpManager::new());
        let tool = McpReadResourceTool::new(Arc::clone(&manager), HashSet::new());
        let err = tool
            .execute_text(
                json!({ "uri": "res://x" }),
                &crate::tools::call_context::CallContext::trusted_sde(),
            )
            .await
            .expect_err("should reject missing server");
        match err {
            ToolError::InvalidParams(msg) => assert!(msg.contains("server")),
            other => panic!("expected InvalidParams, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_tool_rejects_missing_uri() {
        let manager = Arc::new(McpManager::new());
        let tool = McpReadResourceTool::new(Arc::clone(&manager), HashSet::new());
        let err = tool
            .execute_text(
                json!({ "server": "s" }),
                &crate::tools::call_context::CallContext::trusted_sde(),
            )
            .await
            .expect_err("should reject missing uri");
        match err {
            ToolError::InvalidParams(msg) => assert!(msg.contains("uri")),
            other => panic!("expected InvalidParams, got {other:?}"),
        }
    }
}

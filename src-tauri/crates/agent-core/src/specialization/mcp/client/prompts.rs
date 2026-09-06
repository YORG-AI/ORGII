//! `prompts/list` + `prompts/get`.

use rmcp::model::GetPromptRequestParams;
use serde_json::Value;

use super::{render_prompt_content, McpClient};
use crate::specialization::mcp::prompts::{
    McpPrompt, McpPromptArgument, McpPromptMessage, McpPromptMessageRole, McpPromptRendered,
};

impl McpClient {
    /// Did the server advertise the `prompts` capability at handshake time?
    pub async fn has_prompts(&self) -> bool {
        self.capabilities.lock().await.has_prompts
    }

    /// Enumerate every prompt advertised by the server via `prompts/list`.
    ///
    /// rmcp's `list_all_prompts` paginates internally — we already get the
    /// full list back. Returned rows are flat `McpPrompt` structs with
    /// argument declarations converted to our own shape; callers never
    /// see rmcp types.
    ///
    /// If the server didn't advertise `prompts` at handshake we short-
    /// circuit to an empty Vec rather than sending a request the server
    /// will reject — callers must never see a `prompts/list` error for a
    /// server that simply has no prompts capability.
    pub async fn list_prompts(&self) -> Result<Vec<McpPrompt>, String> {
        if !self.has_prompts().await {
            return Ok(Vec::new());
        }

        let service_guard = self.service.lock().await;
        let service = service_guard
            .as_ref()
            .ok_or_else(|| format!("MCP '{}' has no live service", self.name))?;

        let prompts = service.list_all_prompts().await.map_err(|err| {
            crate::specialization::mcp::config::redact_server_secrets_from_text(
                &self.config,
                &format!("prompts/list failed for '{}': {}", self.name, err),
            )
        })?;

        let converted = prompts
            .into_iter()
            .map(|p| McpPrompt {
                name: p.name,
                title: p.title,
                description: p.description,
                arguments: p
                    .arguments
                    .unwrap_or_default()
                    .into_iter()
                    .map(|a| McpPromptArgument {
                        name: a.name,
                        title: a.title,
                        description: a.description,
                        required: a.required.unwrap_or(false),
                    })
                    .collect(),
            })
            .collect();

        Ok(converted)
    }

    /// Execute a prompt via `prompts/get` with the given arguments, then
    /// flatten the returned messages into the `McpPromptRendered` shape.
    ///
    /// Only `text` content is preserved verbatim; images / audio /
    /// resources / resource-links are rendered into short bracketed text
    /// placeholders — same pattern as `render_content` for tool
    /// results. The frontend treats a rendered prompt as plain text to
    /// pre-populate the chat input, not as multi-modal content.
    pub async fn get_prompt(
        &self,
        prompt_name: &str,
        arguments: Option<serde_json::Map<String, Value>>,
    ) -> Result<McpPromptRendered, String> {
        let service_guard = self.service.lock().await;
        let service = service_guard
            .as_ref()
            .ok_or_else(|| format!("MCP '{}' has no live service", self.name))?;

        let params = match arguments {
            Some(args) => GetPromptRequestParams::new(prompt_name).with_arguments(args),
            None => GetPromptRequestParams::new(prompt_name),
        };

        let result = service.get_prompt(params).await.map_err(|err| {
            crate::specialization::mcp::config::redact_server_secrets_from_text(
                &self.config,
                &format!(
                    "prompts/get failed for '{}/{}': {}",
                    self.name, prompt_name, err
                ),
            )
        })?;

        let messages = result
            .messages
            .into_iter()
            .map(|m| McpPromptMessage {
                role: match m.role {
                    rmcp::model::PromptMessageRole::User => McpPromptMessageRole::User,
                    rmcp::model::PromptMessageRole::Assistant => McpPromptMessageRole::Assistant,
                },
                text: render_prompt_content(&m.content),
            })
            .collect();

        Ok(McpPromptRendered {
            description: result.description,
            messages,
        })
    }
}

//! `resources/list`, `resources/read`, `resources/templates/list`.

use rmcp::model::ReadResourceRequestParams;

use super::McpClient;
use crate::specialization::mcp::resources::{McpResource, McpResourceContent, McpResourceTemplate};

impl McpClient {
    pub async fn has_resources(&self) -> bool {
        self.capabilities.lock().await.has_resources
    }

    pub async fn list_resources(
        &self,
        _cursor: Option<&str>,
    ) -> Result<(Vec<McpResource>, Option<String>), String> {
        let service_guard = self.service.lock().await;
        let service = service_guard
            .as_ref()
            .ok_or_else(|| format!("MCP '{}' has no live service", self.name))?;

        let resources = service.list_all_resources().await.map_err(|err| {
            crate::specialization::mcp::config::redact_server_secrets_from_text(
                &self.config,
                &format!("resources/list failed for '{}': {}", self.name, err),
            )
        })?;

        let converted = resources
            .into_iter()
            .map(|r| McpResource {
                uri: r.raw.uri,
                name: r.raw.name,
                description: r.raw.description,
                mime_type: r.raw.mime_type,
                size: r.raw.size.map(|s| s as u64),
            })
            .collect();

        Ok((converted, None))
    }

    pub async fn read_resource(&self, uri: &str) -> Result<Vec<McpResourceContent>, String> {
        let service_guard = self.service.lock().await;
        let service = service_guard
            .as_ref()
            .ok_or_else(|| format!("MCP '{}' has no live service", self.name))?;

        let result = service
            .read_resource(ReadResourceRequestParams::new(uri.to_string()))
            .await
            .map_err(|err| {
                crate::specialization::mcp::config::redact_server_secrets_from_text(
                    &self.config,
                    &format!("resources/read failed for '{}': {}", self.name, err),
                )
            })?;

        let contents = result
            .contents
            .into_iter()
            .map(|c| match c {
                rmcp::model::ResourceContents::TextResourceContents {
                    uri,
                    mime_type,
                    text,
                    ..
                } => McpResourceContent::Text {
                    uri,
                    mime_type,
                    text,
                },
                rmcp::model::ResourceContents::BlobResourceContents {
                    uri,
                    mime_type,
                    blob,
                    ..
                } => McpResourceContent::Blob {
                    uri,
                    mime_type,
                    blob,
                },
            })
            .collect();

        Ok(contents)
    }

    pub async fn list_resource_templates(
        &self,
        _cursor: Option<&str>,
    ) -> Result<(Vec<McpResourceTemplate>, Option<String>), String> {
        let service_guard = self.service.lock().await;
        let service = service_guard
            .as_ref()
            .ok_or_else(|| format!("MCP '{}' has no live service", self.name))?;

        let templates = service.list_all_resource_templates().await.map_err(|err| {
            crate::specialization::mcp::config::redact_server_secrets_from_text(
                &self.config,
                &format!(
                    "resources/templates/list failed for '{}': {}",
                    self.name, err
                ),
            )
        })?;

        let converted = templates
            .into_iter()
            .map(|t| McpResourceTemplate {
                uri_template: t.raw.uri_template,
                name: t.raw.name,
                description: t.raw.description,
                mime_type: t.raw.mime_type,
            })
            .collect();

        Ok((converted, None))
    }
}

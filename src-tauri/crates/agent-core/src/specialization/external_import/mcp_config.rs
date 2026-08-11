use std::path::Path;

use crate::specialization::mcp::config::McpConfigFile;

/// Load an MCP config authored by another agent and normalize the transport
/// spellings that ORGII accepts before deserializing it into the canonical
/// config model.
pub(super) fn load_external_mcp_config(path: &Path) -> Result<McpConfigFile, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|err| format!("Failed to read MCP config {}: {}", path.display(), err))?;
    let mut value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|err| format!("Failed to parse MCP config {}: {}", path.display(), err))?;
    let Some(servers) = value
        .get_mut("mcpServers")
        .and_then(|entry| entry.as_object_mut())
    else {
        return Ok(McpConfigFile::default());
    };

    for server in servers.values_mut() {
        let Some(server_obj) = server.as_object_mut() else {
            continue;
        };
        if !server_obj.contains_key("type") {
            let inferred = if server_obj.contains_key("url") {
                "streamableHttp"
            } else {
                "stdio"
            };
            server_obj.insert(
                "type".to_string(),
                serde_json::Value::String(inferred.to_string()),
            );
        }
        if server_obj.get("type").and_then(|entry| entry.as_str()) == Some("http") {
            server_obj.insert(
                "type".to_string(),
                serde_json::Value::String("streamableHttp".to_string()),
            );
        }
    }

    serde_json::from_value(value).map_err(|err| {
        format!(
            "Failed to parse MCP server entries {}: {}",
            path.display(),
            err
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::specialization::mcp::config::McpTransportType;
    use tempfile::TempDir;

    #[test]
    fn normalizes_external_transport_variants() {
        let temp = TempDir::new().expect("create temp dir");
        let path = temp.path().join("mcp.json");
        std::fs::write(
            &path,
            r#"{
                "mcpServers": {
                    "implicit-stdio": { "command": "server" },
                    "implicit-http": { "url": "https://example.com/mcp" },
                    "legacy-http": { "type": "http", "url": "https://example.com/legacy" },
                    "explicit-sse": { "type": "sse", "url": "https://example.com/sse" }
                }
            }"#,
        )
        .expect("write config");

        let config = load_external_mcp_config(&path).expect("load config");

        assert_eq!(
            config.mcp_servers["implicit-stdio"].transport_type,
            McpTransportType::Stdio
        );
        assert_eq!(
            config.mcp_servers["implicit-http"].transport_type,
            McpTransportType::StreamableHttp
        );
        assert_eq!(
            config.mcp_servers["legacy-http"].transport_type,
            McpTransportType::StreamableHttp
        );
        assert_eq!(
            config.mcp_servers["explicit-sse"].transport_type,
            McpTransportType::Sse
        );
    }

    #[test]
    fn treats_missing_mcp_servers_as_empty() {
        let temp = TempDir::new().expect("create temp dir");
        let path = temp.path().join("mcp.json");
        std::fs::write(&path, r#"{ "other": true }"#).expect("write config");

        let config = load_external_mcp_config(&path).expect("load config");

        assert!(config.mcp_servers.is_empty());
    }
}
